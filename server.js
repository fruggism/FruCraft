'use strict';
/*
 * Cube-Atlas local server.
 *
 * Binds to 127.0.0.1 by default: the world save, the rendered tiles and the
 * projects never leave the machine.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');

const anvil = require('./lib/anvil');
const tiler = require('./lib/tiler');
const worldScan = require('./lib/worldScan');
const projects = require('./lib/projects');
const book = require('./lib/book');

const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// World registry: maps a worldId to its path so tile URLs stay clean and the
// filesystem path is never round-tripped through the browser.
// ---------------------------------------------------------------------------
const REGISTRY_FILE = path.join(__dirname, 'data', 'worlds.json');
let worldRegistry = new Map();

function loadRegistry() {
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    worldRegistry = new Map(Object.entries(raw));
  } catch {
    worldRegistry = new Map();
  }
}
function saveRegistry() {
  try {
    fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(Object.fromEntries(worldRegistry), null, 2));
  } catch { /* best effort */ }
}
function registerWorld(worldPath) {
  const id = worldScan.worldId(worldPath);
  worldRegistry.set(id, path.resolve(worldPath));
  saveRegistry();
  return id;
}
function worldPathFor(id) {
  const p = worldRegistry.get(id);
  if (!p) throw new Error('Mondo non registrato: riapri il mondo dalla schermata iniziale');
  return p;
}
loadRegistry();

function fail(res, err, status = 400) {
  res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

/** Suggest where Minecraft saves usually live, to save the user some typing. */
app.get('/api/world/suggestions', (req, res) => {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.minecraft', 'saves'),
    path.join(home, 'Library', 'Application Support', 'minecraft', 'saves'),
    path.join(home, 'AppData', 'Roaming', '.minecraft', 'saves'),
    path.join(home, 'curseforge', 'minecraft', 'Instances'),
  ];
  const found = [];
  for (const dir of candidates) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (worldScan.isWorldFolder(full)) found.push({ name: e.name, path: full });
    }
  }
  res.json({ savesDirs: candidates, worlds: found });
});

app.get('/api/world/scan', (req, res) => {
  try {
    const worldPath = req.query.path;
    if (!worldPath) throw new Error('Parametro "path" mancante');
    const info = worldScan.scanWorld(String(worldPath));
    if (!info.ok) return res.status(404).json(info);
    registerWorld(String(worldPath));
    res.json(info);
  } catch (err) {
    fail(res, err);
  }
});

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

app.get('/api/tiles/:worldId/:dimension/:z/:x/:y.png', (req, res) => {
  try {
    const { worldId, dimension } = req.params;
    const z = parseInt(req.params.z, 10);
    const x = parseInt(req.params.x, 10);
    const y = parseInt(req.params.y, 10);
    if (![z, x, y].every(Number.isFinite)) throw new Error('Coordinate tile non valide');
    if (!Object.prototype.hasOwnProperty.call(anvil.DIMENSIONS, dimension)) {
      throw new Error(`Dimensione sconosciuta: ${dimension}`);
    }

    const worldPath = worldPathFor(worldId);
    const tile = tiler.getTile({
      worldPath, worldId, dimension, z, x, y,
      renderOptions: {
        shadeStrength: req.query.shade !== undefined ? Number(req.query.shade) : 1,
        waterDepthShading: req.query.waterDepth !== '0',
      },
    });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-cache'); // the on-disk tile cache is the real cache
    res.send(tile.buffer);
  } catch (err) {
    // A broken tile must not break the whole map: answer with a transparent
    // tile and report the reason in a header for debugging.
    res.set('Content-Type', 'image/png');
    res.set('X-Tile-Error', String(err.message).slice(0, 200));
    res.status(200).send(tiler.getTile({ z: 99, x: 0, y: 0 }).buffer);
  }
});

