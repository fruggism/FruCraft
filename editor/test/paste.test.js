/*
 * Tests for copy / paste between worlds (editor/core/clips.js, paste.js) and
 * the terrain seam (editor/core/seam.js). Registered by test/run-tests.js.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TAG, TList, TByte, TDouble } from '../../web/js/core/nbt.js';
import { clearRegionCache } from '../../web/js/core/anvil.js';
import { ChunkEditor, stateKey } from '../core/chunk.js';
import { Journal } from '../core/journal.js';
import { createClip, listClips, removeClip } from '../core/clips.js';
import { PASTE, pastePlacement } from '../core/paste.js';
import { SMOOTH, computeProfiles, groundOf } from '../core/seam.js';
import { OverlaySource } from '../core/overlay.js';
import { NodeSource } from '../core/nodeSource.js';
import { applyJournal } from '../core/apply.js';
import { readRegionFile, writeRegionFile, RegionData } from '../core/region.js';
import { search } from '../core/search.js';
import { makeWorld } from './fixture.js';
import { WorldSession } from '../main/session.js';

const MODERN = 'dimensions/minecraft/overworld';
const rect = (minX, minZ, maxX, maxZ) => ({ type: 'rect', minX, minZ, maxX, maxZ });
const sel = (shape, yMin = null, yMax = null) => ({ items: [{ mode: 'add', shape }], yMin, yMax });
const unlocked = () => false;

/** Read one chunk of a world on disk into an editor. */
function chunkOf(world, cx, cz, kind = 'region') {
  const file = path.join(world, MODERN, kind, `r.${cx >> 5}.${cz >> 5}.mca`);
  if (!fs.existsSync(file)) return null;
  const r = readRegionFile(file);
  if (!r.has(cx & 31, cz & 31)) return null;
  const { value } = r.getChunk(cx & 31, cz & 31);
  return kind === 'region' ? new ChunkEditor(value) : value;
}

/** Change one chunk of a world on disk. */
function editChunk(world, cx, cz, fn, kind = 'region') {
  const file = path.join(world, MODERN, kind, `r.${cx >> 5}.${cz >> 5}.mca`);
  const r = fs.existsSync(file) ? readRegionFile(file) : new RegionData(cx >> 5, cz >> 5);
  const c = r.has(cx & 31, cz & 31) ? r.getChunk(cx & 31, cz & 31) : { name: '', value: null };
  const v = fn(c.value);
  r.setChunk(cx & 31, cz & 31, v, c.name || '');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeRegionFile(file, r);
}

const entityChunk = (cx, cz, entities) => ({
  DataVersion: 3465, Position: Int32Array.from([cx, cz]), Entities: new TList(TAG.Compound, entities),
});
const armorStand = (x, y, z) => ({
  id: 'minecraft:armor_stand', Pos: new TList(TAG.Double, [new TDouble(x), new TDouble(y), new TDouble(z)]), UUID: Int32Array.from([1, 2, 3, 4]),
});

