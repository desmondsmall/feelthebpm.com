// Where the song-search pipeline keeps its inputs and outputs. All of it is under pipeline/cache/
// (gitignored): the dumps are gigabytes and the working database is ~20 GB, so they never leave
// the laptop. Only search.db and its manifest are shipped, by a deploy step outside this repo.
// SEARCH_OPEN_DATA overrides the directory (the tests point it at a small fixture).
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const OPEN_DATA = process.env.SEARCH_OPEN_DATA || join(HERE, '..', 'cache', 'open-data');
export const OPEN_DATA_DB = join(OPEN_DATA, 'open-data.db');     // working database (load.sh / load.sql)
export const SEARCH_DB = join(OPEN_DATA, 'search.db');           // the shipped file (build-search.mjs)
export const MANIFEST = join(OPEN_DATA, 'manifest.json');        // what search.db was built from
export const CURATED = process.env.SEARCH_CURATED || join(HERE, '..', '..', 'public', 'songs.json');
