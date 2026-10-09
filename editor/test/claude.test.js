/*
 * Tests for "Ask Claude": the terrain and feature operations, the group
 * operation, the area survey, the recipe compiler and the CLI runner — the
 * last one end to end with a fake `claude` executable, so no account and no
 * network are needed. Registered by test/run-tests.js.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseRaw } from '../../web/js/core/nbt.js';
import { writeNbt } from '../../web/js/core/nbtWrite.js';
import { ChunkEditor, stateKey } from '../core/chunk.js';
import { Journal, CHUNK_OPS, applyChunkOps } from '../core/journal.js';
import { KEEP, encodeHeights, decodeHeights, readColumn, featureBlocks, isGround } from '../core/terrain.js';
import { surveyArea, describeSurvey, surveyProblem } from '../core/survey.js';
import { compileRecipe, parseRecipe, buildPrompt, terrainField } from '../core/recipe.js';
import { OverlaySource } from '../core/overlay.js';
import { NodeSource } from '../core/nodeSource.js';
import { readRegionFile } from '../core/region.js';
import { cleanEnv, claudeArgs, claudeStatus, explainFailure } from '../main/claude.js';
import { makeWorld, makeChunk } from './fixture.js';
import { WorldSession } from '../main/session.js';

const rect = (minX, minZ, maxX, maxZ) => ({ type: 'rect', minX, minZ, maxX, maxZ });
const sel = (...shapes) => ({ items: shapes.map((shape) => ({ mode: 'add', shape })), yMin: null, yMax: null });
const chunk = (cx = 0, cz = 0) => parseRaw(writeNbt(makeChunk(cx, cz)), { typed: true }).value;
const editor = (root) => new ChunkEditor(root, { minY: -64, height: 384 });
const name = (ed, x, y, z) => ed.getState(x, y, z).Name.replace('minecraft:', '');
const REGIONS = [{ x: 0, z: 0 }];

/** A terrain op over chunk 0,0 with every column at `h` except where fn says otherwise. */
function terrainOp(fn, extra = {}) {
  const H = new Int16Array(256);
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) H[z * 16 + x] = fn(x, z);
  return { type: 'setTerrain', dim: 'overworld', x0: 0, z0: 0, w: 16, d: 16, heights: encodeHeights(H), ...extra };
}

/*
 * A stand-in for the Claude Code CLI: answers `auth status` and, in print
 * mode, streams a recipe the way the real one does. It also records its
 * arguments and whether it saw an API key, for the test to check.
 */
