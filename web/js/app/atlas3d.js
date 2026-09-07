/*
 * Atlante 3D — la porzione di mondo che stai guardando sulla mappa, in tre
 * dimensioni.
 *
 * Non apre niente da sé: il mondo lo ha già aperto l'Editor, e questo modulo
 * riceve da main.js come raggiungerlo. Il worker però è un altro — quello
 * dell'Editor disegna tessere dall'alto, questo legge volumi e costruisce
 * triangoli — quindi il salvataggio va riaperto una volta sola sul suo, la
 * prima volta che si entra nella schermata.
 *
 * Il resto (scelta della porzione, anteprima, caricamento, vista, export .glb)
 * viene da Cube-Atlas 3D, dove girava come applicazione a sé.
 */

import { engine } from './engine3d.js';
import { Viewer } from './viewer3d.js';
import {
  supportsFileHandles, pickPack, restoreLastPack, packFromFileList, forgetPack,
} from './packPicker.js';

const $ = (id) => document.getElementById(id);

const el = {
  pickPack: $('btn-pick-pack'), reopenPack: $('btn-reopen-pack'), packInput: $('pack-input'),
  packHint: $('pack-hint'),
  packStatus: $('pack-status'), packToggleRow: $('pack-toggle-row'), packToggle: $('pack-toggle'),
  hiddenBlocks: $('a3d-block-custom'),
  panelPortion: $('panel-portion'), centerX: $('center-x'), centerZ: $('center-z'),
  spawn: $('btn-spawn'), player: $('btn-player'), radius: $('radius'), sizeLabel: $('size-label'),
  heightMode: $('height-mode'), heightManual: $('height-manual'),
  minY: $('min-y'), heightBlocks: $('height-blocks'), heightLabel: $('height-label'),
  preview: $('preview'), previewHint: $('preview-hint'), estimate: $('estimate'),
  nudgeN: $('nudge-n'), nudgeS: $('nudge-s'), nudgeW: $('nudge-w'), nudgeE: $('nudge-e'),
  load: $('btn-load'), loadStatus: $('load-status'),
  progress: $('progress'), progressBar: $('progress-bar'),
  panelView: $('panel-view'),
  cut: $('cut'), cutLabel: $('cut-label'), snapshot: $('btn-snapshot'),
  exportGlb: $('btn-export'), viewStats: $('view-stats'),
  stage: $('a3d-stage'), emptyState: $('a3d-empty'),
  scene: $('scene'), crosshair: $('crosshair'), hud: $('hud'), hudPos: $('hud-pos'),
  hudLook: $('hud-look'), hudRight: $('hud-right'),
  worldNote: $('a3d-world-note'),
};

const state = {
  scan: null,          // the world as this screen's own worker sees it
  init: null,          // how the Editor reached that world
  dimension: null,
  center: { x: 0, z: 0 },
  survey: null,
  surveying: false,
  loading: false,
  loaded: null,
  pack: null,          // names of the archives the textures come from
};

let viewer = null;
let host = null;       // the bridge back to main.js
let opening = null;    // the in-flight openWorld, so two entries share one

// --------------------------------------------------------------- utilities ---

const snapDown16 = (v) => Math.floor(v / 16) * 16;
const snapUp16 = (v) => Math.ceil(v / 16) * 16;

function setStatus(node, text, kind = '') {
  node.textContent = text;
  node.className = `status${kind ? ` ${kind}` : ''}`;
}

/** Block names to read as air. Barriers are always excluded on their own. */
function hiddenBlocks() {
  return el.hiddenBlocks.value.split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.includes(':') ? s : `minecraft:${s}`));
}

/** The box currently described by the controls, snapped to whole chunks. */
function currentBox() {
  const side = Number(el.radius.value) * 2 * 16;
  const minX = snapDown16(state.center.x - side / 2);
  const minZ = snapDown16(state.center.z - side / 2);

  let minY, maxY;
  if (el.heightMode.value === 'manual') {
    minY = snapDown16(Number(el.minY.value));
    maxY = minY + Math.max(16, snapUp16(Number(el.heightBlocks.value) || 16));
  } else if (state.survey && state.survey.ground) {
    minY = snapDown16(state.survey.ground.lo - 16);
    maxY = snapUp16(state.survey.ground.hi + 12);
  } else {
    minY = 48; maxY = 128;
  }
  if (maxY <= minY) maxY = minY + 16;
  // A world is at most 384 blocks tall; more than that is a mistake, not a view.
  const sizeY = Math.min(384, maxY - minY);
  return { minX, minY, minZ, sizeX: side, sizeY, sizeZ: side };
}

