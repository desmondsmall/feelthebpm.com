-- Song search, step 2: collapse the AcousticBrainz tempo readings to one per canonical MusicBrainz
-- song and join names. Run by load.sh (which extracts the CSVs next to the database first):
--   sqlite3 open-data.db < load.sql      (from pipeline/cache/open-data/)
-- Produces the table build-search.mjs reads: songs (one row per canonical song with a tempo, a
-- name, and how many readings it has). The rest are intermediate. Takes a while and ~20 GB of disk.
PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;
PRAGMA temp_store = FILE;
PRAGMA cache_size = -2000000;   -- ~2 GB page cache

-- 1. raw AcousticBrainz rhythm rows: one per submission (29.46M)
CREATE TABLE ab_raw (mbid TEXT, submission_offset INT, bpm REAL, p1_mean REAL, p1_median REAL, p2_mean REAL, p2_median REAL, danceability REAL, onset_rate REAL);
.import --csv --skip 1 ab-rhythm.csv ab_raw

-- 2. every recording -> its canonical recording
CREATE TABLE redirect (recording_mbid TEXT, canonical_recording_mbid TEXT, canonical_release_mbid TEXT);
.import --csv --skip 1 canonical_recording_redirect.csv redirect
CREATE INDEX redirect_rec ON redirect (recording_mbid);

-- 3. canonical metadata: one row per (artist credit, release, recording)
CREATE TABLE meta (id INT, artist_credit_id INT, artist_mbids TEXT, artist_credit_name TEXT, release_mbid TEXT, release_name TEXT, recording_mbid TEXT, recording_name TEXT, combined_lookup TEXT, score INT);
.import --csv --skip 1 canonical_musicbrainz_data.csv meta
CREATE INDEX meta_rec ON meta (recording_mbid, score);

-- 4. readings keyed by canonical song (a recording with no redirect row is its own canonical)
CREATE TABLE readings AS
  SELECT coalesce(r.canonical_recording_mbid, a.mbid) AS canon, a.mbid AS mbid, a.bpm AS bpm
  FROM ab_raw a LEFT JOIN redirect r ON r.recording_mbid = a.mbid
  WHERE typeof(a.bpm) = 'real' AND a.bpm > 0;   -- typeof: stray text rows compare greater than any number
CREATE INDEX readings_canon ON readings (canon, bpm);

-- 5. one tempo per canonical song: the median reading, plus how many readings and how far they spread
CREATE TABLE tempo AS
  WITH ranked AS (
    SELECT canon, bpm,
           row_number() OVER (PARTITION BY canon ORDER BY bpm) AS rn,
           count(*)     OVER (PARTITION BY canon)             AS n
    FROM readings)
  SELECT canon, n, avg(bpm) AS bpm_median
  FROM ranked WHERE rn IN ((n + 1) / 2, (n + 2) / 2)
  GROUP BY canon, n;
CREATE TABLE spread AS
  SELECT canon, min(bpm) AS bpm_min, max(bpm) AS bpm_max, count(DISTINCT mbid) AS recordings FROM readings GROUP BY canon;

-- 6. the search table: canonical song + best (lowest-score) metadata row
CREATE TABLE songs AS
  SELECT t.canon AS mbid, m.artist_credit_name AS artist, m.recording_name AS title, m.release_name AS release,
         m.combined_lookup AS lookup, round(t.bpm_median, 1) AS bpm, t.n AS readings, s.recordings,
         round(s.bpm_max / s.bpm_min, 3) AS spread
  FROM tempo t
  JOIN spread s ON s.canon = t.canon
  JOIN meta m ON m.id = (SELECT id FROM meta WHERE recording_mbid = t.canon ORDER BY score LIMIT 1);
CREATE INDEX songs_mbid ON songs (mbid);
