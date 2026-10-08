/*
 * Replaying the journal's chunk operations onto region data. One function,
 * two callers: the map preview (in memory) and Apply (onto the copy), so what
 * you see is what gets written.
 */

import { applyChunkOps } from './journal.js';

/**
 * @param region  RegionData to change in place
 * @param chunks  Map "cx,cz" -> ops, as Journal.chunkPlan() gives per dimension
 * @returns list of { cx, cz } actually rewritten
 */
export function replayOnRegion(region, chunks, dim) {
  const done = [];
  for (const [key, ops] of chunks) {
    const [cx, cz] = key.split(',').map(Number);
    if ((cx >> 5) !== region.rx || (cz >> 5) !== region.rz) continue;
    const lx = cx & 31, lz = cz & 31;
    if (!region.has(lx, lz)) continue; // editing never invents chunks
    const { name, value } = region.getChunk(lx, lz);
    applyChunkOps(value, ops, cx, cz, dim);
    region.setChunk(lx, lz, value, name);
    done.push({ cx, cz });
  }
  return done;
}

/** Region files (relative paths) a plan touches, per dimension. */
export function regionsOfPlan(plan, dirOf) {
  const out = [];
  for (const [dim, chunks] of plan) {
    const seen = new Map();
    for (const key of chunks.keys()) {
      const [cx, cz] = key.split(',').map(Number);
      const id = `${cx >> 5},${cz >> 5}`;
      if (!seen.has(id)) seen.set(id, { dim, rx: cx >> 5, rz: cz >> 5, rel: `${dirOf(dim)}/r.${cx >> 5}.${cz >> 5}.mca` });
    }
    out.push(...seen.values());
  }
  return out;
}
