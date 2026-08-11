'use strict';
/*
 * Test suite for the Cube-Atlas world-reading pipeline.
 * Run with: npm test
 */

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const nbt = require('../lib/nbt');
const anvil = require('../lib/anvil');
const tiler = require('../lib/tiler');
const worldScan = require('../lib/worldScan');
const { colorFor } = require('../lib/blockColors');
const book = require('../lib/book');
const fixture = require('./make-test-world');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'not equal'}: atteso ${expected}, ottenuto ${actual}`);
}
function section(title) { console.log(`\n${title}`); }

// ---------------------------------------------------------------------------
section('NBT');

test('round-trip di tipi scalari e stringhe', () => {
  const buf = nbt.build('root', {
    aByte: new nbt.TByte(-7),
    aShort: new nbt.TShort(1234),
    anInt: 70000,
    aLong: new nbt.TLong('9007199254740993'),
    aFloat: new nbt.TFloat(0.5),
    aDouble: new nbt.TDouble(1.25),
    aString: 'ciao mondo',
  });
  const { name, value } = nbt.parse(buf);
  assertEqual(name, 'root', 'nome radice');
  assertEqual(value.aByte, -7, 'byte');
  assertEqual(value.aShort, 1234, 'short');
  assertEqual(value.anInt, 70000, 'int');
  assertEqual(value.aLong, 9007199254740993n, 'long');
  assertEqual(value.aFloat, 0.5, 'float');
  assertEqual(value.aDouble, 1.25, 'double');
  assertEqual(value.aString, 'ciao mondo', 'string');
});

test('round-trip di liste, compound annidati e array', () => {
  const buf = nbt.build('', {
    list: new nbt.TList(nbt.TAG.Compound, [{ Name: 'a' }, { Name: 'b' }]),
    strings: new nbt.TList(nbt.TAG.String, ['x', 'y', 'z']),
    ints: new nbt.TIntArray([1, -2, 3]),
    longs: new nbt.TLongArray([1, -2]),
    nested: { deep: { value: 42 } },
  });
  const { value } = nbt.parse(buf);
  assertEqual(value.list.length, 2, 'lunghezza lista');
  assertEqual(value.list[1].Name, 'b', 'elemento lista');
  assertEqual(value.strings.join(','), 'x,y,z', 'lista di stringhe');
  assertEqual(value.ints[1], -2, 'int array');
  assertEqual(value.longs[1], -2n, 'long array');
  assertEqual(value.nested.deep.value, 42, 'compound annidato');
});

test('gzip e zlib vengono riconosciuti automaticamente', () => {
  const raw = nbt.build('', { v: 5 });
  assertEqual(nbt.parse(nbt.gzip(raw)).value.v, 5, 'gzip');
  assertEqual(nbt.parse(nbt.deflate(raw)).value.v, 5, 'zlib');
  assertEqual(nbt.parse(raw).value.v, 5, 'non compresso');
});

// ---------------------------------------------------------------------------
section('Bit packing dei palette index');

test('packing padded (1.16+) legge i valori scritti', () => {
  const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 15, 3, 9, 12, 1, 0, 14];
  const bits = 5; // 12 valori per long, quindi si attraversa il confine di long
  const longs = fixture.packPadded(values, bits);
  const arr = BigInt64Array.from(longs);
  for (let i = 0; i < values.length; i++) {
    assertEqual(anvil.readPaddedPacked(arr, bits, i), values[i], `valore ${i}`);
  }
});

test('padded e spanning divergono, come devono', () => {
  // Con 5 bit il 13esimo valore cade oltre il primo long solo nel formato
  // padded; se i due lettori coincidessero, uno dei due sarebbe sbagliato.
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
// Reference heightmap used to check what the parser read back.
fixture.ensureTerrain();

test('scanWorld riconosce il mondo e i suoi limiti', () => {
  const info = worldScan.scanWorld(WORLD);
  assert(info.ok, `scan fallito: ${info.error}`);
  assertEqual(info.levelName, 'Cube-Atlas Test World', 'nome del mondo');
  assertEqual(info.dimensions.length, 1, 'una sola dimensione');
  const ow = info.dimensions[0];
  assertEqual(ow.dimension, 'overworld', 'dimensione overworld');
  assertEqual(ow.regionCount, 1, 'una regione');
  assertEqual(ow.bounds.minX, 0, 'bound minX');
  assertEqual(ow.bounds.maxX, 511, 'bound maxX');
});

test('scanWorld rifiuta una cartella qualunque', () => {
  const res = worldScan.scanWorld(path.join(__dirname));
  assert(!res.ok, 'una cartella non-mondo deve essere rifiutata');
  assert(/level\.dat/.test(res.error), 'il messaggio deve spiegare cosa manca');
});

test('readSurface ricostruisce le altezze generate', () => {
  const g = anvil.readSurface(WORLD, 'overworld', 100, 100, 64, 64);
  assertEqual(g.unparsedChunks, 0, 'nessun chunk illeggibile');
  assert(g.totalChunks > 0, 'chunk trovati');
  let checked = 0;
  for (let z = 0; z < 64; z += 7) {
    for (let x = 0; x < 64; x += 7) {
      const wx = 100 + x, wz = 100 + z;
      const expected = fixture.heights[wz * fixture.SIZE + wx];
      const actual = g.surfaceY[z * 64 + x];
      // Sopra l'acqua la superficie è il livello del mare, non il fondale.
      const isWater = fixture.kinds[wz * fixture.SIZE + wx] === 1;
      const want = isWater ? fixture.SEA_LEVEL : expected;
      assertEqual(actual, want, `altezza a (${wx},${wz})`);
      checked++;
    }
  }
  assert(checked > 50, 'campionamento sufficiente');
});

test('readSurface riconosce blocchi e biomi di superficie', () => {
  const g = anvil.readSurface(WORLD, 'overworld', 0, 0, 512, 512);
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

test('sotto l\'acqua viene registrato il fondale', () => {
  const g = anvil.readSurface(WORLD, 'overworld', 0, 0, 512, 512);
  let found = 0;
  for (let i = 0; i < g.surfaceName.length; i++) {
    if (g.surfaceName[i] !== 'minecraft:water') continue;
    assert(g.floorY[i] < g.surfaceY[i], 'il fondale deve stare sotto la superficie');
    found++;
  }
  assert(found > 500, `attese molte colonne d'acqua, trovate ${found}`);
});

