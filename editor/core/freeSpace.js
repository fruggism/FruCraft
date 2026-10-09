/*
 * Free space ("Libera spazio"): find the chunks nobody uses and the files
 * nothing needs, say how much they weigh, and turn the choice into one
 * journal operation that Apply carries out on the copy.
 *
 * Two steps, so the dialog can move its sliders without reading the world
 * again:
 *   scanFreeSpace  reads every region, entities and poi file once (through
 *                  the overlay, so pending changes count) and keeps, per
 *                  chunk, the few facts the criteria need: time spent there
 *                  (InhabitedTime), whether anything built is in it, how many
 *                  bytes it takes in its file;
 *   planFreeSpace  applies the criteria to that and gives back what goes, the
 *                  exact bytes freed and the operation to put in the journal.
 *
 * The operation names files by their path in the world, so it doesn't care
 * about the folder layout (region/ or dimensions/minecraft/overworld/region/):
 *   files   { rel: mask }  a base64 bitmask of the chunk slots to delete; an
 *                          all-zero mask only packs the file again (no holes);
 *                          '' deletes the whole file and its .mcc files
 *   remove  [rel]          single files to delete (orphan .mcc)
 *   dirs    [rel]          folders to delete (data of dimensions not in use)
 * The game regenerates a deleted chunk, from the seed, the next time someone
 * goes there.
 */

import { RegionData, SECTOR } from './region.js';
import { isNatural, isBuiltEntity } from './natural.js';
import { chunkMask, selectionBounds } from './selection.js';

export const KINDS = ['region', 'entities', 'poi'];
export const FLAG = { BLOCKS: 1, BLOCK_ENTITIES: 2, ENTITIES: 4, PROTO: 8, UNREADABLE: 16 };
/** Per-chunk outcome of a plan. */
export const STATE = { KEEP: 0, DELETE: 1, MARGIN: 2, EXCLUDED: 3, OUT: 4, ORPHAN: 5 };

const HEADER = 2 * SECTOR;
const REGION_RE = /^r\.(-?\d+)\.(-?\d+)\.mca$/;
const MCC_RE = /^c\.(-?\d+)\.(-?\d+)\.mcc$/;
/* Folders of the old layout. A 26.x world (dimensions/minecraft/overworld/)
   doesn't read them any more; what is left there is dead weight. */
const LEGACY = ['region', 'entities', 'poi', 'DIM-1', 'DIM1'];

const join = (...parts) => parts.filter(Boolean).join('/');
const items = (l) => (Array.isArray(l) ? l : l && Array.isArray(l.items) ? l.items : []);

/** Folder of `kind` next to a dimension's region folder ('dimensions/x/y/region' -> 'dimensions/x/y/poi'). */
export function kindDir(regionDir, kind) {
  const dir = regionDir || 'region';
  if (kind === 'region') return dir;
  if (dir === 'region') return kind;
  return dir.endsWith('/region') ? `${dir.slice(0, -7)}/${kind}` : null;
}

// ---------------------------------------------------------------------------
// Chunk masks (1024 slots of a region file, base64)
// ---------------------------------------------------------------------------

export function encodeMask(indices) {
  const bits = new Uint8Array(128);
  for (const i of indices) bits[i >> 3] |= 1 << (i & 7);
  return Buffer.from(bits).toString('base64');
}

export function decodeMask(text) {
  const bits = Buffer.from(String(text), 'base64');
  if (bits.length !== 128) throw new Error('Maschera di chunk non valida.');
  const out = [];
  for (let i = 0; i < 1024; i++) if (bits[i >> 3] & (1 << (i & 7))) out.push(i);
  return out;
}

