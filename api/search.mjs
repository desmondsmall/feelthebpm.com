// Song search over search.db (built by pipeline/search/build-search.mjs). Synchronous: the
// service runs it inside a worker thread (query-worker.mjs) so a slow query can be abandoned.
//
// Search is for finding a specific song, so results are ordered by how well they match, and a
// song's weight (AcousticBrainz readings, more for curated songs) only orders equally good
// matches. The matches, best first:
//   head: four kinds of match, blended by weight × boost —
//     artist + title  "beatles yesterday", "beatles yest"   (an exact artist, then the start of a title)
//     exact title     "yesterday" → every song titled "Yesterday"
//     exact artist    "queen" → Queen's songs
//     title start     "smells like" → "Smells Like Teen Spirit"
//   tail: every word matches somewhere in artist or title (FTS5 over the normalized columns, so
//         it splits words exactly as normalize() does; the last word may be unfinished)
// A blended boost rather than strict tiers, because while someone types, a thin exact match
// ("Smells Like" by an unknown band) shouldn't bury a famous prefix match. The boosts are tuned
// against pipeline/search/eval-ranking.mjs.
//
// Cost model. Every kind of match is a stream of song ids in id order (= weight order) straight
// from an index, so nothing is sorted and a page costs the same at any depth; "show more" is a
// cursor of where each stream stopped. Weights and tempos are packed arrays in memory, so
// blending streams and filtering by BPM read no rows. A row is read only for a candidate that
// passes the filters (to check which kinds it belongs to, and to return it). Each request has
// two budgets — ids examined (cheap) and rows read (dear) — and a page can come back short with
// a cursor to keep going.
import { DatabaseSync } from 'node:sqlite';
import { normalize } from './normalize.mjs';

export const LIMIT_DEFAULT = 10;
export const LIMIT_MAX = 50;
export const QUERY_MAX = 100;
export const BOOST = { artistTitle: 40, exactTitle: 12, exactArtist: 6, titleStart: 1 };
const ID_BUDGET = 60_000;       // ids one request may examine (~0.7 µs each: ~40 ms on a laptop, 3–5× on the droplet)
const ROW_BUDGET = 2_000;       // rows one request may read (~15 µs each on a laptop, more on the droplet)
const CHUNK = 64;               // rows fetched at a time when browsing in index order
const SORTS_BROWSE = ['rank', 'bpm', 'artist', 'title'];

export class BadRequest extends Error {}

/** Parse a query into its normalized form, words, and whether the last word may be unfinished. */
export function parseQuery(q) {
  const n = normalize(q);
  const words = n ? n.split(' ') : [];
  return { n, words, open: words.length > 0 && !/[\s\p{P}]$/u.test(q) };
}

/** FTS5 query: every word whole, the last as a prefix while it may be unfinished. */
export function ftsQuery({ words, open }) {
  return words.map((w, i) => `"${w}"` + (open && i === words.length - 1 ? '*' : '')).join(' ');
}

/** FTS5 query for "the title starts with these words": ^ "smells" + "like"*. */
export function titleStartQuery({ words, open }) {
  return '^ ' + words.map((w, i) => `"${w}"` + (open && i === words.length - 1 ? '*' : '')).join(' + ');
}

const encodeCursor = (c) => Buffer.from(JSON.stringify(c)).toString('base64url');
function decodeCursor(s) {
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (c && typeof c === 'object' && !Array.isArray(c)) return c;
  } catch {}
  throw new BadRequest('bad cursor');
}
const int = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
const theVariant = (a) => (a.startsWith('the ') ? a.slice(4) : `the ${a}`);

/** Ids from a statement, lazily; the statement stays open until the stream is closed. */
function* ids(stmt, ...args) { for (const r of stmt.iterate(...args)) yield r.id; }
/** Merge ascending id streams into one, without duplicates. */
function* mergeIds(...streams) {
  const heads = streams.map((s) => ({ s, v: s.next() }));
  let last = 0;
  for (;;) {
    let best = null;
    for (const h of heads) if (!h.v.done && (!best || h.v.value < best.v.value)) best = h;
    if (!best) return;
    const id = best.v.value;
    best.v = best.s.next();
    if (id !== last) { last = id; yield id; }
  }
}

