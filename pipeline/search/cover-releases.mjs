#!/usr/bin/env node
// Write pipeline/generated/cover-releases.json: for each curated song, the MusicBrainz release the
// canonical dump lists for it. build.mjs fetches that release's front cover from the Cover Art
// Archive (.mind/cover-art-source.md). A separate, committed file so the build doesn't need the
// 20 GB working database; rerun this after the curated catalogue gains songs (a song missing from
// the file still gets a cover, picked from its MusicBrainz release groups).
//
//   node pipeline/search/cover-releases.mjs
//
// Matching is build-search.mjs's: the open-data song with the same title and artist (or an alias,
// or one artist name containing the other), most readings first.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { key, norm } from '../build.mjs';
import { CURATED, OPEN_DATA_DB } from './paths.mjs';
import { ARTIST_ALIASES } from './aliases.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'generated', 'cover-releases.json');
const curated = JSON.parse(readFileSync(CURATED, 'utf8'));
const db = new DatabaseSync(OPEN_DATA_DB, { readOnly: true });

const titles = new Set(curated.map((c) => norm(c.title)));
db.function('wanted', { deterministic: true }, (t) => (titles.has(norm(t)) ? 1 : 0));
const rows = db.prepare('SELECT mbid, artist, title FROM songs WHERE wanted(title) ORDER BY readings DESC').all()
  .map((r) => ({ mbid: r.mbid, a: norm(r.artist), t: norm(r.title) }));
const releaseOf = db.prepare('SELECT release_mbid FROM meta WHERE recording_mbid = ? ORDER BY score LIMIT 1');

const out = {};
for (const c of curated) {
  const a = norm(c.artist), names = [a, ...(ARTIST_ALIASES[a] ?? [])];
  const same = rows.filter((r) => r.t === norm(c.title));
  const hit = same.find((r) => names.includes(r.a)) || same.find((r) => r.a && names.some((n) => r.a.includes(n) || n.includes(r.a)));
  const release = hit && releaseOf.get(hit.mbid)?.release_mbid;
  if (release) out[key(c.artist, c.title)] = release;
}
writeFileSync(OUT, JSON.stringify(Object.fromEntries(Object.entries(out).sort()), null, 2) + '\n');
console.error(`${OUT}: ${Object.keys(out).length} of ${curated.length} curated songs have a canonical release`);
