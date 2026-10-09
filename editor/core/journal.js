/*
 * The journal: every pending change, in order, and nothing else.
 *
 * Operations are small plain objects — JSON in, JSON out — so the journal can
 * be written to disk after every change and survive a crash. The world is
 * never touched while they pile up: the map shows the world read from disk with
 * the journal laid over it (OverlaySource), and "Apply" replays the very same
 * operations onto a copy.
 *
 * Operations come in three kinds:
 *   level  — change level.dat; folded into its tree with applyLevelOp
 *   chunk  — change blocks/biomes; applied to one chunk with applyChunkOp
 *   world  — delete chunks and files (Free space); carried out by Apply after
 *            the chunk operations, see WORLD_OPS
 * Undo and redo just move operations between the two stacks.
 */

import { TByte, TLong, TFloat, TDouble, TShort, TIntArray } from '../../web/js/core/nbt.js';
import { ChunkEditor, parseState, stateKey } from './chunk.js';
import { dimensionInfo } from './dimensions.js';
import { selectionBounds, chunkMask, yRange } from './selection.js';
import { blockMatcher, compileMix, pickFromMix, carryProperties, hash3 } from './blocks.js';
import { AIR_NAMES } from '../../web/js/core/anvil.js';
import { readSpawn } from '../../web/js/core/worldScan.js';
import { setTerrain, placeFeatures } from './terrain.js';
import { PASTE } from './paste.js';
import { SMOOTH } from './seam.js';
import { decodeMask } from './freeSpace.js';

// ---------------------------------------------------------------------------
// Level operations
// ---------------------------------------------------------------------------

const KINDS = {
  byte: (v) => new TByte(v ? Number(v) : 0),
  short: (v) => new TShort(Number(v)),
  int: (v) => Number(v) | 0,
  long: (v) => new TLong(v),
  float: (v) => new TFloat(Number(v)),
  double: (v) => new TDouble(Number(v)),
  string: (v) => String(v),
};

function ensurePath(root, path) {
  let node = root;
  for (const key of path.slice(0, -1)) {
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
    node = node[key];
  }
  return node;
}

/*
 * From 26.x (1.21.9 onwards, in steps) time, weather and game rules left
 * level.dat for files of their own. Level operations work on both layouts:
 * they get the level.dat tree plus `files`, { relative path -> parsed root },
 * holding whichever of these exist (an op creates one when it must).
 */
export const LEVEL_FILES = {
  clocks: 'data/minecraft/world_clocks.dat',
  weather: 'data/minecraft/weather.dat',
  gameRules: 'data/minecraft/game_rules.dat',
};
const OVERWORLD_CLOCK = 'minecraft:overworld';

/** Does this world keep time, weather and rules outside level.dat? */
export function isSplitLevel(level, files = {}) {
  const d = level.Data || {};
  if (Object.values(LEVEL_FILES).some((rel) => files[rel])) return true;
  return !('DayTime' in d) && !('GameRules' in d) && !('raining' in d);
}

/** The `data` compound of one of LEVEL_FILES, created when missing. */
function fileData(level, files, rel) {
  if (!files[rel]) files[rel] = { data: {}, DataVersion: Number(level.Data?.DataVersion || 0) };
  if (typeof files[rel].data !== 'object' || files[rel].data === null) files[rel].data = {};
  return files[rel].data;
}

const val = (x) => (x !== null && typeof x === 'object' && 'v' in x ? x.v : x);

/**
 * What the level panel shows, from either layout: spawn, time, weather and the
 * game rules as strings ('true' / 'false' / a number), keyed by their own names.
 */