export class Search {
  constructor(path) {
    this.path = path;
    this.open();
  }

  open() {
    const db = new DatabaseSync(this.path, { readOnly: true });
    const u16 = (b) => new Uint16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    const t = db.prepare('SELECT bpm, bpm_alt, weight FROM tempo').get();
    this.bpm10 = u16(t.bpm);
    this.alt10 = u16(t.bpm_alt);
    this.weight = u16(t.weight);
    this.count = this.bpm10.length - 1;
    this.curatedIds = new Set(db.prepare('SELECT id FROM song WHERE curated = 1').all().map((r) => r.id));
    const meta = db.prepare("SELECT value FROM meta WHERE key = 'manifest'").get();
    this.manifest = meta ? JSON.parse(meta.value) : null;
    // release arrived in schema 5; a file built before it has no such column
    const release = db.prepare("SELECT 1 FROM pragma_table_info('song') WHERE name = 'release'").get() ? 'release' : 'NULL AS release';
    this.q = {
      norms: db.prepare('SELECT artist_norm, title_norm FROM song WHERE id = ?'),
      bpmAsc: db.prepare('SELECT id, bpm AS v FROM song WHERE bpm BETWEEN ? AND ? AND (bpm > ? OR (bpm = ? AND id > ?)) ORDER BY bpm, id LIMIT ?'),
      altAsc: db.prepare('SELECT id, bpm_alt AS v FROM song WHERE bpm_alt BETWEEN ? AND ? AND NOT (bpm BETWEEN ? AND ?) AND (bpm_alt > ? OR (bpm_alt = ? AND id > ?)) ORDER BY bpm_alt, id LIMIT ?'),
      artistAsc: db.prepare("SELECT id, artist_norm AS v FROM song WHERE artist_norm <> '' AND (artist_norm > ? OR (artist_norm = ? AND id > ?)) ORDER BY artist_norm, id LIMIT ?"),
      titleAsc: db.prepare("SELECT id, title_norm AS v FROM song WHERE title_norm <> '' AND (title_norm > ? OR (title_norm = ? AND id > ?)) ORDER BY title_norm, id LIMIT ?"),   // titles of pure punctuation ("------") normalize to ''
      rows: db.prepare(`SELECT id, mbid, ${release}, artist, title, bpm, bpm_alt, curated, genre, year, isrc, cover, youtube_id FROM song WHERE id IN (SELECT value FROM json_each(?))`),
    };
    this.db?.close();
    this.db = db;
  }

  health() {
    const ok = this.db.prepare('SELECT 1 AS ok FROM song WHERE id = 1').get()?.ok === 1;
    return { ok, songs: this.count, schema_version: this.manifest?.schema_version ?? null, built_at: this.manifest?.built_at ?? null };
  }

