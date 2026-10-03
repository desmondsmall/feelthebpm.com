#!/usr/bin/env node
// Evaluate the Cover Art Archive (CAA) as the source of album art WITHOUT touching public/.
// Writes the report to .mind/cover-art-eval.md and a side-by-side page (current cover vs CAA) to
// pipeline/cache/cover-compare.html; none of it is deployed. Why: .mind/song-search/plan.md.
//
//   node pipeline/tools/eval-covers.mjs
//
// Asks two questions:
//   1. Curated — for each shipped song, is there a CAA front cover for a release group it is on,
//      and how good a release group (the original album, a single, a compilation)? Uses the
//      MusicBrainz recording search build.mjs already cached, so it makes no MusicBrainz calls
//      after a full build.
//   2. Search — for open-data songs, does the canonical release in search's working database have
//      a CAA front cover? Sampled: the most-read songs and a random draw. Skipped when the
//      working database (pipeline/cache/open-data/open-data.db) isn't there.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { norm, getJson } from '../build.mjs';
import { OPEN_DATA_DB, SEARCH_DB } from '../search/paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SONGS = JSON.parse(readFileSync(join(ROOT, 'public', 'songs.json'), 'utf8'));
const CAA = 'https://coverartarchive.org';
const MB_UA = 'feelthebpm/1.0 ( https://feelthebpm.com )';
const MB_SEARCH_LIMIT = 25;          // must match build.mjs, so the URL hits its cache
const MAX_TRIES = 6;                 // release groups to try per curated song
const SAMPLE = 300;                  // open-data songs per sample
const CONCURRENCY = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// CAA answers 307 (to the image on archive.org) when it has a front cover and 404 when it doesn't.
// Cached on disk, so a re-run only asks about what it hasn't seen.
const SEEN_FILE = join(HERE, '..', 'cache', 'caa-front.json');
const seen = existsSync(SEEN_FILE) ? JSON.parse(readFileSync(SEEN_FILE, 'utf8')) : {};
async function hasFront(kind, mbid) {
  const k = `${kind}/${mbid}`;
  if (k in seen) return seen[k];
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`${CAA}/${k}/front-250`, { method: 'HEAD', redirect: 'manual', headers: { 'User-Agent': MB_UA } });
      if (res.status === 307 || res.status === 302 || res.status === 200) return (seen[k] = true);
      if (res.status === 404) return (seen[k] = false);
    } catch { /* retry */ }
    await sleep(1500 * (attempt + 1));
  }
  return null;                        // unknown (CAA unreachable); not cached
}
async function pool(items, fn) {
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
      if (++done % 50 === 0) { process.stderr.write(`  ${done}/${items.length}\n`); writeFileSync(SEEN_FILE, JSON.stringify(seen)); }
    }
  }));
  writeFileSync(SEEN_FILE, JSON.stringify(seen));
}

