// Tests for the song-search pipeline: load.sh on tiny dumps, then build-search.mjs on the result.
//   node --test pipeline/search/*.test.mjs
// Needs zstd and the sqlite3 command-line tool (as load.sh does). No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture } from './fixture.mjs';

// MBIDs are short readable stand-ins (the pipeline treats them as opaque text).
const fx = makeFixture({
  songs: [
    { mbid: 'yest-canon', artist: 'The Beatles', title: 'Yesterday', bpms: [96.0] },        // + the remaster's 2 → median 97
    { mbid: 'letitbe', artist: 'The Beatles', title: 'Let It Be', bpms: [139.6] },          // octave case: alt 69.8
    { mbid: 'blinding', artist: 'The Weeknd', title: 'Blinding Lights', bpms: [85.5] },     // alt 171
    { mbid: 'mid', artist: 'Some Band', title: 'Middle', bpms: [105.0] },                   // no plausible other octave
    { mbid: 'obscure', artist: 'Nobody', title: 'Unheard', bpms: [120.0] },                 // one reading: kept anyway
    { mbid: 'marley', artist: 'Bob Marley & The Wailers', title: 'Is This Love', bpms: [76.0] },   // curated as "Bob Marley"
    { mbid: 'cover', artist: 'Cover Band', title: 'Is This Love', bpms: [140.0] },          // a cover with a curated title
    { mbid: 'dup', artist: 'The Beatles', title: 'Let It Be', bpms: [139.0] },              // same song again: dropped
    { mbid: 'cyrillic', artist: 'Кино', title: 'Группа крови', bpms: [110.0] },
    { mbid: 'calilove', artist: '2Pac feat. Dr. Dre', title: 'California Love', bpms: [92.0] },   // curated says "Tupac"
    { mbid: 'calilove2', artist: '2Pac', title: 'California Love', bpms: [91.0] },          // the same song, plain credit
  ],
  redirects: [['yest-remaster', 'yest-canon', [98.0, 97.0]]],
  // Curated: Let It Be (exact), Is This Love by "Bob Marley" (contains), California Love by
  // "Tupac" (alias), Three Little Birds (no open-data row → added).
  curated: [
    { artist: 'The Beatles', title: 'Let It Be', bpm: 139, felt_bpm: 72, genre: 'rock', year: 1970, isrc: 'GBAYE0601690', cover: 'covers/a.jpg', youtube_id: 'x1' },
    { artist: 'Bob Marley', title: 'Is This Love', bpm: 122, felt_bpm: 61, genre: 'reggae', year: 1978 },
    { artist: 'Bob Marley', title: 'Three Little Birds', bpm: 74, felt_bpm: 74, genre: 'reggae', year: 1977 },
    { artist: 'Tupac', title: 'California Love', bpm: 92, felt_bpm: 92, genre: 'hip-hop', year: 1995 },
  ],
});
const dir = fx.dir;

test('load.sh builds songs and redirects from the dumps', () => {
  const db = new DatabaseSync(join(dir, 'open-data.db'));
  assert.equal(db.prepare('SELECT count(*) AS n FROM songs').get().n, 11);
  assert.equal(db.prepare("SELECT bpm FROM songs WHERE mbid = 'yest-canon'").get().bpm, 97);   // median of 96, 97, 98
  assert.equal(db.prepare("SELECT readings FROM songs WHERE mbid = 'yest-canon'").get().readings, 3);
  db.close();
});

test('build-search.mjs writes the search database', () => {
  fx.build();
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
  // Weight: readings, + 1000 for curated; id follows weight.
  assert.equal(row("SELECT weight FROM song WHERE title = 'Yesterday'").weight, 3);
  assert.equal(row("SELECT weight FROM song WHERE title = 'Let It Be'").weight, 1001);
  const w = all('SELECT weight FROM song ORDER BY id').map((r) => r.weight);
  assert.deepEqual(w, [...w].sort((x, y) => y - x));
  // Packed tempos match the rows.
  const t = row('SELECT bpm, bpm_alt FROM tempo');
  const u16 = (b) => new Uint16Array(b.buffer, b.byteOffset, b.byteLength / 2);
  const id = row("SELECT id FROM song WHERE title = 'Blinding Lights'").id;
  assert.equal(u16(t.bpm)[id], 855); assert.equal(u16(t.bpm_alt)[id], 1710);
  assert.equal(u16(row('SELECT weight FROM tempo').weight)[row("SELECT id FROM song WHERE title = 'Let It Be'").id], 1001);
  assert.equal(all(`SELECT s.title FROM fts JOIN song s ON s.id = fts.rowid WHERE fts MATCH '"blind"*'`)[0].title, 'Blinding Lights');
  assert.equal(JSON.parse(row("SELECT value FROM meta WHERE key = 'manifest'").value).schema_version, 4);
  // Title-start index: ^ anchors to the first word of the title.
  const starts = (m) => all('SELECT s.title FROM tstart JOIN song s ON s.id = tstart.rowid WHERE tstart MATCH ? ORDER BY tstart.rowid', m).map((r) => r.title);
  assert.deepEqual(starts('^ "let" + "it"*'), ['Let It Be']);
  assert.deepEqual(starts('^ "love"*'), []);   // "Is This Love" contains love but doesn't start with it
  db.close();

  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.counts.curated_matched, 3);
  assert.equal(manifest.counts.curated_added, 1);
  assert.equal(manifest.counts.songs, 10);   // 11 loaded − duplicate Let It Be − duplicate California Love + Three Little Birds
  assert.equal(manifest.schema_version, 4);
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
