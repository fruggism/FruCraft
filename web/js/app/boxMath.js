/*
 * The 3D selection box, as numbers.
 *
 * Kept apart from the Leaflet code that draws it so the rules can be tested
 * on their own: everything snaps to whole chunks (16 blocks), because that is
 * what the reader loads anyway; a side is never under 32 nor over 1024.
 */

export const CHUNK = 16;
export const MIN_SIDE = 32;
export const MAX_SIDE = 1024;
export const PRESETS = [64, 128, 192, 256, 512];

const snap = (v) => Math.round(v / CHUNK) * CHUNK;
const clampSide = (v) => Math.max(MIN_SIDE, Math.min(MAX_SIDE, snap(v)));

/**
 * The side a model can be built at without the tab struggling. It reads two
 * hints the browser gives (memory in GB, logical cores — Chrome and Edge
 * only; elsewhere both fall back to 4), and stays deliberately modest: the
 * point is a first model that appears in seconds, not the biggest possible.
 */
export function recommendedSide(nav = (typeof navigator !== 'undefined' ? navigator : {})) {
  const mem = nav.deviceMemory || 4;
  const cores = nav.hardwareConcurrency || 4;
  return mem >= 8 && cores >= 8 ? 256 : mem >= 4 ? 192 : 128;
}

/** A box of the given size centred on a point, snapped to the chunk grid. */
export function boxAround(cx, cz, sizeX, sizeZ = sizeX) {
  const sx = clampSide(sizeX);
  const sz = clampSide(sizeZ);
  return { minX: snap(cx - sx / 2), minZ: snap(cz - sz / 2), sizeX: sx, sizeZ: sz };
}

export const centerOf = (b) => ({ x: b.minX + b.sizeX / 2, z: b.minZ + b.sizeZ / 2 });

/** Slide the box; the offset is rounded to whole chunks. */
export function moveBox(b, dx, dz) {
  return { ...b, minX: b.minX + snap(dx), minZ: b.minZ + snap(dz) };
}

/** Grow or shrink both sides around the centre (the + / − buttons). */
export function growBox(b, delta) {
  const c = centerOf(b);
  return boxAround(c.x, c.z, b.sizeX + delta, b.sizeZ + delta);
}

/**
 * Drag one handle to a world point. `handle` names the edges it moves: 'nw',
 * 'se', 'n', 'e'… A corner moves two edges, a mid-side handle one — which is
 * how the box turns rectangular. The opposite edges stay where they were.
 */
export function resizeBox(b, handle, x, z) {
  let x0 = b.minX, z0 = b.minZ, x1 = b.minX + b.sizeX, z1 = b.minZ + b.sizeZ;
  if (handle.includes('w')) x0 = Math.min(Math.max(snap(x), x1 - MAX_SIDE), x1 - MIN_SIDE);
  if (handle.includes('e')) x1 = Math.max(Math.min(snap(x), x0 + MAX_SIDE), x0 + MIN_SIDE);
  if (handle.includes('n')) z0 = Math.min(Math.max(snap(z), z1 - MAX_SIDE), z1 - MIN_SIDE);
  if (handle.includes('s')) z1 = Math.max(Math.min(snap(z), z0 + MAX_SIDE), z0 + MIN_SIDE);
  return { minX: x0, minZ: z0, sizeX: x1 - x0, sizeZ: z1 - z0 };
}
