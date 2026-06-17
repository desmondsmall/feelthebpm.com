#!/usr/bin/env node
// Validate the popularity rework against a hand-labeled set (the §5 regression guard from
// .dev/reference/popularity-rework.md). Read-only — reads public/songs.json, touches nothing
// in public/. Writes a markdown report into the doc vault.
//
//   node pipeline/eval-popularity.mjs
//
// The metric is supposed to make RECOGNIZABILITY win: famous anchors should score high, beloved
// deep cuts should score low. We assert:
//   1. median(KNOWS)     >= 80
//   2. median(DEEP CUTS) <= 40
//   3. no deep cut scores >= a known anchor that shares its BPM (the in-app sort key)
// Exit code is non-zero if any gate fails, so this can gate a release ("ship only if it passes").
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { key } from './build.mjs';
import { KNOWS, DEEP_CUTS } from './labeled-set.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SONGS = JSON.parse(readFileSync(join(HERE, '..', 'public', 'songs.json'), 'utf8'));
const byKey = new Map(SONGS.map((s) => [key(s.artist, s.title), s]));

// ---- resolve labels -> shipped songs -----------------------------------------------------
const resolve = (pairs) =>
  pairs.map(([a, t]) => {
    const s = byKey.get(key(a, t));
    if (!s) console.error(`  ! not in catalogue: ${a} — ${t}`);
    return s ? { artist: a, title: t, bpm: s.bpm, pop: s.popularity } : null;
  }).filter(Boolean);

const knows = resolve(KNOWS);
const deep = resolve(DEEP_CUTS);

const median = (xs) => {
  if (!xs.length) return NaN;
  const v = [...xs].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const medKnows = median(knows.map((s) => s.pop));
const medDeep = median(deep.map((s) => s.pop));

// gate 3: a deep cut ranking at/above a known anchor that shares its BPM (the within-BPM sort
// is exactly what users see, so a same-BPM inversion is the failure that matters most).
const inversions = [];
for (const d of deep) {
  for (const k of knows) {
    if (k.bpm === d.bpm && d.pop >= k.pop) inversions.push({ d, k });
  }
}

// ---- gates ------------------------------------------------------------------------------
const g1 = medKnows >= 80;
const g2 = medDeep <= 40;
const g3 = inversions.length === 0;
const pass = g1 && g2 && g3;

// ---- report -----------------------------------------------------------------------------
const L = [];
L.push(`# Popularity validation — ${new Date().toISOString().slice(0, 10)}`);
L.push('');
L.push(`Population: **${SONGS.length}** songs from \`public/songs.json\`. Read-only. The metric should`);
L.push('rank **recognizability** — famous anchors high, beloved deep cuts low.');
L.push('');
L.push('## Verdict');
L.push('');
L.push(`**${pass ? 'PASS ✅' : 'FAIL ❌'}**`);
L.push('');
L.push('| gate | target | actual | result |');
L.push('|---|---|---|---|');
L.push(`| median(KNOWS) | ≥ 80 | ${medKnows} | ${g1 ? '✅' : '❌'} |`);
L.push(`| median(DEEP CUTS) | ≤ 40 | ${medDeep} | ${g2 ? '✅' : '❌'} |`);
L.push(`| same-BPM inversions | 0 | ${inversions.length} | ${g3 ? '✅' : '❌'} |`);
L.push('');
const tbl = (rows) => {
  const out = ['| song | bpm | popularity |', '|---|---|---|'];
  for (const s of [...rows].sort((a, b) => b.pop - a.pop))
    out.push(`| ${s.artist} — ${s.title} | ${s.bpm} | ${s.pop} |`);
  return out;
};
L.push('## KNOWS (want high)');
L.push('');
L.push(...tbl(knows));
L.push('');
L.push('## DEEP CUTS (want low)');
L.push('');
L.push(...tbl(deep));
L.push('');
if (inversions.length) {
  L.push('## Same-BPM inversions (deep cut ≥ known anchor at the same BPM)');
  L.push('');
  L.push('| bpm | deep cut (pop) | ranks ≥ known anchor (pop) |');
  L.push('|---|---|---|');
  for (const { d, k } of inversions)
    L.push(`| ${d.bpm} | ${d.artist} — ${d.title} (${d.pop}) | ${k.artist} — ${k.title} (${k.pop}) |`);
  L.push('');
}

const DEV = join(HERE, '..', '.dev', 'reference');
mkdirSync(DEV, { recursive: true });
const reportPath = join(DEV, 'popularity-eval.md');
writeFileSync(reportPath, L.join('\n') + '\n');

console.error('');
console.error(`median(KNOWS)=${medKnows} (≥80 ${g1 ? 'ok' : 'FAIL'}) · median(DEEP)=${medDeep} (≤40 ${g2 ? 'ok' : 'FAIL'}) · inversions=${inversions.length} (${g3 ? 'ok' : 'FAIL'})`);
console.error(`${pass ? 'PASS' : 'FAIL'} -> ${reportPath}`);
process.exit(pass ? 0 : 1);
