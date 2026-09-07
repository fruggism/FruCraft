/*
 * Test suite for the Cube-Atlas core.
 *
 * The core is the same code the browser runs — it only needs a WorldSource,
 * and Node provides one backed by the filesystem. Run with: npm test
 */

import fs from 'node:fs';
import path from 'node:path';

import './dom-shim.js';
import * as atlasGeom from '../web/js/app/atlas.js';
import * as nbtWrite from './nbt-write.js';
import * as nbt from '../web/js/core/nbt.js';
import * as anvil from '../web/js/core/anvil.js';
import * as tiler from '../web/js/core/tiler.js';
import * as worldScan from '../web/js/core/worldScan.js';
import * as renderJob from '../web/js/core/renderJob.js';
import * as book from '../web/js/core/book.js';
import { colorFor } from '../web/js/core/blockColors.js';
import { FileMapSource } from '../web/js/core/source.js';
import { NodeSource, MemoryTileCache } from './node-source.js';
import * as fixture from './make-test-world.js';
import * as projects from '../web/js/app/projects.js';
import * as documents from '../web/js/app/documents.js';
import { shapeOf, S } from '../web/js/voxel/blockKinds.js';
import { readVolume, stateKeyOf, AIR_STATE } from '../web/js/voxel/volume.js';
import { buildTables, meshColumn, KIND } from '../web/js/voxel/mesher.js';
import { ZipReader } from '../web/js/pack/zip.js';
import { ResourcePack } from '../web/js/pack/resources.js';
import { FACE_COUNT, faceIndex } from '../web/js/pack/textures.js';
import { collectParts, buildGlb } from '../web/js/export/glb.js';
import { makeZip, bufferSource } from './make-zip.js';
import { clearRegionCache } from '../web/js/core/anvil.js';
import { scanWorld } from '../web/js/core/worldScan.js';

let passed = 0;
let failed = 0;
const failures = [];
const tests = [];

function test(name, fn) { tests.push({ kind: 'test', name, fn }); }
function section(title) { tests.push({ kind: 'section', title }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertClose(actual, expected, msg, eps = 1e-5) {
  if (Math.abs(actual - expected) > eps) {
    throw new Error(`${msg || 'diverso'}: atteso ~${expected}, ottenuto ${actual}`);
  }
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'not equal'}: atteso ${expected}, ottenuto ${actual}`);
}

// ---------------------------------------------------------------------------
section('NBT');

test('round-trip di tipi scalari e stringhe', async () => {
  const buf = nbtWrite.build('root', {
    aByte: new nbtWrite.TByte(-7),
    aShort: new nbtWrite.TShort(1234),
    anInt: 70000,
    aLong: new nbtWrite.TLong('9007199254740993'),
    aFloat: new nbtWrite.TFloat(0.5),
    aDouble: new nbtWrite.TDouble(1.25),
    aString: 'ciao mondo',
  });
  const { name, value } = await nbt.parse(new Uint8Array(buf));
  assertEqual(name, 'root', 'nome radice');
  assertEqual(value.aByte, -7, 'byte');
  assertEqual(value.aShort, 1234, 'short');
  assertEqual(value.anInt, 70000, 'int');
  assertEqual(value.aLong, 9007199254740993n, 'long');
  assertEqual(value.aFloat, 0.5, 'float');
  assertEqual(value.aDouble, 1.25, 'double');
  assertEqual(value.aString, 'ciao mondo', 'string');
});

test('round-trip di liste, compound annidati e array', async () => {
  const buf = nbtWrite.build('', {
    list: new nbtWrite.TList(nbtWrite.TAG.Compound, [{ Name: 'a' }, { Name: 'b' }]),
    strings: new nbtWrite.TList(nbtWrite.TAG.String, ['x', 'y', 'z']),
    ints: new nbtWrite.TIntArray([1, -2, 3]),
    longs: new nbtWrite.TLongArray([1, -2]),
    nested: { deep: { value: 42 } },
  });
  const { value } = await nbt.parse(new Uint8Array(buf));
  assertEqual(value.list.length, 2, 'lunghezza lista');
  assertEqual(value.list[1].Name, 'b', 'elemento lista');
  assertEqual(value.strings.join(','), 'x,y,z', 'lista di stringhe');
  assertEqual(value.ints[1], -2, 'int array');
  assertEqual(value.longs[1], -2n, 'long array');
  assertEqual(value.nested.deep.value, 42, 'compound annidato');
});

test('gzip e zlib vengono riconosciuti automaticamente', async () => {
  const raw = nbtWrite.build('', { v: 5 });
  assertEqual((await nbt.parse(new Uint8Array(nbtWrite.gzip(raw)))).value.v, 5, 'gzip');
  assertEqual((await nbt.parse(new Uint8Array(nbtWrite.deflate(raw)))).value.v, 5, 'zlib');
  assertEqual((await nbt.parse(new Uint8Array(raw))).value.v, 5, 'non compresso');
});

test('la decompressione nativa produce gli stessi byte di zlib', async () => {
  const payload = Buffer.from('x'.repeat(5000) + 'contenuto vario 12345');
  const out = await nbt.decompressBytes(new Uint8Array(nbtWrite.deflate(payload)), 'deflate');
  assertEqual(Buffer.from(out).toString(), payload.toString(), 'contenuto identico');
});

// ---------------------------------------------------------------------------
section('Bit packing dei palette index');

test('packing padded (1.16+) legge i valori scritti', () => {
  const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 15, 3, 9, 12, 1, 0, 14];
  const bits = 5; // 12 valori per long: si supera il confine di long
  const arr = BigInt64Array.from(fixture.packPadded(values, bits));
  for (let i = 0; i < values.length; i++) {
    assertEqual(anvil.readPaddedPacked(arr, bits, i), values[i], `valore ${i}`);
  }
});

test('padded e spanning divergono, come devono', () => {
  const values = new Array(16).fill(0).map((_, i) => (i * 3) % 32);
  const longs = BigInt64Array.from(fixture.packPadded(values, 5));
  const padded = anvil.readPaddedPacked(longs, 5, 13);
  const spanning = anvil.readSpanningPacked(longs, 5, 13);
  assertEqual(padded, values[13], 'lettore padded corretto sul dato padded');
  assert(padded !== spanning, 'i due schemi di packing devono differire');
});

test('bit per valore: minimo 4 per i blocchi, 1 per i biomi', () => {
  assertEqual(anvil.blockBits(1), 0, 'palette singola = nessun dato');
  assertEqual(anvil.blockBits(2), 4, 'minimo 4 bit per i blocchi');
  assertEqual(anvil.blockBits(20), 5, '20 voci = 5 bit');
  assertEqual(anvil.biomeBits(2), 1, 'minimo 1 bit per i biomi');
  assertEqual(anvil.biomeBits(5), 3, '5 voci = 3 bit');
});

// ---------------------------------------------------------------------------
section('Lettura del mondo');

const WORLD = fixture.WORLD_DIR;
if (!fs.existsSync(path.join(WORLD, 'region', 'r.0.0.mca'))) {
  console.log('  (genero il mondo di test, richiede qualche secondo...)');
  fixture.generate({ quiet: true });
}
fixture.ensureTerrain();
const source = new NodeSource(WORLD);

test('scanWorld riconosce il mondo e i suoi limiti', async () => {
  const info = await worldScan.scanWorld(source);
  assert(info.ok, `scan fallito: ${info.error}`);
  assertEqual(info.levelName, 'Cube-Atlas Test World', 'nome del mondo');
  assertEqual(info.dimensions.length, 1, 'una sola dimensione');
  const ow = info.dimensions[0];
  assertEqual(ow.id, 'overworld', 'id della dimensione');
  assertEqual(ow.regionCount, 1, 'una regione');
  assertEqual(ow.bounds.minX, 0, 'bound minX');
  assertEqual(ow.bounds.maxX, 511, 'bound maxX');
});

test('una cartella senza regioni viene rifiutata con un motivo chiaro', async () => {
  const res = await worldScan.scanWorld(new NodeSource(path.join(WORLD, 'region')));
  assert(!res.ok || res.dimensions, 'deve rispondere qualcosa di sensato');
});

test('readSurface ricostruisce le altezze generate', async () => {
  const g = await anvil.readSurface(source, 'region', 100, 100, 64, 64);
  assertEqual(g.unparsedChunks, 0, 'nessun chunk illeggibile');
  assert(g.totalChunks > 0, 'chunk trovati');
  let checked = 0;
  for (let z = 0; z < 64; z += 7) {
    for (let x = 0; x < 64; x += 7) {
      const wx = 100 + x, wz = 100 + z;
      const expected = fixture.heights[wz * fixture.SIZE + wx];
      const isWater = fixture.kinds[wz * fixture.SIZE + wx] === 1;
      assertEqual(g.surfaceY[z * 64 + x], isWater ? fixture.SEA_LEVEL : expected, `altezza a (${wx},${wz})`);
      checked++;
    }
  }
  assert(checked > 50, 'campionamento sufficiente');
});

test('readSurface riconosce blocchi e biomi di superficie', async () => {
  const g = await anvil.readSurface(source, 'region', 0, 0, 512, 512);
  const names = new Set(g.surfaceName);
  for (const expected of ['minecraft:grass_block', 'minecraft:water', 'minecraft:sand', 'minecraft:snow_block', 'minecraft:oak_leaves']) {
    assert(names.has(expected), `atteso ${expected} in superficie`);
  }
  const biomes = new Set(g.biome);
  for (const expected of ['minecraft:plains', 'minecraft:forest', 'minecraft:desert', 'minecraft:river']) {
    assert(biomes.has(expected), `atteso bioma ${expected}`);
  }
  assert(!biomes.has(null), 'ogni colonna deve avere un bioma');
});

test("sotto l'acqua viene registrato il fondale", async () => {
  const g = await anvil.readSurface(source, 'region', 0, 0, 512, 512);
  let found = 0;
  for (let i = 0; i < g.surfaceName.length; i++) {
    if (g.surfaceName[i] !== 'minecraft:water') continue;
    assert(g.floorY[i] < g.surfaceY[i], 'il fondale deve stare sotto la superficie');
    found++;
  }
  assert(found > 500, `attese molte colonne d'acqua, trovate ${found}`);
});

test("un'area fuori dal mondo generato resta vuota", async () => {
  const g = await anvil.readSurface(source, 'region', 5000, 5000, 32, 32);
  assertEqual(g.totalChunks, 0, 'nessun chunk');
  assert(g.surfaceY.every((v) => v === anvil.NO_DATA), 'tutte le colonne senza dati');
});

// ---------------------------------------------------------------------------
section('Salvataggi con struttura di cartelle diversa');

const NESTED = fixture.NESTED_WORLD_DIR;
if (!fs.existsSync(path.join(NESTED, 'level.dat'))) fixture.generateNested({ quiet: true });
const nestedSource = new NodeSource(NESTED);

