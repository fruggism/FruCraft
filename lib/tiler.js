'use strict';
/*
 * Tile pyramid renderer, in the spirit of unMINED.
 *
 * Coordinate model (matches the frontend's Leaflet CRS.Simple setup):
 *   - CRS units ARE block coordinates: lng = blockX, lat = -blockZ.
 *   - At Leaflet zoom z, 1 block = 2^z pixels. So z=0 is 1 px per block
 *     (the native/most detailed level) and negative z zooms out.
 *   - A 256x256 px tile at zoom z covers 256 * 2^-z blocks per side.
 *   - Tile (tx, ty) at zoom z covers blocks
 *       X in [tx * span, tx * span + span - 1]
 *       Z in [ty * span, ty * span + span - 1],  span = 256 * 2^-z
 *
 * Zoom 0 tiles are read from the world; every zoom below is a box-downsample
 * of its four children. Crucially, a zoomed-out tile is NEVER allowed to
 * recursively render the whole world inside one HTTP request — a single
 * zoom -6 tile spans 4096 base tiles, which would take tens of minutes. So:
 *
 *   - serving a tile only renders what is cheap (zoom 0 and -1) and otherwise
 *     composes from whatever children are already cached;
 *   - the full pyramid is produced by a background job (see renderJob.js),
 *     which reports progress and can be limited to an area.
 *
 * A tile that covers no existing region file is answered instantly as empty,
 * which is what keeps panning around a sparsely explored world fast.
 */

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const anvil = require('./anvil');
const { colorFor } = require('./blockColors');

const TILE_SIZE = 256;
const NATIVE_ZOOM = 0;
const MIN_ZOOM = -6;          // 64 blocks per pixel
const MAX_ON_DEMAND_DEPTH = 1; // zoom 0 and -1 may render while serving

const CACHE_ROOT = path.join(__dirname, '..', 'data', 'cache');

let EMPTY_TILE_BUFFER = null;
function emptyTile() {
  if (!EMPTY_TILE_BUFFER) {
    EMPTY_TILE_BUFFER = PNG.sync.write(new PNG({ width: TILE_SIZE, height: TILE_SIZE }));
  }
  return EMPTY_TILE_BUFFER;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Blocks covered by one tile side at zoom z (z <= 0). */
function blocksPerTile(z) {
  return TILE_SIZE * Math.pow(2, -z);
}

function tileCachePath(worldId, dimId, z, x, y) {
  return path.join(CACHE_ROOT, worldId, dimId, String(z), String(x), `${y}.png`);
}

function readCached(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

function writeCached(file, buffer) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buffer);
  } catch { /* the cache is best-effort; never fail a render over it */ }
}

// ---------------------------------------------------------------------------
// Region index — lets us answer "is there anything here at all?" instantly
// ---------------------------------------------------------------------------

/** Build a lookup Set from the region list produced by worldScan. */
function regionSetOf(regions) {
  const set = new Set();
  for (const r of regions) set.add(`${r.x},${r.z}`);
  return set;
}

