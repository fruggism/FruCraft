/*
 * Editing one chunk (1.18+ format) without disturbing what it doesn't touch.
 *
 * The chunk is a typed NBT tree (see nbt.js, { typed: true }). A ChunkEditor
 * decodes only the sections somebody reads or writes into palette + 4096 (or
 * 64, for biomes) indices, lets the caller change them, and on commit() packs
 * those sections back and fixes everything that depends on them. Every key it
 * doesn't know — mods, structures, blending data, ... — is left exactly alone.
 *
 * After blocks change, commit():
 *   - drops SkyLight/BlockLight from the touched sections and sets isLightOn
 *     to 0, so the game relights the chunk when it loads it;
 *   - recomputes the heightmaps the chunk already had;
 *   - removes block entities, block ticks and fluid ticks of replaced blocks.
 */

import { TAG, TByte, TList } from '../../web/js/core/nbt.js';
import {
  readPaddedPacked, readSpanningPacked, blockBits, biomeBits, AIR_NAMES, WATER_NAMES,
} from '../../web/js/core/anvil.js';

export const MIN_DATA_VERSION = 2860;   // 1.18: the chunk format the editor writes
const DV_PADDED_PACKING = 2529;
const MASK64 = (1n << 64n) - 1n;

export const AIR_STATE = Object.freeze({ Name: 'minecraft:air' });

// ---------------------------------------------------------------------------
// Block states
// ---------------------------------------------------------------------------

/** Canonical key of a state: name plus properties sorted by name. */
export function stateKey(state) {
  const p = state.Properties;
  if (!p) return state.Name;
  const keys = Object.keys(p).sort();
  if (!keys.length) return state.Name;
  return `${state.Name}[${keys.map((k) => `${k}=${p[k]}`).join(',')}]`;
}

/** 'oak_stairs[facing=east]' -> { Name: 'minecraft:oak_stairs', Properties: {...} } */
export function parseState(text) {
  const m = /^([^[\]]+)(?:\[(.*)\])?$/.exec(text.trim());
  if (!m) throw new Error(`Stato di blocco non valido: ${text}`);
  const Name = m[1].includes(':') ? m[1] : `minecraft:${m[1]}`;
  if (!m[2]) return { Name };
  const Properties = {};
  for (const pair of m[2].split(',')) {
    const [k, v] = pair.split('=').map((s) => s.trim());
    if (!k || v === undefined) throw new Error(`Proprietà non valida in: ${text}`);
    Properties[k] = v;
  }
  return { Name, Properties };
}

const items = (list) => (list instanceof TList ? list.items : Array.isArray(list) ? list : []);
const asList = (type, arr) => new TList(arr.length ? type : TAG.End, arr);

/** A palette entry as plain strings, whatever the tree's tag types. */
function stateFromTag(tag) {
  if (typeof tag === 'string') return { Name: tag };
  const out = { Name: tag.Name };
  if (tag.Properties && Object.keys(tag.Properties).length) out.Properties = { ...tag.Properties };
  return out;
}

function stateToTag(state) {
  const tag = { Name: state.Name };
  if (state.Properties && Object.keys(state.Properties).length) tag.Properties = { ...state.Properties };
  return tag;
}

// ---------------------------------------------------------------------------
// Bit packing
// ---------------------------------------------------------------------------

/** Pack indices into longs. Padded (>=1.16): a value never spans two longs. */
export function packIndices(indices, bits, padded) {
  if (bits === 0) return new BigInt64Array(0);
  const mask = (1n << BigInt(bits)) - 1n;
  if (padded) {
    const perLong = Math.floor(64 / bits);
    const longs = new Array(Math.ceil(indices.length / perLong)).fill(0n);
    for (let i = 0; i < indices.length; i++) {
      const li = Math.floor(i / perLong);
      longs[li] |= (BigInt(indices[i]) & mask) << BigInt((i % perLong) * bits);
    }
    return BigInt64Array.from(longs.map((v) => BigInt.asIntN(64, v & MASK64)));
  }
  const longs = new Array(Math.ceil((indices.length * bits) / 64)).fill(0n);
  for (let i = 0; i < indices.length; i++) {
    const bit = i * bits;
    const li = bit >> 6;
    const off = BigInt(bit & 63);
    const v = BigInt(indices[i]) & mask;
    longs[li] |= (v << off) & MASK64;
    if (Number(off) + bits > 64) longs[li + 1] |= v >> (64n - off);
  }
  return BigInt64Array.from(longs.map((v) => BigInt.asIntN(64, v & MASK64)));
}

