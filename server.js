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
const renderJob = require('./lib/renderJob');
const worldScan = require('./lib/worldScan');
const projects = require('./lib/projects');
const book = require('./lib/book');

const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// World registry
//
// Tile URLs carry only a world id, never a filesystem path. The registry maps
// that id back to the save folder, and caches the scan so a tile request can
// resolve its dimension's region directory without re-walking the disk.
// ---------------------------------------------------------------------------
const REGISTRY_FILE = path.join(__dirname, 'data', 'worlds.json');
let worldRegistry = new Map();       // worldId -> worldPath
const scanCache = new Map();         // worldId -> scan result

function loadRegistry() {
  try {
    worldRegistry = new Map(Object.entries(JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'))));
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
function registerWorld(scan) {
  worldRegistry.set(scan.worldId, scan.worldPath);
  scanCache.set(scan.worldId, scan);
  saveRegistry();
}
function worldPathFor(id) {
  const p = worldRegistry.get(id);
  if (!p) throw new Error('Mondo non registrato: riaprilo dalla schermata iniziale.');
  return p;
}
/** Scan result for a world, rescanning from disk if it isn't cached yet. */
function scanFor(worldId) {
  const cached = scanCache.get(worldId);
  if (cached) return cached;
  const scan = worldScan.scanWorld(worldPathFor(worldId));
  if (!scan.ok) throw new Error(scan.error);
  scanCache.set(worldId, scan);
  return scan;
}
function dimensionFor(worldId, dimId) {
  const scan = scanFor(worldId);
  const dim = scan.dimensions.find((d) => d.id === dimId);
  if (!dim) throw new Error(`Dimensione "${dimId}" non trovata in questo mondo.`);
  return dim;
}

// Region index per dimension, built once and reused by every tile request.
const regionSets = new Map();
function regionSetFor(worldId, dim) {
  const key = `${worldId}/${dim.id}`;
  let set = regionSets.get(key);
  if (!set) {
    set = tiler.regionSetOf(dim.regions);
    regionSets.set(key, set);
  }
  return set;
}

function invalidateWorld(worldId) {
  scanCache.delete(worldId);
  for (const key of [...regionSets.keys()]) {
    if (key.startsWith(`${worldId}/`)) regionSets.delete(key);
  }
}

loadRegistry();

function fail(res, err, status = 400) {
  res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
}

/** Trim the scan down to what the browser needs (the region list can be huge). */
function publicScan(scan) {
  return {
    ok: true,
    worldId: scan.worldId,
    worldPath: scan.worldPath,
    levelName: scan.levelName,
    version: scan.version,
    dataVersion: scan.dataVersion,
    spawn: scan.spawn || null,
    dimensions: scan.dimensions.map((d) => ({
      id: d.id,
      label: d.label,
      relativeDir: d.relativeDir,
      regionCount: d.regionCount,
      bytes: d.bytes,
      bounds: d.bounds,
    })),
  };
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

/** Where Minecraft saves usually live, so the user rarely has to type a path. */
app.get('/api/world/suggestions', (req, res) => {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.minecraft', 'saves'),
    path.join(home, 'Library', 'Application Support', 'minecraft', 'saves'),
    path.join(home, 'AppData', 'Roaming', '.minecraft', 'saves'),
    path.join(home, 'curseforge', 'minecraft', 'Instances'),
    path.join(home, 'Documents', 'PrismLauncher', 'instances'),
  ];
  const worlds = [];
  for (const dir of candidates) {
    for (const w of worldScan.listNestedWorlds(dir)) {
      worlds.push(w);
      if (worlds.length >= 60) break;
    }
  }
  res.json({ savesDirs: candidates, worlds });
});

app.get('/api/world/scan', (req, res) => {
  try {
    const worldPath = req.query.path;
    if (!worldPath) throw new Error('Parametro "path" mancante');
    const scan = worldScan.scanWorld(String(worldPath));
    if (!scan.ok) return res.status(404).json(scan);
    registerWorld(scan);
    res.json(publicScan(scan));
  } catch (err) {
    fail(res, err);
  }
});

/** Point probe: what block is at this coordinate? */
app.get('/api/world/:worldId/probe', (req, res) => {
  try {
    const dim = dimensionFor(req.params.worldId, req.query.dim);
    const x = parseInt(req.query.x, 10);
    const z = parseInt(req.query.z, 10);
    if (![x, z].every(Number.isFinite)) throw new Error('Coordinate non valide');
    const g = anvil.readSurface(dim.regionDir, x, z, 1, 1);
    const missing = g.surfaceY[0] === anvil.NO_DATA;
    res.json({
      x, z,
      y: missing ? null : g.surfaceY[0],
      block: missing ? null : g.surfaceName[0],
      biome: g.biome[0],
      floorY: missing ? null : g.floorY[0],
      generated: !missing,
    });
  } catch (err) {
    fail(res, err);
  }
});

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

app.get('/api/tiles/:worldId/:dimId/:z/:x/:y.png', (req, res) => {
  const sendEmpty = (reason) => {
    res.set('Content-Type', 'image/png');
    if (reason) res.set('X-Tile-Error', String(reason).slice(0, 200));
    res.set('Cache-Control', 'no-store');
    res.status(200).send(tiler.emptyTile());
  };
  try {
    const { worldId, dimId } = req.params;
    const z = parseInt(req.params.z, 10);
    const x = parseInt(req.params.x, 10);
    const y = parseInt(req.params.y, 10);
    if (![z, x, y].every(Number.isFinite)) return sendEmpty('Coordinate tile non valide');

    const dim = dimensionFor(worldId, dimId);
    const tile = tiler.serveTile({
      regionDir: dim.regionDir,
      worldId, dimId, z, x, y,
      regionSet: regionSetFor(worldId, dim),
      renderOptions: {
        shadeStrength: req.query.shade !== undefined ? Number(req.query.shade) : 1,
        waterDepthShading: req.query.waterDepth !== '0',
      },
    });
    res.set('Content-Type', 'image/png');
    // A tile composed while the background job is still running must not be
    // cached by the browser, or the gaps would stay on screen.
    res.set('Cache-Control', tile.partial ? 'no-store' : 'no-cache');
    if (tile.partial) res.set('X-Tile-Partial', '1');
    res.send(tile.buffer);
  } catch (err) {
    sendEmpty(err.message);
  }
});

app.get('/api/tiles/:worldId/:dimId/cache-stats', (req, res) => {
  try {
    res.json({
      ...tiler.cacheStats(req.params.worldId, req.params.dimId),
      render: renderJob.completedInfo(req.params.worldId, req.params.dimId),
    });
  } catch (err) {
    fail(res, err);
  }
});

app.post('/api/tiles/:worldId/:dimId/clear-cache', (req, res) => {
  try {
    const { worldId, dimId } = req.params;
    dimensionFor(worldId, dimId); // validate
    renderJob.cancel(worldId, dimId);
    renderJob.forget(worldId, dimId);
    tiler.clearCache(worldId, dimId);
    invalidateWorld(worldId);
    res.json({ ok: true, ...tiler.cacheStats(worldId, dimId) });
  } catch (err) {
    fail(res, err);
  }
});

// ---------------------------------------------------------------------------
// Map generation (background job)
// ---------------------------------------------------------------------------

app.post('/api/render/:worldId/:dimId', (req, res) => {
  try {
    const { worldId, dimId } = req.params;
    // The save may have changed since it was scanned; re-read it so newly
    // explored regions are picked up.
    invalidateWorld(worldId);
    const dim = dimensionFor(worldId, dimId);
    const { area, force } = req.body || {};
    const status = renderJob.start({ worldId, dimension: dim, area: area || null, force: !!force });
    res.json({ ...status, dimensionBounds: dim.bounds, regionCount: dim.regionCount });
  } catch (err) {
    fail(res, err);
  }
});

app.get('/api/render/:worldId/:dimId', (req, res) => {
  try {
    res.json(renderJob.status(req.params.worldId, req.params.dimId));
  } catch (err) {
    fail(res, err);
  }
});

app.post('/api/render/:worldId/:dimId/cancel', (req, res) => {
  try {
    const stopped = renderJob.cancel(req.params.worldId, req.params.dimId);
    res.json({ ok: true, stopped });
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
