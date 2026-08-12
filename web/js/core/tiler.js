/*
 * Tile pyramid renderer, in the spirit of unMINED.
 *
 * Coordinate model (matches the Leaflet CRS.Simple setup in the UI):
 *   - CRS units ARE block coordinates: lng = blockX, lat = -blockZ.
 *   - At zoom z one block is 2^z pixels, so z=0 is one pixel per block and
 *     negative zooms are zoomed out.
 *   - A 256x256 tile at zoom z covers 256 * 2^-z blocks per side.
 *
 * Tiles are produced as raw RGBA (Uint8ClampedArray, 256*256*4). Turning that
 * into something drawable is the caller's job — a canvas in the browser — so
 * this module has no rendering dependency and runs in the test suite too.
 *
 * A zoomed-out tile is NEVER allowed to recursively render the whole world:
 * one zoom -6 tile spans 4096 base tiles, tens of minutes of work, which in
 * practice means a map that never appears. Serving renders only what is cheap
 * and composes the rest from cache; the full pyramid is built by a background
 * job that reports progress.
 */

import { readSurface, NO_DATA, WATER_NAMES } from './anvil.js';
import { colorFor } from './blockColors.js';

export const TILE_SIZE = 256;
export const NATIVE_ZOOM = 0;
export const MIN_ZOOM = -6;              // 64 blocks per pixel
export const MAX_ON_DEMAND_DEPTH = 1;    // zoom 0 and -1 may render while serving

const PIXELS = TILE_SIZE * TILE_SIZE * 4;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const blocksPerTile = (z) => TILE_SIZE * Math.pow(2, -z);

export function emptyTile() {
  return new Uint8ClampedArray(PIXELS);
}

// ---------------------------------------------------------------------------
// Region index — answers "is there anything here at all?" without disk access
// ---------------------------------------------------------------------------

export function regionSetOf(regions) {
  const set = new Set();
  for (const r of regions) set.add(`${r.x},${r.z}`);
  return set;
}

