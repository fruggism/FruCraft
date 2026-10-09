/*
 * Terrain: smoothing the seam around a rectangle — typically a piece just
 * pasted — so its ground meets the world around it with a slope instead of
 * a wall or a pit.
 *
 *   { type: 'smoothTerrain', dim, box, sides, bin, bout, rim, sea, wobble,
 *     trees, tree, seed, prof }
 *
 * Along each chosen side (n, s, w, e) a band runs from `bin` blocks inside
 * the box to `bout` blocks outside it. A column in the band gets a new ground
 * height on a smoothstep ramp between the ground `bin` blocks inside (hIn)
 * and the ground `bout` blocks outside (hOut), measured at the same place
 * along the side. Inside the box the ground never drops below `rim` (when
 * set) — a basin keeps its edge and the sea stays out. Below `sea` the ramp is
 * sand under water; above it grass on dirt on stone. Vegetation, ice and old
 * ground above the new surface go. A column with anything built in it is
 * left alone.
 *
 * Those reference heights live in other chunks, and an operation is applied
 * one chunk at a time, so they are measured once, when the operation is made
 * (computeProfiles), and travel inside it in `prof`. Each chunk then needs
 * nothing but itself and the operation.
 *
 * `wobble` moves the band's inner and outer limits in and out along the side
 * (smooth noise, up to that many blocks) so the seam isn't a ruler line.
 * `trees` (0..1) plants trees on the new grass; `tree` is a wood ('oak',
 * 'spruce', ...) or 'auto' for the wood most cleared in that chunk.
 */

import { RegionData } from './region.js';
import { ChunkEditor } from './chunk.js';
import { dimensionInfo } from './dimensions.js';

export const SIDES = ['n', 's', 'w', 'e'];
export const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'cherry', 'mangrove', 'pale_oak'];

/** Ground: what the new surface is made of, and what is looked through. */
const TERRAIN = /^minecraft:(grass_block|dirt|coarse_dirt|rooted_dirt|podzol|mycelium|mud|clay|gravel|sand|red_sand|sandstone|red_sandstone|stone|deepslate|tuff|granite|diorite|andesite|calcite|dripstone_block|smooth_basalt|basalt|snow_block|moss_block|pale_moss_block|terracotta|\w+_terracotta|packed_ice|blue_ice|\w+_ore|bedrock|obsidian|magma_block|soul_sand|dirt_path|farmland|suspicious_\w+)$/;
const CLEAR = /^minecraft:(air|cave_air|water|ice|snow|powder_snow|\w+_leaves|\w+_log|\w+_wood|\w+_stem|vine|glow_lichen|short_grass|tall_grass|fern|large_fern|dead_bush|bush|\w+_bush|seagrass|tall_seagrass|kelp|kelp_plant|sugar_cane|lily_pad|\w+_tulip|poppy|dandelion|\w+_orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|sunflower|lilac|rose_bush|peony|pink_petals|wildflowers|leaf_litter|\w+_mushroom|\w+_mushroom_block|mushroom_stem|moss_carpet|pale_moss_carpet|bamboo|cocoa|mangrove_roots|muddy_mangrove_roots|hanging_roots|spore_blossom|azalea|flowering_azalea|\w+_sapling|pumpkin|melon|cactus|cactus_flower|bubble_column|sea_pickle|\w+_coral\w*|bee_nest|pointed_dripstone|small_dripleaf|big_dripleaf\w*|resin_clump|pale_hanging_moss|short_dry_grass|tall_dry_grass|\w+_eyeblossom|torchflower|pitcher_plant|firefly_bush)$/;

const LOG = /^minecraft:(\w+?)_(log|wood|stem)$/;

/**
 * Ground height of a column: the highest ground block, looking through
 * vegetation, water and ice. null when something built is in the way.
 */
