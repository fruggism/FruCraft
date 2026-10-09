/*
 * The journal: every pending change, in order, and nothing else.
 *
 * Operations are small plain objects — JSON in, JSON out — so the journal can
 * be written to disk after every change and survive a crash. The world is
 * never touched while they pile up: the map shows the world read from disk with
 * the journal laid over it (OverlaySource), and "Apply" replays the very same
 * operations onto a copy.
 *
 * Operations come in two kinds:
 *   level  — change level.dat; folded into its tree with applyLevelOp
 *   chunk  — change blocks/biomes; applied to one chunk with applyChunkOp
 * Undo and redo just move operations between the two stacks.
 */

import { TByte, TLong, TFloat, TDouble, TShort, TIntArray } from '../../web/js/core/nbt.js';
import { ChunkEditor, parseState, stateKey } from './chunk.js';
import { dimensionInfo } from './dimensions.js';
import { selectionBounds, chunkMask, yRange } from './selection.js';
import { blockMatcher, compileMix, pickFromMix, carryProperties, hash3 } from './blocks.js';
import { AIR_NAMES } from '../../web/js/core/anvil.js';

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
  /** Game rules are stored as strings: 'true', 'false' or a number. */
  setGameRule(op, level) {
    const d = level.Data;
    if (!d.GameRules || typeof d.GameRules !== 'object') d.GameRules = {};
    d.GameRules[op.rule] = String(op.value);
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

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

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
    if (!LEVEL_OPS[op.type] && !CHUNK_OPS[op.type]) throw new Error(`Operazione sconosciuta: ${op.type}`);
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
  chunkOps() { return this.done.filter((o) => CHUNK_OPS[o.type]); }

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

  /** Fold the level operations into a (typed) level.dat tree. */
  applyToLevel(level) {
    for (const op of this.levelOps()) LEVEL_OPS[op.type](op, level);
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
