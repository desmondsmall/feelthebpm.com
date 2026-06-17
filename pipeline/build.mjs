#!/usr/bin/env node
// Build songs.json from the seed catalogue (pipeline/catalogue.json — see seed.mjs): Deezer
// (BPM/year/rank) + MusicBrainz (original year) + YouTube/Songsterr popularity + override table.
// No deps; Node 22+ (global fetch). Caches Deezer responses to ./cache so re-runs are cheap.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);

// global fetch is required (Node 18+; stable since 21). Fail loud rather than throw a
// cryptic `ReferenceError: fetch is not defined` halfway through. See .nvmrc (pins 22).
if (typeof fetch !== 'function') {
  console.error(`This pipeline needs Node 18+ for global fetch (you have ${process.version}). See .nvmrc.`);
  process.exit(1);
}

const HERE = dirname(fileURLToPath(import.meta.url));
// the deployable surface — pipeline output (songs.json/songs.js) lands here; nginx serves this dir
const SITE = join(HERE, '..', 'public');
if (!existsSync(SITE)) mkdirSync(SITE, { recursive: true });
const CACHE = join(HERE, 'cache');
if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });

// ---- tunables ----------------------------------------------------------
const SONGS_PER_ARTIST = 6;        // top-N popular songs kept per Songsterr artist
const SONGSTERR_PAGE = 40;         // Songsterr /api/songs hits to scan per artist
const DEEZER_SEARCH_LIMIT = 5;     // Deezer search hits to consider when matching
const MB_SEARCH_LIMIT = 25;        // MusicBrainz recordings to scan for the earliest year
const MAX_FETCH_ATTEMPTS = 3;      // tries before getJson gives up (returns null, caches nothing)
const DEFAULT_PACE_MS = 250;       // polite delay after a live (uncached) fetch
const YT_SEARCH_N = 8;             // YouTube search hits to scan per song (max-views match)
const YT_PACE_MS = 800;            // polite delay after a live yt-dlp call (unauthed scraping)
// Popularity blend weights — percentile-ranked breadth signals (see .dev/reference/popularity-rework.md
// and pipeline-architecture.md). YouTube view breadth is PRIMARY (recognizability); Deezer rank
// (streaming reach) is secondary; Songsterr tab views (a known guitar-canon bias) are minimized.
// A song missing a signal scores percentile 0 for it — a penalty, not a dropped term (see §4b);
// only a signal that's entirely dormant across the catalogue (e.g. YouTube disabled) is dropped,
// with the remaining weights renormalizing. Env-overridable (POP_W_YT / POP_W_RANK / POP_W_SONG)
// to tune/sweep without a code edit; compare configs offline with pipeline/sweep-weights.mjs.
const wEnv = (name, def) => { const v = Number(process.env[name]); return Number.isFinite(v) ? v : def; };
const POP_WEIGHTS = { youtube: wEnv('POP_W_YT', 0.70), rank: wEnv('POP_W_RANK', 0.20), songsterr: wEnv('POP_W_SONG', 0.10) };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

