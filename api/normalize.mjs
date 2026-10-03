// Text normalization shared by the search pipeline (which stores artist_norm / title_norm) and the
// search endpoint (which normalizes queries the same way), so a query and a stored title compare
// equal exactly when a person would say they're the same words.
//
// Unlike pipeline/build.mjs's norm(), this keeps letters and digits of every script: "Mötley Crüe"
// → "motley crue", but "千本桜" stays "千本桜" instead of becoming an empty string.

/** Lowercase, strip accents and apostrophes, turn "&" into "and", collapse everything else to single spaces. */
export function normalize(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')                 // combining marks left by NFKD (accents)
    .toLowerCase()
    .replace(/['‘’`´]/g, '')       // "Don't" = "Dont"
    .replace(/&/g, ' and ')                 // "Simon & Garfunkel" = "Simon and Garfunkel"
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
