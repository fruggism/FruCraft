/*
 * The world as the map should show it: what is on disk, with the journal's
 * pending changes laid over. It is a WorldSource, so the ordinary tiler draws
 * it without knowing anything about editing.
 *
 * Only the region files a pending operation touches are rebuilt (in memory,
 * once per journal change); everything else passes straight through.
 */

import { RegionData } from './region.js';
import { replayOnRegion } from './replay.js';
import { dimensionInfo } from './dimensions.js';
import { chunkBoundsOf } from './journal.js';

export class OverlaySource {
  constructor(base, journal) {
    this.base = base;
    this.journal = journal;
    this.version = 0;
    this.cache = new Map();   // rel path -> { version, bytes }
    this.plan = journal.chunkPlan();
    this.modern = !!base.modernLayout;
    journal.onChange((_j, op) => {
      this.version++;
      this.plan = journal.chunkPlan();
      const b = chunkBoundsOf(op);
      if (!op) this.cache.clear();
      else if (b) for (const rel of this.regionsOf(op.dim, b)) this.cache.delete(rel);
    });
  }

  /** Relative paths of the region files a block box of a dimension covers. */
  regionsOf(dim, b) {
    const dir = dimensionInfo(dim, this.modern).dir;
    const out = new Set();
    for (let rz = b.minZ >> 9; rz <= b.maxZ >> 9; rz++) {
      for (let rx = b.minX >> 9; rx <= b.maxX >> 9; rx++) out.add(`${dir}/r.${rx}.${rz}.mca`);
    }
    return out;
  }

  get name() { return this.base.name; }
  get key() { return `${this.base.key}#overlay`; }
  exists(rel) { return this.base.exists(rel); }
  fileSize(rel) { return this.base.fileSize(rel); }
  listEntries(rel) { return this.base.listEntries(rel); }

  /** Which dimension and chunks a region file path is affected by, if any. */
  affecting(rel) {
    const m = /^(.*?)\/?r\.(-?\d+)\.(-?\d+)\.mca$/.exec(rel);
    if (!m) return null;
    const dir = m[1] || 'region';
    for (const [dim, chunks] of this.plan) {
      if (dimensionInfo(dim, this.modern).dir !== dir) continue;
      return { dim, chunks, rx: Number(m[2]), rz: Number(m[3]) };
    }
    return null;
  }

  async readFile(rel) {
    const hit = this.affecting(rel);
    if (!hit) return this.base.readFile(rel);
    const cached = this.cache.get(rel);
    if (cached) return cached;
    const bytes = await this.base.readFile(rel);
    if (!bytes) return bytes;
    const region = RegionData.fromBuffer(Buffer.from(bytes), hit.rx, hit.rz);
    const done = replayOnRegion(region, hit.chunks, hit.dim);
    const out = done.length ? new Uint8Array(region.serialize().file) : bytes;
    this.cache.set(rel, out);
    return out;
  }
}
