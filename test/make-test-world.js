'use strict';
/*
 * Generates a synthetic Java-Edition world save used by the test suite, so
 * the parser/renderer can be exercised without a Minecraft install.
 *
 * Layout: one region (r.0.0.mca) covering blocks 0..511 on both axes —
 * 2x2 tiles at native zoom, which is enough to exercise the tile pyramid.
 * Terrain: two hills, a river running north-south, a lake, a sand beach and
 * a snowy peak, with biomes set per area so biome tinting is exercised too.
 *
 * Written in the modern (1.16+) padded bit-packing so it matches what a
 * current Minecraft actually writes.
 */

const fs = require('fs');
const path = require('path');
const nbt = require('../lib/nbt');

const WORLD_DIR = path.join(__dirname, '..', 'data', 'testworld');
const REGION_DIR = path.join(WORLD_DIR, 'region');
const SIZE = 512;                 // blocks per side
const CHUNKS = SIZE / 16;         // 32x32 chunks
const DATA_VERSION = 3465;        // 1.20.1
const SECTION_Y = [3, 4, 5, 6, 7]; // y 48..127, così il terreno ci sta tutto
const MASK64 = (1n << 64n) - 1n;

// --- packing (padded: values never span two longs, as in 1.16+) ------------
function packPadded(indices, bits) {
  if (bits === 0) return [];
  const perLong = Math.floor(64 / bits);
  const numLongs = Math.ceil(indices.length / perLong);
  const longs = new Array(numLongs).fill(0n);
  const mask = (1n << BigInt(bits)) - 1n;
  for (let i = 0; i < indices.length; i++) {
    const li = Math.floor(i / perLong);
    const off = BigInt((i % perLong) * bits);
    longs[li] = (longs[li] | ((BigInt(indices[i]) & mask) << off)) & MASK64;
  }
  // NBT longs are signed; wrap values above 2^63 into the negative range.
  return longs.map((v) => (v >= (1n << 63n) ? v - (1n << 64n) : v));
}
const blockBits = (n) => (n <= 1 ? 0 : Math.max(4, Math.ceil(Math.log2(n))));
const biomeBits = (n) => (n <= 1 ? 0 : Math.max(1, Math.ceil(Math.log2(n))));

// --- terrain shape ---------------------------------------------------------
function hill(x, z, cx, cz, height, spread) {
  const dx = x - cx, dz = z - cz;
  return height * Math.exp(-(dx * dx + dz * dz) / spread);
}

const heights = new Int16Array(SIZE * SIZE);
const kinds = new Uint8Array(SIZE * SIZE); // 0 land, 1 water, 2 beach, 3 snow
let terrainBuilt = false;

// Terrain is clamped into the range covered by SECTION_Y so that every column
// — including lake and river beds — has a real floor block in the save.
const MIN_TERRAIN_Y = 50;
const MAX_TERRAIN_Y = 120;
const SEA_LEVEL = 62;

function buildTerrain() {
  for (let z = 0; z < SIZE; z++) {
    for (let x = 0; x < SIZE; x++) {
      let h = 64;
      h += hill(x, z, 140, 150, 34, 5200);   // main hill
      h += hill(x, z, 360, 330, 46, 3600);   // taller peak
      h += 3 * Math.sin(x / 26) * Math.cos(z / 31); // gentle undulation
      // A river meandering roughly north-south around x = 250.
      const riverX = 250 + 40 * Math.sin(z / 70);
      const distToRiver = Math.abs(x - riverX);
      if (distToRiver < 9) h -= (9 - distToRiver) * 1.9;
      // A round lake in the south-west.
      h -= hill(x, z, 110, 420, 16, 1400);

      const y = Math.min(MAX_TERRAIN_Y, Math.max(MIN_TERRAIN_Y, Math.round(h)));
      const i = z * SIZE + x;
      heights[i] = y;
      if (y < SEA_LEVEL) kinds[i] = 1;         // below sea level -> water
      else if (y <= SEA_LEVEL + 2) kinds[i] = 2; // shoreline -> sand
      else if (y >= 96) kinds[i] = 3;          // peak -> snow
      else kinds[i] = 0;
    }
  }
  terrainBuilt = true;
}

/** Rebuild the reference heightmap on demand (the test suite reads it even
 *  when the world file already exists on disk and generate() is skipped). */
