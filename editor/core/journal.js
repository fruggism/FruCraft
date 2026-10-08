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
import { ChunkEditor, parseState } from './chunk.js';
import { dimensionInfo } from './dimensions.js';

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
    d.SpawnX = op.x | 0;
    d.SpawnY = op.y | 0;
    d.SpawnZ = op.z | 0;
    if (op.angle !== undefined) d.SpawnAngle = new TFloat(op.angle);
    if (d.spawn && typeof d.spawn === 'object') {
      d.spawn.pos = new TIntArray([op.x | 0, op.y | 0, op.z | 0]);
      if (op.angle !== undefined) d.spawn.yaw = new TFloat(op.angle);
    }
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

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

export class Journal {
  constructor(ops = []) {
    this.done = ops.slice();
    this.undone = [];
    this.listeners = new Set();
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this); }

  push(op) {
    if (!LEVEL_OPS[op.type] && !CHUNK_OPS[op.type]) throw new Error(`Operazione sconosciuta: ${op.type}`);
    this.done.push(op);
    this.undone.length = 0;
    this.emit();
    return op;
  }

  get canUndo() { return this.done.length > 0; }
  get canRedo() { return this.undone.length > 0; }
  undo() { if (!this.canUndo) return null; const op = this.done.pop(); this.undone.push(op); this.emit(); return op; }
  redo() { if (!this.canRedo) return null; const op = this.undone.pop(); this.done.push(op); this.emit(); return op; }
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

/** Apply a chunk's operations to its typed root. Returns the editor, committed. */
export function applyChunkOps(root, ops, cx, cz, dim) {
  const info = dimensionInfo(dim);
  const ed = new ChunkEditor(root, { minY: info.minY, height: info.height });
  for (const op of ops) CHUNK_OPS[op.type].apply(op, ed, cx, cz);
  ed.commit();
  return ed;
}
