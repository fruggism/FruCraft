/*
 * WorldSource backed by the real filesystem. Read-only by construction: the
 * only calls it makes are readFileSync, statSync and readdirSync, so the world
 * a Cantiere tab has open can't be altered through it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { WorldSource } from '../../web/js/core/source.js';

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