// ---- string helpers ----------------------------------------------------
const norm = (s) =>
  (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\(feat[^)]*\)|\bfeat\.?\b.*$/g, '')
    .replace(/['\u2019]/g, '')               // drop apostrophes so "Dont"=="Don't" (Ultimate
    .replace(/[^a-z0-9]+/g, ' ')             //   Guitar strips them; without this they'd not dedup)
    .trim();
const key = (artist, title) => `${norm(artist)}|${norm(title)}`;

const VARIANT_RE =
  /\b(cover|with bass|backing track|guitar pro|instrumental|karaoke|tribute|made famous|in the style of)\b|\((live|acoustic|remix|remaster|intro|solo|demo|edit|version)\b/i;

// Strip Songsterr tab-arrangement annotations so "Africa Standart Tuning Fingerstyle" -> "Africa",
// while preserving real titles like "Pride (In the Name of Love)" and "Live Forever".
// Multi-word phrases are safe to remove anywhere; single words (live/acoustic/solo...) only inside parens.
const ARR_PHRASES =
  'guitar solo|only guitar|guitar pro|bass tab|bass only|bass guitar|bass track|drum tab|drum show|all instruments|with intro|with outro|standar[dt][ -]?tuning|drop[ -]?[a-g]|[a-g]b?[ -]?standard|half[ -]?step[ -]?down|fingerstyle|fingerpicking|capo ?\\d+|iconic lick[^|]*|in key of [a-g]m?';
const ARR_REPL = new RegExp(`\\b(${ARR_PHRASES})\\b`, 'gi');
const ARR_PAREN = new RegExp(`\\b(${ARR_PHRASES}|acoustic|unplugged|live|remastered|intro|outro|solo|piano|version|edit|tab|tabs)\\b`, 'i');
// trailing arrangement words ("Beat It Solo", "... Acoustic") — stripped at END only, and only
// unambiguous ones (NOT live/bass/guitar/piano, which can be real title words: "Long Live", "All About That Bass").
const ARR_TRAIL = /[\s-]+(solo|intro|outro|acoustic|unplugged|instrumental|remastered|reprise|tabs?|standard)\s*$/i;
const cleanTitle = (t) => {
  let s = t || '';
  // remove a parenthetical only if it looks like an arrangement annotation
  s = s.replace(/[\(\[]([^)\]]*)[\)\]]/g, (m, inner) => (ARR_PAREN.test(inner) ? ' ' : m));
  s = s.replace(ARR_REPL, ' ');
  let prev;
  do { prev = s; s = s.replace(ARR_TRAIL, ''); } while (s !== prev); // strip stacked trailing words
  s = s.replace(/\s+v\d+\s*$/i, '');  // Songsterr version markers ("Let It Happen v1" -> "Let It Happen")
  s = s.replace(/\s*[-–—|]+\s*$/, '').replace(/\s+/g, ' ').trim();
  return s || (t || '').trim();
};

// ---- cached fetch ------------------------------------------------------
// opts.headers: extra request headers (e.g. MusicBrainz requires a real User-Agent).
// opts.pace: ms to sleep after a LIVE (uncached) call, to respect rate limits.
async function getJson(url, opts = {}) {
  const { headers = {}, pace = DEFAULT_PACE_MS } = opts;
  const f = join(CACHE, createHash('md5').update(url).digest('hex') + '.json');
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json', ...headers } });
      // Never cache a failure. Back off and retry on rate-limit (429/503) AND any other
      // non-OK status — otherwise a transient 500 / a stray 404 body would be written to
      // cache and silently poison this song on every future run (cache key is just the URL).
      if (!res.ok) { await sleep(2000 * (attempt + 1)); continue; }
      const j = await res.json();
      // Deezer & MusicBrainz return an error envelope ({error:...}) with HTTP 200; treat
      // that as a failure too, so it isn't cached as if it were real data.
      if (j && j.error) { await sleep(800 * (attempt + 1)); continue; }
      writeFileSync(f, JSON.stringify(j));
      // be polite — paces live calls only (cached fetches don't sleep). 250ms keeps us
      // far under GetSongBPM's 3000/hour limit; MusicBrainz needs ~1100ms (1 req/sec).
      await sleep(pace);
      return j;
    } catch (e) {
      await sleep(800 * (attempt + 1));
    }
  }
  return null;
}

