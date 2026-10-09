/*
 * Selections: which block columns an operation covers, plus an optional
 * Y range.
 *
 * A selection is plain JSON so it can ride inside a journal operation and be
 * saved to disk:
 *
 *   { items: [{ mode, shape }, ...], yMin: null | number, yMax: null | number }
 *
 * Items are combined in order, starting from nothing: 'add' unites, 'sub'
 * subtracts, 'and' intersects. Shapes:
 *
 *   { type: 'rect', minX, minZ, maxX, maxZ }   whole blocks, inclusive
 *   { type: 'poly', points: [[x, z], ...] }    a closed polygon (lasso too)
 *   { type: 'stroke', r, points: [[x, z]...] } a brush stroke: a capsule of
 *                                              radius r along the points
 *   { type: 'region', region }                 a whole nested selection
 *                                              (how "invert" is written)
 *
 * Polygon and stroke coordinates are continuous map coordinates; a column
 * (x, z) belongs to a shape when its centre (x + .5, z + .5) does. That is
 * what makes a selection drawn at any zoom land on whole blocks.
 *
 * Nothing here is ever evaluated for the whole world at once: callers ask for
 * one chunk's 16x16 mask at a time, so a selection thousands of blocks wide
 * costs memory for one chunk, not for its area.
 */

export const emptySelection = () => ({ items: [], yMin: null, yMax: null });

export const isEmptySelection = (sel) => !sel || !Array.isArray(sel.items) || !sel.items.some((i) => i.mode === 'add');

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

function shapeBounds(shape) {
  switch (shape.type) {
    case 'rect':
      return {
        minX: Math.min(shape.minX, shape.maxX), maxX: Math.max(shape.minX, shape.maxX),
        minZ: Math.min(shape.minZ, shape.maxZ), maxZ: Math.max(shape.minZ, shape.maxZ),
      };
    case 'poly':
    case 'stroke': {
      const r = shape.type === 'stroke' ? shape.r : 0;
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      for (const [x, z] of shape.points) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      if (minX === Infinity) return null;
      return {
        minX: Math.floor(minX - r), maxX: Math.ceil(maxX + r),
        minZ: Math.floor(minZ - r), maxZ: Math.ceil(maxZ + r),
      };
    }
    case 'region': return selectionBounds(shape.region);
    default: throw new Error(`Forma di selezione sconosciuta: ${shape.type}`);
  }
}

const unite = (a, b) => (!a ? b : !b ? a : {
  minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX),
  minZ: Math.min(a.minZ, b.minZ), maxZ: Math.max(a.maxZ, b.maxZ),
});

const intersect = (a, b) => {
  if (!a || !b) return null;
  const r = {
    minX: Math.max(a.minX, b.minX), maxX: Math.min(a.maxX, b.maxX),
    minZ: Math.max(a.minZ, b.minZ), maxZ: Math.min(a.maxZ, b.maxZ),
  };
  return r.minX > r.maxX || r.minZ > r.maxZ ? null : r;
};

/** Block box that contains every selected column, or null when nothing is selected. */
export function selectionBounds(sel) {
  if (!sel || !Array.isArray(sel.items)) return null;
  let b = null;
  for (const { mode, shape } of sel.items) {
    if (mode === 'add') b = unite(b, shapeBounds(shape));
    else if (mode === 'and') b = intersect(b, shapeBounds(shape));
  }
  return b;
}

// ---------------------------------------------------------------------------
// Rasterising one chunk
// ---------------------------------------------------------------------------

// Compiled helpers are cached on the shape object: a stroke of 2,000 points
// is split into per-segment boxes once, not once per chunk.
const compiled = new WeakMap();