export function boxHasRegions(regionSet, minX, minZ, maxX, maxZ) {
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

export async function renderBaseTile(source, regionDir, tx, ty, options = {}) {
  const span = TILE_SIZE; // zoom 0 => one block per pixel
  const minX = tx * span;
  const minZ = ty * span;

  // Read one extra row/column to the north and west so the relief shading at
  // the tile edge matches its neighbour and no seam shows.
  const grid = await readSurface(source, regionDir, minX - 1, minZ - 1, span + 1, span + 1);
  if (grid.totalChunks === 0) return { rgba: emptyTile(), empty: true };

  const gw = grid.width;
  const { surfaceY, floorY, surfaceName, biome } = grid;
  const shadeStrength = options.shadeStrength ?? 1;
  const waterDepthShading = options.waterDepthShading !== false;

  const rgba = new Uint8ClampedArray(PIXELS);
  let anyPixel = false;

  for (let py = 0; py < TILE_SIZE; py++) {
    const gy = py + 1; // skip the one-block margin
    for (let px = 0; px < TILE_SIZE; px++) {
      const gi = gy * gw + (px + 1);
      const out = (py * TILE_SIZE + px) * 4;
      const y = surfaceY[gi];
      if (y === NO_DATA) continue; // stays transparent

      anyPixel = true;
      const name = surfaceName[gi];
      let [r, g, b] = colorFor(name, biome[gi]);

      // Water: darken with depth so shorelines and rivers stay readable.
      if (waterDepthShading && WATER_NAMES.has(name)) {
        const depth = clamp(y - floorY[gi], 0, 30);
        const k = Math.min(0.62, depth * 0.03);
        r *= 1 - k * 0.75;
        g *= 1 - k * 0.75;
        b *= 1 - k * 0.55;
      }

      // Relief shading from the north/west height difference.
      const yN = surfaceY[gi - gw];
      const yW = surfaceY[gi - 1];
      const slope = y - ((yN === NO_DATA ? y : yN) + (yW === NO_DATA ? y : yW)) / 2;
      const f = 1 + clamp(slope * 0.05, -0.5, 0.5) * shadeStrength;

      rgba[out] = r * f;
      rgba[out + 1] = g * f;
      rgba[out + 2] = b * f;
      rgba[out + 3] = 255;
    }
  }

  if (!anyPixel) return { rgba: emptyTile(), empty: true };
  return { rgba, empty: false };
}

/**
 * Rail overlay: one transparent tile with only the rails painted, so it can be
 * switched on and off over the terrain. Rails found deep underground are drawn
 * dimmer than surface ones, which makes a tunnel readable as a tunnel while
 * still showing where it runs.
 */
export async function renderRailTile(source, regionDir, tx, ty, options = {}) {
  const span = TILE_SIZE;
  const minX = tx * span;
  const minZ = ty * span;
  const grid = await readSurface(source, regionDir, minX, minZ, span, span, {
    ...options, detectRails: true,
  });
  if (grid.totalChunks === 0 || !grid.railY) return { rgba: emptyTile(), empty: true };

  const rgba = new Uint8ClampedArray(PIXELS);
  const [r, g, b] = options.railColor || [255, 92, 46];
  let any = false;

  for (let i = 0; i < grid.railY.length; i++) {
    const y = grid.railY[i];
    if (y === NO_DATA) continue;
    any = true;
    // How far below the surface the rail sits.
    const surface = grid.surfaceY[i];
    const depth = surface === NO_DATA ? 0 : clamp(surface - y, 0, 48);
    const k = 1 - Math.min(0.55, depth * 0.011);
    const out = i * 4;
    rgba[out] = r * k;
    rgba[out + 1] = g * k;
    rgba[out + 2] = b * k;
    rgba[out + 3] = 255;
  }

  if (!any) return { rgba: emptyTile(), empty: true };
  return { rgba, empty: false };
}

// ---------------------------------------------------------------------------
// Pyramid: box-downsample of the four children
// ---------------------------------------------------------------------------

export function downsampleChildren(children) {
  if (children.every((c) => !c)) return { rgba: emptyTile(), empty: true };

  const half = TILE_SIZE / 2;
  const out = new Uint8ClampedArray(PIXELS);

  const place = (child, offX, offY) => {
    if (!child) return;
    for (let dy = 0; dy < half; dy++) {
      for (let dx = 0; dx < half; dx++) {
        const sx = dx * 2;
        const sy = dy * 2;
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let k = 0; k < 4; k++) {
          const si = ((sy + (k >> 1)) * TILE_SIZE + (sx + (k & 1))) * 4;
          const sa = child[si + 3];
          if (sa === 0) continue;
          r += child[si]; g += child[si + 1]; b += child[si + 2]; a += sa;
          n++;
        }
        const di = ((dy + offY) * TILE_SIZE + (dx + offX)) * 4;
        if (n === 0) continue; // leave transparent
        out[di] = r / n;
        out[di + 1] = g / n;
        out[di + 2] = b / n;
        // Partial coverage stays partial, so coastlines fade instead of growing.
        out[di + 3] = a / 4;
      }
    }
  };

  place(children[0], 0, 0);
  place(children[1], half, 0);
  place(children[2], 0, half);
  place(children[3], half, half);

  return { rgba: out, empty: false };
}

// ---------------------------------------------------------------------------
// Tile production
// ---------------------------------------------------------------------------

/**
 * Produce a tile.
 *
 * ctx: { source, regionDir, regionSet, cache, renderOptions, kind }
 *   cache is optional and must expose async get(z,x,y) / set(z,x,y,rgba).
 *   kind is 'terrain' (default) or 'rails' for the rail overlay.
 *
 * allowRender=true is for the background builder and permits rendering the
 * whole subtree; while serving a request it stays false.
 *
 * Returns { rgba, empty, cached, partial }. `partial` marks a tile composed
 * while some children were still missing, so it must not be cached as final.
 */
