/*
 * WorldSource backed by the real filesystem, so the browser-oriented core can
 * be exercised by the test suite without a browser.
 */

import fs from 'node:fs';
import path from 'node:path';
import { WorldSource } from '../web/js/core/source.js';

export class NodeSource extends WorldSource {
  constructor(root) {
    super();
    this.root = path.resolve(root);
  }

  get name() { return path.basename(this.root); }
  get key() { return `node:${this.root}`; }

  full(rel) {
    return path.join(this.root, String(rel || '').replace(/\//g, path.sep));
  }

  async readFile(rel) {
    try {
      return new Uint8Array(fs.readFileSync(this.full(rel)));
    } catch {
      return null;
    }
  }

  async fileSize(rel) {
    try {
      const st = fs.statSync(this.full(rel));
      return st.isFile() ? st.size : null;
    } catch {
      return null;
    }
  }

  async listEntries(rel) {
    try {
      return fs.readdirSync(this.full(rel), { withFileTypes: true })
        .map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
    } catch {
      return [];
    }
  }
}

/** In-memory tile cache with the shape the tiler expects. */
export class MemoryTileCache {
  constructor() { this.map = new Map(); }
  key(z, x, y) { return `${z}/${x}/${y}`; }
  async get(z, x, y) { return this.map.get(this.key(z, x, y)) || null; }
  async set(z, x, y, rgba) { this.map.set(this.key(z, x, y), rgba); }
  get size() { return this.map.size; }
  clear() { this.map.clear(); }
}