export function groundOf(ed, x, z, top, bottom) {
  for (let y = top; y >= bottom; y--) {
    const n = ed.getState(x, y, z).Name;
    if (CLEAR.test(n)) continue;
    if (TERRAIN.test(n)) return y;
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Geometry shared by the profiles and the operation
// ---------------------------------------------------------------------------

/** Length of a side's profile: blocks along it. */
const sideLength = (box, side) => (side === 'w' || side === 'e' ? box.maxZ - box.minZ + 1 : box.maxX - box.minX + 1);

/** Where a profile is measured: the column `off` blocks from the side (negative = inside), `i` along it. */
function probeAt(box, side, i, off) {
  switch (side) {
    case 'w': return [box.minX - off, box.minZ + i];
    case 'e': return [box.maxX + off, box.minZ + i];
    case 'n': return [box.minX + i, box.minZ - off];
    default: return [box.minX + i, box.maxZ + off];
  }
}

/**
 * Which side, how far from it (negative inside) and how far along it a column
 * is — or null outside the band. Corners outside the box blend the two sides.
 */
function bandOf(op, x, z) {
  const { box, sides, bin, bout } = op;
  const on = new Set(sides);
  const inside = x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ;
  if (inside) {
    let best = null;
    for (const s of on) {
      const m = s === 'w' ? x - box.minX : s === 'e' ? box.maxX - x : s === 'n' ? z - box.minZ : box.maxZ - z;
      if (best === null || m < best.m) best = { m, side: s };
    }
    if (!best || best.m >= bin + op.wobble) return null;
    return { d: -best.m, inside: true, parts: [[best.side, best.side === 'w' || best.side === 'e' ? z - box.minZ : x - box.minX, 1]] };
  }
  const sx = x < box.minX ? 'w' : x > box.maxX ? 'e' : null;
  const sz = z < box.minZ ? 'n' : z > box.maxZ ? 's' : null;
  if ((sx && !on.has(sx)) || (sz && !on.has(sz))) return null;
  const ox = sx === 'w' ? box.minX - x : sx === 'e' ? x - box.maxX : 0;
  const oz = sz === 'n' ? box.minZ - z : sz === 's' ? z - box.maxZ : 0;
  const d = Math.hypot(ox, oz);
  if (d > bout + op.wobble) return null;
  if (!sz) return { d, inside: false, parts: [[sx, z - box.minZ, 1]] };
  if (!sx) return { d, inside: false, parts: [[sz, x - box.minX, 1]] };
  // Outside a corner: both sides, at their ends, weighted by direction.
  const wx = ox / (ox + oz);
  return {
    d, inside: false,
    parts: [[sx, sz === 'n' ? 0 : box.maxZ - box.minZ, wx], [sz, sx === 'w' ? 0 : box.maxX - box.minX, 1 - wx]],
  };
}

const smoothstep = (t) => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c); };

/** Deterministic 32-bit hash of a few integers. */
function hash(...v) {
  let h = 0x811c9dc5;
  for (const n of v) { h ^= n | 0; h = Math.imul(h, 0x01000193); h ^= h >>> 15; }
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  return (h ^ (h >>> 15)) >>> 0;
}
const unit = (...v) => hash(...v) / 0x100000000;

/** Smooth value noise in [-1, 1] along a side, one bump every ~24 blocks. */
function noise1(seed, side, t) {
  const k = SIDES.indexOf(side);
  const i = Math.floor(t / 24), f = t / 24 - i;
  const a = unit(seed, k, i) * 2 - 1, b = unit(seed, k, i + 1) * 2 - 1;
  return a + (b - a) * smoothstep(f);
}

// ---------------------------------------------------------------------------
// Profiles: measured once, from the world as it will be (pending changes included)
// ---------------------------------------------------------------------------

function smooth1d(a, w) {
  const out = new Array(a.length).fill(null);
  for (let i = 0; i < a.length; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(a.length - 1, i + w); j++) if (a[j] !== null) { s += a[j]; c++; }
    out[i] = c ? Math.round((s / c) * 10) / 10 : null;
  }
  return out;
}

