/*
 * Test suite for the Cube-Atlas core.
 *
 * The core is the same code the browser runs — it only needs a WorldSource,
 * and Node provides one backed by the filesystem. Run with: npm test
 */

import fs from 'node:fs';
import path from 'node:path';

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

let passed = 0;
let failed = 0;
const failures = [];
const tests = [];

function test(name, fn) { tests.push({ kind: 'test', name, fn }); }
function section(title) { tests.push({ kind: 'section', title }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
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
