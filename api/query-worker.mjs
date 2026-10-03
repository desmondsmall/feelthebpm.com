// Runs searches in a worker thread, so the HTTP side stays responsive and a query that runs past
// its time budget can be stopped by terminating this thread (node:sqlite can't interrupt a query).
// Protocol: the server posts { id, op: 'search' | 'health', params }; this replies { id, result }
// or { id, error, bad } (bad = the request was invalid → 400). Posts { ready: true } once open.
import { parentPort, workerData } from 'node:worker_threads';
import { Search, BadRequest } from './search.mjs';

const search = new Search(workerData.path);
parentPort.on('message', ({ id, op, params }) => {
  try {
    if (op === 'spin' && workerData.testHooks) { const end = Date.now() + params.ms; while (Date.now() < end); }   // tests only
    const result = op === 'health' ? search.health() : search.search(params);
    parentPort.postMessage({ id, result });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message, bad: e instanceof BadRequest });
  }
});
parentPort.postMessage({ ready: true });
