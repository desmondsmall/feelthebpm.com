#!/usr/bin/env node
// Discovery / SEED step: union every membership source into pipeline/catalogue.json — the
// reviewable, prunable list of songs the build draws from. Run this to refresh membership after
// editing artists.json / extra_songs.json (or to pull fresh Songsterr views):
//
//   node pipeline/seed.mjs
//
// The build (pipeline/build.mjs) READS catalogue.json; it only auto-generates it on a first run
// when the file is absent. Keeping discovery here decouples it from scoring — the build no longer
// scrapes Songsterr on every run, and the catalogue can be eyeballed / hand-pruned between runs.
// See .dev/reference/pipeline-architecture.md.
import { gatherCatalogue, writeCatalogue } from './build.mjs';

try {
  const catalogue = await gatherCatalogue();
  const n = writeCatalogue(catalogue);
  const bySource = catalogue.reduce((m, c) => ((m[c.source] = (m[c.source] || 0) + 1), m), {});
  console.error(`\nSeed written: ${n} songs -> pipeline/catalogue.json`);
  console.error(`By source: ${Object.entries(bySource).map(([s, c]) => `${s} ${c}`).join(' · ')}`);
} catch (e) {
  console.error('\nSeed failed:', e?.stack || e);
  process.exit(1);
}