export function unpackIndices(longs, bits, count, padded) {
  const out = new Uint16Array(count);
  if (bits === 0 || !longs || longs.length === 0) return out;
  const read = padded ? readPaddedPacked : readSpanningPacked;
  for (let i = 0; i < count; i++) out[i] = read(longs, bits, i);
  return out;
}

// ---------------------------------------------------------------------------
// Heightmaps
// ---------------------------------------------------------------------------

/*
 * Blocks the player walks through. Used only to recompute the heightmaps, and
 * deliberately a list of name patterns rather than the game's own block
 * properties, which aren't in the save: where it is wrong, a heightmap is off
 * by a block over decorations, and the game re-primes a heightmap that is
 * missing (see `heightmaps: 'drop'` in ChunkEditor.commit).
 */
const PASSABLE = /(^|_)(grass|fern|flower|flowers|sapling|torch|rail|rails|sign|button|carpet|vine|vines|roots|sprouts|mushroom|dead_bush|seagrass|kelp|kelp_plant|coral_fan|banner|lever|tripwire|tripwire_hook|redstone_wire|redstone_torch|fire|soul_fire|cobweb|rose_bush|peony|lilac|sunflower|dandelion|poppy|orchid|allium|bluet|tulip|daisy|cornflower|lily_of_the_valley|wither_rose|torchflower|pitcher_plant|pink_petals|moss_carpet|snow|light|barrier|structure_void|nether_sprouts|crimson_roots|warped_roots|hanging_roots|spore_blossom|glow_lichen|lichen|sculk_vein|ladder|scaffolding|string|bamboo_sapling|sweet_berry_bush|wheat|carrots|potatoes|beetroots|nether_wart|pumpkin_stem|melon_stem|attached_pumpkin_stem|attached_melon_stem|powder_snow|end_rod|candle)$/;

const baseName = (name) => name.slice(name.indexOf(':') + 1);
const isAir = (name) => AIR_NAMES.has(name);
const isFluid = (name) => WATER_NAMES.has(name) || name === 'minecraft:lava';
const isPassable = (name) => PASSABLE.test(baseName(name));
const isLeaves = (name) => baseName(name).endsWith('_leaves');

const HEIGHTMAP_RULES = {
  WORLD_SURFACE: (n) => !isAir(n),
  OCEAN_FLOOR: (n) => !isAir(n) && !isFluid(n) && !isPassable(n),
  MOTION_BLOCKING: (n) => !isAir(n) && (isFluid(n) || !isPassable(n)),
  MOTION_BLOCKING_NO_LEAVES: (n) => !isAir(n) && !isLeaves(n) && (isFluid(n) || !isPassable(n)),
};

export const heightmapBits = (height) => Math.ceil(Math.log2(height + 1));

// ---------------------------------------------------------------------------
// ChunkEditor
// ---------------------------------------------------------------------------