function describeBox(box) {
  const blocks = box.sizeX * box.sizeY * box.sizeZ;
  const mb = (blocks * 2) / (1024 * 1024);
  return `${box.sizeX}×${box.sizeZ} blocchi, da Y ${box.minY} a Y ${box.minY + box.sizeY}`
    + ` — ${(blocks / 1e6).toFixed(1)} milioni di blocchi, ~${mb.toFixed(0)} MB`;
}

// Above this the read is slow and the browser may run out of memory before
// it finishes, so loading asks first instead of just starting.
const HUGE_BLOCKS = 120e6;
const BIG_BLOCKS = 28e6;

function refreshEstimate() {
  const box = currentBox();
  el.sizeLabel.textContent = String(box.sizeX);
  el.heightLabel.textContent = String(box.sizeY);
  const blocks = box.sizeX * box.sizeY * box.sizeZ;
  let note = '', kind = '';
  if (blocks > HUGE_BLOCKS) {
    note = '. Enorme: può occupare tutta la memoria del browser e non arrivare in fondo.';
    kind = 'err';
  } else if (blocks > BIG_BLOCKS) {
    note = '. È tanto: preparati ad aspettare.';
    kind = 'warn';
  }
  setStatus(el.estimate, describeBox(box) + note, kind);
}
// ----------------------------------------------------------------- il mondo ---

/**
 * Catch up with the world the Editor has open.
 *
 * The scan is cheap but not free, so it only happens when the folder or the
 * dimension actually changed — entering the screen a second time on the same
 * world costs nothing.
 */
async function syncWorld() {
  if (!host) return false;
  const init = host.getWorldInit();
  const dimension = host.getDimension();
  if (!init) {
    el.panelPortion.classList.add('hidden');
    el.worldNote.textContent = 'Apri prima un mondo nell\'Editor: l\'Atlante 3D legge quello.';
    el.worldNote.classList.remove('hidden');
    return false;
  }
  el.worldNote.classList.add('hidden');

  if (state.init === init && state.dimension === dimension && state.scan) return true;
  if (opening) return opening;

  el.panelPortion.classList.add('hidden');
  el.previewHint.textContent = 'Sto aprendo il mondo…';
  opening = (async () => {
    try {
      const scan = await engine.openWorld(init);
      if (!scan.ok) {
        el.worldNote.textContent = scan.error || 'Mondo non leggibile.';
        el.worldNote.classList.remove('hidden');
        return false;
      }
      const changedWorld = state.init !== init;
      state.scan = scan;
      nameTheJar(scan.version);
      state.init = init;
      state.dimension = scan.dimensions.some((d) => d.id === dimension)
        ? dimension : scan.dimensions[0].id;
      el.panelPortion.classList.remove('hidden');
      // A world just opened has no centre worth keeping: start at spawn.
      if (changedWorld) {
        const spawn = scan.spawn || { x: 0, z: 0 };
        setCenter(spawn.x, spawn.z);
      } else {
        state.survey = null;
        runSurvey();
      }
      return true;
    } finally {
      opening = null;
    }
  })();
  return opening;
}

/**
 * Say which .jar to look for.
 *
 * The browser cannot go and fetch it: the save lives in `saves/<mondo>/` and
 * the game in `versions/<versione>/`, and a granted folder cannot be climbed
 * out of. But `level.dat` records the version the world was saved with, so
 * the app can at least name the file instead of asking for "the .jar".
 */
function nameTheJar(version) {
  if (!version) return;
  const clean = String(version).trim();
  if (!/^[\w.\- ]{1,32}$/.test(clean)) return;   // a version string, not a sentence
  el.pickPack.textContent = `Scegli ${clean}.jar…`;
  el.packHint.classList.remove('hidden');
  el.packHint.innerHTML = 'Il mondo è stato salvato con <b>' + clean + '</b>:'
    + ' su macOS il file è <code>~/Library/Application&nbsp;Support/minecraft/versions/'
    + clean + '/' + clean + '.jar</code>. Va bene anche una versione diversa —'
    + ' cambia solo qualche texture.';
}

/** Textures are used when a pack is open and the box is ticked. */
const useTextures = () => !!state.pack && el.packToggle.checked;

