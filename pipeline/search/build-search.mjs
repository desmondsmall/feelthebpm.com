#!/usr/bin/env node
// Song search, step 3: write search.db (the file the search endpoint serves) and manifest.json.
//
//   node pipeline/search/build-search.mjs
//
// Reads the working database (open-data.db, from load.sh) and the curated catalogue
// (public/songs.json). What goes in, and why (reasoning and measurements: .mind/song-search/):
// - Every song with a tempo and a name: search is for finding a specific song, so nothing is
//   filtered out for being obscure.
// - song.id is the tie-break rank: curated songs first, then by the number of AcousticBrainz
//   readings (how many people analysed the song from their own libraries — a free measure of how
//   common it is, which put the expected song first for common titles better than ListenBrainz
//   listener counts did). Search ranks by match quality first and uses id to order songs within
//   a match tier, so every index ends in id.
// - artist_norm / title_norm (api/normalize.mjs) with indexes, for exact and prefix title/artist
//   matches; an FTS5 index over artist and title for word matches.
// - bpm_alt: the raw reading's other octave when that is a plausible felt tempo (60–180), because
//   detectors often report half or double time (Let It Be reads 139.6, felt 72). Null otherwise.
// - Curated songs merged in: a match takes the curated felt BPM and fields and is marked curated;
//   a curated song with no match is added as its own row, so every curated song is searchable.
import { DatabaseSync } from 'node:sqlite';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalize } from '../../api/normalize.mjs';
import { norm, key } from '../build.mjs';
import { CURATED, MANIFEST, OPEN_DATA, OPEN_DATA_DB, SEARCH_DB } from './paths.mjs';

const ALT_MIN = 60, ALT_MAX = 180;   // a plausible felt tempo, a little wider than the curated 70–175
// Artists the curated catalogue names differently from MusicBrainz, which neither the exact key nor
// the "one name contains the other" fallback can bridge. Keys and values are build.mjs norm() form.
const ARTIST_ALIASES = { tupac: ['2pac'] };
const SCHEMA_VERSION = 2;   // 2: no listener counts; id ranks curated first, then by readings
const log = (s) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${s}`);

const TMP = `${SEARCH_DB}.tmp`;
if (existsSync(TMP)) rmSync(TMP);
const db = new DatabaseSync(TMP);
db.function('normalize', { deterministic: true }, (s) => normalize(s));
db.function('ckey', { deterministic: true }, (a, t) => key(a, t));     // the curated catalogue's key
db.function('tkey', { deterministic: true }, (t) => norm(t));
db.exec(`
  PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA page_size = 4096;
  PRAGMA temp_store = FILE; PRAGMA cache_size = -1000000;
  ATTACH '${OPEN_DATA_DB}' AS src;
`);

// ---- 1. the open-data songs ----
log('staging songs');
db.exec(`
  CREATE TEMP TABLE stage AS
    SELECT mbid, artist, title, bpm, readings, spread,
           ckey(artist, title) AS ckey, tkey(title) AS tkey, 0 AS dropped
    FROM src.songs WHERE artist <> '' AND title <> '';
  CREATE INDEX temp.stage_ckey ON stage (ckey);
  CREATE INDEX temp.stage_tkey ON stage (tkey);
`);
log(`${db.prepare('SELECT count(*) AS n FROM stage').get().n} songs staged`);

// ---- 2. merge the curated catalogue ----
const curated = JSON.parse(readFileSync(CURATED, 'utf8'));
const byKey = db.prepare('SELECT rowid, ckey, artist, title, readings FROM stage WHERE ckey = ? ORDER BY readings DESC');
const byTitle = db.prepare('SELECT rowid, ckey, artist, title, readings FROM stage WHERE tkey = ? ORDER BY readings DESC');
const drop = db.prepare('UPDATE stage SET dropped = 1 WHERE ckey = ?');
const matched = [], added = [], report = [];
for (const c of curated) {
  const ck = key(c.artist, c.title), a = norm(c.artist);
  const names = [a, ...(ARTIST_ALIASES[a] ?? [])];
  // Exact normalized artist + title first (also under a known alias); then the same title with one
  // artist name containing the other ("Bob Marley" / "Bob Marley & The Wailers"). Most readings
  // wins among candidates.
  let hit, how = 'exact';
  for (const n of names) if ((hit = byKey.get(`${n}|${norm(c.title)}`))) break;
  if (!hit) {
    hit = byTitle.all(norm(c.title)).find((r) => { const b = norm(r.artist); return b && names.some((n) => n && (b.includes(n) || n.includes(b))); });
    how = 'artist-contains';
  }
  if (hit) {
    // The open row becomes the curated row. Rows with the same normalized artist + title (under the
    // curated name, an alias, or the matched row's own credit) are the same song, so they go too.
    for (const k of new Set([ck, hit.ckey, ...names.map((n) => `${n}|${norm(c.title)}`)])) drop.run(k);
    matched.push({ c, readings: hit.readings });
    report.push(`${how.padEnd(15)} ${c.artist} — ${c.title}  ⇐  ${hit.artist} — ${hit.title} (${hit.readings} readings)`);
  } else {
    added.push(c);
    report.push(`${'added'.padEnd(15)} ${c.artist} — ${c.title}  (no open-data match)`);
  }
}
log(`curated: ${matched.length} matched, ${added.length} added as their own rows`);

db.exec(`
  CREATE TEMP TABLE cur (artist TEXT, title TEXT, bpm REAL, readings INT, genre TEXT, year INT, isrc TEXT, cover TEXT, youtube_id TEXT);
