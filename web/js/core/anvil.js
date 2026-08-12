/*
 * Reader for Minecraft Java Edition Anvil region files (.mca).
 *
 * Chunk formats supported:
 *   - 1.18+  (DataVersion >= 2844): root.sections[], each with
 *            block_states {palette,data} and biomes {palette,data}.
 *   - 1.13 - 1.17: root.Level.Sections[], with Palette + BlockStates.
 *   Pre-1.13 worlds store numeric block ids with no palette and are reported
 *   as unparsable, so rendering degrades instead of crashing.
 *
 * Bit packing (the easy thing to get wrong): up to DataVersion 2528 (1.15.x)
 * palette indices are packed tightly and a value MAY span two longs. From
 * DataVersion 2529 (1.16) each long is padded — floor(64/bits) values per
 * long — and a value NEVER spans two longs.
 */

import { parseRaw, decompressBytes } from './nbt.js';
import { joinPath } from './source.js';

const DV_PADDED_PACKING = 2529;
export const NO_DATA = -9999;

export const AIR_NAMES = new Set([
  'minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:structure_void',
]);
export const WATER_NAMES = new Set(['minecraft:water', 'minecraft:bubble_column']);

/* Rails are looked for through the whole column, not just at the surface, so
 * that tunnels show up on the map too. */
export const RAIL_NAMES = new Set([
  'minecraft:rail', 'minecraft:powered_rail', 'minecraft:detector_rail',
  'minecraft:activator_rail',
]);

const MASK64 = (1n << 64n) - 1n;
const asUnsigned = (v) => v & MASK64;

/** Tight packing (<=1.15): values may span two longs. */
export function readSpanningPacked(longArray, bits, index) {
  const bitIndex = index * bits;
  const longIndex = bitIndex >> 6;
  const bitOffset = BigInt(bitIndex & 63);
  const mask = (1n << BigInt(bits)) - 1n;
  let value = (asUnsigned(longArray[longIndex]) >> bitOffset) & mask;
  const bitsFromLo = 64 - Number(bitOffset);
  if (bitsFromLo < bits && longIndex + 1 < longArray.length) {
    value |= (asUnsigned(longArray[longIndex + 1]) << BigInt(bitsFromLo)) & mask;
  }
  return Number(value);
}

/** Padded packing (>=1.16): each long holds floor(64/bits) values, no spanning. */
export function readPaddedPacked(longArray, bits, index) {
  const perLong = Math.floor(64 / bits);
  const longIndex = Math.floor(index / perLong);
  if (longIndex >= longArray.length) return 0;
  const bitOffset = BigInt((index % perLong) * bits);
  const mask = (1n << BigInt(bits)) - 1n;
  return Number((asUnsigned(longArray[longIndex]) >> bitOffset) & mask);
}

export const blockBits = (n) => (n <= 1 ? 0 : Math.max(4, Math.ceil(Math.log2(n))));
export const biomeBits = (n) => (n <= 1 ? 0 : Math.max(1, Math.ceil(Math.log2(n))));

function makeAccessor(names, longArray, bits, padded) {
  if (names.length <= 1 || bits === 0 || !longArray || longArray.length === 0) {
    const only = names[0] || 'minecraft:air';
    return () => only;
  }
  const read = padded ? readPaddedPacked : readSpanningPacked;
  return (index) => {
    const i = read(longArray, bits, index);
    return names[i] !== undefined ? names[i] : names[0];
  };
}

// Section-local block index: y*256 + z*16 + x
const blockIndex = (lx, ly, lz) => ((ly & 15) << 8) | ((lz & 15) << 4) | (lx & 15);
// Section-local biome cell index (4x4x4 cells): y*16 + z*4 + x
const biomeIndex = (lx, ly, lz) => (((ly & 15) >> 2) << 4) | (((lz & 15) >> 2) << 2) | ((lx & 15) >> 2);

const paletteNames = (tags) => tags.map((p) => (typeof p === 'string' ? p : (p && p.Name) || 'minecraft:air'));