test('un\'area fuori dal mondo generato resta vuota', () => {
  const g = anvil.readSurface(WORLD, 'overworld', 5000, 5000, 32, 32);
  assertEqual(g.totalChunks, 0, 'nessun chunk');
  assert(g.surfaceY.every((v) => v === anvil.NO_DATA), 'tutte le colonne senza dati');
});

// ---------------------------------------------------------------------------
section('Colori e biomi');

test('il tinting per bioma cambia il colore dell\'erba', () => {
  const plains = colorFor('minecraft:grass_block', 'minecraft:plains');
  const desert = colorFor('minecraft:grass_block', 'minecraft:desert');
  const swamp = colorFor('minecraft:grass_block', 'minecraft:swamp');
  assert(plains.join() !== desert.join(), 'pianura e deserto devono differire');
  assert(plains.join() !== swamp.join(), 'pianura e palude devono differire');
});

test('l\'acqua prende il colore del bioma', () => {
  const warm = colorFor('minecraft:water', 'minecraft:warm_ocean');
  const frozen = colorFor('minecraft:water', 'minecraft:frozen_ocean');
  assert(warm.join() !== frozen.join(), 'oceano caldo e ghiacciato devono differire');
});

test('un blocco sconosciuto ottiene un colore stabile', () => {
  const a = colorFor('minecraft:qualcosa_di_inventato', null);
  const b = colorFor('minecraft:qualcosa_di_inventato', null);
  assertEqual(a.join(), b.join(), 'il colore di fallback deve essere deterministico');
  assertEqual(a.length, 3, 'terna RGB');
});

test('un bioma sconosciuto non fa saltare il rendering', () => {
  const c = colorFor('minecraft:grass_block', 'modpack:bioma_strano');
  assertEqual(c.length, 3, 'colore valido con bioma sconosciuto');
});

// ---------------------------------------------------------------------------
section('Tile e piramide');

const WORLD_ID = worldScan.worldId(WORLD);
tiler.clearCache(WORLD_ID);

function decodeTile(z, x, y) {
  const t = tiler.getTile({ worldPath: WORLD, worldId: WORLD_ID, dimension: 'overworld', z, x, y });
  return { ...t, png: PNG.sync.read(t.buffer) };
}

test('un tile nativo ha la dimensione giusta ed è opaco sul terreno', () => {
  const { png, empty } = decodeTile(0, 0, 0);
  assert(!empty, 'il tile 0,0 non deve essere vuoto');
  assertEqual(png.width, 256, 'larghezza');
  assertEqual(png.height, 256, 'altezza');
  let opaque = 0;
  for (let i = 3; i < png.data.length; i += 4) if (png.data[i] === 255) opaque++;
  assertEqual(opaque, 256 * 256, 'tutti i pixel opachi dentro l\'area generata');
});

