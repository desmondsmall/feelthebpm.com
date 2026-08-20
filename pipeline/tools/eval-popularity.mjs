#!/usr/bin/env node
// Validate the popularity metric against the hand-labeled KNOWS set (the recognizability gate
// from .dev/popularity-rework.md §5). Read-only — reads public/songs.json, writes a
// markdown report into the doc vault. Non-zero exit if the gate fails, so it can gate a release.
//
//   node pipeline/tools/eval-popularity.mjs
//
// The metric must make RECOGNIZABILITY win: famous anchors score high. Gate: median(KNOWS) >= 80.
// (The old DEEP_CUTS counter-set was retired once those songs were pruned from the catalogue; the
// bottom-of-catalogue list is the sanity check that nothing famous sinks to the floor.)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { key } from '../build.mjs';
import { KNOWS } from './labeled-set.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SONGS = JSON.parse(readFileSync(join(HERE, '..', '..', 'public', 'songs.json'), 'utf8'));
const byKey = new Map(SONGS.map((s) => [key(s.artist, s.title), s]));

const knows = KNOWS.map(([a, t]) => {
  const s = byKey.get(key(a, t));
  if (!s) console.error(`  ! not in catalogue: ${a} — ${t}`);
  return s ? { artist: a, title: t, bpm: s.bpm, pop: s.popularity } : null;
}).filter(Boolean);

const median = (xs) => {
  if (!xs.length) return NaN;
  const v = [...xs].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const medKnows = median(knows.map((s) => s.pop));
const pass = medKnows >= 80;

const pops = SONGS.map((s) => s.popularity).sort((a, b) => a - b);
const pctl = (p) => pops[Math.min(pops.length - 1, Math.floor((p / 100) * pops.length))];

// ---- report -----------------------------------------------------------------------------
const tbl = (rows) => {
  const out = ['| song | bpm | popularity |', '|---|---|---|'];
  for (const s of rows) out.push(`| ${s.artist} — ${s.title} | ${s.bpm} | ${s.pop ?? s.popularity} |`);
  return out;
};
const L = [];
L.push(`# Popularity validation — ${new Date().toISOString().slice(0, 10)}`);
L.push('');
L.push(`Population: **${SONGS.length}** songs from \`public/songs.json\`. Read-only. The metric should`);
L.push('rank **recognizability** — famous anchors high.');
L.push('');
L.push('## Verdict');
L.push('');
L.push(`**${pass ? 'PASS ✅' : 'FAIL ❌'}**`);
L.push('');
L.push('| gate | target | actual | result |');
L.push('|---|---|---|---|');
L.push(`| median(KNOWS) | ≥ 80 | ${medKnows} | ${pass ? '✅' : '❌'} |`);
L.push('');
L.push(`Spread: min ${pctl(0)} · p10 ${pctl(10)} · p25 ${pctl(25)} · p50 ${pctl(50)} · p75 ${pctl(75)} · p90 ${pctl(90)} · max ${pops[pops.length - 1]}`);
L.push('');
L.push('## KNOWS (want high)');
L.push('');
L.push(...tbl([...knows].sort((a, b) => b.pop - a.pop)));
L.push('');
L.push('## Bottom 15 of the catalogue (sanity — nothing famous should sit here)');
L.push('');
L.push(...tbl([...SONGS].sort((a, b) => a.popularity - b.popularity).slice(0, 15)));
L.push('');

const DEV = join(HERE, '..', '..', '.dev');
mkdirSync(DEV, { recursive: true });
const reportPath = join(DEV, 'popularity-eval.md');
writeFileSync(reportPath, L.join('\n') + '\n');

console.error('');
console.error(`median(KNOWS)=${medKnows} (≥80 ${pass ? 'ok' : 'FAIL'})`);
console.error(`${pass ? 'PASS' : 'FAIL'} -> ${reportPath}`);
process.exit(pass ? 0 : 1);