app.post('/api/tiles/:worldId/clear-cache', (req, res) => {
  try {
    const { worldId } = req.params;
    worldPathFor(worldId); // validate it is a known world
    tiler.clearCache(worldId, req.body && req.body.dimension);
    res.json({ ok: true, ...tiler.cacheStats(worldId) });
  } catch (err) {
    fail(res, err);
  }
});

app.get('/api/tiles/:worldId/cache-stats', (req, res) => {
  try {
    res.json(tiler.cacheStats(req.params.worldId));
  } catch (err) {
    fail(res, err);
  }
});

// ---------------------------------------------------------------------------
// World inspection
// ---------------------------------------------------------------------------

/** Point probe: what is at this block? Used by the map's inspector. */
app.get('/api/world/:worldId/probe', (req, res) => {
  try {
    const worldPath = worldPathFor(req.params.worldId);
    const dimension = req.query.dim || 'overworld';
    const x = parseInt(req.query.x, 10);
    const z = parseInt(req.query.z, 10);
    if (![x, z].every(Number.isFinite)) throw new Error('Coordinate non valide');
    const g = anvil.readSurface(worldPath, dimension, x, z, 1, 1);
    res.json({
      x, z,
      y: g.surfaceY[0] === anvil.NO_DATA ? null : g.surfaceY[0],
      block: g.surfaceY[0] === anvil.NO_DATA ? null : g.surfaceName[0],
      biome: g.biome[0],
      floorY: g.floorY[0] === anvil.NO_DATA ? null : g.floorY[0],
    });
  } catch (err) {
    fail(res, err);
  }
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

app.get('/api/projects', (req, res) => {
  try {
    res.json(projects.listProjects());
  } catch (err) {
    fail(res, err, 500);
  }
});

app.post('/api/projects', (req, res) => {
  try {
    res.status(201).json(projects.createProject(req.body || {}));
  } catch (err) {
    fail(res, err);
  }
});

app.get('/api/projects/:id', (req, res) => {
  try {
    const p = projects.getProject(req.params.id);
    if (!p) return res.status(404).json({ error: 'Progetto non trovato' });
    res.json(p);
  } catch (err) {
    fail(res, err);
  }
});

app.put('/api/projects/:id', (req, res) => {
  try {
    res.json(projects.saveProject(req.params.id, req.body || {}));
  } catch (err) {
    fail(res, err, /non trovato/.test(err.message) ? 404 : 400);
  }
});

/* Same as PUT, but reachable from navigator.sendBeacon (which can only POST)
 * so edits still pending in the browser's debounce are flushed when the tab
 * is closed instead of being lost. */
app.post('/api/projects/:id/flush', (req, res) => {
  try {
    projects.saveProject(req.params.id, req.body || {});
    res.status(204).end();
  } catch (err) {
    fail(res, err, /non trovato/.test(err.message) ? 404 : 400);
  }
});

app.delete('/api/projects/:id', (req, res) => {
  try {
    projects.deleteProject(req.params.id);
    res.status(204).end();
  } catch (err) {
    fail(res, err);
  }
});

app.post('/api/projects/import', (req, res) => {
  try {
    const body = req.body || {};
    if (body.format && body.format !== projects.FORMAT) {
      throw new Error('Il file non sembra un progetto Cube-Atlas');
    }
    res.status(201).json(projects.importProject(body, ' (importato)'));
  } catch (err) {
    fail(res, err);
  }
});

// ---------------------------------------------------------------------------
// Archive -> Minecraft books
// ---------------------------------------------------------------------------

app.post('/api/books/export', (req, res) => {
  try {
    const { title, author, body, maxChars } = req.body || {};
    res.json(book.exportDocument({ title, author, body, maxChars }));
  } catch (err) {
    fail(res, err);
  }
});

// ---------------------------------------------------------------------------

app.use((req, res) => res.status(404).json({ error: 'Endpoint non trovato' }));

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`\n  Cube-Atlas è pronto:  http://${HOST}:${PORT}`);
    console.log('  (server locale — nessun dato lascia questo computer)\n');
  });
}

module.exports = app;
