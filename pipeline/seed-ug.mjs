#!/usr/bin/env node
// Parse manually-harvested Ultimate Guitar "Top 100 tabs by hits" charts into pipeline/generated/seed-ug.json
// — a MEMBERSHIP + ug_hits source for the build's SEED layer (see .dev/reference/pipeline-architecture.md).
// UG is Cloudflare-protected (no keyless fetch like Songsterr), so harvesting is manual: copy each
// chart's rendered text into pipeline/raw/ug-<type>.txt, then:
//   node pipeline/seed-ug.mjs        # raw/ -> seed-ug.json
//   node pipeline/seed.mjs           # fold UG into catalogue.json
//   ENABLE_YOUTUBE=1 node pipeline/build.mjs
// File type comes from the NAME: 'drums' anywhere in the filename => 'drums', else 'guitar-pro'.
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = join(HERE, 'raw');
const GENERATED = join(HERE, 'generated');
if (!existsSync(GENERATED)) mkdirSync(GENERATED, { recursive: true });
const OUT = join(GENERATED, 'seed-ug.json');

if (!existsSync(RAW)) { console.error(`No ${RAW}/ — create it and add harvested ug-*.txt files.`); process.exit(1); }
const files = readdirSync(RAW).filter((f) => /^ug-.*\.txt$/i.test(f));
if (!files.length) { console.error(`No ug-*.txt in ${RAW}/ — see the harvest steps in seed-ug.mjs.`); process.exit(1); }

// Rendered-text rows are 5 lines: rank / title / "<title><artist>" / version / hits-with-commas.
// Anchor on the hits line (digits with ≥1 comma group — ranks are comma-free, so no collision),
// then read the two lines above: title, and title+artist concatenated (artist = the suffix).
const parseText = (text, type) => {
  const lines = text.split('\n').map((l) => l.trim());
  const rows = [];
  for (let i = 3; i < lines.length; i++) {
    if (!/^\d{1,3}(,\d{3})+$/.test(lines[i])) continue;       // hits line
    const title = lines[i - 3];
    const titleArtist = lines[i - 2];
    if (!title || !titleArtist.startsWith(title)) continue;    // not a real chart row
    const artist = titleArtist.slice(title.length).trim();
    if (!artist) continue;
    rows.push({ artist, title, ug_hits: Number(lines[i].replace(/,/g, '')), ug_type: type });
  }
  return rows;
};

// dedup: collapse multiple tab versions + the same song across charts; keep max hits, union types.
const norm = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const byKey = new Map();
let parsed = 0;
for (const f of files) {
  const type = /drums/i.test(f) ? 'drums' : 'guitar-pro';
  const rows = parseText(readFileSync(join(RAW, f), 'utf8'), type);
  console.error(`  ${f}: ${rows.length} rows (${type})`);
  parsed += rows.length;
  for (const r of rows) {
    const k = `${norm(r.artist)}|${norm(r.title)}`;
    const prev = byKey.get(k);
    if (!prev) byKey.set(k, { artist: r.artist, title: r.title, ug_hits: r.ug_hits, ug_types: new Set([r.ug_type]) });
    else { prev.ug_hits = Math.max(prev.ug_hits, r.ug_hits); prev.ug_types.add(r.ug_type); }
  }
}

const songs = [...byKey.values()]
  .map(({ ug_types, ...r }) => ({ ...r, ug_type: [...ug_types].sort().join(',') }))
  .sort((a, b) => b.ug_hits - a.ug_hits);

writeFileSync(OUT, JSON.stringify({
  _comment:
    'Parsed Ultimate Guitar top-tabs harvest = MEMBERSHIP + ug_hits signal for the build SEED. Regenerate with `node pipeline/seed-ug.mjs` (reads pipeline/raw/ug-*.txt). UG strips punctuation from titles (display artifact); matching/dedup is punctuation-insensitive (build.mjs `key()`), so these still merge with existing catalogue entries. Net-new songs ship with UG\'s title and a default genre — promote any you care about into extra_songs.json with a real title/genre.',
  generated: new Date().toISOString().slice(0, 10),
  count: songs.length,
  songs,
}, null, 2) + '\n');

console.error(`\nParsed ${parsed} rows -> ${songs.length} unique songs -> pipeline/generated/seed-ug.json`);
