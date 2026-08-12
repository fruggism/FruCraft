/*
 * Background map generation.
 *
 * Rendering a whole world is minutes of work, so it can't happen while a tile
 * is being requested. This drives it as a job: base tiles first (only where
 * region files exist), then each pyramid level by downsampling the one above,
 * reporting progress as it goes. The job yields between tiles so the worker
 * keeps answering tile requests while it runs.
 *
 * The area can be limited, which is what makes a large world usable: you
 * generally only care about the part you have built in.
 */

import { getTile, blocksPerTile, MIN_ZOOM } from './tiler.js';

/** Clip a requested area to the part of the world that has region files. */
export function effectiveBounds(dimension, area) {
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
export function baseTilesFor(dimension, bounds) {
  const out = [];
  for (const r of dimension.regions) {
    const rMinX = r.x * 512, rMinZ = r.z * 512;
    if (rMinX + 511 < bounds.minX || rMinX > bounds.maxX) continue;
    if (rMinZ + 511 < bounds.minZ || rMinZ > bounds.maxZ) continue;
    const tx0 = rMinX / 256, tz0 = rMinZ / 256;
    for (let dz = 0; dz < 2; dz++) {
      for (let dx = 0; dx < 2; dx++) {
        const tx = tx0 + dx, ty = tz0 + dz;
        if (tx * 256 + 255 < bounds.minX || tx * 256 > bounds.maxX) continue;
        if (ty * 256 + 255 < bounds.minZ || ty * 256 > bounds.maxZ) continue;
        out.push([tx, ty]);
      }
    }
  }
  return out;
}

/** Tiles of one zoom level covering the bounds. */
export function tilesForZoom(z, bounds) {
  const span = blocksPerTile(z);
  const out = [];
  const t0x = Math.floor(bounds.minX / span), t1x = Math.floor(bounds.maxX / span);
  const t0y = Math.floor(bounds.minZ / span), t1y = Math.floor(bounds.maxZ / span);
  for (let ty = t0y; ty <= t1y; ty++) {
    for (let tx = t0x; tx <= t1x; tx++) out.push([tx, ty]);
  }
  return out;
}

/** The full queue of tiles a render has to produce, in dependency order. */
export function buildQueue(dimension, bounds) {
  const queue = baseTilesFor(dimension, bounds)
    .map(([x, y]) => ({ z: 0, x, y, phase: 'Mappa di dettaglio' }));
  for (let z = -1; z >= MIN_ZOOM; z--) {
    for (const [x, y] of tilesForZoom(z, bounds)) {
      queue.push({ z, x, y, phase: `Livello di zoom ${z}` });
    }
  }
  return queue;
}

/**
 * Run a render.
 *
 * ctx      tile context ({ source, regionDir, regionSet, cache, ... })
 * onProgress({ done, total, phase }) is called as work completes
 * shouldStop() lets the caller cancel between tiles
 */
export async function runRender({ ctx, dimension, area, onProgress, shouldStop }) {
  const bounds = effectiveBounds(dimension, area);
  if (bounds.minX > bounds.maxX || bounds.minZ > bounds.maxZ) {
    throw new Error("L'area richiesta non contiene nessuna parte generata del mondo.");
  }

  const queue = buildQueue(dimension, bounds);
  const total = queue.length;
  let done = 0;
  let lastPhase = '';

  for (const t of queue) {
    if (shouldStop && shouldStop()) {
      return { state: 'cancelled', done, total, bounds };
    }
    await getTile(ctx, t.z, t.x, t.y, true);
    done++;
    if (onProgress && (done % 2 === 0 || done === total || t.phase !== lastPhase)) {
      lastPhase = t.phase;
      onProgress({ done, total, phase: t.phase, bounds });
    }
  }
  return { state: 'done', done, total, bounds };
}