  /** params: { q, bpm_min, bpm_max, sort, limit, after, curated } — validated here. */
  search(params = {}) {
    const q = typeof params.q === 'string' ? params.q.slice(0, QUERY_MAX) : '';
    const parsed = parseQuery(q);
    const limit = params.limit == null ? LIMIT_DEFAULT : Number(params.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > LIMIT_MAX) throw new BadRequest(`limit must be 1–${LIMIT_MAX}`);
    const lo = params.bpm_min == null || params.bpm_min === '' ? null : Number(params.bpm_min);
    const hi = params.bpm_max == null || params.bpm_max === '' ? null : Number(params.bpm_max);
    for (const v of [lo, hi]) if (v != null && !(v >= 1 && v <= 400)) throw new BadRequest('bpm_min/bpm_max must be 1–400');
    if (lo != null && hi != null && lo > hi) throw new BadRequest('bpm_min is above bpm_max');
    const range = lo == null && hi == null ? null : [Math.round((lo ?? 1) * 10), Math.round((hi ?? 400) * 10)];
    const curatedOnly = params.curated === '1' || params.curated === true || params.curated === 1;
    const sort = params.sort || (parsed.words.length ? 'match' : 'rank');
    if (parsed.words.length && sort !== 'match') throw new BadRequest('with q, sort must be match');
    if (!parsed.words.length && !SORTS_BROWSE.includes(sort)) throw new BadRequest(`sort must be one of ${SORTS_BROWSE.join(', ')}`);
    const cursor = params.after ? decodeCursor(params.after) : {};

    const keep = (id) => {
      if (curatedOnly && !this.curatedIds.has(id)) return false;
      if (!range) return true;
      const b = this.bpm10[id], a = this.alt10[id];
      return (b >= range[0] && b <= range[1]) || (a !== 0 && a >= range[0] && a <= range[1]);
    };
    const run = { ids: ID_BUDGET, rows: ROW_BUDGET, keep, limit };
    let found, next;
    if (sort === 'match') ({ found, next } = this.#match(parsed, cursor, run));
    else if (sort === 'rank') ({ found, next } = this.#browseRank(cursor, run));
    else ({ found, next } = this.#browseSorted(sort, cursor, run, range));
    return { items: this.#rows(found), next: next ? encodeCursor(next) : null };
  }

  // ---- search: head (blended kinds of match) then tail (any words) ----
  #match(p, cursor, run) {
    const { n, words, open } = p;
    const db = this.db;
    // Each stream iterates its own statement: SQLite can't step one statement twice at once.
    const stream = (sql, ...args) => ids(db.prepare(sql), ...args);
    const START = 'SELECT rowid AS id FROM tstart WHERE tstart MATCH ? AND rowid > ? ORDER BY rowid';
    const ARTIST = 'SELECT id FROM song WHERE artist_norm = ? AND id > ? ORDER BY id';
    const titleStarts = (t, pre) => (pre.endsWith(' ') ? t === pre.trimEnd() || t.startsWith(pre) : t.startsWith(pre));

    // artist + title: the first k words are an artist (with or without "the"), the rest the start
    // of a title. The artist's song ids are collected into a set from the (artist_norm, id) index
    // (cheap, no rows), then the title-start stream is filtered by the set. An artist with more
    // than ARTIST_CAP songs is skipped here; its songs still match in the tail.
    const ARTIST_CAP = 50_000;
    const splits = [];
    for (let k = 1; k < Math.min(words.length, 8); k++) {
      const a = words.slice(0, k).join(' '), rest = words.slice(k);
      const set = new Set();
      let complete = true;
      for (const name of [a, theVariant(a)]) {
        for (const id of stream(ARTIST, name, 0)) { if (set.size >= ARTIST_CAP) { complete = false; break; } set.add(id); }
        run.ids -= set.size;
      }
      if (set.size && complete) splits.push({ artists: [a, theVariant(a)], title: rest.join(' ') + (open ? '' : ' '), set, q: titleStartQuery({ words: rest, open }) });
    }
    const kinds = {
      artistTitle: {
        is: (r) => splits.some((sp) => sp.artists.includes(r.artist_norm) && titleStarts(r.title_norm, sp.title)),
        stream: (after) => mergeIds(...splits.map((sp) => (function* () { for (const id of stream(START, sp.q, after)) if (sp.set.has(id)) yield id; })())),
      },
      exactTitle: { is: (r) => r.title_norm === n, stream: (after) => stream('SELECT id FROM song WHERE title_norm = ? AND id > ? ORDER BY id', n, after) },
      exactArtist: {
        is: (r) => r.artist_norm === n || r.artist_norm === theVariant(n),
        stream: (after) => mergeIds(stream(ARTIST, n, after), stream(ARTIST, theVariant(n), after)),
      },
      titleStart: { is: (r) => titleStarts(r.title_norm, open ? n : `${n} `), stream: (after) => stream(START, titleStartQuery(p), after) },
    };
    const order = Object.keys(kinds).sort((x, y) => BOOST[y] - BOOST[x]);
    const norms = new Map();
    const rowOf = (id) => {
      if (!norms.has(id)) { run.rows--; norms.set(id, this.q.norms.get(id)); }
      return norms.get(id);
    };
    const pos = {};
    for (const k of order) pos[k] = int(cursor.h?.[k]);
    const found = [];
    let tail = cursor.t === undefined ? undefined : int(cursor.t);   // undefined until the head is exhausted
    const opened = [];

    try {
      if (tail === undefined) {
        const lists = order.map((k) => { const gen = kinds[k].stream(pos[k]); opened.push(gen); return { k, gen, cur: gen.next() }; });
        while (found.length < run.limit) {
          if (run.ids <= 0 || run.rows <= 0) return { found, next: { h: pos } };
          let best = null;
          for (const L of lists) {
            if (L.cur.done) continue;
            const w = this.weight[L.cur.value] * BOOST[L.k];
            if (!best || w > best.w) best = { L, w };
          }
          if (!best) break;
          const { L } = best;
          const id = L.cur.value;
          L.cur = L.gen.next();
          pos[L.k] = id;
          run.ids--;
          if (!run.keep(id)) continue;
          // Emit a song only from the highest-boost kind it belongs to (where it ranks earliest).
          const higher = order.slice(0, order.indexOf(L.k));
          if (higher.length && higher.some((k) => kinds[k].is(rowOf(id)))) continue;
          found.push(id);
        }
        if (lists.some((L) => !L.cur.done)) return { found, next: { h: pos } };
        tail = 0;
      }

      // Tail: any-word matches in weight order, skipping songs the head covers.
      const it = stream('SELECT rowid AS id FROM fts WHERE fts MATCH ? AND rowid > ? ORDER BY rowid', ftsQuery(p), tail);
      opened.push(it);
      for (const id of it) {
        if (run.ids <= 0 || run.rows <= 0) return { found, next: { h: pos, t: tail } };   // resume at this id
        run.ids--;
        tail = id;
        if (!run.keep(id)) continue;
        const r = rowOf(id);
        if (order.some((k) => kinds[k].is(r))) continue;
        found.push(id);
        if (found.length >= run.limit) return { found, next: { h: pos, t: tail } };
      }
      return { found, next: null };
    } finally {
      for (const g of opened) g.return?.();
    }
  }

  // ---- browse by rank: a scan of the in-memory tempos in id order ----
  #browseRank(cursor, run) {
    const found = [];
    let id = int(cursor.id);
    const stop = Math.min(this.count, id + run.ids * 10);   // array checks are cheap
    while (id < stop && found.length < run.limit) { id++; if (run.keep(id)) found.push(id); }
    return { found, next: id < this.count ? { id } : null };
  }

  // ---- browse sorted by bpm, artist or title: index order, cursor = (value, id) ----
  #browseSorted(sort, cursor, run, range) {
    const found = [];
    let v = cursor.v ?? (sort === 'bpm' ? -1 : ''), id = int(cursor.id);
    if (sort === 'bpm' && typeof v !== 'number') throw new BadRequest('bad cursor');
    if (sort !== 'bpm' && typeof v !== 'string') throw new BadRequest('bad cursor');
    // With a BPM range, sort by the tempo that's in range: merge the bpm and bpm_alt lists.
    const lo = range ? range[0] / 10 : 0, hi = range ? range[1] / 10 : 1e9;
    const fetch = sort === 'bpm'
      ? (after, k) => {
          const a = this.q.bpmAsc.all(lo, hi, after.v, after.v, after.id, k);
          const b = range ? this.q.altAsc.all(lo, hi, lo, hi, after.v, after.v, after.id, k) : [];
          return [...a, ...b].sort((x, y) => x.v - y.v || x.id - y.id).slice(0, k);
        }
      : (after, k) => this.q[`${sort}Asc`].all(after.v, after.v, after.id, k);
    let done = false;
    while (found.length < run.limit && run.ids > 0 && !done) {
      const rows = fetch({ v, id }, CHUNK);
      if (rows.length < CHUNK) done = true;
      for (const r of rows) {
        v = r.v; id = r.id; run.ids -= 50;   // an index row costs more than an array check
        if (run.keep(r.id)) found.push(r.id);
        if (found.length >= run.limit) { done = false; break; }
      }
    }
    return { found, next: done && found.length < run.limit ? null : { v, id } };
  }

  #rows(ids) {
    if (!ids.length) return [];
    const byId = new Map(this.q.rows.all(JSON.stringify(ids)).map((r) => [r.id, r]));
    return ids.map((id) => {
      const r = byId.get(id);
      const item = { artist: r.artist, title: r.title, bpm: r.bpm, bpm_alt: r.bpm_alt, curated: r.curated === 1 };
      if (r.mbid) item.mbid = r.mbid;
      if (r.release) item.release = r.release;
      if (r.curated) for (const k of ['genre', 'year', 'isrc', 'cover', 'youtube_id']) if (r[k] != null) item[k] = r[k];
      return item;
    });
  }
}
