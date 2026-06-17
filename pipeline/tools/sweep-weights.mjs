#!/usr/bin/env node
// Compare popularity-blend WEIGHTS offline — no network, no rebuild. Reads the raw signals
// dumped by `DUMP_SIGNALS=1 node pipeline/build.mjs` (pipeline/cache/signals.json) and reruns
// the EXACT production percentile blend (imported from build.mjs) under several weight configs,
// scoring each against the shared KNOWS recognizability gate. Read-only: never touches public/.
//
//   node pipeline/tools/sweep-weights.mjs                 # compare a built-in set of configs
//   node pipeline/tools/sweep-weights.mjs 0.6 0.25 0.15   # add a custom YT/RANK/SONG config
//
// Use it to tune weights against the §5 set, then ship the winner with
//   POP_W_YT=.. POP_W_RANK=.. POP_W_SONG=.. ENABLE_YOUTUBE=1 node pipeline/build.mjs
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { key, percentileMap } from '../build.mjs';
import { KNOWS } from './labeled-set.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SIG = join(HERE, '..', 'cache', 'signals.json');
if (!existsSync(SIG)) {
  console.error('No pipeline/cache/signals.json. Generate it first (cached, no network):');
  console.error('  ENABLE_YOUTUBE=1 DUMP_SIGNALS=1 node pipeline/build.mjs');
  process.exit(1);
}
const rows = JSON.parse(readFileSync(SIG, 'utf8')); // [{artist,title,bpm,raw:{youtube,rank,songsterr}}]

// Percentile maps are weight-INDEPENDENT — compute once, reuse for every config (the whole
// point: a sweep is cheap because only the final weighted average changes).
const pYt = percentileMap(rows, (r) => r.raw.youtube);
const pRank = percentileMap(rows, (r) => r.raw.rank);
const pSong = percentileMap(rows, (r) => r.raw.songsterr);

const scoreAll = (w) => {
  const m = new Map();
  for (const r of rows) {
    let num = 0, den = 0;
    if (w.youtube > 0 && pYt && pYt.has(r))   { num += w.youtube   * pYt.get(r);   den += w.youtube; }
    if (w.rank > 0 && pRank && pRank.has(r))  { num += w.rank      * pRank.get(r); den += w.rank; }
    if (w.songsterr > 0 && pSong && pSong.has(r)) { num += w.songsterr * pSong.get(r); den += w.songsterr; }
    m.set(key(r.artist, r.title), { pop: den > 0 ? Math.round((100 * num) / den) : 0, bpm: r.bpm });
  }
  return m;
};

const median = (xs) => {
  if (!xs.length) return NaN;
  const v = [...xs].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

// median popularity of the KNOWS anchors under a given scoring (the recognizability gate).
const medKnows = (scores) => median(KNOWS.map(([a, t]) => scores.get(key(a, t))).filter(Boolean).map((s) => s.pop));
const spread = (scores) => {
  const all = [...scores.values()].map((s) => s.pop).sort((a, b) => a - b);
  const p = (q) => all[Math.min(all.length - 1, Math.floor((q / 100) * all.length))];
  return `${p(10)}/${p(50)}/${p(90)}`;
};
const render = (headers, rows) => {
  const w = headers.map((_, i) => Math.max(headers[i].length, ...rows.map((r) => String(r[i]).length)));
  console.log(headers.map((h, i) => h.padEnd(w[i])).join('  '));
  for (const r of rows) console.log(r.map((c, i) => String(c).padEnd(w[i])).join('  '));
};

// ---- configs to compare ------------------------------------------------------------------
const CONFIGS = [
  ['shipped 70/20/10', { youtube: 0.70, rank: 0.20, songsterr: 0.10 }], // current default (recognizability-first)
  ['60/30/10',         { youtube: 0.60, rank: 0.30, songsterr: 0.10 }],
  ['pureYT 100/0/0',   { youtube: 1.00, rank: 0.00, songsterr: 0.00 }],
  ['old 45/0/55',      { youtube: 0.45, rank: 0.00, songsterr: 0.55 }], // pre-2026-06-17 (Songsterr-led)
  ['pureSong 0/0/100', { youtube: 0.00, rank: 0.00, songsterr: 1.00 }],
];

// CLI: `--bpm N` also prints how the N±2 BPM bucket (what the app shows) reorders under each
//      config. Three bare numbers (YT RANK SONG) append a custom config.
const argv = process.argv.slice(2);
let focusBpm = null;
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--bpm') { focusBpm = Number(argv[++i]); continue; }
  rest.push(argv[i]);
}
const nums = rest.map(Number).filter(Number.isFinite);
if (nums.length === 3) CONFIGS.push([`custom ${nums[0]}/${nums[1]}/${nums[2]}`, { youtube: nums[0], rank: nums[1], songsterr: nums[2] }]);

const scored = CONFIGS.map(([name, w]) => ({ name, short: name.split(' ').pop(), scores: scoreAll(w) }));

// ---- report: both axes per config --------------------------------------------------------
console.log(`Comparing ${CONFIGS.length} weight configs over ${rows.length} songs\n`);

console.log('# Recognizability axis  (median KNOWS want high ≥80)');
render(['config', 'medK', 'p10/50/90', 'gate'], scored.map(({ name, scores }) => {
  const mk = medKnows(scores);
  return [name, mk, spread(scores), mk >= 80 ? 'PASS' : 'FAIL'];
}));

// ---- optional: BPM-bucket reorder (mirrors the in-app list) -------------------------------
if (focusBpm != null) {
  const bucket = rows.filter((r) => Math.abs(r.bpm - focusBpm) <= 2);
  const popOf = (sc, r) => sc.get(key(r.artist, r.title))?.pop ?? 0;
  bucket.sort((a, b) => popOf(scored[0].scores, b) - popOf(scored[0].scores, a)); // by 1st config
  console.log(`\n=== ${focusBpm}±2 BPM bucket (${bucket.length} songs) — popularity per config (rows in shipped order) ===`);
  const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const bh = ['song', 'bpm', ...scored.map((s) => s.short)];
  const bl = [bh];
  for (const r of bucket.slice(0, 18)) {
    bl.push([trunc(`${r.title} — ${r.artist}`, 34), String(r.bpm), ...scored.map((s) => String(popOf(s.scores, r)))]);
  }
  const bw = bh.map((_, i) => Math.max(...bl.map((l) => l[i].length)));
  for (const l of bl) console.log(l.map((c, i) => c.padEnd(bw[i])).join('  '));
}