export function register({ test, section, assert, assertEqual }) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cantiere-paste-'));
  let n = 0;
  const freshSaves = () => { const d = path.join(scratch, `s${n++}`); fs.mkdirSync(d); return d; };
  const clipsDir = path.join(scratch, 'clips');

  /** A source world (26.x folders) with an armor stand in chunk 0,0 and a tick on the chest. */
  function sourceWorld() {
    const world = makeWorld(freshSaves(), 'Sorgente', { modernDirs: true });
    editChunk(world, 0, 0, () => entityChunk(0, 0, [armorStand(5.5, 40, 5.5)]), 'entities');
    editChunk(world, 0, 0, (v) => { v.block_ticks = new TList(TAG.Compound, [{ i: 'minecraft:chest', x: 5, y: 40, z: 5, t: 3, p: 0 }]); return v; });
    return world;
  }

  // -------------------------------------------------------------------------
  section('Cantiere — copia e incolla');

  test('copia: l\'appunto clona region ed entità sotto la selezione e si descrive', () => {
    const world = sourceWorld();
    const clip = createClip({ worldDir: world, modern: true, dim: 'overworld', selection: sel(rect(0, 0, 20, 20)), clipsDir, worldName: 'Sorgente' });
    assertEqual(clip.chunks.maxX, 1, 'chunk coperti');
    assert(fs.existsSync(path.join(clip.dir, 'region', 'r.0.0.mca')), 'region clonata');
    assert(fs.existsSync(path.join(clip.dir, 'entities', 'r.0.0.mca')), 'entità clonate');
    assert(listClips(clipsDir).some((c) => c.id === clip.id), 'elencato');
    removeClip(clip.dir);
    assert(!listClips(clipsDir).some((c) => c.id === clip.id), 'tolto');
  });

  test('copia: una selezione senza chunk generati non crea appunti', () => {
    const world = sourceWorld();
    let err = null;
    try { createClip({ worldDir: world, modern: true, dim: 'overworld', selection: sel(rect(5000, 5000, 5010, 5010)), clipsDir }); } catch (e) { err = e; }
    assert(err && /non ci sono chunk/.test(err.message), 'errore chiaro');
  });

  test('incolla a chunk interi: spostati, creati dove non c\'erano (anche in una region nuova), bordo da rifare', async () => {
    const src = sourceWorld();
    const clip = createClip({ worldDir: src, modern: true, dim: 'overworld', selection: sel(rect(0, 0, 31, 31)), clipsDir });
    const dst = makeWorld(freshSaves(), 'Destinazione', { modernDirs: true });
    editChunk(dst, 1, 0, () => entityChunk(1, 0, [armorStand(20, 40, 3)]), 'entities');
    editChunk(dst, 1, 0, () => ({ DataVersion: 3465, Sections: {} }), 'poi');
    const j = new Journal();
    // One chunk east, over the destination's own chunks 1,* and new chunks 2,*
    const a = pastePlacement(clip, { mode: 'chunks', x: 16, z: 0 });
    assertEqual(a.dx, 16, 'agganciato al chunk');
    j.push({ type: 'paste', dim: 'overworld', clip: clip.dir, mode: 'chunks', ...a, selection: clip.selection });
    // And far away, where there is no region file at all
    const b = pastePlacement(clip, { mode: 'chunks', x: 1030, z: 7 });
    assertEqual(b.dx, 1024, 'arrotondato al chunk');
    j.push({ type: 'paste', dim: 'overworld', clip: clip.dir, mode: 'chunks', ...b, selection: clip.selection });

    // Preview: the overlay already shows both
    clearRegionCache();
    const overlay = new OverlaySource(new NodeSource(dst), j);
    const hit = await search({ source: overlay, dim: 'overworld', regions: [{ x: 0, z: 0 }, { x: 2, z: 0 }], selection: null, query: { kind: 'block', block: 'chest' } });
    // Every fixture chunk has a chest block: 2 left of the destination's own, 4 + 4 pasted.
    assertEqual(hit.total, 2 + 4 + 4, 'bauli in anteprima');

    const before = fs.readFileSync(path.join(dst, MODERN, 'region', 'r.0.0.mca'));
    const res = await applyJournal({ worldDir: dst, journal: j, lockCheck: unlocked });
    assert(Buffer.compare(before, fs.readFileSync(path.join(dst, MODERN, 'region', 'r.0.0.mca'))) === 0, 'originale intatto');
    const c2 = chunkOf(res.targetDir, 2, 0);
    assert(c2, 'chunk 2,0 creato');
    assertEqual(Number(c2.root.xPos), 2, 'xPos');
    assertEqual(c2.root.isLightOn.v, 0, 'anello esterno da rifare');
    assertEqual(stateKey(c2.getState(37, 39, 5)), 'minecraft:grass_block', 'erba del chunk 1,0 sorgente a x+16');
    assertEqual(stateKey(c2.getState(37, 40, 5)), 'minecraft:chest', 'e il suo baule');
    const c1 = chunkOf(res.targetDir, 1, 0);
    assertEqual(stateKey(c1.getState(21, 40, 5)), 'minecraft:chest', 'baule spostato');
    assertEqual(c1.root.block_entities.items[0].x, 21, 'block entity spostata');
    assertEqual(c1.root.block_ticks.items[0].x, 21, 'tick spostato');
    const far = chunkOf(res.targetDir, 64, 0);
    assert(far && Number(far.root.xPos) === 64, 'region nuova r.2.0 creata');
    // Entities: the destination's stand under the paste is gone, the clip's moved in
    const e1 = chunkOf(res.targetDir, 1, 0, 'entities');
    assertEqual(e1.Entities.items.length, 1, 'una sola entità');
    assertEqual(e1.Entities.items[0].Pos.items[0].v, 21.5, 'è quella del pezzo, spostata');
    assert(e1.Entities.items[0].UUID[0] !== 1 || e1.Entities.items[0].UUID[1] !== 2, 'UUID nuovo');
    assert(!chunkOf(res.targetDir, 1, 0, 'poi'), 'POI della zona tolti');
  });

  test('incolla a blocchi: spostamento qualsiasi anche in Y, baule e tick con il blocco, aria saltata a richiesta', async () => {
    const src = sourceWorld();
    const clip = createClip({ worldDir: src, modern: true, dim: 'overworld', selection: sel(rect(4, 4, 6, 6), 39, 41), clipsDir });
    const dst = makeWorld(freshSaves(), 'Blocchi', { modernDirs: true });
    const j = new Journal();
    const base = { type: 'paste', dim: 'overworld', clip: clip.dir, mode: 'blocks', selection: clip.selection, yMin: 39, yMax: 41, biomes: true };
    j.push({ ...base, ...pastePlacement(clip, { mode: 'blocks', x: 11, z: 7, dy: -2 }), air: false });
    j.push({ ...base, ...pastePlacement(clip, { mode: 'blocks', x: 11, z: 23, dy: -2 }), air: true });
    const res = await applyJournal({ worldDir: dst, journal: j, lockCheck: unlocked });
    const c = chunkOf(res.targetDir, 0, 0);
    assertEqual(stateKey(c.getState(12, 38, 8)), 'minecraft:chest', 'baule a (12, 38, 8)');
    assertEqual(stateKey(c.getState(11, 37, 7)), 'minecraft:grass_block', 'erba sotto, spostata');
    assertEqual(stateKey(c.getState(12, 39, 8)), 'minecraft:grass_block', 'senza aria: l\'erba di destinazione resta');
    const be = c.root.block_entities.items.find((e) => e.id === 'minecraft:chest' && e.x === 12);
    assert(be && be.y === 38 && be.z === 8, 'block entity spostata');
    assert(c.root.block_ticks.items.some((t) => t.x === 12 && t.y === 38 && t.z === 8), 'tick spostato');
    const d = chunkOf(res.targetDir, 0, 1);
    assertEqual(stateKey(d.getState(12, 39, 24)), 'minecraft:air', 'con l\'aria: sovrascrive');
    assertEqual(stateKey(d.getState(4, 39, 20)), 'minecraft:grass_block', 'fuori dalla selezione nulla cambia');
  });

  test('incolla: a chunk interi lo spostamento dev\'essere un multiplo di 16', () => {
    const src = sourceWorld();
    const clip = createClip({ worldDir: src, modern: true, dim: 'overworld', selection: sel(rect(0, 0, 15, 15)), clipsDir });
    let err = null;
    try { PASTE.validate({ type: 'paste', clip: clip.dir, mode: 'chunks', dx: 5, dy: 0, dz: 0, to: { minX: 5, minZ: 0, maxX: 20, maxZ: 15 } }); } catch (e) { err = e; }
    assert(err && /multiplo di 16/.test(err.message), 'rifiutato');
  });

  // -------------------------------------------------------------------------
  section('Cantiere — terreno');

  /** World with chunk column x 0..15 raised to grass at y 60; the rest stays at 39. */
  async function raised() {
    const world = makeWorld(freshSaves(), 'Rialzo', { modernDirs: true });
    const j = new Journal();
    j.push({ type: 'fillBox', dim: 'overworld', x1: 0, y1: 40, z1: 0, x2: 15, y2: 59, z2: 31, state: 'stone' });
    j.push({ type: 'fillBox', dim: 'overworld', x1: 0, y1: 60, z1: 0, x2: 15, y2: 60, z2: 31, state: 'grass_block' });
    j.push({ type: 'fillBox', dim: 'overworld', x1: 20, y1: 45, z1: 10, x2: 20, y2: 45, z2: 10, state: 'oak_planks' });
    const res = await applyJournal({ worldDir: world, journal: j, lockCheck: unlocked, copyName: 'Rialzo base' });
    return res.targetDir;
  }
  const opFor = async (world, extra) => {
    const box = { minX: 0, minZ: 0, maxX: 15, maxZ: 31 };
    const params = { dim: 'overworld', box, sides: ['e'], bin: 4, bout: 12, rim: null, sea: 30, wobble: 0, trees: 0, tree: 'oak', seed: 7, ...extra };
    const prof = await computeProfiles({ source: new NodeSource(world), regionDir: `${MODERN}/region`, ...params });
    return { type: 'smoothTerrain', ...params, prof };
  };
  const heights = (world, z) => {
    const out = [];
    for (let x = 8; x <= 31; x++) { const ed = chunkOf(world, x >> 4, z >> 4); out.push(groundOf(ed, x, z, 319, -64)); }
    return out;
  };

  test('raccordo: i profili misurano dentro e fuori dal lato', async () => {
    const world = await raised();
    const op = await opFor(world, {});
    assertEqual(op.prof.e.i[5], 60, 'dentro: il rialzo');
    assertEqual(op.prof.e.o[5], 39, 'fuori: il terreno');
    SMOOTH.validate(op);
  });

  test('raccordo: una rampa scende dal rialzo al terreno, senza toccare il costruito', async () => {
    const world = await raised();
    const j = new Journal();
    j.push(await opFor(world, {}));
    const res = await applyJournal({ worldDir: world, journal: j, lockCheck: unlocked });
    const h = heights(res.targetDir, 6);       // x = 8..31 (z 5 has the fixture's chest at x 21)
    assertEqual(h[11 - 8], 60, 'all\'inizio della fascia interna resta il rialzo');
    assertEqual(h[27 - 8], 39, 'alla fine della fascia esterna c\'è il terreno');
    for (let i = 11 - 8; i < 27 - 8; i++) assert(h[i] >= h[i + 1], `la rampa non risale (x ${8 + i}: ${h[i]} → ${h[i + 1]})`);
    assert(h[19 - 8] < 60 && h[19 - 8] > 39, 'a metà sta a metà');
    const c = chunkOf(res.targetDir, 1, 0);
    assertEqual(stateKey(c.getState(20, 45, 10)), 'minecraft:oak_planks', 'la colonna costruita resta com\'era');
    assertEqual(stateKey(c.getState(20, 39, 10)), 'minecraft:grass_block', 'anche sotto');
    assertEqual(stateKey(c.getState(21, 40, 5)), 'minecraft:chest', 'e il baule');
  });

  test('raccordo: dentro non scende sotto la quota minima; alberi sulla fascia', async () => {
    const world = await raised();
    const j = new Journal();
    j.push(await opFor(world, { rim: 58, trees: 1, tree: 'birch', bout: 14 }));
    const res = await applyJournal({ worldDir: world, journal: j, lockCheck: unlocked });
    for (const x of [11, 12, 13, 14, 15]) {
      const g = groundOf(chunkOf(res.targetDir, 0, 0), x, 5, 319, -64);
      assert(g === null || g >= 58, `x ${x}: ${g}`);
    }
    let logs = 0;
    for (const [cx, cz] of [[1, 0], [1, 1]]) {
      const ed = chunkOf(res.targetDir, cx, cz);
      for (let z = cz * 16; z < cz * 16 + 16; z++) for (let x = 16; x < 32; x++) for (let y = 39; y < 70; y++) if (ed.getState(x, y, z).Name === 'minecraft:birch_log') logs++;
    }
    assert(logs > 0, 'qualche betulla');
  });

  test('raccordo: con l\'irregolarità il confine si muove ma resta nella fascia', async () => {
    const world = await raised();
    const op = await opFor(world, { wobble: 4 });
    SMOOTH.validate(op);
    const b = SMOOTH.bounds(op);
    assertEqual(b.maxX, 15 + 12 + 4, 'la fascia esterna più l\'irregolarità');
    const j = new Journal();
    j.push(op);
    const res = await applyJournal({ worldDir: world, journal: j, lockCheck: unlocked });
    const far = groundOf(chunkOf(res.targetDir, 1, 0), 31, 5, 319, -64);
    assertEqual(far, 39, 'oltre la fascia nulla cambia');
  });

  // -------------------------------------------------------------------------
  section('Cantiere — incolla e raccordo dalla sessione');

  test('sessione: copia da un mondo, incolla nell\'altro e raccorda i bordi del pezzo', async () => {
    const dataDir = path.join(scratch, 'dati-sessione');
    const a = await WorldSession.open(sourceWorld(), { dataDir });
    const b = await WorldSession.open(makeWorld(freshSaves(), 'Arrivo', { modernDirs: true }), { dataDir });
    const clip = a.copy('overworld', sel(rect(0, 0, 15, 15)), path.join(dataDir, 'clips'));
    b.push({ type: 'paste', dim: 'overworld', clip: clip.dir, mode: 'chunks', ...pastePlacement(clip, { mode: 'chunks', x: 16, z: 16 }), selection: clip.selection });
    assertEqual((await b.probe('overworld', 21, 21)).block, 'minecraft:chest', 'l\'anteprima mostra il pezzo');
    const last = b.lastPasteBox('overworld');
    assertEqual(last.minX, 16, 'riquadro dell\'ultimo incollato');
    await b.smooth({ dim: 'overworld', box: last, sides: ['n', 'w'], bin: 2, bout: 6, rim: null, sea: 30, wobble: 0, trees: 0, tree: 'oak', seed: 1 });
    assertEqual(b.journal.ops[b.journal.ops.length - 1].type, 'smoothTerrain', 'raccordo in sospeso');
  });
}
