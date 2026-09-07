/*
 * Turns a box of blocks into triangles.
 *
 * Three ideas do all the work:
 *
 * 1. Face culling. Only the faces between a solid block and something you can
 *    see through are drawn. A 16x16x256 column holds 65 536 blocks and
 *    393 216 faces; after culling, a few thousand survive.
 *
 * 2. Greedy meshing. Adjacent faces that would be drawn identically are
 *    merged into one big quad, so a flat meadow costs one rectangle instead
 *    of one per block. Only full cubes go through this; the odd shapes
 *    (slabs, fences, flowers) are emitted block by block, and there are far
 *    fewer of them.
 *
 * 3. Baked light. There are no lights in the scene: the shade of each face
 *    (top brightest, bottom darkest) and its ambient occlusion are multiplied
 *    into the vertex colors while meshing. That is what gives the corners
 *    their depth, and it costs the GPU nothing — the material is unlit.
 *
 * With a resource pack loaded each face also carries texture coordinates and
 * the layer of the texture array to sample. The coordinates come from the
 * block's own position in the world, which is what keeps greedy meshing
 * working: a rectangle four blocks wide simply runs 0..4 and the texture
 * repeats. It also crops correctly for free — a slab's side face spans
 * y..y+0.5, so it shows the bottom half of its texture, exactly as the game
 * draws it.
 *
 * The result is three meshes per chunk column: opaque, plants (opaque too,
 * but cut out by an alpha mask and drawn from both sides) and translucent
 * (water, glass, panes), drawn last.
 */

import { shapeOf, isVaried } from './blockKinds.js';
import {
  colorFor, baseColor, GRASS_TINTED, FOLIAGE_TINTED, WATER_TINTED,
} from '../core/blockColors.js';
import { AIR_STATE } from './volume.js';
import { FACE_COUNT, faceIndex } from '../pack/textures.js';

export const KIND = {
  air: 0, skip: 1, cube: 2, glass: 3, water: 4, plant: 5, box: 6, post: 7,
};

// Vanilla's face shading: a cube reads as a cube even with a flat color.
const SHADE = [0.62, 1, 0.8]; // by axis: x sides, y (top), z sides
const SHADE_BOTTOM = 0.5;
const AO_LIGHT = [0.44, 0.64, 0.82, 1];
const PLANT_SHADE = 0.92;

/**
 * The biome tint on its own.
 *
 * colorFor() multiplies the tint into the block's own colour, which is what a
 * flat-shaded face wants. A textured face needs the opposite: the game's grass
 * and foliage sprites are already grey, and it is the tint alone that colours
 * them. Dividing back out is exact enough — the values differ by at most a
 * rounding step.
 */
function tintOf(name, biomeName) {
  const tinted = colorFor(name, biomeName);
  if (WATER_TINTED.has(name)) return tinted;      // water's colour *is* its tint
  const base = baseColor(name);
  return [0, 1, 2].map((i) => Math.min(255,
    Math.round((tinted[i] * 255) / Math.max(1, base[i]))));
}

/**
 * Per-state lookup tables, built once per volume.
 *
 * `textures` is the result of buildTextureLayers(), or null for flat colours.
 */
export function buildTables(vol, textures = null) {
  const n = vol.states.length;
  const kind = new Uint8Array(n);
  const shapes = new Array(n);
  const alpha = new Float32Array(n);
  const tint = new Uint8Array(n);
  const varied = new Uint8Array(n);
  const flat = new Int32Array(n); // packed rgb for untinted states

  for (let i = 0; i < n; i++) {
    const name = vol.names[i];
    const shape = shapeOf(vol.states[i], name, vol.props[i]);
    shapes[i] = shape;
    kind[i] = KIND[shape.kind] ?? KIND.cube;
    alpha[i] = shape.alpha;
    tint[i] = GRASS_TINTED.has(name) ? 1 : FOLIAGE_TINTED.has(name) ? 2
      : WATER_TINTED.has(name) ? 3 : 0;
    // A texture already carries the block's own colour and its own grain, so
    // the vertex colour must not repeat either: it stays white except where
    // the game itself tints, and the jitter that saves flat leaves from
    // looking like a solid box would only muddy real ones.
    varied[i] = !textures && isVaried(name.replace(/^minecraft:/, '')) ? 1 : 0;
    const c = textures ? (tint[i] ? tintOf(name, null) : [255, 255, 255]) : colorFor(name, null);
    flat[i] = (c[0] << 16) | (c[1] << 8) | c[2];
  }
  kind[AIR_STATE] = KIND.air;
  return {
    kind, shapes, alpha, tint, varied, flat, textures,
    names: vol.names, biomeNames: vol.biomeNames,
  };
}

