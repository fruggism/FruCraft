/*
 * The map engine, off the UI thread.
 *
 * Everything that reads the save and paints tiles happens here: parsing a
 * region is hundreds of milliseconds of work, and doing it on the main thread
 * would freeze panning and drawing. The page talks to this worker with small
 * request/response messages, and gets tiles back as ImageBitmaps, which are
 * transferred rather than copied.
 */

import { FileMapSource, DirectoryHandleSource } from './core/source.js';
import * as worldScan from './core/worldScan.js';
import * as tiler from './core/tiler.js';
import * as anvil from './core/anvil.js';
import { runRender } from './core/renderJob.js';
import { idbGet, idbPut, idbDeletePrefix, idbStatsPrefix } from './app/db.js';

let source = null;
let scan = null;
const regionSets = new Map();   // dimId -> Set("rx,rz")
const caches = new Map();       // dimId -> TileCache
let cancelRequested = false;
let rendering = false;

// ---------------------------------------------------------------------------
// Tile cache
//
// Tiles are kept as WebP blobs rather than raw pixels: a 256x256 RGBA tile is
// 256 KB, so a few thousand of them would blow through the origin's storage
// quota, while the same tile as WebP is typically 10-30 KB.
// ---------------------------------------------------------------------------

const canEncode = typeof OffscreenCanvas !== 'undefined';

class TileCache {
  constructor(worldKey, dimId) {
    this.prefix = `${worldKey}|${dimId}|`;
    this.memory = new Map();      // recently used tiles, as rgba
    this.memoryLimit = 64;
  }

  key(z, x, y) { return `${this.prefix}${z}/${x}/${y}`; }

  remember(k, rgba) {
    this.memory.set(k, rgba);
    if (this.memory.size > this.memoryLimit) {
      this.memory.delete(this.memory.keys().next().value);
    }
  }

  async get(z, x, y) {
    const k = this.key(z, x, y);
    const hot = this.memory.get(k);
    if (hot) return hot;
    let blob;
    try {
      blob = await idbGet('tiles', k);
    } catch {
      return null;
    }
    if (!blob) return null;
    const rgba = await blobToRgba(blob);
    if (rgba) this.remember(k, rgba);
    return rgba;
  }

  async set(z, x, y, rgba) {
    const k = this.key(z, x, y);
    this.remember(k, rgba);
    if (!canEncode) return;
    try {
      await idbPut('tiles', await rgbaToBlob(rgba), k);
    } catch {
      // Out of quota, or private-mode storage: the map still works, it just
      // has to re-render after a reload.
    }
  }

  clearMemory() { this.memory.clear(); }
}

let scratch = null;
function scratchCanvas() {
  if (!scratch) scratch = new OffscreenCanvas(tiler.TILE_SIZE, tiler.TILE_SIZE);
  return scratch;
}

async function rgbaToBlob(rgba) {
  const canvas = scratchCanvas();
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), tiler.TILE_SIZE, tiler.TILE_SIZE), 0, 0);
  return canvas.convertToBlob({ type: 'image/webp', quality: 0.9 });
}

async function blobToRgba(blob) {
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = scratchCanvas();
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, tiler.TILE_SIZE, tiler.TILE_SIZE);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return ctx.getImageData(0, 0, tiler.TILE_SIZE, tiler.TILE_SIZE).data;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------

function dimensionById(dimId) {
  if (!scan || !scan.ok) throw new Error('Nessun mondo aperto');
  const dim = scan.dimensions.find((d) => d.id === dimId);
  if (!dim) throw new Error(`Dimensione "${dimId}" non trovata`);
  return dim;
}

function contextFor(dimId, renderOptions = {}) {
  const dim = dimensionById(dimId);
  if (!regionSets.has(dimId)) regionSets.set(dimId, tiler.regionSetOf(dim.regions));
  if (!caches.has(dimId)) caches.set(dimId, new TileCache(scan.worldKey, dimId));
  return {
    source,
    regionDir: dim.regionDir,
    regionSet: regionSets.get(dimId),
    cache: caches.get(dimId),
    renderOptions,
  };
}

/** Strip the region list before sending a scan to the page: a big world has
 *  tens of thousands of entries and the UI never needs them. */
