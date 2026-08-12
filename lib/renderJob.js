'use strict';
/*
 * Background map generation.
 *
 * Rendering a whole world is minutes of CPU work, so it can't happen inside a
 * tile request. This module runs it as a job: base tiles first (only where
 * region files actually exist), then each pyramid level by downsampling the
 * level above. Progress is reported so the UI can show a bar, and the job
 * yields to the event loop between tiles so the server stays responsive.
 *
 * The job can be limited to an area, which is what makes a big world usable:
 * you generally only care about the part you have built in.
 */

const fs = require('fs');
const path = require('path');
const tiler = require('./tiler');

const jobs = new Map(); // `${worldId}/${dimId}` -> job

const keyOf = (worldId, dimId) => `${worldId}/${dimId}`;

function markerPath(worldId, dimId) {
  return path.join(tiler.CACHE_ROOT, worldId, dimId, 'render.json');
}

function readMarker(worldId, dimId) {
  try {
    return JSON.parse(fs.readFileSync(markerPath(worldId, dimId), 'utf8'));
  } catch {
    return null;
  }
}

function writeMarker(worldId, dimId, data) {
  try {
    fs.mkdirSync(path.dirname(markerPath(worldId, dimId)), { recursive: true });
    fs.writeFileSync(markerPath(worldId, dimId), JSON.stringify(data, null, 2));
  } catch { /* best effort */ }
}

/** Clip a bounding box to the area that actually has region files. */
function effectiveBounds(dimension, area) {
  const b = dimension.bounds;
  if (!area) return { ...b };
  return {
    minX: Math.max(b.minX, Math.floor(area.minX)),
    minZ: Math.max(b.minZ, Math.floor(area.minZ)),
    maxX: Math.min(b.maxX, Math.ceil(area.maxX)),
    maxZ: Math.min(b.maxZ, Math.ceil(area.maxZ)),
  };
}

/** Base tiles to render: the 2x2 tiles of every region inside the bounds. */
function baseTilesFor(dimension, bounds) {
  const out = [];
  for (const r of dimension.regions) {
    const rMinX = r.x * 512, rMinZ = r.z * 512;
    if (rMinX + 511 < bounds.minX || rMinX > bounds.maxX) continue;
    if (rMinZ + 511 < bounds.minZ || rMinZ > bounds.maxZ) continue;
    const tx0 = rMinX / 256, tz0 = rMinZ / 256;
    for (let dz = 0; dz < 2; dz++) {
      for (let dx = 0; dx < 2; dx++) {
        const tx = tx0 + dx, ty = tz0 + dz;
        // Skip tiles fully outside the requested area.
        if (tx * 256 + 255 < bounds.minX || tx * 256 > bounds.maxX) continue;
        if (ty * 256 + 255 < bounds.minZ || ty * 256 > bounds.maxZ) continue;
        out.push([tx, ty]);
      }
    }
  }
  return out;
}

/** Tiles of one zoom level covering the bounds. */
function tilesForZoom(z, bounds) {
  const span = tiler.blocksPerTile(z);
  const out = [];
  const t0x = Math.floor(bounds.minX / span), t1x = Math.floor(bounds.maxX / span);
  const t0y = Math.floor(bounds.minZ / span), t1y = Math.floor(bounds.maxZ / span);
  for (let ty = t0y; ty <= t1y; ty++) {
    for (let tx = t0x; tx <= t1x; tx++) out.push([tx, ty]);
  }
  return out;
}

function statusOf(job) {
  if (!job) return null;
  const elapsed = Date.now() - job.startedAt;
  const rate = job.done > 0 ? elapsed / job.done : 0;
  return {
    state: job.state,
    phase: job.phase,
    done: job.done,
    total: job.total,
    percent: job.total ? Math.round((job.done / job.total) * 100) : 0,
    elapsedMs: elapsed,
    etaMs: job.done > 0 && job.state === 'running' ? Math.round(rate * (job.total - job.done)) : null,
    error: job.error || null,
    bounds: job.bounds,
  };
}

