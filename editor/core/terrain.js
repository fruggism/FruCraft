/*
 * Terrain: the ground of a column, reshaping it, and things that grow on it.
 *
 * Two chunk operations live here (journal.js registers them):
 *
 *   setTerrain     — a height per column, already computed (see recipe.js), so
 *                    every chunk can be rebuilt on its own and the result never
 *                    depends on the order chunks are visited in.
 *   placeFeatures  — trees and plants at given positions, each with the Y of
 *                    the block it stands on, again resolved beforehand.
 *
 * "Ground" is what a column stands on once vegetation, water and air are
 * looked through: stone, dirt, sand, grass_block... and buildings too (planks
 * are not vegetation). Leaves, logs, flowers, snow layers are not ground.
 */

import { stateKey } from './chunk.js';
import { dimensionInfo } from './dimensions.js';
import { hash3 } from './blocks.js';
import { AIR_NAMES, WATER_NAMES } from '../../web/js/core/anvil.js';

const NOT_GROUND = /(_leaves|_log|_wood|_stem|_hyphae|sapling|propagule|flower|tulip|orchid|allium|bluet|daisy|poppy|dandelion|cornflower|lily|rose|peony|lilac|grass$|fern$|bush$|bushes$|vine|vines_plant|mushroom$|mushroom_block|roots$|sugar_cane|bamboo|cactus|kelp|seagrass|sea_pickle|^minecraft:snow$|dripleaf|spore_blossom|carpet$|pumpkin|melon|cocoa|torch|petals|leaf_litter|cobweb|eyeblossom|lava|fire$|chorus|azalea$|pitcher|sniffer|frogspawn|lichen|hanging_moss|pale_moss_carpet|sweet_berry|wheat|carrots|potatoes|beetroots|nether_wart|crop)/;

export const isAir = (name) => AIR_NAMES.has(name);
export const isWater = (name) => WATER_NAMES.has(name);
/** Can a column stand on this block? */
export const isGround = (name) => !AIR_NAMES.has(name) && !WATER_NAMES.has(name) && !NOT_GROUND.test(name);

/** Marker for "leave this column alone" in a height grid. */
export const KEEP = -32768;

/**
 * One column of a chunk: { ground, groundName, top, water } where ground is the
 * Y of the highest ground block (null when there is none), top the Y of the
 * highest non-air block (trees, buildings), water the Y of the highest water
 * block above the ground (null when dry).
 */
export function readColumn(ed, x, z) {
  let top = null, water = null;
  for (let sy = ed.maxSectionY; sy >= ed.minSectionY; sy--) {
    const sec = ed.section(sy);
    if (!sec) continue;
    if (sec.palette.every((s) => AIR_NAMES.has(s.Name))) continue;
    const at = ((z & 15) << 4) | (x & 15);
    for (let ly = 15; ly >= 0; ly--) {
      const name = sec.palette[sec.blocks[(ly << 8) | at]].Name;
      if (AIR_NAMES.has(name)) continue;
      const y = sy * 16 + ly;
      if (top === null) top = y;
      if (WATER_NAMES.has(name)) { if (water === null) water = y; continue; }
      if (isGround(name)) return { ground: y, groundName: name, top, water };
    }
  }
  return { ground: null, groundName: null, top, water };
}

// ---------------------------------------------------------------------------
// Height grids travel as base64 Int16 (little endian), row by row (z outer).
// ---------------------------------------------------------------------------

export function encodeHeights(arr) {
  const bytes = new Uint8Array(arr.length * 2);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < arr.length; i++) dv.setInt16(i * 2, arr[i], true);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function decodeHeights(text, count) {
  const s = atob(String(text));
  if (s.length !== count * 2) throw new Error(`Griglia delle altezze non valida: ${s.length / 2} valori invece di ${count}.`);
  const out = new Int16Array(count);
  for (let i = 0; i < count; i++) {
    const v = s.charCodeAt(i * 2) | (s.charCodeAt(i * 2 + 1) << 8);
    out[i] = v >= 0x8000 ? v - 0x10000 : v;
  }
  return out;
}

const decoded = new WeakMap();
function heightsOf(op) {
  let h = decoded.get(op);
  if (!h) { h = decodeHeights(op.heights, op.w * op.d); decoded.set(op, h); }
  return h;
}

const stateCache = new Map();
function state(text) {
  if (text && typeof text === 'object') return text;
  let s = stateCache.get(text);
  if (!s) {
    const m = /^([^[\]]+)(?:\[(.*)\])?$/.exec(String(text).trim());
    if (!m) throw new Error(`Stato di blocco non valido: ${text}`);
    s = { Name: m[1].includes(':') ? m[1] : `minecraft:${m[1]}` };
    if (m[2]) s.Properties = Object.fromEntries(m[2].split(',').map((p) => p.split('=').map((x) => x.trim())));
    stateCache.set(text, s);
  }
  return s;
}