// ---- Songsterr: discover popular songs per artist ----------------------
async function songsterrForArtist(name, genre) {
  const url = `https://www.songsterr.com/api/songs?pattern=${encodeURIComponent(name)}&size=${SONGSTERR_PAGE}`;
  const data = await getJson(url);
  if (!Array.isArray(data)) return [];
  const want = norm(name);
  const byTitle = new Map();
  for (const s of data) {
    if (norm(s.artist) !== want) continue;            // exact artist only (drops Nick Drake etc.)
    if (VARIANT_RE.test(s.title)) continue;            // drop covers/variants
    // strip a leading "Artist - " / "Artist: " prefix some tabs carry, then arrangement junk
    const deprefixed = s.title.replace(
      new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[-–—:]\\s*`, 'i'),
      ''
    );
    const title = cleanTitle(deprefixed);              // strip tab-arrangement annotations
    const views = Math.max(0, ...(s.tracks || []).map((t) => t.views || 0));
    const k = norm(title);
    if (!byTitle.has(k) || byTitle.get(k).songsterr_views < views) {
      byTitle.set(k, { artist: name, title, genre, songsterr_views: views });
    }
  }
  return [...byTitle.values()]
    .sort((a, b) => b.songsterr_views - a.songsterr_views)
    .slice(0, SONGS_PER_ARTIST);
}

// ---- Deezer: enrich one candidate with bpm/year/isrc/rank --------------
async function deezerEnrich(c) {
  const q = `${c.artist} ${c.title}`;
  const search = await getJson(
    `https://api.deezer.com/search/track?q=${encodeURIComponent(q)}&limit=${DEEZER_SEARCH_LIMIT}`
  );
  const results = search?.data || [];
  const wantA = norm(c.artist);
  const wantT = norm(c.title);
  // pick best: artist matches and title overlaps; prefer higher rank
  let best = null;
  for (const r of results) {
    const a = norm(r.artist?.name);
    const t = norm(r.title);
    const artistOk = a.includes(wantA) || wantA.includes(a);
    const titleOk = t.includes(wantT) || wantT.includes(t);
    if (artistOk && titleOk) {
      if (!best || (r.rank || 0) > (best.rank || 0)) best = r;
    }
  }
  // No strict match: trust Deezer's own #1 hit, but ONLY if it lines up on at least artist
  // OR title. That tolerates artist aliases (2Pac/Tupac, a feat. credit) and title suffixes
  // (remaster, "(Live)") where the track is still right — while refusing a top hit that
  // matches neither, which would stamp an unrelated track's tempo on the song. A genuinely
  // unrelated result returns null and falls through to override / GetSongBPM / the gaps list.
  if (!best && results[0]) {
    const a = norm(results[0].artist?.name), t = norm(results[0].title);
    const related =
      a.includes(wantA) || wantA.includes(a) || t.includes(wantT) || wantT.includes(t);
    if (related) best = results[0];
  }
  if (!best) return null;
  const track = await getJson(`https://api.deezer.com/track/${best.id}`);
  if (!track || track.error) return null;
  const year = track.release_date ? Number(track.release_date.slice(0, 4)) : null;
  return {
    bpm: Math.round(track.bpm || 0),
    isrc: track.isrc || null,
    year: year && year > 1900 ? year : null,
    deezer_rank: track.rank || best.rank || 0,
    deezer_title: track.title,
    deezer_artist: track.artist?.name,
  };
}

// ---- GetSongBPM: gap-filler for songs Deezer can't tempo --------------
// Free but requires an API key (+ mandatory backlink to getsongbpm.com). Dormant unless
// GETSONGBPM_API_KEY is set. We take only tempo + year (key/time-sig are available but
// unused — not part of the app). API base is api.getsong.co (per docs, changed 2024-09).
// Limit: 3000 req/hour — we only call it on Deezer gaps, so well under.
// Response shapes (per docs): /search/ -> { search: [ {id,title,tempo,artist:{name},album:{year}} ] }
//                             /song/   -> { song: { tempo:"220", album:{year} } }
const GSB_BASE = 'https://api.getsong.co';
const GSB_KEY = process.env.GETSONGBPM_API_KEY || '';
async function getsongbpmEnrich(c) {
  if (!GSB_KEY) return null;
  const lookup = encodeURIComponent(`song:${c.title} artist:${c.artist}`);
  const search = await getJson(`${GSB_BASE}/search/?api_key=${GSB_KEY}&type=both&lookup=${lookup}`);
  const results = Array.isArray(search?.search) ? search.search
                : (search?.search?.id ? [search.search] : []);
  if (!results.length) return null;
  const wantA = norm(c.artist), wantT = norm(c.title);
  const hit = results.find((r) => {
    const a = norm(r.artist?.name), t = norm(r.title);
    return (a.includes(wantA) || wantA.includes(a)) && (t.includes(wantT) || wantT.includes(t));
  }) || results[0];
  let tempo = Number(hit.tempo) || 0;       // tempo can be a string ("220")
  let year = Number(hit.album?.year) || null;
  // search occasionally omits the tempo — fall back to the /song/ detail endpoint
  if (!tempo && hit.id) {
    const detail = await getJson(`${GSB_BASE}/song/?api_key=${GSB_KEY}&id=${hit.id}`);
    const song = detail?.song;
    if (song) {
      tempo = Number(song.tempo) || tempo;
      year = year || Number(song.album?.year) || null;
    }
  }
  if (!tempo) return null;
  return { bpm: Math.round(tempo), year };
}

// ---- MusicBrainz: ORIGINAL release year --------------------------------
// Deezer's release_date tracks the *matched* release (often a remaster/comp), so old
// songs get stamped with recent years. MusicBrainz exposes a recording's earliest
// release date, which is the real original year. We search by artist+title and take
// the minimum first-release-date across exact-title matches (so live/remaster/edit
// recordings — which carry their own later dates — are ignored).
// Policy: MB requires a descriptive User-Agent and allows ~1 req/sec (we pace 1100ms).
// Docs: https://musicbrainz.org/doc/MusicBrainz_API  ·  rate limit: /doc/MusicBrainz_API/Rate_Limiting
const MB_BASE = 'https://musicbrainz.org/ws/2';
const MB_UA = 'feelthebpm/1.0 ( https://feelthebpm.com )';
async function musicbrainzYear(c) {
  const query = `artist:"${c.artist}" AND recording:"${c.title}"`;
  const url = `${MB_BASE}/recording?query=${encodeURIComponent(query)}&limit=${MB_SEARCH_LIMIT}&fmt=json`;
  const data = await getJson(url, { headers: { 'User-Agent': MB_UA }, pace: 1100 });
  const recs = data?.recordings || [];
  const wantA = norm(c.artist), wantT = norm(c.title);
  let best = null;
  for (const r of recs) {
    const credit = (r['artist-credit'] || []).map((x) => x.name).join(' ');
    const a = norm(credit), t = norm(r.title);
    const artistOk = a.includes(wantA) || wantA.includes(a);
    if (!artistOk || t !== wantT) continue;     // exact title -> skip "(Live)/(Remaster)/(Edit)"
    const d = r['first-release-date'];
    if (!d) continue;
    const y = Number(String(d).slice(0, 4));
    if (y > 1900 && (best === null || y < best)) best = y;
  }
  return best;
}

// ---- YouTube: view count as a breadth (recognizability) signal ---------
// Shells out to yt-dlp (a system binary, like git — keeps the "no npm deps" property). A
// --flat-playlist search returns per-result view_count in one fast call (no video download).
// YouTube's universal reach is the broadest free "how many people know this" proxy and fixes
// Last.fm's rock/English skew. Caveat: views ≈ plays (not distinct listeners) and partly track
// artist fame, which is why it's weighted 0.55, not 1.0. See popularity-rework.md §4a.
// Dormant unless ENABLE_YOUTUBE=1 AND yt-dlp is on PATH (set in main()); misses fail soft.
let YT_ON = false;
const YT_ENABLED = process.env.ENABLE_YOUTUBE === '1';
// uploads that aren't the canonical recording — never count these toward "knows this song".
const YT_VARIANT_RE =
  /\b(cover|reaction|tutorial|lesson|how to play|backing track|karaoke|nightcore|mashup|remix|sped[ -]?up|slowed|loop(ed)?|\d+\s*hours?|8d audio)\b/i;

async function ytDlpPresent() {
  try { await execFileP('yt-dlp', ['--version']); return true; } catch { return false; }
}

// One yt-dlp search, cached to cache/yt-<md5(query)>.json (getJson can't serve a subprocess).
// Returns a slimmed [{title, channel, views}] array, or null on any failure (fail soft).
async function ytSearch(query) {
  const f = join(CACHE, 'yt-' + createHash('md5').update(query).digest('hex') + '.json');
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  try {
    const { stdout } = await execFileP(
      'yt-dlp',
      ['--flat-playlist', '-J', '--socket-timeout', '20', '--retries', '3', '--no-warnings', query],
      { maxBuffer: 64 * 1024 * 1024 }
    );
    const entries = (JSON.parse(stdout).entries || []).map((e) => ({
      title: e.title || '',
      channel: e.channel || e.uploader || '',
      views: e.view_count || 0,
    }));
    writeFileSync(f, JSON.stringify(entries));
    await sleep(YT_PACE_MS);
    return entries;
  } catch {
    return null; // yt-dlp missing / throttled / parse error -> song drops the signal
  }
}

// Canonical YouTube view count for a song: max views among top results whose channel OR
// title fuzzy-matches the artist AND whose title contains the song title, excluding non-canonical
// uploads (live/cover/remix/...). For famous songs the official video / Topic art-track is the max.
async function youtubeViews(c) {
  if (!YT_ON) return null;
  const entries = await ytSearch(`ytsearch${YT_SEARCH_N}:${c.artist} ${c.title}`);
  if (!entries || !entries.length) return null;
  const wantA = norm(c.artist), wantT = norm(c.title);
  let best = 0;
  for (const e of entries) {
    if (YT_VARIANT_RE.test(e.title)) continue;
    const a = norm(e.channel), t = norm(e.title);
    const artistOk = a.includes(wantA) || wantA.includes(a) || t.includes(wantA);
    const titleOk = t.includes(wantT) || wantT.includes(t);
    if (artistOk && titleOk && e.views > best) best = e.views;
  }
  return best || null;
}

// ---- popularity blend (0..100) -----------------------------------------
// Percentile rank (0..1) of each item's signal across the WHOLE set, ties sharing the lower
// rank: percentile = (# items with a strictly smaller value) / (n-1). A song MISSING the signal
// (value 0) therefore lands at 0 — a PENALTY, not a dropped term. This is deliberate: for a
// drummer's anchor metric, "nobody tabs this" should count *against* a song (it's likely a
// vocal/production-led track, a weaker tempo anchor), not be quietly ignored. Songsterr coverage
// is ~50%, so this penalty is the lever that pushes musician-anchor songs above streaming-pop.
// See .dev/reference/popularity-rework.md §4b. Percentile still guarantees an even spread (no
// lognorm saturation). Returns null if the signal is entirely absent (all 0 -> dormant, e.g.
// YouTube with no opt-in), so the caller drops it and renormalizes onto the remaining signals.
function percentileMap(items, getVal) {
  if (!items.some((it) => (getVal(it) || 0) > 0)) return null;
  const n = items.length;
  const sorted = items.map((it) => getVal(it) || 0).sort((a, b) => a - b);
  const below = (v) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; } return lo; };
  const m = new Map();
  items.forEach((it) => m.set(it, n > 1 ? below(getVal(it) || 0) / (n - 1) : 1));
  return m;
}

