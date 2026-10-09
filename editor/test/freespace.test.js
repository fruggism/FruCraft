/*
 * Tests for Free space ("Libera spazio"): the natural blocks list, the scan,
 * the criteria, the bytes promised against the bytes Apply really frees, and
 * the overlay hiding what is going to be deleted. Registered by
 * test/run-tests.js after phase2.test.js.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { TAG, TList } from '../../web/js/core/nbt.js';
import { RegionData, writeRegionFile, readRegionFile } from '../core/region.js';
import { isNatural, isBuiltEntity } from '../core/natural.js';
import {
  scanFreeSpace, planFreeSpace, freeSpaceOp, heatOf, encodeMask, decodeMask, FLAG, STATE,
} from '../core/freeSpace.js';
import { Journal } from '../core/journal.js';
import { OverlaySource } from '../core/overlay.js';
import { NodeSource } from '../core/nodeSource.js';
import { applyJournal } from '../core/apply.js';
import { WorldSession } from '../main/session.js';
import { scanWorld } from '../../web/js/core/worldScan.js';
import { makeWorld, makeChunk } from './fixture.js';

const ROW = 13;              // terrain chunks (0..12, 0)
const PIG = { id: 'minecraft:pig', Pos: new TList(TAG.Double, []) };
const FRAME = { id: 'minecraft:item_frame', Pos: new TList(TAG.Double, []) };
const entityChunk = (cx, cz, entities) => ({
  DataVersion: 3465, Position: new Int32Array([cx, cz]), Entities: new TList(TAG.Compound, entities),
});

/*
 * A world made for pruning. Terrain: a row of chunks 0..12 at z = 0 where 0
 * has a chest (built), 12 an item frame (built, through entities/), 8 is huge
 * (kept in a .mcc file); the rest natural and never visited. Chunk (5, 8) is
 * natural but visited for 100 s. A second region holds one built chunk and
 * wasted space at its end. Plus: an empty region file, an orphan .mcc, an
 * entities chunk with no terrain, a poi chunk, and (modern) old DIM-1 data.
 */
function makePruneWorld(savesDir, name, { modern = false } = {}) {
  const dir = makeWorld(savesDir, name, { modernDirs: modern });
  const base = modern ? path.join(dir, 'dimensions', 'minecraft', 'overworld') : dir;
  const regionDir = path.join(base, 'region');
  for (const f of fs.readdirSync(regionDir)) fs.rmSync(path.join(regionDir, f));
  const r = new RegionData(0, 0);
  for (let cx = 0; cx < ROW; cx++) {
    const ch = makeChunk(cx, 0, { inhabited: cx === 0 ? 50000 : 0, natural: cx !== 0 });
    if (cx === 8) ch.mod_data.big = new Int8Array(crypto.randomBytes(1_200_000).buffer);
    r.setChunk(cx, 0, ch, '', 1700000000);
  }
  r.setChunk(5, 8, makeChunk(5, 8, { inhabited: 2000, natural: true }), '', 1700000000);
  writeRegionFile(path.join(regionDir, 'r.0.0.mca'), r);
  const far = new RegionData(-1, -1);
  far.setChunk(31, 31, makeChunk(-1, -1, { inhabited: 99999 }), '', 1700000000);
  writeRegionFile(path.join(regionDir, 'r.-1.-1.mca'), far);
  fs.appendFileSync(path.join(regionDir, 'r.-1.-1.mca'), Buffer.alloc(8192));   // holes left by the game
  fs.writeFileSync(path.join(regionDir, 'r.1.0.mca'), Buffer.alloc(0));        // empty region
  fs.writeFileSync(path.join(regionDir, 'c.-5.0.mcc'), Buffer.alloc(3000, 7)); // nobody points at it

  fs.mkdirSync(path.join(base, 'entities'), { recursive: true });
  const ent = new RegionData(0, 0);
  ent.setChunk(4, 0, entityChunk(4, 0, [PIG]), '', 1700000000);
  ent.setChunk(12, 0, entityChunk(12, 0, [FRAME]), '', 1700000000);
  ent.setChunk(20, 20, entityChunk(20, 20, [PIG]), '', 1700000000);   // no terrain there
  writeRegionFile(path.join(base, 'entities', 'r.0.0.mca'), ent);
  fs.mkdirSync(path.join(base, 'poi'), { recursive: true });
  const poi = new RegionData(0, 0);
  poi.setChunk(3, 0, { DataVersion: 3465, Sections: {} }, '', 1700000000);
  writeRegionFile(path.join(base, 'poi', 'r.0.0.mca'), poi);
  if (modern) {
    fs.mkdirSync(path.join(dir, 'DIM-1', 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'DIM-1', 'data', 'vecchio.dat'), 'dati della vecchia cartella');
  }
  return dir;
}