test('i quattro tile nativi coprono il mondo e sono diversi tra loro', () => {
  const tiles = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => decodeTile(0, x, y));
  for (const t of tiles) assert(!t.empty, 'nessuno dei 4 tile deve essere vuoto');
  const hashes = tiles.map((t) => t.png.data.toString('base64').slice(0, 64));
  assertEqual(new Set(hashes).size, 4, 'i 4 tile devono avere contenuti diversi');
});

test('un tile fuori dal mondo è vuoto e trasparente', () => {
  const t = tiler.getTile({ worldPath: WORLD, worldId: WORLD_ID, dimension: 'overworld', z: 0, x: 40, y: 40 });
  assert(t.empty, 'deve risultare vuoto');
  const png = PNG.sync.read(t.buffer);
  let transparent = 0;
  for (let i = 3; i < png.data.length; i += 4) if (png.data[i] === 0) transparent++;
  assertEqual(transparent, 256 * 256, 'completamente trasparente');
});

test('il livello zoom -1 riassume i quattro figli', () => {
  const parent = decodeTile(-1, 0, 0);
  assert(!parent.empty, 'il genitore non deve essere vuoto');
  // A zoom -1 il mondo (512 blocchi) entra esattamente in un tile.
  let opaque = 0;
  for (let i = 3; i < parent.png.data.length; i += 4) if (parent.png.data[i] === 255) opaque++;
  assertEqual(opaque, 256 * 256, 'il mondo intero riempie il tile a zoom -1');
});

test('la cache restituisce lo stesso identico PNG', () => {
  const args = { worldPath: WORLD, worldId: WORLD_ID, dimension: 'overworld', z: 0, x: 1, y: 1 };
  const first = tiler.getTile(args);
  const second = tiler.getTile(args);
  assert(second.cached, 'la seconda richiesta deve venire dalla cache');
  assertEqual(Buffer.compare(first.buffer, second.buffer), 0, 'i byte devono coincidere');
});

test('clearCache svuota davvero la cache su disco', () => {
  const before = tiler.cacheStats(WORLD_ID);
  assert(before.files > 0, 'la cache deve contenere file');
  tiler.clearCache(WORLD_ID);
  assertEqual(tiler.cacheStats(WORLD_ID).files, 0, 'cache svuotata');
});

test('il calcolo dei blocchi per tile segue lo zoom', () => {
  assertEqual(tiler.blocksPerTile(0), 256, 'zoom 0');
  assertEqual(tiler.blocksPerTile(-1), 512, 'zoom -1');
  assertEqual(tiler.blocksPerTile(-4), 4096, 'zoom -4');
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
  for (const p of pages) {
    assert(!/^\S+\s/.test(p) || p.startsWith('parolina'), 'le pagine iniziano su una parola intera');
    assert(!p.includes('paroli\n'), 'nessuna parola spezzata');
  }
});

test('il comando /give è valido e con escaping corretto', () => {
  const cmd = book.buildGiveCommand({
    title: 'Cronache dell\'Impero',
    author: 'Fru "il Grande"',
    pages: ['Pagina uno', 'Riga uno\nRiga due'],
  });
  assert(cmd.startsWith('/give @p written_book'), 'deve essere un comando give');
  assert(cmd.includes('\\"'), 'le virgolette interne devono essere sfuggite');
  assert(!/[^\\]"il Grande"/.test(cmd), 'le virgolette dell\'autore devono essere sfuggite');
  assert(cmd.includes('\\\\n') || cmd.includes('\\n'), 'gli a capo devono essere codificati');
});

test('un titolo vuoto non genera un comando rotto', () => {
  const cmd = book.buildGiveCommand({ title: '', author: '', pages: [] });
  assert(cmd.includes('written_book'), 'comando comunque generato');
  assert(cmd.length < 400, 'comando compatto per un libro vuoto');
});

test('l\'export completo produce comando e mcfunction', () => {
  const out = book.exportDocument({ title: 'Diario', author: 'Fru', body: 'Riga uno.\n\nRiga due.' });
  assert(out.command.includes('written_book'), 'comando presente');
  assert(out.mcfunction.includes('give @p'), 'mcfunction presente');
  assert(out.pages.length >= 1, 'almeno una pagina');
  assertEqual(out.title, 'Diario', 'titolo conservato');
});

// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(52)}`);
console.log(`Test superati: ${passed}   falliti: ${failed}`);
if (failed) {
  console.log('\nDettaglio fallimenti:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.err.stack.split('\n').slice(0, 3).join('\n    ')}`);
  process.exit(1);
}
console.log('Tutti i test superati.');
