'use strict';
/*
 * Reader for Minecraft Java Edition Anvil region files (.mca).
 *
 * Chunk formats supported:
 *   - 1.18+  (DataVersion >= 2844): root.sections[], each with
 *            block_states {palette,data} and biomes {palette,data}.
 *   - 1.13 - 1.17 (DataVersion 1519..2843): root.Level.Sections[], each with
 *            Palette + BlockStates. Biomes as numeric ids (not tinted).
 *   Pre-1.13 numeric-block-id worlds have no palette and are reported as
 *   unparsable so rendering degrades gracefully instead of crashing.
 *
 * Bit packing (important): up to DataVersion 2528 (1.15.x) palette indices
 * are packed tightly and a value MAY span two longs. From DataVersion 2529
 * (1.16) onward each long is padded — floor(64/bits) values per long and a
 * value NEVER spans two longs.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const nbt = require('./nbt');

const DV_PADDED_PACKING = 2529; // 1.16: values stopped spanning longs
const NO_DATA = -9999;          // sentinel height for "no chunk here"

const AIR_NAMES = new Set([
  'minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:structure_void',
]);

// Blocks that are "see-through" for map purposes: we keep descending to find
// the ground under them, then blend. Matches how unMINED shows water depth.
const WATER_NAMES = new Set(['minecraft:water', 'minecraft:bubble_column']);

const MASK64 = (1n << 64n) - 1n;
const asUnsigned = (v) => v & MASK64;

/** Tight packing (<=1.15): values may span two longs. */
function readSpanningPacked(longArray, bits, index) {
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
function readPaddedPacked(longArray, bits, index) {
  const perLong = Math.floor(64 / bits);
  const longIndex = Math.floor(index / perLong);
  if (longIndex >= longArray.length) return 0;
  const bitOffset = BigInt((index % perLong) * bits);
  const mask = (1n << BigInt(bits)) - 1n;
  return Number((asUnsigned(longArray[longIndex]) >> bitOffset) & mask);
}

function blockBits(paletteSize) {
  if (paletteSize <= 1) return 0;
  return Math.max(4, Math.ceil(Math.log2(paletteSize)));
}
function biomeBits(paletteSize) {
  if (paletteSize <= 1) return 0;
  return Math.max(1, Math.ceil(Math.log2(paletteSize)));
}

/** Build an accessor over a paletted+packed array. */
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

function paletteNames(paletteTags) {
  return paletteTags.map((p) => {
    if (typeof p === 'string') return p;          // biomes palette = list of strings
    return (p && p.Name) || 'minecraft:air';      // block palette = list of compounds
  });
}

/**
 * Normalize a chunk root into sections sorted top-down, each exposing
 * getBlock(lx,ly,lz) and getBiome(lx,ly,lz). Returns null if unsupported.
 */
function normalizeChunk(root) {
  const dataVersion = Number(root.DataVersion || 0);
  const padded = dataVersion >= DV_PADDED_PACKING;

  let rawSections = null;
  if (Array.isArray(root.sections)) rawSections = root.sections;            // 1.18+
  else if (root.Level && Array.isArray(root.Level.Sections)) rawSections = root.Level.Sections; // 1.13-1.17
  if (!rawSections) return null;

  const sections = [];
  for (const sec of rawSections) {
    // Blocks: new format nests under block_states, old format is flat.
    const bsTag = sec.block_states;
    const paletteTag = bsTag ? bsTag.palette : sec.Palette;
    if (!Array.isArray(paletteTag) || paletteTag.length === 0) continue;
    const dataTag = bsTag ? bsTag.data : sec.BlockStates;
    const blockLongs = dataTag instanceof BigInt64Array ? dataTag : null;
    const names = paletteNames(paletteTag);
    const getBlockAt = makeAccessor(names, blockLongs, blockBits(names.length), padded);

    // Biomes: only the 1.18+ named palette is supported (older worlds store
    // numeric ids, which we skip rather than guess at).
    let getBiomeAt = null;
    const bio = sec.biomes;
    if (bio && Array.isArray(bio.palette) && bio.palette.length) {
      const bNames = paletteNames(bio.palette);
      const bLongs = bio.data instanceof BigInt64Array ? bio.data : null;
      getBiomeAt = makeAccessor(bNames, bLongs, biomeBits(bNames.length), padded);
    }

    sections.push({
      yBase: Number(sec.Y) * 16,
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
 * Returns typed arrays + name arrays, or null if the chunk is unsupported.
 *   surfaceY   : Y of the topmost non-air block (water counts as surface)
 *   surfaceName: its block name
 *   floorY     : Y of the first non-water block under the surface
 *                (== surfaceY when the surface isn't water)
 *   biome      : biome name at the surface, or null when unavailable
 */
function analyzeChunk(root) {
  const sections = normalizeChunk(root);
  if (!sections) return null;

  const surfaceY = new Int32Array(256).fill(NO_DATA);
  const floorY = new Int32Array(256).fill(NO_DATA);
  const surfaceName = new Array(256).fill('minecraft:air');
  const floorName = new Array(256).fill('minecraft:air');
  const biome = new Array(256).fill(null);

  for (let lz = 0; lz < 16; lz++) {
    for (let lx = 0; lx < 16; lx++) {
      const col = lz * 16 + lx;
      let top = null;
      let floor = null;
      scan: for (const sec of sections) {
        for (let ly = 15; ly >= 0; ly--) {
          const name = sec.getBlock(lx, ly, lz);
          if (AIR_NAMES.has(name)) continue;
          const y = sec.yBase + ly;
          if (top === null) {
            top = { y, name, sec, ly };
            if (!WATER_NAMES.has(name)) { floor = top; break scan; }
            continue;
          }
          if (!WATER_NAMES.has(name)) { floor = { y, name, sec, ly }; break scan; }
        }
      }
      if (!top) continue;
      surfaceY[col] = top.y;
      surfaceName[col] = top.name;
      const f = floor || top;
      floorY[col] = f.y;
      floorName[col] = f.name;
      if (top.sec.getBiome) biome[col] = top.sec.getBiome(lx, top.ly, lz);
    }
  }
  return { surfaceY, surfaceName, floorY, floorName, biome };
}

// ---------------------------------------------------------------------------
// Region files
// ---------------------------------------------------------------------------

class RegionFile {
  constructor(buffer) {
    this.buf = buffer;
    this.locations = new Array(1024).fill(null);
    if (buffer.length < 8192) return;
    for (let i = 0; i < 1024; i++) {
      const o = i * 4;
      const sector = (buffer[o] << 16) | (buffer[o + 1] << 8) | buffer[o + 2];
      if (sector) this.locations[i] = { sector, count: buffer[o + 3] };
    }
  }

  hasChunk(lx, lz) { return !!this.locations[(lx & 31) + (lz & 31) * 32]; }

  getChunkRoot(lx, lz) {
    const entry = this.locations[(lx & 31) + (lz & 31) * 32];
    if (!entry) return null;
    const start = entry.sector * 4096;
    if (start + 5 > this.buf.length) return null;
    const length = this.buf.readUInt32BE(start);
    if (length <= 0 || start + 4 + length > this.buf.length) return null;
    const compression = this.buf.readUInt8(start + 4);
    if (compression & 128) return null; // payload in an external .mcc file
    const raw = this.buf.subarray(start + 5, start + 4 + length);
    let payload;
    if (compression === 1) payload = zlib.gunzipSync(raw);
    else if (compression === 2) payload = zlib.inflateSync(raw);
    else if (compression === 3) payload = raw;
    else if (compression === 4) payload = zlib.inflateSync(raw); // LZ4 unsupported; try zlib
    else return null;
    return nbt.parse(payload).value;
  }
}

// Bounded LRU so scanning a large world doesn't grow memory without limit
// (each region file is up to a few MB).
const MAX_CACHED_REGIONS = 12;
const regionCache = new Map();

function loadRegionFile(filePath) {
  if (regionCache.has(filePath)) {
    const v = regionCache.get(filePath);
    regionCache.delete(filePath);
    regionCache.set(filePath, v); // refresh recency
    return v;
  }
  let region = null;
  try {
    region = new RegionFile(fs.readFileSync(filePath));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  regionCache.set(filePath, region);
  if (regionCache.size > MAX_CACHED_REGIONS) {
    regionCache.delete(regionCache.keys().next().value);
  }
  return region;
}

function clearRegionCache() { regionCache.clear(); }

/**
 * Surface grid for an arbitrary block bounding box, reading only the region
 * files it touches from `regionDir`. Row-major (z outer, x inner).
 */
function readSurface(regionDir, minX, minZ, width, depth) {
  const maxX = minX + width - 1;
  const maxZ = minZ + depth - 1;
  const size = width * depth;

  const surfaceY = new Int32Array(size).fill(NO_DATA);
  const floorY = new Int32Array(size).fill(NO_DATA);
  const surfaceName = new Array(size).fill('minecraft:air');
  const biome = new Array(size).fill(null);

  let totalChunks = 0;
  let unparsedChunks = 0;

  const cMinX = minX >> 4, cMaxX = maxX >> 4;
  const cMinZ = minZ >> 4, cMaxZ = maxZ >> 4;

  // Iterate region-major so each region file is opened once per tile.
  const rMinX = cMinX >> 5, rMaxX = cMaxX >> 5;
  const rMinZ = cMinZ >> 5, rMaxZ = cMaxZ >> 5;

  for (let rz = rMinZ; rz <= rMaxZ; rz++) {
    for (let rx = rMinX; rx <= rMaxX; rx++) {
      const region = loadRegionFile(path.join(regionDir, `r.${rx}.${rz}.mca`));
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
            const root = region.getChunkRoot(lx, lz);
            if (root) cols = analyzeChunk(root);
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
            }
          }
        }
      }
    }
  }

  return { minX, minZ, width, depth, surfaceY, floorY, surfaceName, biome, totalChunks, unparsedChunks };
}

module.exports = {
  NO_DATA, AIR_NAMES, WATER_NAMES,
  RegionFile, loadRegionFile, clearRegionCache,
  normalizeChunk, analyzeChunk, readSurface,
  readPaddedPacked, readSpanningPacked, blockBits, biomeBits,
};
