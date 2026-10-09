/*
 * One open world: what the main process knows about a tab.
 *
 * No Electron in here — the window code only forwards IPC calls to these
 * methods — so the whole thing runs in the test suite.
 *
 * The world on disk is only ever read. Everything the user changes goes into
 * the journal, which is saved after each change (so it survives a crash) and
 * laid over the world by an OverlaySource for the map.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { scanWorld } from '../../web/js/core/worldScan.js';
import { serveTile, regionSetOf, tileRangeFor, TILE_SIZE, MIN_ZOOM, NATIVE_ZOOM } from '../../web/js/core/tiler.js';
import { readSurface, forgetRegions, NO_DATA } from '../../web/js/core/anvil.js';
import { NodeSource } from '../core/nodeSource.js';
import { OverlaySource } from '../core/overlay.js';
import { Journal, chunkBoundsOf } from '../core/journal.js';
import { biomeColor } from '../core/biomes.js';
import { applyJournal, preflight, readLevel, dataVersionOf, isCantiereCopy, uniqueCopyName } from '../core/apply.js';
import { MIN_DATA_VERSION } from '../core/chunk.js';

export const defaultSavesDir = () => (process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support', 'minecraft', 'saves')
  : path.join(os.homedir(), '.minecraft', 'saves'));

/** Worlds found in a saves folder, newest first. */
export function listWorlds(savesDir) {
  let entries;
  try { entries = fs.readdirSync(savesDir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(savesDir, e.name);
    try {
      const st = fs.statSync(path.join(dir, 'level.dat'));
      out.push({ name: e.name, path: dir, modified: st.mtimeMs, cantiere: isCantiereCopy(dir) });
    } catch { /* not a world */ }
  }
  return out.sort((a, b) => b.modified - a.modified);
}

const snapshot = (file) => {
  try { const st = fs.statSync(file); return `${st.size}:${st.mtimeMs}`; } catch { return null; }
};

export class WorldSession {
  static async open(worldDir, { dataDir }) {
    const s = new WorldSession(path.resolve(worldDir), dataDir);
    await s.load();
    return s;
  }

  constructor(worldDir, dataDir) {
    this.worldDir = worldDir;
    this.dataDir = dataDir;
    this.base = new NodeSource(worldDir);
    this.journalFile = path.join(
      dataDir, 'journals', `${crypto.createHash('sha1').update(worldDir).digest('hex')}.json`);
    this.caches = new Map();   // "dim|maxY" -> Map of tiles
  }

  async load() {
    this.scan = await scanWorld(this.base);
    if (!this.scan.ok) throw new Error(this.scan.error);
    this.levelSnapshot = snapshot(path.join(this.worldDir, 'level.dat'));
    this.readOnly = this.scan.dataVersion !== null && this.scan.dataVersion < MIN_DATA_VERSION;
    this.journal = this.restoreJournal();
    this.overlay = new OverlaySource(this.base, this.journal);
    this.dirty = [];
    this.journal.onChange((_j, op) => { this.invalidate(op); this.persist(); });
    this.regionSets = new Map(this.scan.dimensions.map((d) => [d.id, regionSetOf(d.regions)]));
  }

  /**
   * Forget what an operation changed: the region files under it and the
   * tiles over it, at every zoom. Level operations change no tile. The
   * boxes are remembered in this.dirty for the window to redraw.
   */
  invalidate(op) {
    const b = chunkBoundsOf(op);
    if (!op) {
      this.caches.clear();
      forgetRegions(this.overlay);
      this.dirty.push({ dim: null, bounds: null });
      return;
    }
    if (!b) return;
    forgetRegions(this.overlay, this.overlay.regionsOf(op.dim, b));
    for (const [key, tiles] of this.caches) {
      if (!key.startsWith(`${op.dim}|`)) continue;
      for (let z = MIN_ZOOM; z <= NATIVE_ZOOM; z++) {
        const r = tileRangeFor(b, z);
        for (let ty = r.minTY; ty <= r.maxTY; ty++) {
          for (let tx = r.minTX; tx <= r.maxTX; tx++) tiles.delete(`${z}/${tx}/${ty}`);
        }
      }
    }
    this.dirty.push({ dim: op.dim, bounds: b });
  }

  /** Boxes changed since the last call: what the window must redraw. */
  takeDirty() { const d = this.dirty; this.dirty = []; return d; }

  restoreJournal() {
    try {
      return Journal.fromJSON(JSON.parse(fs.readFileSync(this.journalFile, 'utf8')));
    } catch {
      return new Journal();
    }
  }

  persist() {
    fs.mkdirSync(path.dirname(this.journalFile), { recursive: true });
    const tmp = `${this.journalFile}.tmp`;
    if (this.journal.size === 0) { fs.rmSync(this.journalFile, { force: true }); return; }
    fs.writeFileSync(tmp, JSON.stringify(this.journal));
    fs.renameSync(tmp, this.journalFile);
  }

  /** Level data with the pending level operations on top (spawn, rules, ...). */
  async levelPreview() {
    const level = await readLevel(this.worldDir);
    this.journal.applyToLevel(level.value);
    return level.value.Data;
  }

  async info() {
    const d = await this.levelPreview();
    return {
      path: this.worldDir,
      name: this.scan.levelName,
      version: this.scan.version,
      dataVersion: this.scan.dataVersion,
      readOnly: this.readOnly,
      isCopy: isCantiereCopy(this.worldDir),
      spawn: { x: Number(d.SpawnX), y: Number(d.SpawnY), z: Number(d.SpawnZ) },
      time: {
        dayTime: String(d.DayTime ?? 0),
        raining: !!(d.raining && d.raining.v),
        thundering: !!(d.thundering && d.thundering.v),
      },
      gameRules: { ...(d.GameRules || {}) },
      dimensions: this.scan.dimensions.map((x) => ({
        id: x.id, label: x.label, regionCount: x.regionCount, bounds: x.bounds,
      })),
      journal: this.journalState(),
    };
  }

  journalState() {
    return {
      size: this.journal.size,
      canUndo: this.journal.canUndo,
      canRedo: this.journal.canRedo,
      summary: this.journal.summary(),
    };
  }

  ctxFor(dimId, maxY, view = 'blocks') {
    const dim = this.scan.dimensions.find((x) => x.id === dimId);
    if (!dim) throw new Error(`Dimensione sconosciuta: ${dimId}`);
    const key = `${dimId}|${maxY ?? ''}|${view}`;
    if (!this.caches.has(key)) this.caches.set(key, new Map());
    const tiles = this.caches.get(key);
    return {
      source: this.overlay,
      kind: 'base',
      regionDir: dim.regionDir,
      regionSet: this.regionSets.get(dimId),
      cache: {
        get: async (z, x, y) => tiles.get(`${z}/${x}/${y}`) || null,
        set: async (z, x, y, rgba) => { tiles.set(`${z}/${x}/${y}`, rgba); },
      },
      renderOptions: {
        ...(maxY === null || maxY === undefined ? {} : { maxY }),
        ...(view === 'biomes' ? { biomeColor } : {}),
      },
    };
  }

  /** RGBA bytes of a 256x256 tile, or null when there is nothing there. view: 'blocks' | 'biomes'. */
  async tile(dimId, z, x, y, maxY = null, view = 'blocks') {
    const r = await serveTile(this.ctxFor(dimId, maxY, view), z, x, y);
    return r.empty ? null : r.rgba;
  }

  /** What is under the cursor: surface block, its height and biome. */
  async probe(dimId, x, z, maxY = null) {
    const dim = this.scan.dimensions.find((d) => d.id === dimId);
    const g = await readSurface(this.overlay, dim.regionDir, x, z, 1, 1, maxY === null ? {} : { maxY });
    if (g.surfaceY[0] === NO_DATA) return null;
    return { y: g.surfaceY[0], block: g.surfaceName[0], biome: g.biome[0] };
  }

  push(op) { this.assertWritable(); this.journal.push(op); return { ...this.journalState(), dirty: this.takeDirty() }; }
  undo() { this.journal.undo(); return { ...this.journalState(), dirty: this.takeDirty() }; }
  redo() { this.journal.redo(); return { ...this.journalState(), dirty: this.takeDirty() }; }

  assertWritable() {
    if (this.readOnly) throw new Error('Questo mondo è anteriore alla 1.18: il Cantiere lo apre solo in lettura.');
  }

  /** True if level.dat was changed by someone else since the tab was opened. */
  levelChangedOnDisk() {
    return snapshot(path.join(this.worldDir, 'level.dat')) !== this.levelSnapshot;
  }

  suggestedCopyName() {
    return uniqueCopyName(path.dirname(this.worldDir), path.basename(this.worldDir));
  }

  async check(lockCheck) {
    const pre = await preflight({ worldDir: this.worldDir, targetDir: null, journal: this.journal, lockCheck });
    if (this.levelChangedOnDisk()) pre.warnings.push('Il file level.dat dell\'originale è cambiato mentre il mondo era aperto nel Cantiere.');
    return { ...pre, copyName: this.suggestedCopyName() };
  }

  async apply(opts) {
    this.assertWritable();
    const res = await applyJournal({ worldDir: this.worldDir, journal: this.journal, ...opts });
    this.journal.clear();
    this.takeDirty();
    return res;
  }
}

export { TILE_SIZE };