// ---- 1. curated ---------------------------------------------------------
// How good a release group is as "the cover people know": the studio album first, then the single
// or EP, then soundtracks and other secondary types, compilations and live albums last.
const KINDS = ['album', 'single/EP', 'other', 'compilation/live'];
function kindOf(rg) {
  const p = rg['primary-type'], s = rg['secondary-types'] || [];
  if (s.some((x) => ['Compilation', 'Live', 'DJ-mix', 'Mixtape/Street', 'Interview', 'Demo'].includes(x))) return 3;
  if (s.length) return 2;
  return p === 'Album' ? 0 : (p === 'Single' || p === 'EP') ? 1 : 2;
}
async function candidates(c) {
  const query = `artist:"${c.artist}" AND recording:"${c.title}"`;
  const url = `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(query)}&limit=${MB_SEARCH_LIMIT}&fmt=json`;
  const data = await getJson(url, { headers: { 'User-Agent': MB_UA }, pace: 1100 });
  const wantA = norm(c.artist), wantT = norm(c.title);
  const groups = new Map();           // release group id -> { id, title, kind, date }
  for (const r of data?.recordings || []) {
    const a = norm((r['artist-credit'] || []).map((x) => x.name).join(' '));
    if (!(a.includes(wantA) || wantA.includes(a)) || norm(r.title) !== wantT) continue;
    for (const rel of r.releases || []) {
      const rg = rel['release-group'];
      if (!rg?.id || (rel.status && rel.status !== 'Official')) continue;
      const date = rel.date || '9999';
      const g = groups.get(rg.id);
      if (!g) groups.set(rg.id, { id: rg.id, title: rg.title, kind: kindOf(rg), date });
      else if (date < g.date) g.date = date;
    }
  }
  return [...groups.values()].sort((x, y) => x.kind - y.kind || (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
}

console.error(`curated: ${SONGS.length} songs`);
const curated = [];
await pool(SONGS, async (c) => {
  const cands = await candidates(c);
  let hit = null, unknown = false;
  for (const g of cands.slice(0, MAX_TRIES)) {
    const ok = await hasFront('release-group', g.id);
    if (ok) { hit = g; break; }
    if (ok === null) unknown = true;
  }
  curated.push({ c, cands: cands.length, hit, unknown: !hit && unknown });
});
curated.sort((x, y) => SONGS.indexOf(x.c) - SONGS.indexOf(y.c));

// ---- 2. search (open data) ----------------------------------------------
let samples = null;
if (existsSync(OPEN_DATA_DB) && existsSync(SEARCH_DB)) {
  const db = new DatabaseSync(SEARCH_DB, { readOnly: true });
  db.exec(`ATTACH '${OPEN_DATA_DB}' AS od`);

  // The same route for the curated songs: the open-data song with the curated title and a matching
  // artist (most readings wins, as in build-search.mjs), then that song's canonical release.
  console.error('curated: canonical releases');
  const titles = new Set(SONGS.map((c) => norm(c.title)));
  db.function('wanted', { deterministic: true }, (t) => (titles.has(norm(t)) ? 1 : 0));
  const rows = db.prepare('SELECT mbid, artist, title, readings FROM od.songs WHERE wanted(title) ORDER BY readings DESC').all();
  const relOf = db.prepare('SELECT release_mbid, release_name FROM od.meta WHERE recording_mbid = ? ORDER BY score LIMIT 1');
  for (const x of curated) {
    const a = norm(x.c.artist), t = norm(x.c.title);
    const same = rows.filter((r) => norm(r.title) === t);
    const hit = same.find((r) => norm(r.artist) === a) || same.find((r) => { const b = norm(r.artist); return b && (b.includes(a) || a.includes(b)); });
    const rel = hit && relOf.get(hit.mbid);
    x.canon = rel ? { id: rel.release_mbid, title: rel.release_name } : null;
  }
  await pool(curated.filter((x) => x.canon), async (x) => { x.canon.ok = await hasFront('release', x.canon.id); });
  const withRelease = (rows) => rows.map((r) => ({
    ...r,
    release: db.prepare('SELECT release_mbid FROM od.meta WHERE recording_mbid = ? ORDER BY score LIMIT 1').get(r.mbid)?.release_mbid ?? null,
  }));
  const max = db.prepare('SELECT max(id) AS n FROM song').get().n;
  const ids = new Set();
  let seed = 20261003;                // fixed, so a re-run asks about the same songs
  while (ids.size < SAMPLE * 2) { seed = (seed * 1103515245 + 12345) % 2147483648; ids.add(1 + (seed % max)); }
  samples = {
    'most-read open-data songs': withRelease(db.prepare(`SELECT mbid, artist, title FROM song WHERE curated = 0 AND mbid IS NOT NULL ORDER BY id LIMIT ${SAMPLE}`).all()),
    'random open-data songs': withRelease(db.prepare(`SELECT mbid, artist, title FROM song WHERE curated = 0 AND mbid IS NOT NULL AND id IN (${[...ids].join(',')}) LIMIT ${SAMPLE}`).all()),
  };
  for (const [name, rows] of Object.entries(samples)) {
    console.error(`search: ${name} (${rows.length})`);
    await pool(rows, async (r) => { r.ok = r.release ? await hasFront('release', r.release) : false; });
  }
}

// ---- report ---------------------------------------------------------------
const pct = (n, d) => (d ? `${n} (${Math.round((100 * n) / d)}%)` : '0');
const found = curated.filter((x) => x.hit);
const lines = [
  '# Cover art eval: Cover Art Archive',
  '',
  `Generated by \`pipeline/tools/eval-covers.mjs\` on ${new Date().toISOString().slice(0, 10)}. A snapshot: rerun rather than edit. It says whether a cover exists, not whether it is the cover people know; for that, open \`pipeline/cache/cover-compare.html\`.`,
  '',
  '## Curated songs (for downloading)',
  '',
  `Each song's release groups come from the cached MusicBrainz recording search (exact title, official releases), tried in order: studio album, single or EP, other, compilation or live; earliest first within a kind; at most ${MAX_TRIES} tried.`,
  '',
  '| | songs |',
  '|---|---|',
  `| curated songs | ${curated.length} |`,
  `| with a Cover Art Archive front cover | ${pct(found.length, curated.length)} |`,
  ...KINDS.map((k, i) => `| … from ${k === 'other' ? 'another kind of release' : `a ${k}`} | ${pct(found.filter((x) => x.hit.kind === i).length, curated.length)} |`),
  `| no cover found | ${pct(curated.length - found.length, curated.length)} |`,
  `| … of those, no release group matched in MusicBrainz | ${curated.filter((x) => !x.hit && !x.cands).length} |`,
  `| … of those, Cover Art Archive didn't answer | ${curated.filter((x) => x.unknown).length} |`,
  '',
  '### No cover found',
  '',
  ...(curated.filter((x) => !x.hit).map((x) => `- ${x.c.artist} — ${x.c.title} (${x.cands} release groups)`)),
  '',
  '### Cover from a compilation or live release',
  '',
  ...(found.filter((x) => x.hit.kind === 3).map((x) => `- ${x.c.artist} — ${x.c.title}: *${x.hit.title}*`)),
  '',
];
if (samples) {
  const canon = curated.filter((x) => x.canon), canonOk = canon.filter((x) => x.canon.ok);
  lines.push('## Curated songs, by the canonical release', '',
    'The other route: the release the MusicBrainz canonical dump lists for the song (the route search would use), checked by release.', '',
    '| | songs |', '|---|---|',
    `| matched to an open-data song | ${pct(canon.length, curated.length)} |`,
    `| with a front cover for its canonical release | ${pct(canonOk.length, curated.length)} |`,
    `| with a cover by either route | ${pct(curated.filter((x) => x.hit || x.canon?.ok).length, curated.length)} |`, '',
    '| song | canonical release | cover |', '|---|---|---|',
    ...canon.map((x) => `| ${x.c.artist} — ${x.c.title} | ${x.canon.title} | ${x.canon.ok ? 'yes' : 'no'} |`), '');
  lines.push('## Open-data songs (for hotlinking from search)', '',
    'The release is the one the MusicBrainz canonical dump lists for the song, which is what search could carry per row. Checked by release, not release group.', '',
    '| sample | songs | with a release | with a front cover |', '|---|---|---|---|');
  for (const [name, rows] of Object.entries(samples)) {
    lines.push(`| ${name} | ${rows.length} | ${pct(rows.filter((r) => r.release).length, rows.length)} | ${pct(rows.filter((r) => r.ok).length, rows.length)} |`);
  }
  lines.push('');
}
const out = join(ROOT, '.mind', 'cover-art-eval.md');
writeFileSync(out, lines.join('\n'));

const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const html = `<!doctype html><meta charset="utf-8"><title>Cover compare</title>
<style>body{font:14px system-ui;margin:16px;background:#111;color:#ddd}.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(400px,1fr));gap:14px}
.c{background:#1c1c1c;padding:8px;border-radius:6px}.p{display:flex;gap:6px}img,.n{width:125px;height:125px;object-fit:cover;background:#333}
.n{display:flex;align-items:center;justify-content:center;color:#888}.k{color:#888;font-size:12px}.k3{color:#e0a030}</style>
<h1>Current cover · Cover Art Archive by release group · by canonical release</h1><div class="g">
${curated.map((x) => `<div class="c"><div class="p"><img loading="lazy" src="../../public/${esc(x.c.cover || '')}">${x.hit ? `<img loading="lazy" src="${CAA}/release-group/${x.hit.id}/front-250">` : '<div class="n">none</div>'}${x.canon?.ok ? `<img loading="lazy" src="${CAA}/release/${x.canon.id}/front-250">` : '<div class="n">none</div>'}</div>
<div>${esc(x.c.title)}</div><div class="k">${esc(x.c.artist)}</div><div class="k k${x.hit?.kind ?? ''}">${x.hit ? `${KINDS[x.hit.kind]}: ${esc(x.hit.title)}` : ''}</div><div class="k">${x.canon ? `canonical: ${esc(x.canon.title)}` : ''}</div></div>`).join('\n')}
</div>`;
const page = join(HERE, '..', 'cache', 'cover-compare.html');
writeFileSync(page, html);
console.error(`wrote ${out}\nwrote ${page}`);
console.log(lines.join('\n'));