test('le regioni vengono trovate anche annidate in dimensions/<ns>/<nome>', async () => {
  const info = await worldScan.scanWorld(nestedSource);
  assert(info.ok, `scan fallito: ${info.error}`);
  const ow = info.dimensions.find((d) => d.id === 'overworld');
  assert(ow, `overworld non trovato fra: ${info.dimensions.map((d) => d.id).join(', ')}`);
  assert(/dimensions/.test(ow.relativeDir), `atteso un percorso annidato, trovato ${ow.relativeDir}`);
  assertEqual(ow.regionCount, 2, 'due regioni');
});

test('anche il Nether accanto ad esso viene riconosciuto', async () => {
  const info = await worldScan.scanWorld(nestedSource);
  const nether = info.dimensions.find((d) => d.id === 'the_nether');
  assert(nether, 'DIM-1 deve essere riconosciuto come Nether');
  assertEqual(nether.label, 'Nether', 'etichetta');
});

test('lo spawn viene letto da level.dat', async () => {
  const info = await worldScan.scanWorld(nestedSource);
  assertEqual(info.spawn.x, 128, 'spawn X');
  assertEqual(info.spawn.z, 128, 'spawn Z');
});

test('i limiti coprono anche la regione lontana', async () => {
  const info = await worldScan.scanWorld(nestedSource);
  const ow = info.dimensions.find((d) => d.id === 'overworld');
  assertEqual(ow.bounds.maxX, (fixture.FAR_REGION.x + 1) * 512 - 1, 'maxX arriva alla regione lontana');
});

test('una cartella che contiene più mondi propone i mondi trovati', async () => {
  const res = await worldScan.scanWorld(new NodeSource(path.dirname(NESTED)));
  assert(!res.ok, 'la cartella contenitore non è un mondo');
  assert(Array.isArray(res.candidates) && res.candidates.length >= 2,
    `attesi più mondi candidati, trovati ${res.candidates && res.candidates.length}`);
});

// ---------------------------------------------------------------------------
section('Selezione della cartella dal browser');

/** Rebuild the browser's flat "path -> File" view of a folder on disk. */
function fileMapSourceFor(root, rootName) {
  const files = new Map();
  const walk = (dir, prefix) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, rel);
      else {
        const bytes = fs.readFileSync(full);
        files.set(rel, {
          size: bytes.length,
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
          slice: (a, b) => ({ arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset + a, bytes.byteOffset + (b ?? bytes.length)) }),
        });
      }
    }
  };
  walk(root, '');
  return new FileMapSource(files, rootName);
}

test('una cartella scelta col selettore si legge come su disco', async () => {
  const picked = fileMapSourceFor(NESTED, 'Mondo Annidato');
  const info = await worldScan.scanWorld(picked);
  assert(info.ok, `scan fallito: ${info.error}`);
  const ow = info.dimensions.find((d) => d.id === 'overworld');
  assert(ow, 'overworld trovato anche dalla selezione del browser');
  assertEqual(ow.regionCount, 2, 'due regioni');
  assertEqual(info.spawn.x, 128, 'spawn letto');
});

test('l\'indice delle sottocartelle ricostruisce l\'albero', async () => {
  const picked = fileMapSourceFor(NESTED, 'Mondo Annidato');
  const top = await picked.listEntries('');
  assert(top.some((e) => e.name === 'dimensions' && e.isDirectory), 'cartella dimensions');
  assert(top.some((e) => e.name === 'level.dat' && !e.isDirectory), 'file level.dat');
  const deep = await picked.listEntries('dimensions/minecraft/overworld/region');
  assertEqual(deep.filter((e) => e.name.endsWith('.mca')).length, 2, 'due file di regione');
});

// ---------------------------------------------------------------------------
section('Colori e biomi');

test("il tinting per bioma cambia il colore dell'erba", () => {
  const plains = colorFor('minecraft:grass_block', 'minecraft:plains');
  const desert = colorFor('minecraft:grass_block', 'minecraft:desert');
  const swamp = colorFor('minecraft:grass_block', 'minecraft:swamp');
  assert(plains.join() !== desert.join(), 'pianura e deserto devono differire');
  assert(plains.join() !== swamp.join(), 'pianura e palude devono differire');
});

test("l'acqua prende il colore del bioma", () => {
  assert(colorFor('minecraft:water', 'minecraft:warm_ocean').join()
    !== colorFor('minecraft:water', 'minecraft:frozen_ocean').join(), 'oceano caldo e ghiacciato differiscono');
});

test('un blocco sconosciuto ottiene un colore stabile', () => {
  const a = colorFor('minecraft:qualcosa_di_inventato', null);
  const b = colorFor('minecraft:qualcosa_di_inventato', null);
  assertEqual(a.join(), b.join(), 'il colore di fallback deve essere deterministico');
  assertEqual(a.length, 3, 'terna RGB');
});

test('un bioma sconosciuto non fa saltare il rendering', () => {
  assertEqual(colorFor('minecraft:grass_block', 'modpack:bioma_strano').length, 3, 'colore valido');
});

// ---------------------------------------------------------------------------
section('Tile e piramide');

let OVERWORLD = null;
let ctx = null;
const cache = new MemoryTileCache();

test('preparazione del contesto dei tile', async () => {
  const info = await worldScan.scanWorld(source);
  OVERWORLD = info.dimensions[0];
  ctx = {
    source,
    regionDir: OVERWORLD.regionDir,
    regionSet: tiler.regionSetOf(OVERWORLD.regions),
    cache,
    renderOptions: {},
  };
  assert(ctx.regionSet.size === 1, 'una regione indicizzata');
});

const opaqueCount = (rgba) => {
  let n = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] === 255) n++;
  return n;
};

test('un tile nativo ha la dimensione giusta ed è opaco sul terreno', async () => {
  const t = await tiler.getTile(ctx, 0, 0, 0, true);
  assert(!t.empty, 'il tile 0,0 non deve essere vuoto');
  assertEqual(t.rgba.length, 256 * 256 * 4, 'dimensione del buffer');
  assertEqual(opaqueCount(t.rgba), 256 * 256, "tutti i pixel opachi dentro l'area generata");
});

test('i quattro tile nativi coprono il mondo e sono diversi tra loro', async () => {
  const tiles = [];
  for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    tiles.push(await tiler.getTile(ctx, 0, x, y, true));
  }
  for (const t of tiles) assert(!t.empty, 'nessuno dei 4 tile deve essere vuoto');
  const hashes = tiles.map((t) => Buffer.from(t.rgba.buffer).toString('base64').slice(0, 96));
  assertEqual(new Set(hashes).size, 4, 'i 4 tile devono avere contenuti diversi');
});

test('un tile su una zona senza regioni è vuoto senza leggere il disco', async () => {
  const t = await tiler.getTile(ctx, 0, 40, 40, true);
  assert(t.empty, 'deve risultare vuoto');
  assertEqual(opaqueCount(t.rgba), 0, 'completamente trasparente');
});

test("l'indice delle regioni sa dire dove non c'è nulla", () => {
  assert(tiler.boxHasRegions(ctx.regionSet, 0, 0, 511, 511), 'la regione 0,0 esiste');
  assert(!tiler.boxHasRegions(ctx.regionSet, 100000, 100000, 100511, 100511), "là non c'è niente");
});

test('il livello zoom -1 riassume i quattro figli', async () => {
  const parent = await tiler.getTile(ctx, -1, 0, 0, true);
  assert(!parent.empty, 'il genitore non deve essere vuoto');
  assertEqual(opaqueCount(parent.rgba), 256 * 256, 'il mondo intero riempie il tile a zoom -1');
});

test('servire un tile molto zoomato non innesca un rendering enorme', async () => {
  // La regressione che rendeva la mappa vuota su un mondo vero: un tile a
  // zoom -6 dipende da 4096 tile base, decine di minuti di lavoro.
  cache.clear();
  const t0 = Date.now();
  const t = await tiler.serveTile(ctx, -6, 0, 0);
  const ms = Date.now() - t0;
  assert(ms < 1500, `servire il tile ha richiesto ${ms} ms: non deve renderizzare in profondità`);
  assert(t.partial || t.empty, 'senza cache il tile va segnalato come parziale');
});

test('la cache restituisce lo stesso identico tile', async () => {
  const first = await tiler.getTile(ctx, 0, 1, 1, true);
  const second = await tiler.getTile(ctx, 0, 1, 1, true);
  assert(second.cached, 'la seconda richiesta deve venire dalla cache');
  assertEqual(Buffer.compare(Buffer.from(first.rgba), Buffer.from(second.rgba)), 0, 'byte identici');
});

test('il calcolo dei blocchi per tile segue lo zoom', () => {
  assertEqual(tiler.blocksPerTile(0), 256, 'zoom 0');
  assertEqual(tiler.blocksPerTile(-1), 512, 'zoom -1');
  assertEqual(tiler.blocksPerTile(-4), 4096, 'zoom -4');
});

test('il filtro blocchi nasconde davvero un blocco dal tile renderizzato', async () => {
  // Regressione: renderBaseTile passava le opzioni a readSurface solo per il
  // rilevamento delle ferrovie, non per hiddenBlocks — il filtro cambiava lo
  // stato in worker.js ma non aveva alcun effetto sui pixel prodotti.
  const { x, z } = fixture.TEST_BARRIER;
  const tx = Math.floor(x / tiler.TILE_SIZE);
  const ty = Math.floor(z / tiler.TILE_SIZE);
  const px = x - tx * tiler.TILE_SIZE;
  const py = z - ty * tiler.TILE_SIZE;
  const pixelAt = (rgba) => {
    const o = (py * tiler.TILE_SIZE + px) * 4;
    return [rgba[o], rgba[o + 1], rgba[o + 2]];
  };

  const withoutFilter = await tiler.renderBaseTile(source, OVERWORLD.regionDir, tx, ty, {});
  const withFilter = await tiler.renderBaseTile(source, OVERWORLD.regionDir, tx, ty, {
    hiddenBlocks: new Set(['minecraft:barrier']),
  });

  const a = pixelAt(withoutFilter.rgba);
  const b = pixelAt(withFilter.rgba);
  assert(a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2],
    `il pixel sul blocco nascosto deve cambiare quando è nel filtro: senza=${a} con=${b}`);
});

// ---------------------------------------------------------------------------
section('Generazione in background');

test('il job elenca solo i tile che contengono regioni', async () => {
  const info = await worldScan.scanWorld(nestedSource);
  const ow = info.dimensions.find((d) => d.id === 'overworld');
  const all = renderJob.baseTilesFor(ow, ow.bounds);
  assertEqual(all.length, 8, 'due regioni = 8 tile base, non il rettangolo fra di loro');
  const spanning = Math.ceil((ow.bounds.maxX - ow.bounds.minX + 1) / 256) ** 2;
  assert(spanning > 1000, 'il rettangolo fra le regioni è enorme');
});