export class ChunkEditor {
  /**
   * @param root  typed chunk root (what RegionData.getChunk returns as .value)
   * @param opts  minY / height of the dimension (default -64 / 384)
   */
  constructor(root, { minY = -64, height = 384 } = {}) {
    this.root = root;
    this.dataVersion = Number(root.DataVersion || 0);
    if (!Array.isArray(items(root.sections)) || !(root.sections instanceof TList)) {
      throw new Error('Formato del chunk non supportato (servono i chunk 1.18+)');
    }
    this.padded = this.dataVersion >= DV_PADDED_PACKING;
    this.minY = minY;
    this.height = height;
    this.minSectionY = Math.floor(minY / 16);
    this.maxSectionY = Math.floor((minY + height - 1) / 16);
    this.cache = new Map();          // sectionY -> decoded section
    this.changedBlocks = new Set();  // "x,y,z" of blocks whose state changed
    this.touchedBlocks = new Set();  // section Y of sections with block changes
    this.biomesChanged = false;
  }

  /** The chunk's own position, from the chunk itself. */
  get xPos() { return Number(this.root.xPos); }
  get zPos() { return Number(this.root.zPos); }

  tagFor(sy) {
    return items(this.root.sections).find((s) => Number(s.Y instanceof Object ? s.Y.v : s.Y) === sy) || null;
  }

  section(sy, create = false) {
    let sec = this.cache.get(sy);
    if (sec) return sec;
    const tag = this.tagFor(sy);
    if (!tag && !create) return null;
    if (sy < this.minSectionY || sy > this.maxSectionY) return null;
    sec = tag ? this.decode(sy, tag) : this.empty(sy);
    this.cache.set(sy, sec);
    return sec;
  }

  decode(sy, tag) {
    const bs = tag.block_states || {};
    const palette = items(bs.palette).map(stateFromTag);
    if (!palette.length) palette.push({ ...AIR_STATE });
    const blocks = unpackIndices(bs.data, blockBits(palette.length), 4096, this.padded);
    const bio = tag.biomes || {};
    const biomePalette = items(bio.palette).map((b) => String(b));
    if (!biomePalette.length) biomePalette.push('minecraft:plains');
    const biomes = unpackIndices(bio.data, biomeBits(biomePalette.length), 64, this.padded);
    return { sy, tag, palette, blocks, biomePalette, biomes, blocksDirty: false, biomesDirty: false, isNew: false };
  }

  empty(sy) {
    return {
      sy, tag: null, palette: [{ ...AIR_STATE }], blocks: new Uint16Array(4096),
      biomePalette: ['minecraft:plains'], biomes: new Uint16Array(64),
      blocksDirty: true, biomesDirty: true, isNew: true,
    };
  }

