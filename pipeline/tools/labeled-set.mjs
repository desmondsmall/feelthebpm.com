// Hand-labeled recognizability ground truth (see .dev/popularity-rework.md §5).
// Shared by eval-popularity.mjs (the release gate) and sweep-weights.mjs (offline weight
// comparison). KNOWS = songs ~everyone recognizes; the metric must rank these HIGH.
//
// A DEEP_CUTS counter-set used to live here (beloved-but-obscure tracks that should rank LOW),
// but the recognizability prune (exclude-obscure.json / exclude-contemporary.json) removed those
// songs from the catalogue entirely — so the gate is now KNOWS-only, with eval-popularity.mjs's
// bottom-of-catalogue list as the floor sanity check. See pipeline-architecture.md.
export const KNOWS = [
  ['Michael Jackson', 'Billie Jean'],
  ['Spice Girls', 'Wannabe'],
  ["Guns N' Roses", "Sweet Child O' Mine"],
  ['Gloria Gaynor', 'I Will Survive'],
  ['Eagles', 'Hotel California'],
  ['Journey', "Don't Stop Believin'"],
  ['The White Stripes', 'Seven Nation Army'],
  ['Nirvana', 'Smells Like Teen Spirit'],
  ['Oasis', 'Wonderwall'],
  ['Toto', 'Africa'],
  ['a-ha', 'Take On Me'],
];