export function normalizeChunk(root) {
  const padded = Number(root.DataVersion || 0) >= DV_PADDED_PACKING;

  let raw = null;
  if (Array.isArray(root.sections)) raw = root.sections;
  else if (root.Level && Array.isArray(root.Level.Sections)) raw = root.Level.Sections;
  if (!raw) return null;

  const sections = [];
  for (const sec of raw) {
    const bs = sec.block_states;
    const paletteTag = bs ? bs.palette : sec.Palette;
    if (!Array.isArray(paletteTag) || paletteTag.length === 0) continue;
    const dataTag = bs ? bs.data : sec.BlockStates;
    const names = paletteNames(paletteTag);
    const getBlockAt = makeAccessor(
      names, dataTag instanceof BigInt64Array ? dataTag : null, blockBits(names.length), padded);

    // Only the 1.18+ named biome palette is read; older worlds store numeric
    // ids, which we skip rather than guess at.
    let getBiomeAt = null;
    const bio = sec.biomes;
    if (bio && Array.isArray(bio.palette) && bio.palette.length) {
      const bn = paletteNames(bio.palette);
      getBiomeAt = makeAccessor(
        bn, bio.data instanceof BigInt64Array ? bio.data : null, biomeBits(bn.length), padded);
    }

    sections.push({
      yBase: Number(sec.Y) * 16,
      // The palette is kept so a caller can ask "is any of these blocks in
      // this section?" and skip all 4096 of its cells when the answer is no.
      names,
      getBlock: (lx, ly, lz) => getBlockAt(blockIndex(lx, ly, lz)),
      getBiome: getBiomeAt ? (lx, ly, lz) => getBiomeAt(biomeIndex(lx, ly, lz)) : null,
    });
  }
  if (!sections.length) return null;
  sections.sort((a, b) => b.yBase - a.yBase);
  return sections;
}

/**
 * Per-column surface analysis for one chunk (256 columns).
 *   surfaceY / surfaceName : topmost visible block (water counts as surface)
 *   floorY                 : first non-water block below it
 *   biome                  : biome at the surface, or null
 *   railY                  : highest rail in the column, or NO_DATA (only when
 *                            options.detectRails is set)
 *
 * options.hiddenBlocks is a Set of block names to look straight through, as if
 * they were air — barriers and other invisible blocks otherwise draw solid
 * walls across the map.
 */
export function analyzeChunk(root, options = {}) {
  const sections = normalizeChunk(root);
  if (!sections) return null;

  const hidden = options.hiddenBlocks;
  const detectRails = !!options.detectRails;
  const isSkippable = hidden && hidden.size
    ? (name) => AIR_NAMES.has(name) || hidden.has(name)
    : (name) => AIR_NAMES.has(name);

  const surfaceY = new Int32Array(256).fill(NO_DATA);
  const floorY = new Int32Array(256).fill(NO_DATA);
  const surfaceName = new Array(256).fill('minecraft:air');
  const biome = new Array(256).fill(null);
  const railY = detectRails ? new Int32Array(256).fill(NO_DATA) : null;

  for (let lz = 0; lz < 16; lz++) {
    for (let lx = 0; lx < 16; lx++) {
      const col = lz * 16 + lx;
      let top = null;
      let floor = null;
      scan: for (const sec of sections) {
        for (let ly = 15; ly >= 0; ly--) {
          const name = sec.getBlock(lx, ly, lz);
          if (isSkippable(name)) continue;
          const y = sec.yBase + ly;
          if (top === null) {
            top = { y, name, sec, ly };
            if (!WATER_NAMES.has(name)) { floor = top; break scan; }
            continue;
          }
          if (!WATER_NAMES.has(name)) { floor = { y, name }; break scan; }
        }
      }
      if (!top) continue;
      surfaceY[col] = top.y;
      surfaceName[col] = top.name;
      floorY[col] = (floor || top).y;
      if (top.sec.getBiome) biome[col] = top.sec.getBiome(lx, top.ly, lz);
    }
  }

  if (detectRails) {
    // Sections are sorted top-down, and only the ones whose palette actually
    // mentions a rail are worth walking — which is what keeps a full-height
    // search affordable.
    for (const sec of sections) {
      if (!sec.names.some((n) => RAIL_NAMES.has(n))) continue;
      for (let ly = 15; ly >= 0; ly--) {
        const y = sec.yBase + ly;
        for (let lz = 0; lz < 16; lz++) {
          for (let lx = 0; lx < 16; lx++) {
            const col = lz * 16 + lx;
            if (railY[col] !== NO_DATA) continue; // already found higher up
            if (RAIL_NAMES.has(sec.getBlock(lx, ly, lz))) railY[col] = y;
          }
        }
      }
    }
  }

  return { surfaceY, surfaceName, floorY, biome, railY };
}

// ---------------------------------------------------------------------------
// Region files
// ---------------------------------------------------------------------------