/** A copy of a region file's bytes with those chunk slots emptied (header only: cheap, keeps .mcc chunks). */
export function withoutChunks(bytes, indices) {
  const out = new Uint8Array(bytes);
  if (out.length < HEADER) return out;
  for (const i of indices) out.fill(0, i * 4, i * 4 + 4);
  return out;
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

/**
 * The stored chunks of a region file, as the region reader would see them:
 * [{ i, bytes, ext }]. `bytes` is what the chunk takes once the file is packed
 * again (whole sectors; a chunk kept in a .mcc file leaves a one-sector stub).
 */
export function headerOf(buf) {
  const out = [];
  if (buf.length < HEADER) return out;
  for (let i = 0; i < 1024; i++) {
    const o = i * 4;
    const sector = (buf[o] << 16) | (buf[o + 1] << 8) | buf[o + 2];
    const count = buf[o + 3];
    if (!sector || !count) continue;
    const start = sector * SECTOR;
    if (start + 5 > buf.length) continue;
    const length = buf.readUInt32BE(start);
    if (length < 1 || start + 4 + length > buf.length) continue;
    const ext = (buf[start + 4] & 128) !== 0;
    out.push({ i, ext, bytes: ext ? SECTOR : Math.ceil((4 + length) / SECTOR) * SECTOR });
  }
  return out;
}

const nameOf = (p) => (typeof p === 'string' ? p : p && (p.Name || p.id)) || 'minecraft:air';

/** What a terrain chunk says about itself: flags (FLAG.*) and InhabitedTime in ticks. */
export function analyseChunk(v) {
  let flags = 0;
  const status = String(v.Status ?? 'full').replace(/^minecraft:/, '');
  if (status !== 'full') flags |= FLAG.PROTO;
  for (const sec of items(v.sections)) {
    const pal = sec && (sec.block_states ? sec.block_states.palette : sec.Palette);
    if (items(pal).some((p) => !isNatural(nameOf(p)))) { flags |= FLAG.BLOCKS; break; }
  }
  if (items(v.block_entities).length) flags |= FLAG.BLOCK_ENTITIES;
  // Chunks not yet fully generated (and pre-1.17 ones) keep their entities inside.
  if (items(v.entities).some(isBuiltEntity) || items(v.Entities).some(isBuiltEntity)) flags |= FLAG.ENTITIES;
  return { flags, inhabited: Number(v.InhabitedTime ?? 0) || 0 };
}

async function dirSize(source, rel) {
  let total = 0;
  for (const e of await source.listEntries(rel)) {
    const p = join(rel, e.name);
    total += e.isDirectory ? await dirSize(source, p) : (await source.fileSize(p)) || 0;
  }
  return total;
}

const toBuffer = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);

/**
 * @param source  a WorldSource (the overlay, so pending changes are seen)
 * @param dims    [{ id, label, regionDir }] as the world scan found them
 * @returns plain data (typed arrays), safe to send from a worker:
 *   records  one entry per stored chunk of every file: dim, kind (index in
 *            KINDS), cx, cz, inhabited (ticks), flags, bytes, mcc (bytes of its
 *            .mcc file), file (index in files), slot (0..1023 in the file)
 *   files    [{ rel, dim, kind, rx, rz, size, chunks }]
 *   orphanMcc, legacy  [{ rel, size }]
 */
