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
import { createClip, clipMeta } from '../core/clips.js';
import { computeProfiles } from '../core/seam.js';
import { biomeColor } from '../core/biomes.js';
import { applyJournal, preflight, readLevel, readLevelFiles, dataVersionOf, isCantiereCopy, uniqueCopyName, INCOMPLETE_MARK } from '../core/apply.js';
import { runTask } from './tasks.js';
import { claudeStatus, runClaude } from './claude.js';
import { SYSTEM_PROMPT, buildPrompt, parseRecipe, compileRecipe } from '../core/recipe.js';
import { surveyProblem, surveyStats } from '../core/survey.js';
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

/** Invisible in game, solid on a map: looked through when "hide invisible blocks" is on. */
export const INVISIBLE_BLOCKS = ['minecraft:barrier', 'minecraft:light', 'minecraft:structure_void'];

/**
 * The part of a dimension worth showing: the biggest group of neighbouring
 * region files. A few regions far away (a teleport to x = 12,000,000, a
 * chunk-loader test) would otherwise make "fit to window" show a whole
 * continent of nothing. `home` is where to look first: 0,0 when it is part of
 * that group (the End's main island, the Nether under the overworld spawn),
 * else the group's middle.
 */
export function mainArea(regions) {
  if (!regions || !regions.length) return { mainBounds: null, home: { x: 0, z: 0 } };
  const key = (x, z) => `${x},${z}`;
  const left = new Map(regions.map((r) => [key(r.x, r.z), r]));
  const GAP = 3; // regions this close (in region units) belong to the same group
  let best = null;
  while (left.size) {
    const [k0, r0] = left.entries().next().value;
    left.delete(k0);
    const group = [r0], queue = [r0];
    while (queue.length) {
      const r = queue.pop();
      for (let dz = -GAP; dz <= GAP; dz++) for (let dx = -GAP; dx <= GAP; dx++) {
        const k = key(r.x + dx, r.z + dz), n = left.get(k);
        if (n) { left.delete(k); group.push(n); queue.push(n); }
      }
    }
    if (!best || group.length > best.length) best = group;
  }
  const xs = best.map((r) => r.x), zs = best.map((r) => r.z);
  const b = { minX: Math.min(...xs) * 512, minZ: Math.min(...zs) * 512, maxX: (Math.max(...xs) + 1) * 512 - 1, maxZ: (Math.max(...zs) + 1) * 512 - 1 };
  const hasOrigin = best.some((r) => r.x >= -1 && r.x <= 0 && r.z >= -1 && r.z <= 0);
  return { mainBounds: b, home: hasOrigin ? { x: 0, z: 0 } : { x: (b.minX + b.maxX) >> 1, z: (b.minZ + b.maxZ) >> 1 } };
}

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
    if (this.hidden === undefined) this.hidden = new Set(INVISIBLE_BLOCKS);
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
    // A whole-chunk paste can bring regions the scan never saw: the map must ask for their tiles.
    if (op.type === 'paste' && op.mode === 'chunks') {
      const set = this.regionSets.get(op.dim);
      if (set) for (let rz = b.minZ >> 9; rz <= b.maxZ >> 9; rz++) for (let rx = b.minX >> 9; rx <= b.maxX >> 9; rx++) set.add(`${rx},${rz}`);
    }
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
    const id = `${this.cacheKey(dimId, maxY, view)}|${z}/${x}/${y}`;
    if (this.rebuildQueued.has(id)) return;
    this.rebuildQueued.add(id);
    this.rebuildChain = this.rebuildChain.then(async () => {
      try {
        const ctx = this.ctxFor(dimId, maxY, view);
        const r = await getTile(ctx, z, x, y, true);
        if (!r.partial) this.staleOf(this.cacheKey(dimId, maxY, view)).delete(`${z}/${x}/${y}`);
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
      icon: this.iconUrl(),
      dimensions: this.scan.dimensions.map((x) => ({
        id: x.id, label: x.label, regionCount: x.regionCount, bounds: x.bounds, ...mainArea(x.regions),
      })),
      journal: this.journalState(),
    };
  }

  /** The world's picture as a data URL: the pending one if there is one, else icon.png, else null. */
  iconUrl() {
    const pending = this.journal.pendingIcon();
    if (pending) return `data:image/png;base64,${pending}`;
    try { return `data:image/png;base64,${fs.readFileSync(path.join(this.worldDir, 'icon.png')).toString('base64')}`; } catch { return null; }
  }

  journalState() {
    return {
      size: this.journal.size,
      canUndo: this.journal.canUndo,
      canRedo: this.journal.canRedo,
      summary: this.journal.summary(),
    };
  }

  /** One tile cache per dimension, cut height, view and invisible-blocks setting. */
  cacheKey(dimId, maxY, view) { return `${dimId}|${maxY ?? ''}|${view}|${this.hidden ? 'h' : ''}`; }

  ctxFor(dimId, maxY, view = 'blocks') {
    const dim = this.scan.dimensions.find((x) => x.id === dimId);
    if (!dim) throw new Error(`Dimensione sconosciuta: ${dimId}`);
    const key = this.cacheKey(dimId, maxY, view);
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
        ...(this.hidden ? { hiddenBlocks: this.hidden } : {}),
      },
    };
  }

  /** Look through barriers, light blocks and structure voids on the map (true) or draw them (false). */
  setHideInvisible(on) { this.hidden = on ? new Set(INVISIBLE_BLOCKS) : null; }

  /** RGBA bytes of a 256x256 tile, or null when there is nothing there. view: 'blocks' | 'biomes'. */
  async tile(dimId, z, x, y, maxY = null, view = 'blocks') {
    const r = await serveTile(this.ctxFor(dimId, maxY, view), z, x, y);
    if (r.partial && z <= -2) {
      // Far zooms are only composed from tiles already built: build this one in
      // the background (the window is told when it is ready) instead of leaving
      // it black until somebody happens to look at the area up close.
      this.scheduleRebuild(dimId, maxY, view, z, x, y);
      const old = this.stale.get(this.cacheKey(dimId, maxY, view))?.get(`${z}/${x}/${y}`);
      if (old) return old;
    }
    return r.empty ? null : r.rgba;
  }

  /** What is under the cursor: surface block, its height and biome. */
  async probe(dimId, x, z, maxY = null) {
    const dim = this.scan.dimensions.find((d) => d.id === dimId);
    const g = await readSurface(this.overlay, dim.regionDir, x, z, 1, 1, { ...(maxY === null ? {} : { maxY }), ...(this.hidden ? { hiddenBlocks: this.hidden } : {}) });
    if (g.surfaceY[0] === NO_DATA) return null;
    return { y: g.surfaceY[0], block: g.surfaceName[0], biome: g.biome[0] };
  }

  push(op) { this.assertWritable(); this.journal.push(op); return { ...this.journalState(), dirty: this.takeDirty() }; }
  undo() { this.journal.undo(); return { ...this.journalState(), dirty: this.takeDirty() }; }
  redo() { this.journal.redo(); return { ...this.journalState(), dirty: this.takeDirty() }; }
  removeAt(i) { this.journal.removeAt(i); return { ...this.journalState(), dirty: this.takeDirty() }; }

  /** Copy the selection into a new clip (see clips.js) under clipsDir. */
  copy(dimId, selection, clipsDir) {
    const dim = this.scan.dimensions.find((d) => d.id === dimId);
    if (!dim) throw new Error(`Dimensione sconosciuta: ${dimId}`);
    return createClip({
      worldDir: this.worldDir, modern: this.base.modernLayout, dim: dimId, selection, clipsDir,
      worldName: this.scan.levelName, dataVersion: this.scan.dataVersion,
    });
  }

  /** Check a paste against this world before it goes in the journal. Returns warnings. */
  pasteWarnings(op) {
    const clip = clipMeta(op.clip);
    if (!clip) throw new Error('L\'appunto da incollare non esiste più.');
    if (clip.dim !== op.dim) throw new Error(`L'appunto viene da un'altra dimensione (${clip.dim}).`);
    const warnings = [];
    const mine = this.scan.dataVersion, theirs = clip.dataVersion;
    if (mine && theirs && theirs > mine) throw new Error('L\'appunto viene da una versione di Minecraft più recente di questo mondo.');
    if (mine && theirs && theirs < mine && op.mode === 'blocks') warnings.push('L\'appunto viene da una versione più vecchia: a blocchi alcuni nomi potrebbero non esistere più. A chunk interi il gioco li aggiorna da sé.');
    return warnings;
  }

  /** The box of the last pending paste in this dimension, or null. */
  lastPasteBox(dimId) {
    const op = [...this.journal.ops].reverse().find((o) => o.type === 'paste' && o.dim === dimId);
    return op ? { ...op.to } : null;
  }

  /**
   * Measure the ground along the chosen sides of a box (pending changes
   * included) and put a smoothTerrain operation in the journal.
   */
  async smooth(params) {
    this.assertWritable();
    const dim = this.scan.dimensions.find((d) => d.id === params.dim);
    if (!dim) throw new Error(`Dimensione sconosciuta: ${params.dim}`);
    const prof = await computeProfiles({ source: this.overlay, regionDir: dim.regionDir, ...params });
    return this.push({ type: 'smoothTerrain', ...params, prof });
  }

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

  /** Read the ground of the selected columns, in a worker (see survey.js). */
  survey(dimId, selection, onProgress) {
    return runTask('survey', {
      worldDir: this.worldDir, journal: this.journal.toJSON(), dim: dimId, regions: this.regionsOf(dimId), selection,
    }, onProgress);
  }

  /**
   * Ask Claude to change the selected area: survey it, send the description to
   * the user's Claude Code CLI (their subscription, no tools), compile the
   * answer into one `group` operation. Nothing is pushed: the window shows the
   * result and pushes it. Returns { promise, cancel }.
   * onProgress({ phase: 'controllo' | 'lettura' | 'claude' | 'compila', ... })
   */
  askClaude({ dim, selection, request, model = 'opus', claudePath = null }, onProgress = () => {}) {
    let current = null, cancelled = false;
    const stop = () => { if (cancelled) throw Object.assign(new Error('Annullato.'), { cancelled: true }); };
    const promise = (async () => {
      this.assertWritable();
      if (!String(request || '').trim()) throw new Error('Scrivi cosa vuoi che Claude faccia nell\'area.');
      const problem = surveyProblem(selection);
      if (problem) throw new Error(problem);
      onProgress({ phase: 'controllo' });
      const st = await claudeStatus(claudePath);
      if (!st.ok) throw new Error(st.error);
      stop();
      current = this.survey(dim, selection, (p) => onProgress({ phase: 'lettura', ...p }));
      const survey = await current.promise;
      stop();
      const stats = surveyStats(survey);
      if (!stats.known) throw new Error('Nell\'area selezionata non c\'è terreno (chunk vuoti o non generati).');
      const prompt = buildPrompt(request, survey);
      // Kept on disk for a look when something goes wrong (last 10 requests).
      const logDir = path.join(this.dataDir, 'claude', new Date().toISOString().replace(/[:.]/g, '-'));
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(path.join(logDir, 'prompt.txt'), prompt);
      pruneLogs(path.dirname(logDir), 10);
      current = runClaude({ exe: st.exe, prompt, system: SYSTEM_PROMPT, model, onEvent: (e) => onProgress({ ...e, phase: 'claude', step: e.phase }) });
      const reply = await current.promise;
      current = null;
      fs.writeFileSync(path.join(logDir, 'answer.txt'), reply.text);
      onProgress({ phase: 'compila' });
      const recipe = parseRecipe(reply.text);
      const seed = Math.floor(Math.random() * 1e9);
      const out = compileRecipe(recipe, survey, { selection, request, seed });
      return {
        ...out, explanation: String(recipe.explanation || ''), seconds: reply.seconds, model,
        area: { w: survey.w, d: survey.d, columns: stats.columns }, logDir,
      };
    })();
    return {
      promise,
      cancel: async () => { cancelled = true; if (current) await current.cancel(); },
    };
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

/** Keep only the newest `keep` folders of a log directory. */
function pruneLogs(dir, keep) {
  try {
    const all = fs.readdirSync(dir).sort();
    for (const old of all.slice(0, Math.max(0, all.length - keep))) fs.rmSync(path.join(dir, old), { recursive: true, force: true });
  } catch { /* nothing to prune */ }
}

export { TILE_SIZE };
