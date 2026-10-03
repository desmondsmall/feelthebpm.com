# [feelthebpm.com](https://feelthebpm.com)

A metronome that answers "*what does 90 BPM feel like?*" — slide the tempo and it
surfaces popular songs sitting at that BPM (Billie Jean is right here, Seven Nation
Army is a bit faster), so you build intuition by anchoring numbers to songs you already know.

## Run it

The deployable site lives in `public/` (this is exactly what nginx serves in prod).

```bash
# Option A — just open it (works because data is bundled as songs.js)
open public/index.html

# Option B — serve it (also fine; index.html falls back to fetching songs.json)
cd public && python3 -m http.server 8777   # then visit http://localhost:8777
```

The UI is a **spatial tempo axis** (Signal Green): the selected BPM pulses at center as a
metronome and songs arrange around it — slower to the left, faster to the right, exact
matches pouring out of the beat below center. Nearer tempos are brighter, farther ones fade.

Controls: **drag the axis** (or trackpad-scroll) to scrub the center · `+`/`−` or arrow keys
to nudge · **type a BPM** in the field for precise entry · click any song to snap the beat to
its exact tempo · genre chips filter (multi-select). The pulse is visual-only — its ring
expands at the current tempo so you *feel* the BPM; there are no playback controls.

## Data structure

Each song in `public/songs.json` / `public/songs.js` (written there by the pipeline):

```json
{
  "artist": "The White Stripes",
  "title": "Seven Nation Army",
  "bpm": 124,                     // the raw detector reading
  "felt_bpm": 124,                // the tempo people tap; the UI shows and positions by this
  "genre": "rock",
  "year": 2003,                   // original release year (MusicBrainz; Deezer fallback)
  "isrc": "USVT10300001",
  "cover": "covers/<id>.jpg",     // self-hosted album art (Cover Art Archive); null if none
  "youtube_id": "0J2QdDbelmY",
  "popularity": 81                // 0–100, derived blend (see below)
}
```

Alongside them the pipeline writes `public/version.json` — a small build manifest
(date, song count, year sources, cover source and counts, popularity weights, exclusions,
BPM gaps) for provenance/versioning.

`songs.json` is canonical (the source of truth CI validates); `songs.js` is a
generated `<script>`-loadable mirror (`window.SONGS=[…]`) so `index.html` works on
`file://` with no server. The page loads `.js` and only fetches `.json` as a
fallback — but both are written from the same array by the pipeline and CI fails the
deploy if they drift out of sync, so treat `.json` as authoritative.

The shipped dataset is **facts + one derived score** only. The raw provider signals
used to compute popularity (YouTube views, Deezer rank, Songsterr views) and the
per-source tempo readings are used at build time but deliberately **not** included in
`songs.json` / `songs.js` — so the published file redistributes no provider-specific data
(CI fails the deploy if one appears). To inspect those signals, re-run the pipeline or
check `pipeline/cache/`.

## How the data is built

```bash
ENABLE_ACOUSTICBRAINZ=1 ENABLE_YOUTUBE=1 ENABLE_COVERS=1 node --env-file=.env pipeline/build.mjs
```

A multi-source pipeline, plain Node 22 with no npm dependencies (`yt-dlp` is the only
external binary). It runs on a laptop, never in CI; every response is cached to
`pipeline/cache/`, so re-runs are fast. `.env` (gitignored) holds `GETSONGBPM_API_KEY`.
A bare `node pipeline/build.mjs` runs, but without the flags and the key it drops tempo
votes, popularity and covers.

1. **Membership** — which songs exist: a Songsterr artist scrape (popular, recognizable
   guitar-band songs), a hand-kept cross-genre list (`pipeline/inputs/extra_songs.json`)
   for what Songsterr covers poorly, and a hand-copied Ultimate Guitar chart harvest.
2. **Tempo** — three independent readings, reconciled: **Deezer** (audio analysis),
   **GetSongBPM** and **AcousticBrainz**. Audio analysis often reports half or double the
   tempo people feel (Dancing Queen 201 → 101), and Deezer has no tempo for much of the
   classic-rock canon, so the votes are reconciled into `felt_bpm`, and a hand override
   (`pipeline/inputs/bpm_overrides.json`) wins outright.
3. **Year** — **MusicBrainz**: the earliest release date across exact-title recordings,
   because Deezer's date is whichever release it matched (*The Boxer* → 2025). Deezer's
   year is only a fallback.
