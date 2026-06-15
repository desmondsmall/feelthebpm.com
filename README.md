# Tempo — feel the BPM through songs you know

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

Controls: drag the slider · `+`/`−` or arrow keys to nudge · **Tap** (or press `t`)
to tap a tempo · **Space** to start/stop · click any song to snap to its exact BPM ·
genre chips filter (multi-select).

## Data structure

Each song in `public/songs.json` / `public/songs.js` (written there by the pipeline):

```json
{
  "artist": "The White Stripes",
  "title": "Seven Nation Army",
  "bpm": 124,
  "genre": "rock",
  "year": 2003,
  "isrc": "USVT10300001",
  "key_of": null,                 // musical key  (only from GetSongBPM gap-filler)
  "time_sig": null,               // time signature (only from GetSongBPM gap-filler)
  "popularity": 98               // 0–100, derived blend (see below)
}
```

The shipped dataset is **facts + one derived score** only. Raw provider signals
used to compute popularity (Songsterr per-instrument views, Deezer rank) and the
per-song confidence tag (whose values name the source provider) are computed at
build time but deliberately **not** included in `songs.json` / `songs.js` — so the
published file redistributes no provider-specific data. To inspect those signals,
re-run the pipeline or check `pipeline/cache/`.

## How the data is built

`node pipeline/build.mjs` runs a multi-source pipeline (no API keys needed for the core,
results cached to `pipeline/cache/` so re-runs are instant):

1. **Songsterr** (`/api/songs`) — discovers *popular, recognizable* songs and gives a
   real popularity signal (per-instrument view counts). Great for rock/pop/metal;
   covers/variants and tab-arrangement suffixes are filtered/cleaned out.
2. **Curated cross-genre list** (`pipeline/extra_songs.json`) — fills what Songsterr
   covers poorly (hip-hop, electronic, R&B, disco, reggae), genre-tagged by hand.
3. **Deezer** (`api.deezer.com`) — the BPM source of record (audio-analysis tempo) plus
   year / ISRC / popularity rank. Free, no auth.

**Override table** (`pipeline/bpm_overrides.json`) handles two known Deezer weaknesses:
- *Coverage gaps* — Deezer returns `bpm: 0` for much of the classic-rock canon
  (Highway to Hell, Wonderwall, Creep…), so canonical tempos live here.
- *Half/double-tempo artifacts* — audio analysis sometimes reports 2× the real tempo
  (Dancing Queen 201→101, Superstition 201→100); corrected here.

Songs the pipeline can't find a trustworthy BPM for are dropped (quality over quantity)
and logged to `pipeline/gaps.json` — review that file to grow the override table.

## Extending

- **More songs:** add artists to `pipeline/artists.json` (Songsterr-friendly genres) or
  songs to `pipeline/extra_songs.json` (anything else), then re-run the pipeline.
- **Fix a tempo:** add `"artist|title": bpm` to `pipeline/bpm_overrides.json`
  (punctuation/case are normalized, so `"AC/DC|Back in Black"` matches).
- **GetSongBPM gap-filler (wired, dormant):** any song Deezer can't tempo falls through to
  GetSongBPM, which also returns musical key + time signature. Off until you provide a free
  key (register at getsongbpm.com/api — requires a visible backlink):
  ```bash
  GETSONGBPM_API_KEY=your_key node pipeline/build.mjs
  ```
- **Better BPM source later:** SoundCharts (paid B2B, industry-grade) can augment at the same seam.

## Sources & attribution

BPM from Deezer audio analysis; popularity & song discovery from Songsterr. Both are
free public endpoints; this is a personal/educational project. If you ship it publicly,
review each provider's ToS (Deezer restricts long-term caching; GetSongBPM requires a
visible backlink).