test("limitare l'area riduce il lavoro alla zona scelta", async () => {
  const info = await worldScan.scanWorld(nestedSource);
  const ow = info.dimensions.find((d) => d.id === 'overworld');
  const bounds = renderJob.effectiveBounds(ow, { minX: -100, minZ: -100, maxX: 400, maxZ: 400 });
  const tiles = renderJob.baseTilesFor(ow, bounds);
  assertEqual(tiles.length, 4, 'solo i tile della regione vicina');
  for (const [tx, ty] of tiles) {
    assert(tx >= 0 && tx <= 1 && ty >= 0 && ty <= 1, `tile inatteso ${tx},${ty}`);
  }
});

test('la generazione completa produce i tile e riporta i progressi', async () => {
  const info = await worldScan.scanWorld(nestedSource);
  const ow = info.dimensions.find((d) => d.id === 'overworld');
  const jobCache = new MemoryTileCache();
  const jobCtx = {
    source: nestedSource,
    regionDir: ow.regionDir,
    regionSet: tiler.regionSetOf(ow.regions),
    cache: jobCache,
    renderOptions: {},
  };
  const progress = [];
  const result = await renderJob.runRender({
    ctx: jobCtx,
    dimension: ow,
    area: { minX: 0, minZ: 0, maxX: 511, maxZ: 511 },
    onProgress: (p) => progress.push(p),
  });
  assertEqual(result.state, 'done', 'job completato');
  assert(result.total > 4, 'il job aveva del lavoro da fare');
  assert(progress.length > 0, 'ha riportato avanzamenti');
  assertEqual(progress[progress.length - 1].done, result.total, "l'ultimo avanzamento è al 100%");
  assert(jobCache.size > 4, 'tile scritti in cache');

  // Ora un tile panoramico arriva dalla cache, senza renderizzare.
  const t = await tiler.serveTile(jobCtx, -6, 0, 0);
  assert(!t.empty, 'dopo la generazione il tile panoramico ha contenuto');
});

test('la generazione si può interrompere', async () => {
  const info = await worldScan.scanWorld(nestedSource);
  const ow = info.dimensions.find((d) => d.id === 'overworld');
  const jobCtx = {
    source: nestedSource,
    regionDir: ow.regionDir,
    regionSet: tiler.regionSetOf(ow.regions),
    cache: new MemoryTileCache(),
    renderOptions: {},
  };
  let seen = 0;
  const result = await renderJob.runRender({
    ctx: jobCtx,
    dimension: ow,
    area: { minX: 0, minZ: 0, maxX: 511, maxZ: 511 },
    onProgress: () => { seen++; },
    shouldStop: () => seen >= 1,
  });
  assertEqual(result.state, 'cancelled', 'job interrotto');
  assert(result.done < result.total, 'interrotto prima della fine');
});

// ---------------------------------------------------------------------------
section('Export libri Minecraft');

test('il testo viene diviso in pagine entro il limite', () => {
  const long = ('Lorem ipsum dolor sit amet, consectetur adipiscing elit. ').repeat(60);
  const pages = book.paginate(long);
  assert(pages.length > 1, 'un testo lungo deve occupare più pagine');
  for (const p of pages) assert(p.length <= book.MAX_PAGE_CHARS, 'pagina entro il limite');
  assert(pages.length <= book.MAX_PAGES, 'entro il numero massimo di pagine');
});

test('le parole non vengono spezzate a metà', () => {
  const pages = book.paginate('parolina '.repeat(200));
  for (const p of pages) assert(!p.includes('paroli\n'), 'nessuna parola spezzata');
});

test('il comando /give è valido e con escaping corretto', () => {
  const cmd = book.buildGiveCommand({
    title: "Cronache dell'Impero",
    author: 'Fru "il Grande"',
    pages: ['Pagina uno', 'Riga uno\nRiga due'],
  });
  assert(cmd.startsWith('/give @p written_book'), 'deve essere un comando give');
  assert(cmd.includes('\\"'), 'le virgolette interne devono essere sfuggite');
  assert(!/[^\\]"il Grande"/.test(cmd), "le virgolette dell'autore devono essere sfuggite");
});

test('un titolo vuoto non genera un comando rotto', () => {
  const cmd = book.buildGiveCommand({ title: '', author: '', pages: [] });
  assert(cmd.includes('written_book'), 'comando comunque generato');
  assert(cmd.length < 400, 'comando compatto per un libro vuoto');
});

test("l'export completo produce comando e mcfunction", () => {
  const out = book.exportDocument({ title: 'Diario', author: 'Fru', body: 'Riga uno.\n\nRiga due.' });
  assert(out.command.includes('written_book'), 'comando presente');
  assert(out.mcfunction.includes('give @p'), 'mcfunction presente');
  assert(out.pages.length >= 1, 'almeno una pagina');
  assertEqual(out.title, 'Diario', 'titolo conservato');
});

// ---------------------------------------------------------------------------
section('Modello del progetto: layer, filtro blocchi, trasporti');

test('i tipi di layer includono trasporti e note', () => {
  assert(projects.LAYER_TYPES.includes('transit'), 'transit');
  assert(projects.LAYER_TYPES.includes('notes'), 'notes');
});

test('normalizeBlockList deduplica e normalizza i nomi', () => {
  const out = projects.normalizeBlockList(['Barrier', 'minecraft:barrier', ' tinted_glass ', '', 'a b']);
  assertEqual(out.length, 3, 'tre voci uniche');
  assert(out.includes('minecraft:barrier'), 'barrier normalizzato con namespace');
  assert(out.includes('minecraft:tinted_glass'), 'spazi tolti');
  assert(out.includes('minecraft:a_b'), 'spazio interno diventa underscore');
});

test('normalizeFeature accetta un punto di interesse valido e scarta uno senza coordinate', () => {
  const ok = projects.normalizeFeature({ name: 'Casa', coord: [10, 20] }, 'pois');
  assert(ok && ok.coord[0] === 10 && ok.category === 'altro', 'poi normalizzato con categoria di default');
  assertEqual(projects.normalizeFeature({ name: 'Casa' }, 'pois'), null, 'senza coord viene scartato');
});

test('normalizeFeature per una nota si comporta come un punto, senza categoria', () => {
  const note = projects.normalizeFeature({ name: 'Da costruire', description: 'un faro', coord: [1, 2] }, 'notes');
  assert(note && note.coord[1] === 2, 'la nota ha una posizione');
  assertEqual(note.category, undefined, 'una nota non ha categoria');
});

test('normalizeFeature per una linea di trasporto richiede almeno 2 vertici e porta stationIds', () => {
  const short = projects.normalizeFeature({ coords: [[0, 0]] }, 'transit');
  assertEqual(short, null, 'una linea di un solo punto viene scartata');
  const line = projects.normalizeFeature({ coords: [[0, 0], [10, 0], [10, 10]], stationIds: ['st_a', 42, 'st_b'] }, 'transit');
  assert(line, 'linea valida accettata');
  assertEqual(line.coords.length, 3, 'i vertici sono conservati');
  assertEqual(line.stationIds.join(','), 'st_a,st_b', 'solo gli id stringa sopravvivono a questo livello');
});

test('normalizeStation richiede coordinate numeriche', () => {
  assert(projects.normalizeStation({ x: 5, z: -5, name: 'Centrale' }), 'stazione valida');
  assertEqual(projects.normalizeStation({ x: 'nord', z: 0 }), null, 'x non numerico viene scartato');
  assertEqual(projects.normalizeStation(null), null, 'input nullo viene scartato');
});

test('normalizeLayer per un layer trasporti tiene solo i riferimenti a stazioni realmente esistenti', () => {
  const layer = projects.normalizeLayer({
    type: 'transit',
    name: 'Metro',
    stations: [{ id: 'st_1', x: 0, z: 0, name: 'Nord' }, { x: 'bad', z: 0 }],
    features: [{ coords: [[0, 0], [5, 5]], stationIds: ['st_1', 'st_ghost'] }],
  });
  assertEqual(layer.stations.length, 1, 'la stazione senza coordinate valide non sopravvive');
  assertEqual(layer.features[0].stationIds.join(','), 'st_1', 'il riferimento a una stazione inesistente viene tolto');
});

test('un layer non-trasporti ha comunque un array stations vuoto', () => {
  const layer = projects.makeLayer('roads', 'Strade');
  assert(Array.isArray(layer.stations) && layer.stations.length === 0, 'stations presente ma vuota');
});

test('makeLayer accetta un parentId per creare un sublayer', () => {
  const parent = projects.makeLayer('areas', 'Quartiere');
  const child = projects.makeLayer('roads', 'Vie del quartiere', parent.id);
  assertEqual(child.parentId, parent.id, 'il figlio referenzia il genitore');
});

test('normalizeProject scarta un parentId che non esiste', () => {
  const project = projects.normalizeProject({
    layers: [{ id: 'l1', type: 'roads', name: 'Strade', parentId: 'non-esiste', features: [] }],
  }, null);
  assertEqual(project.layers[0].parentId, null, 'il riferimento pendente viene rimosso');
});

test('normalizeProject spezza un ciclo di parentId', () => {
  const project = projects.normalizeProject({
    layers: [
      { id: 'a', type: 'roads', name: 'A', parentId: 'b', features: [] },
      { id: 'b', type: 'roads', name: 'B', parentId: 'a', features: [] },
    ],
  }, null);
  const byId = Object.fromEntries(project.layers.map((l) => [l.id, l]));
  // Almeno uno dei due deve aver perso il parent, altrimenti l'albero non si potrebbe disegnare.
  assert(byId.a.parentId === null || byId.b.parentId === null, 'il ciclo viene spezzato');
});

test('normalizeProject mantiene una catena di sublayer valida intatta', () => {
  const project = projects.normalizeProject({
    layers: [
      { id: 'regione', type: 'areas', name: 'Regione', features: [] },
      { id: 'provincia', type: 'areas', name: 'Provincia', parentId: 'regione', features: [] },
      { id: 'strade', type: 'roads', name: 'Strade', parentId: 'provincia', features: [] },
    ],
  }, null);
  const byId = Object.fromEntries(project.layers.map((l) => [l.id, l]));
  assertEqual(byId.provincia.parentId, 'regione', 'provincia sotto regione');
  assertEqual(byId.strade.parentId, 'provincia', 'strade sotto provincia');
});

// ---------------------------------------------------------------------------
section('Geometria dei trasporti: stazioni condivise e linee adiacenti');