const AIR = { Name: 'minecraft:air' };
const WATER = { Name: 'minecraft:water', Properties: { level: '0' } };
const BLOCK_NAME = /^(minecraft:)?[a-z0-9_]+(\[[a-z0-9_]+=[a-z0-9_]+(,[a-z0-9_]+=[a-z0-9_]+)*\])?$/;

function checkBlock(text, what) {
  if (text === null || text === undefined) return;
  if (!BLOCK_NAME.test(String(text))) throw new Error(`${what}: blocco non valido “${text}”.`);
}

// ---------------------------------------------------------------------------
// setTerrain
// ---------------------------------------------------------------------------

/*
 * op: { type: 'setTerrain', dim, x0, z0, w, d, heights (base64 Int16, KEEP =
 *       column untouched), top?, filler?, fillerDepth?, stone?, waterLevel?,
 *       underwater? }
 *
 * For each column with a height h:
 *   - everything above the old ground (trees, plants, snow, water) and above h
 *     becomes air — or water up to waterLevel;
 *   - h gets the top block, the fillerDepth blocks under it the filler;
 *   - when the ground rises, the gap down to the old ground is stone.
 * top/filler left out keep what the column had (its grass, its dirt).
 * Columns with no ground at all (void) are skipped.
 */
export const setTerrain = {
  bounds: (op) => ({ minX: op.x0, minZ: op.z0, maxX: op.x0 + op.w - 1, maxZ: op.z0 + op.d - 1 }),
  validate(op) {
    for (const k of ['x0', 'z0', 'w', 'd']) if (!Number.isInteger(op[k])) throw new Error(`Terreno: ${k} mancante.`);
    if (op.w < 1 || op.d < 1 || op.w * op.d > 1024 * 1024) throw new Error('Terreno: area non valida.');
    heightsOf(op);
    checkBlock(op.top, 'Terreno'); checkBlock(op.filler, 'Terreno'); checkBlock(op.stone, 'Terreno'); checkBlock(op.underwater, 'Terreno');
    if (op.fillerDepth !== undefined && !(op.fillerDepth >= 0 && op.fillerDepth <= 16)) throw new Error('Terreno: spessore del riempimento fra 0 e 16.');
  },
  apply(op, ed, cx, cz) {
    const H = heightsOf(op);
    const info = dimensionInfo(op.dim);
    const lo = info.minY + 1, hi = info.minY + info.height - 2;
    const depth = op.fillerDepth ?? 3;
    const stone = state(op.stone || 'minecraft:stone');
    const level = op.waterLevel === null || op.waterLevel === undefined ? null : Number(op.waterLevel);
    const x0 = Math.max(op.x0, cx * 16), x1 = Math.min(op.x0 + op.w - 1, cx * 16 + 15);
    const z0 = Math.max(op.z0, cz * 16), z1 = Math.min(op.z0 + op.d - 1, cz * 16 + 15);
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        let h = H[(z - op.z0) * op.w + (x - op.x0)];
        if (h === KEEP) continue;
        h = Math.max(lo, Math.min(hi, h));
        const col = readColumn(ed, x, z);
        if (col.ground === null) continue;
        const g = col.ground;
        const wet = level !== null && h < level;
        const top = wet ? state(op.underwater || 'minecraft:sand') : op.top ? state(op.top) : ed.getState(x, g, z);
        const below = ed.getState(x, g - 1, z);
        const filler = op.filler ? state(op.filler) : isGround(below.Name) ? below : state('minecraft:dirt');
        // Above the new surface: air, or water up to the level.
        const clearTo = Math.max(col.top ?? h, h, wet ? level : h);
        for (let y = h + 1; y <= clearTo; y++) ed.setState(x, y, z, level !== null && y <= level ? WATER : AIR);
        // Rising ground: stone from the old surface up to the filler.
        for (let y = g + 1; y < h - depth; y++) ed.setState(x, y, z, stone);
        for (let d = 1; d <= depth && h - d >= lo; d++) ed.setState(x, h - d, z, filler);
        ed.setState(x, h, z, top);
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Trees and plants
// ---------------------------------------------------------------------------

/*
 * Each species is drawn by a small deterministic recipe: the same position
 * and seed always give the same tree, so the preview is what Apply writes.
 */
export const TREES = {
  oak: { log: 'oak_log', leaves: 'oak_leaves', shape: 'round', h: [4, 6] },
  birch: { log: 'birch_log', leaves: 'birch_leaves', shape: 'round', h: [5, 7] },
  cherry: { log: 'cherry_log', leaves: 'cherry_leaves', shape: 'wide', h: [4, 6] },
  jungle: { log: 'jungle_log', leaves: 'jungle_leaves', shape: 'round', h: [6, 10] },
  acacia: { log: 'acacia_log', leaves: 'acacia_leaves', shape: 'flat', h: [5, 6] },
  spruce: { log: 'spruce_log', leaves: 'spruce_leaves', shape: 'cone', h: [7, 10] },
  dark_oak: { log: 'dark_oak_log', leaves: 'dark_oak_leaves', shape: 'big', h: [6, 8] },
  pale_oak: { log: 'pale_oak_log', leaves: 'pale_oak_leaves', shape: 'big', h: [6, 8] },
  mangrove: { log: 'mangrove_log', leaves: 'mangrove_leaves', shape: 'round', h: [5, 7] },
  azalea: { log: 'oak_log', leaves: 'azalea_leaves', shape: 'round', h: [3, 4] },
  shrub: { log: 'oak_log', leaves: 'oak_leaves', shape: 'shrub', h: [1, 1] },
};

/** Single plants; `tall` ones take two blocks (lower and upper half). */
export const PLANTS = {
  short_grass: {}, fern: {}, dandelion: {}, poppy: {}, blue_orchid: {}, allium: {}, azure_bluet: {},
  red_tulip: {}, orange_tulip: {}, white_tulip: {}, pink_tulip: {}, oxeye_daisy: {}, cornflower: {},
  lily_of_the_valley: {}, dead_bush: {}, brown_mushroom: {}, red_mushroom: {}, moss_carpet: {},
  tall_grass: { tall: true }, large_fern: { tall: true }, sunflower: { tall: true }, lilac: { tall: true },
  rose_bush: { tall: true }, peony: { tall: true }, pumpkin: {}, melon: {},
};

/** Largest horizontal reach of any feature from its position (blocks). */
export const FEATURE_REACH = 4;
export const FEATURE_KINDS = [...Object.keys(TREES), ...Object.keys(PLANTS)];

/* `short_grass` was called `grass` before 1.20.3 (DataVersion 3698). */
const plantName = (kind, dataVersion) => (kind === 'short_grass' && dataVersion && dataVersion < 3698 ? 'minecraft:grass' : `minecraft:${kind}`);

/**
 * Blocks of one feature: [[x, y, z, state, mode]], mode 'log' (replaces
 * anything but ground) or 'leaf' (only air and plants). `y` is the ground
 * block the feature stands on.
 */
export function featureBlocks([x, y, z, kind, size], seed = 0, dataVersion = 0) {
  const out = [];
  if (PLANTS[kind]) {
    const name = plantName(kind, dataVersion);
    if (PLANTS[kind].tall) {
      out.push([x, y + 1, z, { Name: name, Properties: { half: 'lower' } }, 'plant']);
      out.push([x, y + 2, z, { Name: name, Properties: { half: 'upper' } }, 'plant']);
    } else out.push([x, y + 1, z, { Name: name }, 'plant']);
    return out;
  }
  const t = TREES[kind];
  if (!t) return out;
  const r = (k) => hash3(x, z, k, seed);
  const h = Number.isInteger(size) && size >= 1 && size <= 24 ? size : t.h[0] + Math.floor(r(1) * (t.h[1] - t.h[0] + 1));
  const logs = [];
  const log = (lx, ly, lz) => { logs.push([lx, ly, lz]); out.push([lx, ly, lz, { Name: `minecraft:${t.log}`, Properties: { axis: 'y' } }, 'log']); };
  const leaves = new Map();
  const leaf = (lx, ly, lz) => { leaves.set(`${lx},${ly},${lz}`, [lx, ly, lz]); };
  /* A layer of leaves of radius rad around (cx, cz); corners dropped (some at random). */
  const layer = (ly, rad, cxo = 0, czo = 0, wide = 1) => {
    for (let dz = -rad; dz <= rad + wide - 1; dz++) {
      for (let dx = -rad; dx <= rad + wide - 1; dx++) {
        const ex = dx < 0 ? -dx : dx - (wide - 1), ez = dz < 0 ? -dz : dz - (wide - 1);
        if (rad > 0 && ex === rad && ez === rad && (rad === 1 || r(dx * 31 + dz * 7 + ly) < 0.6)) continue;
        leaf(x + cxo + dx, ly, z + czo + dz);
      }
    }
  };
  switch (t.shape) {
    case 'shrub':
      log(x, y + 1, z); layer(y + 1, 1); layer(y + 2, 1); leaf(x, y + 3, z);
      break;
    case 'cone': {
      for (let i = 1; i <= h; i++) log(x, y + i, z);
      leaf(x, y + h + 1, z);
      const radii = [1, 1, 2, 1, 2, 3, 2, 3, 2, 3];
      for (let i = 0; y + h - i >= y + 3 && i < radii.length; i++) layer(y + h - i, Math.min(radii[i], 1 + Math.floor((h - i) / 2)));
      break;
    }
    case 'flat':
      for (let i = 1; i <= h; i++) log(x, y + i, z);
      layer(y + h, 3); layer(y + h + 1, 1);
      break;
    case 'big':
      for (let i = 1; i <= h; i++) { log(x, y + i, z); log(x + 1, y + i, z); log(x, y + i, z + 1); log(x + 1, y + i, z + 1); }
      layer(y + h - 1, 3, 0, 0, 2); layer(y + h, 3, 0, 0, 2); layer(y + h + 1, 2, 0, 0, 2);
      break;
    case 'wide':
      for (let i = 1; i <= h; i++) log(x, y + i, z);
      layer(y + h - 2, 3); layer(y + h - 1, 2); layer(y + h, 2); layer(y + h + 1, 1);
      break;
    default: // round
      for (let i = 1; i <= h; i++) log(x, y + i, z);
      layer(y + h - 2, 2); layer(y + h - 1, 2); layer(y + h, 1); layer(y + h + 1, 1);
      leaves.delete(`${x + 1},${y + h + 1},${z + 1}`); leaves.delete(`${x - 1},${y + h + 1},${z - 1}`);
      leaves.delete(`${x + 1},${y + h + 1},${z - 1}`); leaves.delete(`${x - 1},${y + h + 1},${z + 1}`);
  }
  const logSet = new Set(logs.map((p) => p.join(',')));
  for (const [k, [lx, ly, lz]] of leaves) {
    if (logSet.has(k)) continue;
    // Leaves decay farther than 6 steps from a log: give them the real distance.
    let dist = 7;
    for (const [ax, ay, az] of logs) dist = Math.min(dist, Math.abs(ax - lx) + Math.abs(ay - ly) + Math.abs(az - lz));
    const props = { distance: String(Math.max(1, dist)), persistent: dist > 6 ? 'true' : 'false', waterlogged: 'false' };
    out.push([lx, ly, lz, { Name: `minecraft:${t.leaves}`, Properties: props }, 'leaf']);
  }
  return out;
}

const PLANT_SOIL = /grass_block|dirt|podzol|mycelium|moss_block|mud|farmland|rooted_dirt|sand$|red_sand|terracotta|pale_moss_block/;

/*
 * op: { type: 'placeFeatures', dim, items: [[x, y, z, kind, size?], ...], seed }
 * Items are placed in order; a tree's blocks outside this chunk are placed
 * when that chunk is visited (bounds include the reach).
 */
export const placeFeatures = {
  bounds(op) {
    if (!Array.isArray(op.items) || !op.items.length) return null;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const [x, , z] of op.items) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    return { minX: minX - FEATURE_REACH, minZ: minZ - FEATURE_REACH, maxX: maxX + FEATURE_REACH, maxZ: maxZ + FEATURE_REACH };
  },
  validate(op) {
    for (const it of op.items) {
      if (!Array.isArray(it) || !it.slice(0, 3).every(Number.isInteger)) throw new Error('Alberi e piante: posizione non valida.');
      if (!TREES[it[3]] && !PLANTS[it[3]]) throw new Error(`Specie sconosciuta: ${it[3]}`);
    }
  },
  apply(op, ed, cx, cz) {
    const info = dimensionInfo(op.dim);
    const lo = info.minY, hi = info.minY + info.height - 1;
    const x0 = cx * 16, z0 = cz * 16;
    for (const it of op.items) {
      if (it[0] + FEATURE_REACH < x0 || it[0] - FEATURE_REACH > x0 + 15 || it[2] + FEATURE_REACH < z0 || it[2] - FEATURE_REACH > z0 + 15) continue;
      const plant = !!PLANTS[it[3]];
      // A plant needs soil under it and air where it goes; the soil column is
      // the plant's own, so it is always in this chunk when the plant is.
      if (plant) {
        if (it[0] >> 4 !== cx || it[2] >> 4 !== cz) continue;
        if (!PLANT_SOIL.test(ed.getState(it[0], it[1], it[2]).Name)) continue;
      }
      for (const [x, y, z, st, mode] of featureBlocks(it, op.seed | 0, ed.dataVersion)) {
        if (x >> 4 !== cx || z >> 4 !== cz || y < lo || y > hi) continue;
        const cur = ed.getState(x, y, z).Name;
        const free = mode === 'log' ? !isGround(cur)
          : mode === 'leaf' ? isAir(cur) || (!isGround(cur) && !isWater(cur) && !/_log$|_wood$/.test(cur))
            : isAir(cur);
        if (!free) continue;
        if (stateKey(ed.getState(x, y, z)) !== stateKey(st)) ed.setState(x, y, z, st);
      }
    }
  },
};
