// Tests for the song-search pipeline: load.sh on tiny dumps, then build-search.mjs on the result.
//   node --test pipeline/search/*.test.mjs
// Needs zstd and the sqlite3 command-line tool (as load.sh does). No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'search-test-'));
const env = { ...process.env, SEARCH_OPEN_DATA: dir, SEARCH_CURATED: join(dir, 'songs.json') };

// MBIDs: short readable stand-ins (the pipeline treats them as opaque text).
const csv = (rows) => rows.map((r) => r.join(',')).join('\n') + '\n';
function tarZst(name, files) {   // files: { 'path/in/tar': contents }
  const stage = join(dir, 'stage');
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(stage, p)), { recursive: true }); writeFileSync(join(stage, p), body); }
  execFileSync('sh', ['-c', `tar -cf - -C '${stage}' ${Object.keys(files).map((p) => `'${p}'`).join(' ')} | zstd -q -o '${join(dir, name)}'`]);
  rmSync(stage, { recursive: true });
}

// AcousticBrainz readings (mbid, offset, bpm, 4 histogram columns, danceability, onset_rate).
const ab = [['mbid', 'submission_offset', 'bpm', 'p1m', 'p1md', 'p2m', 'p2md', 'danceability', 'onset_rate']];
const reading = (mbid, bpm) => ab.push([mbid, 0, bpm, 0, 0, 0, 0, 0, 0]);
reading('yest-canon', 96.0); reading('yest-remaster', 98.0); reading('yest-remaster', 97.0);  // 3 readings (merged) → median 97
reading('letitbe', 139.6);       // octave case: alt = 69.8
reading('blinding', 85.5);       // alt = 171
reading('mid', 105.0);           // neither octave plausible → no alt
reading('obscure', 120.0);       // one reading: kept anyway (nothing is filtered for being obscure)
reading('marley', 76.0);         // curated by "Bob Marley" (artist-contains match)
reading('cover', 140.0);         // a cover with the same title as a curated song
reading('dup', 139.0);           // a second "Let It Be" by the same artist: dropped as a duplicate
reading('cyrillic', 110.0);
reading('calilove', 92.0);       // credited to "2Pac"; the curated catalogue says "Tupac"
reading('calilove2', 91.0);
tarZst('ab-rhythm.tar.zst', { 'acousticbrainz-lowlevel-features-20220623/acousticbrainz-lowlevel-features-20220623-rhythm.csv': csv(ab), 'acousticbrainz-lowlevel-features-20220623/COPYING': 'CC0\n' });

const meta = [['id', 'artist_credit_id', 'artist_mbids', 'artist_credit_name', 'release_mbid', 'release_name', 'recording_mbid', 'recording_name', 'combined_lookup', 'score']];
const song = (id, mbid, artist, title) => meta.push([id, 1, 'a', `"${artist}"`, 'r', 'R', mbid, `"${title}"`, 'x', 1]);
song(1, 'yest-canon', 'The Beatles', 'Yesterday');
song(2, 'letitbe', 'The Beatles', 'Let It Be');
song(3, 'blinding', 'The Weeknd', 'Blinding Lights');
song(4, 'mid', 'Some Band', 'Middle');
song(5, 'obscure', 'Nobody', 'Unheard');
song(6, 'marley', 'Bob Marley & The Wailers', 'Is This Love');
song(7, 'cover', 'Cover Band', 'Is This Love');
song(8, 'dup', 'The Beatles', 'Let It Be');
song(9, 'cyrillic', 'Кино', 'Группа крови');
song(10, 'calilove', '2Pac feat. Dr. Dre', 'California Love');
song(11, 'calilove2', '2Pac', 'California Love');                   // the same song again, plain credit
const redirect = [['recording_mbid', 'canonical_recording_mbid', 'canonical_release_mbid'], ['yest-remaster', 'yest-canon', 'r']];
tarZst('canonical.tar.zst', {
  'musicbrainz-canonical-dump-test/canonical/canonical_musicbrainz_data.csv': csv(meta),
  'musicbrainz-canonical-dump-test/canonical/canonical_recording_redirect.csv': csv(redirect),
  'musicbrainz-canonical-dump-test/COPYING': 'CC0\n',
});

// Curated catalogue: Let It Be (exact match), Is This Love by "Bob Marley" (contains match),
// and Three Little Birds (no open-data row → added).
writeFileSync(env.SEARCH_CURATED, JSON.stringify([
  { artist: 'The Beatles', title: 'Let It Be', bpm: 139, felt_bpm: 72, genre: 'rock', year: 1970, isrc: 'GBAYE0601690', cover: 'covers/a.jpg', youtube_id: 'x1' },
  { artist: 'Bob Marley', title: 'Is This Love', bpm: 122, felt_bpm: 61, genre: 'reggae', year: 1978 },
  { artist: 'Bob Marley', title: 'Three Little Birds', bpm: 74, felt_bpm: 74, genre: 'reggae', year: 1977 },
  { artist: 'Tupac', title: 'California Love', bpm: 92, felt_bpm: 92, genre: 'hip-hop', year: 1995 },
]));