function ensureTerrain() {
  if (!terrainBuilt) buildTerrain();
  return { heights, kinds };
}


function blockAt(x, y, z) {
  const i = z * SIZE + x;
  const surface = heights[i];
  const kind = kinds[i];
  if (kind === 1) {
    if (y > SEA_LEVEL) return 'minecraft:air';
    if (y > surface) return 'minecraft:water';
    if (y === surface) return 'minecraft:sand';
    if (y > surface - 4) return 'minecraft:gravel';
    return 'minecraft:stone';
  }
  if (y > surface) return 'minecraft:air';
  if (y === surface) {
    if (kind === 2) return 'minecraft:sand';
    if (kind === 3) return 'minecraft:snow_block';
    // A patch of forest on the flank of the main hill.
    if (x > 60 && x < 200 && z > 60 && z < 210 && ((x * 7 + z * 13) % 11 === 0)) {
      return 'minecraft:oak_leaves';
    }
    return 'minecraft:grass_block';
  }
  if (y > surface - 4) return kind === 2 ? 'minecraft:sand' : 'minecraft:dirt';
  return 'minecraft:stone';
}

function biomeAt(x, z) {
  const i = z * SIZE + x;
  if (kinds[i] === 1) return heights[i] < 50 ? 'minecraft:ocean' : 'minecraft:river';
  if (kinds[i] === 3) return 'minecraft:snowy_slopes';
  if (kinds[i] === 2) return 'minecraft:beach';
  if (x > 60 && x < 200 && z > 60 && z < 210) return 'minecraft:forest';
  if (x > 300 && z < 200) return 'minecraft:desert';
  return 'minecraft:plains';
}

// --- chunk building --------------------------------------------------------
function buildSection(cx, cz, secY) {
  const yBase = secY * 16;
  const names = [];
  const nameIdx = new Map();
  const indices = new Int32Array(4096);
  for (let ly = 0; ly < 16; ly++) {
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const name = blockAt(cx * 16 + lx, yBase + ly, cz * 16 + lz);
        let idx = nameIdx.get(name);
        if (idx === undefined) { idx = names.length; names.push(name); nameIdx.set(name, idx); }
        indices[(ly << 8) | (lz << 4) | lx] = idx;
      }
    }
  }

  // biomes: 4x4x4 cells -> 64 entries, ordered y,z,x
  const bNames = [];
  const bIdx = new Map();
  const bIndices = new Int32Array(64);
  for (let by = 0; by < 4; by++) {
    for (let bz = 0; bz < 4; bz++) {
      for (let bx = 0; bx < 4; bx++) {
        const name = biomeAt(cx * 16 + bx * 4, cz * 16 + bz * 4);
        let idx = bIdx.get(name);
        if (idx === undefined) { idx = bNames.length; bNames.push(name); bIdx.set(name, idx); }
        bIndices[(by << 4) | (bz << 2) | bx] = idx;
      }
    }
  }

  const section = {
    Y: new nbt.TByte(secY),
    block_states: { palette: new nbt.TList(nbt.TAG.Compound, names.map((n) => ({ Name: n }))) },
    biomes: { palette: new nbt.TList(nbt.TAG.String, bNames) },
  };
  const bb = blockBits(names.length);
  if (bb > 0) section.block_states.data = new nbt.TLongArray(packPadded(indices, bb));
  const bib = biomeBits(bNames.length);
  if (bib > 0) section.biomes.data = new nbt.TLongArray(packPadded(bIndices, bib));
  return section;
}

function buildChunk(cx, cz) {
  const root = {
    DataVersion: DATA_VERSION,
    xPos: cx,
    zPos: cz,
    yPos: -4,
    Status: 'minecraft:full',
    sections: new nbt.TList(nbt.TAG.Compound, SECTION_Y.map((y) => buildSection(cx, cz, y))),
  };
  return nbt.deflate(nbt.build('', root));
}

