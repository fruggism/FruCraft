/*
 * Where a clip lands: pure arithmetic, shared by the window (the paste ghost
 * on the map) and the main process (the paste operation). See paste.js.
 */

const shiftBox = (b, dx, dz) => ({ minX: b.minX + dx, minZ: b.minZ + dz, maxX: b.maxX + dx, maxZ: b.maxZ + dz });

/**
 * The boxes and shift of a paste, from a clip's description and where its
 * north-west corner should go (x, z). Whole chunks snap to the chunk grid.
 */
export function pastePlacement(clip, { mode = 'chunks', x, z, dy = 0 }) {
  if (mode === 'chunks') {
    const from = { minX: clip.chunks.minX * 16, minZ: clip.chunks.minZ * 16, maxX: clip.chunks.maxX * 16 + 15, maxZ: clip.chunks.maxZ * 16 + 15 };
    const dx = Math.round((x - from.minX) / 16) * 16;
    const dz = Math.round((z - from.minZ) / 16) * 16;
    return { dx, dy: 0, dz, from, to: shiftBox(from, dx, dz) };
  }
  const b = clip.bounds;
  const dx = Math.round(x - b.minX), dz = Math.round(z - b.minZ);
  return { dx, dy: Math.round(dy), dz, from: { ...b }, to: shiftBox(b, dx, dz) };
}

/** Size of what a paste covers, in blocks, for each mode. */
export function clipSize(clip, mode) {
  if (mode === 'chunks') return { w: (clip.chunks.maxX - clip.chunks.minX + 1) * 16, h: (clip.chunks.maxZ - clip.chunks.minZ + 1) * 16 };
  return { w: clip.bounds.maxX - clip.bounds.minX + 1, h: clip.bounds.maxZ - clip.bounds.minZ + 1 };
}