// Assign popularity from the percentile-ranked blend of each song's raw signals. `raw` maps
// record -> {youtube, rank, songsterr}. Signals with zero weight or no coverage (dormant) are
// skipped and the remaining weights renormalize. Mutates each record's popularity.
function assignPopularity(songs, raw) {
  const maps = [];
  for (const [sig, w] of Object.entries(POP_WEIGHTS)) {
    if (w <= 0) continue;
    const pm = percentileMap(songs, (s) => raw.get(s)[sig]);
    if (pm) maps.push([w, pm]); // null -> dormant signal, drop it
  }
  for (const s of songs) {
    let num = 0, den = 0;
    for (const [w, pm] of maps) { num += w * pm.get(s); den += w; }
    s.popularity = den > 0 ? Math.round((100 * num) / den) : 0;
  }
}

// ---- enrich one candidate ----------------------------------------------
// Turn a discovered candidate into a finished song record, or return null if we can't
// find a trustworthy BPM (the caller logs those as gaps). Exclusions are filtered by the
// caller before this runs, so every candidate reaching here is one we intend to keep.
// `overrides` is the normalized artist|title -> bpm table. Returns { record, yearSource }.
async function enrichCandidate(c, overrides) {
  const enr = await deezerEnrich(c);
  let bpm = enr?.bpm || 0;
  let gsbYear = null;
  const ov = overrides[key(c.artist, c.title)];
  if (ov) bpm = ov;
  // GetSongBPM fallback: only when Deezer AND override both came up empty
  if (!bpm) {
    const gsb = await getsongbpmEnrich(c);
    if (gsb?.bpm) {
      bpm = gsb.bpm;
      gsbYear = gsb.year;
    }
  }
  if (!bpm) return null; // can't tempo it -> gap (quality over quantity)
  // year: prefer MusicBrainz's original-release year (Deezer's is reissue-inflated).
  // Only looked up for songs we're keeping, to minimize MB calls (1 req/sec).
  const mbYear = await musicbrainzYear(c);
  // YouTube view breadth — only for kept songs (skip wasted yt-dlp calls on gaps).
  const yt = await youtubeViews(c);
  const fallbackYear = enr?.year ?? gsbYear ?? null;
  const record = {
    artist: c.artist,
    title: c.title,
    bpm,
    genre: c.genre,
    year: mbYear ?? fallbackYear,
    isrc: enr?.isrc ?? null,
    // popularity is assigned later by the whole-catalogue percentile pass (it needs every
    // song's signals). The raw signals are held in a SIDE MAP (not on the record), so they
    // can never leak into the shipped file — only the derived 0–100 score ships. See §3/§6.
  };
  const raw = { youtube: yt || 0, rank: enr?.deezer_rank || 0, songsterr: c.songsterr_views || 0 };
  return { record, raw, yearSource: mbYear ? 'musicbrainz' : (fallbackYear ? 'deezer' : null) };
}

