#!/usr/bin/env node
// The song-search endpoint. Node 22, no dependencies.
//
//   SEARCH_DB=pipeline/cache/open-data/search.db node api/server.mjs
//
//   GET /api/songs?q=&bpm_min=&bpm_max=&sort=&limit=&after=&curated=   → { items, next }
//   GET /api/health                                                    → { ok, songs, schema_version, built_at }
//
// Environment: SEARCH_DB (required), PORT (default 8090), HOST (default 127.0.0.1: meant to sit
// behind a reverse proxy), QUERY_TIMEOUT_MS (default 500), QUEUE_MAX (default 100).
// Queries run one at a time in a worker thread (query-worker.mjs). One that exceeds
// QUERY_TIMEOUT_MS gets a 503, and the worker is terminated and replaced. SIGHUP reopens the
// database (after a new search.db is swapped in); SIGTERM/SIGINT shut down cleanly.
// What the query parameters mean: api/search.mjs.
import { createServer } from 'node:http';
import { Worker } from 'node:worker_threads';

const DB = process.env.SEARCH_DB;
const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.HOST || '127.0.0.1';
const TIMEOUT = Number(process.env.QUERY_TIMEOUT_MS || 500);
const QUEUE_MAX = Number(process.env.QUEUE_MAX || 100);
const TEST_HOOKS = process.env.SEARCH_TEST_HOOKS === '1';
if (!DB) { console.error('SEARCH_DB is not set'); process.exit(1); }
const log = (s) => console.log(`[search] ${s}`);

// ---- the worker: one query at a time, with a deadline ----
let worker = null, ready = false, inflight = null, reopenPending = false, seq = 0;
const queue = [];

function startWorker() {
  ready = false;
  const w = new Worker(new URL('./query-worker.mjs', import.meta.url), { workerData: { path: DB, testHooks: TEST_HOOKS } });
  w.on('message', (m) => {
    if (w !== worker) return;
    if (m.ready) { ready = true; log(`database open: ${DB}`); return pump(); }
    if (!inflight || m.id !== inflight.id) return;
    clearTimeout(inflight.timer);
    const job = inflight;
    inflight = null;
    job.done(m);
    if (reopenPending) { reopenPending = false; restart('reopening the database'); } else pump();
  });
  w.on('error', (e) => { if (w === worker) { log(`worker error: ${e.message}`); failInflight('unavailable'); restart('after an error'); } });
  w.on('exit', (code) => { if (w === worker && code !== 0) { failInflight('unavailable'); restart(`after exit ${code}`); } });
  worker = w;
}
function restart(why) {
  log(`restarting the query worker ${why}`);
  const old = worker;
  worker = null;
  old?.terminate();
  startWorker();
}
function failInflight(error) {
  if (!inflight) return;
  clearTimeout(inflight.timer);
  inflight.done({ error, status: 503 });
  inflight = null;
}
function pump() {
  if (inflight || !ready || !queue.length) return;
  const job = queue.shift();
  job.id = ++seq;
  job.timer = setTimeout(() => {
    log(`query exceeded ${TIMEOUT} ms: ${JSON.stringify(job.params)}`);
    failInflight('timeout');
    restart('after a timeout');
  }, TIMEOUT);
  inflight = job;
  worker.postMessage({ id: job.id, op: job.op, params: job.params });
}
function ask(op, params) {
  return new Promise((done) => {
    if (queue.length >= QUEUE_MAX) return done({ error: 'busy', status: 503 });
    queue.push({ op, params, done });
    pump();
  });
}

// ---- HTTP ----
const PARAMS = ['q', 'bpm_min', 'bpm_max', 'sort', 'limit', 'after', 'curated'];
function send(res, status, body, cache) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cache ?? 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(res.req.method === 'HEAD' ? undefined : json);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
  if (url.pathname === '/api/health') {
    const m = await ask('health', null);
    return m.result?.ok ? send(res, 200, m.result) : send(res, 503, { ok: false, error: m.error ?? 'unavailable' });
  }
  if (url.pathname === '/api/songs') {
    const params = {};
    for (const k of PARAMS) { const v = url.searchParams.get(k); if (v != null) params[k] = v; }
    if (params.limit != null) params.limit = Number(params.limit);
    const m = await ask('search', params);
    if (m.result) return send(res, 200, m.result, 'public, max-age=3600');   // the data changes only on a rebuild
    return send(res, m.bad ? 400 : m.status ?? 500, { error: m.error });
  }
  if (TEST_HOOKS && url.pathname === '/test/spin') {
    const m = await ask('spin', { ms: Number(url.searchParams.get('ms')) });
    return m.result ? send(res, 200, { ok: true }) : send(res, m.status ?? 500, { error: m.error });
  }
  send(res, 404, { error: 'not found' });
});

startWorker();
server.listen(PORT, HOST, () => log(`listening on ${HOST}:${server.address().port}`));
process.on('SIGHUP', () => {
  log('SIGHUP: reopening the database');
  if (inflight) reopenPending = true; else restart('to reopen the database');
});
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { log(`${sig}: shutting down`); server.close(); worker?.terminate(); setTimeout(() => process.exit(0), 2000).unref(); });
