#!/usr/bin/env node
// Evaluate GetSongBPM as a canonical BPM/key source WITHOUT touching public/.
// Reuses build.mjs's real matching helpers so the report reflects what the pipeline
// would actually do. Writes the markdown report + raw JSON into .dev/reference/ (the
// project's doc vault); neither is deployed.
//
//   GETSONGBPM_API_KEY=your_key node pipeline/eval-gsb.mjs
//
// Asks three questions:
//   1. Coverage   — what % of shipped songs does GSB return a bpm / key for?
//   2. vs overrides (GROUND TRUTH) — does GSB agree with your hand-verified tempos?
//   3. vs Deezer  — where they diverge, who's right (override adjudicates)?
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { key, deezerEnrich, getsongbpmEnrich, loadOverrides } from './build.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SONGS = JSON.parse(readFileSync(join(HERE, '..', 'public', 'songs.json'), 'utf8'));

if (!process.env.GETSONGBPM_API_KEY) {
  console.error('GETSONGBPM_API_KEY is not set. Run: GETSONGBPM_API_KEY=your_key node pipeline/eval-gsb.mjs');
  process.exit(1);
}

// ---- classification helpers --------------------------------------------
const within = (a, b, tol = 2) => Math.abs(a - b) <= tol;
const isHalfOrDouble = (a, b) => {
  const r = b ? a / b : 0;
  return Math.abs(r - 2) <= 0.05 || Math.abs(r - 0.5) <= 0.05;
};
// classify GSB value `a` against reference `b`
const classify = (a, b) => {
  if (!a || !b) return 'missing';
  if (a === b) return 'exact';
  if (within(a, b, 2)) return 'within2';
  if (isHalfOrDouble(a, b)) return 'half_double';
  return 'disagree';
};
const dir = (a, b) => (a > b ? `gsb 2× high (${a} vs ${b})` : `gsb 2× low (${a} vs ${b})`);

// ---- gather --------------------------------------------------------------
const overrides = loadOverrides();
const rows = [];
let i = 0;
console.error(`Evaluating GSB over ${SONGS.length} songs (first run hits the network; cached after)...`);
for (const s of SONGS) {
  i++;
  const k = key(s.artist, s.title);
  const deezer = await deezerEnrich(s);          // cache-served from prior builds
  const gsb = await getsongbpmEnrich(s);         // live GSB call (cached after first)
  rows.push({
    artist: s.artist, title: s.title,
    override: overrides[k] ?? null,
    deezer_bpm: deezer?.bpm || 0,
    gsb_bpm: gsb?.bpm || 0,
    gsb_year: gsb?.year || null,
    published_bpm: s.bpm,
  });
  if (i % 25 === 0) console.error(`  [${i}/${SONGS.length}]`);
}

// ---- 1. coverage ---------------------------------------------------------
const n = rows.length;
const gsbBpm = rows.filter((r) => r.gsb_bpm > 0).length;
const gsbYear = rows.filter((r) => r.gsb_year).length;
const deezerBpm = rows.filter((r) => r.deezer_bpm > 0).length;
const pct = (x) => `${((100 * x) / n).toFixed(1)}%`;

// ---- 2. GSB vs overrides (ground truth) ----------------------------------
const ovRows = rows.filter((r) => r.override != null);
const ovClass = ovRows.map((r) => ({ ...r, cls: classify(r.gsb_bpm, r.override) }));
const ovCount = (c) => ovClass.filter((r) => r.cls === c).length;
const ovCovered = ovClass.filter((r) => r.cls !== 'missing').length;
const ovAgree = ovCount('exact') + ovCount('within2');
const ovAgreePct = ovCovered ? `${((100 * ovAgree) / ovCovered).toFixed(1)}%` : 'n/a';

