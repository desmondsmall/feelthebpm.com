#!/usr/bin/env node
// Build songs.json: Songsterr (popularity/discovery) + Deezer (BPM/year) + override table.
// No deps; Node 22+ (global fetch). Caches Deezer responses to ./cache so re-runs are cheap.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// the deployable surface — pipeline output (songs.json/songs.js) lands here; nginx serves this dir
const SITE = join(HERE, '..', 'public');
if (!existsSync(SITE)) mkdirSync(SITE, { recursive: true });
const CACHE = join(HERE, 'cache');
if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });

const SONGS_PER_ARTIST = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

// ---- string helpers ----------------------------------------------------
const norm = (s) =>
  (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\(feat[^)]*\)|\bfeat\.?\b.*$/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
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
  s = s.replace(/\s*[-–—|]+\s*$/, '').replace(/\s+/g, ' ').trim();
  return s || (t || '').trim();
};

// ---- cached fetch ------------------------------------------------------
async function getJson(url) {
  const f = join(CACHE, createHash('md5').update(url).digest('hex') + '.json');
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
      const j = await res.json();
      writeFileSync(f, JSON.stringify(j));
      // be polite — paces live calls (only uncached fetches sleep). 250ms keeps us
      // far under GetSongBPM's 3000/hour limit even in a worst case.
      await sleep(250);
      return j;
    } catch (e) {
      await sleep(800 * (attempt + 1));
    }
  }
  return null;
}

// ---- Songsterr: discover popular songs per artist ----------------------
async function songsterrForArtist(name, genre) {
  const url = `https://www.songsterr.com/api/songs?pattern=${encodeURIComponent(name)}&size=40`;
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
    `https://api.deezer.com/search/track?q=${encodeURIComponent(q)}&limit=5`
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
  if (!best) best = results[0]; // fall back to top hit
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
// GETSONGBPM_API_KEY is set. Bonus: also returns musical key + time signature + year.
// API base is api.getsong.co (per docs, changed 2024-09); auth via api_key param.
// Limit: 3000 req/hour — we only call it on Deezer gaps, so well under.
// Response shapes (per docs): /search/ -> { search: [ {id,title,tempo,key_of,time_sig,artist:{name},album:{year}} ] }
//                             /song/   -> { song: { tempo:"220", key_of:"Em", time_sig:"4/4", album:{year} } }
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
  let keyOf = hit.key_of || null;
  let timeSig = hit.time_sig || null;
  let year = Number(hit.album?.year) || null;
  // search occasionally omits fields — fall back to the /song/ detail endpoint
  if ((!tempo || !keyOf) && hit.id) {
    const detail = await getJson(`${GSB_BASE}/song/?api_key=${GSB_KEY}&id=${hit.id}`);
    const song = detail?.song;
    if (song) {
      tempo = Number(song.tempo) || tempo;
      keyOf = song.key_of || keyOf;
      timeSig = song.time_sig || timeSig;
      year = year || Number(song.album?.year) || null;
    }
  }
  if (!tempo) return null;
  return { bpm: Math.round(tempo), key_of: keyOf, time_sig: timeSig, year };
}

// ---- popularity blend (0..100) -----------------------------------------
const lognorm = (v, max) =>
  Math.max(0, Math.min(1, Math.log10((v || 0) + 1) / Math.log10(max)));
const popularity = (views, rank) =>
  Math.round(100 * Math.max(lognorm(views, 500000), lognorm(rank, 1000000)));

