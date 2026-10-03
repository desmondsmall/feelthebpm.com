// Test helper: build a tiny search.db through the real pipeline (load.sh, then build-search.mjs)
// from a handful of songs. Used by the pipeline's and the endpoint's tests. Needs zstd and the
// sqlite3 command-line tool. No network.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const csv = (rows) => rows.map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(',')).join('\n') + '\n';

function tarZst(dir, name, files) {
  const stage = join(dir, 'stage');
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(stage, p)), { recursive: true });
    writeFileSync(join(stage, p), body);
  }
  const list = Object.keys(files).map((p) => `'${p}'`).join(' ');
  execFileSync('sh', ['-c', `tar -cf - -C '${stage}' ${list} | zstd -q -o '${join(dir, name)}' && rm -rf '${stage}'`]);
}

/**
 * Write fixture dumps for `songs` and run load.sh. Returns { dir, env } where env points the
 * pipeline at the fixture; call build() to run build-search.mjs.
 *   songs:     [{ mbid, artist, title, bpms: [reading, …] }]  (bpms: one AcousticBrainz reading each)
 *   redirects: [[recording_mbid, canonical_mbid, bpms]]        (a merged recording and its readings)
 *   curated:   the public/songs.json records to merge
 */
export function makeFixture({ songs, redirects = [], curated = [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'search-fixture-'));
  const env = { ...process.env, SEARCH_OPEN_DATA: dir, SEARCH_CURATED: join(dir, 'songs.json') };

  const ab = [['mbid', 'submission_offset', 'bpm', 'p1m', 'p1md', 'p2m', 'p2md', 'danceability', 'onset_rate']];
  for (const s of songs) for (const b of s.bpms) ab.push([s.mbid, 0, b, 0, 0, 0, 0, 0, 0]);
  for (const [rec, , bpms] of redirects) for (const b of bpms ?? []) ab.push([rec, 0, b, 0, 0, 0, 0, 0, 0]);
  tarZst(dir, 'ab-rhythm.tar.zst', {
    'acousticbrainz-lowlevel-features-20220623/acousticbrainz-lowlevel-features-20220623-rhythm.csv': csv(ab),
    'acousticbrainz-lowlevel-features-20220623/COPYING': 'CC0\n',
  });

  const meta = [['id', 'artist_credit_id', 'artist_mbids', 'artist_credit_name', 'release_mbid', 'release_name', 'recording_mbid', 'recording_name', 'combined_lookup', 'score']];
  songs.forEach((s, i) => meta.push([i + 1, 1, 'a', s.artist, 'r', 'R', s.mbid, s.title, 'x', 1]));
  const redirect = [['recording_mbid', 'canonical_recording_mbid', 'canonical_release_mbid'], ...redirects.map(([rec, canon]) => [rec, canon, 'r'])];
  tarZst(dir, 'canonical.tar.zst', {
    'musicbrainz-canonical-dump-test/canonical/canonical_musicbrainz_data.csv': csv(meta),
    'musicbrainz-canonical-dump-test/canonical/canonical_recording_redirect.csv': csv(redirect),
    'musicbrainz-canonical-dump-test/COPYING': 'CC0\n',
  });
  writeFileSync(env.SEARCH_CURATED, JSON.stringify(curated));

  execFileSync(join(HERE, 'load.sh'), { env, stdio: 'pipe' });
  const build = () => execFileSync(process.execPath, ['--no-warnings', join(HERE, 'build-search.mjs')], { env, stdio: 'pipe' });
  return { dir, env, build, searchDb: join(dir, 'search.db') };
}
