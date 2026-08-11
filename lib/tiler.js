'use strict';
/*
 * Tile pyramid renderer, in the spirit of unMINED.
 *
 * Coordinate model (matches the frontend's Leaflet CRS.Simple setup):
 *   - CRS units ARE block coordinates: lng = blockX, lat = -blockZ.
 *   - At Leaflet zoom z, 1 block = 2^z pixels. So z=0 is 1 px per block
 *     (the native/most detailed level) and negative z zooms out.
 *   - A 256x256 px tile at zoom z therefore covers 256 * 2^-z blocks per side.
 *   - Tile (tx, ty) at zoom z covers blocks
 *       X in [tx * span, tx * span + span - 1]
 *       Z in [ty * span, ty * span + span - 1],  span = 256 * 2^-z
 *
 * Zoom 0 tiles are rendered from the world's region files. Every zoom below 0
 * is built by box-downsampling its four children, so a low zoom never has to
 * read a huge block area directly. Tiles are cached as PNGs on disk.
 */

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const anvil = require('./anvil');
const { colorFor } = require('./blockColors');

const TILE_SIZE = 256;
const NATIVE_ZOOM = 0;
const MIN_ZOOM = -6; // 64 blocks per pixel: a 32k x 32k world fits in ~1 screen

const CACHE_ROOT = path.join(__dirname, '..', 'data', 'cache');

// A single shared, fully transparent tile for areas with no chunk data.
let EMPTY_TILE_BUFFER = null;
function emptyTile() {
  if (!EMPTY_TILE_BUFFER) {
    EMPTY_TILE_BUFFER = PNG.sync.write(new PNG({ width: TILE_SIZE, height: TILE_SIZE }));
  }
  return EMPTY_TILE_BUFFER;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function blocksPerTile(z) {
  return TILE_SIZE * Math.pow(2, -z); // z <= 0
}

function tileCachePath(worldId, dimension, z, x, y) {
  return path.join(CACHE_ROOT, worldId, dimension, String(z), String(x), `${y}.png`);
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
  } catch {
    /* cache is best-effort; a failure here must not break the response */
  }
}

// ---------------------------------------------------------------------------
// Base (zoom 0) rendering
// ---------------------------------------------------------------------------

/**
 * Shading model: compare each column's height with its north and west
 * neighbours to get a relief slope, and darken water by how deep it is.
 * This is what gives the map its "3D-ish" embossed look.
 */