test('load.sh builds songs and redirects from the dumps', () => {
  execFileSync(join(HERE, 'load.sh'), { env, stdio: 'pipe' });
  const db = new DatabaseSync(join(dir, 'open-data.db'));
  assert.equal(db.prepare('SELECT count(*) AS n FROM songs').get().n, 11);
  assert.equal(db.prepare("SELECT bpm FROM songs WHERE mbid = 'yest-canon'").get().bpm, 97);   // median of 96, 97, 98
  assert.equal(db.prepare("SELECT readings FROM songs WHERE mbid = 'yest-canon'").get().readings, 3);
  db.close();
});

test('build-search.mjs writes the search database', () => {
  execFileSync(process.execPath, ['--no-warnings', join(HERE, 'build-search.mjs')], { env, stdio: 'pipe' });
  const db = new DatabaseSync(join(dir, 'search.db'), { readOnly: true });
  const row = (sql, ...a) => db.prepare(sql).get(...a);
  const all = (sql, ...a) => db.prepare(sql).all(...a);

  // Rank: curated songs first (ids 1–4), then by readings, so Yesterday (3 readings) is next.
  assert.deepEqual(all('SELECT curated FROM song ORDER BY id LIMIT 5').map((r) => r.curated), [1, 1, 1, 1, 0]);
  assert.equal(row("SELECT id FROM song WHERE title = 'Yesterday'").id, 5);
  // Alias: curated "Tupac" took a "2Pac" row, and the other "2Pac" credit of the same song is gone.
  assert.deepEqual(all("SELECT artist, curated FROM song WHERE title = 'California Love'").map((r) => ({ ...r })), [{ artist: 'Tupac', curated: 1 }]);
  // Nothing is dropped for being obscure.
  assert.equal(row("SELECT count(*) AS n FROM song WHERE title = 'Unheard'").n, 1);
  // Octaves: alt only when plausible.
  assert.equal(row("SELECT bpm_alt FROM song WHERE title = 'Blinding Lights'").bpm_alt, 171);
  assert.equal(row("SELECT bpm_alt FROM song WHERE title = 'Middle'").bpm_alt, null);
  // Curated, exact match: felt BPM, curated fields, no alt, and the same-name duplicate is gone.
  const lib = all("SELECT * FROM song WHERE title = 'Let It Be'");
  assert.equal(lib.length, 1);
  assert.equal(lib[0].curated, 1); assert.equal(lib[0].bpm, 72); assert.equal(lib[0].bpm_alt, null);
  assert.equal(lib[0].isrc, 'GBAYE0601690'); assert.equal(lib[0].readings, 1);
  // Curated, contains match: "Bob Marley" took "Bob Marley & The Wailers"; the cover stays a raw row.
  const love = all("SELECT artist, curated, bpm FROM song WHERE title = 'Is This Love' ORDER BY curated DESC");
  assert.deepEqual(love.map((r) => ({ ...r })), [{ artist: 'Bob Marley', curated: 1, bpm: 61 }, { artist: 'Cover Band', curated: 0, bpm: 140 }]);
  // Curated, no match → its own row, still ranked with the curated songs.
  const birds = row("SELECT id, curated, mbid, readings FROM song WHERE title = 'Three Little Birds'");
  assert.deepEqual({ ...birds }, { id: 4, curated: 1, mbid: null, readings: null });
  // Normalized columns, every script kept.
  assert.equal(row("SELECT artist_norm FROM song WHERE title = 'Группа крови'").artist_norm, 'кино');
  // Indexes the endpoint relies on.
  assert.equal(row("SELECT id FROM song WHERE title_norm = 'yesterday'").id, 5);
  assert.equal(row("SELECT count(*) AS n FROM pragma_table_info('song') WHERE name IN ('users', 'listens')").n, 0);
  assert.equal(all(`SELECT s.title FROM fts JOIN song s ON s.id = fts.rowid WHERE fts MATCH '"blind"*'`)[0].title, 'Blinding Lights');
  db.close();

  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.counts.curated_matched, 3);
  assert.equal(manifest.counts.curated_added, 1);
  assert.equal(manifest.counts.songs, 10);   // 11 loaded − duplicate Let It Be − duplicate California Love + Three Little Birds
  assert.equal(manifest.schema_version, 2);
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