export function levelSummary(level, files = {}) {
  const d = level.Data || {};
  if (!isSplitLevel(level, files)) {
    return {
      split: false,
      spawn: readSpawn(d),
      time: { dayTime: String(val(d.DayTime) ?? 0), raining: !!val(d.raining), thundering: !!val(d.thundering) },
      gameRules: { ...(d.GameRules || {}) },
    };
  }
  const clock = files[LEVEL_FILES.clocks]?.data?.[OVERWORLD_CLOCK];
  const ticks = BigInt(val(clock?.total_ticks) ?? 0);
  const w = files[LEVEL_FILES.weather]?.data || {};
  const rules = {};
  for (const [k, v] of Object.entries(files[LEVEL_FILES.gameRules]?.data || {})) {
    rules[k] = v instanceof TByte ? (v.v ? 'true' : 'false') : String(val(v));
  }
  return {
    split: true,
    spawn: readSpawn(d),
    time: { dayTime: String(((ticks % 24000n) + 24000n) % 24000n), raining: !!val(w.raining), thundering: !!val(w.thundering) },
    gameRules: rules,
  };
}

export const LEVEL_OPS = {
  /** Set the world spawn. Handles both the old (SpawnX/Y/Z) and new (Data.spawn) layouts. */
  setSpawn(op, level) {
    const d = level.Data;
    if (d.spawn && typeof d.spawn === 'object') {
      d.spawn.pos = new TIntArray([op.x | 0, op.y | 0, op.z | 0]);
      if (op.angle !== undefined) d.spawn.yaw = new TFloat(op.angle);
      return;
    }
    d.SpawnX = op.x | 0;
    d.SpawnY = op.y | 0;
    d.SpawnZ = op.z | 0;
    if (op.angle !== undefined) d.SpawnAngle = new TFloat(op.angle);
  },
  /** Set any value in level.dat by path, with an explicit tag type. */
  setLevelValue(op, level) {
    const node = ensurePath(level, op.path);
    node[op.path[op.path.length - 1]] = KINDS[op.kind](op.value);
  },
  /**
   * Game rules: strings ('true', 'false' or a number) in level.dat; from 26.x
   * bytes and ints in game_rules.dat, under names like minecraft:keep_inventory.
   */
  setGameRule(op, level, files = {}) {
    if (isSplitLevel(level, files)) {
      const v = op.value;
      const bool = typeof v === 'boolean' || v === 'true' || v === 'false';
      fileData(level, files, LEVEL_FILES.gameRules)[op.rule] = bool ? new TByte(v === true || v === 'true' ? 1 : 0) : Number(v) | 0;
      return;
    }
    const d = level.Data;
    if (!d.GameRules || typeof d.GameRules !== 'object') d.GameRules = {};
    d.GameRules[op.rule] = String(op.value);
  },
  /** Time of day in ticks (0 = sunrise): DayTime, or the overworld clock from 26.x. */
  setDayTime(op, level, files = {}) {
    const t = Math.max(0, Math.floor(Number(op.value) || 0));
    if (!isSplitLevel(level, files)) { level.Data.DayTime = new TLong(t); return; }
    const clocks = fileData(level, files, LEVEL_FILES.clocks);
    const clock = clocks[OVERWORLD_CLOCK] && typeof clocks[OVERWORLD_CLOCK] === 'object' ? clocks[OVERWORLD_CLOCK] : (clocks[OVERWORLD_CLOCK] = { paused: new TByte(0) });
    // Keep the days already lived, move to the chosen time of the current one.
    const now = BigInt(val(clock.total_ticks) ?? 0);
    clock.total_ticks = now - (((now % 24000n) + 24000n) % 24000n) + BigInt(t % 24000);
  },
  /** The world's picture (icon.png, 64x64): not in level.dat, Apply writes the file. */
  setIcon() {},
  /** Weather: 'clear' | 'rain' | 'storm', for the next 6000 ticks (5 minutes). */
  setWeather(op, level, files = {}) {
    const rain = op.kind !== 'clear', storm = op.kind === 'storm';
    if (!isSplitLevel(level, files)) {
      const d = level.Data;
      d.raining = new TByte(rain ? 1 : 0);
      d.thundering = new TByte(storm ? 1 : 0);
      if (rain) d.rainTime = 6000;
      if (storm) d.thunderTime = 6000;
      if (!rain) d.clearWeatherTime = 6000;
      return;
    }
    const w = fileData(level, files, LEVEL_FILES.weather);
    w.raining = new TByte(rain ? 1 : 0);
    w.thundering = new TByte(storm ? 1 : 0);
    if (rain) w.rain_time = 6000;
    if (storm) w.thunder_time = 6000;
    if (!rain) w.clear_weather_time = 6000;
  },
};