async function scanOf(dir, journal = new Journal()) {
  const base = new NodeSource(dir);
  const ws = await scanWorld(base);
  const dims = ws.dimensions.map((d) => ({ id: d.id, label: d.label, regionDir: d.regionDir }));
  return scanFreeSpace({ source: new OverlaySource(base, journal), dims });
}

/** Terrain chunks of the overworld a plan deletes, as "cx,cz". */
const deleted = (scan, plan) => {
  const h = heatOf(scan, plan, 'overworld');
  const out = [];
  for (let i = 0; i < h.cx.length; i++) if (h.state[i] === STATE.DELETE) out.push(`${h.cx[i]},${h.cz[i]}`);
  return out.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).join(' ');
};
const row = (...xs) => xs.map((x) => `${x},0`).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).join(' ');
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

function fileHashes(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

const sizeUnder = (dir, rels) => rels.reduce((s, rel) => {
  const p = path.join(dir, rel);
  if (!fs.existsSync(p)) return s;
  const st = fs.statSync(p);
  if (!st.isDirectory()) return s + st.size;
  return s + fs.readdirSync(p).reduce((t, n) => t + sizeUnder(p, [n]), 0);
}, 0);

export function register({ test, section, assert, assertEqual }) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cantiere-spazio-'));
  let n = 0;
  const freshSaves = () => { const d = path.join(scratch, `s${n++}`); fs.mkdirSync(d); return d; };

  // -------------------------------------------------------------------------
  section('Cantiere — libera spazio');

  test('blocchi naturali e costruiti', () => {
    for (const b of ['stone', 'minecraft:grass_block', 'oak_log', 'oak_leaves', 'water', 'deepslate_diamond_ore', 'netherrack', 'end_stone', 'kelp_plant', 'crimson_stem']) {
      assert(isNatural(b), `${b} è naturale`);
    }
    for (const b of ['oak_planks', 'minecraft:chest', 'glass', 'stripped_oak_log', 'cobblestone', 'oak_stairs', 'torch', 'rail', 'mymod:ore', 'crimson_planks']) {
      assert(!isNatural(b), `${b} è costruito`);
    }
    assert(isBuiltEntity({ id: 'minecraft:armor_stand' }) && isBuiltEntity({ id: 'minecraft:oak_boat' }), 'supporto e barca');
    assert(isBuiltEntity({ id: 'minecraft:wolf', Owner: [1, 2, 3, 4] }) && isBuiltEntity({ id: 'minecraft:cow', CustomName: 'Carla' }), 'animali con padrone o nome');
    assert(!isBuiltEntity({ id: 'minecraft:pig' }) && !isBuiltEntity({ id: 'minecraft:chest_minecart' }), 'mob e carrelli delle miniere');
  });

  test('maschere dei chunk: andata e ritorno', () => {
    assertEqual(decodeMask(encodeMask([0, 7, 8, 1023])).join(','), '0,7,8,1023', 'indici');
    assertEqual(decodeMask(encodeMask([])).length, 0, 'vuota');
  });

  test('analisi: tempo, costruzioni, block entity, entità, file orfani', async () => {
    const dir = makePruneWorld(freshSaves(), 'Analisi');
    const scan = await scanOf(dir);
    const R = scan.records;
    const at = (cx, cz, kind = 0) => { for (let i = 0; i < R.cx.length; i++) if (R.kind[i] === kind && R.cx[i] === cx && R.cz[i] === cz) return i; return -1; };
    assertEqual(R.flags[at(0, 0)], FLAG.BLOCKS | FLAG.BLOCK_ENTITIES, 'chunk con la cassa');
    assertEqual(R.flags[at(12, 0)] & FLAG.ENTITIES, 0, 'il chunk del terreno da solo non sa della cornice');
    assertEqual(R.flags[at(12, 0, 1)], FLAG.ENTITIES, 'la cornice è nel file entities');
    assertEqual(R.flags[at(3, 0)], 0, 'chunk naturale');
    assertEqual(R.inhabited[at(5, 8)], 2000, 'InhabitedTime');
    assert(R.mcc[at(8, 0)] > 1_000_000, 'il chunk enorme sta nel .mcc');
    assertEqual(scan.orphanMcc.map((m) => m.rel).join(), 'region/c.-5.0.mcc', '.mcc orfano');
    assertEqual(scan.legacy.length, 0, 'mondo vecchio: niente cartelle da togliere');
    const empty = scan.files.find((f) => f.rel === 'region/r.1.0.mca');
    assert(empty && empty.chunks === 0, 'region vuota');
  });

  test('criteri: margine, tempo, costruzioni, entità', async () => {
    const dir = makePruneWorld(freshSaves(), 'Criteri');
    const scan = await scanOf(dir);
    // 0 has the chest, 12 the item frame: two chunks of margin around each.
    assertEqual(deleted(scan, planFreeSpace(scan, {})), row(...range(3, 9)), 'predefiniti (margine 2)');
    assertEqual(deleted(scan, planFreeSpace(scan, { margin: 0 })), row(...range(1, 11)), 'margine 0');
    assertEqual(deleted(scan, planFreeSpace(scan, { inhabited: false, blocks: false, blockEntities: false })), '', 'nessun criterio: niente');
    // Without "nothing built" the frame no longer protects 12; the chest still counts as a block entity.
    assertEqual(deleted(scan, planFreeSpace(scan, { blocks: false })), row(...range(3, 12)), 'solo tempo e block entity');
    // Time only: 5,8 (100 s) stays with a short threshold, goes with a long one.
    assert(!deleted(scan, planFreeSpace(scan, { blocks: false, blockEntities: false, margin: 0, seconds: 60 })).includes('5,8'), '100 s > 60 s');
    assert(deleted(scan, planFreeSpace(scan, { blocks: false, blockEntities: false, margin: 0, seconds: 300 })).includes('5,8'), '100 s < 5 min');
    assert(!deleted(scan, planFreeSpace(scan, { margin: 0, dims: ['the_nether'] })), 'dimensione esclusa');
  });

  test('aree escluse e chunk con modifiche in sospeso', async () => {
    const dir = makePruneWorld(freshSaves(), 'Escluse');
    const scan = await scanOf(dir);
    const sel = { items: [{ mode: 'add', shape: { type: 'rect', minX: 80, minZ: 0, maxX: 95, maxZ: 15 } }], yMin: null, yMax: null };
    assertEqual(deleted(scan, planFreeSpace(scan, { exclude: [{ dim: 'overworld', sel }] })), row(3, 4, 6, 7, 8, 9), 'il chunk 5 resta');
    // A pending change in chunk 7 keeps it and, with the margin, its neighbours.
    assertEqual(deleted(scan, planFreeSpace(scan, { protect: { overworld: ['7,0'] } })), row(3, 4), 'margine anche attorno alle modifiche');
  });

  test('anteprima: entities, poi, file vuoti e orfani, compattazione', async () => {
    const dir = makePruneWorld(freshSaves(), 'Anteprima');
    const scan = await scanOf(dir);
    const plan = planFreeSpace(scan, {});
    assertEqual(plan.counts.chunks, 7, 'chunk di terreno');
    assertEqual(plan.counts.side, 2, 'entities (4,0) e poi (3,0)');
    assertEqual(plan.counts.orphans, 1, 'entities senza terreno');
    assertEqual(plan.files['poi/r.0.0.mca'], '', 'il file poi resta vuoto: via tutto');
    assertEqual(plan.files['region/r.1.0.mca'], '', 'region vuota');
    assertEqual(decodeMask(plan.files['region/r.-1.-1.mca']).length, 0, 'solo compattata');
    assertEqual(plan.bytes.compact >= 8192, true, 'i buchi contano');
    assertEqual(plan.remove.join(), 'region/c.-5.0.mcc', '.mcc orfano');
    const none = planFreeSpace(scan, { emptyRegions: false, orphanMcc: false, orphanChunks: false, compact: false });
    assert(!('region/r.1.0.mca' in none.files) && !none.remove.length && !('region/r.-1.-1.mca' in none.files), 'opzioni spente');
    assertEqual(none.counts.orphans, 0, 'orfani tenuti');
  });

  for (const modern of [false, true]) {
    test(`Applica libera esattamente lo spazio previsto${modern ? ' (cartelle 26.x)' : ''}`, async () => {
      const saves = freshSaves();
      const dir = makePruneWorld(saves, 'Pota', { modern });
      const before = fileHashes(dir);
      const journal = new Journal();
      const scan = await scanOf(dir, journal);
      if (modern) assertEqual(scan.legacy.map((l) => l.rel).join(), 'DIM-1', 'vecchia cartella DIM-1');
      const plan = planFreeSpace(scan, { legacy: modern });
      journal.push({ ...freeSpaceOp(plan), at: 1 });
      const res = await applyJournal({ worldDir: dir, journal, lockCheck: () => false });
      assertEqual(JSON.stringify(fileHashes(dir)), JSON.stringify(before), 'originale intatto');
      const base = modern ? 'dimensions/minecraft/overworld' : '';
      const rels = ['region', 'entities', 'poi', 'DIM-1'].map((k) => (k === 'DIM-1' ? k : [base, k].filter(Boolean).join('/')));
      assertEqual(sizeUnder(dir, rels) - sizeUnder(res.targetDir, rels), plan.bytes.total, 'byte liberati = anteprima');
      assertEqual(res.freed.bytes, plan.bytes.total, 'byte nel resoconto');
      assertEqual(res.freed.chunks, 7, 'chunk eliminati');
      const p = (rel) => path.join(res.targetDir, base, rel);
      const terrain = readRegionFile(p('region/r.0.0.mca'));
      assertEqual(terrain.chunks().map(({ lx, lz }) => `${lx},${lz}`).join(' '), '0,0 1,0 2,0 10,0 11,0 12,0 5,8', 'chunk rimasti');
      assert(!fs.existsSync(p('region/c.8.0.mcc')), 'via il .mcc del chunk enorme');
      assert(!fs.existsSync(p('region/c.-5.0.mcc')) && !fs.existsSync(p('region/r.1.0.mca')), 'via orfani e vuoti');
      assert(!fs.existsSync(p('poi/r.0.0.mca')), 'via il poi');
      assertEqual(readRegionFile(p('entities/r.0.0.mca')).chunks().map(({ lx, lz }) => `${lx},${lz}`).join(), '12,0', 'resta solo la cornice');
      assertEqual(fs.statSync(p('region/r.-1.-1.mca')).size, 8192 + 4096 * Math.ceil((readRegionFile(p('region/r.-1.-1.mca')).entries.get(1023).data.length + 5) / 4096), 'compattata');
      assert(!fs.existsSync(path.join(res.targetDir, 'DIM-1')), 'cartella vecchia tolta');
      // The copy opens in the Cantiere and draws.
      const s = await WorldSession.open(res.targetDir, { dataDir: path.join(scratch, `data${n++}`) });
      const info = await s.info();
      assertEqual(info.dimensions[0].id, 'overworld', 'si apre');
      assert(await s.tile('overworld', 0, 0, 0), 'la mappa si disegna');
    });
  }

  test('la mappa nasconde quello che verrà eliminato; Annulla lo rimette', async () => {
    const dir = makePruneWorld(freshSaves(), 'Mappa', { modern: true });
    const journal = new Journal();
    const base = new NodeSource(dir);
    const overlay = new OverlaySource(base, journal);
    const scan = await scanOf(dir, journal);
    journal.push({ ...freeSpaceOp(planFreeSpace(scan, { legacy: true })), at: 1 });
    const rel = 'dimensions/minecraft/overworld/region/r.0.0.mca';
    const shown = RegionData.fromBuffer(Buffer.from(await overlay.readFile(rel)), 0, 0);
    assertEqual(shown.size, 7, 'restano 7 chunk');
    assertEqual(await overlay.fileSize('dimensions/minecraft/overworld/poi/r.0.0.mca'), null, 'il file poi sparisce');
    assert(!(await overlay.listEntries('')).some((e) => e.name === 'DIM-1'), 'la cartella vecchia sparisce');
    assertEqual(await overlay.readFile('DIM-1/data/vecchio.dat'), null, 'anche il suo contenuto');
    // A second scan sees the world without them.
    const again = planFreeSpace(await scanOf(dir, journal), { legacy: true });
    assertEqual(again.counts.chunks, 0, 'niente da rifare');
    journal.undo();
    // (fromBuffer without a folder leaves out the big chunk kept in its .mcc: 13 + 1.)
    assertEqual(RegionData.fromBuffer(Buffer.from(await overlay.readFile(rel)), 0, 0).size, 13, 'Annulla');
    assert(await overlay.fileSize('dimensions/minecraft/overworld/poi/r.0.0.mca'), 'il poi torna');
  });

  test('il giornale rifiuta percorsi fuori dal mondo', () => {
    const j = new Journal();
    const bad = [
      { files: { '../altro/region/r.0.0.mca': '' } },
      { files: { '/etc/r.0.0.mca': '' } },
      { files: { 'region/level.dat': '' } },
      { files: {}, dirs: ['playerdata'] },
      { files: {}, remove: ['region/../../x.mcc'] },
      { files: {} },
      { files: { 'region/r.0.0.mca': 'corta' } },
    ];
    for (const op of bad) {
      let threw = false;
      try { j.push({ type: 'freeSpace', remove: [], dirs: [], ...op }); } catch { threw = true; }
      assert(threw, JSON.stringify(op));
    }
    assertEqual(j.size, 0, 'niente in sospeso');
  });

  test('sessione: analizza in un worker, anteprima, metti in sospeso', async () => {
    const dir = makePruneWorld(freshSaves(), 'Sessione');
    const s = await WorldSession.open(dir, { dataDir: path.join(scratch, `data${n++}`) });
    s.push({ type: 'fillBox', dim: 'overworld', x1: 112, y1: 0, z1: 0, x2: 112, y2: 0, z2: 0, state: 'minecraft:stone', at: 1 });
    const progress = [];
    const sum = await s.freeSpaceScan((p) => progress.push(p)).promise;
    assertEqual(s.freeScan.orphanMcc.length, 1, 'il .mcc del chunk enorme non è orfano anche con la modifica in sospeso');
    assertEqual(sum.chunks, 15, 'chunk di terreno');
    assert(progress.length > 0, 'avanzamento');
    const pv = s.freeSpacePlan({}, 'overworld');
    assertEqual(pv.counts.chunks, 2, 'la modifica in sospeso al chunk 7 tiene 5..9');
    assertEqual(pv.heat.cx.length, 15, 'calore: un valore per chunk');
    const r = s.freeSpacePush({});
    assertEqual(s.journal.summary().freeSpace, 1, 'in sospeso');
    assert(r.dirty.some((d) => d.bounds === null), 'la mappa si ridisegna tutta');
    let threw = false;
    try { s.freeSpacePlan({}, 'overworld'); } catch { threw = true; }
    assert(threw, 'dopo una modifica l\'analisi va rifatta');
    const pre = await s.check(() => false);
    assert(pre.ok, 'Applica si può fare');
  });
}