function fakeClaude(dir, { loggedIn = true, method = 'claude.ai', recipe = null, sleep = 0, fail = null } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'claude');
  const log = path.join(dir, 'calls.jsonl');
  const answer = JSON.stringify(recipe || {});
  fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, apiKey: 'ANTHROPIC_API_KEY' in process.env, cwd: process.cwd() }) + '\\n');
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: ${loggedIn}, authMethod: ${JSON.stringify(method)} })); process.exit(0); }
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(path.join(dir, 'stdin.txt'))}, input);
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  out({ type: 'system', subtype: 'init' });
  setTimeout(() => {
    ${fail ? `out({ type: 'result', subtype: 'success', is_error: true, result: ${JSON.stringify(fail)} }); process.exit(1);` : ''}
    const text = '\`\`\`json\\n' + ${JSON.stringify(answer)} + '\\n\`\`\`';
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
    out({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: text });
  }, ${sleep});
});
`);
  fs.chmodSync(file, 0o755);
  return { file, log, calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) };
}

export function register({ test, section, assert, assertEqual }) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cantiere-claude-'));
  let n = 0;
  const freshSaves = () => { const d = path.join(scratch, `s${n++}`); fs.mkdirSync(d); return d; };

  // -------------------------------------------------------------------------
  section('Cantiere — terreno, alberi e gruppi');

  test('altezze: codifica base64 avanti e indietro, KEEP compreso', () => {
    const a = new Int16Array([0, -64, 319, KEEP, 1234, -1]);
    const back = decodeHeights(encodeHeights(a), a.length);
    assertEqual([...back].join(), [...a].join(), 'valori');
    let threw = false;
    try { decodeHeights(encodeHeights(a), 5); } catch { threw = true; }
    assert(threw, 'lunghezza sbagliata rifiutata');
  });

  test('suolo di una colonna: erba a 39, il baule conta come costruito', () => {
    const ed = editor(chunk());
    const c = readColumn(ed, 2, 2);
    assertEqual(c.ground, 39, 'quota'); assertEqual(c.groundName, 'minecraft:grass_block', 'blocco');
    assertEqual(readColumn(ed, 5, 5).ground, 40, 'baule');
    assert(!isGround('minecraft:oak_leaves') && !isGround('minecraft:short_grass') && isGround('minecraft:stone'), 'classificazione');
  });

  test('setTerrain alza: erba in cima, terra sotto, pietra fino al vecchio suolo', () => {
    const root = chunk();
    applyChunkOps(root, [terrainOp(() => 46, { top: 'grass_block', filler: 'dirt', fillerDepth: 3 })], 0, 0, 'overworld');
    const ed = editor(root);
    assertEqual(name(ed, 3, 46, 3), 'grass_block', 'cima');
    assertEqual(name(ed, 3, 45, 3), 'dirt', 'riempimento');
    assertEqual(name(ed, 3, 43, 3), 'dirt', 'riempimento in fondo');
    assertEqual(name(ed, 3, 42, 3), 'stone', 'pietra');
    assertEqual(name(ed, 3, 40, 3), 'stone', 'pietra sul vecchio suolo');
    assertEqual(name(ed, 3, 47, 3), 'air', 'aria sopra');
  });

  test('setTerrain abbassa, con l\'acqua fino al livello e la sabbia sul fondo', () => {
    const root = chunk();
    applyChunkOps(root, [terrainOp((x) => (x < 8 ? 34 : KEEP), { waterLevel: 37 })], 0, 0, 'overworld');
    const ed = editor(root);
    assertEqual(name(ed, 2, 34, 2), 'sand', 'fondo');
    assertEqual(name(ed, 2, 35, 2), 'water', 'acqua');
    assertEqual(name(ed, 2, 37, 2), 'water', 'acqua al livello');
    assertEqual(name(ed, 2, 38, 2), 'air', 'aria sopra il livello');
    assertEqual(name(ed, 2, 39, 2), 'air', 'vecchia erba tolta');
    assertEqual(name(ed, 12, 39, 2), 'grass_block', 'colonna KEEP intatta');
  });

  test('alberi: tronco sul suolo, foglie con la distanza giusta; piante solo sulla terra', () => {
    const blocks = featureBlocks([8, 39, 8, 'oak', 5], 1);
    const logs = blocks.filter((b) => b[4] === 'log');
    assertEqual(logs.length, 5, 'tronco di 5');
    assertEqual(logs[0][1], 40, 'parte sopra il suolo');
    const leaves = blocks.filter((b) => b[4] === 'leaf');
    assert(leaves.length > 20 && leaves.every((b) => Number(b[3].Properties.distance) <= 6 && b[3].Properties.persistent === 'false'), 'foglie che non seccano');
    const root = chunk();
    applyChunkOps(root, [{ type: 'placeFeatures', dim: 'overworld', seed: 1, items: [[8, 39, 8, 'oak', 5], [2, 39, 2, 'tall_grass'], [5, 40, 5, 'poppy']] }], 0, 0, 'overworld');
    const ed = editor(root);
    assertEqual(name(ed, 8, 44, 8), 'oak_log', 'tronco');
    assertEqual(ed.getState(2, 41, 2).Properties.half, 'upper', 'erba alta su due blocchi');
    assertEqual(name(ed, 5, 41, 5), 'air', 'niente fiore sul baule');
    // A canopy across the chunk border is drawn half here, half there.
    const b = CHUNK_OPS.placeFeatures.bounds({ items: [[15, 39, 8, 'oak']] });
    assertEqual(b.maxX, 19, 'la chioma entra nel chunk accanto');
  });

  test('gruppo: una voce, un annulla; errori leggibili sulle operazioni dentro', () => {
    const j = new Journal();
    const g = { type: 'group', dim: 'overworld', label: 'prova', ops: [
      terrainOp(() => 41), { type: 'fillBox', dim: 'overworld', x1: 20, y1: 40, z1: 0, x2: 21, y2: 40, z2: 1, state: 'gold_block' },
    ] };
    j.push(g);
    assertEqual(j.size, 1, 'una voce');
    const plan = j.chunkPlan().get('overworld');
    assert(plan.has('0,0') && plan.has('1,0'), 'tocca i due chunk');
    const root = chunk(1, 0);
    applyChunkOps(root, plan.get('1,0'), 1, 0, 'overworld');
    assertEqual(name(editor(root), 20, 40, 0), 'gold_block', 'riempimento nel gruppo');
    assertEqual(name(editor(root), 25, 39, 0), 'grass_block', 'il terreno non esce dalla sua area');
    j.undo();
    assertEqual(j.size, 0, 'annullato tutto insieme');
    let msg = '';
    try { j.push({ ...g, ops: [{ type: 'fillBox', dim: 'overworld', x1: 0, y1: 0, z1: 0, x2: 1, y2: 1, z2: 1, state: 'not a block!' }] }); } catch (err) { msg = err.message; }
    assert(/Operazione 1 \(fillBox\)/.test(msg), msg);
    msg = '';
    try { j.push({ ...g, ops: [g.ops[1], { type: 'setSpawn', x: 0, y: 0, z: 0 }] }); } catch (err) { msg = err.message; }
    assert(/non ammesso/.test(msg), msg);
  });

  // -------------------------------------------------------------------------
  section('Cantiere — chiedi a Claude: area e ricetta');

  const surveyOf = async (selection, world = makeWorld(freshSaves())) => surveyArea({
    source: new OverlaySource(new NodeSource(world), new Journal()), dim: 'overworld', regions: REGIONS, selection,
  });

  test('lettura dell\'area: suolo, blocchi e biomi; limite di dimensione', async () => {
    const s = await surveyOf(sel(rect(0, 0, 19, 9)));
    assertEqual(s.w, 20, 'larghezza'); assertEqual(s.d, 10, 'profondità');
    assertEqual(s.ground[3 * 20 + 3], 39, 'suolo');
    assertEqual(s.names[s.groundName[3 * 20 + 3]], 'minecraft:grass_block', 'erba');
    const { text } = describeSurvey(s);
    assert(/HEIGHT GRID/.test(text) && /39 39 39/.test(text) && /SURFACE GRID/.test(text), text.slice(0, 300));
    assert(/lato massimo/.test(surveyProblem(sel(rect(0, 0, 300, 10)))), 'troppo grande');
    assert(surveyProblem(sel()) !== null, 'vuota');
  });

  test('ricetta: collina al centro, bordi raccordati, colonne ferme lasciate stare', async () => {
    const selection = sel(rect(0, 0, 31, 31));
    const s = await surveyOf(selection);
    const F = terrainField({ steps: [{ op: 'hill', x: 16, z: 16, radius: 12, height: 10 }], blend: 4 }, s);
    assert(F[16 * 32 + 16] >= 48, `cima ${F[16 * 32 + 16]}`);
    assertEqual(F[0], 39, 'angolo fermo');
    const { op, stats } = compileRecipe({
      explanation: 'Una collina boscosa.',
      terrain: { steps: [{ op: 'hill', x: 16, z: 16, radius: 12, height: 10 }, { op: 'smooth', radius: 1 }], top: 'grass_block' },
      edits: [{ type: 'replace', rules: [{ from: 'grass_block', to: 'podzol' }], area: { minX: 0, minZ: 0, maxX: 3, maxZ: 3 } }],
      features: [{ type: 'scatter', species: { oak: 2, birch: 1 }, density: 0.05, spacing: 4 }, { type: 'at', kind: 'spruce', x: 16, z: 16 }],
    }, s, { selection, request: 'trasforma in una collina boscosa', seed: 7 });
    assertEqual(op.type, 'group', 'un gruppo');
    assertEqual(op.ops.map((o) => o.type).join(), 'setTerrain,replaceBlocks,placeFeatures', 'ordine');
    assert(stats.raised > 100 && stats.trees > 5, JSON.stringify(stats));
    const spruce = op.ops[2].items.find((i) => i[3] === 'spruce');
    assert(spruce && spruce[1] > 45, 'l\'albero sta sulla collina nuova');
    assertEqual(op.label, 'trasforma in una collina boscosa', 'etichetta');
  });

  test('ricetta: errori chiari e risposte con il JSON fra i recinti', async () => {
    const selection = sel(rect(0, 0, 15, 15));
    const s = await surveyOf(selection);
    const bad = (recipe) => { try { compileRecipe(recipe, s, { selection }); return ''; } catch (err) { return err.message; } };
    assert(/passo sconosciuto/.test(bad({ terrain: { steps: [{ op: 'explode' }] } })), 'passo');
    assert(/specie sconosciuta/.test(bad({ features: [{ type: 'scatter', species: { baobab: 1 } }] })), 'specie');
    assert(/fuori dall'area/.test(bad({ edits: [{ type: 'fillBox', x1: 100, y1: 0, z1: 100, x2: 101, y2: 1, z2: 101, block: 'stone' }] })), 'scatola fuori');
    assert(/fuori dai limiti/.test(bad({ terrain: { steps: [{ op: 'set', y: 999 }] } })), 'quota');
    assertEqual(compileRecipe({ explanation: 'niente', terrain: null, edits: [], features: [] }, s, { selection }).op, null, 'niente da fare');
    assertEqual(parseRecipe('Ecco:\n```json\n{"explanation":"x","edits":[]}\n```').explanation, 'x', 'recinti');
    let msg = '';
    try { parseRecipe('non so'); } catch (err) { msg = err.message; }
    assert(/nessun JSON/.test(msg), msg);
    assert(/REQUEST FROM THE USER/.test(buildPrompt('fai un lago', s)), 'prompt');
  });

  // -------------------------------------------------------------------------
  section('Cantiere — chiedi a Claude: la CLI dell\'abbonamento');

  test('ambiente pulito: niente chiavi API, niente strumenti, niente impostazioni dell\'utente', () => {
    const env = cleanEnv('/x/bin/claude', { PATH: '/usr/bin', HOME: '/h', ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_SIMPLE: '1', CLAUDECODE: '1' });
    assert(!('ANTHROPIC_API_KEY' in env) && !('ANTHROPIC_AUTH_TOKEN' in env) && !('CLAUDE_CODE_SIMPLE' in env) && !('CLAUDECODE' in env), 'variabili tolte');
    assert(env.PATH.startsWith('/x/bin:') && env.HOME === '/h', env.PATH);
    const args = claudeArgs({ system: 'S', model: 'opus' });
    const at = args.indexOf('--tools');
    assert(at >= 0 && args[at + 1] === '', 'nessuno strumento');
    assert(args.includes('-p') && args.includes('--safe-mode') && args.includes('--no-session-persistence') && !args.includes('--bare'), args.join(' '));
    assert(/limite d'uso/.test(explainFailure('Claude usage limit reached')), 'limite');
    assert(/non è collegato/.test(explainFailure('Not logged in · Please run /login')), 'login');
  });

  test('stato della CLI: non trovata, non collegata, chiave API rifiutata, abbonamento ok', async () => {
    assert(/non è installato/.test((await claudeStatus(path.join(scratch, 'nessuno'))).error), 'non trovata');
    assert(/non è collegato/.test((await claudeStatus(fakeClaude(path.join(scratch, 'f1'), { loggedIn: false }).file)).error), 'non collegata');
    assert(/chiave API/.test((await claudeStatus(fakeClaude(path.join(scratch, 'f2'), { method: 'api_key' }).file)).error), 'chiave API');
    assert((await claudeStatus(fakeClaude(path.join(scratch, 'f3')).file)).ok, 'ok');
  });

  test('dall\'area alla copia: chiedi, metti in sospeso, applica (CLI finta)', async () => {
    const saves = freshSaves();
    const world = makeWorld(saves);
    const s = await WorldSession.open(world, { dataDir: path.join(scratch, 'dc1') });
    const fake = fakeClaude(path.join(scratch, 'f4'), { recipe: {
      explanation: 'Alzo una collinetta e ci pianto una quercia.',
      terrain: { steps: [{ op: 'plateau', x: 8, z: 8, radius: 4, y: 44, falloff: 3 }], top: 'grass_block', blend: 0 },
      features: [{ type: 'at', kind: 'oak', x: 8, z: 8, size: 4 }],
    } });
    const phases = new Set();
    const selection = sel(rect(0, 0, 15, 15));
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-non-usare';
    let res;
    try {
      res = await s.askClaude({ dim: 'overworld', selection, request: 'una collinetta con una quercia', claudePath: fake.file }, (p) => phases.add(p.phase)).promise;
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev;
    }
    assert(['controllo', 'lettura', 'claude', 'compila'].every((p) => phases.has(p)), [...phases].join());
    const run = fake.calls().find((c) => c.args.includes('-p'));
    assert(run && !run.apiKey, 'la CLI non vede la chiave API');
    assert(/una collinetta con una quercia/.test(fs.readFileSync(path.join(scratch, 'f4', 'stdin.txt'), 'utf8')), 'richiesta nel prompt');
    assert(fs.existsSync(path.join(res.logDir, 'answer.txt')), 'risposta salvata');
    assertEqual(res.explanation, 'Alzo una collinetta e ci pianto una quercia.', 'spiegazione');
    assertEqual(s.journal.size, 0, 'nulla in sospeso finché non lo si chiede');
    s.push(res.op);
    assertEqual(await s.probe('overworld', 8, 8).then((p) => p && p.block), 'minecraft:oak_leaves', 'anteprima: la quercia sulla mappa');
    const before = fs.readFileSync(path.join(world, 'region', 'r.0.0.mca'));
    const out = await s.applyInWorker({ skipLockCheck: true }).promise;
    assert(before.equals(fs.readFileSync(path.join(world, 'region', 'r.0.0.mca'))), 'originale intatto');
    const ed = editor(readRegionFile(path.join(out.targetDir, 'region', 'r.0.0.mca')).getChunk(0, 0).value);
    assertEqual(name(ed, 8, 44, 8), 'grass_block', 'collinetta nella copia');
    assertEqual(name(ed, 8, 45, 8), 'oak_log', 'quercia nella copia');
    assertEqual(stateKey(ed.getState(0, 39, 0)), 'minecraft:grass_block', 'bordo intatto');
  });

  test('chiedi a Claude: annullamento ed errori della CLI', async () => {
    const s = await WorldSession.open(makeWorld(freshSaves()), { dataDir: path.join(scratch, 'dc2') });
    const selection = sel(rect(0, 0, 15, 15));
    const slow = fakeClaude(path.join(scratch, 'f5'), { sleep: 20000 });
    const t = s.askClaude({ dim: 'overworld', selection, request: 'piano', claudePath: slow.file }, (p) => { if (p.phase === 'claude') t.cancel(); });
    let err = null;
    try { await t.promise; } catch (e) { err = e; }
    assert(err && err.cancelled, err ? err.message : 'non annullato');
    const broken = fakeClaude(path.join(scratch, 'f6'), { fail: 'Claude AI usage limit reached|1760000000' });
    err = null;
    try { await s.askClaude({ dim: 'overworld', selection, request: 'piano', claudePath: broken.file }).promise; } catch (e) { err = e; }
    assert(err && /limite d'uso/.test(err.message), err ? err.message : 'nessun errore');
    err = null;
    try { await s.askClaude({ dim: 'overworld', selection: sel(rect(0, 0, 400, 3)), request: 'x', claudePath: broken.file }).promise; } catch (e) { err = e; }
    assert(err && /lato massimo/.test(err.message), 'area troppo grande');
  });
}
