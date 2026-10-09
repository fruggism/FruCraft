/*
 * Paste: put a clip (see clips.js) into the world being edited.
 *
 *   { type: 'paste', dim, clip: '<clip folder>', name, mode, dx, dy, dz,
 *     air, biomes, from, to, selection, yMin, yMax }
 *
 * `from` is the clip's box in source coordinates, `to` the box it lands on;
 * dx/dy/dz the shift. Two modes:
 *
 *   chunks  Whole chunks, every block from bottom to top, exactly as they
 *           were: blocks, biomes, block entities, light and heightmaps. Only
 *           the position changes, so dx and dz must be multiples of 16 and
 *           dy 0. It may create chunks (and region files) where the world has
 *           none yet. The outer ring is left for the game to relight, since it
 *           meets this world's own light. Entities come along and this
 *           world's entities and points of interest under it go (apply.js).
 *   blocks  Only the selected columns and Y range, at any offset. Block
 *           entities and scheduled ticks move with their blocks; air can be
 *           skipped (pasting "over" what is there) and biomes copied or not.
 *           Entities are not touched.
 *
 * Every paste is replayed from the clip folder, so the preview and Apply see
 * the same thing and the source world is never read again.
 */

import { TByte, TAG, TList } from '../../web/js/core/nbt.js';
import { AIR_NAMES } from '../../web/js/core/anvil.js';
import { ChunkEditor } from './chunk.js';
import { chunkMask } from './selection.js';
import { dimensionInfo } from './dimensions.js';
import { clipChunk, clipExists } from './clips.js';

const items = (list) => (list instanceof TList ? list.items : Array.isArray(list) ? list : []);
const isAir = (state) => AIR_NAMES.has(state.Name);

export { pastePlacement } from './placement.js';

