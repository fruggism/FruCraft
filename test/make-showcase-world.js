/*
 * A small world built on purpose to exercise every shape the mesher knows.
 *
 * The synthetic world in make-test-world.js is all terrain: it proves the
 * reader, but it contains no stairs, no fences, no flowers and no glass, so
 * it can never show whether those come out right. This one is 64x64 blocks of
 * nothing but special cases — a house with a door and windows, a paddock, a
 * slab path, a pond, a meadow, rails, a staircase, a glass box, snow, lava.
 *
 * Run with: npm run showcase
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import * as nbt from './nbt-write.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const WORLD_DIR = path.join(__dirname, '..', 'data', 'showcase');
const REGION_DIR = path.join(WORLD_DIR, 'region');

const DATA_VERSION = 3465;      // 1.20.1
const SECTION_Y = [3, 4, 5];    // y 48..95
const CHUNKS = 4;               // 64x64 blocks
const GROUND = 63;              // topmost solid block of the plain
const MASK64 = (1n << 64n) - 1n;

// --- bit packing, as 1.16+ writes it ---------------------------------------
function packPadded(indices, bits) {
  if (bits === 0) return [];
  const perLong = Math.floor(64 / bits);
  const longs = new Array(Math.ceil(indices.length / perLong)).fill(0n);
  const mask = (1n << BigInt(bits)) - 1n;
  for (let i = 0; i < indices.length; i++) {
    const li = Math.floor(i / perLong);
    const off = BigInt((i % perLong) * bits);
    longs[li] = (longs[li] | ((BigInt(indices[i]) & mask) << off)) & MASK64;
  }
  return longs.map((v) => (v >= (1n << 63n) ? v - (1n << 64n) : v));
}
const blockBits = (n) => (n <= 1 ? 0 : Math.max(4, Math.ceil(Math.log2(n))));
const biomeBits = (n) => (n <= 1 ? 0 : Math.max(1, Math.ceil(Math.log2(n))));

// --- the build ---------------------------------------------------------------

const placed = new Map(); // "x,y,z" -> { name, props }

const put = (x, y, z, name, props) => {
  if (x < 0 || z < 0 || x > 63 || z > 63 || y < 48 || y > 95) return;
  placed.set(`${x},${y},${z}`, { name: `minecraft:${name}`, props: props || null });
};
const fill = (x0, y0, z0, x1, y1, z1, name, props) => {
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) put(x, y, z, name, props);
  }
};

/** Deterministic noise, so the same world comes out every time. */
function rand(x, z, salt) {
  let h = (x * 374761393 + z * 668265263 + salt * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function build() {
  // --- una casa, con porta, finestre e tetto -------------------------------
  fill(8, GROUND, 8, 18, GROUND, 16, 'oak_planks');
  for (let y = GROUND + 1; y <= GROUND + 3; y++) {
    for (let x = 8; x <= 18; x++) { put(x, y, 8, 'cobblestone'); put(x, y, 16, 'cobblestone'); }
    for (let z = 8; z <= 16; z++) { put(8, y, z, 'cobblestone'); put(18, y, z, 'cobblestone'); }
  }
  for (const x of [10, 12, 15, 17]) {
    put(x, GROUND + 2, 8, 'glass_pane');
    put(x, GROUND + 2, 16, 'glass_pane');
  }
  for (const z of [10, 13]) {
    put(8, GROUND + 2, z, 'glass_pane');
    put(18, GROUND + 2, z, 'glass_pane');
  }
  put(13, GROUND + 1, 8, 'oak_door', { facing: 'south', half: 'lower', hinge: 'left', open: 'false' });
  put(13, GROUND + 2, 8, 'oak_door', { facing: 'south', half: 'upper', hinge: 'left', open: 'false' });
  // tetto: una lastra di slab, con la gronda di scale tutt'intorno
  fill(9, GROUND + 4, 9, 17, GROUND + 4, 15, 'oak_slab', { type: 'bottom' });
  for (let x = 8; x <= 18; x++) {
    put(x, GROUND + 4, 8, 'oak_stairs', { facing: 'north', half: 'bottom', shape: 'straight' });
    put(x, GROUND + 4, 16, 'oak_stairs', { facing: 'south', half: 'bottom', shape: 'straight' });
  }
  for (let z = 9; z <= 15; z++) {
    put(8, GROUND + 4, z, 'oak_stairs', { facing: 'west', half: 'bottom', shape: 'straight' });
    put(18, GROUND + 4, z, 'oak_stairs', { facing: 'east', half: 'bottom', shape: 'straight' });
  }
  put(10, GROUND + 1, 10, 'crafting_table');
  put(16, GROUND + 1, 14, 'chest', { facing: 'west' });
  put(11, GROUND + 3, 9, 'torch');
  put(16, GROUND + 3, 15, 'torch');

  // --- un recinto con un cancello ------------------------------------------
  for (let x = 24; x <= 34; x++) {
    put(x, GROUND + 1, 8, 'oak_fence');
    if (x !== 29) put(x, GROUND + 1, 16, 'oak_fence');
  }
  for (let z = 9; z <= 15; z++) { put(24, GROUND + 1, z, 'oak_fence'); put(34, GROUND + 1, z, 'oak_fence'); }
  put(29, GROUND + 1, 16, 'oak_fence_gate', { facing: 'south', open: 'false' });
  for (let i = 0; i < 24; i++) {
    const x = 25 + Math.floor(rand(i, 3, 7) * 9);
    const z = 9 + Math.floor(rand(i, 5, 11) * 7);
    put(x, GROUND + 1, z, rand(i, 1, 2) > 0.5 ? 'short_grass' : 'dandelion');
  }

  // --- un sentiero di lastre, e un muretto ---------------------------------
  for (let x = 19; x <= 45; x++) put(x, GROUND + 1, 12, 'stone_slab', { type: 'bottom' });
  for (let x = 4; x <= 20; x++) put(x, GROUND + 1, 24, 'cobblestone_wall');

  // --- un laghetto ----------------------------------------------------------
  for (let z = 20; z <= 32; z++) {
    for (let x = 40; x <= 52; x++) {
      const d = Math.hypot(x - 46, z - 26);
      if (d > 6.2) continue;
      const depth = d > 4.5 ? 1 : d > 2.5 ? 2 : 3;
      for (let y = GROUND; y > GROUND - depth; y--) put(x, y, z, 'water');
      put(x, GROUND - depth, z, d > 5 ? 'sand' : 'gravel');
      if (d > 5.6) put(x, GROUND, z, 'sand');
    }
  }
  for (let i = 0; i < 10; i++) {
    put(41 + Math.floor(rand(i, 9, 3) * 10), GROUND, 21 + Math.floor(rand(i, 4, 8) * 10), 'lily_pad');
  }

  // --- un prato fiorito ----------------------------------------------------
  const flowers = ['poppy', 'dandelion', 'cornflower', 'oxeye_daisy', 'short_grass',
    'short_grass', 'short_grass', 'fern', 'oak_sapling'];
  for (let z = 30; z <= 50; z++) {
    for (let x = 4; x <= 30; x++) {
      const r = rand(x, z, 17);
      if (r > 0.42) continue;
      put(x, GROUND + 1, z, flowers[Math.floor(r * 9 / 0.42) % flowers.length]);
    }
  }

  // --- un albero -------------------------------------------------------------
  const [tx, tz] = [22, 22];
  fill(tx, GROUND + 1, tz, tx, GROUND + 5, tz, 'oak_log', { axis: 'y' });
  for (let y = GROUND + 4; y <= GROUND + 7; y++) {
    const r = y >= GROUND + 6 ? 1 : 2;
    for (let z = tz - r; z <= tz + r; z++) {
      for (let x = tx - r; x <= tx + r; x++) {
        if (x === tx && z === tz && y <= GROUND + 5) continue;
        if (Math.abs(x - tx) === r && Math.abs(z - tz) === r && r > 1) continue;
        put(x, y, z, 'oak_leaves');
      }
    }
  }

  // --- una scalinata su una piattaforma ------------------------------------
  fill(26, GROUND + 1, 40, 32, GROUND + 4, 46, 'stone_bricks');
  fill(27, GROUND + 5, 41, 31, GROUND + 5, 45, 'stone_brick_slab', { type: 'bottom' });
  for (let i = 0; i < 4; i++) {
    for (let z = 42; z <= 44; z++) {
      put(25 - i, GROUND + 4 - i, z, 'stone_brick_stairs',
        { facing: 'east', half: 'bottom', shape: 'straight' });
      fill(25 - i, GROUND + 1, z, 25 - i, GROUND + 3 - i, z, 'stone_bricks');
    }
  }
  put(27, GROUND + 6, 41, 'lantern');
  put(31, GROUND + 6, 45, 'lantern');

  // --- una scatola di vetro, per la trasparenza ------------------------------
  fill(54, GROUND + 1, 38, 58, GROUND + 4, 42, 'glass');
  fill(55, GROUND + 1, 39, 57, GROUND + 3, 41, 'air');
  put(56, GROUND + 1, 40, 'gold_block');
  put(56, GROUND + 2, 40, 'redstone_block');

  // --- neve, binari, lava ---------------------------------------------------
  for (let z = 4; z <= 16; z++) {
    for (let x = 48; x <= 60; x++) {
      const layers = 1 + Math.floor(rand(x, z, 31) * 5);
      put(x, GROUND + 1, z, 'snow', { layers: String(layers) });
    }
  }
  for (let x = 4; x <= 44; x++) put(x, GROUND + 1, 55, 'rail', { shape: 'east_west' });
  fill(56, GROUND, 54, 59, GROUND, 57, 'lava');
  put(58, GROUND + 1, 52, 'oak_fence');
}

// --- terrain underneath ------------------------------------------------------
function baseBlock(y) {
  if (y > GROUND) return 'minecraft:air';
  if (y === GROUND) return 'minecraft:grass_block';
  if (y > GROUND - 4) return 'minecraft:dirt';
  return 'minecraft:stone';
}

function blockAt(x, y, z) {
  const set = placed.get(`${x},${y},${z}`);
  if (set) return set.name === 'minecraft:air' ? { name: 'minecraft:air', props: null } : set;
  return { name: baseBlock(y), props: null };
}

// --- writing the save --------------------------------------------------------

const paletteKey = (b) => (b.props ? `${b.name}|${JSON.stringify(b.props)}` : b.name);

function buildSection(cx, cz, secY) {
  const yBase = secY * 16;
  const entries = [];
  const index = new Map();
  const indices = new Int32Array(4096);
  for (let ly = 0; ly < 16; ly++) {
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const b = blockAt(cx * 16 + lx, yBase + ly, cz * 16 + lz);
        const key = paletteKey(b);
        let i = index.get(key);
        if (i === undefined) { i = entries.length; entries.push(b); index.set(key, i); }
        indices[(ly << 8) | (lz << 4) | lx] = i;
      }
    }
  }
  const section = {
    Y: new nbt.TByte(secY),
    block_states: {
      palette: new nbt.TList(nbt.TAG.Compound, entries.map(
        (b) => (b.props ? { Name: b.name, Properties: b.props } : { Name: b.name }))),
    },
    biomes: { palette: new nbt.TList(nbt.TAG.String, ['minecraft:plains']) },
  };
  const bits = blockBits(entries.length);
  if (bits > 0) section.block_states.data = new nbt.TLongArray(packPadded(indices, bits));
  return section;
}