async function openPack(files) {
  if (!files || !files.length) return;
  setStatus(el.packStatus, 'Sto aprendo l\'archivio…');
  try {
    const result = await engine.openPack(files);
    state.pack = result.names;
    setStatus(el.packStatus, `Texture da ${result.names.join(' + ')}`, 'ok');
    el.packToggleRow.classList.remove('hidden');
    el.packToggle.checked = true;
  } catch (err) {
    setStatus(el.packStatus, err.message, 'err');
  }
}

// ------------------------------------------------------------- l'anteprima ---

let surveyTimer = null;

function scheduleSurvey() {
  clearTimeout(surveyTimer);
  surveyTimer = setTimeout(runSurvey, 260);
}

/**
 * A top-down look at the area, wider than the selection so the portion can be
 * moved around inside it without a new read every time.
 */
async function runSurvey() {
  if (!state.scan || state.surveying) return;
  const box = currentBox();
  // Wider than the selection where that is cheap, but never narrower than it:
  // the preview has to contain the green frame it draws.
  const span = Math.max(box.sizeX, Math.min(1024, Math.max(256, snapUp16(box.sizeX * 1.6))));
  const minX = snapDown16(state.center.x - span / 2);
  const minZ = snapDown16(state.center.z - span / 2);

  state.surveying = true;
  el.previewHint.textContent = 'Sto guardando la zona dall\'alto…';
  try {
    state.survey = await engine.survey({
      dimId: state.dimension, minX, minZ, width: span, depth: span,
      hiddenBlocks: hiddenBlocks(),
      focus: { minX: box.minX, minZ: box.minZ, width: box.sizeX, depth: box.sizeZ },
    });
    el.previewHint.textContent = state.survey.ground
      ? `Terreno da Y ${state.survey.ground.lo} a Y ${state.survey.ground.hi}.`
        + ' Clicca sull\'anteprima per spostare il centro.'
      : 'Qui non c\'è nessun chunk salvato: spostati altrove.';
  } catch (err) {
    el.previewHint.textContent = err.message;
  } finally {
    state.surveying = false;
    drawPreview();
    refreshEstimate();
  }
}

function drawPreview() {
  const canvas = el.preview;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const survey = state.survey;
  if (!survey) return;

  const bitmap = document.createElement('canvas');
  bitmap.width = survey.width; bitmap.height = survey.depth;
  bitmap.getContext('2d').putImageData(
    new ImageData(survey.rgba, survey.width, survey.depth), 0, 0);

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  const box = currentBox();
  const k = canvas.width / survey.width;
  const x = (box.minX - survey.minX) * k;
  const z = (box.minZ - survey.minZ) * k;
  const w = box.sizeX * k;

  ctx.fillStyle = 'rgba(0,0,0,.35)';
  ctx.fillRect(0, 0, canvas.width, z);
  ctx.fillRect(0, z + w, canvas.width, canvas.height - z - w);
  ctx.fillRect(0, z, x, w);
  ctx.fillRect(x + w, z, canvas.width - x - w, w);
  ctx.strokeStyle = '#7fd44f';
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, z + 1, w - 2, w - 2);
}

/**
 * Walk the selection one step sideways. A quarter of the side keeps some of
 * what you were looking at in view; Shift jumps a whole side, for covering
 * ground fast.
 */
function nudge(dx, dz, whole) {
  const side = Number(el.radius.value) * 2 * 16;
  const step = whole ? side : Math.max(16, snapUp16(side / 4));
  setCenter(state.center.x + dx * step, state.center.z + dz * step);
}

function setCenter(x, z) {
  state.center = { x: Math.round(x), z: Math.round(z) };
  el.centerX.value = state.center.x;
  el.centerZ.value = state.center.z;
  refreshEstimate();
  drawPreview();
  scheduleSurvey();
}
// -------------------------------------------------------------- il caricamento ---