export async function getTile(ctx, z, x, y, allowRender = false) {
  if (z > NATIVE_ZOOM || z < MIN_ZOOM) {
    return { rgba: emptyTile(), empty: true, cached: false, partial: false };
  }

  // Nothing generated here at all: answer instantly, without touching storage.
  const span = blocksPerTile(z);
  const minX = x * span;
  const minZ = y * span;
  if (!boxHasRegions(ctx.regionSet, minX, minZ, minX + span - 1, minZ + span - 1)) {
    return { rgba: emptyTile(), empty: true, cached: false, partial: false };
  }

  if (ctx.cache) {
    const hit = await ctx.cache.get(z, x, y);
    if (hit) return { rgba: hit, empty: false, cached: true, partial: false };
  }

  if (z === NATIVE_ZOOM) {
    const render = ctx.kind === 'rails' ? renderRailTile : renderBaseTile;
    const result = await render(ctx.source, ctx.regionDir, x, y, ctx.renderOptions);
    // Empty tiles are cached too, as fully transparent ones. For the rail
    // overlay most tiles inside a region have no rails at all, and each of
    // those costs a full-height scan to discover — recomputing them on every
    // pan would be the slowest thing the app does.
    if (ctx.cache) await ctx.cache.set(z, x, y, result.rgba);
    return { ...result, cached: false, partial: false };
  }

  const mayRender = allowRender || -z <= MAX_ON_DEMAND_DEPTH;
  let partial = false;
  const children = [];
  for (const [kx, ky] of [[x * 2, y * 2], [x * 2 + 1, y * 2], [x * 2, y * 2 + 1], [x * 2 + 1, y * 2 + 1]]) {
    let child;
    if (mayRender) {
      child = await getTile(ctx, z + 1, kx, ky, allowRender);
    } else {
      child = await getTileFromCache(ctx, z + 1, kx, ky);
    }
    if (child.partial) partial = true;
    children.push(child.empty ? null : child.rgba);
  }

  const result = downsampleChildren(children);
  if (ctx.cache && !partial) await ctx.cache.set(z, x, y, result.rgba);
  return { ...result, cached: false, partial };
}

/** Compose a tile purely from what is already cached — never renders. */
export async function getTileFromCache(ctx, z, x, y) {
  if (z > NATIVE_ZOOM || z < MIN_ZOOM) {
    return { rgba: emptyTile(), empty: true, cached: false, partial: false };
  }
  const span = blocksPerTile(z);
  if (!boxHasRegions(ctx.regionSet, x * span, y * span, x * span + span - 1, y * span + span - 1)) {
    return { rgba: emptyTile(), empty: true, cached: false, partial: false };
  }
  if (ctx.cache) {
    const hit = await ctx.cache.get(z, x, y);
    if (hit) return { rgba: hit, empty: false, cached: true, partial: false };
  }
  if (z === NATIVE_ZOOM) {
    return { rgba: emptyTile(), empty: true, cached: false, partial: true };
  }
  // Not built yet: show whatever finer detail exists rather than nothing.
  const children = [];
  for (const [kx, ky] of [[x * 2, y * 2], [x * 2 + 1, y * 2], [x * 2, y * 2 + 1], [x * 2 + 1, y * 2 + 1]]) {
    const child = await getTileFromCache(ctx, z + 1, kx, ky);
    children.push(child.empty ? null : child.rgba);
  }
  const result = downsampleChildren(children);
  return { ...result, cached: false, partial: true };
}

/** Serve-time entry point: never triggers an expensive deep render. */
export async function serveTile(ctx, z, x, y) {
  if (-z > MAX_ON_DEMAND_DEPTH) return getTileFromCache(ctx, z, x, y);
  return getTile(ctx, z, x, y, false);
}

/** Tile range covering a block box at a given zoom. */
export function tileRangeFor(bounds, z) {
  const span = blocksPerTile(z);
  return {
    minTX: Math.floor(bounds.minX / span),
    maxTX: Math.floor(bounds.maxX / span),
    minTY: Math.floor(bounds.minZ / span),
    maxTY: Math.floor(bounds.maxZ / span),
  };
}