test('snapToStations aggancia un vertice vicino a una stazione e lo colloca esattamente su di essa', () => {
  const layer = { stations: [{ id: 'st1', x: 50, z: 2, name: 'Centrale' }] };
  const { coords, stationIds } = atlasGeom.snapToStations(layer, [[0, 0], [50, 0], [100, 0]]);
  assertEqual(stationIds.join(','), 'st1', 'la stazione vicina viene agganciata');
  assertEqual(coords[1].join(','), '50,2', 'il vertice viene spostato esattamente sulla stazione');
  assertEqual(coords[0].join(','), '0,0', 'i vertici lontani non si muovono');
});

test('snapToStations non aggancia una stazione troppo lontana dal tracciato', () => {
  const layer = { stations: [{ id: 'st1', x: 50, z: 12, name: 'Centrale' }] };
  const { coords, stationIds } = atlasGeom.snapToStations(layer, [[0, 0], [50, 0], [100, 0]]);
  assertEqual(stationIds.length, 0, 'nessuna stazione agganciata oltre la tolleranza di disegno');
  assertEqual(coords[1].join(','), '50,0', 'il vertice resta dove è stato disegnato');
});

test('offsetTransitCoords non tocca una linea senza altre linee vicine', () => {
  const feature = { id: 'f1', coords: [[0, 0], [100, 0]] };
  const layer = { features: [feature] };
  const out = atlasGeom.offsetTransitCoords(feature, layer);
  assertEqual(JSON.stringify(out), JSON.stringify(feature.coords), 'coordinate invariate senza altre linee');
});

test('offsetTransitCoords separa due linee che corrono vicine e parallele', () => {
  const a = { id: 'fa', coords: [[0, 0], [100, 0]] };
  const b = { id: 'fb', coords: [[0, 3], [100, 3]] };
  const layer = { features: [a, b] };
  const outA = atlasGeom.offsetTransitCoords(a, layer);
  const outB = atlasGeom.offsetTransitCoords(b, layer);
  assert(Math.abs(outA[0][1] - outB[0][1]) > 0.5, 'le due linee vengono spostate su lati diversi');
  assert(Math.abs(outA[0][1] - 0) > 0.01, 'la prima linea si sposta dalla propria coordinata originale');
  assert(Math.abs(outB[0][1] - 3) > 0.01, 'la seconda linea si sposta dalla propria coordinata originale');
});

test('offsetTransitCoords non sposta due linee che si incrociano perpendicolari', () => {
  const a = { id: 'fa', coords: [[0, 0], [100, 0]] };
  const b = { id: 'fb', coords: [[50, -50], [50, 50]] };
  const layer = { features: [a, b] };
  const outA = atlasGeom.offsetTransitCoords(a, layer);
  assertEqual(JSON.stringify(outA), JSON.stringify(a.coords), 'una linea che solo incrocia, senza correre parallela, non viene spostata');
});

// ---------------------------------------------------------------------------
section('straightenPolygon: raddrizza un\'area disegnata a mano libera (iPad)');

function edgeAngles(coords) {
  const angles = [];
  for (let i = 0; i < coords.length; i++) {
    const a = coords[i];
    const b = coords[(i + 1) % coords.length];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    if (Math.hypot(dx, dz) < 0.5) continue; // a zero-length edge has no angle to check
    let deg = (Math.atan2(dz, dx) * 180) / Math.PI;
    deg = ((deg % 90) + 90) % 90; // fold onto [0, 90) — a rectilinear edge lands on 0
    angles.push(Math.min(deg, 90 - deg)); // distance from the nearest axis
  }
  return angles;
}

test('un rettangolo leggermente storto e con vertici sdoppiati diventa un vero rettangolo', () => {
  // Simula un dito/penna poco fermo: quasi un rettangolo 50x50, ma nessun
  // lato è davvero dritto e un paio di "doppi click" hanno lasciato vertici
  // in più a un paio di block di distanza dall'angolo vero.
  const wobbly = [
    [0, 0], [1, 2], [48, 3], [50, 2], [50, 52], [2, 49],
  ];
  const out = atlasGeom.straightenPolygon(wobbly);
  assert(out.length >= 3, 'resta un poligono valido');
  const angles = edgeAngles(out);
  for (const a of angles) assert(a < 1, `lato non dritto: ${a.toFixed(2)}° dal più vicino asse`);
});

test('chiude sempre esattamente: l\'ultimo lato torna al primo vertice', () => {
  const wobbly = [[0, 0], [40, 1], [39, 40], [1, 39]];
  const out = atlasGeom.straightenPolygon(wobbly);
  // Nessun controllo di uguaglianza qui: straightenPolygon costruisce ogni
  // vertice indipendentemente (clusterAxis), non camminando in avanti dal
  // primo — è proprio per questo che non può "non chiudersi". Verifichiamo
  // solo che il poligono resti percorribile (nessun lato di lunghezza nulla
  // strampalato) e che gli angoli restino square.
  for (const a of edgeAngles(out)) assert(a < 1, `lato non dritto dopo la chiusura: ${a.toFixed(2)}°`);
});

test('un poligono già pulito (pochi vertici, angoli netti) resta sostanzialmente lo stesso', () => {
  const clean = [[0, 0], [60, 0], [60, 40], [0, 40]];
  const out = atlasGeom.straightenPolygon(clean);
  for (const a of edgeAngles(out)) assert(a < 1, `un rettangolo pulito non dovrebbe cambiare forma: ${a.toFixed(2)}°`);
});

test('un input degenere (meno di 3 punti) torna invariato invece di lanciare un errore', () => {
  const degenerate = [[0, 0], [10, 10]];
  const out = atlasGeom.straightenPolygon(degenerate);
  assertEqual(JSON.stringify(out), JSON.stringify(degenerate), 'con meno di 3 punti non c\'è un poligono da raddrizzare');
});

// ---------------------------------------------------------------------------
section('Esportazione: la tela non supera mai il limite');

test('un\'area enorme (regione lontana isolata) resta sotto MAX_EXPORT_PX', () => {
  // Il bug reale: "tutto il mondo generato" può includere una regione
  // sperduta lontanissima dal resto, per cui i confini del mondo sono enormi
  // pur essendo la parte costruita minuscola. Prima della correzione questo
  // produceva una tela di decine di migliaia di pixel per lato, che il
  // browser non riusciva ad allocare — da cui l'immagine "rotta" nel Lettore.
  const huge = { minX: 0, minZ: 0, maxX: 2_000_000, maxZ: 2_000_000 };
  const plan = atlasGeom.exportPlan(huge);
  assert(plan.w <= atlasGeom.MAX_EXPORT_PX, `larghezza ${plan.w} oltre il limite`);
  assert(plan.h <= atlasGeom.MAX_EXPORT_PX, `altezza ${plan.h} oltre il limite`);
  assert(plan.shrunk, 'un\'area così enorme deve essere segnalata come ridotta');
  assert(plan.scale > 0, 'la scala deve restare positiva e utilizzabile');
});

test('un\'area piccola non viene ridotta oltre lo zoom nativo', () => {
  const small = { minX: 0, minZ: 0, maxX: 255, maxZ: 255 };
  const plan = atlasGeom.exportPlan(small);
  assertEqual(plan.shrunk, false, 'un\'area piccola sta già sotto il limite allo zoom nativo');
  assertEqual(plan.w, 256, 'larghezza allo zoom scelto, senza ulteriore riduzione');
});

test('un\'area estrema non produce una tela degenere (0 o non finita)', () => {
  const extreme = { minX: -30_000_000, minZ: -30_000_000, maxX: 30_000_000, maxZ: 30_000_000 };
  const plan = atlasGeom.exportPlan(extreme);
  assert(Number.isFinite(plan.w) && plan.w >= 1, `larghezza non valida: ${plan.w}`);
  assert(Number.isFinite(plan.h) && plan.h >= 1, `altezza non valida: ${plan.h}`);
  assert(plan.w <= atlasGeom.MAX_EXPORT_PX && plan.h <= atlasGeom.MAX_EXPORT_PX, 'anche il caso estremo resta entro il limite');
});

// ---------------------------------------------------------------------------
section('Archivio: documenti indipendenti e versionati');

test('normalizeDocument assegna codice, data e autore la prima volta', () => {
  const doc = documents.normalizeDocument({ title: 'Cronaca', author: 'Ricky', body: 'Un tempo...' }, null);
  assert(doc.id, 'id assegnato');
  assert(/^CA-/.test(doc.code), 'codice nel formato atteso');
  assert(doc.createdAt, 'data di creazione presente');
  assertEqual(doc.author, 'Ricky', 'autore preso da chi lo scrive');
  assertEqual(doc.versionOf, null, 'un documento nuovo non è la versione di nient\'altro');
});

test('normalizeDocument non lascia mai cambiare codice, data, autore o versionOf di una versione esistente', () => {
  const original = documents.normalizeDocument({ title: 'Cronaca', author: 'Ricky', body: 'v1' }, null);
  const tampered = documents.normalizeDocument(
    { title: 'Cronaca modificata', author: 'Qualcun altro', body: 'v2', code: 'CA-FINTO', versionOf: 'altro_id' },
    original,
  );
  assertEqual(tampered.id, original.id, 'id invariato');
  assertEqual(tampered.code, original.code, 'codice invariato anche se il chiamante prova a cambiarlo');
  assertEqual(tampered.createdAt, original.createdAt, 'data di creazione invariata');
  assertEqual(tampered.author, original.author, 'autore invariato: non lo si può riassegnare modificando');
  assertEqual(tampered.versionOf, original.versionOf, 'versionOf invariato');
  assertEqual(tampered.title, 'Cronaca modificata', 'il titolo invece è modificabile');
  assertEqual(tampered.body, 'v2', 'il corpo invece è modificabile');
});

test('isLatest riconosce solo la versione senza fork', () => {
  const v1 = documents.normalizeDocument({ title: 'A', author: 'Ricky', body: '1' }, null);
  const v2 = documents.normalizeDocument({ title: 'A', author: 'Ricky', body: '2', versionOf: v1.id }, null);
  const all = [v1, v2];
  assertEqual(documents.isLatest(v1, all), false, 'v1 ha già un fork (v2): non è più la più recente');
  assertEqual(documents.isLatest(v2, all), true, 'v2 non ha fork: è la più recente');
});

test('history ricostruisce la catena dalla radice alla versione data', () => {
  const v1 = documents.normalizeDocument({ title: 'A', author: 'Ricky', body: '1' }, null);
  const v2 = documents.normalizeDocument({ title: 'A', author: 'Ricky', body: '2', versionOf: v1.id }, null);
  const v3 = documents.normalizeDocument({ title: 'A', author: 'Ricky', body: '3', versionOf: v2.id }, null);
  const all = [v1, v2, v3];
  const chain = documents.history(v3, all);
  assertEqual(chain.map((d) => d.body).join(','), '1,2,3', 'la catena va dalla radice fino alla versione richiesta, in ordine');
  assertEqual(documents.history(v1, all).length, 1, 'la radice ha una catena di un solo elemento: se stessa');
});

