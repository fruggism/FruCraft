/*
 * Apply: write the journal onto a COPY of the world.
 *
 * The original is only ever read. The copy is made first (a copy-on-write
 * clone where the filesystem has one — instant and free on APFS), marked
 * incomplete, changed, verified, and only then unmarked. If anything fails the
 * marker stays and the original is untouched by construction.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from '../../web/js/core/nbt.js';
import { writeNbt } from '../../web/js/core/nbtWrite.js';
import { gzipSync } from 'node:zlib';
import { readRegionFile, writeRegionFile, RegionData } from './region.js';
import { MIN_DATA_VERSION, ChunkEditor, stateKey } from './chunk.js';
import { CHUNK_OPS, LEVEL_FILES } from './journal.js';
import { replayOnRegion, regionsOfPlan, createsChunks } from './replay.js';
import { pastedEntityChunk } from './paste.js';
import { dimensionInfo, dimensionDir, MODERN_PROBE } from './dimensions.js';

export const INCOMPLETE_MARK = '.cantiere-incompleto';
export const COPY_MARK = 'cantiere.json';
// Level operations that may write the 26.x level files instead of level.dat.
const SPLIT_OPS = new Set(['setGameRule', 'setDayTime', 'setWeather']);

// ---------------------------------------------------------------------------
// Level.dat
// ---------------------------------------------------------------------------

export async function readLevel(worldDir) {
  const bytes = fs.readFileSync(path.join(worldDir, 'level.dat'));
  return parse(new Uint8Array(bytes), { typed: true });
}

export function writeLevel(worldDir, level) {
  const file = path.join(worldDir, 'level.dat');
  const tmp = `${file}.cantiere-tmp`;
  fs.writeFileSync(tmp, gzipSync(Buffer.from(writeNbt(level.value, level.name))));
  fs.renameSync(tmp, file);
}

export const dataVersionOf = (level) => Number(level.value?.Data?.DataVersion || 0);

/** The 26.x level files that exist in this world: { relative path -> typed root }. */
export async function readLevelFiles(worldDir) {
  const files = {};
  for (const rel of Object.values(LEVEL_FILES)) {
    const file = path.join(worldDir, rel);
    if (!fs.existsSync(file)) continue;
    files[rel] = (await parse(new Uint8Array(fs.readFileSync(file)), { typed: true })).value;
  }
  return files;
}