  /** Block state at world (x, y, z), or null if the chunk has no such section. */
  getState(x, y, z) {
    const sec = this.section(y >> 4);
    if (!sec) return { ...AIR_STATE };
    return sec.palette[sec.blocks[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)]];
  }

  setState(x, y, z, state) {
    const sec = this.section(y >> 4, true);
    if (!sec) throw new Error(`Quota fuori dal mondo: ${y}`);
    const key = stateKey(state);
    let idx = sec.palette.findIndex((s) => stateKey(s) === key);
    if (idx < 0) { sec.palette.push(stateFromTag(state)); idx = sec.palette.length - 1; }
    const at = ((y & 15) << 8) | ((z & 15) << 4) | (x & 15);
    if (sec.blocks[at] === idx) return false;
    sec.blocks[at] = idx;
    sec.blocksDirty = true;
    this.changedBlocks.add(`${x},${y},${z}`);
    this.touchedBlocks.add(sec.sy);
    return true;
  }

  getBiome(x, y, z) {
    const sec = this.section(y >> 4);
    if (!sec) return null;
    return sec.biomePalette[sec.biomes[(((y & 15) >> 2) << 4) | (((z & 15) >> 2) << 2) | ((x & 15) >> 2)]];
  }

  setBiome(x, y, z, biome) {
    const sec = this.section(y >> 4, true);
    if (!sec) throw new Error(`Quota fuori dal mondo: ${y}`);
    let idx = sec.biomePalette.indexOf(biome);
    if (idx < 0) { sec.biomePalette.push(biome); idx = sec.biomePalette.length - 1; }
    const at = (((y & 15) >> 2) << 4) | (((z & 15) >> 2) << 2) | ((x & 15) >> 2);
    if (sec.biomes[at] === idx) return false;
    sec.biomes[at] = idx;
    sec.biomesDirty = true;
    this.biomesChanged = true;
    return true;
  }

  /**
   * Write every change back into the tree and fix what depends on it.
   * options.heightmaps: 'recompute' (default) or 'drop' — drop leaves the game
   * to rebuild the ones it finds missing.
   */
  commit({ heightmaps = 'recompute' } = {}) {
    const root = this.root;
    const sections = items(root.sections).slice();

    for (const sec of this.cache.values()) {
      if (!sec.blocksDirty && !sec.biomesDirty) continue;
      let tag = sec.tag;
      if (!tag) {
        tag = { Y: new TByte(sec.sy) };
        sections.push(tag);
        sec.tag = tag;
      }
      if (sec.blocksDirty) {
        const { palette, blocks } = compact(sec.palette, sec.blocks);
        const block_states = { palette: asList(TAG.Compound, palette.map(stateToTag)) };
        if (palette.length > 1) {
          block_states.data = packIndices(blocks, blockBits(palette.length), this.padded);
        }
        tag.block_states = block_states;
        delete tag.SkyLight;
        delete tag.BlockLight;
      }
      if (sec.biomesDirty) {
        const { palette, blocks } = compact(sec.biomePalette, sec.biomes);
        const biomes = { palette: asList(TAG.String, palette) };
        if (palette.length > 1) biomes.data = packIndices(blocks, biomeBits(palette.length), this.padded);
        tag.biomes = biomes;
      }
      sec.blocksDirty = false;
      sec.biomesDirty = false;
    }
    sections.sort((a, b) => Number(a.Y.v ?? a.Y) - Number(b.Y.v ?? b.Y));
    root.sections = new TList(TAG.Compound, sections);

    if (this.changedBlocks.size) {
      root.isLightOn = new TByte(0);
      this.dropBlockData();
      this.fixHeightmaps(heightmaps);
      this.changedBlocks.clear();
      this.touchedBlocks.clear();
    }
    return root;
  }

  /** Block entities and scheduled ticks of blocks that were replaced. */
  dropBlockData() {
    const gone = (e) => this.changedBlocks.has(`${e.x},${e.y},${e.z}`);
    for (const key of ['block_entities', 'block_ticks', 'fluid_ticks']) {
      const list = this.root[key];
      if (!(list instanceof TList) || !list.items.length) continue;
      list.items = list.items.filter((e) => !gone(e));
      if (!list.items.length) list.itemType = TAG.End;
    }
  }

  fixHeightmaps(mode) {
    const hm = this.root.Heightmaps;
    if (!hm) return;
    if (mode === 'drop') { delete this.root.Heightmaps; return; }
    const bits = heightmapBits(this.height);
    const lastSy = this.maxSectionY;
    for (const name of Object.keys(hm)) {
      const rule = HEIGHTMAP_RULES[name];
      if (!rule) continue;
      const out = new Uint16Array(256);
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          let h = 0;
          for (let sy = lastSy; sy >= this.minSectionY && !h; sy--) {
            const sec = this.section(sy);
            if (!sec) continue;
            for (let ly = 15; ly >= 0; ly--) {
              const st = sec.palette[sec.blocks[(ly << 8) | (z << 4) | x]];
              if (rule(st.Name)) { h = sy * 16 + ly - this.minY + 1; break; }
            }
          }
          out[z * 16 + x] = h;
        }
      }
      hm[name] = packIndices(out, bits, this.padded);
    }
  }
}

/** Drop unused palette entries and renumber the indices. */
function compact(palette, indices) {
  const remap = new Map();
  const next = [];
  const out = new Uint16Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    const old = indices[i];
    let n = remap.get(old);
    if (n === undefined) { n = next.length; remap.set(old, n); next.push(palette[old]); }
    out[i] = n;
  }
  return { palette: next, blocks: out };
}