/**
 * Ground heights along each chosen side, `bin` inside and `bout` outside.
 * @param source     a WorldSource (the session's overlay: pending changes count)
 * @param regionDir  the dimension's region folder in that source
 * @returns { [side]: { i: number[]|null[], o: number[]|null[] } }
 */
export async function computeProfiles({ source, regionDir, dim, box, sides, bin, bout }) {
  const info = dimensionInfo(dim);
  const top = info.minY + info.height - 1;
  const regions = new Map(), eds = new Map();
  const editor = async (cx, cz) => {
    const k = `${cx},${cz}`;
    if (eds.has(k)) return eds.get(k);
    const rk = `${cx >> 5},${cz >> 5}`;
    if (!regions.has(rk)) {
      const bytes = await source.readFile(`${regionDir}/r.${cx >> 5}.${cz >> 5}.mca`);
      regions.set(rk, bytes && bytes.length >= 8192 ? RegionData.fromBuffer(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), cx >> 5, cz >> 5) : null);
    }
    const r = regions.get(rk);
    let ed = null;
    if (r && r.has(cx & 31, cz & 31)) {
      try { ed = new ChunkEditor(r.getChunk(cx & 31, cz & 31).value, { minY: info.minY, height: info.height }); } catch { ed = null; }
    }
    eds.set(k, ed);
    return ed;
  };
  const ground = async (x, z) => { const ed = await editor(x >> 4, z >> 4); return ed ? groundOf(ed, x, z, top, info.minY) : null; };
  const prof = {};
  for (const side of sides) {
    const n = sideLength(box, side);
    const i = new Array(n), o = new Array(n);
    for (let k = 0; k < n; k++) {
      i[k] = await ground(...probeAt(box, side, k, -bin));
      o[k] = await ground(...probeAt(box, side, k, bout));
    }
    prof[side] = { i: smooth1d(i, 15), o: smooth1d(o, 15) };
  }
  return prof;
}

// ---------------------------------------------------------------------------
// The operation
// ---------------------------------------------------------------------------