// Load bpm_overrides.json into a normalized { "norm-artist|norm-title": bpm } map.
// Punctuation/case are normalized via key() so 'AC/DC|...' matches candidate keys;
// comment/section keys (leading '_') and non-numeric values are skipped.
function loadOverrides() {
  const raw = readJson(join(HERE, 'bpm_overrides.json')).overrides;
  const overrides = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_') || typeof v !== 'number') continue;
    const [a, t] = k.split('|');
    overrides[key(a, t)] = v;
  }
  return overrides;
}

// ---- seed (catalogue MEMBERSHIP) ---------------------------------------
// Which songs exist, independent of BPM/popularity. gatherCatalogue() unions every discovery
// source (Songsterr artist scrape + extra_songs.json) into one deduped candidate list, tagging
// each with the `source` that found it. `node pipeline/seed.mjs` writes it to catalogue.json — a
// reviewable, prunable artifact — and the build reads it back, so DISCOVERY and BUILD are
// decoupled: refresh the seed occasionally, build off it every run. songsterr_views rides on the
// seed entry because it's captured for free during the Songsterr scrape (it doubles as the
// Songsterr popularity signal). See .dev/reference/pipeline-architecture.md.
const CATALOGUE = join(HERE, 'catalogue.json');

async function gatherCatalogue() {
  const artists = readJson(join(HERE, 'artists.json')).artists;
  const extra = readJson(join(HERE, 'extra_songs.json')).songs;
  const UG = join(HERE, 'seed-ug.json');
  const candidates = new Map();
  // On a key collision, keep the FIRST record (its artist/title/genre/source) but absorb the
  // popularity signals (songsterr_views, ug_hits) — so a song discovered on Songsterr that's also
  // a top UG tab still carries its ug_hits for the (future) signal, without changing its identity.
  const add = (c) => {
    const k = key(c.artist, c.title);
    const prev = candidates.get(k);
    if (!prev) { candidates.set(k, c); return; }
    prev.songsterr_views = Math.max(prev.songsterr_views || 0, c.songsterr_views || 0);
    if (c.ug_hits) prev.ug_hits = Math.max(prev.ug_hits || 0, c.ug_hits);
  };
  console.error(`Scraping Songsterr for ${artists.length} artists...`);
  for (const a of artists) {
    const found = await songsterrForArtist(a.name, a.genre);
    console.error(`  ${a.name}: ${found.length} songs`);
    found.forEach((c) => add({ ...c, source: 'songsterr' }));
  }
  for (const s of extra)
    add({ artist: s.artist, title: s.title, genre: s.genre, source: 'extra', songsterr_views: s.songsterr_views || 0 });
  // Ultimate Guitar top-tab charts (membership + ug_hits) — manually harvested into seed-ug.json
  // (see seed-ug.mjs; UG is Cloudflare-gated so it can't be fetched live). Absent file = no UG
  // contribution. Net-new UG songs get a default genre; promote ones you care about into
  // extra_songs.json with a real genre (added before UG, so the proper entry wins the collision).
  if (existsSync(UG)) {
    const ug = readJson(UG).songs;
    ug.forEach((s) => add({ artist: s.artist, title: s.title, genre: 'rock', source: 'ultimate-guitar', songsterr_views: 0, ug_hits: s.ug_hits }));
    console.error(`  + Ultimate Guitar: ${ug.length} songs (seed-ug.json)`);
  }
  return [...candidates.values()];
}