export class RegionFile {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.locations = new Array(1024).fill(null);
    if (bytes.length < 8192) return;
    for (let i = 0; i < 1024; i++) {
      const o = i * 4;
      const sector = (bytes[o] << 16) | (bytes[o + 1] << 8) | bytes[o + 2];
      if (sector) this.locations[i] = { sector, count: bytes[o + 3] };
    }
  }

  hasChunk(lx, lz) { return !!this.locations[(lx & 31) + (lz & 31) * 32]; }

  async getChunkRoot(lx, lz) {
    const entry = this.locations[(lx & 31) + (lz & 31) * 32];
    if (!entry) return null;
    const start = entry.sector * 4096;
    if (start + 5 > this.bytes.length) return null;
    const length = this.view.getUint32(start);
    if (length <= 0 || start + 4 + length > this.bytes.length) return null;
    const compression = this.bytes[start + 4];
    if (compression & 128) return null; // payload lives in an external .mcc file
    const raw = this.bytes.subarray(start + 5, start + 4 + length);
    let payload;
    if (compression === 1) payload = await decompressBytes(raw, 'gzip');
    else if (compression === 2) payload = await decompressBytes(raw, 'deflate');
    else if (compression === 3) payload = raw;
    else return null;
    return parseRaw(payload);
  }
}

// Bounded LRU: region files are several MB each, and a render walks many.
const MAX_CACHED_REGIONS = 8;
const regionCache = new Map();

export async function loadRegionFile(source, path) {
  if (regionCache.has(path)) {
    const v = regionCache.get(path);
    regionCache.delete(path);
    regionCache.set(path, v); // refresh recency
    return v;
  }
  let region = null;
  const bytes = await source.readFile(path);
  if (bytes && bytes.length >= 8192) region = new RegionFile(bytes);
  regionCache.set(path, region);
  if (regionCache.size > MAX_CACHED_REGIONS) {
    regionCache.delete(regionCache.keys().next().value);
  }
  return region;
}

export function clearRegionCache() { regionCache.clear(); }

/**
 * Surface grid for a block bounding box, reading only the region files it
 * touches from `regionDir`. Row-major (z outer, x inner).
 */
export async function readSurface(source, regionDir, minX, minZ, width, depth, options = {}) {
  const maxX = minX + width - 1;
  const maxZ = minZ + depth - 1;
  const size = width * depth;

  const surfaceY = new Int32Array(size).fill(NO_DATA);
  const floorY = new Int32Array(size).fill(NO_DATA);
  const surfaceName = new Array(size).fill('minecraft:air');
  const biome = new Array(size).fill(null);
  const railY = options.detectRails ? new Int32Array(size).fill(NO_DATA) : null;

  let totalChunks = 0;
  let unparsedChunks = 0;

  const cMinX = minX >> 4, cMaxX = maxX >> 4;
  const cMinZ = minZ >> 4, cMaxZ = maxZ >> 4;
  const rMinX = cMinX >> 5, rMaxX = cMaxX >> 5;
  const rMinZ = cMinZ >> 5, rMaxZ = cMaxZ >> 5;

  for (let rz = rMinZ; rz <= rMaxZ; rz++) {
    for (let rx = rMinX; rx <= rMaxX; rx++) {
      const region = await loadRegionFile(source, joinPath(regionDir, `r.${rx}.${rz}.mca`));
      if (!region) continue;
      const czStart = Math.max(cMinZ, rz * 32), czEnd = Math.min(cMaxZ, rz * 32 + 31);
      const cxStart = Math.max(cMinX, rx * 32), cxEnd = Math.min(cMaxX, rx * 32 + 31);
      for (let cz = czStart; cz <= czEnd; cz++) {
        for (let cx = cxStart; cx <= cxEnd; cx++) {
          const lx = ((cx % 32) + 32) % 32;
          const lz = ((cz % 32) + 32) % 32;
          if (!region.hasChunk(lx, lz)) continue;
          totalChunks++;
          let cols = null;
          try {
            const root = await region.getChunkRoot(lx, lz);
            if (root) cols = analyzeChunk(root.value, options);
          } catch {
            cols = null;
          }
          if (!cols) { unparsedChunks++; continue; }

          const baseX = cx * 16, baseZ = cz * 16;
          const zFrom = Math.max(0, minZ - baseZ), zTo = Math.min(15, maxZ - baseZ);
          const xFrom = Math.max(0, minX - baseX), xTo = Math.min(15, maxX - baseX);
          for (let lzz = zFrom; lzz <= zTo; lzz++) {
            const dstRow = (baseZ + lzz - minZ) * width;
            const srcRow = lzz * 16;
            for (let lxx = xFrom; lxx <= xTo; lxx++) {
              const dst = dstRow + (baseX + lxx - minX);
              const src = srcRow + lxx;
              surfaceY[dst] = cols.surfaceY[src];
              floorY[dst] = cols.floorY[src];
              surfaceName[dst] = cols.surfaceName[src];
              biome[dst] = cols.biome[src];
              if (railY) railY[dst] = cols.railY[src];
            }
          }
        }
      }
    }
  }

  return { minX, minZ, width, depth, surfaceY, floorY, surfaceName, biome, railY, totalChunks, unparsedChunks };
}
