#!/usr/bin/env node
// Local curation tool (no deps). Serves the felt-BPM review UI, the review.json sidecar, and writes
// decisions back to inputs/bpm_overrides.json. Decisions are the same git-tracked overrides the build
// already reads — rebuild to apply them. See .dev/curation-tool.md.
//
//   node pipeline/build.mjs            # (re)generate pipeline/generated/review.json
//   node pipeline/review-server.mjs    # → http://localhost:5177  — listen, tap, save
//   node pipeline/build.mjs            # rebuild to bake decisions into songs.json
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REVIEW = join(HERE, 'generated', 'review.json');
const OVERRIDES = join(HERE, 'inputs', 'bpm_overrides.json');
const HTML = join(HERE, 'review.html');
const COVERS = join(HERE, '..', 'public', 'covers');   // self-hosted art the review UI displays
const PORT = Number(process.env.PORT) || 5177;

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
};

// Append/update a felt override. Key is lowercased 'artist|title' to match the file's style; the
// build's loadOverrides() re-normalizes both sides (punctuation/case) so it matches the candidate.
function saveOverride(artist, title, bpm) {
  const doc = readJson(OVERRIDES);
  const key = `${artist}|${title}`.toLowerCase();
  doc.overrides[key] = bpm;
  writeFileSync(OVERRIDES, JSON.stringify(doc, null, 2) + '\n');
  return key;
}

const server = createServer((req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
      if (!existsSync(HTML)) return send(res, 500, 'review.html missing', 'text/plain');
      return send(res, 200, readFileSync(HTML, 'utf8'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && req.url === '/review.json') {
      if (!existsSync(REVIEW)) return send(res, 404, JSON.stringify({ error: 'no review.json — run `node pipeline/build.mjs` first' }));
      return send(res, 200, readFileSync(REVIEW, 'utf8'));
    }
    if (req.method === 'GET' && req.url.startsWith('/covers/')) {
      const name = decodeURIComponent(req.url.slice('/covers/'.length).split('?')[0]);
      const p = join(COVERS, name);
      if (name.includes('..') || !existsSync(p)) return send(res, 404, '', 'text/plain');
      return send(res, 200, readFileSync(p), 'image/jpeg');
    }
    if (req.method === 'POST' && req.url === '/decide') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        try {
          const { artist, title, bpm } = JSON.parse(body || '{}');
          if (!artist || !title || !(bpm > 0)) return send(res, 400, JSON.stringify({ error: 'need artist, title, bpm>0' }));
          const key = saveOverride(artist, title, Math.round(bpm));
          console.error(`  saved  ${key} = ${Math.round(bpm)}`);
          send(res, 200, JSON.stringify({ ok: true, key, bpm: Math.round(bpm) }));
        } catch (e) { send(res, 400, JSON.stringify({ error: String(e) })); }
      });
      return;
    }
    send(res, 404, JSON.stringify({ error: 'not found' }));
  } catch (e) { send(res, 500, JSON.stringify({ error: String(e) })); }
});

server.listen(PORT, () => {
  console.error(`\n  Curation tool → http://localhost:${PORT}`);
  console.error(`  Decisions write to inputs/bpm_overrides.json — rebuild (node pipeline/build.mjs) to apply.\n`);
});