function renderBaseTile(worldPath, dimension, tx, ty, options) {
  const span = TILE_SIZE; // zoom 0 => 1 block per pixel
  const minX = tx * span;
  const minZ = ty * span;

  // Read one extra row/column to the north and west so shading at the tile
  // edge matches the neighbouring tile (no visible seams).
  const grid = anvil.readSurface(worldPath, dimension, minX - 1, minZ - 1, span + 1, span + 1);
  if (grid.totalChunks === 0) return { buffer: emptyTile(), empty: true };

  const gw = grid.width;
  const { surfaceY, floorY, surfaceName, biome } = grid;
  const shadeStrength = options.shadeStrength ?? 1;
  const waterDepthShading = options.waterDepthShading !== false;

  const png = new PNG({ width: TILE_SIZE, height: TILE_SIZE });
  let anyPixel = false;

  for (let py = 0; py < TILE_SIZE; py++) {
    const gy = py + 1; // offset by the 1-block margin
    for (let px = 0; px < TILE_SIZE; px++) {
      const gx = px + 1;
      const gi = gy * gw + gx;
      const out = (py * TILE_SIZE + px) * 4;
      const y = surfaceY[gi];

      if (y === anvil.NO_DATA) {
        png.data[out] = 0; png.data[out + 1] = 0; png.data[out + 2] = 0; png.data[out + 3] = 0;
        continue;
      }
      anyPixel = true;

      const name = surfaceName[gi];
      const bio = biome[gi];
      let [r, g, b] = colorFor(name, bio);

      // Water: darken with depth and blend a little of the bottom through,
      // so shorelines and shallow rivers stay readable.
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
      const refN = yN === anvil.NO_DATA ? y : yN;
      const refW = yW === anvil.NO_DATA ? y : yW;
      const slope = y - (refN + refW) / 2;
      const shade = clamp(slope * 0.05, -0.5, 0.5) * shadeStrength;
      const f = 1 + shade;

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
// Pyramid (zoom < 0) via box downsampling of the four children
// ---------------------------------------------------------------------------

function downsampleChildren(children) {
  // children: [tl, tr, bl, br], each a decoded PNG or null
  if (children.every((c) => !c)) return { buffer: emptyTile(), empty: true };

  const half = TILE_SIZE / 2;
  const out = new PNG({ width: TILE_SIZE, height: TILE_SIZE });

  const place = (child, offX, offY) => {
    if (!child) return;
    // Average each 2x2 source block into one destination pixel.
    for (let dy = 0; dy < half; dy++) {
      for (let dx = 0; dx < half; dx++) {
        const sx = dx * 2;
        const sy = dy * 2;
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let k = 0; k < 4; k++) {
          const kx = sx + (k & 1);
          const ky = sy + (k >> 1);
          const si = (ky * TILE_SIZE + kx) * 4;
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
          // Keep partial coverage honest: a 2x2 with 2 opaque source pixels
          // becomes half-transparent, which is what makes coastlines fade
          // smoothly instead of growing.
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get a tile PNG buffer, rendering (and caching) it if needed.
 * Returns { buffer, cached, empty }.
 */
function getTile(opts) {
  const { worldPath, worldId, dimension, z, x, y, useCache = true, renderOptions = {} } = opts;

  if (z > NATIVE_ZOOM || z < MIN_ZOOM) {
    return { buffer: emptyTile(), cached: false, empty: true };
  }

  const cacheFile = tileCachePath(worldId, dimension, z, x, y);
  if (useCache) {
    const hit = readCached(cacheFile);
    if (hit) return { buffer: hit, cached: true, empty: false };
  }

  let result;
  if (z === NATIVE_ZOOM) {
    result = renderBaseTile(worldPath, dimension, x, y, renderOptions);
  } else {
    const childZ = z + 1;
    const cx = x * 2;
    const cy = y * 2;
    const children = [[cx, cy], [cx + 1, cy], [cx, cy + 1], [cx + 1, cy + 1]].map(([kx, ky]) => {
      const child = getTile({ ...opts, z: childZ, x: kx, y: ky });
      if (child.empty) return null;
      try {
        return PNG.sync.read(child.buffer);
      } catch {
        return null;
      }
    });
    result = downsampleChildren(children);
  }

  // Empty tiles are cached too — that's what stops us re-scanning ungenerated
  // areas of the world on every pan.
  if (useCache) writeCached(cacheFile, result.buffer);
  return { buffer: result.buffer, cached: false, empty: result.empty };
}

/** Delete a world's cached tiles (all dimensions, or just one). */
function clearCache(worldId, dimension) {
  const dir = dimension
    ? path.join(CACHE_ROOT, worldId, dimension)
    : path.join(CACHE_ROOT, worldId);
  fs.rmSync(dir, { recursive: true, force: true });
  anvil.clearRegionCache();
}

function cacheStats(worldId) {
  const dir = path.join(CACHE_ROOT, worldId);
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

/** Tile range covering a block bounding box at a given zoom. */
function tileRangeFor(bounds, z) {
  const span = blocksPerTile(z);
  return {
    minTX: Math.floor(bounds.minX / span),
    maxTX: Math.floor(bounds.maxX / span),
    minTY: Math.floor(bounds.minZ / span),
    maxTY: Math.floor(bounds.maxZ / span),
  };
}

module.exports = {
  TILE_SIZE, NATIVE_ZOOM, MIN_ZOOM, CACHE_ROOT,
  getTile, clearCache, cacheStats, blocksPerTile, tileRangeFor, tileCachePath,
};
