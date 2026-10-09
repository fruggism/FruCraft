/*
 * The world as the map should show it: what is on disk, with the journal's
 * pending changes laid over. It is a WorldSource, so the ordinary tiler draws
 * it without knowing anything about editing.
 *
 * Only the region files a pending operation touches are rebuilt (in memory,
 * once per journal change); everything else passes straight through. Free
 * space operations hide what they delete: chunks vanish from their files,
 * files and folders from the listings.
 */

import { RegionData } from './region.js';
import { replayOnRegion, createsChunks } from './replay.js';
import { dimensionInfo } from './dimensions.js';
import { chunkBoundsOf, WORLD_OPS } from './journal.js';
import { decodeMask, withoutChunks, headerOf } from './freeSpace.js';

export class OverlaySource {
  constructor(base, journal) {
    this.base = base;
    this.journal = journal;
    this.version = 0;
    this.cache = new Map();   // rel path -> { version, bytes }
    this.plan = journal.chunkPlan();
    this.modern = !!base.modernLayout;
    this.indexDeletions();
    journal.onChange((_j, op) => {
      this.version++;
      this.plan = journal.chunkPlan();
      const b = chunkBoundsOf(op);
      if (!op || WORLD_OPS[op.type]) { this.indexDeletions(); this.cache.clear(); }
      else if (b) for (const rel of this.regionsOf(op.dim, b)) this.cache.delete(rel);
    });
  }

  /** What the pending Free space operations delete: chunk slots per file, whole files, folders. */
  indexDeletions() {
    this.pruned = new Map();   // rel -> Set of slots
    this.gone = new Set();     // files and folders
    for (const op of this.journal.worldOps()) {
      for (const [rel, mask] of Object.entries(op.files || {})) {
        if (mask === '') { this.gone.add(rel); continue; }
        if (!this.pruned.has(rel)) this.pruned.set(rel, new Set());
        for (const i of decodeMask(mask)) this.pruned.get(rel).add(i);
      }
      for (const rel of op.remove || []) this.gone.add(rel);
      for (const rel of op.dirs || []) this.gone.add(rel);
    }
  }

  isGone(rel) {
    if (!this.gone.size) return false;
    const parts = String(rel).split('/');
    for (let i = 1; i <= parts.length; i++) if (this.gone.has(parts.slice(0, i).join('/'))) return true;
    return false;
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
  async exists(rel) { return !this.isGone(rel) && this.base.exists(rel); }
  async fileSize(rel) { return this.isGone(rel) ? null : this.base.fileSize(rel); }
  async listEntries(rel) {
    const list = await this.base.listEntries(rel);
    return this.gone.size ? list.filter((e) => !this.isGone(rel ? `${rel}/${e.name}` : e.name)) : list;
  }

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
    if (this.isGone(rel)) return null;
    if (rel.endsWith('.mcc') && this.cache.has(rel)) return this.cache.get(rel);
    const del = this.pruned.get(rel);
    if (!del) return this.readEdited(rel);
    const key = `${rel}#pruned`;
    if (this.cache.has(key)) return this.cache.get(key);
    const bytes = await this.readEdited(rel);
    const out = bytes ? withoutChunks(bytes, del) : bytes;
    this.cache.set(key, out);
    return out;
  }

  /** The file with the pending chunk operations replayed on it. */
  async readEdited(rel) {
    const hit = this.affecting(rel);
    if (!hit) return this.base.readFile(rel);
    const cached = this.cache.get(rel);
    if (cached) return cached;
    const bytes = await this.base.readFile(rel);
    // A whole-chunk paste may land where the world has no region file yet.
    if (!bytes && !createsChunks(this.plan, hit.dim, hit.rx, hit.rz)) return bytes;
    // Chunks over 1 MiB live in .mcc files next to the region: read them too,
    // or rebuilding the region would drop them.
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const ext = new Map();
    for (const h of bytes ? headerOf(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)) : []) {
      if (!h.ext) continue;
      const name = `c.${hit.rx * 32 + (h.i & 31)}.${hit.rz * 32 + (h.i >> 5)}.mcc`;
      const b = await this.base.readFile(dir ? `${dir}/${name}` : name);
      if (b) ext.set(name, Buffer.from(b));
    }
    const region = bytes ? RegionData.fromBuffer(Buffer.from(bytes), hit.rx, hit.rz, ext) : new RegionData(hit.rx, hit.rz);
    const done = replayOnRegion(region, hit.chunks, hit.dim);
    let out = bytes;
    if (done.length) {
      const { file, externals } = region.serialize();
      out = new Uint8Array(file);
      // An edited big chunk is read back from here, not from the old .mcc on disk.
      for (const [name, data] of externals) this.cache.set(dir ? `${dir}/${name}` : name, new Uint8Array(data));
    }
    this.cache.set(rel, out);
    return out;
  }
}