// ---- 3. GSB vs Deezer ----------------------------------------------------
const bothRows = rows.filter((r) => r.gsb_bpm > 0 && r.deezer_bpm > 0);
const dzClass = bothRows.map((r) => ({ ...r, cls: classify(r.gsb_bpm, r.deezer_bpm) }));
const dzCount = (c) => dzClass.filter((r) => r.cls === c).length;
const adjudicate = (r) =>
  r.override == null ? '—'
  : within(r.gsb_bpm, r.override) ? 'GSB'
  : within(r.deezer_bpm, r.override) ? 'Deezer'
  : 'neither';

// ---- report --------------------------------------------------------------
const L = [];
L.push(`# GetSongBPM evaluation — ${new Date().toISOString().slice(0, 10)}`);
L.push('');
L.push(`Population: **${n}** songs from \`public/songs.json\` (the shipped catalogue). Read-only — nothing in \`public/\` was touched.`);
L.push('');
L.push('## 1. Coverage');
L.push('');
L.push('| source | has BPM | has year |');
L.push('|---|---|---|');
L.push(`| **GSB** | ${gsbBpm}/${n} (${pct(gsbBpm)}) | ${gsbYear}/${n} (${pct(gsbYear)}) |`);
L.push(`| Deezer | ${deezerBpm}/${n} (${pct(deezerBpm)}) | — |`);
L.push('');
L.push('## 2. GSB vs overrides — the decider');
L.push('');
L.push(`Ground truth = your **${ovRows.length}** hand-verified overrides. Of those:`);
L.push('');
L.push('| outcome | count | meaning |');
L.push('|---|---|---|');
L.push(`| GSB has no BPM | ${ovCount('missing')} | GSB couldn't tempo it |`);
L.push(`| exact | ${ovCount('exact')} | GSB == override |`);
L.push(`| within ±2 | ${ovCount('within2')} | effectively agrees |`);
L.push(`| half/double | ${ovCount('half_double')} | GSB has the 2×/½ artifact |`);
L.push(`| disagree | ${ovCount('disagree')} | genuinely different |`);
L.push('');
L.push(`**Agreement (exact or ±2) among GSB-covered overrides: ${ovAgree}/${ovCovered} = ${ovAgreePct}.**`);
L.push(`That's the share of your manual overrides GSB could potentially absorb. High → GSB is canonical-quality; low → it isn't.`);
L.push('');
const ovBad = ovClass.filter((r) => r.cls === 'disagree' || r.cls === 'half_double')
  .sort((a, b) => Math.abs(b.gsb_bpm - b.override) - Math.abs(a.gsb_bpm - a.override));
if (ovBad.length) {
  L.push('### Overrides GSB gets wrong (eyeball these)');
  L.push('');
  L.push('| artist — title | override | gsb | class |');
  L.push('|---|---|---|---|');
  for (const r of ovBad) L.push(`| ${r.artist} — ${r.title} | ${r.override} | ${r.gsb_bpm} | ${r.cls === 'half_double' ? dir(r.gsb_bpm, r.override) : 'disagree'} |`);
  L.push('');
}
L.push('## 3. GSB vs Deezer');
L.push('');
L.push(`Among the **${bothRows.length}** songs where both have a BPM:`);
L.push('');
L.push(`- exact: ${dzCount('exact')} · within ±2: ${dzCount('within2')} · half/double: ${dzCount('half_double')} · disagree: ${dzCount('disagree')}`);
L.push('');
const dzSplit = dzClass.filter((r) => r.cls === 'half_double' || r.cls === 'disagree')
  .sort((a, b) => Math.abs(b.gsb_bpm - b.deezer_bpm) - Math.abs(a.gsb_bpm - a.deezer_bpm));
if (dzSplit.length) {
  L.push('### Where they diverge — who\'s right? (override adjudicates where present)');
  L.push('');
  L.push('| artist — title | deezer | gsb | override | correct | class |');
  L.push('|---|---|---|---|---|---|');
  for (const r of dzSplit) L.push(`| ${r.artist} — ${r.title} | ${r.deezer_bpm} | ${r.gsb_bpm} | ${r.override ?? '—'} | ${adjudicate(r)} | ${r.cls} |`);
  L.push('');
}