/** Write them back (gzipped, unnamed root, like the game), through a temporary file. */
export function writeLevelFiles(worldDir, files) {
  for (const [rel, root] of Object.entries(files)) {
    const file = path.join(worldDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.cantiere-tmp`;
    fs.writeFileSync(tmp, gzipSync(Buffer.from(writeNbt(root, ''))));
    fs.renameSync(tmp, file);
  }
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/**
 * Is another process holding this file open? Minecraft keeps session.lock open
 * for as long as the world is loaded. Node has no flock, so ask lsof (present
 * on macOS and Linux). Returns true / false, or null when it can't be known.
 */
export function defaultLockCheck(file) {
  if (!fs.existsSync(file)) return false;
  try {
    const out = execFileSync('lsof', ['-t', '--', file], { stdio: ['ignore', 'pipe', 'ignore'] });
    return out.toString().trim().length > 0;
  } catch (err) {
    if (err.code === 'ENOENT') return null;      // no lsof
    return false;                                // lsof exits 1 when nothing has it open
  }
}

function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

const gb = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1).replace('.', ',')} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);

/** Folder name for the copy: "<Name> (Cantiere)", then "(Cantiere 2)", ... */
export function uniqueCopyName(savesDir, baseName) {
  const base = baseName.replace(/\s*\(Cantiere(?: \d+)?\)$/, '');
  let name = `${base} (Cantiere)`;
  for (let n = 2; fs.existsSync(path.join(savesDir, name)); n++) name = `${base} (Cantiere ${n})`;
  return name;
}

/** Does the world use the 26.x folder layout? See dimensions.js. */
export const isModernWorld = (dir) => fs.existsSync(path.join(dir, MODERN_PROBE));

export const isCantiereCopy = (dir) => fs.existsSync(path.join(dir, COPY_MARK));

/**
 * Everything that must be true before writing. Returns { ok, errors, warnings, stats }.
 * Errors block Apply; warnings are shown in the confirmation dialog.
 */
export async function preflight({ worldDir, targetDir, journal, lockCheck = defaultLockCheck }) {
  const errors = [];
  const warnings = [];
  // The same facts as a list of ✓ / ✕ lines, for the confirmation dialog.
  const checks = [];
  const level = await readLevel(worldDir);
  const dv = dataVersionOf(level);
  if (dv < MIN_DATA_VERSION) {
    errors.push(`Il mondo è di una versione troppo vecchia (DataVersion ${dv}): il Cantiere scrive solo mondi 1.18 o successivi.`);
  }
  checks.push({ ok: dv >= MIN_DATA_VERSION, label: 'Versione del mondo supportata', detail: level.value?.Data?.Version?.Name ? String(level.value.Data.Version.Name) : `DataVersion ${dv}` });
  let lock = false;
  for (const [label, dir] of [['originale', worldDir], ['copia', targetDir]]) {
    if (!dir || !fs.existsSync(dir)) continue;
    const held = lockCheck(path.join(dir, 'session.lock'));
    if (held === true) { lock = true; errors.push(`Minecraft sembra aperto sul mondo (${label}): chiudilo e riprova.`); }
    else if (held === null) { if (lock === false) lock = null; warnings.push('Non riesco a controllare se Minecraft è aperto: assicurati che sia chiuso.'); }
  }
  checks.push(lock === true
    ? { ok: false, label: 'Minecraft sembra aperto', detail: 'chiudilo e riprova' }
    : { ok: true, label: 'Minecraft è chiuso', detail: lock === null ? 'non verificabile: controlla tu' : 'nessun lock sul mondo' });
  const plan = journal.chunkPlan();
  const regions = regionsOfPlan(plan, (dim) => dimensionInfo(dim, isModernWorld(worldDir)).dir);
  let chunks = 0;
  for (const m of plan.values()) chunks += m.size;
  const need = regions.reduce((sum, r) => {
    try { return sum + fs.statSync(path.join(worldDir, r.rel)).size; } catch { return sum; }
  }, 0);
  const worldSize = dirSize(worldDir);
  try {
    const st = fs.statfsSync(path.dirname(worldDir));
    const free = st.bavail * st.bsize;
    // Worst case the clone shares nothing; with a CoW clone this is far less.
    if (free < worldSize + need) warnings.push('Spazio su disco scarso per una copia completa del mondo.');
    if (free < need * 2) errors.push('Spazio su disco insufficiente.');
    checks.push({ ok: free >= need * 2, label: free >= need * 2 ? 'Spazio su disco sufficiente' : 'Spazio su disco insufficiente', detail: `${gb(free)} liberi · servono ~${gb(Math.max(need * 2, 1))}` });
  } catch { /* statfs unavailable: skip */ }
  checks.push({ ok: true, label: 'Il mondo originale resta com\'è', detail: 'sola lettura' });
  return { ok: errors.length === 0, errors, warnings, checks, stats: { regions: regions.length, chunks, worldSize, level: journal.levelOps().length } };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * @param opts.worldDir   the world being edited
 * @param opts.copyName   folder name of the copy (default: uniqueCopyName)
 * @param opts.overwrite  allow reusing targetDir, only if it is a Cantiere copy
 */
export async function applyJournal({
  worldDir, journal, copyName, overwrite = false, onProgress = () => {}, lockCheck = defaultLockCheck,
}) {
  const savesDir = path.dirname(path.resolve(worldDir));
  const name = copyName || uniqueCopyName(savesDir, path.basename(worldDir));
  const targetDir = path.join(savesDir, name);
  if (path.resolve(targetDir) === path.resolve(worldDir)) throw new Error('La copia non può essere l\'originale.');
  const exists = fs.existsSync(targetDir);
  if (exists && !(overwrite && isCantiereCopy(targetDir))) {
    throw new Error(`Esiste già "${name}" e non è una copia del Cantiere: scegli un altro nome.`);
  }

  const pre = await preflight({ worldDir, targetDir: exists ? targetDir : null, journal, lockCheck });
  if (!pre.ok) throw Object.assign(new Error(pre.errors.join('\n')), { preflight: pre });

  onProgress({ phase: 'copia', done: 0, total: 1 });
  if (exists) fs.rmSync(targetDir, { recursive: true, force: true });
  fs.cpSync(worldDir, targetDir, {
    recursive: true,
    mode: fs.constants.COPYFILE_FICLONE,
    // The lock belongs to a running game, never to the copy.
    filter: (src) => path.basename(src) !== 'session.lock',
  });
  fs.writeFileSync(path.join(targetDir, INCOMPLETE_MARK), 'Applica non è terminata: non aprire questo mondo.\n');

  // level.dat
  const level = await readLevel(targetDir);
  const levelFiles = await readLevelFiles(targetDir);
  journal.applyToLevel(level.value, levelFiles);
  level.value.Data.LevelName = name;
  writeLevel(targetDir, level);
  if (journal.levelOps().some((op) => SPLIT_OPS.has(op.type))) {
    writeLevelFiles(targetDir, levelFiles);
    // Read back: a file that doesn't parse must not survive Apply.
    for (const rel of Object.keys(levelFiles)) await parse(new Uint8Array(fs.readFileSync(path.join(targetDir, rel))));
  }
  const icon = journal.pendingIcon();
  if (icon) fs.writeFileSync(path.join(targetDir, 'icon.png'), Buffer.from(icon, 'base64'));
  fs.writeFileSync(path.join(targetDir, COPY_MARK), JSON.stringify({
    origine: path.basename(worldDir), creata: new Date().toISOString(), operazioni: journal.summary(),
  }, null, 2));

  // Regions
  const plan = journal.chunkPlan();
  const regions = regionsOfPlan(plan, (dim) => dimensionInfo(dim, isModernWorld(worldDir)).dir);
  const written = [];
  let n = 0;
  for (const r of regions) {
    onProgress({ phase: 'scrittura', done: n++, total: regions.length, file: r.rel });
    const file = path.join(targetDir, r.rel);
    let region;
    if (fs.existsSync(file)) region = readRegionFile(file);
    else if (createsChunks(plan, r.dim, r.rx, r.rz)) { fs.mkdirSync(path.dirname(file), { recursive: true }); region = new RegionData(r.rx, r.rz); }
    else continue;
    const chunks = plan.get(r.dim);
    const done = replayOnRegion(region, chunks, r.dim);
    if (!done.length) continue;
    writeRegionFile(file, region);
    written.push(...done.map((c) => ({ ...c, dim: r.dim, rel: r.rel })));
  }

  // Entities and points of interest under whole-chunk pastes
  pasteEntities(targetDir, journal, isModernWorld(worldDir), onProgress);

  // Verify: read every rewritten chunk back from disk.
  onProgress({ phase: 'verifica', done: 0, total: written.length });
  const problems = verifyWritten(targetDir, written, plan);
  if (problems.length) {
    throw Object.assign(new Error(`Verifica fallita su ${problems.length} chunk: ${problems[0]}`), { problems });
  }

  fs.rmSync(path.join(targetDir, INCOMPLETE_MARK));
  onProgress({ phase: 'fine', done: 1, total: 1 });
  return { targetDir, name, regions: regions.length, chunks: written.length, warnings: pre.warnings };
}

/** Re-read the chunks that were written and check the operations show in them. */
/**
 * A whole-chunk paste brings its own entities: under it, the copy's entity
 * chunks are replaced by the clip's (moved, see paste.js) and its points of
 * interest dropped — the game rebuilds those from the blocks it finds.
 * Pastes are taken in journal order, so where two overlap the later one wins,
 * as it does for the blocks.
 */
export function pasteEntities(targetDir, journal, modern, onProgress = () => {}) {
  const ops = journal.chunkOps().filter((op) => op.type === 'paste' && op.mode === 'chunks');
  if (!ops.length) return;
  const files = new Map();   // path -> RegionData | null
  const fileFor = (dim, kind, rx, rz, create) => {
    const file = path.join(targetDir, dimensionDir(dim, kind, modern), `r.${rx}.${rz}.mca`);
    if (!files.has(file)) files.set(file, fs.existsSync(file) ? readRegionFile(file) : null);
    if (!files.get(file) && create) files.set(file, new RegionData(rx, rz));
    return files.get(file);
  };
  onProgress({ phase: 'entità', done: 0, total: ops.length });
  for (const op of ops) {
    const t = op.to;
    for (let cz = t.minZ >> 4; cz <= t.maxZ >> 4; cz++) {
      for (let cx = t.minX >> 4; cx <= t.maxX >> 4; cx++) {
        for (const kind of ['entities', 'poi']) {
          const r = fileFor(op.dim, kind, cx >> 5, cz >> 5, false);
          if (r) r.deleteChunk(cx & 31, cz & 31);
        }
        const ents = pastedEntityChunk(op, cx, cz);
        if (ents) fileFor(op.dim, 'entities', cx >> 5, cz >> 5, true).setChunk(cx & 31, cz & 31, ents.value, ents.name || '');
      }
    }
  }
  for (const [file, r] of files) {
    if (!r) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (r.chunks().length) writeRegionFile(file, r);
    else fs.rmSync(file, { force: true });
  }
}

export function verifyWritten(targetDir, written, plan) {
  const problems = [];
  const cache = new Map();
  for (const w of written) {
    try {
      let region = cache.get(w.rel);
      if (!region) { region = readRegionFile(path.join(targetDir, w.rel)); cache.set(w.rel, region); }
      const { value } = region.getChunk(w.cx & 31, w.cz & 31);
      const info = dimensionInfo(w.dim);
      const ed = new ChunkEditor(value, { minY: info.minY, height: info.height });
      for (const op of plan.get(w.dim).get(`${w.cx},${w.cz}`)) {
        const def = CHUNK_OPS[op.type];
        if (!def.probe) continue;
        const p = def.probe(op);
        if (p.x >> 4 !== w.cx || p.z >> 4 !== w.cz) continue;
        // A later operation may legitimately overwrite the probe: only check the last writer.
        const got = stateKey(ed.getState(p.x, p.y, p.z));
        if (got !== stateKey(p.state) && lastWriter(plan.get(w.dim).get(`${w.cx},${w.cz}`), op)) {
          problems.push(`chunk ${w.cx},${w.cz}: atteso ${stateKey(p.state)}, letto ${got}`);
        }
      }
    } catch (err) {
      problems.push(`chunk ${w.cx},${w.cz}: ${err.message}`);
    }
  }
  return problems;
}

const lastWriter = (ops, op) => ops[ops.length - 1] === op;
