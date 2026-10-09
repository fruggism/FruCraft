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
import { serveTile, getTile, regionSetOf, tileRangeFor, blocksPerTile, TILE_SIZE, MIN_ZOOM, NATIVE_ZOOM } from '../../web/js/core/tiler.js';
import { readSurface, forgetRegions, NO_DATA } from '../../web/js/core/anvil.js';
import { NodeSource } from '../core/nodeSource.js';
import { OverlaySource } from '../core/overlay.js';
import { Journal, chunkBoundsOf, levelSummary } from '../core/journal.js';
import { biomeColor } from '../core/biomes.js';
import { applyJournal, preflight, readLevel, readLevelFiles, dataVersionOf, isCantiereCopy, uniqueCopyName, INCOMPLETE_MARK } from '../core/apply.js';
import { runTask } from './tasks.js';
import { MIN_DATA_VERSION } from '../core/chunk.js';

export const defaultSavesDir = () => (process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support', 'minecraft', 'saves')
  : path.join(os.homedir(), '.minecraft', 'saves'));

/**
 * Worlds found in a saves folder, newest first, with what the start screen
 * shows: version, dimensions, the game's own screenshot (icon.png).
 */
export async function listWorlds(savesDir) {
  let entries;
  try { entries = fs.readdirSync(savesDir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(savesDir, e.name);
    let st;
    try { st = fs.statSync(path.join(dir, 'level.dat')); } catch { continue; }
    const w = { name: e.name, path: dir, modified: st.mtimeMs, cantiere: isCantiereCopy(dir), version: null, dataVersion: null, icon: null };
    try {
      const d = (await readLevel(dir)).value.Data;
      w.name = String(d.LevelName || e.name);
      w.version = d.Version && d.Version.Name ? String(d.Version.Name) : null;
      w.dataVersion = d.DataVersion !== undefined ? Number(d.DataVersion) : null;
    } catch { /* unreadable level.dat: list it anyway */ }
    w.folder = e.name;
    w.readOnly = w.dataVersion !== null && w.dataVersion < MIN_DATA_VERSION;
    w.dimensions = ['Overworld',
      ...(fs.existsSync(path.join(dir, 'DIM-1', 'region')) ? ['Nether'] : []),
      ...(fs.existsSync(path.join(dir, 'DIM1', 'region')) ? ['End'] : [])];
    try { w.icon = `data:image/png;base64,${fs.readFileSync(path.join(dir, 'icon.png')).toString('base64')}`; } catch { /* no screenshot */ }
    out.push(w);
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
    this.stale = new Map();          // cache key -> Map of outdated zoomed-out tiles
    this.rebuildQueued = new Set();
    this.rebuildChain = Promise.resolve();
    this.onTilesReady = null;        // set by the main process: (box) => notify the window
    this.journal.onChange((_j, op) => { this.invalidate(op); this.persist(); });
    this.regionSets = new Map(this.scan.dimensions.map((d) => [d.id, regionSetOf(d.regions)]));
  }

  /**
   * Forget what an operation changed: the region files under it and the
   * tiles over it, at every zoom. Level operations change no tile. The
   * boxes are remembered in this.dirty for the window to redraw.
   *
   * Zoomed-out tiles (z <= -2) are never rendered while serving — they are
   * composed from finer cached tiles — so dropping them would leave holes in
   * a zoomed-out map after every edit. They are kept as "stale" instead, shown
   * until a background rebuild replaces them (see tile()).
   */
  invalidate(op) {
    const b = chunkBoundsOf(op);
    if (!op) {
      for (const [key, tiles] of this.caches) {
        for (const [tk, rgba] of tiles) if (Number(tk.split('/')[0]) <= -2) this.staleOf(key).set(tk, rgba);
      }
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
          for (let tx = r.minTX; tx <= r.maxTX; tx++) {
            const tk = `${z}/${tx}/${ty}`;
            if (z <= -2 && tiles.has(tk)) this.staleOf(key).set(tk, tiles.get(tk));
            tiles.delete(tk);
          }
        }
      }
    }
    this.dirty.push({ dim: op.dim, bounds: b });
  }

  staleOf(key) {
    if (!this.stale.has(key)) this.stale.set(key, new Map());
    return this.stale.get(key);
  }

  /**
   * Re-render a zoomed-out tile in the background (one at a time), then tell
   * the window its area changed. Only down to z = -3 (64 base tiles); further
   * out, tiles are composed from those once they exist.
   */
  scheduleRebuild(dimId, maxY, view, z, x, y) {
    const id = `${dimId}|${maxY ?? ''}|${view}|${z}/${x}/${y}`;
    if (this.rebuildQueued.has(id)) return;
    this.rebuildQueued.add(id);
    this.rebuildChain = this.rebuildChain.then(async () => {
      try {
        const ctx = this.ctxFor(dimId, maxY, view);
        const r = await getTile(ctx, z, x, y, true);
        if (!r.partial) this.staleOf(`${dimId}|${maxY ?? ''}|${view}`).delete(`${z}/${x}/${y}`);
        const span = blocksPerTile(z);
        if (this.onTilesReady) this.onTilesReady({ dim: dimId, bounds: { minX: x * span, minZ: y * span, maxX: (x + 1) * span - 1, maxZ: (y + 1) * span - 1 } });
      } catch { /* the window will ask again */ }
      this.rebuildQueued.delete(id);
    });
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
    const files = await readLevelFiles(this.worldDir);
    this.journal.applyToLevel(level.value, files);
    return { level: level.value, files };
  }

  async info() {
    const { level, files } = await this.levelPreview();
    const summary = levelSummary(level, files);
    return {
      path: this.worldDir,
      name: this.scan.levelName,
      version: this.scan.version,
      dataVersion: this.scan.dataVersion,
      readOnly: this.readOnly,
      isCopy: isCantiereCopy(this.worldDir),
      spawn: summary.spawn,
      time: summary.time,
      gameRules: summary.gameRules,
      splitLevel: summary.split,
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
    if (r.partial && z <= -2) {
      const old = this.stale.get(`${dimId}|${maxY ?? ''}|${view}`)?.get(`${z}/${x}/${y}`);
      if (old) {
        if (z >= -3) this.scheduleRebuild(dimId, maxY, view, z, x, y);
        return old;
      }
    }
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
  removeAt(i) { this.journal.removeAt(i); return { ...this.journalState(), dirty: this.takeDirty() }; }

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

  regionsOf(dimId) {
    const dim = this.scan.dimensions.find((d) => d.id === dimId);
    if (!dim) throw new Error(`Dimensione sconosciuta: ${dimId}`);
    return dim.regions.map((r) => ({ x: r.x, z: r.z }));
  }

  /** Search the dimension (or the selection) in a worker. Returns { promise, cancel }. */
  search(dimId, selection, query, onProgress) {
    return runTask('search', {
      worldDir: this.worldDir, journal: this.journal.toJSON(), dim: dimId,
      regions: this.regionsOf(dimId), selection, query,
    }, onProgress);
  }

  /** How many blocks a replaceBlocks operation would change, in a worker. */
  countReplace(op, onProgress) {
    return runTask('countReplace', {
      worldDir: this.worldDir, journal: this.journal.toJSON(), dim: op.dim, regions: this.regionsOf(op.dim), op,
    }, onProgress);
  }

  /**
   * Apply in a worker. Returns { promise, cancel }. A cancelled Apply removes
   * its unfinished copy (marked incomplete — never the original); a failed one
   * keeps it, marked, for a look.
   */
  applyInWorker({ copyName, overwrite = false, onProgress = () => {}, skipLockCheck = false } = {}) {
    this.assertWritable();
    const name = copyName || this.suggestedCopyName();
    const targetDir = path.join(path.dirname(this.worldDir), name);
    const task = runTask('apply', {
      worldDir: this.worldDir, journal: this.journal.toJSON(), copyName: name, overwrite, skipLockCheck,
    }, onProgress);
    const promise = task.promise.then((res) => {
      this.journal.clear();
      this.takeDirty();
      return res;
    }, (err) => {
      if (err.cancelled && path.resolve(targetDir) !== path.resolve(this.worldDir)
        && fs.existsSync(path.join(targetDir, INCOMPLETE_MARK))) {
        fs.rmSync(targetDir, { recursive: true, force: true });
      }
      throw err;
    });
    return { promise, cancel: task.cancel, targetDir };
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