const DEV = join(HERE, '..', '.dev', 'reference');   // project doc vault — docs live here, not pipeline/
mkdirSync(DEV, { recursive: true });
const reportPath = join(DEV, 'gsb-eval.md');
const jsonPath = join(DEV, 'gsb-eval.json');
writeFileSync(reportPath, L.join('\n') + '\n');
writeFileSync(jsonPath, JSON.stringify({ generated: new Date().toISOString(), n, coverage: { gsbBpm, gsbYear, deezerBpm }, rows }, null, 2));

// ---- override worklist: conflicts with no override to settle them --------
// Songs where Deezer & GSB disagree and there's no hand-override. These are the
// highest-value override candidates — emit them ranked by popularity so the most
// recognizable songs (the anchors) get curated first. Nothing is dropped; this just
// tells you where a trustworthy tempo is still missing.
const popOf = new Map(SONGS.map((s) => [key(s.artist, s.title), s.popularity ?? 0]));
const conflicts = rows
  .filter((r) => r.override == null && r.deezer_bpm > 0 && r.gsb_bpm > 0 && !within(r.deezer_bpm, r.gsb_bpm, 3))
  .map((r) => ({ ...r, pop: popOf.get(key(r.artist, r.title)) ?? 0, cls: isHalfOrDouble(r.deezer_bpm, r.gsb_bpm) ? '2x' : 'disagree' }))
  .sort((a, b) => b.pop - a.pop);
const W = [];
W.push('# BPM conflicts — Deezer vs GSB disagree, no override');
W.push('');
W.push(`Generated by \`pipeline/eval-gsb.mjs\`. **${conflicts.length}** songs where Deezer and GSB disagree by >3 BPM`);
W.push(`with no hand-override to settle it (${conflicts.filter((r) => r.cls === '2x').length} are 2×/½ artifacts, ${conflicts.filter((r) => r.cls === 'disagree').length} genuine disagreements).`);
W.push('You know these songs — add the right tempo to `pipeline/bpm_overrides.json` to resolve each. Nothing is dropped meanwhile.');
W.push('');
W.push('| pop | song | deezer | gsb | type |');
W.push('|---|---|---|---|---|');
for (const r of conflicts) W.push(`| ${r.pop} | ${r.artist} — ${r.title} | ${r.deezer_bpm} | ${r.gsb_bpm} | ${r.cls} |`);
W.push('');
W.push('## Override stubs — fill each blank with the correct BPM, paste into bpm_overrides.json');
W.push('```jsonc');
for (const r of conflicts) W.push(`    "${key(r.artist, r.title)}": ,   // deezer ${r.deezer_bpm} / gsb ${r.gsb_bpm}  [${r.cls}, pop ${r.pop}]`);
W.push('```');
const conflictsPath = join(DEV, 'bpm-conflicts.md');
writeFileSync(conflictsPath, W.join('\n') + '\n');

console.error('');
console.error(`Coverage: GSB bpm ${pct(gsbBpm)}, year ${pct(gsbYear)} (Deezer bpm ${pct(deezerBpm)})`);
console.error(`vs overrides (${ovRows.length} truth): agree ${ovAgree}/${ovCovered} (${ovAgreePct}), half/double ${ovCount('half_double')}, disagree ${ovCount('disagree')}, no-gsb ${ovCount('missing')}`);
console.error(`vs Deezer (${bothRows.length} both): exact ${dzCount('exact')}, ±2 ${dzCount('within2')}, half/double ${dzCount('half_double')}, disagree ${dzCount('disagree')}`);
console.error(`\nReport    -> ${reportPath}`);
console.error(`Raw       -> ${jsonPath}`);
console.error(`Worklist  -> ${conflictsPath}  (${conflicts.length} conflicts to override)`);
