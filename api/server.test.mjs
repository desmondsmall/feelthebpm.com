// Tests for api/server.mjs: the real process, over HTTP, against a tiny fixture search.db.
//   node --test api/*.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeFixture } from '../pipeline/search/fixture.mjs';

const fx = makeFixture({
  songs: [
    { mbid: 'a', artist: 'The Beatles', title: 'Yesterday', bpms: [97, 97, 97] },
    { mbid: 'b', artist: 'Queen', title: 'Bohemian Rhapsody', bpms: [72, 72] },
  ],
});
fx.build();

let proc, base;
before(async () => {
  proc = spawn(process.execPath, ['--no-warnings', fileURLToPath(new URL('./server.mjs', import.meta.url))], {
    env: { ...process.env, SEARCH_DB: fx.searchDb, PORT: '0', QUERY_TIMEOUT_MS: '300', SEARCH_TEST_HOOKS: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  base = await new Promise((resolve, reject) => {
    let out = '';
    proc.stdout.on('data', (d) => { out += d; const m = out.match(/listening on ([\d.]+):(\d+)/); if (m) resolve(`http://${m[1]}:${m[2]}`); });
    proc.on('exit', (c) => reject(new Error(`server exited ${c}`)));
  });
});
after(() => { proc?.kill('SIGTERM'); rmSync(fx.dir, { recursive: true, force: true }); });
const get = async (path, init) => { const r = await fetch(base + path, init); return { status: r.status, headers: r.headers, body: await r.json() }; };

test('GET /api/songs answers a search, cacheably', async () => {
  const r = await get('/api/songs?q=yesterday');
  assert.equal(r.status, 200);
  assert.equal(r.body.items[0].title, 'Yesterday');
  assert.equal(r.headers.get('cache-control'), 'public, max-age=3600');
  assert.match(r.headers.get('content-type'), /application\/json/);
});

test('invalid parameters are a 400, unknown paths a 404, other methods a 405', async () => {
  assert.equal((await get('/api/songs?limit=500')).status, 400);
  assert.equal((await get('/api/songs?q=x&sort=bpm')).status, 400);
  assert.equal((await get('/nope')).status, 404);
  assert.equal((await get('/api/songs', { method: 'POST' })).status, 405);
});

test('GET /api/health reports the data version, uncached', async () => {
  const r = await get('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true); assert.equal(r.body.songs, 2); assert.equal(r.body.schema_version, 4);
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('a query past the time budget gets a 503, and the server recovers', async () => {
  const slow = await get('/test/spin?ms=5000');
  assert.equal(slow.status, 503); assert.equal(slow.body.error, 'timeout');
  const r = await get('/api/songs?q=bohemian');
  assert.equal(r.status, 200); assert.equal(r.body.items[0].artist, 'Queen');
});

test('SIGHUP reopens the database without dropping requests', async () => {
  proc.kill('SIGHUP');
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => get(`/api/songs?q=${i % 2 ? 'yesterday' : 'queen'}`)));
  assert.ok(results.every((r) => r.status === 200), results.map((r) => r.status).join(','));
  assert.equal((await get('/api/health')).body.ok, true);
});