function compile(shape) {
  let c = compiled.get(shape);
  if (c) return c;
  if (shape.type === 'poly') {
    const pts = shape.points;
    const edges = [];
    for (let i = 0; i < pts.length; i++) {
      const [x1, z1] = pts[i];
      const [x2, z2] = pts[(i + 1) % pts.length];
      if (z1 === z2) continue; // horizontal edges never cross a row centre
      edges.push({ x1, z1, x2, z2, zMin: Math.min(z1, z2), zMax: Math.max(z1, z2) });
    }
    c = { edges };
  } else if (shape.type === 'stroke') {
    const pts = shape.points;
    const segs = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[Math.min(i + 1, pts.length - 1)];
      segs.push({
        ax: a[0], az: a[1], bx: b[0], bz: b[1],
        minX: Math.min(a[0], b[0]) - shape.r, maxX: Math.max(a[0], b[0]) + shape.r,
        minZ: Math.min(a[1], b[1]) - shape.r, maxZ: Math.max(a[1], b[1]) + shape.r,
      });
    }
    c = { segs, r2: shape.r * shape.r };
  } else {
    c = {};
  }
  compiled.set(shape, c);
  return c;
}

function distSeg2(px, pz, s) {
  const dx = s.bx - s.ax, dz = s.bz - s.az;
  const len2 = dx * dx + dz * dz;
  let t = len2 ? ((px - s.ax) * dx + (pz - s.az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = s.ax + t * dx - px, ez = s.az + t * dz - pz;
  return ex * ex + ez * ez;
}

/** Fill `out` (256 bytes, z-major) with 1 where the shape covers the chunk's columns. */
function shapeMask(shape, cx, cz, out) {
  out.fill(0);
  const x0 = cx * 16, z0 = cz * 16;
  const b = shapeBounds(shape);
  if (!b || b.maxX < x0 || b.minX > x0 + 15 || b.maxZ < z0 || b.minZ > z0 + 15) return false;
  let any = false;
  switch (shape.type) {
    case 'rect': {
      for (let z = Math.max(b.minZ, z0); z <= Math.min(b.maxZ, z0 + 15); z++) {
        for (let x = Math.max(b.minX, x0); x <= Math.min(b.maxX, x0 + 15); x++) out[(z - z0) * 16 + (x - x0)] = 1;
      }
      return true;
    }
    case 'poly': {
      const { edges } = compile(shape);
      const near = edges.filter((e) => e.zMax >= z0 && e.zMin <= z0 + 16);
      const xs = [];
      for (let lz = 0; lz < 16; lz++) {
        const zc = z0 + lz + 0.5;
        xs.length = 0;
        for (const e of near) {
          // Half-open on z so a vertex exactly on the row is counted once.
          if ((e.z1 <= zc && e.z2 > zc) || (e.z2 <= zc && e.z1 > zc)) {
            xs.push(e.x1 + ((zc - e.z1) / (e.z2 - e.z1)) * (e.x2 - e.x1));
          }
        }
        if (xs.length < 2) continue;
        xs.sort((a, b2) => a - b2);
        for (let i = 0; i + 1 < xs.length; i += 2) {
          // columns whose centre lies in [xs[i], xs[i+1])
          const from = Math.max(0, Math.ceil(xs[i] - 0.5) - x0);
          const to = Math.min(15, Math.ceil(xs[i + 1] - 0.5) - 1 - x0);
          for (let lx = from; lx <= to; lx++) { out[lz * 16 + lx] = 1; any = true; }
        }
      }
      return any;
    }
    case 'stroke': {
      const { segs, r2 } = compile(shape);
      const near = segs.filter((s) => s.maxX >= x0 && s.minX <= x0 + 16 && s.maxZ >= z0 && s.minZ <= z0 + 16);
      if (!near.length) return false;
      for (let lz = 0; lz < 16; lz++) {
        const pz = z0 + lz + 0.5;
        for (let lx = 0; lx < 16; lx++) {
          const px = x0 + lx + 0.5;
          for (const s of near) {
            if (px < s.minX || px > s.maxX || pz < s.minZ || pz > s.maxZ) continue;
            if (distSeg2(px, pz, s) <= r2) { out[lz * 16 + lx] = 1; any = true; break; }
          }
        }
      }
      return any;
    }
    case 'region': {
      const m = chunkMask(shape.region, cx, cz);
      if (!m) return false;
      out.set(m);
      return true;
    }
    default: return false;
  }
}

/**
 * Mask of the selected columns of chunk (cx, cz): Uint8Array(256), index
 * (z & 15) * 16 + (x & 15). Null when the chunk has no selected column.
 */
export function chunkMask(sel, cx, cz) {
  if (!sel || !Array.isArray(sel.items)) return null;
  const b = selectionBounds(sel);
  if (!b || b.maxX < cx * 16 || b.minX > cx * 16 + 15 || b.maxZ < cz * 16 || b.minZ > cz * 16 + 15) return null;
  const mask = new Uint8Array(256);
  const tmp = new Uint8Array(256);
  for (const { mode, shape } of sel.items) {
    const hit = shapeMask(shape, cx, cz, tmp);
    if (mode === 'add') { if (hit) for (let i = 0; i < 256; i++) mask[i] |= tmp[i]; }
    else if (mode === 'sub') { if (hit) for (let i = 0; i < 256; i++) if (tmp[i]) mask[i] = 0; }
    else if (mode === 'and') { for (let i = 0; i < 256; i++) mask[i] &= tmp[i]; }
  }
  for (let i = 0; i < 256; i++) if (mask[i]) return mask;
  return null;
}

/** Is column (x, z) selected? For single lookups; bulk work should use chunkMask. */
export function contains(sel, x, z) {
  const m = chunkMask(sel, x >> 4, z >> 4);
  return !!m && m[(z & 15) * 16 + (x & 15)] === 1;
}

/** Every chunk with at least one selected column, as [cx, cz] pairs. */
export function* selectedChunks(sel) {
  const b = selectionBounds(sel);
  if (!b) return;
  for (let cz = b.minZ >> 4; cz <= b.maxZ >> 4; cz++) {
    for (let cx = b.minX >> 4; cx <= b.maxX >> 4; cx++) {
      if (chunkMask(sel, cx, cz)) yield [cx, cz];
    }
  }
}

/** Columns and chunks a selection covers (for the status line and the panel). */
export function measure(sel) {
  const b = selectionBounds(sel);
  if (!b) return { columns: 0, chunks: 0, bounds: null };
  let columns = 0, chunks = 0;
  for (let cz = b.minZ >> 4; cz <= b.maxZ >> 4; cz++) {
    for (let cx = b.minX >> 4; cx <= b.maxX >> 4; cx++) {
      const m = chunkMask(sel, cx, cz);
      if (!m) continue;
      chunks++;
      for (let i = 0; i < 256; i++) columns += m[i];
    }
  }
  return { columns, chunks, bounds: b };
}

/** The Y range [lo, hi] a selection covers inside a dimension of the given height. */
export function yRange(sel, minY, height) {
  const top = minY + height - 1;
  const lo = sel && sel.yMin !== null && sel.yMin !== undefined ? Math.max(minY, Number(sel.yMin)) : minY;
  const hi = sel && sel.yMax !== null && sel.yMax !== undefined ? Math.min(top, Number(sel.yMax)) : top;
  return [lo, hi];
}

// ---------------------------------------------------------------------------
// Building selections
// ---------------------------------------------------------------------------

/** Combine a new shape into a selection: 'new' replaces, otherwise add / sub / and. */
export function combine(sel, mode, shape) {
  const base = sel || emptySelection();
  if (mode === 'new') return { ...base, items: [{ mode: 'add', shape }] };
  return { ...base, items: [...base.items, { mode, shape }] };
}

/** Everything inside `bounds` that is not in `sel`. */
export function invert(sel, bounds) {
  const all = { type: 'rect', ...bounds };
  if (isEmptySelection(sel)) return { items: [{ mode: 'add', shape: all }], yMin: sel?.yMin ?? null, yMax: sel?.yMax ?? null };
  return {
    items: [{ mode: 'add', shape: all }, { mode: 'sub', shape: { type: 'region', region: { items: sel.items, yMin: null, yMax: null } } }],
    yMin: sel.yMin, yMax: sel.yMax,
  };
}

/** Round the points of a freehand shape and drop the ones that add nothing. */
export function simplifyPoints(points, tolerance = 0.5) {
  const out = [];
  for (const p of points) {
    const q = [Math.round(p[0] * 2) / 2, Math.round(p[1] * 2) / 2];
    const last = out[out.length - 1];
    if (last && Math.hypot(q[0] - last[0], q[1] - last[1]) < tolerance) continue;
    out.push(q);
  }
  return out;
}