/** True when the block box overlaps at least one region file that exists. */
function boxHasRegions(regionSet, minX, minZ, maxX, maxZ) {
  if (!regionSet || regionSet.size === 0) return true; // unknown: assume yes
  const r0x = Math.floor(minX / 512), r1x = Math.floor(maxX / 512);
  const r0z = Math.floor(minZ / 512), r1z = Math.floor(maxZ / 512);
  const spanned = (r1x - r0x + 1) * (r1z - r0z + 1);
  // Walk whichever side is smaller: the spanned rectangle or the region list.
  if (spanned <= regionSet.size) {
    for (let rz = r0z; rz <= r1z; rz++) {
      for (let rx = r0x; rx <= r1x; rx++) {
        if (regionSet.has(`${rx},${rz}`)) return true;
      }
    }
    return false;
  }
  for (const key of regionSet) {
    const c = key.indexOf(',');
    const rx = Number(key.slice(0, c));
    const rz = Number(key.slice(c + 1));
    if (rx >= r0x && rx <= r1x && rz >= r0z && rz <= r1z) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Base (zoom 0) rendering
// ---------------------------------------------------------------------------

function renderBaseTile(regionDir, tx, ty, options = {}) {
  const span = TILE_SIZE; // zoom 0 => 1 block per pixel
  const minX = tx * span;
  const minZ = ty * span;

  // Read one extra row/column north and west so the relief shading at the
  // tile edge matches its neighbour and no seam shows.
  const grid = anvil.readSurface(regionDir, minX - 1, minZ - 1, span + 1, span + 1);
  if (grid.totalChunks === 0) return { buffer: emptyTile(), empty: true };

  const gw = grid.width;
  const { surfaceY, floorY, surfaceName, biome } = grid;
  const shadeStrength = options.shadeStrength ?? 1;
  const waterDepthShading = options.waterDepthShading !== false;

  const png = new PNG({ width: TILE_SIZE, height: TILE_SIZE });
  let anyPixel = false;

  for (let py = 0; py < TILE_SIZE; py++) {
    const gy = py + 1; // skip the 1-block margin
    for (let px = 0; px < TILE_SIZE; px++) {
      const gi = gy * gw + (px + 1);
      const out = (py * TILE_SIZE + px) * 4;
      const y = surfaceY[gi];

      if (y === anvil.NO_DATA) {
        png.data[out] = 0; png.data[out + 1] = 0; png.data[out + 2] = 0; png.data[out + 3] = 0;
        continue;
      }
      anyPixel = true;

      const name = surfaceName[gi];
      let [r, g, b] = colorFor(name, biome[gi]);

      // Water: darken with depth so shorelines and rivers stay readable.
      if (waterDepthShading && anvil.WATER_NAMES.has(name)) {
        const depth = clamp(y - floorY[gi], 0, 30);
        const k = Math.min(0.62, depth * 0.03);
        r = Math.round(r * (1 - k * 0.75));
        g = Math.round(g * (1 - k * 0.75));
        b = Math.round(b * (1 - k * 0.55));
      }

      // Relief shading from the north/west height difference.
      const yN = surfaceY[gi - gw];
      const yW = surfaceY[gi - 1];
      const slope = y - ((yN === anvil.NO_DATA ? y : yN) + (yW === anvil.NO_DATA ? y : yW)) / 2;
      const f = 1 + clamp(slope * 0.05, -0.5, 0.5) * shadeStrength;

      png.data[out] = clamp(Math.round(r * f), 0, 255);
      png.data[out + 1] = clamp(Math.round(g * f), 0, 255);
      png.data[out + 2] = clamp(Math.round(b * f), 0, 255);
      png.data[out + 3] = 255;
    }
  }

  if (!anyPixel) return { buffer: emptyTile(), empty: true };
  return { buffer: PNG.sync.write(png), empty: false };
}

// ---------------------------------------------------------------------------
// Pyramid: box-downsample of four children
// ---------------------------------------------------------------------------

function downsampleChildren(children) {
  if (children.every((c) => !c)) return { buffer: emptyTile(), empty: true };

  const half = TILE_SIZE / 2;
  const out = new PNG({ width: TILE_SIZE, height: TILE_SIZE });

  const place = (child, offX, offY) => {
    if (!child) return;
    for (let dy = 0; dy < half; dy++) {
      for (let dx = 0; dx < half; dx++) {
        const sx = dx * 2;
        const sy = dy * 2;
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let k = 0; k < 4; k++) {
          const si = ((sy + (k >> 1)) * TILE_SIZE + (sx + (k & 1))) * 4;
          const sa = child.data[si + 3];
          if (sa === 0) continue;
          r += child.data[si]; g += child.data[si + 1]; b += child.data[si + 2]; a += sa;
          n++;
        }
        const di = ((dy + offY) * TILE_SIZE + (dx + offX)) * 4;
        if (n === 0) {
          out.data[di] = 0; out.data[di + 1] = 0; out.data[di + 2] = 0; out.data[di + 3] = 0;
        } else {
          out.data[di] = Math.round(r / n);
          out.data[di + 1] = Math.round(g / n);
          out.data[di + 2] = Math.round(b / n);
          // Partial coverage stays partial, so coastlines fade instead of growing.
          out.data[di + 3] = Math.round(a / 4);
        }
      }
    }
  };

  place(children[0], 0, 0);
  place(children[1], half, 0);
  place(children[2], 0, half);
  place(children[3], half, half);

  return { buffer: PNG.sync.write(out), empty: false };
}

function decodeOrNull(buffer) {
  try {
    return PNG.sync.read(buffer);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get a tile PNG.
 *
 * opts:
 *   regionDir, worldId, dimId, z, x, y
 *   regionSet       optional Set("rx,rz") of regions that exist
 *   allowRender     true only for the background builder: permits rendering
 *                   the whole subtree. When false (serving a request) only
 *                   cheap depths render and the rest composes from cache.
 *   useCache        default true
 *
 * Returns { buffer, cached, empty, partial }.
 *   partial = the tile was composed while some children were still missing,
 *   so it must not be written to the cache as if it were final.
 */
function getTile(opts) {
  const {
    regionDir, worldId, dimId, z, x, y,
    regionSet = null, allowRender = false, useCache = true, renderOptions = {},
  } = opts;

  if (z > NATIVE_ZOOM || z < MIN_ZOOM) {
    return { buffer: emptyTile(), cached: false, empty: true, partial: false };
  }

  // Nothing generated here at all: answer instantly, without touching disk.
  const span = blocksPerTile(z);
  const minX = x * span;
  const minZ = y * span;
  if (!boxHasRegions(regionSet, minX, minZ, minX + span - 1, minZ + span - 1)) {
    return { buffer: emptyTile(), cached: false, empty: true, partial: false };
  }

  const cacheFile = worldId && dimId ? tileCachePath(worldId, dimId, z, x, y) : null;
  if (useCache && cacheFile) {
    const hit = readCached(cacheFile);
    if (hit) return { buffer: hit, cached: true, empty: false, partial: false };
  }

  if (z === NATIVE_ZOOM) {
    const result = renderBaseTile(regionDir, x, y, renderOptions);
    if (useCache && cacheFile) writeCached(cacheFile, result.buffer);
    return { ...result, cached: false, partial: false };
  }

  // Below native zoom: compose from the four children.
  const depth = -z;
  const mayRenderChildren = allowRender || depth <= MAX_ON_DEMAND_DEPTH;
  let partial = false;
  const children = [[x * 2, y * 2], [x * 2 + 1, y * 2], [x * 2, y * 2 + 1], [x * 2 + 1, y * 2 + 1]]
    .map(([kx, ky]) => {
      const child = getTile({ ...opts, z: z + 1, x: kx, y: ky, allowRender });
      if (child.empty) return null;
      if (child.partial) partial = true;
      return decodeOrNull(child.buffer);
    });

  if (!mayRenderChildren) {
    // We only looked at the cache above; anything missing makes this partial.
    // (getTile above still returns cached children, which is exactly what we
    // want: the map fills in as the background job progresses.)
    partial = partial || children.some((c) => c === null);
  }

  const result = downsampleChildren(children);
  // A partial composite must not be cached, or it would freeze the gaps in.
  if (useCache && cacheFile && !partial) writeCached(cacheFile, result.buffer);
  return { ...result, cached: false, partial };
}

/** Serve-time wrapper: never allows an expensive deep render. */
function serveTile(opts) {
  const depth = -opts.z;
  if (depth > MAX_ON_DEMAND_DEPTH) {
    return getTileFromCacheOnly(opts);
  }
  return getTile({ ...opts, allowRender: false });
}

/** Compose a zoomed-out tile purely from already-cached children. */
function getTileFromCacheOnly(opts) {
  const { worldId, dimId, z, x, y, regionSet } = opts;
  if (z > NATIVE_ZOOM || z < MIN_ZOOM) {
    return { buffer: emptyTile(), cached: false, empty: true, partial: false };
  }
  const span = blocksPerTile(z);
  if (!boxHasRegions(regionSet, x * span, y * span, x * span + span - 1, y * span + span - 1)) {
    return { buffer: emptyTile(), cached: false, empty: true, partial: false };
  }
  const hit = readCached(tileCachePath(worldId, dimId, z, x, y));
  if (hit) return { buffer: hit, cached: true, empty: false, partial: false };

  // Not built yet: show whatever finer detail already exists, without
  // rendering anything new, so the view is never blank for no reason.
  const children = [[x * 2, y * 2], [x * 2 + 1, y * 2], [x * 2, y * 2 + 1], [x * 2 + 1, y * 2 + 1]]
    .map(([kx, ky]) => {
      const child = getTileFromCacheOnly({ ...opts, z: z + 1, x: kx, y: ky });
      return child.empty ? null : decodeOrNull(child.buffer);
    });
  const result = downsampleChildren(children);
  return { ...result, cached: false, partial: true };
}

function clearCache(worldId, dimId) {
  const dir = dimId ? path.join(CACHE_ROOT, worldId, dimId) : path.join(CACHE_ROOT, worldId);
  fs.rmSync(dir, { recursive: true, force: true });
  anvil.clearRegionCache();
}

function cacheStats(worldId, dimId) {
  const dir = dimId ? path.join(CACHE_ROOT, worldId, dimId) : path.join(CACHE_ROOT, worldId);
  let files = 0, bytes = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { files++; try { bytes += fs.statSync(p).size; } catch { /* ignore */ } }
    }
  };
  walk(dir);
  return { files, bytes };
}

module.exports = {
  TILE_SIZE, NATIVE_ZOOM, MIN_ZOOM, MAX_ON_DEMAND_DEPTH, CACHE_ROOT,
  getTile, serveTile, getTileFromCacheOnly, renderBaseTile, downsampleChildren,
  clearCache, cacheStats, blocksPerTile, tileCachePath,
  regionSetOf, boxHasRegions, emptyTile,
};