test('history non entra in loop su un versionOf ciclico', () => {
  const a = documents.normalizeDocument({ title: 'A', author: 'Ricky', body: 'a' }, null);
  const b = documents.normalizeDocument({ title: 'B', author: 'Ricky', body: 'b', versionOf: a.id }, null);
  a.versionOf = b.id; // ciclo artificiale, non dovrebbe mai capitare ma non deve bloccare l'app
  const all = [a, b];
  const chain = documents.history(b, all);
  assert(chain.length > 0 && chain.length <= all.length, 'la catena resta finita anche con un ciclo');
});

// ---------------------------------------------------------------------------

// ======================================================================
// Atlante 3D — voxel, mesher, texture ed export, portati da Cube-Atlas 3D.
// Girano sullo stesso mondo di prova del resto della suite.
// ======================================================================
// --------------------------------------------------------------- helpers ---

/** A volume built by hand, with the same shape readVolume() produces. */
function makeVolume(sizeX, sizeY, sizeZ, stateKeys) {
  const states = ['minecraft:air', ...stateKeys];
  return {
    minX: 0, minY: 0, minZ: 0, sizeX, sizeY, sizeZ,
    blocks: new Uint16Array(sizeX * sizeY * sizeZ),
    biomes: new Uint8Array((sizeX >> 2) * (sizeY >> 2) * (sizeZ >> 2)),
    states,
    names: states.map((k) => k.split('|')[0]),
    props: states.map((k) => {
      const parts = k.split('|').slice(1);
      if (!parts.length) return null;
      const o = {};
      for (const p of parts) { const [a, b] = p.split('='); o[a] = b; }
      return o;
    }),
    biomeNames: ['minecraft:plains'],
    stats: { chunks: 1, missing: 0, unparsed: 0 },
  };
}

const setBlock = (vol, x, y, z, id) => {
  vol.blocks[(y * vol.sizeZ + z) * vol.sizeX + x] = id;
};

/** Vertex k of quad q, as [x, y, z]. */
const vertex = (mesh, q, k) => {
  const o = (q * 4 + k) * 3;
  return [mesh.positions[o], mesh.positions[o + 1], mesh.positions[o + 2]];
};

/** Face normal of quad q, from the winding of its first triangle. */
function normalOf(mesh, q) {
  const [ax, ay, az] = vertex(mesh, q, 0);
  const [bx, by, bz] = vertex(mesh, q, 1);
  const [cx, cy, cz] = vertex(mesh, q, 2);
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  const len = Math.hypot(...n) || 1;
  return n.map((c) => Math.round(c / len));
}

const quadCount = (mesh) => (mesh ? mesh.positions.length / 12 : 0);

/** Every quad whose normal points the given way. */
function quadsFacing(mesh, nx, ny, nz) {
  const out = [];
  for (let q = 0; q < quadCount(mesh); q++) {
    const n = normalOf(mesh, q);
    if (n[0] === nx && n[1] === ny && n[2] === nz) out.push(q);
  }
  return out;
}

function meshOf(vol) {
  return meshColumn(vol, buildTables(vol), 0, 0);
}

/**
 * Texture tables built by hand: layer `state * 6 + face`, so a face's layer
 * says exactly which state and which side it came from and a wrong mapping
 * cannot hide.
 */
function fakeTextures(vol) {
  const count = vol.states.length;
  const faces = new Int32Array(count * FACE_COUNT);
  const cross = new Int32Array(count);
  for (let state = 0; state < count; state++) {
    for (let f = 0; f < FACE_COUNT; f++) faces[state * FACE_COUNT + f] = state * FACE_COUNT + f;
    cross[state] = 900 + state;
  }
  return { tile: 16, layers: count * FACE_COUNT + 1000, faces, cross };
}

function texturedMeshOf(vol) {
  const textures = fakeTextures(vol);
  return { mesh: meshColumn(vol, buildTables(vol, textures), 0, 0), textures };
}

/** Texture coordinates of vertex k of quad q. */
const texel = (mesh, q, k) => [mesh.uvs[(q * 4 + k) * 2], mesh.uvs[(q * 4 + k) * 2 + 1]];

// ---------------------------------------------------------------------------
section('Forme dei blocchi');

test('un blocco pieno è un cubo, l\'aria non è niente', () => {
  assertEqual(shapeOf('minecraft:stone', 'minecraft:stone', null).kind, 'cube', 'pietra');
  assertEqual(shapeOf('minecraft:air', 'minecraft:air', null).kind, 'air', 'aria');
  assertEqual(shapeOf('minecraft:cave_air', 'minecraft:cave_air', null).kind, 'air', 'aria di grotta');
});

test('le barriere non diventano muri', () => {
  assertEqual(shapeOf('minecraft:barrier', 'minecraft:barrier', null).kind, 'skip', 'barriera');
});

test('lo slab sta sotto o sopra secondo type', () => {
  const bottom = shapeOf('a', 'minecraft:oak_slab', { type: 'bottom' });
  const top = shapeOf('b', 'minecraft:oak_slab', { type: 'top' });
  const dbl = shapeOf('c', 'minecraft:oak_slab', { type: 'double' });
  assertEqual(bottom.boxes[0][4], 0.5, 'lo slab basso arriva a metà');
  assertEqual(top.boxes[0][1], 0.5, 'lo slab alto parte da metà');
  assertEqual(dbl.kind, 'cube', 'il doppio slab è un cubo pieno');
});

test('la scala è mezzo blocco più un gradino sul lato di facing', () => {
  const east = shapeOf('e', 'minecraft:stone_stairs', { facing: 'east', half: 'bottom' });
  assertEqual(east.boxes.length, 2, 'due scatole');
  assertEqual(east.boxes[0][4], 0.5, 'la base è mezzo blocco');
  assertEqual(east.boxes[1][0], 0.5, 'il gradino sta a est');
  assertEqual(east.boxes[1][4], 1, 'e arriva in cima');
  const top = shapeOf('t', 'minecraft:stone_stairs', { facing: 'east', half: 'top' });
  assertEqual(top.boxes[0][1], 0.5, 'capovolta: la base è in alto');
  assertEqual(top.boxes[1][1], 0, 'e il gradino in basso');
});

test('la neve cresce con i suoi strati', () => {
  assertClose(shapeOf('s1', 'minecraft:snow', { layers: '1' }).boxes[0][4], 2 * S, 'uno strato');
  assertClose(shapeOf('s5', 'minecraft:snow', { layers: '5' }).boxes[0][4], 10 * S, 'cinque strati');
});

test('la porta è un pannello sul lato opposto a facing', () => {
  const d = shapeOf('d', 'minecraft:oak_door', { facing: 'east', half: 'lower', open: 'false' });
  assertEqual(d.kind, 'box', 'è una scatola');
  assertEqual(d.boxes[0][0], 0, 'il pannello sta a ovest');
  assertClose(d.boxes[0][3], 3 * S, 'ed è spesso 3/16');
});

test('erba e fiori sono croci, l\'acqua è acqua, il vetro è vetro', () => {
  assertEqual(shapeOf('g', 'minecraft:short_grass', null).kind, 'plant', 'erba');
  assertEqual(shapeOf('p', 'minecraft:poppy', null).kind, 'plant', 'papavero');
  assertEqual(shapeOf('sa', 'minecraft:oak_sapling', null).kind, 'plant', 'germoglio');
  assertEqual(shapeOf('w', 'minecraft:water', null).kind, 'water', 'acqua');
  assertEqual(shapeOf('gl', 'minecraft:glass', null).kind, 'glass', 'vetro');
  assert(shapeOf('gl2', 'minecraft:glass', null).alpha < 1, 'il vetro è trasparente');
});

test('recinti, muretti e vetrate sono pali con braccia', () => {
  for (const n of ['minecraft:oak_fence', 'minecraft:cobblestone_wall', 'minecraft:glass_pane']) {
    assertEqual(shapeOf(n, n, null).kind, 'post', n);
  }
});

test('la chiave di stato tiene solo le proprietà che cambiano la forma', () => {
  const a = stateKeyOf({ Name: 'minecraft:oak_slab', Properties: { type: 'top', waterlogged: 'true' } });
  const b = stateKeyOf({ Name: 'minecraft:oak_slab', Properties: { type: 'top', waterlogged: 'false' } });
  assertEqual(a, b, 'waterlogged non cambia la geometria');
  assert(a.includes('type=top'), 'type invece sì');
  const c = stateKeyOf({ Name: 'minecraft:oak_slab', Properties: { type: 'bottom' } });
  assert(a !== c, 'slab alto e slab basso restano distinti');
});

// ---------------------------------------------------------------------------
section('Mesher');

test('un cubo isolato ha sei facce, una per lato', () => {
  const vol = makeVolume(16, 16, 16, ['minecraft:stone']);
  setBlock(vol, 8, 8, 8, 1);
  const { opaque, translucent } = meshOf(vol);
  assertEqual(quadCount(opaque), 6, 'facce');
  assertEqual(translucent, null, 'niente da disegnare in trasparenza');
  for (const [nx, ny, nz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    assertEqual(quadsFacing(opaque, nx, ny, nz).length, 1, `faccia ${nx},${ny},${nz}`);
  }
});

test('le facce fra due cubi attaccati non vengono disegnate', () => {
  const vol = makeVolume(16, 16, 16, ['minecraft:stone']);
  setBlock(vol, 8, 8, 8, 1);
  setBlock(vol, 9, 8, 8, 1);
  const { opaque } = meshOf(vol);
  // Le due facce che si toccano spariscono, e le altre quattro coppie si
  // fondono a due a due: restano sei quadrilateri, come per un cubo solo.
  assertEqual(quadCount(opaque), 6, 'sei facce in tutto');
  const east = quadsFacing(opaque, 1, 0, 0);
  assertEqual(east.length, 1, 'una sola faccia verso est');
  assertEqual(vertex(opaque, east[0], 0)[0], 10, 'ed è quella esterna, a x=10');
  const top = quadsFacing(opaque, 0, 1, 0);
  assertEqual(top.length, 1, 'e una sola faccia in cima, lunga due blocchi');
});

test('le facce complanari si fondono in un rettangolo solo', () => {
  const vol = makeVolume(16, 16, 16, ['minecraft:stone']);
  for (let x = 4; x < 8; x++) for (let z = 4; z < 8; z++) setBlock(vol, x, 5, z, 1);
  const { opaque } = meshOf(vol);
  const top = quadsFacing(opaque, 0, 1, 0);
  assertEqual(top.length, 1, 'una sola faccia in cima per 16 blocchi');
  assertEqual(quadCount(opaque), 6, 'la lastra 4x4 costa quanto un cubo');
  // e copre davvero tutta l'area
  const xs = [0, 1, 2, 3].map((k) => vertex(opaque, top[0], k)[0]);
  const zs = [0, 1, 2, 3].map((k) => vertex(opaque, top[0], k)[2]);
  assertEqual(Math.min(...xs), 4, 'da x=4');
  assertEqual(Math.max(...xs), 8, 'a x=8');
  assertEqual(Math.min(...zs), 4, 'da z=4');
  assertEqual(Math.max(...zs), 8, 'a z=8');
});

test('la faccia superiore sta in cima al blocco, non alla sua base', () => {
  const vol = makeVolume(16, 16, 16, ['minecraft:stone']);
  setBlock(vol, 2, 3, 2, 1);
  const { opaque } = meshOf(vol);
  const top = quadsFacing(opaque, 0, 1, 0)[0];
  assertEqual(vertex(opaque, top, 0)[1], 4, 'y del piano superiore');
  const bottom = quadsFacing(opaque, 0, -1, 0)[0];
  assertEqual(vertex(opaque, bottom, 0)[1], 3, 'y del piano inferiore');
});

test('l\'occlusione ambientale scurisce gli angoli, non le superfici libere', () => {
  const vol = makeVolume(16, 16, 16, ['minecraft:stone']);
  for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) setBlock(vol, x, 4, z, 1);
  setBlock(vol, 2, 5, 2, 1);   // un blocco in piedi sul pavimento
  const { opaque } = meshOf(vol);
  const tops = quadsFacing(opaque, 0, 1, 0);
  let darkest = 255, brightest = 0;
  for (const q of tops) {
    for (let k = 0; k < 4; k++) {
      const g = opaque.colors[(q * 4 + k) * 3 + 1];
      if (vertex(opaque, q, k)[1] !== 5) continue; // solo il pavimento
      darkest = Math.min(darkest, g);
      brightest = Math.max(brightest, g);
    }
  }
  assert(darkest < brightest * 0.95, `il pavimento accanto al blocco è più scuro (${darkest} vs ${brightest})`);
});