/**
 * Start (or return the already-running) render job for one dimension.
 *   dimension: entry from worldScan (regionDir, regions, bounds)
 *   area:      optional { minX, minZ, maxX, maxZ } to limit the work
 */
function start({ worldId, dimension, area, renderOptions = {}, force = false }) {
  const key = keyOf(worldId, dimension.id);
  const existing = jobs.get(key);
  if (existing && existing.state === 'running') return statusOf(existing);

  const bounds = effectiveBounds(dimension, area);
  if (bounds.minX > bounds.maxX || bounds.minZ > bounds.maxZ) {
    throw new Error("L'area richiesta non contiene nessuna parte generata del mondo.");
  }

  const regionSet = tiler.regionSetOf(dimension.regions);
  const baseTiles = baseTilesFor(dimension, bounds);
  const levels = [];
  for (let z = -1; z >= tiler.MIN_ZOOM; z--) levels.push({ z, tiles: tilesForZoom(z, bounds) });

  const total = baseTiles.length + levels.reduce((n, l) => n + l.tiles.length, 0);

  const job = {
    worldId,
    dimId: dimension.id,
    regionDir: dimension.regionDir,
    regionSet,
    renderOptions,
    bounds,
    state: 'running',
    phase: 'Mappa di dettaglio',
    done: 0,
    total,
    startedAt: Date.now(),
    cancelled: false,
    error: null,
  };
  jobs.set(key, job);

  if (force) tiler.clearCache(worldId, dimension.id);

  // Work through the queue in small slices, yielding between them so tile
  // requests and the progress endpoint keep answering.
  const queue = [
    ...baseTiles.map(([x, y]) => ({ z: 0, x, y, phase: 'Mappa di dettaglio' })),
    ...levels.flatMap((l) => l.tiles.map(([x, y]) => ({ z: l.z, x, y, phase: `Livello di zoom ${l.z}` }))),
  ];

  let i = 0;
  const SLICE = 4; // tiles per turn of the event loop

  const step = () => {
    if (job.cancelled) {
      job.state = 'cancelled';
      return;
    }
    const until = Math.min(i + SLICE, queue.length);
    try {
      for (; i < until; i++) {
        const t = queue[i];
        job.phase = t.phase;
        tiler.getTile({
          regionDir: job.regionDir,
          worldId: job.worldId,
          dimId: job.dimId,
          regionSet: job.regionSet,
          z: t.z, x: t.x, y: t.y,
          allowRender: true,
          renderOptions: job.renderOptions,
        });
        job.done++;
      }
    } catch (err) {
      job.state = 'error';
      job.error = err.message;
      return;
    }
    if (i >= queue.length) {
      job.state = 'done';
      job.phase = 'Completata';
      writeMarker(job.worldId, job.dimId, {
        completedAt: new Date().toISOString(),
        regionCount: dimension.regions.length,
        bounds: job.bounds,
        tiles: job.total,
      });
      return;
    }
    setImmediate(step);
  };
  setImmediate(step);

  return statusOf(job);
}

function status(worldId, dimId) {
  const job = jobs.get(keyOf(worldId, dimId));
  if (job) return statusOf(job);
  const marker = readMarker(worldId, dimId);
  if (marker) {
    return {
      state: 'done', phase: 'Completata', done: marker.tiles || 0, total: marker.tiles || 0,
      percent: 100, elapsedMs: 0, etaMs: null, error: null,
      bounds: marker.bounds, completedAt: marker.completedAt,
    };
  }
  return { state: 'idle', phase: null, done: 0, total: 0, percent: 0, elapsedMs: 0, etaMs: null, error: null };
}

function cancel(worldId, dimId) {
  const job = jobs.get(keyOf(worldId, dimId));
  if (job && job.state === 'running') {
    job.cancelled = true;
    return true;
  }
  return false;
}

/** Has this dimension been rendered before (and for which area)? */
function completedInfo(worldId, dimId) {
  return readMarker(worldId, dimId);
}

function forget(worldId, dimId) {
  jobs.delete(keyOf(worldId, dimId));
}

module.exports = { start, status, cancel, completedInfo, forget, baseTilesFor, tilesForZoom, effectiveBounds };