async function loadPortion() {
  if (state.loading) return;
  const box = currentBox();
  const blocks = box.sizeX * box.sizeY * box.sizeZ;
  if (blocks > BIG_BLOCKS) {
    const mb = Math.round((blocks * 2) / (1024 * 1024));
    const ok = window.confirm(
      `${box.sizeX}×${box.sizeZ} blocchi per ${box.sizeY} di altezza:`
      + ` ${(blocks / 1e6).toFixed(0)} milioni di blocchi, circa ${mb} MB.\n\n`
      + (blocks > HUGE_BLOCKS
        ? 'A questa taglia il browser può esaurire la memoria e chiudere la pagina'
          + ' prima di finire. Provo lo stesso?'
        : 'Ci vorrà un po\' e la pagina resterà ferma mentre legge. Vado?'));
    if (!ok) return;
  }
  state.loading = true;
  el.load.disabled = true;
  el.progress.classList.remove('hidden');
  el.progressBar.style.width = '0%';
  setStatus(el.loadStatus, 'Lettura del salvataggio…');

  ensureViewer();
  viewer.reset(box);
  if (!useTextures()) viewer.clearTextures();
  el.emptyState.classList.add('hidden');
  el.scene.classList.remove('hidden');
  el.crosshair.classList.remove('hidden');
  el.hud.classList.remove('hidden');
  el.hudRight.classList.remove('hidden');
  viewer.resize();
  viewer.start();

  try {
    const phases = {
      read: { from: 0, to: 35, label: 'Lettura dei chunk' },
      textures: { from: 35, to: 55, label: 'Lettura delle texture' },
      mesh: { from: 55, to: 100, label: 'Costruzione della geometria' },
    };
    const result = await engine.load(
      {
        dimId: state.dimension, box, hiddenBlocks: hiddenBlocks(),
        textured: useTextures(),
      },
      {
        onProgress: ({ phase, value }) => {
          const step = phases[phase] || phases.mesh;
          el.progressBar.style.width = `${(step.from + value * (step.to - step.from)).toFixed(0)}%`;
          setStatus(el.loadStatus, `${step.label}… ${(value * 100) | 0}%`);
        },
        onStream: (data) => {
          if (data.kind === 'textures') viewer.setTextures(data);
          else if (data.kind === 'column') viewer.addColumn(data);
        },
      });

    viewer.setVolume({
      blocks: result.blocks, states: result.states, names: result.names, props: result.props,
    });
    state.loaded = { box, result };

    const { chunks, missing, unparsed } = result.stats;
    const notes = [`${chunks} chunk`, `${(result.quads / 1000).toFixed(0)}k facce`];
    if (result.textured) notes.push(`${result.textureLayers} texture`);
    if (missing) notes.push(`${missing} chunk mai generati`);
    if (unparsed) notes.push(`${unparsed} illeggibili`);
    setStatus(el.loadStatus, notes.join(' · '), unparsed ? 'warn' : 'ok');

    el.panelView.classList.remove('hidden');
    el.cut.min = String(box.minY);
    el.cut.max = String(box.minY + box.sizeY);
    el.cut.value = String(box.minY + box.sizeY);
    el.cutLabel.textContent = '—';
    setStatus(el.viewStats,
      `${(viewer.triangles / 1000).toFixed(0)}k triangoli in ${viewer.meshes.length} mesh`);
  } catch (err) {
    setStatus(el.loadStatus, err.message, 'err');
  } finally {
    state.loading = false;
    el.load.disabled = false;
    el.progress.classList.add('hidden');
  }
}
// ------------------------------------------------------------------ la vista ---

function ensureViewer() {
  if (viewer) return;
  viewer = new Viewer(el.scene);
  viewer.onHud = updateHud;
  new ResizeObserver(() => viewer.resize()).observe(el.stage);
}

function updateHud(hud) {
  el.hudPos.innerHTML = `<b>${hud.x.toFixed(1)} ${hud.y.toFixed(1)} ${hud.z.toFixed(1)}</b>`
    + `  ·  ${hud.facing}`;
  el.hudLook.textContent = hud.target
    ? `${short(hud.target.name)} a ${hud.target.x} ${hud.target.y} ${hud.target.z}`
    : 'niente sotto il mirino';
  el.hudRight.textContent = `${hud.fps} fps`;
}

const short = (name) => String(name).replace(/^minecraft:/, '').replace(/_/g, ' ');
// -------------------------------------------------------------------- eventi ---

el.pickPack.onclick = async () => {
  if (supportsFileHandles) {
    try {
      await openPack(await pickPack());
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      // Fall through: some setups refuse the file picker.
    }
  }
  el.packInput.click();
};

el.packInput.onchange = () => {
  if (el.packInput.files && el.packInput.files.length) {
    openPack(packFromFileList(el.packInput.files));
  }
};

el.reopenPack.onclick = async () => {
  const found = await restoreLastPack({ prompt: true });
  if (!found || found.needsPermission) {
    setStatus(el.packStatus, 'Permesso negato: riscegli il file.', 'err');
    await forgetPack();
    return;
  }
  openPack(found.files);
};

el.centerX.onchange = () => setCenter(Number(el.centerX.value), state.center.z);
el.centerZ.onchange = () => setCenter(state.center.x, Number(el.centerZ.value));