// ---------------------------------------------------------------------------
// Chunk operations
// ---------------------------------------------------------------------------

const blockRange = (op) => ({
  minX: Math.min(op.x1, op.x2), maxX: Math.max(op.x1, op.x2),
  minY: Math.min(op.y1, op.y2), maxY: Math.max(op.y1, op.y2),
  minZ: Math.min(op.z1, op.z2), maxZ: Math.max(op.z1, op.z2),
});

export const CHUNK_OPS = {
  /** Fill a box with one block state. */
  fillBox: {
    bounds: blockRange,
    validate(op) {
      for (const k of ['x1', 'y1', 'z1', 'x2', 'y2', 'z2']) if (!Number.isFinite(Number(op[k]))) throw new Error(`Riempimento: coordinata ${k} non valida.`);
      const st = parseState(String(op.state || ''));
      if (!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(st.Name)) throw new Error(`Riempimento: blocco non valido “${op.state}”.`);
    },
    apply(op, ed, cx, cz) {
      const r = blockRange(op);
      const state = parseState(op.state);
      const info = dimensionInfo(op.dim);
      const y0 = Math.max(r.minY, info.minY);
      const y1 = Math.min(r.maxY, info.minY + info.height - 1);
      for (let z = Math.max(r.minZ, cz * 16); z <= Math.min(r.maxZ, cz * 16 + 15); z++) {
        for (let x = Math.max(r.minX, cx * 16); x <= Math.min(r.maxX, cx * 16 + 15); x++) {
          for (let y = y0; y <= y1; y++) ed.setState(x, y, z, state);
        }
      }
    },
    /** A block that must read back as the operation says (used by the verifier). */
    probe(op) {
      const r = blockRange(op);
      const info = dimensionInfo(op.dim);
      const y = Math.max(r.minY, info.minY);
      return { x: r.minX, y, z: r.minZ, state: parseState(op.state) };
    },
  },
};

/*
 * Replace: the rules are compiled once per operation (cached on the op object,
 * which the journal never mutates) and each section is first checked through
 * its palette, so a section with nothing to replace costs one pass over a
 * palette of a few entries, not 4096 lookups.
 */
const compiledRules = new WeakMap();
function rulesOf(op) {
  let c = compiledRules.get(op);
  if (!c) {
    c = op.rules.map((r) => ({ match: blockMatcher(r.from), mix: compileMix(r.to) }));
    compiledRules.set(op, c);
  }
  return c;
}

const isAirState = (s) => AIR_NAMES.has(s.Name);