export async function scanFreeSpace({ source, dims, onProgress = () => {}, signal = null }) {
  const R = { dim: [], kind: [], cx: [], cz: [], inhabited: [], flags: [], bytes: [], mcc: [], file: [], slot: [] };
  const files = [];
  const orphanMcc = [];
  const jobs = [];
  for (let d = 0; d < dims.length; d++) {
    for (let k = 0; k < KINDS.length; k++) {
      const dir = kindDir(dims[d].regionDir, KINDS[k]);
      if (dir === null) continue;
      jobs.push({ d, k, dir, entries: (await source.listEntries(dir)).filter((e) => !e.isDirectory) });
    }
  }
  const total = jobs.reduce((s, j) => s + j.entries.filter((e) => REGION_RE.test(e.name)).length, 0);
  let done = 0;
  for (const job of jobs) {
    const referenced = new Set();
    for (const e of job.entries) {
      const m = REGION_RE.exec(e.name);
      if (!m) continue;
      if (signal && signal.aborted) throw Object.assign(new Error('Annullato.'), { cancelled: true });
      const rel = join(job.dir, e.name);
      const rx = Number(m[1]), rz = Number(m[2]);
      const size = await source.fileSize(rel);
      if (size === null) continue;
      const fi = files.push({ rel, dim: job.d, kind: job.k, rx, rz, size, chunks: 0 }) - 1;
      const raw = size >= HEADER ? await source.readFile(rel) : null;
      if (raw && raw.length >= HEADER) {
        const buf = toBuffer(raw);
        const head = headerOf(buf);
        const ext = new Map();
        for (const h of head) {
          if (!h.ext) continue;
          const name = `c.${rx * 32 + (h.i & 31)}.${rz * 32 + (h.i >> 5)}.mcc`;
          const b = await source.readFile(join(job.dir, name));
          if (b) { ext.set(name, toBuffer(b)); referenced.add(name); }
        }
        const region = KINDS[job.k] === 'poi' ? null : RegionData.fromBuffer(buf, rx, rz, ext);
        for (const h of head) {
          const cx = rx * 32 + (h.i & 31), cz = rz * 32 + (h.i >> 5);
          const mccName = `c.${cx}.${cz}.mcc`;
          // A chunk whose .mcc is gone can't be read, and a rewrite drops it anyway.
          if (h.ext && !ext.has(mccName)) continue;
          let flags = 0, inhabited = 0;
          if (region) {
            try {
              const v = region.getChunk(h.i & 31, h.i >> 5, { typed: false }).value;
              if (KINDS[job.k] === 'region') ({ flags, inhabited } = analyseChunk(v));
              else if (items(v.Entities).some(isBuiltEntity)) flags = FLAG.ENTITIES;
            } catch { flags = FLAG.UNREADABLE; }
          }
          R.dim.push(job.d); R.kind.push(job.k); R.cx.push(cx); R.cz.push(cz);
          R.inhabited.push(inhabited); R.flags.push(flags); R.bytes.push(h.bytes);
          R.mcc.push(h.ext ? ext.get(mccName).length : 0); R.file.push(fi); R.slot.push(h.i);
          files[fi].chunks++;
        }
      }
      done++;
      onProgress({ done, total, file: rel });
    }
    for (const e of job.entries) {
      if (!MCC_RE.test(e.name) || referenced.has(e.name)) continue;
      const rel = join(job.dir, e.name);
      orphanMcc.push({ rel, dim: job.d, size: (await source.fileSize(rel)) || 0 });
    }
  }

  const legacy = [];
  if ((await source.listEntries('dimensions/minecraft/overworld')).length) {
    const top = await source.listEntries('');
    for (const name of LEGACY) {
      if (!top.some((e) => e.isDirectory && e.name === name)) continue;
      if (dims.some((d) => (d.regionDir || 'region') === name || (d.regionDir || '').startsWith(`${name}/`))) continue;
      legacy.push({ rel: name, size: await dirSize(source, name) });
    }
  }

  return {
    dims: dims.map((d) => ({ id: d.id, label: d.label || d.id, regionDir: d.regionDir })),
    records: {
      dim: Uint8Array.from(R.dim), kind: Uint8Array.from(R.kind), cx: Int32Array.from(R.cx), cz: Int32Array.from(R.cz),
      inhabited: Float64Array.from(R.inhabited), flags: Uint8Array.from(R.flags), bytes: Uint32Array.from(R.bytes),
      mcc: Uint32Array.from(R.mcc), file: Int32Array.from(R.file), slot: Uint16Array.from(R.slot),
    },
    files, orphanMcc, legacy,
  };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/*
 * Criteria. A chunk goes when it passes every chunk criterion that is on, is
 * farther than `margin` chunks from every chunk that stays because of them
 * (or because a pending change is in it), and isn't in an excluded area.
 * With no chunk criterion on, no chunk goes.
 */
export const DEFAULT_CRITERIA = {
  dims: null,            // ids of the dimensions to clean (null: all)
  inhabited: true,       // less than `seconds` spent there (InhabitedTime)
  seconds: 60,
  blocks: true,          // nothing built: only natural blocks, no item frames, stands, named mobs
  blockEntities: true,   // no chests, signs, spawners... (generated ones count too)
  margin: 2,             // chunks kept around what stays
  exclude: [],           // [{ dim, sel }] areas never touched (selections)
  protect: {},           // { dim: ['cx,cz', ...] } always kept (chunks with pending changes)
  emptyRegions: true,    // region files with no chunks
  orphanMcc: true,       // .mcc files no region points to
  orphanChunks: true,    // entities/ and poi/ chunks with no terrain chunk
  compact: true,         // pack region files again, without the holes the game leaves
  legacy: false,         // old-layout folders a 26.x world no longer reads
};

const KEY_OFF = 0x200000;
const keyOf = (cx, cz) => (cx + KEY_OFF) * 0x400000 + (cz + KEY_OFF);

export function planFreeSpace(scan, criteria = {}) {
  const c = { ...DEFAULT_CRITERIA, ...criteria };
  const R = scan.records;
  const n = R.cx.length;
  const state = new Uint8Array(n);
  const dimOn = scan.dims.map((d) => !c.dims || c.dims.includes(d.id));
  const anyCriterion = !!(c.inhabited || c.blocks || c.blockEntities);
  const maxTicks = Math.max(0, Number(c.seconds) || 0) * 20;
  const margin = Math.max(0, Math.min(32, Math.floor(Number(c.margin) || 0)));

  const terrainAt = scan.dims.map(() => new Map());
  for (let i = 0; i < n; i++) if (R.kind[i] === 0) terrainAt[R.dim[i]].set(keyOf(R.cx[i], R.cz[i]), i);
  const protect = scan.dims.map((d) => new Set((c.protect[d.id] || []).map((k) => { const [x, z] = String(k).split(',').map(Number); return keyOf(x, z); })));
  const exclude = scan.dims.map((d) => (c.exclude || []).filter((e) => e && e.dim === d.id && selectionBounds(e.sel)).map((e) => ({ sel: e.sel, b: selectionBounds(e.sel) })));
  const excluded = (d, cx, cz) => exclude[d].some(({ sel, b }) => cx * 16 <= b.maxX && cx * 16 + 15 >= b.minX
    && cz * 16 <= b.maxZ && cz * 16 + 15 >= b.minZ && chunkMask(sel, cx, cz) !== null);
  const seeds = scan.dims.map(() => new Set());
  // Item frames, stands, named mobs live in entities/: they mark their terrain chunk as built.
  const builtHere = scan.dims.map(() => new Set());
  for (let i = 0; i < n; i++) if (R.kind[i] !== 0 && (R.flags[i] & FLAG.ENTITIES)) builtHere[R.dim[i]].add(keyOf(R.cx[i], R.cz[i]));

  for (let i = 0; i < n; i++) {
    if (R.kind[i] !== 0) continue;
    const d = R.dim[i];
    if (!dimOn[d]) { state[i] = STATE.OUT; continue; }
    const k = keyOf(R.cx[i], R.cz[i]);
    const f = R.flags[i] | (builtHere[d].has(k) ? FLAG.ENTITIES : 0);
    const unused = anyCriterion && !(f & FLAG.UNREADABLE)
      && (!c.inhabited || R.inhabited[i] < maxTicks)
      && (!c.blocks || !(f & (FLAG.BLOCKS | FLAG.ENTITIES)))
      && (!c.blockEntities || !(f & FLAG.BLOCK_ENTITIES));
    if (protect[d].has(k)) { state[i] = STATE.EXCLUDED; seeds[d].add(k); }
    else if (!unused) { state[i] = STATE.KEEP; seeds[d].add(k); }
    else if (excluded(d, R.cx[i], R.cz[i])) state[i] = STATE.EXCLUDED;
    else state[i] = STATE.DELETE;
  }
  if (margin > 0) {
    for (let i = 0; i < n; i++) {
      if (state[i] !== STATE.DELETE || R.kind[i] !== 0) continue;
      const s = seeds[R.dim[i]];
      if (!s.size) continue;
      const cx = R.cx[i], cz = R.cz[i];
      near: for (let dz = -margin; dz <= margin; dz++) {
        for (let dx = -margin; dx <= margin; dx++) {
          if (s.has(keyOf(cx + dx, cz + dz))) { state[i] = STATE.MARGIN; break near; }
        }
      }
    }
  }
  // Entities and points of interest follow their terrain chunk.
  for (let i = 0; i < n; i++) {
    if (R.kind[i] === 0) continue;
    if (!dimOn[R.dim[i]]) { state[i] = STATE.OUT; continue; }
    const t = terrainAt[R.dim[i]].get(keyOf(R.cx[i], R.cz[i]));
    if (t !== undefined) state[i] = state[t] === STATE.DELETE ? STATE.DELETE : STATE.KEEP;
    else state[i] = c.orphanChunks ? STATE.ORPHAN : STATE.KEEP;
  }

  // Bytes, file by file: exactly what the packed files will weigh.
  const bytes = { chunks: 0, side: 0, orphans: 0, compact: 0, empty: 0, mcc: 0, legacy: 0, total: 0 };
  const counts = { chunks: 0, side: 0, orphans: 0, emptyFiles: 0, mcc: 0, legacy: 0, filesRemoved: 0, filesRewritten: 0 };
  const perDim = scan.dims.map((d) => ({ id: d.id, label: d.label, chunks: 0, deleted: 0, bytes: 0 }));
  const used = new Float64Array(scan.files.length);
  const gone = new Map();   // file -> [record]
  for (let i = 0; i < n; i++) {
    used[R.file[i]] += R.bytes[i];
    if (R.kind[i] === 0 && dimOn[R.dim[i]]) perDim[R.dim[i]].chunks++;
    if (state[i] !== STATE.DELETE && state[i] !== STATE.ORPHAN) continue;
    if (!gone.has(R.file[i])) gone.set(R.file[i], []);
    gone.get(R.file[i]).push(i);
  }
  const category = (i) => (state[i] === STATE.ORPHAN ? 'orphans' : R.kind[i] === 0 ? 'chunks' : 'side');
  const files = {};
  scan.files.forEach((f, fi) => {
    if (!dimOn[f.dim]) return;
    const list = gone.get(fi) || [];
    if (f.chunks === 0) {
      if (c.emptyRegions) { files[f.rel] = ''; bytes.empty += f.size; perDim[f.dim].bytes += f.size; counts.emptyFiles++; }
      return;
    }
    // Signed: the game doesn't pad the last chunk of a file to a whole sector.
    const holes = f.size - HEADER - used[fi];
    if (!list.length) {
      if (c.compact && holes > 0) { files[f.rel] = encodeMask([]); bytes.compact += holes; perDim[f.dim].bytes += holes; counts.filesRewritten++; }
      return;
    }
    let freed = 0;
    for (const i of list) {
      const b = R.bytes[i] + R.mcc[i];
      bytes[category(i)] += b; freed += b;
      counts[category(i)]++;
      if (R.kind[i] === 0) perDim[f.dim].deleted++;
    }
    if (list.length === f.chunks) {
      // The whole file goes: its header and holes too.
      files[f.rel] = '';
      const extra = f.size - used[fi];   // header and holes (or the unpadded tail, negative)
      bytes[category(list[0])] += extra; freed += extra;
      counts.filesRemoved++;
    } else {
      files[f.rel] = encodeMask(list.map((i) => R.slot[i]));
      bytes.compact += holes; freed += holes;
      counts.filesRewritten++;
    }
    perDim[f.dim].bytes += freed;
  });
  const remove = [];
  if (c.orphanMcc) {
    for (const m of scan.orphanMcc) {
      if (!dimOn[m.dim]) continue;
      remove.push(m.rel); bytes.mcc += m.size; perDim[m.dim].bytes += m.size; counts.mcc++;
    }
  }
  const dirs = [];
  if (c.legacy) for (const l of scan.legacy) { dirs.push(l.rel); bytes.legacy += l.size; counts.legacy++; }
  bytes.total = bytes.chunks + bytes.side + bytes.orphans + bytes.compact + bytes.empty + bytes.mcc + bytes.legacy;

  return { state, bytes, counts, perDim, files, remove, dirs, criteria: c };
}

/** The journal operation for a plan, or null when it frees nothing. */
export function freeSpaceOp(plan) {
  if (!Object.keys(plan.files).length && !plan.remove.length && !plan.dirs.length) return null;
  const c = plan.criteria;
  return {
    type: 'freeSpace',
    files: plan.files,
    remove: plan.remove,
    dirs: plan.dirs,
    stats: { chunks: plan.counts.chunks, bytes: plan.bytes.total, perDim: plan.perDim.filter((d) => d.deleted || d.bytes).map(({ id, deleted, bytes }) => ({ id, deleted, bytes })) },
    criteria: { inhabited: c.inhabited ? c.seconds : null, blocks: c.blocks, blockEntities: c.blockEntities, margin: c.margin, compact: c.compact, legacy: c.legacy },
  };
}

/**
 * What the map draws for one dimension: every terrain chunk with its time
 * (seconds) and the plan's state for it.
 */
export function heatOf(scan, plan, dimId) {
  const d = scan.dims.findIndex((x) => x.id === dimId);
  const R = scan.records;
  const idx = [];
  for (let i = 0; i < R.cx.length; i++) if (R.dim[i] === d && R.kind[i] === 0) idx.push(i);
  return {
    cx: Int32Array.from(idx, (i) => R.cx[i]),
    cz: Int32Array.from(idx, (i) => R.cz[i]),
    seconds: Float32Array.from(idx, (i) => R.inhabited[i] / 20),
    state: Uint8Array.from(idx, (i) => (plan ? plan.state[i] : STATE.KEEP)),
  };
}