// catalogue.json is a committed, hand-editable artifact (sorted so diffs stay reviewable).
function writeCatalogue(catalogue) {
  const songs = [...catalogue].sort((a, b) => `${a.artist} ${a.title}`.localeCompare(`${b.artist} ${b.title}`));
  const out = {
    _comment:
      'Generated SEED = catalogue membership (which songs exist). Refresh from sources with `node pipeline/seed.mjs` after editing artists.json / extra_songs.json. The build reads this file and only auto-generates it when absent (first run). `source` = which discovery source found the song; `songsterr_views` is the Songsterr popularity signal captured at discovery.',
    generated: new Date().toISOString().slice(0, 10),
    count: songs.length,
    songs,
  };
  writeFileSync(CATALOGUE, JSON.stringify(out, null, 2) + '\n');
  return songs.length;
}

// ---- main --------------------------------------------------------------
async function main() {
  const overrides = loadOverrides();
  // exclusion lists: every exclude*.json in the pipeline dir, each a reviewable list of
  // 'artist|title' keys (normalized like the candidates so 'queen|bohemian rhapsody' matches). By
  // file: exclude.json = no single meaningful tempo (multi-movement/rubato); exclude-obscure.json =
  // guitar/drum-tab "canon" musicians know but laypeople don't; exclude-contemporary.json =
  // too-recent-for-karaoke streaming hits. All unioned, applied as a build-time filter. See
  // .dev/reference/pipeline-architecture.md.
  const excludeSet = new Set(
    readdirSync(HERE)
      .filter((f) => /^exclude.*\.json$/.test(f))
      .flatMap((f) => readJson(join(HERE, f)).exclude
        .filter((k) => !k.startsWith('_'))
        .map((k) => { const [a, t] = k.split('|'); return key(a, t); }))
  );

  console.error(`GetSongBPM gap-filler: ${GSB_KEY ? 'ENABLED' : 'dormant (set GETSONGBPM_API_KEY to enable)'}`);
  // YouTube view breadth: needs the opt-in AND the yt-dlp binary; otherwise popularity falls
  // back to the Deezer+Songsterr blend (Tier A). Loud, like GSB — a silent fallback would hide
  // that the recognizability signal is missing.
  YT_ON = YT_ENABLED && (await ytDlpPresent());
  console.error(
    `YouTube views: ${
      YT_ON ? 'ENABLED'
      : YT_ENABLED ? 'requested but yt-dlp NOT FOUND on PATH — dormant'
      : 'dormant (set ENABLE_YOUTUBE=1 and install yt-dlp to enable)'
    }`
  );

  // 1. seed: read the reviewable catalogue (membership). Auto-generate on first run so a fresh
  // checkout still builds; refresh deliberately with `node pipeline/seed.mjs`.
  let catalogue;
  if (existsSync(CATALOGUE)) {
    catalogue = readJson(CATALOGUE).songs;
    console.error(`Seed: ${catalogue.length} songs from catalogue.json (refresh: node pipeline/seed.mjs).`);
  } else {
    console.error('No catalogue.json — generating the seed from sources (first run)...');
    catalogue = await gatherCatalogue();
    console.error(`Seed: wrote ${writeCatalogue(catalogue)} songs -> catalogue.json.`);
  }
  console.error(`\n${catalogue.length} unique candidates. Enriching via Deezer...`);

  // 2. enrich
  const out = [];
  const gaps = [];
  const excluded = [];
  // record -> { youtube, rank, songsterr }: raw popularity signals kept OFF the shipped record,
  // consumed by the percentile blend (step 3b) and the dedup tie-break (step 3). Never written.
  const rawSignals = new Map();
  let i = 0;
  let yearFromMB = 0, yearFromDeezer = 0; // year-source tally (for the build summary)
  for (const c of catalogue) {
    i++;
    const k = key(c.artist, c.title);
    // drop multi-tempo / rubato songs up front (no single meaningful BPM to anchor to).
    // Done before any network call — no point enriching a song we're discarding.
    if (excludeSet.has(k)) { excluded.push(k); continue; }
    const enriched = await enrichCandidate(c, overrides);
    if (!enriched) {
      gaps.push(k); // couldn't find a trustworthy BPM
    } else {
      out.push(enriched.record);
      rawSignals.set(enriched.record, enriched.raw);
      if (enriched.yearSource === 'musicbrainz') yearFromMB++;
      else if (enriched.yearSource === 'deezer') yearFromDeezer++;
    }
    if (i % 25 === 0) console.error(`  [${i}/${catalogue.length}]`);
  }

  // 3. dedup: collapse arrangement / parenthetical variants of the same song (per artist).
  // Safety net for anything that slipped past cleanTitle (e.g. "Burning Heart (Rocky)").
  const dupKey = (artist, title) =>
    key(artist, cleanTitle(title.replace(/[\(\[][^)\]]*[\)\]]/g, ' '))); // drop ALL parens, then clean
  // popularity isn't computed yet (it's a whole-catalogue percentile pass — step 3b), so the
  // "keep the more popular variant" tie-break runs on RAW signals: YouTube reach, then Deezer
  // rank, then Songsterr views, then the cleaner (shorter) title.
  const morePopularRaw = (a, b) => {
    const ra = rawSignals.get(a), rb = rawSignals.get(b);
    if (ra.youtube !== rb.youtube) return ra.youtube > rb.youtube ? a : b;
    if (ra.rank !== rb.rank) return ra.rank > rb.rank ? a : b;
    if (ra.songsterr !== rb.songsterr) return ra.songsterr > rb.songsterr ? a : b;
    return a.title.length <= b.title.length ? a : b;
  };
  const byDup = new Map();
  for (const r of out) {
    const k = dupKey(r.artist, r.title);
    const prev = byDup.get(k);
    if (!prev) { byDup.set(k, r); continue; }
    const keep = morePopularRaw(r, prev);
    if (keep !== prev) byDup.set(k, keep);
  }
  const deduped = [...byDup.values()];
  const nDropped = out.length - deduped.length;

  // 3b. popularity: percentile-ranked, breadth-weighted blend over the FULL surviving set
  // (needs every song's signals, so it runs here, not per-song). Raw signals stay in rawSignals
  // and are never written; only the derived 0–100 score lands on each record.
  assignPopularity(deduped, rawSignals);

  // optional: dump the deduped set's RAW signals so weights can be swept offline (no network).
  // Lands in the gitignored cache — raw provider signals must never be committed (see §3) —
  // and is read by pipeline/sweep-weights.mjs. Enable with DUMP_SIGNALS=1.
  if (process.env.DUMP_SIGNALS) {
    const dump = deduped.map((s) => ({ artist: s.artist, title: s.title, bpm: s.bpm, raw: rawSignals.get(s) }));
    writeFileSync(join(CACHE, 'signals.json'), JSON.stringify(dump));
    console.error(`Dumped ${dump.length} raw-signal rows -> pipeline/cache/signals.json (gitignored).`);
  }

  deduped.sort((a, b) => a.bpm - b.bpm || b.popularity - a.popularity);
  writeFileSync(join(SITE, 'songs.json'), JSON.stringify(deduped, null, 2));
  // songs.js lets index.html load via <script> so it works on file:// (no server / no CORS)
  writeFileSync(join(SITE, 'songs.js'), `window.SONGS = ${JSON.stringify(deduped)};\n`);
  writeFileSync(join(HERE, 'gaps.json'), JSON.stringify(gaps, null, 2));
  // build manifest: provenance git can't infer from songs.json alone (how it was produced).
  // Ships in public/ so it deploys with the data and can double as a version stamp.
  const ytCovered = deduped.filter((s) => rawSignals.get(s).youtube > 0).length;
  const meta = {
    built: new Date().toISOString().slice(0, 10),
    songs: deduped.length,
    year_sources: { musicbrainz: yearFromMB, deezer: yearFromDeezer },
    popularity: { method: 'percentile-blend', weights: POP_WEIGHTS, youtube: { enabled: YT_ON, coverage: ytCovered } },
    excluded: excluded.length,
    bpm_gaps: gaps.length,
  };
  writeFileSync(join(SITE, 'version.json'), JSON.stringify(meta, null, 2) + '\n');
  // popularity spread — quick proof the percentile blend de-saturated (old lognorm sat at 76–100).
  const pops = deduped.map((s) => s.popularity).sort((a, b) => a - b);
  const pctl = (p) => pops[Math.min(pops.length - 1, Math.floor((p / 100) * pops.length))];
  console.error(
    `\nPopularity spread: min ${pops[0]} · p10 ${pctl(10)} · p25 ${pctl(25)} · p50 ${pctl(50)} · p75 ${pctl(75)} · p90 ${pctl(90)} · max ${pops[pops.length - 1]}`
  );
  console.error(`YouTube coverage: ${ytCovered}/${deduped.length} songs have a view count (${YT_ON ? 'enabled' : 'dormant'}).`);
  console.error(`Deduped ${nDropped} arrangement variant(s).`);
  console.error(`Excluded ${excluded.length} multi-tempo song(s) via exclude.json: ${excluded.join(', ') || '(none matched)'}`);
  console.error(`Year source: ${yearFromMB} from MusicBrainz (original release), ${yearFromDeezer} from Deezer fallback.`);
  console.error(`Done. ${deduped.length} songs -> songs.json`);
  console.error(`${gaps.length} BPM gaps -> pipeline/gaps.json (add to bpm_overrides.json)`);
}

// Reusable pieces for sibling tools (e.g. pipeline/eval-gsb.mjs) — exported so the eval
// runs the EXACT production matching logic instead of a drifting reimplementation.
export { norm, key, getJson, deezerEnrich, getsongbpmEnrich, loadOverrides, percentileMap, POP_WEIGHTS, gatherCatalogue, writeCatalogue };

// Run the build only when invoked directly (node pipeline/build.mjs), not when imported.
// Fail loud and non-zero on any unhandled error, so a broken run can't masquerade as a
// successful build (writing nothing) or surface as a bare unhandled-rejection trace.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error('\nBuild failed:', e?.stack || e);
    process.exit(1);
  });
}
