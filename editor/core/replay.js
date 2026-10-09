/*
 * Replaying the journal's chunk operations onto region data. One function,
 * two callers: the map preview (in memory) and Apply (onto the copy), so what
 * you see is what gets written.
 */

import { applyChunkOps, CHUNK_OPS } from './journal.js';

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
    // A whole-chunk paste replaces the chunk (or creates it); later operations go on top.
    let start = 0, chunk = null;
    for (let i = ops.length - 1; i >= 0; i--) {
      const def = CHUNK_OPS[ops[i].type];
      if (!def.chunkRoot) continue;
      chunk = def.chunkRoot(ops[i], cx, cz);
      if (chunk) { start = i + 1; break; }
    }
    if (!chunk) {
      if (!region.has(lx, lz)) continue; // otherwise editing never invents chunks
      chunk = region.getChunk(lx, lz);
    }
    const rest = ops.slice(start).filter((op) => CHUNK_OPS[op.type].apply);
    if (rest.length) applyChunkOps(chunk.value, rest, cx, cz, dim);
    region.setChunk(lx, lz, chunk.value, chunk.name || '');
    done.push({ cx, cz });
  }
  return done;
}

/** Can the operations of this plan create chunks in region (rx, rz) of `dim`? */
export function createsChunks(plan, dim, rx, rz) {
  const chunks = plan.get(dim);
  if (!chunks) return false;
  for (const [key, ops] of chunks) {
    const [cx, cz] = key.split(',').map(Number);
    if ((cx >> 5) === rx && (cz >> 5) === rz && ops.some((op) => CHUNK_OPS[op.type].chunkRoot && op.mode === 'chunks')) return true;
  }
  return false;
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