4. **Popularity** — a percentile blend of **YouTube** views of the canonical upload (via
   `yt-dlp`, which also supplies `youtube_id`), Deezer rank and Songsterr tab views. Only
   the blended 0–100 score ships.
5. **Covers** — the **Cover Art Archive**: the front cover of the earliest studio album
   the song is on, falling back to the song's canonical MusicBrainz release and then to
   other releases. Downloaded once to `public/covers/` and served from there; the site
   hotlinks nothing. Nothing is taken from Deezer, whose terms don't allow storing its
   images.

Songs the pipeline can't find a trustworthy BPM for are dropped (quality over quantity)
and logged to `pipeline/generated/gaps.json` — review that file to grow the override table.

## Song search

`https://feelthebpm.com/api/songs` looks up the tempo of any of ~6 million songs. The data
is built by `pipeline/search/` from two bulk, **CC0** dumps — AcousticBrainz tempos (frozen
in 2022) and MusicBrainz canonical names — plus the curated catalogue, into one SQLite file;
nothing in it is scraped or comes from a provider that restricts storage. The endpoint is
`api/` (Node 22, `node:sqlite`, no dependencies). Open-data results show the raw reading
and, when plausible, its other octave; curated songs show their felt tempo. Each open-data
result carries its MusicBrainz release id, so a page can show its cover straight from the
Cover Art Archive.

```bash
node --test api/*.test.mjs pipeline/search/*.test.mjs   # needs zstd and sqlite3
```

## Extending

- **More songs:** add artists to `pipeline/inputs/artists.json` (Songsterr-friendly genres) or
  songs to `pipeline/inputs/extra_songs.json` (anything else), run `node pipeline/seed.mjs`,
  then the build. `node pipeline/search/cover-releases.mjs` refreshes the cover lookup for new
  songs where the search pipeline's working database exists; without it they still get a
  cover, picked from their MusicBrainz releases.
- **Fix a tempo:** add `"artist|title": bpm` to `pipeline/inputs/bpm_overrides.json`
  (punctuation/case are normalized, so `"AC/DC|Back in Black"` matches), or use the local
  review tool (`node pipeline/review-server.mjs`).
- **Drop a multi-tempo song:** add `"artist|title"` to `pipeline/inputs/exclude.json`. Songs with
  no single meaningful tempo (multi-movement or rubato — Bohemian Rhapsody, Stairway, Free
  Bird…) make poor "feel this BPM" anchors, so they're dropped even if they have a BPM.

## Design docs

Design records, source evaluations, and the deployment runbook live in a local-only
`.mind/` folder — gitignored, so it is not part of this repo. Code comments pointing at
`.mind/<path>.md` are breadcrumbs for whoever holds the working copy, not files you will
find in a clone.

## Sources, terms & attribution

This is a personal, non-commercial project: no ads, no accounts, nothing sold. What each
source is used for, what the site keeps from it, and the condition that applies:

| source | used for | kept in the published site | condition we follow |
|---|---|---|---|
| [Deezer](https://developers.deezer.com) API | a tempo reading, ISRC, and rank as one popularity input | the reconciled tempo and the ISRC; no images, audio or rank | non-commercial use only; its images may not be stored, so none are; credited in the footer |
| [GetSongBPM](https://getsongbpm.com) API | a tempo reading | the reconciled tempo | free key in exchange for a visible backlink, which is in the footer; 3,000 requests/hour |
| [MusicBrainz](https://musicbrainz.org) API and canonical dump | original year; names and release ids for search | year; artist, title and ids | core data is CC0; a descriptive User-Agent and ~1 request/second |
| [AcousticBrainz](https://acousticbrainz.org) API and dump | a tempo reading; every tempo in search | tempos | CC0 |
| [Cover Art Archive](https://coverartarchive.org) | album covers | one 500 px front cover per curated song | no storage or rate rule; the images remain copyrighted by their owners and the archive grants no licence to them; credited in the footer |
| YouTube, read with `yt-dlp` | view counts as the main popularity input | the video id; never the counts | not an official API |
| Songsterr | which songs to include; tab views as a minor popularity input | song membership only | an undocumented public endpoint |
| Ultimate Guitar | which songs to include | song membership only | copied by hand from its public charts, never fetched |

Album art, song titles and artist names belong to their owners. If you reuse this code for
anything commercial, the Deezer row no longer holds and the cover question needs a real
answer: read each provider's terms yourself.