/** Color of a state in a biome, memoised — the pair repeats millions of times. */
function makeColorLookup(tables) {
  const memo = new Map();
  const of = tables.textures ? tintOf : colorFor;
  return (state, biome) => {
    if (!tables.tint[state]) return tables.flat[state];
    const key = state * 256 + biome;
    let c = memo.get(key);
    if (c === undefined) {
      const rgb = of(tables.names[state], tables.biomeNames[biome] || null);
      c = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
      memo.set(key, c);
    }
    return c;
  };
}

// --------------------------------------------------------------- buffers ---

class Buf {
  constructor(Type, cap) { this.T = Type; this.a = new Type(cap); this.n = 0; }
  need(k) {
    if (this.n + k <= this.a.length) return;
    let cap = this.a.length || 1024;
    while (cap < this.n + k) cap *= 2;
    const grown = new this.T(cap);
    grown.set(this.a.subarray(0, this.n));
    this.a = grown;
  }
  /** A copy sized exactly, owning its buffer so it can be transferred. */
  out() { return this.a.slice(0, this.n); }
}

class MeshBuf {
  constructor(withUV, withLayer) {
    this.pos = new Buf(Float32Array, 4096);
    this.col = new Buf(Uint8Array, 4096);
    this.idx = new Buf(Uint32Array, 4096);
    this.uv = withUV ? new Buf(Float32Array, 2048) : null;
    this.layer = withLayer ? new Buf(Float32Array, 1024) : null;
    this.verts = 0;
  }

  /**
   * One quad from four vertices already in counter-clockwise order as seen
   * from outside. `flip` swaps the diagonal, which keeps an ambient-occlusion
   * gradient from bending the wrong way across the two triangles.
   */
  quad(vx, vy, vz, vc, flip, uv, layer) {
    this.pos.need(12); this.col.need(12); this.idx.need(6);
    if (this.uv) { this.uv.need(8); for (let k = 0; k < 8; k++) this.uv.a[this.uv.n++] = uv[k]; }
    if (this.layer) {
      this.layer.need(4);
      for (let k = 0; k < 4; k++) this.layer.a[this.layer.n++] = layer;
    }
    const p = this.pos, c = this.col, ix = this.idx;
    for (let k = 0; k < 4; k++) {
      p.a[p.n++] = vx[k]; p.a[p.n++] = vy[k]; p.a[p.n++] = vz[k];
      const rgb = vc[k];
      c.a[c.n++] = (rgb >> 16) & 255; c.a[c.n++] = (rgb >> 8) & 255; c.a[c.n++] = rgb & 255;
    }
    const b = this.verts;
    if (flip) {
      ix.a[ix.n++] = b + 1; ix.a[ix.n++] = b + 2; ix.a[ix.n++] = b + 3;
      ix.a[ix.n++] = b + 1; ix.a[ix.n++] = b + 3; ix.a[ix.n++] = b;
    } else {
      ix.a[ix.n++] = b; ix.a[ix.n++] = b + 1; ix.a[ix.n++] = b + 2;
      ix.a[ix.n++] = b; ix.a[ix.n++] = b + 2; ix.a[ix.n++] = b + 3;
    }
    this.verts += 4;
  }

  get empty() { return this.verts === 0; }
  out() {
    const parts = { positions: this.pos.out(), colors: this.col.out(), indices: this.idx.out() };
    if (this.uv) parts.uvs = this.uv.out();
    if (this.layer) parts.layers = this.layer.out();
    return parts;
  }
}

