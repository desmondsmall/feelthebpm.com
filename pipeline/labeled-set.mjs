// Hand-labeled recognizability ground truth (see .dev/reference/popularity-rework.md §5).
// Shared by eval-popularity.mjs (the release gate) and sweep-weights.mjs (offline weight
// comparison) so both score against the SAME set. Exact catalogue strings (artist, title).
//   KNOWS     — songs ~everyone recognizes; the metric should rank these HIGH.
//   DEEP_CUTS — beloved-but-obscure tracks (deliberately by famous artists, the hard case);
//               the metric should rank these LOW.
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

export const DEEP_CUTS = [
  ['Simon & Garfunkel', 'Anji'],
  ['The Black Keys', 'Thickfreakness'],
  ['Talking Heads', 'And She Was'],
  ['Kings of Leon', 'Beautiful War'],
  ['Earth, Wind & Fire', 'In The Stone'],
  ['Soundgarden', 'Burden In My Hand'],
  ['The Smiths', 'Some Girls Are Bigger Than Others'],
  ['Jimi Hendrix', 'Hey Baby (New Rising Sun)'],
  ['Jimi Hendrix', 'Bold As Love'],
  ['Jimi Hendrix', 'Castles Made Of Sand'],
];