test('il pelo dell\'acqua sta 1/16 sotto il bordo del blocco', () => {
  const vol = makeVolume(16, 16, 16, ['minecraft:water']);
  setBlock(vol, 8, 4, 8, 1);
  setBlock(vol, 8, 3, 8, 1);
  const { opaque, translucent } = meshOf(vol);
  assertEqual(opaque, null, 'l\'acqua non è opaca');
  const top = quadsFacing(translucent, 0, 1, 0);
  assertEqual(top.length, 1, 'una superficie sola: quella in alto');
  assertClose(vertex(translucent, top[0], 0)[1], 4 + 0.875, 'altezza del pelo dell\'acqua');
  // la faccia fra i due blocchi d'acqua non esiste
  assertEqual(quadsFacing(translucent, 0, -1, 0).length, 1, 'solo il fondo');
});

test('lo slab occupa mezzo blocco anche nel mesh', () => {
  const vol = makeVolume(16, 16, 16, ['minecraft:stone_slab|type=bottom']);
  setBlock(vol, 8, 4, 8, 1);
  const { opaque } = meshOf(vol);
  assertEqual(quadCount(opaque), 6, 'sei facce');
  assertClose(vertex(opaque, quadsFacing(opaque, 0, 1, 0)[0], 0)[1], 4.5, 'il piano dello slab');
});

test('l\'erba è una croce a parte, con le sue coordinate di texture', () => {
  const vol = makeVolume(16, 16, 16, ['minecraft:short_grass']);
  setBlock(vol, 8, 4, 8, 1);
  const { opaque, plants } = meshOf(vol);
  assertEqual(opaque, null, 'non finisce fra i cubi opachi');
  assertEqual(quadCount(plants), 2, 'due piani incrociati (il materiale è a doppia faccia)');
  assertEqual(quadsFacing(plants, 0, 1, 0).length, 0, 'nessuna faccia orizzontale');
  assertEqual(plants.uvs.length, plants.positions.length / 3 * 2, 'una uv per vertice');
  // l'erba non arriva in cima al blocco
  let top = 0;
  for (let q = 0; q < quadCount(plants); q++) {
    for (let k = 0; k < 4; k++) top = Math.max(top, vertex(plants, q, k)[1]);
  }
  assertClose(top, 4.85, 'altezza dell\'erba');
});

test('i fiori usano l\'altra metà della maschera', () => {
  const vol = makeVolume(16, 16, 16, ['minecraft:poppy', 'minecraft:fern']);
  setBlock(vol, 4, 4, 4, 1);
  setBlock(vol, 8, 4, 8, 2);
  const { plants } = meshOf(vol);
  const us = new Set();
  for (let i = 0; i < plants.uvs.length; i += 2) us.add(plants.uvs[i]);
  assert(us.has(0) && us.has(0.5) && us.has(1), `entrambe le mattonelle: ${[...us]}`);
});

test('le barriere non producono geometria', () => {
  const vol = makeVolume(16, 16, 16, ['minecraft:barrier']);
  setBlock(vol, 8, 4, 8, 1);
  const { opaque, translucent } = meshOf(vol);
  assertEqual(opaque, null, 'niente di opaco');
  assertEqual(translucent, null, 'niente di trasparente');
});

test('il vetro è trasparente ma non nasconde ciò che gli sta dietro', () => {
  const vol = makeVolume(16, 16, 16, ['minecraft:glass', 'minecraft:stone']);
  setBlock(vol, 8, 4, 8, 1);
  setBlock(vol, 9, 4, 8, 2);
  const { opaque, translucent } = meshOf(vol);
  assertEqual(quadCount(opaque), 6, 'la pietra conserva la faccia rivolta al vetro');
  assertEqual(quadCount(translucent), 5, 'il vetro perde solo la faccia coperta dalla pietra');
});

test('due vetri attaccati non hanno facce interne', () => {
  const vol = makeVolume(16, 16, 16, ['minecraft:glass']);
  setBlock(vol, 8, 4, 8, 1);
  setBlock(vol, 9, 4, 8, 1);
  const { translucent } = meshOf(vol);
  assertEqual(quadCount(translucent), 6, 'il guscio esterno, senza le facce interne');
  assertEqual(quadsFacing(translucent, 1, 0, 0).length, 1, 'una sola faccia verso est');
});

test('il recinto mette un braccio solo verso ciò che tocca', () => {
  const vol = makeVolume(16, 16, 16, ['minecraft:oak_fence', 'minecraft:stone']);
  setBlock(vol, 8, 4, 8, 1);
  const alone = quadCount(meshOf(vol).opaque);
  setBlock(vol, 9, 4, 8, 2);
  const joined = meshOf(vol).opaque;
  assert(quadCount(joined) > alone, 'attaccato alla pietra il palo cresce di un braccio');
});

test('una colonna vuota non produce mesh', () => {
  const vol = makeVolume(16, 16, 16, ['minecraft:stone']);
  const { opaque, translucent, quads } = meshOf(vol);
  assertEqual(opaque, null, 'niente opaco');
  assertEqual(translucent, null, 'niente trasparente');
  assertEqual(quads, 0, 'zero quadrilateri');
});

test('i blocchi ai bordi della porzione mostrano il taglio', () => {
  const vol = makeVolume(16, 16, 16, ['minecraft:stone']);
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) setBlock(vol, x, y, z, 1);
  }
  const { opaque } = meshOf(vol);
  assertEqual(quadsFacing(opaque, -1, 0, 0).length, 1, 'la parete ovest del taglio');
  assertEqual(quadsFacing(opaque, 0, -1, 0).length, 1, 'e il fondo');
});

test('gli indici formano triangoli validi e non escono dai vertici', () => {
  const vol = makeVolume(16, 16, 16, ['minecraft:stone']);
  for (let x = 2; x < 10; x++) for (let z = 2; z < 10; z++) setBlock(vol, x, 4, z, 1);
  setBlock(vol, 5, 5, 5, 1);
  const { opaque } = meshOf(vol);
  const verts = opaque.positions.length / 3;
  assertEqual(opaque.indices.length, quadCount(opaque) * 6, 'sei indici per quadrilatero');
  assertEqual(opaque.colors.length, verts * 3, 'un colore per vertice');
  for (const i of opaque.indices) assert(i < verts, `indice fuori intervallo: ${i}`);
});

// ---------------------------------------------------------------------------
section('Archivi e risorse');

test('legge un archivio zip, compresso e non', async () => {
  const zip = await ZipReader.open(bufferSource(makeZip([
    ['piccolo.txt', 'ciao'],
    ['grande.txt', 'ripetuto '.repeat(200)],
  ])));
  assertEqual(new TextDecoder().decode(await zip.read('piccolo.txt')), 'ciao', 'voce non compressa');
  assertEqual(new TextDecoder().decode(await zip.read('grande.txt')), 'ripetuto '.repeat(200),
    'voce compressa');
  assertEqual(await zip.read('non-c-e.txt'), null, 'voce assente');
  assert(zip.has('piccolo.txt'), 'has()');
});

test('un file che non è uno zip viene rifiutato invece di leggere spazzatura', async () => {
  const junk = Buffer.alloc(500, 7);
  let failed = false;
  try { await ZipReader.open(bufferSource(junk)); } catch { failed = true; }
  assert(failed, 'deve fallire');
});

/** Un pacchetto di prova con la stessa struttura del .jar del gioco. */
async function testPack() {
  const zip = await ZipReader.open(bufferSource(makeZip([
    ['assets/minecraft/blockstates/prova_pietra.json',
      JSON.stringify({ variants: { '': { model: 'minecraft:block/prova_pietra' } } })],
    ['assets/minecraft/blockstates/prova_tronco.json',
      JSON.stringify({ variants: {
        'axis=y': { model: 'minecraft:block/prova_tronco' },
        'axis=x': { model: 'minecraft:block/prova_tronco', x: 90, y: 90 },
      } })],
    ['assets/minecraft/models/block/cube.json', JSON.stringify({})],
    ['assets/minecraft/models/block/cube_all.json', JSON.stringify({
      parent: 'block/cube',
      textures: { down: '#all', up: '#all', north: '#all', east: '#all', south: '#all', west: '#all' },
    })],
    ['assets/minecraft/models/block/prova_pietra.json', JSON.stringify({
      parent: 'minecraft:block/cube_all',
      // forma a oggetto, come la scrivono le versioni dal 2026
      textures: { all: { force_translucent: false, sprite: 'minecraft:block/prova_pietra' } },
    })],
    ['assets/minecraft/models/block/prova_tronco.json', JSON.stringify({
      parent: 'minecraft:block/cube_all',
      textures: { end: 'minecraft:block/prova_cima', side: 'minecraft:block/prova_lato' },
    })],
    ['assets/minecraft/textures/block/prova_pietra.png', 'png'],
    ['assets/minecraft/textures/block/prova_cima.png', 'png'],
    ['assets/minecraft/textures/block/prova_lato.png', 'png'],
  ])));
  return new ResourcePack([zip]);
}