export const SMOOTH = {
  bounds(op) {
    const { box, sides } = op;
    const pad = op.bout + op.wobble;
    const s = new Set(sides);
    return {
      minX: box.minX - (s.has('w') ? pad : 0), maxX: box.maxX + (s.has('e') ? pad : 0),
      minZ: box.minZ - (s.has('n') ? pad : 0), maxZ: box.maxZ + (s.has('s') ? pad : 0),
    };
  },

  validate(op) {
    if (!op.box || !Array.isArray(op.sides) || !op.sides.length || op.sides.some((s) => !SIDES.includes(s))) throw new Error('Scegli almeno un lato da raccordare.');
    if (!(op.bin >= 0 && op.bin <= 128 && op.bout >= 1 && op.bout <= 256)) throw new Error('Fasce non valide: dentro 0–128, fuori 1–256 blocchi.');
    if (!(op.wobble >= 0 && op.wobble <= 64)) throw new Error('Irregolarità fra 0 e 64 blocchi.');
    if (!(op.trees >= 0 && op.trees <= 1)) throw new Error('Densità degli alberi fra 0 e 100%.');
    if (op.tree !== 'auto' && !WOODS.includes(op.tree)) throw new Error(`Albero sconosciuto: ${op.tree}`);
    for (const s of op.sides) {
      const p = op.prof && op.prof[s];
      if (!p || p.i.length !== sideLength(op.box, s) || p.o.length !== p.i.length) throw new Error('Mancano le misure del terreno: ricrea il raccordo.');
    }
  },

  apply(op, ed, cx, cz) {
    const info = dimensionInfo(op.dim);
    const top = info.minY + info.height - 1;
    const sea = op.sea ?? 62;
    const st = (n, props) => (props ? { Name: `minecraft:${n}`, Properties: props } : { Name: `minecraft:${n}` });
    const logs = new Map();
    const planted = [];
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const x = cx * 16 + lx, z = cz * 16 + lz;
        const band = bandOf(op, x, z);
        if (!band) continue;
        // References, and the band's limits moved by the wobble.
        let hIn = 0, hOut = 0, w = 0, wob = 0;
        for (const [side, along, weight] of band.parts) {
          const p = op.prof[side];
          const k = Math.max(0, Math.min(p.i.length - 1, along));
          if (p.i[k] === null || p.o[k] === null) { w = 0; break; }
          hIn += p.i[k] * weight; hOut += p.o[k] * weight; w += weight;
          if (op.wobble) wob += noise1(op.seed | 0, side, along) * op.wobble * weight;
        }
        if (!w) continue;
        const lo = -(op.bin + wob), hi = op.bout + wob;
        if (band.d < lo || band.d > hi || hi <= lo) continue;
        const { inside } = band;
        let target = Math.round(hIn + (hOut - hIn) * smoothstep((band.d - lo) / (hi - lo)));
        if (inside && op.rim !== null && op.rim !== undefined) target = Math.max(target, op.rim);
        target = Math.max(info.minY + 1, Math.min(top - 8, target));
        const g = groundOf(ed, x, z, top, info.minY);
        if (g === null) continue;
        const under = target < sea;
        // Above the new surface: air, or water below sea level.
        for (let y = top; y > target; y--) {
          const n = ed.getState(x, y, z).Name;
          const m = LOG.exec(n);
          if (m) logs.set(m[1], (logs.get(m[1]) || 0) + 1);
          const want = y <= sea && (under || n === 'minecraft:water') ? 'minecraft:water' : 'minecraft:air';
          if (n !== want) ed.setState(x, y, z, { Name: want });
        }
        // The surface and the layers under it, down to where the old ground was.
        for (let y = target; y > Math.min(g, target - 4); y--) {
          const depth = target - y;
          ed.setState(x, y, z, st(under ? (depth < 3 ? 'sand' : 'sandstone') : depth === 0 ? 'grass_block' : depth < 4 ? 'dirt' : 'stone'));
        }
        // A tree, now and then, where the whole crown stays in this chunk.
        if (!under && op.trees > 0 && lx >= 2 && lx <= 13 && lz >= 2 && lz <= 13 && target + 9 < top
          && unit(op.seed | 0, x, z, 7) < op.trees / 30) planted.push([x, target, z]);
      }
    }
    if (!planted.length) return;
    const wood = op.tree === 'auto' ? ([...logs].sort((a, b) => b[1] - a[1])[0]?.[0] || 'oak') : op.tree;
    const log = st(`${WOODS.includes(wood) ? wood : 'oak'}_log`, { axis: 'y' });
    const leaves = st(`${WOODS.includes(wood) ? wood : 'oak'}_leaves`, { distance: '1', persistent: 'true', waterlogged: 'false' });
    const isAir = (x, y, z) => ed.getState(x, y, z).Name === 'minecraft:air';
    for (const [x, g, z] of planted) {
      if (ed.getState(x, g, z).Name !== 'minecraft:grass_block' || !isAir(x, g + 1, z)) continue;
      const h = 4 + (hash(op.seed | 0, x, z) % 3);
      ed.setState(x, g, z, st('dirt'));
      for (let y = g + 1; y <= g + h; y++) ed.setState(x, y, z, log);
      for (let y = g + h - 2; y <= g + h + 1; y++) {
        const r = y >= g + h ? 1 : 2;
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.abs(dx) === r && Math.abs(dz) === r && (r === 1 || unit(x, y, z, dx, dz) < 0.5)) continue;
            if (isAir(x + dx, y, z + dz)) ed.setState(x + dx, y, z + dz, leaves);
          }
        }
      }
    }
  },
};