el.spawn.onclick = () => {
  const spawn = (state.scan && state.scan.spawn) || { x: 0, z: 0 };
  setCenter(spawn.x, spawn.z);
};

el.player.onclick = async () => {
  const pos = await engine.player();
  if (!pos) { el.previewHint.textContent = 'Il salvataggio non registra dov\'eri.'; return; }
  setCenter(pos.x, pos.z);
};

el.radius.oninput = () => { refreshEstimate(); drawPreview(); };
el.radius.onchange = () => scheduleSurvey();

el.heightMode.onchange = () => {
  el.heightManual.classList.toggle('hidden', el.heightMode.value !== 'manual');
  if (el.heightMode.value === 'manual' && state.survey && state.survey.ground) {
    const lo = snapDown16(state.survey.ground.lo - 16);
    el.minY.value = String(lo);
    el.heightBlocks.value = String(Math.max(16, snapUp16(state.survey.ground.hi + 12) - lo));
  }
  refreshEstimate();
};
el.minY.onchange = refreshEstimate;
el.heightBlocks.onchange = refreshEstimate;

el.nudgeN.onclick = (e) => nudge(0, -1, e.shiftKey);
el.nudgeS.onclick = (e) => nudge(0, 1, e.shiftKey);
el.nudgeW.onclick = (e) => nudge(-1, 0, e.shiftKey);
el.nudgeE.onclick = (e) => nudge(1, 0, e.shiftKey);

el.preview.onclick = (event) => {
  if (!state.survey) return;
  const rect = el.preview.getBoundingClientRect();
  const fx = (event.clientX - rect.left) / rect.width;
  const fz = (event.clientY - rect.top) / rect.height;
  setCenter(
    state.survey.minX + fx * state.survey.width,
    state.survey.minZ + fz * state.survey.depth,
  );
};

el.load.onclick = loadPortion;

el.cut.oninput = () => {
  if (!viewer || !state.loaded) return;
  const y = Number(el.cut.value);
  const top = state.loaded.box.minY + state.loaded.box.sizeY;
  viewer.setCut(y >= top ? 1e6 : y);
  el.cutLabel.textContent = y >= top ? '—' : String(y);
};

/** Hand a file to the browser: the same dance for the PNG and the .glb. */
function save(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const worldName = () =>
  (state.scan ? state.scan.levelName.replace(/[^\w-]+/g, '_') : 'mondo');

el.exportGlb.onclick = async () => {
  if (!viewer || !state.loaded) return;
  el.exportGlb.disabled = true;
  setStatus(el.viewStats, 'Sto preparando il modello…');
  try {
    const glb = await viewer.exportGlb((done) => {
      setStatus(el.viewStats, `Sto preparando il modello… ${Math.round(done * 100)}%`);
    });
    if (!glb) { setStatus(el.viewStats, 'Non c\'è niente da esportare.', 'warn'); return; }
    save(new Blob([glb], { type: 'model/gltf-binary' }), `${worldName()}_3D.glb`);
    setStatus(el.viewStats,
      `Modello salvato — ${(glb.byteLength / (1024 * 1024)).toFixed(1)} MB.`, 'ok');
  } catch (err) {
    setStatus(el.viewStats, `Esportazione fallita: ${err.message}`, 'err');
  } finally {
    el.exportGlb.disabled = false;
  }
};

el.snapshot.onclick = async () => {
  if (!viewer) return;
  const blob = await viewer.snapshot();
  if (!blob) return;
  save(blob, `${worldName()}_3D.png`);
};

// ----------------------------------------------------------------- ingresso ---

/**
 * Wire the screen up. `host` is how main.js hands over what it already knows:
 * which folder the world came from and which dimension is selected.
 */
export function init(bridge) {
  host = bridge;
  refreshEstimate();
  (async () => {
    const lastPack = await restoreLastPack();
    if (!lastPack) return;
    if (lastPack.needsPermission) {
      el.reopenPack.classList.remove('hidden');
      el.reopenPack.textContent = `Riapri «${lastPack.names.join(' + ')}»`;
    } else {
      openPack(lastPack.files);
    }
  })();
}

/** Called every time the screen becomes visible. */
export async function show() {
  await syncWorld();
  if (viewer) viewer.resize();
}

/** Aim the portion somewhere — this is what "vedi in 3D" on the map calls. */
export async function focusOn(x, z) {
  if (!(await syncWorld())) return;
  setCenter(x, z);
}

/** The Editor closed or swapped the world: forget what we knew about it. */
export function worldChanged() {
  state.scan = null;
  state.init = null;
  state.survey = null;
}