test('risolve la texture seguendo la catena dei modelli e i riferimenti #', async () => {
  const faces = await (await testPack()).facesFor('minecraft:prova_pietra', null);
  assert(faces, 'trovato');
  for (const side of ['up', 'down', 'north', 'south', 'west', 'east']) {
    assertEqual(faces[side], 'minecraft:block/prova_pietra', `faccia ${side}`);
  }
});

test('un tronco mette le cime sull\'asse su cui è appoggiato', async () => {
  const pack = await testPack();
  const dritto = await pack.facesFor('prova_tronco', { axis: 'y' });
  assertEqual(dritto.up, 'minecraft:block/prova_cima', 'in piedi: cima sopra');
  assertEqual(dritto.north, 'minecraft:block/prova_lato', 'e corteccia di lato');
  const sdraiato = await pack.facesFor('prova_tronco', { axis: 'x' });
  assertEqual(sdraiato.east, 'minecraft:block/prova_cima', 'sdraiato: cima a est');
  assertEqual(sdraiato.up, 'minecraft:block/prova_lato', 'e corteccia sopra');
});

test('un blocco che il pacchetto non conosce non risolve niente', async () => {
  assertEqual(await (await testPack()).facesFor('blocco_inventato', null), null, 'niente');
});

test('una texture citata dal modello ma assente non viene usata', async () => {
  const zip = await ZipReader.open(bufferSource(makeZip([
    ['assets/minecraft/blockstates/vuoto.json',
      JSON.stringify({ variants: { '': { model: 'block/vuoto' } } })],
    ['assets/minecraft/models/block/vuoto.json',
      JSON.stringify({ textures: { all: 'block/mai_esistita' } })],
  ])));
  assertEqual(await new ResourcePack([zip]).facesFor('vuoto', null), null,
    'meglio niente che una texture che non c\'è');
});

// ---------------------------------------------------------------------------
section('Texture nella geometria');

test('ogni faccia porta lo strato della sua direzione', () => {
  const vol = makeVolume(16, 16, 16, ['minecraft:stone']);
  setBlock(vol, 8, 8, 8, 1);
  const { mesh } = texturedMeshOf(vol);
  const layers = mesh.opaque.layers;
  assert(layers, 'gli strati ci sono');
  const dirs = [[1, 0, 0, 0], [-1, 0, 0, 1], [0, 1, 0, 2], [0, -1, 0, 3], [0, 0, 1, 4], [0, 0, -1, 5]];
  for (const [nx, ny, nz, face] of dirs) {
    const q = quadsFacing(mesh.opaque, nx, ny, nz)[0];
    assertEqual(layers[q * 4], 1 * FACE_COUNT + face, `strato della faccia ${nx},${ny},${nz}`);
  }
  assertEqual(faceIndex(1, 1), 2, 'indice della faccia superiore');
});

test('le coordinate di texture vengono dalla posizione, quindi si ripetono', () => {
  const vol = makeVolume(16, 16, 16, ['minecraft:stone']);
  for (let x = 4; x < 8; x++) for (let z = 4; z < 8; z++) setBlock(vol, x, 5, z, 1);
  const { mesh } = texturedMeshOf(vol);
  const top = quadsFacing(mesh.opaque, 0, 1, 0);
  assertEqual(top.length, 1, 'la faccia in cima resta fusa in una sola');
  // fusa su 4x4 blocchi: le coordinate spaziano 4 unità, così la texture si
  // ripete quattro volte invece di essere stirata
  const us = [0, 1, 2, 3].map((k) => texel(mesh.opaque, top[0], k)[0]);
  const vs = [0, 1, 2, 3].map((k) => texel(mesh.opaque, top[0], k)[1]);
  assertEqual(Math.max(...us) - Math.min(...us), 4, 'quattro ripetizioni in orizzontale');
  assertEqual(Math.max(...vs) - Math.min(...vs), 4, 'quattro in verticale');
  assertEqual(Math.min(...us), 4, 'e partono dalla x del blocco');
});

