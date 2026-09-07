/*
 * Static file server for local development and for opening the app without
 * publishing it. It only serves files — all the map work happens in the
 * browser. Run with: npm run web
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', 'web');
const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '127.0.0.1';

/*
 * A world folder and a resource pack served over HTTP, for development only:
 * they let the app be opened against a known save without going through the
 * folder picker, which is the only way to drive the whole chain from an
 * automated check. Set WORLD=/path/to/save and PACK=/path/to/version.jar;
 * the world defaults to the fixture the test suite generates.
 */
const WORLD = process.env.WORLD || path.join(__dirname, '..', 'data', 'testworld');
const PACK = process.env.PACK || '';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const json = (res, code, data) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};

/** Resolve a path inside `root`, refusing anything that escapes it. */
function inside(root, rel) {
  const full = path.resolve(root, '.' + path.posix.resolve('/', rel));
  return full.startsWith(path.resolve(root)) ? full : null;
}

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  let rel = decodeURIComponent(parsed.pathname);

  // --- development world and pack ----------------------------------------
  if (rel === '/__world_ls') {
    const dir = inside(WORLD, parsed.searchParams.get('path') || '');
    if (!dir) { json(res, 403, []); return; }
    fs.readdir(dir, { withFileTypes: true }, (err, entries) => {
      if (err) { json(res, 200, []); return; }
      json(res, 200, entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() })));
    });
    return;
  }
  if (rel === '/__pack') {
    if (!PACK) { res.writeHead(404).end('Nessun pacchetto di sviluppo'); return; }
    fs.readFile(PACK, (err, data) => {
      if (err) { res.writeHead(404).end('Non trovato'); return; }
      res.writeHead(200, { 'Content-Type': 'application/java-archive' });
      res.end(data);
    });
    return;
  }
  if (rel.startsWith('/__world/')) {
    const file = inside(WORLD, rel.slice('/__world'.length));
    if (!file) { res.writeHead(403).end('Forbidden'); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end('Non trovato'); return; }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(data);
    });
    return;
  }

  if (rel.endsWith('/')) rel += 'index.html';

  const file = path.join(ROOT, rel);
  // Never serve outside the web folder.
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Non trovato');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Cube-Atlas:  http://${HOST}:${PORT}`);
  console.log('  (solo file statici — il mondo viene letto dal browser, in locale)\n');
});