// ---- main --------------------------------------------------------------
(async () => {
  const artists = readJson(join(HERE, 'artists.json')).artists;
  const extra = readJson(join(HERE, 'extra_songs.json')).songs;
  // normalize override keys so punctuation (AC/DC, Guns N' Roses) matches candidate keys
  const rawOverrides = readJson(join(HERE, 'bpm_overrides.json')).overrides;
  const overrides = {};
  for (const [k, v] of Object.entries(rawOverrides)) {
    if (k.startsWith('_') || typeof v !== 'number') continue; // skip comment/section keys
    const [a, t] = k.split('|');
    overrides[key(a, t)] = v;
  }

  // 1. gather candidates
  const candidates = new Map();
  const add = (c) => {
    const k = key(c.artist, c.title);
    const prev = candidates.get(k);
    if (!prev) candidates.set(k, c);
    else prev.songsterr_views = Math.max(prev.songsterr_views || 0, c.songsterr_views || 0);
  };

  console.error(`GetSongBPM gap-filler: ${GSB_KEY ? 'ENABLED' : 'dormant (set GETSONGBPM_API_KEY to enable)'}`);
  console.error(`Scraping Songsterr for ${artists.length} artists...`);
  for (const a of artists) {
    const found = await songsterrForArtist(a.name, a.genre);
    console.error(`  ${a.name}: ${found.length} songs`);
    found.forEach(add);
  }
  for (const s of extra) add({ ...s, songsterr_views: s.songsterr_views || 0 });
  console.error(`\n${candidates.size} unique candidates. Enriching via Deezer...`);

  // 2. enrich
  const out = [];
  const gaps = [];
  let i = 0;
  for (const c of candidates.values()) {
    i++;
    const enr = await deezerEnrich(c);
    let bpm = enr?.bpm || 0;
    let keyOf = null, timeSig = null, gsbYear = null;
    const ov = overrides[key(c.artist, c.title)];
    if (ov) bpm = ov;
    // GetSongBPM fallback: only when Deezer AND override both came up empty
    if (!bpm) {
      const gsb = await getsongbpmEnrich(c);
      if (gsb?.bpm) {
        bpm = gsb.bpm;
        keyOf = gsb.key_of; timeSig = gsb.time_sig; gsbYear = gsb.year;
      }
    }
    if (!bpm) {
      gaps.push(key(c.artist, c.title));
      if (i % 25 === 0) console.error(`  [${i}/${candidates.size}]`);
      continue; // skip songs we can't tempo (quality over quantity)
    }
    out.push({
      artist: c.artist,
      title: c.title,
      bpm,
      genre: c.genre,
      year: enr?.year ?? gsbYear ?? null,
      isrc: enr?.isrc ?? null,
      key_of: keyOf,
      time_sig: timeSig,
      // popularity is a derived 0–100 blend computed at build time; the raw
      // source signals (Songsterr views, Deezer rank) are intentionally NOT
      // shipped — only this neutral score is. Likewise bpm_confidence
      // (whose values name providers) stays out of the published dataset.
      popularity: popularity(c.songsterr_views, enr?.deezer_rank),
    });
    if (i % 25 === 0) console.error(`  [${i}/${candidates.size}]`);
  }

  // 3. dedup: collapse arrangement / parenthetical variants of the same song (per artist).
  // Safety net for anything that slipped past cleanTitle (e.g. "Burning Heart (Rocky)").
  const dupKey = (artist, title) =>
    key(artist, cleanTitle(title.replace(/[\(\[][^)\]]*[\)\]]/g, ' '))); // drop ALL parens, then clean
  const byDup = new Map();
  for (const r of out) {
    const k = dupKey(r.artist, r.title);
    const prev = byDup.get(k);
    if (!prev) { byDup.set(k, r); continue; }
    // keep the more popular row; tie -> the cleaner (shorter) title
    const keep = r.popularity > prev.popularity ||
      (r.popularity === prev.popularity && r.title.length < prev.title.length) ? r : prev;
    if (keep !== prev) byDup.set(k, keep);
  }
  const deduped = [...byDup.values()];
  const nDropped = out.length - deduped.length;

  deduped.sort((a, b) => a.bpm - b.bpm || b.popularity - a.popularity);
  writeFileSync(join(SITE, 'songs.json'), JSON.stringify(deduped, null, 2));
  // songs.js lets index.html load via <script> so it works on file:// (no server / no CORS)
  writeFileSync(join(SITE, 'songs.js'), `window.SONGS = ${JSON.stringify(deduped)};\n`);
  writeFileSync(join(HERE, 'gaps.json'), JSON.stringify(gaps, null, 2));
  console.error(`\nDeduped ${nDropped} arrangement variant(s).`);
  console.error(`Done. ${deduped.length} songs -> songs.json`);
  console.error(`${gaps.length} BPM gaps -> pipeline/gaps.json (add to bpm_overrides.json)`);
})();