function publicScan(s) {
  if (!s.ok) return s;
  return {
    ok: true,
    worldKey: s.worldKey,
    levelName: s.levelName,
    version: s.version || null,
    dataVersion: s.dataVersion || null,
    spawn: s.spawn || null,
    dimensions: s.dimensions.map((d) => ({
      id: d.id,
      label: d.label,
      relativeDir: d.relativeDir,
      regionCount: d.regionCount,
      bytes: d.bytes,
      bounds: d.bounds,
    })),
  };
}

const metaKey = (dimId) => `render|${scan.worldKey}|${dimId}`;

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

const handlers = {
  async openWorld({ init }) {
    if (init.kind === 'files') source = new FileMapSource(init.files, init.name);
    else source = new DirectoryHandleSource(init.handle);
    regionSets.clear();
    caches.clear();
    anvil.clearRegionCache();
    scan = await worldScan.scanWorld(source);
    return publicScan(scan);
  },

  async tile({ dimId, z, x, y }) {
    const ctx = contextFor(dimId);
    const result = await tiler.serveTile(ctx, z, x, y);
    if (result.empty) return { empty: true, partial: !!result.partial };
    const bitmap = await createImageBitmap(
      new ImageData(new Uint8ClampedArray(result.rgba), tiler.TILE_SIZE, tiler.TILE_SIZE));
    return { empty: false, partial: !!result.partial, bitmap, transfer: [bitmap] };
  },

  async probe({ dimId, x, z }) {
    const dim = dimensionById(dimId);
    const g = await anvil.readSurface(source, dim.regionDir, x, z, 1, 1);
    const missing = g.surfaceY[0] === anvil.NO_DATA;
    return {
      x, z,
      y: missing ? null : g.surfaceY[0],
      block: missing ? null : g.surfaceName[0],
      biome: g.biome[0],
      generated: !missing,
    };
  },

  async renderStatus({ dimId }) {
    if (rendering) return { state: 'running' };
    let meta = null;
    try { meta = await idbGet('meta', metaKey(dimId)); } catch { /* no storage */ }
    if (meta) return { state: 'done', ...meta };
    return { state: 'idle' };
  },

  async cancelRender() {
    cancelRequested = true;
    return { ok: true };
  },

  async clearCache({ dimId }) {
    const cache = caches.get(dimId);
    if (cache) cache.clearMemory();
    anvil.clearRegionCache();
    let removed = 0;
    try {
      removed = await idbDeletePrefix('tiles', `${scan.worldKey}|${dimId}|`);
      await idbPut('meta', null, metaKey(dimId));
    } catch { /* nothing cached */ }
    return { removed };
  },

  async cacheStats({ dimId }) {
    try {
      return await idbStatsPrefix('tiles', `${scan.worldKey}|${dimId}|`);
    } catch {
      return { files: 0, bytes: 0 };
    }
  },

  async render({ dimId, area, requestId }) {
    if (rendering) throw new Error('Una generazione è già in corso');
    rendering = true;
    cancelRequested = false;
    const dim = dimensionById(dimId);
    const ctx = contextFor(dimId);
    try {
      const result = await runRender({
        ctx,
        dimension: dim,
        area,
        onProgress: (p) => postMessage({ type: 'progress', requestId, progress: p }),
        shouldStop: () => cancelRequested,
      });
      if (result.state === 'done') {
        try {
          await idbPut('meta', {
            completedAt: new Date().toISOString(),
            bounds: result.bounds,
            tiles: result.total,
            regionCount: dim.regionCount,
          }, metaKey(dimId));
        } catch { /* storage unavailable: the map is still rendered in memory */ }
      }
      return result;
    } finally {
      rendering = false;
    }
  },
};

self.onmessage = async (event) => {
  const { id, type, payload } = event.data || {};
  const handler = handlers[type];
  if (!handler) {
    postMessage({ id, error: `Richiesta sconosciuta: ${type}` });
    return;
  }
  try {
    const result = await handler({ ...payload, requestId: id });
    const transfer = result && result.transfer;
    if (transfer) delete result.transfer;
    postMessage({ id, result }, transfer || []);
  } catch (err) {
    postMessage({ id, error: err && err.message ? err.message : String(err) });
  }
};

postMessage({ type: 'ready' });