function buildChunk(cx, cz) {
  return nbt.deflate(nbt.build('', {
    DataVersion: DATA_VERSION,
    xPos: cx, zPos: cz, yPos: -4,
    Status: 'minecraft:full',
    sections: new nbt.TList(nbt.TAG.Compound, SECTION_Y.map((y) => buildSection(cx, cz, y))),
  }));
}

function buildRegion(chunks) {
  const header = Buffer.alloc(8192);
  const body = [];
  let nextSector = 2;
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

export function generate({ quiet = false } = {}) {
  placed.clear();
  build();
  fs.mkdirSync(REGION_DIR, { recursive: true });
  const chunks = new Map();
  for (let cz = 0; cz < CHUNKS; cz++) {
    for (let cx = 0; cx < CHUNKS; cx++) chunks.set(`${cx},${cz}`, buildChunk(cx, cz));
  }
  fs.writeFileSync(path.join(REGION_DIR, 'r.0.0.mca'), buildRegion(chunks));
  fs.writeFileSync(path.join(WORLD_DIR, 'level.dat'), nbt.gzip(nbt.build('', {
    Data: {
      LevelName: 'Cube-Atlas Showcase',
      DataVersion: DATA_VERSION,
      SpawnX: 32, SpawnY: GROUND + 1, SpawnZ: 32,
      Version: { Name: '1.20.1', Id: DATA_VERSION },
      Player: { Pos: new nbt.TList(nbt.TAG.Double, [13.5, GROUND + 1, 20.5]) },
    },
  })));
  if (!quiet) console.log(`Mondo vetrina generato in ${WORLD_DIR}`);
  return WORLD_DIR;
}

export { WORLD_DIR, GROUND, blockAt };

if (process.argv[1] && process.argv[1].endsWith('make-showcase-world.js')) generate();