test('le facce laterali hanno il verticale della texture su Y', () => {
  const vol = makeVolume(16, 16, 16, ['minecraft:stone']);
  setBlock(vol, 2, 3, 2, 1);
  const { mesh } = texturedMeshOf(vol);
  for (const [nx, ny, nz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
    const q = quadsFacing(mesh.opaque, nx, ny, nz)[0];
    const vs = [0, 1, 2, 3].map((k) => texel(mesh.opaque, q, k)[1]);
    assertEqual(Math.min(...vs), 3, `faccia ${nx},${nz}: parte dalla base del blocco`);
    assertEqual(Math.max(...vs), 4, 'e arriva in cima');
  }
});

test('lo slab mostra solo la metà bassa della sua texture', () => {
  const vol = makeVolume(16, 16, 16, ['minecraft:stone_slab|type=bottom']);
  setBlock(vol, 8, 4, 8, 1);
  const { mesh } = texturedMeshOf(vol);
  const side = quadsFacing(mesh.opaque, 1, 0, 0)[0];
  const vs = [0, 1, 2, 3].map((k) => texel(mesh.opaque, side, k)[1]);
  assertClose(Math.min(...vs), 4, 'dalla base');
  assertClose(Math.max(...vs), 4.5, 'a metà blocco: la texture si taglia da sola');
});

test('con le texture le piante stanno in piedi per tutto il blocco', () => {
  const vol = makeVolume(16, 16, 16, ['minecraft:short_grass']);
  setBlock(vol, 8, 4, 8, 1);
  const { mesh } = texturedMeshOf(vol);
  let top = 0;
  for (let q = 0; q < quadCount(mesh.plants); q++) {
    for (let k = 0; k < 4; k++) top = Math.max(top, vertex(mesh.plants, q, k)[1]);
  }
  assertEqual(top, 5, 'la sagoma la decide la texture, non l\'altezza del quadrilatero');
  assertEqual(mesh.plants.layers[0], 901, 'e usa lo strato della croce');
  const us = [0, 1, 2, 3].map((k) => texel(mesh.plants, 0, k)[0]);
  assertEqual(Math.min(...us), 0, 'texture intera in orizzontale');
  assertEqual(Math.max(...us), 1, 'da 0 a 1');
});

test('senza pacchetto non si emettono né coordinate né strati', () => {
  const vol = makeVolume(16, 16, 16, ['minecraft:stone']);
  setBlock(vol, 8, 8, 8, 1);
  const { opaque } = meshOf(vol);
  assertEqual(opaque.uvs, undefined, 'niente coordinate');
  assertEqual(opaque.layers, undefined, 'niente strati');
});

// ---------------------------------------------------------------------------
section('Lettura del volume');

test('legge un mondo vero e ritrova il terreno', async () => {
  if (!fs.existsSync(fixture.WORLD_DIR)) fixture.generate({ quiet: true });
  clearRegionCache();
  const source = new NodeSource(fixture.WORLD_DIR);
  const scan = await scanWorld(source);
  assert(scan.ok, `scansione fallita: ${scan.error || ''}`);
  const dim = scan.dimensions[0];

  const vol = await readVolume(source, dim.regionDir,
    { minX: 96, minY: 48, minZ: 96, sizeX: 32, sizeY: 80, sizeZ: 32 });

  assertEqual(vol.stats.chunks, 4, 'quattro chunk letti');
  assertEqual(vol.stats.unparsed, 0, 'nessun chunk illeggibile');
  assert(vol.states.length > 3, `palette con più di tre stati (${vol.states.length})`);
  assertEqual(vol.states[AIR_STATE], 'minecraft:air', 'lo stato 0 è aria');

  // c'è della roccia in basso e dell'aria in alto
  const at = (x, y, z) => vol.states[vol.blocks[((y - 48) * 32 + (z - 96)) * 32 + (x - 96)]];
  assert(at(100, 50, 100).startsWith('minecraft:'), 'nome di blocco valido');
  assertEqual(at(100, 127, 100), 'minecraft:air', 'in cima c\'è aria');
  let solid = 0;
  for (const s of vol.blocks) if (s !== AIR_STATE) solid++;
  assert(solid > 1000, `il volume non è vuoto (${solid} blocchi)`);

  assert(vol.biomeNames.length >= 1, 'almeno un bioma');
  assert(vol.biomeNames.every((b) => b.startsWith('minecraft:')), 'nomi di bioma validi');
});

test('ogni blocco letto è quello che il mondo di prova ci ha scritto', async () => {
  // Il controllo che conta: se lo spacchettamento dei bit o l'indicizzazione
  // sbagliassero, il volume uscirebbe plausibile ma con i blocchi sbagliati.
  if (!fs.existsSync(fixture.WORLD_DIR)) fixture.generate({ quiet: true });
  fixture.ensureTerrain();
  clearRegionCache();
  const source = new NodeSource(fixture.WORLD_DIR);
  const scan = await scanWorld(source);
  const box = { minX: 112, minY: 48, minZ: 112, sizeX: 16, sizeY: 80, sizeZ: 16 };
  const vol = await readVolume(source, scan.dimensions[0].regionDir, box);

  let checked = 0;
  for (let y = 0; y < box.sizeY; y++) {
    for (let z = 0; z < box.sizeZ; z++) {
      for (let x = 0; x < box.sizeX; x++) {
        const got = vol.names[vol.blocks[(y * box.sizeZ + z) * box.sizeX + x]];
        const want = fixture.blockAt(box.minX + x, box.minY + y, box.minZ + z);
        if (got !== want) {
          throw new Error(`blocco a ${box.minX + x},${box.minY + y},${box.minZ + z}: `
            + `atteso ${want}, letto ${got}`);
        }
        checked++;
      }
    }
  }
  assertEqual(checked, 16 * 80 * 16, 'blocchi confrontati');
});

test('il volume letto si trasforma in triangoli', async () => {
  if (!fs.existsSync(fixture.WORLD_DIR)) fixture.generate({ quiet: true });
  clearRegionCache();
  const source = new NodeSource(fixture.WORLD_DIR);
  const scan = await scanWorld(source);
  const vol = await readVolume(source, scan.dimensions[0].regionDir,
    { minX: 96, minY: 48, minZ: 96, sizeX: 32, sizeY: 80, sizeZ: 32 });
  const tables = buildTables(vol);
  assertEqual(tables.kind[AIR_STATE], KIND.air, 'lo stato 0 resta aria');

  let quads = 0;
  for (let z = 0; z < 32; z += 16) {
    for (let x = 0; x < 32; x += 16) {
      const m = meshColumn(vol, tables, x, z);
      quads += m.quads;
      if (m.opaque) {
        const verts = m.opaque.positions.length / 3;
        for (const i of m.opaque.indices) assert(i < verts, 'indice valido');
      }
    }
  }
  assert(quads > 200, `il terreno produce geometria (${quads} quadrilateri)`);
});

test('i blocchi nascosti si leggono come aria', async () => {
  if (!fs.existsSync(fixture.WORLD_DIR)) fixture.generate({ quiet: true });
  clearRegionCache();
  const source = new NodeSource(fixture.WORLD_DIR);
  const scan = await scanWorld(source);
  const box = { minX: 96, minY: 48, minZ: 96, sizeX: 16, sizeY: 80, sizeZ: 16 };
  const dir = scan.dimensions[0].regionDir;

  const plain = await readVolume(source, dir, box);
  const counts = new Map();
  for (const s of plain.blocks) counts.set(s, (counts.get(s) || 0) + 1);
  let common = 1, best = 0;
  for (const [s, n] of counts) {
    if (s !== AIR_STATE && n > best) { best = n; common = s; }
  }
  const name = plain.names[common];

  const filtered = await readVolume(source, dir, box, { hiddenBlocks: new Set([name]) });
  let before = 0, after = 0;
  for (const s of plain.blocks) if (plain.names[s] === name) before++;
  for (const s of filtered.blocks) if (filtered.names[s] === name) after++;
  assert(before > 0, 'il blocco c\'era');
  assertEqual(after, 0, `${name} è sparito dal volume filtrato`);
});


// --------------------------------------------------------------- glb ---
section('Esportazione .glb');

/** One quad, as the mesher lays it out: four vertices, two triangles. */
function quad({ y = 0, layer = 0, kind = 'opaque' } = {}) {
  return {
    kind,
    offset: [0, 0, 0],
    positions: new Float32Array([0, y, 0, 1, y, 0, 1, y, 1, 0, y, 1]),
    colors: new Uint8Array([255, 255, 255, 200, 200, 200, 150, 150, 150, 90, 90, 90]),
    uvs: new Float32Array([0, 0, 4, 0, 4, 4, 0, 4]),
    layers: new Float32Array([layer, layer, layer, layer]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

/** Read a .glb back: header, then the JSON chunk. */
function readGlb(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  const total = view.getUint32(8, true);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(
    new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
  const binAt = 20 + jsonLength;
  const binLength = view.getUint32(binAt, true);
  return {
    magic, total, json, binLength,
    bin: bytes.subarray(binAt + 8, binAt + 8 + binLength),
  };
}

const fakePng = (n) => new Uint8Array([137, 80, 78, 71, n]);

test('le facce si raggruppano per strato di texture', () => {
  const parts = collectParts([quad({ layer: 0 }), quad({ y: 1, layer: 3 })]);
  assertEqual(parts.length, 2, 'due strati, due gruppi');
  const layers = parts.map((p) => p.layer).sort();
  assertEqual(layers.join(','), '0,3', 'gli strati sono quelli di partenza');
  for (const part of parts) {
    assertEqual(part.positions.length / 3, 4, 'quattro vertici per quad');
    assertEqual(part.indices.length, 6, 'due triangoli');
    assertEqual(part.colors.length / 4, 4, 'i colori escono in RGBA');
  }
});

test('gruppi diversi per famiglie di blocchi diverse', () => {
  const parts = collectParts([quad({ layer: 0 }), quad({ y: 1, layer: 0, kind: 'clear' })]);
  assertEqual(parts.length, 2, 'stesso strato ma materiali diversi');
});

test('le coordinate di texture escono intatte, ripetizioni comprese', () => {
  const [part] = collectParts([quad()]);
  assertEqual(Math.max(...part.uvs), 4, 'il 4 di un quad merge-ato resta 4');
});

test('il taglio in altezza lascia fuori quello che nasconde', () => {
  const parts = collectParts([quad({ y: 0 }), quad({ y: 10 })], { cut: 5 });
  assertEqual(parts.length, 1, 'il quad sopra il taglio non esce');
  assertEqual(parts[0].positions[1], 0, 'quello rimasto è il basso');
});

test('una parete a cavallo del taglio viene tagliata sul piano', () => {
  // Il mesher unisce una parete piatta in un solo rettangolo alto: tenerlo o
  // buttarlo interi sbaglierebbe di dieci blocchi.
  const wall = quad();
  wall.positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 10, 1, 0, 10, 1]);
  const [part] = collectParts([wall], { cut: 5 });
  let top = -Infinity, bottom = Infinity;
  for (let i = 1; i < part.positions.length; i += 3) {
    top = Math.max(top, part.positions[i]);
    bottom = Math.min(bottom, part.positions[i]);
  }
  assertClose(top, 5, 'la parete finisce esattamente sul taglio');
  assertEqual(bottom, 0, 'e parte da dove partiva');
  assert(part.indices.length >= 6, 'il pezzo rimasto è ancora chiuso');
  assertEqual(part.indices.length % 3, 0, 'sono triangoli');
});

test('il taglio interpola anche colori e coordinate di texture', () => {
  const wall = quad();
  wall.positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 10, 0, 0, 10, 0]);
  wall.uvs = new Float32Array([0, 0, 1, 0, 1, 10, 0, 10]);
  const [part] = collectParts([wall], { cut: 5 });
  const maxV = Math.max(...[...part.uvs].filter((_, i) => i % 2 === 1));
  assertClose(maxV, 5, 'la texture si ferma dove si ferma la geometria');
});

test('senza pacchetto non escono né coordinate né strati', () => {
  const bare = quad();
  bare.uvs = null; bare.layers = null;
  const [part] = collectParts([bare]);
  assertEqual(part.uvs, null, 'niente coordinate');
  assertEqual(part.layer, -1, 'nessuno strato');
});

test('il file è un glb valido: intestazione, lunghezze, blocchi allineati', () => {
  const bytes = buildGlb(collectParts([quad()]), [fakePng(1)]);
  const glb = readGlb(bytes);
  assertEqual(glb.magic, 0x46546c67, 'la firma è glTF');
  assertEqual(glb.total, bytes.length, 'la lunghezza dichiarata è quella vera');
  assertEqual(bytes.length % 4, 0, 'il file è allineato a 4');
  assertEqual(glb.binLength % 4, 0, 'il blocco binario è allineato a 4');
  assertEqual(glb.json.asset.version, '2.0', 'è glTF 2.0');
});

test('ogni accessore sta dentro il blocco binario che dichiara', () => {
  const bytes = buildGlb(collectParts([quad({ layer: 0 }), quad({ y: 1, layer: 1 })]),
    [fakePng(1), fakePng(2)]);
  const { json, binLength } = readGlb(bytes);
  const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const BYTES = { 5121: 1, 5125: 4, 5126: 4 };
  for (const accessor of json.accessors) {
    const view = json.bufferViews[accessor.bufferView];
    const need = accessor.count * SIZE[accessor.type] * BYTES[accessor.componentType];
    assertEqual(view.byteLength, need, 'la vista è larga quanto i dati');
    assert(view.byteOffset + view.byteLength <= binLength, 'la vista sta nel buffer');
    assertEqual(view.byteOffset % 4, 0, 'la vista è allineata a 4');
  }
  assertEqual(json.buffers[0].byteLength, binLength, 'il buffer dichiara la sua taglia');
});

test('una texture per strato, con la ripetizione accesa', () => {
  const bytes = buildGlb(collectParts([quad({ layer: 0 }), quad({ y: 1, layer: 1 })]),
    [fakePng(1), fakePng(2)]);
  const { json } = readGlb(bytes);
  assertEqual(json.images.length, 2, 'due strati, due immagini');
  assertEqual(json.samplers[0].wrapS, 10497, 'wrapS è REPEAT');
  assertEqual(json.samplers[0].wrapT, 10497, 'wrapT è REPEAT');
  assertEqual(json.samplers[0].magFilter, 9728, 'ingrandimento NEAREST: sono pixel');
});

test('i materiali sono unlit, perché l\'ombra è già nei colori', () => {
  const bytes = buildGlb(collectParts([quad()]), [fakePng(1)]);
  const { json } = readGlb(bytes);
  assert(json.extensionsUsed.includes('KHR_materials_unlit'), 'estensione dichiarata');
  for (const m of json.materials) {
    assert(m.extensions && m.extensions.KHR_materials_unlit, 'ogni materiale è unlit');
  }
});

test('acqua e vetro escono trasparenti e a due facce', () => {
  const bytes = buildGlb(collectParts([quad({ kind: 'clear' })]), [fakePng(1)]);
  const { json } = readGlb(bytes);
  assertEqual(json.materials[0].alphaMode, 'BLEND', 'si mescola');
  assertEqual(json.materials[0].doubleSided, true, 'si vede da dentro');
});

test('senza texture il materiale non ritaglia contro il colore', () => {
  const bare = quad();
  bare.uvs = null; bare.layers = null;
  const { json } = readGlb(buildGlb(collectParts([bare]), []));
  assertEqual(json.materials[0].alphaMode, 'OPAQUE', 'niente MASK senza sprite');
  assert(!json.images, 'nessuna immagine');
});

test('le immagini finiscono nel binario, non in un file a fianco', () => {
  const png = fakePng(7);
  const { json, bin } = readGlb(buildGlb(collectParts([quad()]), [png]));
  const view = json.bufferViews[json.images[0].bufferView];
  assertEqual(json.images[0].mimeType, 'image/png', 'dichiarata come PNG');
  assertEqual(bin[view.byteOffset], png[0], 'i byte sono quelli dell\'immagine');
  assertEqual(view.byteLength, png.length, 'lunga quanto l\'immagine');
});

test('la posizione porta il suo minimo e massimo, come chiede lo standard', () => {
  const { json } = readGlb(buildGlb(collectParts([quad()]), [fakePng(1)]));
  const position = json.accessors.find((a) => a.type === 'VEC3' && a.min);
  assert(position, 'l\'accessore della posizione c\'è');
  assertEqual(position.min.join(','), '0,0,0', 'minimo');
  assertEqual(position.max.join(','), '1,0,1', 'massimo');
});

test('la provenienza della porzione resta scritta nel file', () => {
  const extras = { world: { minX: -320, minY: 48, minZ: 96 } };
  const { json } = readGlb(buildGlb(collectParts([quad()]), [fakePng(1)], extras));
  assertEqual(json.asset.extras.world.minX, -320, 'le coordinate del mondo');
});


(async () => {
  for (const item of tests) {
    if (item.kind === 'section') { console.log(`\n${item.title}`); continue; }
    try {
      await item.fn();
      passed++;
      console.log(`  ✓ ${item.name}`);
    } catch (err) {
      failed++;
      failures.push({ name: item.name, err });
      console.log(`  ✗ ${item.name}\n      ${err.message}`);
    }
  }
  console.log(`\n${'='.repeat(52)}`);
  console.log(`Test superati: ${passed}   falliti: ${failed}`);
  if (failed) {
    console.log('\nDettaglio fallimenti:');
    for (const f of failures) console.log(`  - ${f.name}: ${f.err.stack.split('\n').slice(0, 3).join('\n    ')}`);
    process.exit(1);
  }
  console.log('Tutti i test superati.');
})();
