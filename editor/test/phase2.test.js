/*
 * Tests for the Cantiere's second phase: selections, biome painting, block
 * replacement and search. Registered by test/run-tests.js after cantiere.test.js.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseRaw } from '../../web/js/core/nbt.js';
import { writeNbt } from '../../web/js/core/nbtWrite.js';
import { loadRegionFile, forgetRegions, clearRegionCache } from '../../web/js/core/anvil.js';
import { ChunkEditor, stateKey, parseState } from '../core/chunk.js';
import { Journal, applyChunkOps } from '../core/journal.js';
import {
  chunkMask, contains, measure, selectionBounds, combine, invert, yRange, emptySelection,
} from '../core/selection.js';
import {
  blockMatcher, carryProperties, parseMix, compileMix, pickFromMix, familyOf, hash3,
} from '../core/blocks.js';
import { biomeColor, biomesFor } from '../core/biomes.js';
import { search, countReplace } from '../core/search.js';
import { OverlaySource } from '../core/overlay.js';
import { NodeSource } from '../core/nodeSource.js';
import { applyJournal } from '../core/apply.js';
import { readRegionFile } from '../core/region.js';
import { makeWorld, makeChunk } from './fixture.js';
import { WorldSession } from '../main/session.js';

const rect = (minX, minZ, maxX, maxZ) => ({ type: 'rect', minX, minZ, maxX, maxZ });
const sel = (...items) => ({ items, yMin: null, yMax: null });
const add = (shape) => ({ mode: 'add', shape });
const sub = (shape) => ({ mode: 'sub', shape });
const chunk = (cx = 0, cz = 0) => parseRaw(writeNbt(makeChunk(cx, cz)), { typed: true }).value;
const count = (mask) => (mask ? mask.reduce((a, b) => a + b, 0) : 0);
const REGIONS = [{ x: 0, z: 0 }];

export function register({ test, section, assert, assertEqual }) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cantiere2-'));
  let n = 0;
  const freshSaves = () => { const d = path.join(scratch, `s${n++}`); fs.mkdirSync(d); return d; };

  // -------------------------------------------------------------------------
  section('Cantiere — selezioni');

  test('rettangolo: colonne incluse ai bordi, chunk fuori esclusi', () => {
    const s = sel(add(rect(2, 3, 17, 4)));
    assertEqual(count(chunkMask(s, 0, 0)), 14 * 2, 'chunk 0,0');
    assertEqual(count(chunkMask(s, 1, 0)), 2 * 2, 'chunk 1,0');
    assertEqual(chunkMask(s, 0, 1), null, 'chunk fuori');
    assert(contains(s, 17, 4) && !contains(s, 18, 4) && !contains(s, 1, 3), 'bordi');
  });

  test('poligono: un triangolo prende le colonne col centro dentro', () => {
    const s = sel(add({ type: 'poly', points: [[0, 0], [16, 0], [0, 16]] }));
    assert(contains(s, 0, 0) && contains(s, 7, 7) && !contains(s, 8, 8) && !contains(s, 15, 15), 'diagonale');
    assertEqual(measure(s).columns, 120, 'metà del chunk meno la diagonale');
  });

  test('pennello: una pennellata è una capsula di raggio r', () => {
    const s = sel(add({ type: 'stroke', r: 2, points: [[10.5, 10.5], [30.5, 10.5]] }));
    assert(contains(s, 10, 10) && contains(s, 20, 12) && contains(s, 30, 8), 'dentro');
    assert(!contains(s, 20, 13) && !contains(s, 33, 10), 'fuori');
  });

  test('sottrai e interseca seguono l\'ordine', () => {
    const s = sel(add(rect(0, 0, 9, 9)), sub(rect(5, 0, 9, 9)), { mode: 'and', shape: rect(0, 0, 9, 4) });
    assertEqual(measure(s).columns, 25, '5x5');
    assert(contains(s, 4, 4) && !contains(s, 5, 4) && !contains(s, 4, 5), 'angoli');
  });

  test('inverti dentro un riquadro, combina con "nuova"', () => {
    const s = invert(sel(add(rect(0, 0, 3, 3))), { minX: 0, minZ: 0, maxX: 7, maxZ: 7 });
    assertEqual(measure(s).columns, 64 - 16, 'complemento');
    const t = combine(s, 'new', rect(0, 0, 0, 0));
    assertEqual(measure(t).columns, 1, 'nuova');
    assertEqual(selectionBounds(emptySelection()), null, 'vuota');
  });

  test('intervallo Y limitato all\'altezza della dimensione', () => {
    assertEqual(yRange({ yMin: null, yMax: null }, -64, 384).join(), '-64,319');
    assertEqual(yRange({ yMin: -100, yMax: 40 }, -64, 384).join(), '-64,40');
  });

  test('una selezione larga migliaia di blocchi si misura senza allocarla tutta', () => {
    const s = sel(add({ type: 'poly', points: [[-3000, -3000], [3000, -3000], [3000, 3000], [-3000, 3000]] }));
    const t0 = Date.now();
    const m = measure(s);
    assertEqual(m.columns, 6000 * 6000, 'colonne');
    assert(Date.now() - t0 < 20000, 'troppo lenta');
  });

  // -------------------------------------------------------------------------
  section('Cantiere — blocchi, tag e mix');

  test('blocco, proprietà, tag e pattern', () => {
    const st = (t) => parseState(t);
    assert(blockMatcher('stone')(st('stone')) && !blockMatcher('stone')(st('granite')), 'blocco');
    assert(blockMatcher('oak_stairs[half=top]')(st('oak_stairs[facing=east,half=top]')), 'proprietà sottoinsieme');
    assert(!blockMatcher('oak_stairs[half=top]')(st('oak_stairs[half=bottom]')), 'proprietà diversa');
    assert(blockMatcher('#minecraft:logs')(st('stripped_birch_log')) && !blockMatcher('#logs')(st('oak_planks')), 'tag');
    assert(blockMatcher('*_planks')(st('cherry_planks')) && !blockMatcher('*_planks')(st('mod:x_planks')), 'pattern');
    let err = '';
    try { blockMatcher('#minecraft:nonesiste'); } catch (e) { err = e.message; }
    assert(/Tag sconosciuto/.test(err), 'tag sconosciuto');
  });

  test('mantieni proprietà solo nella stessa famiglia', () => {
    const a = carryProperties(parseState('oak_stairs[facing=east,half=top]'), parseState('spruce_stairs'), true);
    assertEqual(stateKey(a.state), 'minecraft:spruce_stairs[facing=east,half=top]', 'scale');
    assert(!a.dropped, 'nulla perso');
    const b = carryProperties(parseState('oak_stairs[facing=east]'), parseState('oak_slab'), true);
    assertEqual(stateKey(b.state), 'minecraft:oak_slab', 'famiglia diversa');
    assert(b.dropped, 'segnalato');
    assertEqual(familyOf('minecraft:quartz_pillar'), 'log', 'pilastri come tronchi');
    assertEqual(stateKey(carryProperties(parseState('oak_log[axis=x]'), parseState('birch_log'), false).state), 'minecraft:birch_log', 'senza mantieni');
  });

  test('mix percentuale: lettura, pesi, scelta deterministica', () => {
    const mix = parseMix('70% stone, 30% andesite');
    assertEqual(mix.map((m) => m.weight).join(), '70,30');
    const c = compileMix(mix);
    let stone = 0;
    for (let i = 0; i < 4000; i++) if (pickFromMix(c, hash3(i, 7, -i)).Name === 'minecraft:stone') stone++;
    assert(stone > 2600 && stone < 3000, `circa 70%: ${stone}`);
    assertEqual(hash3(1, 2, 3, 4), hash3(1, 2, 3, 4), 'deterministico');
    assertEqual(stateKey(parseMix('oak_stairs[facing=east,half=top]')[0].state), 'minecraft:oak_stairs[facing=east,half=top]', 'virgole tra parentesi');
  });

  test('biomi: elenco per dimensione e colori stabili', () => {
    assert(biomesFor('the_nether').every((b) => b.dim === 'the_nether') && biomesFor('overworld').length > 40, 'elenchi');
    assertEqual(biomeColor('mod:strano').join(), biomeColor('mod:strano').join(), 'colore stabile');
  });

  // -------------------------------------------------------------------------
  section('Cantiere — sostituzione e biomi nel giornale');

  test('sostituisci: solo nella selezione e nell\'intervallo Y, con le proprietà', () => {
    const root = chunk();
    const op = {
      type: 'replaceBlocks', dim: 'overworld', region: sel(add(rect(0, 0, 7, 15))),
      rules: [{ from: 'grass_block', to: 'diamond_block' }, { from: 'stone', to: '50% andesite, 50% granite' }],
      yMin: 35, yMax: 60, keepProps: true,
    };
    applyChunkOps(root, [op], 0, 0, 'overworld');
    const ed = new ChunkEditor(root);
    assertEqual(ed.getState(3, 39, 3).Name, 'minecraft:diamond_block', 'erba nella selezione');
    assertEqual(ed.getState(9, 39, 3).Name, 'minecraft:grass_block', 'erba fuori');
    assert(['minecraft:andesite', 'minecraft:granite'].includes(ed.getState(3, 36, 3).Name), 'pietra a y36');
    assertEqual(ed.getState(3, 30, 3).Name, 'minecraft:stone', 'pietra sotto y35');
    assertEqual(ed.getState(5, 40, 5).Name, 'minecraft:chest', 'il baule resta');
  });

  test('sostituisci "solo esposti all\'aria" tocca solo la superficie', () => {
    const root = chunk();
    applyChunkOps(root, [{
      type: 'replaceBlocks', dim: 'overworld', region: sel(add(rect(0, 0, 15, 15))),
      rules: [{ from: '#minecraft:dirt', to: 'sand' }, { from: 'stone', to: 'gravel' }], exposedOnly: true,
    }], 0, 0, 'overworld');
    const ed = new ChunkEditor(root);
    assertEqual(ed.getState(3, 39, 3).Name, 'minecraft:sand', 'erba esposta');
    assertEqual(ed.getState(3, 38, 3).Name, 'minecraft:stone', 'pietra coperta');
  });

  test('il giornale rifiuta una selezione vuota e regole sbagliate', () => {
    const j = new Journal();
    let a = '', b = '';
    try { j.push({ type: 'replaceBlocks', dim: 'overworld', region: emptySelection(), rules: [{ from: 'stone', to: 'dirt' }] }); } catch (e) { a = e.message; }
    try { j.push({ type: 'replaceBlocks', dim: 'overworld', region: sel(add(rect(0, 0, 1, 1))), rules: [{ from: '#nope', to: 'dirt' }] }); } catch (e) { b = e.message; }
    assert(/vuota/.test(a) && /Tag sconosciuto/.test(b), `${a} / ${b}`);
    assertEqual(j.size, 0, 'niente nel giornale');
  });

  test('pennello bioma: celle intere, sezioni mancanti non create', () => {
    const root = chunk();
    const before = root.sections.items.length;
    applyChunkOps(root, [{
      type: 'paintBiome', dim: 'overworld', biome: 'minecraft:desert',
      region: sel(add({ type: 'stroke', r: 1, points: [[2.5, 2.5]] })),
    }], 0, 0, 'overworld');
    const ed = new ChunkEditor(root);
    assertEqual(ed.getBiome(0, 10, 0), 'minecraft:desert', 'cella 0,0');
    assertEqual(ed.getBiome(3, 63, 3), 'minecraft:desert', 'tutta la colonna');
    assertEqual(ed.getBiome(4, 10, 0), 'minecraft:plains', 'cella accanto');
    assertEqual(root.sections.items.length, before, 'nessuna sezione nuova');
  });

  // -------------------------------------------------------------------------
  section('Cantiere — ricerca e conteggi');

  test('cerca blocchi, block entity per oggetto contenuto, rispetta la selezione', async () => {
    const world = makeWorld(freshSaves());
    const src = new NodeSource(world);
    const r1 = await search({ source: src, dim: 'overworld', regions: REGIONS, selection: null, query: { kind: 'block', block: 'chest' } });
    assertEqual(r1.total, 4, 'un baule per chunk');
    assertEqual(r1.items[0].label, 'chest');
    const r2 = await search({ source: src, dim: 'overworld', regions: REGIONS, selection: sel(add(rect(0, 0, 15, 15))), query: { kind: 'block', block: '#minecraft:dirt' } });
    assertEqual(r2.total, 256, 'erba nel solo chunk 0,0');
    const r3 = await search({ source: src, dim: 'overworld', regions: REGIONS, selection: null, query: { kind: 'blockEntity', id: 'chest' }, limit: 10 });
    assertEqual(r3.total, 1, 'una block entity');
    assertEqual(`${r3.items[0].x},${r3.items[0].y},${r3.items[0].z}`, '5,40,5', 'posizione');
    const r4 = await search({ source: src, dim: 'overworld', regions: REGIONS, selection: null, query: { kind: 'blockEntity', item: 'diamond' } });
    assertEqual(r4.total, 0, 'baule vuoto');
    const r5 = await search({ source: src, dim: 'overworld', regions: REGIONS, selection: null, query: { kind: 'block', block: 'stone' }, limit: 5 });
    assert(r5.truncated && r5.items.length === 5 && r5.total > 1000, 'troncato con totale esatto');
  });

  test('la ricerca vede le modifiche in sospeso; il conteggio della sostituzione è esatto', async () => {
    const world = makeWorld(freshSaves());
    const j = new Journal();
    const overlay = new OverlaySource(new NodeSource(world), j);
    const op = { type: 'replaceBlocks', dim: 'overworld', region: sel(add(rect(0, 0, 31, 31))), rules: [{ from: 'grass_block', to: 'gold_block' }] };
    const c = await countReplace({ source: overlay, dim: 'overworld', regions: REGIONS, op });
    assertEqual(c.changed, 1024, 'quattro chunk di erba');
    j.push(op);
    const r = await search({ source: overlay, dim: 'overworld', regions: REGIONS, selection: null, query: { kind: 'block', block: 'gold_block' } });
    assertEqual(r.total, 1024, 'oro in anteprima');
  });

  test('sostituzione e biomi passano da Applica alla copia', async () => {
    const saves = freshSaves();
    const world = makeWorld(saves);
    const j = new Journal();
    j.push({ type: 'replaceBlocks', dim: 'overworld', region: sel(add(rect(0, 0, 15, 15))), rules: [{ from: 'grass_block', to: 'moss_block' }] });
    j.push({ type: 'paintBiome', dim: 'overworld', biome: 'minecraft:jungle', region: sel(add(rect(16, 0, 31, 15))) });
    const res = await applyJournal({ worldDir: world, journal: j, lockCheck: () => false });
    const region = readRegionFile(path.join(res.targetDir, 'region', 'r.0.0.mca'));
    const a = new ChunkEditor(region.getChunk(0, 0).value);
    const b = new ChunkEditor(region.getChunk(1, 0).value);
    assertEqual(a.getState(1, 39, 1).Name, 'minecraft:moss_block', 'sostituito');
    assertEqual(b.getBiome(20, 39, 4), 'minecraft:jungle', 'bioma');
    assertEqual(b.getState(20, 39, 4).Name, 'minecraft:grass_block', 'blocchi del chunk dipinto intatti');
  });

  // -------------------------------------------------------------------------
  section('Cantiere — cache delle region');

  test('due mondi aperti insieme non si scambiano le region in cache', async () => {
    clearRegionCache();
    const wa = makeWorld(freshSaves(), 'A');
    const wb = makeWorld(freshSaves(), 'B');
    const j = new Journal();
    j.push({ type: 'fillBox', dim: 'overworld', x1: 0, y1: 39, z1: 0, x2: 0, y2: 39, z2: 0, state: 'gold_block' });
    const sa = new OverlaySource(new NodeSource(wa), j);
    const sb = new NodeSource(wb);
    const ra = await loadRegionFile(sa, 'region/r.0.0.mca');
    const rb = await loadRegionFile(sb, 'region/r.0.0.mca');
    assert(ra !== rb, 'stessa voce in cache per due mondi');
    forgetRegions(sa);
    assert((await loadRegionFile(sa, 'region/r.0.0.mca')) !== ra, 'dimenticata');
    assert((await loadRegionFile(sb, 'region/r.0.0.mca')) === rb, 'l\'altro mondo resta in cache');
  });

  test('sessione: solo le tile dei chunk toccati vengono invalidate', async () => {
    const s = await WorldSession.open(makeWorld(freshSaves()), { dataDir: path.join(scratch, 'd1') });
    await s.tile('overworld', 0, 0, 0);
    await s.tile('overworld', -1, 0, 0);
    const changed = s.push({ type: 'fillBox', dim: 'overworld', x1: 3, y1: 39, z1: 3, x2: 3, y2: 39, z2: 3, state: 'gold_block' });
    assert(changed.dirty && changed.dirty.length === 1, 'un riquadro sporco');
    assertEqual(changed.dirty[0].dim, 'overworld');
  });

  section('Cantiere — lavori in un worker');

  test('Applica in un worker: avanzamento, copia scritta, giornale svuotato', async () => {
    const saves = freshSaves();
    const s = await WorldSession.open(makeWorld(saves), { dataDir: path.join(scratch, 'd2') });
    s.push({ type: 'paintBiome', dim: 'overworld', biome: 'minecraft:desert', region: sel(add(rect(0, 0, 15, 15))) });
    const phases = new Set();
    const t = s.applyInWorker({ skipLockCheck: true, onProgress: (p) => phases.add(p.phase) });
    const res = await t.promise;
    assert(fs.existsSync(path.join(res.targetDir, 'level.dat')), 'copia');
    assert(phases.has('copia') && phases.has('fine'), [...phases].join());
    assertEqual(s.journal.size, 0, 'giornale svuotato');
  });

  test('ricerca in un worker e annullamento', async () => {
    const s = await WorldSession.open(makeWorld(freshSaves()), { dataDir: path.join(scratch, 'd3') });
    const r = await s.search('overworld', null, { kind: 'block', block: 'chest' }).promise;
    assertEqual(r.total, 4, 'bauli');
    const t = s.search('overworld', null, { kind: 'block', block: 'stone' });
    await t.cancel();
    let err = null;
    try { await t.promise; } catch (e) { err = e; }
    assert(err && err.cancelled, 'annullata');
    const c = await s.countReplace({ type: 'replaceBlocks', dim: 'overworld', region: sel(add(rect(0, 0, 15, 15))), rules: [{ from: 'chest', to: 'barrel' }] }).promise;
    assertEqual(c.changed, 1, 'un baule da cambiare');
  });

  test('sessione: da lontano la mappa tiene il riquadro vecchio finché quello nuovo non è pronto', async () => {
    const s = await WorldSession.open(makeWorld(freshSaves()), { dataDir: path.join(scratch, 'd4') });
    // Build the pyramid down to -3 as the background builder would.
    const { getTile } = await import('../../web/js/core/tiler.js');
    await getTile(s.ctxFor('overworld', null), -3, 0, 0, true);
    const before = await s.tile('overworld', -3, 0, 0);
    assert(before, 'riquadro lontano');
    const ready = new Promise((resolve) => { s.onTilesReady = resolve; });
    s.push({ type: 'fillBox', dim: 'overworld', x1: 0, y1: 39, z1: 0, x2: 31, y2: 39, z2: 31, state: 'gold_block' });
    const during = await s.tile('overworld', -3, 0, 0);
    assert(during === before, 'mostra il vecchio, non un buco');
    const box = await ready;
    assertEqual(box.dim, 'overworld');
    const after = await s.tile('overworld', -3, 0, 0);
    assert(after && after !== before, 'ricostruito');
  });

  test('pulizia delle cartelle temporanee (fase 2)', () => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });
}