export const PASTE = {
  bounds: (op) => op.to,

  validate(op) {
    if (!op.clip || !clipExists(op.clip)) throw new Error('L\'appunto da incollare non esiste più.');
    if (!['chunks', 'blocks'].includes(op.mode)) throw new Error(`Modo di incolla sconosciuto: ${op.mode}`);
    if (op.mode === 'chunks' && (op.dx % 16 || op.dz % 16 || op.dy)) {
      throw new Error('A chunk interi lo spostamento dev\'essere un multiplo di 16 e senza cambiare quota.');
    }
    const t = op.to;
    if (!t || t.maxX - t.minX > 8192 || t.maxZ - t.minZ > 8192) throw new Error('Il pezzo da incollare è troppo grande (massimo 8192 blocchi per lato).');
  },

  /** Whole-chunk mode: the chunk that replaces (cx, cz), or null where the clip has none. */
  chunkRoot(op, cx, cz) {
    if (op.mode !== 'chunks') return null;
    const c = clipChunk(op.clip, cx - op.dx / 16, cz - op.dz / 16);
    if (!c) return null;
    const v = c.value;
    v.xPos = cx;
    v.zPos = cz;
    for (const key of ['block_entities', 'block_ticks', 'fluid_ticks']) {
      for (const e of items(v[key])) { e.x += op.dx; e.z += op.dz; }
    }
    // Structure starts and references point at the source's places.
    v.structures = { References: {}, starts: {} };
    const t = op.to;
    const ring = cx - (t.minX >> 4) < 1 || (t.maxX >> 4) - cx < 1 || cz - (t.minZ >> 4) < 1 || (t.maxZ >> 4) - cz < 1;
    if (ring) v.isLightOn = new TByte(0);
    return c;
  },

  /** Block mode, onto one chunk of the destination. */
  apply(op, ed, cx, cz) {
    if (op.mode !== 'blocks') return;
    const info = dimensionInfo(op.dim);
    const top = info.minY + info.height - 1;
    const lo = op.yMin ?? info.minY, hi = op.yMax ?? top;
    const sources = new Map();
    const source = (scx, scz) => {
      const k = `${scx},${scz}`;
      if (!sources.has(k)) {
        const c = clipChunk(op.clip, scx, scz);
        let s = null;
        if (c) {
          try { s = { ed: new ChunkEditor(c.value, { minY: info.minY, height: info.height }), root: c.value, mask: chunkMask(op.selection, scx, scz) }; } catch { s = null; }
        }
        sources.set(k, s);
      }
      return sources.get(k);
    };
    const f = op.from;
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const x = cx * 16 + lx, z = cz * 16 + lz, sx = x - op.dx, sz = z - op.dz;
        if (sx < f.minX || sx > f.maxX || sz < f.minZ || sz > f.maxZ) continue;
        const s = source(sx >> 4, sz >> 4);
        if (!s || !s.mask || !s.mask[(sz & 15) * 16 + (sx & 15)]) continue;
        for (let y = lo; y <= hi; y++) {
          const ty = y + op.dy;
          if (ty < info.minY || ty > top) continue;
          const st = s.ed.getState(sx, y, sz);
          if (op.air === false && isAir(st)) continue;
          ed.setState(x, ty, z, st);
          // One biome per 4x4x4 cell, taken where the cell's centre lands.
          if (op.biomes !== false && (x & 3) === 1 && (z & 3) === 1 && (ty & 3) === 1) {
            const bio = s.ed.getBiome(sx, y, sz);
            if (bio) ed.setBiome(x, ty, z, bio);
          }
        }
      }
    }
    // Block entities and ticks travel with their blocks.
    for (const s of sources.values()) {
      if (!s) continue;
      for (const key of ['block_entities', 'block_ticks', 'fluid_ticks']) {
        for (const e of items(s.root[key])) {
          const x = e.x + op.dx, y = e.y + op.dy, z = e.z + op.dz;
          if (x >> 4 !== cx || z >> 4 !== cz || e.y < lo || e.y > hi) continue;
          if (!s.mask || !s.mask[(e.z & 15) * 16 + (e.x & 15)]) continue;
          ed.addBlockData(key, { ...e, x, y, z });
        }
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Entities (whole-chunk pastes only; used by Apply)
// ---------------------------------------------------------------------------

const randomUuid = () => {
  const a = new Int32Array(4);
  for (let i = 0; i < 4; i++) a[i] = (Math.random() * 0x100000000) | 0;
  return a;
};

/** Move one entity (and its passengers) by dx, dz; new UUIDs so a second paste doesn't clash. */
export function shiftEntity(e, dx, dz) {
  const pos = items(e.Pos);
  if (pos.length === 3) {
    const shifted = [pos[0], pos[1], pos[2]].map((p, i) => {
      const v = (p && typeof p === 'object' && 'v' in p ? p.v : p) + (i === 0 ? dx : i === 2 ? dz : 0);
      return p && typeof p === 'object' && 'v' in p ? new p.constructor(v) : v;
    });
    e.Pos = e.Pos instanceof TList ? new TList(e.Pos.itemType, shifted) : shifted;
  }
  for (const key of ['block_pos', 'sleeping_pos']) {
    const a = e[key];
    if (a && (a instanceof Int32Array || (a.v instanceof Int32Array))) {
      const arr = a instanceof Int32Array ? a : a.v;
      arr[0] += dx; arr[2] += dz;
    }
  }
  if (typeof e.TileX === 'number') e.TileX += dx;
  if (typeof e.TileZ === 'number') e.TileZ += dz;
  if (e.UUID) e.UUID = randomUuid();
  delete e.Brain;      // remembered homes, jobs and meeting points are in the source
  for (const p of items(e.Passengers)) shiftEntity(p, dx, dz);
  return e;
}

/** The clip's entity chunk for destination (cx, cz), moved there; null if none. */
export function pastedEntityChunk(op, cx, cz) {
  const c = clipChunk(op.clip, cx - op.dx / 16, cz - op.dz / 16, 'entities');
  if (!c) return null;
  const v = c.value;
  if (v.Position instanceof Int32Array) v.Position = Int32Array.from([cx, cz]);
  else if (v.Position && v.Position.v instanceof Int32Array) v.Position.v = Int32Array.from([cx, cz]);
  for (const e of items(v.Entities)) shiftEntity(e, op.dx, op.dz);
  if (!(v.Entities instanceof TList) || !v.Entities.items.length) return null;
  v.Entities.itemType = TAG.Compound;
  return c;
}