/** Is the block at (x, y, z) next to air? Neighbours outside this chunk don't count. */
function exposed(ed, x, y, z) {
  const x0 = ed.xPos * 16, z0 = ed.zPos * 16;
  const top = ed.minY + ed.height - 1;
  for (const [dx, dy, dz] of [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
    const nx = x + dx, ny = y + dy, nz = z + dz;
    if (ny < ed.minY || ny > top) continue;
    if (nx < x0 || nx > x0 + 15 || nz < z0 || nz > z0 + 15) continue;
    if (isAirState(ed.getState(nx, ny, nz))) return true;
  }
  return false;
}

/**
 * Walk the blocks a replaceBlocks op changes in one chunk, without changing
 * them: visit(x, y, z, newState, dropped). Shared by apply and the preview count.
 */
export function visitReplace(op, ed, cx, cz, visit) {
  const mask = chunkMask(op.region, cx, cz);
  if (!mask) return;
  const info = dimensionInfo(op.dim);
  let [lo, hi] = yRange(op.region, info.minY, info.height);
  if (op.yMin !== null && op.yMin !== undefined) lo = Math.max(lo, Number(op.yMin));
  if (op.yMax !== null && op.yMax !== undefined) hi = Math.min(hi, Number(op.yMax));
  if (lo > hi) return;
  const rules = rulesOf(op);
  const biomes = op.biomes && op.biomes.length ? new Set(op.biomes) : null;
  const seed = op.seed | 0;
  for (let sy = lo >> 4; sy <= hi >> 4; sy++) {
    const sec = ed.section(sy);
    if (!sec) continue;
    const ruleOf = sec.palette.map((st) => rules.findIndex((r) => r.match(st)));
    if (ruleOf.every((i) => i < 0)) continue;
    const yFrom = Math.max(lo, sy * 16), yTo = Math.min(hi, sy * 16 + 15);
    for (let y = yFrom; y <= yTo; y++) {
      for (let lz = 0; lz < 16; lz++) {
        for (let lx = 0; lx < 16; lx++) {
          if (!mask[lz * 16 + lx]) continue;
          const from = sec.palette[sec.blocks[((y & 15) << 8) | (lz << 4) | lx]];
          const ri = ruleOf[sec.blocks[((y & 15) << 8) | (lz << 4) | lx]];
          if (ri < 0) continue;
          const x = cx * 16 + lx, z = cz * 16 + lz;
          if (op.exposedOnly && !exposed(ed, x, y, z)) continue;
          if (biomes && !biomes.has(ed.getBiome(x, y, z))) continue;
          const to = pickFromMix(rules[ri].mix, hash3(x, y, z, seed + ri));
          const { state, dropped } = carryProperties(from, to, op.keepProps !== false);
          if (stateKey(state) === stateKey(from)) continue;
          visit(x, y, z, state, dropped);
        }
      }
    }
  }
}

CHUNK_OPS.replaceBlocks = {
  bounds: (op) => selectionBounds(op.region),
  validate(op) {
    if (!Array.isArray(op.rules) || !op.rules.length) throw new Error('Nessuna regola di sostituzione.');
    rulesOf(op);
  },
  apply(op, ed, cx, cz) {
    const changes = [];
    visitReplace(op, ed, cx, cz, (x, y, z, state) => changes.push([x, y, z, state]));
    for (const [x, y, z, state] of changes) ed.setState(x, y, z, state);
  },
};

/**
 * Paint a biome. Biomes are stored per 4x4x4 cell; a cell is painted when the
 * column at its centre is selected, so a brush paints whole cells, the way the
 * game itself sees biomes. Missing sections are not created for a biome.
 */
CHUNK_OPS.paste = PASTE;
CHUNK_OPS.smoothTerrain = SMOOTH;

CHUNK_OPS.paintBiome = {
  bounds: (op) => selectionBounds(op.region),
  validate(op) {
    if (!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(String(op.biome))) throw new Error(`Bioma non valido: ${op.biome}`);
  },
  apply(op, ed, cx, cz) {
    const mask = chunkMask(op.region, cx, cz);
    if (!mask) return;
    const info = dimensionInfo(op.dim);
    const [lo, hi] = yRange(op.region, info.minY, info.height);
    for (let z4 = 0; z4 < 4; z4++) {
      for (let x4 = 0; x4 < 4; x4++) {
        if (!mask[(z4 * 4 + 2) * 16 + x4 * 4 + 2]) continue;
        for (let y = Math.floor(lo / 4) * 4; y <= hi; y += 4) {
          if (!ed.section(y >> 4)) continue;
          ed.setBiome(cx * 16 + x4 * 4, y, cz * 16 + z4 * 4, op.biome);
        }
      }
    }
  },
};

/** Terrain heights and trees: see terrain.js. */
CHUNK_OPS.setTerrain = setTerrain;
CHUNK_OPS.placeFeatures = placeFeatures;

const touches = (b, cx, cz) => !!b && b.maxX >= cx * 16 && b.minX <= cx * 16 + 15 && b.maxZ >= cz * 16 && b.minZ <= cz * 16 + 15;

/**
 * Several chunk operations of one dimension as a single journal entry (one
 * line in the history, one undo): what "Ask Claude" produces. They run in
 * their own order inside each chunk.
 */
CHUNK_OPS.group = {
  bounds(op) {
    let b = null;
    for (const sub of op.ops || []) {
      const s = CHUNK_OPS[sub.type] && CHUNK_OPS[sub.type].bounds(sub);
      if (!s) continue;
      b = !b ? { ...s } : {
        minX: Math.min(b.minX, s.minX), maxX: Math.max(b.maxX, s.maxX),
        minZ: Math.min(b.minZ, s.minZ), maxZ: Math.max(b.maxZ, s.maxZ),
      };
    }
    return b;
  },
  validate(op) {
    if (!Array.isArray(op.ops) || !op.ops.length) throw new Error('Il gruppo è vuoto.');
    op.ops.forEach((sub, i) => {
      const def = CHUNK_OPS[sub && sub.type];
      const where = `Operazione ${i + 1} (${sub && sub.type})`;
      if (!def || sub.type === 'group') throw new Error(`${where}: tipo non ammesso in un gruppo.`);
      if (sub.dim !== op.dim) throw new Error(`${where}: dimensione diversa da quella del gruppo.`);
      if (!def.bounds(sub)) throw new Error(`${where}: area vuota.`);
      try { if (def.validate) def.validate(sub); } catch (err) { throw new Error(`${where}: ${err.message}`); }
    });
  },
  apply(op, ed, cx, cz) {
    for (const sub of op.ops) {
      const def = CHUNK_OPS[sub.type];
      if (touches(def.bounds(sub), cx, cz)) def.apply(sub, ed, cx, cz);
    }
  },
};

// ---------------------------------------------------------------------------
// World operations
// ---------------------------------------------------------------------------

/** A path inside the world folder, '/'-separated, that can't climb out of it. */
export function safeRel(rel) {
  const s = String(rel);
  if (!s || s.startsWith('/') || s.includes('\\') || /^[a-zA-Z]:/.test(s)) return false;
  return s.split('/').every((p) => p && p !== '.' && p !== '..');
}

export const WORLD_OPS = {
  /**
   * Free space: delete chunks from region / entities / poi files and whole
   * files or folders. See freeSpace.js for the shape. It deletes whatever
   * the other operations did in those chunks, in whatever order they came.
   */
  freeSpace: {
    validate(op) {
      const files = op.files && typeof op.files === 'object' ? op.files : null;
      if (!files || !Array.isArray(op.remove || []) || !Array.isArray(op.dirs || [])) throw new Error('Operazione "Libera spazio" non valida.');
      for (const [rel, mask] of Object.entries(files)) {
        if (!safeRel(rel) || !/\.mca$/.test(rel)) throw new Error(`File non valido: ${rel}`);
        if (mask !== '') decodeMask(mask);
      }
      for (const rel of op.remove || []) if (!safeRel(rel) || !/\.mcc$/.test(rel)) throw new Error(`File non valido: ${rel}`);
      for (const rel of op.dirs || []) {
        if (!safeRel(rel) || !['region', 'entities', 'poi', 'DIM-1', 'DIM1'].includes(rel)) throw new Error(`Cartella non valida: ${rel}`);
      }
      if (!Object.keys(files).length && !(op.remove || []).length && !(op.dirs || []).length) throw new Error('Non c\'è niente da liberare.');
    },
  },
};

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = 'iVBORw0KGg'; // base64 of the PNG header (the first 60 bits of it)
function validateIcon(op) {
  if (typeof op.png !== 'string' || !op.png.startsWith(PNG_SIGNATURE)) throw new Error('L\'icona deve essere un PNG.');
  if (op.png.length > 400000) throw new Error('Icona troppo grande.');
}

export class Journal {
  constructor(ops = []) {
    this.done = ops.slice();
    this.undone = [];
    this.listeners = new Set();
  }

  /** fn(journal, op): op is the operation that came or went, or null when everything changed. */
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(op = null) { for (const fn of this.listeners) fn(this, op); }

  push(op) {
    if (!LEVEL_OPS[op.type] && !CHUNK_OPS[op.type] && !WORLD_OPS[op.type]) throw new Error(`Operazione sconosciuta: ${op.type}`);
    if (op.type === 'setIcon') validateIcon(op);
    if (WORLD_OPS[op.type]) WORLD_OPS[op.type].validate(op);
    const def = CHUNK_OPS[op.type];
    if (def) {
      if (!def.bounds(op)) throw new Error('La selezione è vuota.');
      if (def.validate) def.validate(op);
    }
    this.done.push(op);
    this.undone.length = 0;
    this.emit(op);
    return op;
  }

  get canUndo() { return this.done.length > 0; }
  get canRedo() { return this.undone.length > 0; }
  undo() { if (!this.canUndo) return null; const op = this.done.pop(); this.undone.push(op); this.emit(op); return op; }
  redo() { if (!this.canRedo) return null; const op = this.undone.pop(); this.done.push(op); this.emit(op); return op; }
  /** Drop one pending operation, wherever it is in the list. */
  removeAt(index) {
    if (index < 0 || index >= this.done.length) return null;
    const [op] = this.done.splice(index, 1);
    this.emit(op);
    return op;
  }

  clear() { this.done.length = 0; this.undone.length = 0; this.emit(); }

  get size() { return this.done.length; }
  get ops() { return this.done; }

  levelOps() { return this.done.filter((o) => LEVEL_OPS[o.type]); }
  /** The icon a pending setIcon will write (PNG as base64), or null. */
  pendingIcon() { const op = this.done.filter((o) => o.type === 'setIcon').pop(); return op ? op.png : null; }
  chunkOps() { return this.done.filter((o) => CHUNK_OPS[o.type]); }
  worldOps() { return this.done.filter((o) => WORLD_OPS[o.type]); }

  /** Pending operations counted by type, for the confirmation dialog. */
  summary() {
    const out = {};
    for (const op of this.done) out[op.type] = (out[op.type] || 0) + 1;
    return out;
  }

  /** Lowest-common-denominator version marker, bumped when an op's shape changes. */
  toJSON() { return { version: 1, ops: this.done }; }
  static fromJSON(json) {
    if (!json || json.version !== 1 || !Array.isArray(json.ops)) throw new Error('Giornale non valido');
    return new Journal(json.ops);
  }

  /**
   * Fold the level operations into a (typed) level.dat tree and, for 26.x
   * worlds, into `files` (see LEVEL_FILES; entries are created as needed).
   */
  applyToLevel(level, files = {}) {
    for (const op of this.levelOps()) LEVEL_OPS[op.type](op, level, files);
    return level;
  }

  /**
   * Which chunks of which dimension are touched: Map "dim" -> Map "cx,cz" -> ops[].
   * Operations keep their journal order inside each chunk.
   */
  chunkPlan() {
    const plan = new Map();
    for (const op of this.chunkOps()) {
      const b = CHUNK_OPS[op.type].bounds(op);
      if (!plan.has(op.dim)) plan.set(op.dim, new Map());
      const chunks = plan.get(op.dim);
      for (let cz = b.minZ >> 4; cz <= b.maxZ >> 4; cz++) {
        for (let cx = b.minX >> 4; cx <= b.maxX >> 4; cx++) {
          const k = `${cx},${cz}`;
          if (!chunks.has(k)) chunks.set(k, []);
          chunks.get(k).push(op);
        }
      }
    }
    return plan;
  }
}

/** Region box a chunk operation touches, aligned to whole chunks; null for level operations. */
export function chunkBoundsOf(op) {
  const def = op && CHUNK_OPS[op.type];
  if (!def) return null;
  const b = def.bounds(op);
  if (!b) return null;
  return { minX: (b.minX >> 4) * 16, minZ: (b.minZ >> 4) * 16, maxX: (b.maxX >> 4) * 16 + 15, maxZ: (b.maxZ >> 4) * 16 + 15 };
}

/** Apply a chunk's operations to its typed root. Returns the editor, committed. */
export function applyChunkOps(root, ops, cx, cz, dim) {
  const info = dimensionInfo(dim);
  const ed = new ChunkEditor(root, { minY: info.minY, height: info.height });
  for (const op of ops) CHUNK_OPS[op.type].apply(op, ed, cx, cz);
  // A test switch of the Development menu: let the game rebuild the heightmaps.
  ed.commit({ heightmaps: ops.some((o) => o.heightmaps === 'drop') ? 'drop' : 'recompute' });
  return ed;
}
