/*
 * WorldSource backed by the real filesystem (shared with the editor), plus the
 * in-memory tile cache the tests use.
 */

export { NodeSource } from '../editor/core/nodeSource.js';

/** In-memory tile cache with the shape the tiler expects. */
export class MemoryTileCache {
  constructor() { this.map = new Map(); }
  key(z, x, y) { return `${z}/${x}/${y}`; }
  async get(z, x, y) { return this.map.get(this.key(z, x, y)) || null; }
  async set(z, x, y, rgba) { this.map.set(this.key(z, x, y), rgba); }
  get size() { return this.map.size; }
  clear() { this.map.clear(); }
}