function buildRegion(chunks) {
  const HEADER_SECTORS = 2;
  const header = Buffer.alloc(HEADER_SECTORS * 4096);
  const body = [];
  let nextSector = HEADER_SECTORS;
  const now = Math.floor(Date.now() / 1000);

  for (const [key, compressed] of chunks) {
    const head = Buffer.alloc(5);
    head.writeUInt32BE(compressed.length + 1, 0);
    head.writeUInt8(2, 4); // zlib
    const payload = Buffer.concat([head, compressed]);
    const sectors = Math.ceil(payload.length / 4096);
    const padded = Buffer.alloc(sectors * 4096);
    payload.copy(padded);

    const [lx, lz] = key.split(',').map(Number);
    const slot = (lx & 31) + (lz & 31) * 32;
    header[slot * 4] = (nextSector >> 16) & 0xff;
    header[slot * 4 + 1] = (nextSector >> 8) & 0xff;
    header[slot * 4 + 2] = nextSector & 0xff;
    header[slot * 4 + 3] = sectors & 0xff;
    header.writeUInt32BE(now, 4096 + slot * 4);

    body.push(padded);
    nextSector += sectors;
  }
  return Buffer.concat([header, ...body]);
}

function buildAllChunks(quiet) {
  const chunks = new Map();
  for (let cz = 0; cz < CHUNKS; cz++) {
    for (let cx = 0; cx < CHUNKS; cx++) chunks.set(`${cx},${cz}`, buildChunk(cx, cz));
    if (!quiet && cz % 8 === 0) process.stdout.write(`  ...righe di chunk ${cz}/${CHUNKS}\r`);
  }
  return chunks;
}

function generate({ quiet = false } = {}) {
  fs.mkdirSync(REGION_DIR, { recursive: true });
  ensureTerrain();
  const chunks = buildAllChunks(quiet);
  fs.writeFileSync(path.join(REGION_DIR, 'r.0.0.mca'), buildRegion(chunks));

  const levelDat = nbt.gzip(nbt.build('', {
    Data: {
      LevelName: 'Cube-Atlas Test World',
      DataVersion: DATA_VERSION,
      SpawnX: 256, SpawnY: 80, SpawnZ: 256,
      Version: { Name: '1.20.1', Id: DATA_VERSION },
    },
  }));
  fs.writeFileSync(path.join(WORLD_DIR, 'level.dat'), levelDat);
  if (!quiet) console.log(`\nMondo di test generato in ${WORLD_DIR} (${SIZE}x${SIZE} blocchi)`);
  return WORLD_DIR;
}

if (require.main === module) generate();

/*
 * A save that mirrors the layouts people actually have: the region files live
 * several folders below level.dat (dimensions/<ns>/<name>/region), and the
 * world has one far-flung explored region besides the built-up area near the
 * origin — so the map bounds are enormous while the interesting part is tiny.
 */
const NESTED_WORLD_DIR = path.join(__dirname, '..', 'data', 'testworld-nested');
const FAR_REGION = { x: 20, z: 20 }; // blocks 10240..10751

function generateNested({ quiet = true } = {}) {
  const regionDir = path.join(NESTED_WORLD_DIR, 'dimensions', 'minecraft', 'overworld', 'region');
  fs.mkdirSync(regionDir, { recursive: true });
  ensureTerrain();
  const chunks = buildAllChunks(quiet);
  const region = buildRegion(chunks);
  fs.writeFileSync(path.join(regionDir, 'r.0.0.mca'), region);
  // The far region reuses the same terrain: only its position matters here.
  fs.writeFileSync(path.join(regionDir, `r.${FAR_REGION.x}.${FAR_REGION.z}.mca`), region);

  // A nether folder too, so dimension discovery has something to tell apart.
  const netherDir = path.join(NESTED_WORLD_DIR, 'DIM-1', 'region');
  fs.mkdirSync(netherDir, { recursive: true });
  fs.writeFileSync(path.join(netherDir, 'r.0.0.mca'), region);

  fs.writeFileSync(path.join(NESTED_WORLD_DIR, 'level.dat'), nbt.gzip(nbt.build('', {
    Data: {
      LevelName: 'Mondo Annidato',
      DataVersion: DATA_VERSION,
      SpawnX: 128, SpawnY: 100, SpawnZ: 128,
      Version: { Name: '1.20.1', Id: DATA_VERSION },
    },
  })));
  if (!quiet) console.log(`Mondo annidato generato in ${NESTED_WORLD_DIR}`);
  return NESTED_WORLD_DIR;
}

module.exports = {
  generate, generateNested, ensureTerrain,
  WORLD_DIR, NESTED_WORLD_DIR, FAR_REGION, SIZE, SEA_LEVEL,
  heights, kinds, blockAt, biomeAt, packPadded, blockBits, biomeBits,
};
