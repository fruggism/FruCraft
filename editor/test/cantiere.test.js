/*
 * Tests for the Cantiere core (editor/core). Registered into the main test
 * runner by test/run-tests.js, so `npm test` covers both apps.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

import { parseRaw, TAG, TList, TByte } from '../../web/js/core/nbt.js';
import { writeNbt } from '../../web/js/core/nbtWrite.js';
import { readSpanningPacked, readPaddedPacked, clearRegionCache, analyzeChunk } from '../../web/js/core/anvil.js';
import { renderBaseTile } from '../../web/js/core/tiler.js';
import { RegionData, readRegionFile, writeRegionFile } from '../core/region.js';
import {
  ChunkEditor, packIndices, unpackIndices, parseState, stateKey, heightmapBits,
} from '../core/chunk.js';
import { Journal } from '../core/journal.js';
import { applyJournal, preflight, readLevel, uniqueCopyName, INCOMPLETE_MARK } from '../core/apply.js';
import { OverlaySource } from '../core/overlay.js';
import { NodeSource } from '../core/nodeSource.js';
import { makeWorld, makeChunk, CHUNKS } from './fixture.js';
import { WorldSession, listWorlds } from '../main/session.js';

const unlocked = () => false;

function hashTree(dir) {
  const h = crypto.createHash('sha256');
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      h.update(path.relative(dir, p));
      if (e.isDirectory()) walk(p); else h.update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}

export function register({ test, section, assert, assertEqual }) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cantiere-'));
  let counter = 0;
  const freshSaves = () => { const d = path.join(scratch, `saves${counter++}`); fs.mkdirSync(d); return d; };

  // -------------------------------------------------------------------------
  section('Cantiere — NBT con tipi');

  test('un albero letto con i tipi si riscrive identico byte per byte', () => {
    const bytes = writeNbt(makeChunk(0, 0), 'radice');
    const { name, value } = parseRaw(bytes, { typed: true });
    assertEqual(name, 'radice');
    const again = writeNbt(value, name);
    assert(Buffer.compare(Buffer.from(bytes), Buffer.from(again)) === 0, 'i byte sono diversi');
  });

  test('la lettura normale non cambia: i tipi numerici restano numeri', () => {
    const { value } = parseRaw(writeNbt(makeChunk(0, 0)));
    assertEqual(value.mod_data.f, 1.5, 'float');
    assertEqual(value.isLightOn, 1, 'byte');
    assert(Array.isArray(value.sections), 'le liste sono array');
  });

  // -------------------------------------------------------------------------
  section('Cantiere — impacchettamento dei bit');

  test('packIndices coincide con i lettori di Cube-Atlas (a blocchi e a tratti)', () => {
    for (const bits of [4, 5, 6, 7, 9, 13]) {
      const idx = Uint16Array.from({ length: 4096 }, (_, i) => (i * 2654435761 >>> 7) % (1 << bits));
      for (const padded of [true, false]) {
        const longs = packIndices(idx, bits, padded);
        const read = padded ? readPaddedPacked : readSpanningPacked;
        for (let i = 0; i < 4096; i += 13) assertEqual(read(longs, bits, i), idx[i], `bits ${bits} padded ${padded} i ${i}`);
        const back = unpackIndices(longs, bits, 4096, padded);
        assert(back.every((v, i) => v === idx[i]), `round trip bits ${bits} padded ${padded}`);
      }
    }
  });

  // -------------------------------------------------------------------------
  section('Cantiere — file di regione');

  test('regione: serializza e rilegge gli stessi chunk, intatti', () => {
    const r = new RegionData(0, 0);
    for (const [cx, cz] of CHUNKS) r.setChunk(cx, cz, makeChunk(cx, cz), '', 1700000000);
    const { file } = r.serialize();
    const back = RegionData.fromBuffer(file, 0, 0);
    assertEqual(back.size, 4, 'chunk');
    for (const [cx, cz] of CHUNKS) {
      const a = writeNbt(back.getChunk(cx, cz).value);
      assert(Buffer.compare(Buffer.from(a), Buffer.from(writeNbt(makeChunk(cx, cz)))) === 0, `chunk ${cx},${cz}`);
    }
  });

  test('regione: i chunk non toccati si copiano senza ricomprimerli', () => {
    const r = new RegionData(0, 0);
    for (const [cx, cz] of CHUNKS) r.setChunk(cx, cz, makeChunk(cx, cz));
    const before = RegionData.fromBuffer(r.serialize().file, 0, 0);
    const edited = RegionData.fromBuffer(r.serialize().file, 0, 0);
    const { value } = edited.getChunk(0, 0);
    value.LastUpdate = 99n;
    edited.setChunk(0, 0, value);
    const after = RegionData.fromBuffer(edited.serialize().file, 0, 0);
    for (const [cx, cz] of CHUNKS.slice(1)) {
      assert(before.entries.get(cx + cz * 32).data.equals(after.entries.get(cx + cz * 32).data), `chunk ${cx},${cz} cambiato`);
    }
    assertEqual(after.getChunk(0, 0).value.LastUpdate, 99n, 'la modifica c\'è');
  });

  test('regione: un chunk che si allarga o si restringe non rovina i vicini', () => {
    const r = new RegionData(0, 0);
    for (const [cx, cz] of CHUNKS) r.setChunk(cx, cz, makeChunk(cx, cz));
    const big = makeChunk(0, 0);
    // Incompressible filler, so the chunk really needs more sectors.
    big.mod_data.filler = new Int8Array(crypto.randomBytes(40000));
    r.setChunk(0, 0, big);
    let back = RegionData.fromBuffer(r.serialize().file, 0, 0);
    assert(back.getChunk(0, 0).value.mod_data.filler.length === 40000, 'grande');
    assertEqual(back.getChunk(1, 1).value.xPos, 1, 'vicino dopo l\'ingrandimento');
    r.setChunk(0, 0, makeChunk(0, 0));
    back = RegionData.fromBuffer(r.serialize().file, 0, 0);
    assertEqual(back.getChunk(1, 0).value.xPos, 1, 'vicino dopo il restringimento');
    assert(r.serialize().file.length % 4096 === 0, 'settori interi');
  });

  test('regione: un chunk oltre 1 MiB finisce in un file .mcc e torna indietro', () => {
    const dir = path.join(freshSaves(), 'region');
    fs.mkdirSync(dir);
    const r = new RegionData(0, 0);
    r.setChunk(0, 0, makeChunk(0, 0));
    r.setChunk(2, 0, makeChunk(2, 0));
    const big = makeChunk(1, 0);
    big.mod_data.filler = new Int8Array(crypto.randomBytes(1100000));
    r.setChunk(1, 0, big);
    const file = path.join(dir, 'r.0.0.mca');
    writeRegionFile(file, r);
    assert(fs.existsSync(path.join(dir, 'c.1.0.mcc')), 'manca il .mcc');
    const back = readRegionFile(file);
    assertEqual(back.getChunk(1, 0).value.mod_data.filler.length, 1100000, 'letto dal .mcc');
    assertEqual(back.getChunk(2, 0).value.xPos, 2, 'il vicino');
    // Shrink it: the stale .mcc must go away.
    back.setChunk(1, 0, makeChunk(1, 0));
    writeRegionFile(file, back);
    assert(!fs.existsSync(path.join(dir, 'c.1.0.mcc')), 'il .mcc vecchio è rimasto');
  });

  // -------------------------------------------------------------------------
  section('Cantiere — chunk');

  test('un chunk letto e riscritto senza modifiche è identico', () => {
    const bytes = writeNbt(makeChunk(0, 0));
    const { value } = parseRaw(bytes, { typed: true });
    const ed = new ChunkEditor(value);
    for (let sy = 0; sy <= 3; sy++) ed.getState(0, sy * 16, 0); // decode everything
    ed.commit();
    assert(Buffer.compare(Buffer.from(bytes), Buffer.from(writeNbt(value))) === 0, 'diverso');
  });

  test('setState: il blocco si rilegge, la palette si compatta, il resto resta', () => {
    const { value } = parseRaw(writeNbt(makeChunk(0, 0)), { typed: true });
    const ed = new ChunkEditor(value);
    assertEqual(stateKey(ed.getState(3, 39, 3)), 'minecraft:grass_block', 'prima');
    ed.setState(3, 39, 3, parseState('oak_stairs[facing=east,half=top]'));
    ed.setState(4, 39, 3, parseState('stone'));
    ed.commit();
    const re = new ChunkEditor(parseRaw(writeNbt(value), { typed: true }).value);
    assertEqual(stateKey(re.getState(3, 39, 3)), 'minecraft:oak_stairs[facing=east,half=top]', 'scala');
    assertEqual(stateKey(re.getState(4, 39, 3)), 'minecraft:stone', 'pietra');
    assertEqual(stateKey(re.getState(5, 39, 3)), 'minecraft:grass_block', 'vicino');
    assertEqual(value.mod_data.listOfLists.items.length, 2, 'chiavi sconosciute');
    assertEqual(value.InhabitedTime, 12345n, 'InhabitedTime');
  });

  test('NBT: una lista mista (26.3) si rilegge spacchettata e si riscrive come il gioco', () => {
    const tree = { l: ['minecraft:air', { id: 'minecraft:water', properties: { level: '2' } }], w: [{ '': 'x' }, { a: 1 }] };
    const back = parseRaw(writeNbt(tree), { typed: true }).value;
    assertEqual(back.l.itemType, TAG.Compound, 'lista di compound');
    assertEqual(back.l.items[0], 'minecraft:air', 'stringa spacchettata');
    assertEqual(back.l.items[1].id, 'minecraft:water', 'compound intatto');
    assertEqual(back.w.items[0][''], 'x', 'un compound con la sola chiave "" sopravvive');
    assertEqual(writeNbt(back).length, writeNbt(tree).length, 'riscrittura stabile');
  });

  test('chunk 26.3 (palette con nomi nudi e { id, properties }): si legge, si modifica e resta nel suo formato', () => {
    const chunk = makeChunk(0, 0);
    for (const sec of chunk.sections.items) {
      sec.block_states.palette = new TList(TAG.String, sec.block_states.palette.items.map((p) => p.Name));
    }
    const { value } = parseRaw(writeNbt(chunk), { typed: true });
    const cols = analyzeChunk(parseRaw(writeNbt(chunk)).value);
    assertEqual(cols.surfaceName[0], 'minecraft:grass_block', 'la mappa vede l\'erba, non la pietra sotto');
    const ed = new ChunkEditor(value);
    assertEqual(stateKey(ed.getState(3, 39, 3)), 'minecraft:grass_block', 'prima');
    ed.setState(3, 39, 3, parseState('oak_stairs[facing=east,half=top]'));
    ed.commit();
    const raw = parseRaw(writeNbt(value)).value;
    const pal = raw.sections.find((x) => x.Y === 2).block_states.palette;
    assert(pal.includes('minecraft:stone'), 'nomi nudi');
    assert(pal.some((p) => p && p.id === 'minecraft:oak_stairs' && p.properties.half === 'top'), '{ id, properties }');
    assert(!pal.some((p) => p && p.Name), 'niente Name nel formato nuovo');
    const re = new ChunkEditor(parseRaw(writeNbt(value), { typed: true }).value);
    assertEqual(stateKey(re.getState(3, 39, 3)), 'minecraft:oak_stairs[facing=east,half=top]', 'scala');
    assertEqual(stateKey(re.getState(5, 39, 3)), 'minecraft:grass_block', 'vicino');
  });

  test('setState: luce tolta, isLightOn a 0, block entity rimossa, sezioni non toccate intatte', () => {
    const { value } = parseRaw(writeNbt(makeChunk(0, 0)), { typed: true });
    const sec0 = writeNbt(value.sections.items[0]);
    const ed = new ChunkEditor(value);
    ed.setState(5, 40, 5, parseState('air'));
    ed.commit();
    const sec2 = value.sections.items.find((s) => s.Y.v === 2);
    assert(!sec2.SkyLight && !sec2.BlockLight, 'luce ancora presente');
    assertEqual(value.isLightOn.v, 0, 'isLightOn');
    assertEqual(value.block_entities.items.length, 0, 'block entity');
    assert(Buffer.compare(Buffer.from(sec0), Buffer.from(writeNbt(value.sections.items[0]))) === 0, 'sezione 0 toccata');
    assert(value.sections.items[0].SkyLight, 'la luce delle altre sezioni resta');
  });

  test('heightmap ricalcolate dopo aver abbassato e alzato il terreno', () => {
    const { value } = parseRaw(writeNbt(makeChunk(0, 0)), { typed: true });
    const ed = new ChunkEditor(value);
    ed.setState(1, 40, 1, parseState('stone'));   // raise one column to y40
    ed.setState(2, 39, 2, parseState('air'));     // dig one down to y38
    ed.commit();
    const out = unpackIndices(value.Heightmaps.WORLD_SURFACE, heightmapBits(384), 256, true);
    assertEqual(out[1 * 16 + 1], 105, 'colonna alzata (y40 -> 105)');
    assertEqual(out[2 * 16 + 2], 103, 'colonna scavata (y38 -> 103)');
    assertEqual(out[0], 104, 'colonna intatta');
  });

  test('i biomi si ridipingono sulla griglia 4x4x4', () => {
    const { value } = parseRaw(writeNbt(makeChunk(0, 0)), { typed: true });
    const ed = new ChunkEditor(value);
    ed.setBiome(6, 33, 6, 'minecraft:desert');
    ed.commit();
    const re = new ChunkEditor(parseRaw(writeNbt(value), { typed: true }).value);
    assertEqual(re.getBiome(4, 32, 4), 'minecraft:desert', 'stessa cella');
    assertEqual(re.getBiome(7, 35, 7), 'minecraft:desert', 'fine della cella');
    assertEqual(re.getBiome(8, 32, 4), 'minecraft:plains', 'cella accanto');
  });

  test('un mondo troppo vecchio viene rifiutato', () => {
    let msg = '';
    try { new ChunkEditor({ DataVersion: 2000, Level: { Sections: [] } }); } catch (e) { msg = e.message; }
    assert(/1\.18/.test(msg), 'messaggio');
  });

  // -------------------------------------------------------------------------
  section('Cantiere — giornale');

  test('annulla e ripeti spostano le operazioni, una nuova operazione svuota il ripeti', () => {
    const j = new Journal();
    j.push({ type: 'setSpawn', x: 1, y: 2, z: 3 });
    j.push({ type: 'setGameRule', rule: 'keepInventory', value: true });
    j.undo();
    assertEqual(j.size, 1);
    assert(j.canRedo, 'ripeti');
    j.push({ type: 'setSpawn', x: 9, y: 9, z: 9 });
    assert(!j.canRedo, 'il ripeti doveva svuotarsi');
  });

  test('il giornale sopravvive a una scrittura su disco', () => {
    const j = new Journal();
    j.push({ type: 'setSpawn', x: 1, y: 2, z: 3 });
    j.push({ type: 'fillBox', dim: 'overworld', x1: 0, y1: 0, z1: 0, x2: 3, y2: 3, z2: 3, state: 'stone' });
    const back = Journal.fromJSON(JSON.parse(JSON.stringify(j)));
    assertEqual(back.size, 2);
    assertEqual(back.summary().fillBox, 1);
  });

  test('chunkPlan: una scatola a cavallo di due chunk li elenca entrambi, in ordine', () => {
    const j = new Journal();
    j.push({ type: 'fillBox', dim: 'overworld', x1: 14, y1: 0, z1: 0, x2: 17, y2: 3, z2: 3, state: 'stone' });
    const keys = [...j.chunkPlan().get('overworld').keys()];
    assertEqual(keys.join('|'), '0,0|1,0');
  });

  // -------------------------------------------------------------------------
  section('Cantiere — Applica');

  test('Applica scrive una copia e l\'originale resta identico byte per byte', async () => {
    const saves = freshSaves();
    const world = makeWorld(saves);
    const before = hashTree(world);
    const j = new Journal();
    j.push({ type: 'setSpawn', x: 100, y: 70, z: -20 });
    j.push({ type: 'fillBox', dim: 'overworld', x1: 2, y1: 39, z1: 2, x2: 20, y2: 41, z2: 20, state: 'gold_block' });
    const res = await applyJournal({ worldDir: world, journal: j, lockCheck: unlocked });
    assertEqual(res.name, 'Prova (Cantiere)');
    assertEqual(hashTree(world), before, 'l\'originale è cambiato');
    assert(!fs.existsSync(path.join(res.targetDir, INCOMPLETE_MARK)), 'marcatore di incompleto rimasto');
    assertEqual(res.chunks, 4, 'chunk riscritti');

    const level = (await readLevel(res.targetDir)).value.Data;
    assertEqual(level.SpawnX, 100, 'spawn x');
    assertEqual(level.SpawnZ, -20, 'spawn z');
    assertEqual(level.LevelName, 'Prova (Cantiere)', 'nome');
    assertEqual(level.GameRules.randomTickSpeed, '3', 'le altre chiavi restano');
    assertEqual(level.DayTime.toString(), '6000', 'tipi long preservati');

    const region = readRegionFile(path.join(res.targetDir, 'region', 'r.0.0.mca'));
    const ed = new ChunkEditor(region.getChunk(1, 1).value);
    assertEqual(stateKey(ed.getState(20, 40, 20)), 'minecraft:gold_block', 'blocco in un altro chunk');
    assertEqual(stateKey(ed.getState(21, 40, 20)), 'minecraft:air', 'fuori dalla scatola');
    assert(fs.existsSync(path.join(res.targetDir, 'playerdata', 'x.dat')), 'file copiati');
  });

  test('Applica due volte crea (Cantiere) e (Cantiere 2); non sovrascrive senza consenso', async () => {
    const saves = freshSaves();
    const world = makeWorld(saves);
    const j = new Journal();
    j.push({ type: 'setSpawn', x: 1, y: 1, z: 1 });
    const a = await applyJournal({ worldDir: world, journal: j, lockCheck: unlocked });
    const b = await applyJournal({ worldDir: world, journal: j, lockCheck: unlocked });
    assertEqual(b.name, 'Prova (Cantiere 2)');
    assertEqual(uniqueCopyName(saves, 'Prova (Cantiere)'), 'Prova (Cantiere 3)', 'nome da una copia');
    let err = '';
    fs.mkdirSync(path.join(saves, 'Altro'));
    try { await applyJournal({ worldDir: world, journal: j, copyName: 'Altro', lockCheck: unlocked }); } catch (e) { err = e.message; }
    assert(/Esiste già/.test(err), 'doveva rifiutare un mondo che non è una copia');
    // A Cantiere copy may be rewritten when asked.
    await applyJournal({ worldDir: world, journal: j, copyName: a.name, overwrite: true, lockCheck: unlocked });
  });

  test('Minecraft aperto: Applica si ferma senza creare nulla', async () => {
    const saves = freshSaves();
    const world = makeWorld(saves);
    const j = new Journal();
    j.push({ type: 'setSpawn', x: 1, y: 1, z: 1 });
    let err = '';
    try { await applyJournal({ worldDir: world, journal: j, lockCheck: () => true }); } catch (e) { err = e.message; }
    assert(/Minecraft/.test(err), 'messaggio');
    assertEqual(fs.readdirSync(saves).length, 1, 'non doveva nascere nessuna copia');
  });

  test('un mondo troppo vecchio non si applica', async () => {
    const saves = freshSaves();
    const world = makeWorld(saves);
    const level = await readLevel(world);
    level.value.Data.DataVersion = 1343;
    fs.writeFileSync(path.join(world, 'level.dat'), zlib.gzipSync(Buffer.from(writeNbt(level.value, level.name))));
    const j = new Journal();
    j.push({ type: 'setSpawn', x: 1, y: 1, z: 1 });
    const pre = await preflight({ worldDir: world, targetDir: null, journal: j, lockCheck: unlocked });
    assert(!pre.ok && /troppo vecchia/.test(pre.errors[0]), 'preflight');
  });

  test('regole di gioco, ora e meteo passano dal giornale e restano tipizzate', async () => {
    const saves = freshSaves();
    const world = makeWorld(saves);
    const j = new Journal();
    j.push({ type: 'setGameRule', rule: 'keepInventory', value: true });
    j.push({ type: 'setLevelValue', path: ['Data', 'DayTime'], kind: 'long', value: 18000 });
    j.push({ type: 'setLevelValue', path: ['Data', 'raining'], kind: 'byte', value: 1 });
    j.push({ type: 'setLevelValue', path: ['Data', 'rainTime'], kind: 'int', value: 3000 });
    const res = await applyJournal({ worldDir: world, journal: j, lockCheck: unlocked });
    const d = (await readLevel(res.targetDir)).value.Data;
    assertEqual(d.GameRules.keepInventory, 'true');
    assertEqual(d.DayTime.toString(), '18000');
    assert(d.raining instanceof TByte && d.raining.v === 1, 'raining è un Byte');
    assertEqual(d.rainTime, 3000);
  });

  // -------------------------------------------------------------------------
  section('Cantiere — anteprima sulla mappa');

  test('la mappa mostra le modifiche in sospeso senza toccare il disco', async () => {
    const saves = freshSaves();
    const world = makeWorld(saves);
    const before = hashTree(world);
    const base = new NodeSource(world);
    const j = new Journal();
    const overlay = new OverlaySource(base, j);
    const pixel = async (src) => {
      clearRegionCache();
      const { rgba } = await renderBaseTile(src, 'region', 0, 0, {});
      return Array.from(rgba.slice((6 * 256 + 6) * 4, (6 * 256 + 6) * 4 + 3));
    };
    const plain = await pixel(overlay);
    j.push({ type: 'fillBox', dim: 'overworld', x1: 0, y1: 39, z1: 0, x2: 15, y2: 39, z2: 15, state: 'gold_block' });
    const painted = await pixel(overlay);
    assert(plain.join() !== painted.join(), 'il colore doveva cambiare');
    j.undo();
    assertEqual((await pixel(overlay)).join(), plain.join(), 'annullando torna com\'era');
    assertEqual(hashTree(world), before, 'il disco è cambiato');
  });

  // -------------------------------------------------------------------------
  section('Cantiere — sessione di un mondo');

  test('la sessione apre il mondo, serve tile, e lo spawn in sospeso si vede subito', async () => {
    const saves = freshSaves();
    const world = makeWorld(saves);
    const dataDir = path.join(scratch, 'dati');
    const s = await WorldSession.open(world, { dataDir });
    const info = await s.info();
    assertEqual(info.name, 'Prova');
    assertEqual(info.dimensions[0].id, 'overworld');
    assert((await s.tile('overworld', 0, 0, 0)) !== null, 'tile (0,0)');
    assert((await s.tile('overworld', 0, 5, 5)) === null, 'tile vuoto');
    s.push({ type: 'setSpawn', x: 50, y: 60, z: 70 });
    assertEqual((await s.info()).spawn.x, 50, 'spawn in anteprima');
    assertEqual((await readLevel(world)).value.Data.SpawnX, 8, 'il disco no');
  });

  test('mondo 1.21.9+ (spawn.pos invece di SpawnX/Y/Z): lo spawn si legge e si scrive senza NaN', async () => {
    const saves = freshSaves();
    const world = makeWorld(saves, 'Nuovo', { newSpawn: true });
    const s = await WorldSession.open(world, { dataDir: path.join(scratch, 'dati-nuovo') });
    const info = await s.info();
    assertEqual(info.spawn.x, 440, 'spawn x');
    assertEqual(info.spawn.y, 71, 'spawn y');
    assertEqual(info.spawn.z, 1085, 'spawn z');
    s.push({ type: 'setSpawn', x: -5, y: 64, z: 12 });
    const after = (await s.info()).spawn;
    assertEqual(after.x, -5, 'spawn in anteprima x');
    assertEqual(after.z, 12, 'spawn in anteprima z');
    const d = await s.levelPreview();
    assert(!('SpawnX' in d), 'niente SpawnX nel formato nuovo');
  });

  test('il giornale non applicato sopravvive alla chiusura dell\'app', async () => {
    const saves = freshSaves();
    const world = makeWorld(saves);
    const dataDir = path.join(scratch, 'dati2');
    const a = await WorldSession.open(world, { dataDir });
    a.push({ type: 'setSpawn', x: 7, y: 7, z: 7 });
    const b = await WorldSession.open(world, { dataDir });
    assertEqual(b.journal.size, 1, 'giornale ripristinato');
    b.undo();
    assert(!fs.existsSync(b.journalFile), 'giornale vuoto, file rimosso');
  });

  test('la quota di taglio mostra la superficie sotto il piano', async () => {
    const saves = freshSaves();
    const s = await WorldSession.open(makeWorld(saves), { dataDir: path.join(scratch, 'dati3') });
    assertEqual((await s.probe('overworld', 6, 6)).block, 'minecraft:grass_block', 'senza taglio');
    const cut = await s.probe('overworld', 6, 6, 20);
    assertEqual(cut.block, 'minecraft:stone', 'sotto y=20');
    assertEqual(cut.y, 20, 'quota');
    assertEqual(await s.probe('overworld', 6, 6, -10), null, 'sotto il fondo del chunk non c\'è nulla');
  });

  test('lo stesso mondo si applica dalla sessione e il giornale si svuota', async () => {
    const saves = freshSaves();
    const s = await WorldSession.open(makeWorld(saves), { dataDir: path.join(scratch, 'dati4') });
    s.push({ type: 'setSpawn', x: 3, y: 3, z: 3 });
    const pre = await s.check(unlocked);
    assert(pre.ok && pre.copyName === 'Prova (Cantiere)', 'preflight');
    const res = await s.apply({ lockCheck: unlocked });
    assertEqual(res.name, 'Prova (Cantiere)');
    assertEqual(s.journal.size, 0, 'giornale svuotato');
    const worlds = await listWorlds(saves);
    assertEqual(worlds.length, 2, 'due mondi nella cartella saves');
    assert(worlds.some((w) => w.cantiere && w.version === '1.20.1' && !w.readOnly), 'la copia è riconoscibile');
  });

  test('maxY in analyzeChunk non cambia nulla se non è impostato', async () => {
    const saves = freshSaves();
    const s = await WorldSession.open(makeWorld(saves), { dataDir: path.join(scratch, 'dati5') });
    const a = await s.probe('overworld', 2, 2, null);
    const b = await s.probe('overworld', 2, 2, 1000);
    assertEqual(a.block, b.block, 'blocco');
    assertEqual(a.y, b.y, 'quota');
  });

  test('pulizia delle cartelle temporanee dei test', () => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });
}
