// Tests for api/search.mjs against a tiny search.db built through the real pipeline.
//   node --test api/*.test.mjs      (needs zstd and the sqlite3 command-line tool, as the pipeline does)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { makeFixture } from '../pipeline/search/fixture.mjs';
import { Search, BadRequest, parseQuery, ftsQuery } from './search.mjs';

const reads = (n, bpm) => Array(n).fill(bpm);   // n AcousticBrainz readings → weight n
let id = 0;
const s = (artist, title, n, bpm) => ({ mbid: `m${++id}`, artist, title, bpms: reads(n, bpm) });
const fx = makeFixture({
  songs: [
    s('The Beatles', 'Yesterday', 50, 97),
    s('Nobody Special', 'Yesterday', 1, 120),
    s('Carpenters', 'Yesterday Once More', 30, 86),
    s('Thirty Seconds to Mars', 'From Yesterday', 40, 135),
    s('The Beatles', 'Blackbird / Yesterday', 5, 96),
    s('Unknown Band', 'Smells Like', 1, 100),
    s('Nirvana', 'Smells Like Teen Spirit', 60, 117),
    s('Queen', 'Bohemian Rhapsody', 45, 72),
    s('Queen', 'Another One Bites the Dust', 35, 110),
    s('Perfume Genius', 'Queen', 3, 100),
    s('Journey', "Don't Stop Believin'", 25, 119),
    s('Daft Punk', 'Get Lucky', 20, 116),
    ...Array.from({ length: 7 }, (_, i) => s(`Love Band ${i}`, 'Love', 7 - i, 100 + i)),   // paging
  ],
  curated: [{ artist: 'Daft Punk', title: 'Get Lucky', bpm: 116, felt_bpm: 116, genre: 'disco', year: 2013 }],
});
fx.build();
const search = new Search(fx.searchDb);
const top = (params, n = 3) => search.search(params).items.slice(0, n).map((r) => `${r.artist} — ${r.title}`);
after(() => rmSync(fx.dir, { recursive: true, force: true }));

test('query parsing: the last word is open unless the query ends in a space or punctuation', () => {
  assert.deepEqual(parseQuery('Smells Lik'), { n: 'smells lik', words: ['smells', 'lik'], open: true });
  assert.equal(parseQuery('smells like ').open, false);
  assert.equal(ftsQuery(parseQuery("don't sto")), '"dont" "sto"*');
});

test('titles matching the query come before titles that merely contain its words', () => {
  // The famous exact match first; a famous prefix match ahead of an obscure exact one; then the
  // songs that only contain "yesterday" ("From Yesterday" weighs more but matches less well).
  assert.deepEqual(top({ q: 'yesterday' }, 5), ['The Beatles — Yesterday', 'Carpenters — Yesterday Once More', 'Nobody Special — Yesterday',
    'Thirty Seconds to Mars — From Yesterday', 'The Beatles — Blackbird / Yesterday']);
});

test('while typing, a famous prefix match outranks a thin exact match', () => {
  assert.deepEqual(top({ q: 'smells like' }, 1), ['Nirvana — Smells Like Teen Spirit']);
  assert.deepEqual(top({ q: 'smells li' }, 1), ['Nirvana — Smells Like Teen Spirit']);
});

test("an artist's name finds the artist's songs before songs with that title", () => {
  assert.deepEqual(top({ q: 'queen' }, 2), ['Queen — Bohemian Rhapsody', 'Queen — Another One Bites the Dust']);
});

test('artist + title, with or without "the", finishes or unfinished', () => {
  assert.deepEqual(top({ q: 'beatles yesterday' }, 1), ['The Beatles — Yesterday']);
  assert.deepEqual(top({ q: 'the beatles yest' }, 1), ['The Beatles — Yesterday']);
});

test('words in any order still match (the tail)', () => {
  assert.deepEqual(top({ q: 'yesterday beatles' }, 1), ['The Beatles — Yesterday']);
});

test('apostrophes and accents normalize the same way as the index', () => {
  assert.deepEqual(top({ q: 'dont stop' }, 1), ["Journey — Don't Stop Believin'"]);
  assert.deepEqual(top({ q: "Don’t Stop Believin’" }, 1), ["Journey — Don't Stop Believin'"]);
});

test('results carry both octaves, and curated fields only for curated songs', () => {
  const [lucky] = search.search({ q: 'get lucky' }).items;
  assert.deepEqual(lucky, { artist: 'Daft Punk', title: 'Get Lucky', bpm: 116, bpm_alt: null, curated: true, genre: 'disco', year: 2013 });
  const [rhap] = search.search({ q: 'bohemian' }).items;
  assert.equal(rhap.bpm, 72); assert.equal(rhap.bpm_alt, 144); assert.equal(rhap.curated, false);
  assert.ok(rhap.mbid); assert.equal(rhap.release, 'r'); assert.equal(rhap.genre, undefined);
});

test('a BPM range matches the reading or its other octave', () => {
  // Bohemian Rhapsody reads 72 (alt 144); Carpenters 86 (alt 172).
  assert.deepEqual(top({ q: 'bohemian', bpm_min: 140, bpm_max: 150 }), ['Queen — Bohemian Rhapsody']);
  assert.deepEqual(top({ q: 'bohemian', bpm_min: 100, bpm_max: 110 }), []);
  const browse = search.search({ bpm_min: 171, bpm_max: 173, limit: 50 }).items.map((r) => r.title);
  assert.ok(browse.includes('Yesterday Once More'));
});

test('show more: pages never repeat and together cover every match', () => {
  const seen = [];
  let after;
  do {
    const page = search.search({ q: 'love', limit: 2, after });
    seen.push(...page.items.map((r) => r.artist));
    after = page.next;
  } while (after);
  assert.equal(new Set(seen).size, seen.length);
  assert.equal(seen.filter((a) => a.startsWith('Love Band')).length, 7);
  assert.equal(seen[0], 'Love Band 0');   // heaviest first
});

test('browse: by rank, curated only, and sorted by BPM with paging', () => {
  assert.equal(search.search({ limit: 1 }).items[0].title, 'Get Lucky');   // curated weighs most
  assert.deepEqual(search.search({ curated: '1', limit: 50 }).items.map((r) => r.title), ['Get Lucky']);
  const all = [];
  let after;
  do {
    const page = search.search({ sort: 'bpm', bpm_min: 95, bpm_max: 101, limit: 2, after });
    all.push(...page.items.map((r) => (r.bpm >= 95 && r.bpm <= 101 ? r.bpm : r.bpm_alt)));
    after = page.next;
  } while (after);
  assert.deepEqual(all, [...all].sort((x, y) => x - y));
  assert.ok(all.length >= 5);
});

test('bad input is rejected', () => {
  for (const p of [{ limit: 0 }, { limit: 51 }, { bpm_min: 500 }, { bpm_min: 120, bpm_max: 90 }, { sort: 'nonsense' }, { q: 'x', sort: 'bpm' }, { after: '!!!' }]) {
    assert.throws(() => search.search(p), BadRequest, JSON.stringify(p));
  }
});

test('health reports the data version', () => {
  const h = search.health();
  assert.equal(h.ok, true); assert.equal(h.schema_version, 5); assert.ok(h.built_at); assert.equal(h.songs, 19);
});