`);
const insCur = db.prepare('INSERT INTO cur VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
for (const { c, readings } of [...matched, ...added.map((c) => ({ c, readings: null }))]) {
  insCur.run(c.artist, c.title, c.felt_bpm ?? c.bpm, readings, c.genre ?? null, c.year ?? null, c.isrc ?? null, c.cover ?? null, c.youtube_id ?? null);
}

// ---- 3. write the song table, numbered by tie-break rank ----
log('writing song table');
db.exec(`
  CREATE TABLE song (
    id INTEGER PRIMARY KEY,          -- tie-break rank: curated songs first, then most AcousticBrainz readings
    mbid TEXT,                       -- MusicBrainz recording; null for a curated song with no open-data match
    artist TEXT NOT NULL, title TEXT NOT NULL,
    artist_norm TEXT NOT NULL, title_norm TEXT NOT NULL,
    bpm REAL NOT NULL,               -- curated: felt BPM; otherwise the raw reading (median of readings)
    bpm_alt REAL,                    -- the other octave when plausible; null for curated songs
    readings INT, spread REAL,       -- how many readings, and max/min between them; null for an added curated song
    curated INT NOT NULL DEFAULT 0,
    genre TEXT, year INT, isrc TEXT, cover TEXT, youtube_id TEXT
  );
  INSERT INTO song (mbid, artist, title, artist_norm, title_norm, bpm, bpm_alt, readings, spread, curated, genre, year, isrc, cover, youtube_id)
    SELECT mbid, artist, title, normalize(artist), normalize(title), bpm, bpm_alt, readings, spread, curated, genre, year, isrc, cover, youtube_id FROM (
      SELECT mbid, artist, title, bpm,
             round(CASE WHEN bpm / 2 >= ${ALT_MIN} THEN bpm / 2 WHEN bpm * 2 <= ${ALT_MAX} THEN bpm * 2 END, 1) AS bpm_alt,
             readings, spread, 0 AS curated,
             NULL AS genre, NULL AS year, NULL AS isrc, NULL AS cover, NULL AS youtube_id
        FROM stage WHERE dropped = 0
      UNION ALL
      SELECT NULL, artist, title, bpm, NULL, readings, NULL, 1, genre, year, isrc, cover, youtube_id FROM cur
    ) ORDER BY curated DESC, readings DESC, artist, title;
  DETACH src;
`);

// ---- 4. indexes ----
log('indexing');
db.exec(`
  CREATE INDEX song_title ON song (title_norm, id);
  CREATE INDEX song_artist ON song (artist_norm, id);
  CREATE INDEX song_bpm ON song (bpm, id);
  CREATE INDEX song_bpm_alt ON song (bpm_alt, id) WHERE bpm_alt IS NOT NULL;
  CREATE VIRTUAL TABLE fts USING fts5(artist, title, content='song', content_rowid='id',
    tokenize='unicode61 remove_diacritics 2', prefix='1 2 3', detail=none);
  INSERT INTO fts (fts) VALUES ('rebuild');
  INSERT INTO fts (fts) VALUES ('optimize');
`);
const count = (sql) => db.prepare(sql).get().n;
const stats = {
  songs: count('SELECT count(*) AS n FROM song'),
  curated: count('SELECT count(*) AS n FROM song WHERE curated = 1'),
  with_bpm_alt: count('SELECT count(*) AS n FROM song WHERE bpm_alt IS NOT NULL'),
};
db.close();
const v = new DatabaseSync(TMP); v.exec('VACUUM'); v.close();
renameSync(TMP, SEARCH_DB);

// ---- 5. manifest: what this file was built from ----
const readMaybe = (f) => (existsSync(f) ? readFileSync(f, 'utf8').trim() : null);
const git = (cmd) => { try { return execSync(`git ${cmd}`, { encoding: 'utf8' }).trim(); } catch { return null; } };
const manifest = {
  schema_version: SCHEMA_VERSION,
  built_at: new Date().toISOString(),
  pipeline_commit: git('rev-parse HEAD'),
  pipeline_dirty: Boolean(git('status --porcelain -- pipeline/search api')),
  inputs: {
    acousticbrainz: 'acousticbrainz-lowlevel-features-20220623 (rhythm)',
    musicbrainz_canonical: readMaybe(join(OPEN_DATA, 'canonical.version')),
    curated_songs: curated.length,
  },
  counts: { ...stats, curated_matched: matched.length, curated_added: added.length },
  bytes: statSync(SEARCH_DB).size,
};
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(join(OPEN_DATA, 'curated-merge.txt'), report.join('\n') + '\n');
log(`${SEARCH_DB}: ${stats.songs} songs, ${(manifest.bytes / 1e6).toFixed(0)} MB; manifest and curated-merge.txt written`);