/** Stable per-position jitter, so the same block is the same shade every load. */
function jitter(x, y, z) {
  let h = (x * 374761393 + y * 668265263 + z * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return 0.9 + (((h ^ (h >>> 16)) >>> 0) / 4294967296) * 0.2;
}

const shadeRGB = (rgb, f) => {
  const r = Math.min(255, ((rgb >> 16) & 255) * f + 0.5) | 0;
  const g = Math.min(255, ((rgb >> 8) & 255) * f + 0.5) | 0;
  const b = Math.min(255, (rgb & 255) * f + 0.5) | 0;
  return (r << 16) | (g << 8) | b;
};

// ----------------------------------------------------------------- mesher ---

/**
 * Mesh one 16x16 column of the volume.
 *
 * Neighbours are read from the whole volume, not just this column, so faces
 * on a chunk border are culled exactly as they are inside — otherwise every
 * chunk would come out wrapped in a visible shell.
 */
export function meshColumn(vol, tables, colX, colZ) {
  const { sizeX, sizeY, sizeZ, blocks, biomes } = vol;
  const bxDim = sizeX >> 2, bzDim = sizeZ >> 2, byDim = sizeY >> 2;
  const { kind, shapes, alpha, varied, textures } = tables;
  const colorOf = makeColorLookup(tables);

  const at = (x, y, z) => (
    x < 0 || y < 0 || z < 0 || x >= sizeX || y >= sizeY || z >= sizeZ
      ? AIR_STATE : blocks[(y * sizeZ + z) * sizeX + x]);
  const biomeAt = (x, y, z) => biomes[
    ((Math.min(byDim - 1, Math.max(0, y >> 2)) * bzDim)
      + Math.min(bzDim - 1, Math.max(0, z >> 2))) * bxDim
    + Math.min(bxDim - 1, Math.max(0, x >> 2))];
  const isCube = (s) => kind[s] === KIND.cube;

  const textured = !!textures;
  const opaque = new MeshBuf(textured, textured);
  const plants = new MeshBuf(true, textured);
  const clear = new MeshBuf(textured, textured);
  const faceLayers = textured ? textures.faces : null;
  const crossLayers = textured ? textures.cross : null;
  const layerFor = (state, d, dir) => faceLayers[state * FACE_COUNT + faceIndex(d, dir)];

  const x1 = Math.min(colX + 16, sizeX);
  const z1 = Math.min(colZ + 16, sizeZ);

  // Most of a column is air. Find the band that actually holds blocks (with
  // one block of margin, so the faces just outside it are still culled
  // against real neighbours) and sweep only that.
  let yLo = sizeY, yHi = -1;
  for (let y = 0; y < sizeY; y++) {
    let any = false;
    for (let z = colZ; z < z1 && !any; z++) {
      const row = (y * sizeZ + z) * sizeX;
      for (let x = colX; x < x1; x++) {
        if (blocks[row + x] !== AIR_STATE) { any = true; break; }
      }
    }
    if (any) { if (y < yLo) yLo = y; yHi = y; }
  }
  if (yHi < 0) return { opaque: null, plants: null, translucent: null, quads: 0 };
  yLo = Math.max(0, yLo - 1);
  yHi = Math.min(sizeY - 1, yHi + 1);

  // Scratch reused by every face: meshing a chunk emits tens of thousands of
  // quads, and allocating four vectors for each of them costs more than the
  // meshing itself.
  const vx = new Float32Array(4), vy = new Float32Array(4), vz = new Float32Array(4);
  const vc = new Int32Array(4);
  const colors = new Int32Array(4);
  const ao = new Uint8Array(4);
  const probe = new Int32Array(3);
  // Not integers: a slab's face sits at y + 0.5, water's at y + 0.875.
  const out = new Float64Array(3);
  const org = new Int32Array(3);
  const uu = new Float32Array(4), vv = new Float32Array(4);
  const quv = new Float32Array(8);
  const armBox = new Float32Array(6);

  const solidOffset = (du, dv, u, v) => {
    out[0] = probe[0]; out[1] = probe[1]; out[2] = probe[2];
    out[u] += du; out[v] += dv;
    return isCube(at(out[0], out[1], out[2])) ? 1 : 0;
  };

  /** Ambient occlusion for the four corners of a face, by vanilla's rule. */
  function faceAO(gx, gy, gz, d, dir) {
    const u = (d + 1) % 3, v = (d + 2) % 3;
    probe[0] = gx; probe[1] = gy; probe[2] = gz;
    probe[d] += dir;
    for (let k = 0; k < 4; k++) {
      const du = (k === 1 || k === 2) ? 1 : -1;
      const dv = (k === 2 || k === 3) ? 1 : -1;
      const s1 = solidOffset(du, 0, u, v);
      const s2 = solidOffset(0, dv, u, v);
      ao[k] = (s1 && s2) ? 0 : 3 - (s1 + s2 + solidOffset(du, dv, u, v));
    }
  }

  /**
   * A quad on plane `c` of axis `d`, spanning [u0,u1] x [v0,v1] of the other
   * two axes. Corners are numbered (u0,v0) (u1,v0) (u1,v1) (u0,v1) — which is
   * counter-clockwise seen from +d, so a face pointing the other way is
   * emitted in reverse. Reversing also swaps which diagonal splits the quad,
   * hence the inverted `flip`.
   */
  function planeQuad(buf, d, dir, c, u0, u1, v0, v1, flip, layer) {
    const u = (d + 1) % 3, v = (d + 2) % 3;
    uu[0] = u0; uu[1] = u1; uu[2] = u1; uu[3] = u0;
    vv[0] = v0; vv[1] = v0; vv[2] = v1; vv[3] = v1;
    for (let k = 0; k < 4; k++) {
      const j = dir > 0 ? k : 3 - k;
      out[d] = c; out[u] = uu[j]; out[v] = vv[j];
      vx[k] = out[0]; vy[k] = out[1]; vz[k] = out[2];
      vc[k] = colors[j];
      if (textured) faceUV(d, dir, out[0], out[1], out[2], k);
    }
    buf.quad(vx, vy, vz, vc, dir > 0 ? flip : !flip, quv, layer);
  }

  /*
   * Where a point on a face lands on its texture. Taken from the world
   * position, so the coordinates keep running across a merged rectangle and
   * repeat by themselves; the vertical axis is world Y on every side face, so
   * nothing ends up sideways.
   */
  function faceUV(d, dir, x, y, z, k) {
    let s0, t0;
    if (d === 1) { s0 = x; t0 = dir > 0 ? -z : z; }
    else if (d === 0) { s0 = dir > 0 ? -z : z; t0 = y; }
    else { s0 = dir > 0 ? x : -x; t0 = y; }
    quv[k * 2] = s0; quv[k * 2 + 1] = t0;
  }

  // ---- 1. greedy pass over full cubes -------------------------------------

  const dims = [x1 - colX, yHi - yLo + 1, z1 - colZ];
  const origin = [colX, yLo, colZ];

  function greedy(buf, memberKind, occludes) {
    for (let d = 0; d < 3; d++) {
      const u = (d + 1) % 3, v = (d + 2) % 3;
      const nu = dims[u], nv = dims[v];
      const size = nu * nv;
      const mId = new Int32Array(size);   // (state + 1), signed by face direction
      const mCol = new Int32Array(size);
      const mAo = new Int32Array(size);   // four corners, one byte each
      const mUni = new Uint8Array(size);
      const cell = new Int32Array(3);

      for (let s = -1; s < dims[d]; s++) {
        mId.fill(0);
        const ca = origin[d] + s;
        for (let j = 0; j < nv; j++) {
          for (let i = 0; i < nu; i++) {
            cell[u] = origin[u] + i; cell[v] = origin[v] + j;
            cell[d] = ca;
            const a = at(cell[0], cell[1], cell[2]);
            cell[d] = ca + 1;
            const b = at(cell[0], cell[1], cell[2]);

            let owner = -1, dir = 0;
            if (kind[a] === memberKind && !occludes(b, a) && s >= 0) { owner = a; dir = 1; }
            else if (kind[b] === memberKind && !occludes(a, b) && s + 1 < dims[d]) {
              owner = b; dir = -1;
            }
            if (dir === 0) continue;

            cell[d] = dir > 0 ? ca : ca + 1;
            faceAO(cell[0], cell[1], cell[2], d, dir);

            const shade = d === 1 && dir < 0 ? SHADE_BOTTOM : SHADE[d];
            const rgb = colorOf(owner, biomeAt(cell[0], cell[1], cell[2]));
            const n = j * nu + i;
            mId[n] = (owner + 1) * dir;
            mCol[n] = shadeRGB(rgb, varied[owner]
              ? shade * jitter(cell[0], cell[1], cell[2]) : shade);
            mAo[n] = (ao[0] << 24) | (ao[1] << 16) | (ao[2] << 8) | ao[3];
            mUni[n] = (ao[0] === ao[1] && ao[1] === ao[2] && ao[2] === ao[3]) ? 1 : 0;
          }
        }

        // Merge faces that would be drawn identically into rectangles. Only
        // uniformly-lit ones merge: stretching an ambient-occlusion gradient
        // over a rectangle would smear the shadow instead of repeating it.
        for (let j = 0; j < nv; j++) {
          for (let i = 0; i < nu;) {
            const n = j * nu + i;
            if (mId[n] === 0) { i++; continue; }
            const id = mId[n], col = mCol[n], aoBits = mAo[n], uni = mUni[n];
            const same = (k) => mId[k] === id && mCol[k] === col && mAo[k] === aoBits && uni;

            let w = 1;
            while (i + w < nu && same(n + w)) w++;
            let h = 1;
            if (uni) {
              grow: while (j + h < nv) {
                for (let k = 0; k < w; k++) if (!same((j + h) * nu + i + k)) break grow;
                h++;
              }
            }

            const a0 = (aoBits >> 24) & 255, a1 = (aoBits >> 16) & 255;
            const a2 = (aoBits >> 8) & 255, a3 = aoBits & 255;
            colors[0] = shadeRGB(col, AO_LIGHT[a0]);
            colors[1] = shadeRGB(col, AO_LIGHT[a1]);
            colors[2] = shadeRGB(col, AO_LIGHT[a2]);
            colors[3] = shadeRGB(col, AO_LIGHT[a3]);
            const dir = id > 0 ? 1 : -1;
            planeQuad(buf, d, dir, ca + 1,
              origin[u] + i, origin[u] + i + w, origin[v] + j, origin[v] + j + h,
              a0 + a2 > a1 + a3, textured ? layerFor(Math.abs(id) - 1, d, dir) : 0);

            for (let dj = 0; dj < h; dj++) {
              for (let di = 0; di < w; di++) mId[(j + dj) * nu + i + di] = 0;
            }
            i += w;
          }
        }
      }
    }
  }

  greedy(opaque, KIND.cube, (neighbour) => isCube(neighbour));
  greedy(clear, KIND.glass, (neighbour, self) => isCube(neighbour) || neighbour === self);

  // ---- 2. everything that is not a full cube ------------------------------

  /** The six faces of one box inside the cell at (gx, gy, gz). */
  function emitBox(buf, gx, gy, gz, b, rgb, withAO, state) {
    org[0] = gx; org[1] = gy; org[2] = gz;
    for (let d = 0; d < 3; d++) {
      const u = (d + 1) % 3, v = (d + 2) % 3;
      for (let dir = -1; dir <= 1; dir += 2) {
        const face = dir > 0 ? b[d + 3] : b[d];
        // A face flush with the cell wall is hidden by a solid neighbour.
        if (dir > 0 ? face >= 1 : face <= 0) {
          probe[0] = gx; probe[1] = gy; probe[2] = gz;
          probe[d] += dir;
          if (isCube(at(probe[0], probe[1], probe[2]))) continue;
        }
        const shade = d === 1 && dir < 0 ? SHADE_BOTTOM : SHADE[d];
        const base = shadeRGB(rgb, shade);
        let flip = false;
        if (withAO) {
          faceAO(gx, gy, gz, d, dir);
          for (let k = 0; k < 4; k++) colors[k] = shadeRGB(base, AO_LIGHT[ao[k]]);
          flip = ao[0] + ao[2] > ao[1] + ao[3];
        } else {
          colors[0] = base; colors[1] = base; colors[2] = base; colors[3] = base;
        }
        planeQuad(buf, d, dir, org[d] + face,
          org[u] + b[u], org[u] + b[u + 3], org[v] + b[v], org[v] + b[v + 3], flip,
          textured ? layerFor(state, d, dir) : 0);
      }
    }
  }

  /**
   * Two crossed quads, cut out by the plant mask. The material is
   * double-sided, so one quad per plane is enough, and the mask is what keeps
   * a meadow from turning into a field of coloured flags.
   */
  function emitCross(gx, gy, gz, shape, rgb, state) {
    const c = shadeRGB(rgb, PLANT_SHADE);
    const k = 0.1464; // where vanilla's crossed planes meet the block edges
    // With a pack the sprite carries its own empty space, so the plane is a
    // full block tall and shows the whole texture; without one, our mask is a
    // single tile and the height has to come from the species.
    const h = textured ? 1 : (shape.height || 0.9);
    const u0 = textured ? 0 : (shape.tile ? 0.5 : 0);
    const u1 = textured ? 1 : (shape.tile ? 1 : 0.5);
    const diagonals = [[k, k, 1 - k, 1 - k], [1 - k, k, k, 1 - k]];
    for (const [ax, az, bx, bz] of diagonals) {
      vx[0] = gx + ax; vy[0] = gy; vz[0] = gz + az;
      vx[1] = gx + bx; vy[1] = gy; vz[1] = gz + bz;
      vx[2] = gx + bx; vy[2] = gy + h; vz[2] = gz + bz;
      vx[3] = gx + ax; vy[3] = gy + h; vz[3] = gz + az;
      vc[0] = c; vc[1] = c; vc[2] = c; vc[3] = c;
      quv[0] = u0; quv[1] = 0; quv[2] = u1; quv[3] = 0;
      quv[4] = u1; quv[5] = 1; quv[6] = u0; quv[7] = 1;
      plants.quad(vx, vy, vz, vc, false, quv, textured ? crossLayers[state] : 0);
    }
  }

  /** Water: a full cube below the surface, 15/16 high where it meets the air. */
  function emitWater(buf, gx, gy, gz, rgb, state) {
    const top = kind[at(gx, gy + 1, gz)] === KIND.water ? 1 : 0.875;
    org[0] = gx; org[1] = gy; org[2] = gz;
    for (let d = 0; d < 3; d++) {
      const u = (d + 1) % 3, v = (d + 2) % 3;
      const hi = [1, top, 1];
      for (let dir = -1; dir <= 1; dir += 2) {
        probe[0] = gx; probe[1] = gy; probe[2] = gz;
        probe[d] += dir;
        const nb = at(probe[0], probe[1], probe[2]);
        if (kind[nb] === KIND.water || isCube(nb)) continue;
        const c = shadeRGB(rgb, d === 1 && dir < 0 ? SHADE_BOTTOM : SHADE[d]);
        colors[0] = c; colors[1] = c; colors[2] = c; colors[3] = c;
        planeQuad(buf, d, dir, org[d] + (dir > 0 ? hi[d] : 0),
          org[u], org[u] + hi[u], org[v], org[v] + hi[v], false,
          textured ? layerFor(state, d, dir) : 0);
      }
    }
  }

  /** Fence / wall / pane: a centre post plus an arm toward what it touches. */
  function emitPost(buf, gx, gy, gz, shape, rgb, state) {
    const p = shape.post, a = shape.arm;
    const ay0 = shape.armY[0], ay1 = shape.armY[1];
    armBox.set([0.5 - p, 0, 0.5 - p, 0.5 + p, 1, 0.5 + p]);
    emitBox(buf, gx, gy, gz, armBox, rgb, false, state);
    for (let i = 0; i < 4; i++) {
      const dx = i === 0 ? -1 : i === 1 ? 1 : 0;
      const dz = i === 2 ? -1 : i === 3 ? 1 : 0;
      const nk = kind[at(gx + dx, gy, gz + dz)];
      if (nk !== KIND.cube && nk !== KIND.post) continue;
      if (dx) armBox.set([dx < 0 ? 0 : 0.5 + p, ay0, 0.5 - a, dx < 0 ? 0.5 - p : 1, ay1, 0.5 + a]);
      else armBox.set([0.5 - a, ay0, dz < 0 ? 0 : 0.5 + p, 0.5 + a, ay1, dz < 0 ? 0.5 - p : 1]);
      emitBox(buf, gx, gy, gz, armBox, rgb, false, state);
    }
  }

  for (let y = yLo; y <= yHi; y++) {
    for (let z = colZ; z < z1; z++) {
      const row = (y * sizeZ + z) * sizeX;
      for (let x = colX; x < x1; x++) {
        const state = blocks[row + x];
        const k = kind[state];
        if (k === KIND.air || k === KIND.skip || k === KIND.cube || k === KIND.glass) continue;
        const rgb = colorOf(state, biomeAt(x, y, z));
        const buf = alpha[state] < 1 || k === KIND.water ? clear : opaque;
        if (k === KIND.water) { emitWater(buf, x, y, z, rgb, state); continue; }
        if (k === KIND.plant) { emitCross(x, y, z, shapes[state], rgb, state); continue; }
        if (k === KIND.post) { emitPost(buf, x, y, z, shapes[state], rgb, state); continue; }
        for (const b of shapes[state].boxes) emitBox(buf, x, y, z, b, rgb, true, state);
      }
    }
  }

  return {
    opaque: opaque.empty ? null : opaque.out(),
    plants: plants.empty ? null : plants.out(),
    translucent: clear.empty ? null : clear.out(),
    quads: (opaque.verts + plants.verts + clear.verts) / 4,
  };
}
