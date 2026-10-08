/*
 * Modello 3D — la sesta scheda dell'editor.
 *
 * Si inquadra una zona sulla mappa stessa (un riquadro che si trascina e si
 * ridimensiona, vedi selectionBox.js) e la si ricostruisce in tre dimensioni,
 * al posto della mappa (3e). La mappa intanto resta lì sotto, intatta: «Torna
 * alla mappa» la rimostra con il riquadro dove l'avevi lasciato.
 *
 * Non apre niente da sé: il mondo lo ha già aperto l'Editor, e questo modulo
 * riceve da main.js come raggiungerlo. Il worker però è un altro — quello
 * dell'Editor disegna tessere dall'alto, questo legge volumi e costruisce
 * triangoli — quindi il salvataggio va riaperto una volta sola sul suo.
 *
 * Il viewer sta in un contenitore sostituibile (mountViewer): oggi è l'area
 * della mappa, domani potrebbe essere una finestra flottante (3f) senza
 * toccare il resto.
 */

import { engine } from './engine3d.js';
import { Viewer } from './viewer3d.js';
import {
  supportsFileHandles, pickPack, restoreLastPack, packFromFileList, forgetPack,
} from './packPicker.js';
import { toLatLng, fromLatLng } from './ui-core.js';
import { createSelection } from './selectionBox.js';
import {
  boxAround, centerOf, moveBox, growBox, recommendedSide, PRESETS,
} from './boxMath.js';

const $ = (id) => document.getElementById(id);

const el = {
  pickPack: $('btn-pick-pack'), reopenPack: $('btn-reopen-pack'), packInput: $('pack-input'),
  packHint: $('pack-hint'), packStatus: $('pack-status'),
  packToggleRow: $('pack-toggle-row'), packToggle: $('pack-toggle'),
  hiddenBlocks: $('a3d-block-custom'),
  worldNote: $('a3d-world-note'), badge: $('a3d-badge'),
  setup: $('a3d-setup'), ready: $('a3d-ready'),
  rec: $('a3d-rec'), size: $('a3d-size'), minus: $('a3d-minus'), plus: $('a3d-plus'),
  presets: $('a3d-presets'), center: $('a3d-center'), height: $('a3d-height'),
  heightMode: $('height-mode'), heightManual: $('height-manual'),
  minY: $('min-y'), heightBlocks: $('height-blocks'), heightLabel: $('height-label'),
  estimate: $('estimate'), load: $('btn-load'), loadStatus: $('load-status'),
  review: $('a3d-review'),
  minimap: $('a3d-minimap'), miniCap: $('a3d-mini-cap'),
  cut: $('cut'), cutLabel: $('cut-label'), snapshot: $('btn-snapshot'),
  exportGlb: $('btn-export'), viewStats: $('view-stats'), changeZone: $('a3d-change-zone'),
  stage: $('a3d-stage'), scene: $('scene'), crosshair: $('crosshair'),
  hud: $('hud'), hudPos: $('hud-pos'), hudLook: $('hud-look'), hudRight: $('hud-right'),
  backMap: $('a3d-back-map'),
  progress: $('progress'), progressBar: $('progress-bar'), progressLbl: $('a3d-loading-lbl'),
};

const RECOMMENDED = recommendedSide();

const state = {
  scan: null,          // the world as this module's own worker sees it
  init: null,          // how the Editor reached that world
  dimension: null,
  box: null,           // { minX, minZ, sizeX, sizeZ }, multiples of 16
  survey: null,
  surveying: false,
  loading: false,
  loaded: null,        // { box, result } of the model in memory
  pack: null,          // names of the archives the textures come from
  packRemembered: false,
  tabActive: false,
  viewerShown: false,
};

let viewer = null;
let host = null;       // the bridge back to main.js
let opening = null;    // the in-flight openWorld, so two entries share one
let selection = null;
let container = null;  // where the viewer is mounted (mountViewer)

// --------------------------------------------------------------- utilities ---

const snapDown16 = (v) => Math.floor(v / 16) * 16;
const snapUp16 = (v) => Math.ceil(v / 16) * 16;
const fmt = (n) => Math.round(n).toLocaleString('it-IT');

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

/** The vertical range: what the user set, or the ground plus some sky. */
function heightRange() {
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
  return { minY, sizeY: Math.min(384, maxY - minY) };
}

/** The box to read: the map selection plus the height range. */
function currentBox() {
  const b = state.box || boxAround(0, 0, RECOMMENDED);
  const { minY, sizeY } = heightRange();
  return { minX: b.minX, minZ: b.minZ, sizeX: b.sizeX, sizeZ: b.sizeZ, minY, sizeY };
}

// Above this the read is slow and the browser may run out of memory before
// it finishes, so loading asks first instead of just starting.
const HUGE_BLOCKS = 120e6;
const BIG_BLOCKS = 28e6;

/*
 * How fast this computer reads and meshes, in blocks per second. It starts
 * from a cautious guess and is replaced by the real figure after the first
 * model, so the "circa N s" next to the button becomes honest quickly.
 */
const RATE_KEY = 'cube-atlas-3d-rate';
function readRate() {
  try { return Number(localStorage.getItem(RATE_KEY)) || 450000; } catch { return 450000; }
}
function writeRate(rate) {
  try { localStorage.setItem(RATE_KEY, String(Math.round(rate))); } catch { /* ignore */ }
}

function refreshUI() {
  const box = currentBox();
  const c = centerOf(box);
  el.size.textContent = `${box.sizeX} × ${box.sizeZ}`;
  el.center.textContent = `${Math.round(c.x)}, ${Math.round(c.z)}`;
  el.height.textContent = `${el.heightMode.value === 'manual' ? 'Manuale' : 'Auto'} · Y ${box.minY} → ${box.minY + box.sizeY}`;
  el.heightLabel.textContent = String(box.sizeY);
  el.presets.querySelectorAll('button').forEach((b) => {
    const n = Number(b.dataset.side);
    b.classList.toggle('active', box.sizeX === n && box.sizeZ === n);
  });

  const blocks = box.sizeX * box.sizeY * box.sizeZ;
  const chunks = (box.sizeX * box.sizeZ) / 256;
  const secs = Math.max(1, Math.round(blocks / readRate()));
  let text = `≈ ${fmt(chunks)} chunk · ${(blocks / 1e6).toLocaleString('it-IT', { maximumFractionDigits: 1 })} M blocchi · circa ${secs} s`;
  let kind = '';
  if (blocks > HUGE_BLOCKS) {
    text += '. Enorme: può esaurire la memoria del browser.';
    kind = 'err';
  } else if (blocks > BIG_BLOCKS) {
    text += '. È tanto: preparati ad aspettare.';
    kind = 'warn';
  }
  setStatus(el.estimate, text, kind);
}

// ----------------------------------------------------------------- il mondo ---

/**
 * Catch up with the world the Editor has open.
 *
 * The scan is cheap but not free, so it only happens when the folder or the
 * dimension actually changed — entering the tab a second time on the same
 * world costs nothing.
 */
async function syncWorld() {
  if (!host) return false;
  const init = host.getWorldInit();
  const dimension = host.getDimension();
  if (!init) {
    el.setup.classList.add('hidden');
    el.worldNote.textContent = 'Apri prima un mondo: il modello si costruisce da quello.';
    el.worldNote.classList.remove('hidden');
    return false;
  }
  if (state.init === init && state.dimension === dimension && state.scan) {
    el.worldNote.classList.add('hidden');
    if (!state.viewerShown) el.setup.classList.remove('hidden');
    return true;
  }
  if (opening) return opening;

  el.worldNote.textContent = 'Sto aprendo il mondo…';
  el.worldNote.classList.remove('hidden');
  opening = (async () => {
    try {
      const scan = await engine.openWorld(init);
      if (!scan.ok) {
        el.worldNote.textContent = scan.error || 'Mondo non leggibile.';
        return false;
      }
      state.scan = scan;
      state.init = init;
      state.dimension = scan.dimensions.some((d) => d.id === dimension)
        ? dimension : scan.dimensions[0].id;
      state.survey = null;
      nameTheJar(scan.version);
      el.worldNote.classList.add('hidden');
      if (!state.viewerShown) el.setup.classList.remove('hidden');
      scheduleSurvey();
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
  if (!version || state.pack) return;
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

async function openPack(files, { remembered = false } = {}) {
  if (!files || !files.length) return;
  setStatus(el.packStatus, 'Sto aprendo l\'archivio…');
  try {
    const result = await engine.openPack(files);
    state.pack = result.names;
    state.packRemembered = remembered;
    el.packStatus.className = '';
    el.packStatus.textContent = `Texture: ${result.names.join(' + ')} ✓`;
    el.pickPack.textContent = remembered ? 'ricordato · cambia' : 'cambia';
    el.reopenPack.classList.add('hidden');
    el.packHint.classList.add('hidden');
    el.packToggleRow.classList.remove('hidden');
    el.packToggle.checked = true;
  } catch (err) {
    setStatus(el.packStatus, err.message, 'err');
  }
}

// ------------------------------------------------- la zona (riquadro + rilievo) ---

let surveyTimer = null;

function scheduleSurvey() {
  clearTimeout(surveyTimer);
  surveyTimer = setTimeout(runSurvey, 350);
}

/**
 * A top-down read of the zone, a little wider than the box. It gives the
 * ground height the automatic range is derived from, and the picture for the
 * mini-map shown next to a finished model.
 */
async function runSurvey() {
  if (!state.scan || !state.box) return;
  if (state.surveying) { scheduleSurvey(); return; }
  const box = state.box;
  const side = Math.max(box.sizeX, box.sizeZ);
  const span = Math.max(side, Math.min(1024, Math.max(256, snapUp16(side * 1.6))));
  const c = centerOf(box);
  state.surveying = true;
  try {
    state.survey = await engine.survey({
      dimId: state.dimension,
      minX: snapDown16(c.x - span / 2), minZ: snapDown16(c.z - span / 2),
      width: span, depth: span,
      hiddenBlocks: hiddenBlocks(),
      focus: { minX: box.minX, minZ: box.minZ, width: box.sizeX, depth: box.sizeZ },
    });
  } catch {
    state.survey = null;
  } finally {
    state.surveying = false;
    refreshUI();
  }
}

function drawMinimap(box) {
  const canvas = el.minimap;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const survey = state.survey;
  const c = centerOf(box);
  el.miniCap.textContent = `${Math.round(c.x)}, ${Math.round(c.z)} · ${box.sizeX}×${box.sizeZ}`;
  if (!survey) return;
  const bitmap = document.createElement('canvas');
  bitmap.width = survey.width; bitmap.height = survey.depth;
  bitmap.getContext('2d').putImageData(new ImageData(survey.rgba, survey.width, survey.depth), 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const k = canvas.width / survey.width;
  const x = (box.minX - survey.minX) * k, z = (box.minZ - survey.minZ) * k;
  const w = box.sizeX * k, h = box.sizeZ * k;
  ctx.fillStyle = 'rgba(0,0,0,.45)';
  ctx.fillRect(0, 0, canvas.width, z);
  ctx.fillRect(0, z + h, canvas.width, canvas.height - z - h);
  ctx.fillRect(0, z, x, h);
  ctx.fillRect(x + w, z, canvas.width - x - w, h);
  ctx.strokeStyle = '#7fd44f';
  ctx.lineWidth = 3;
  ctx.strokeRect(x + 1.5, z + 1.5, w - 3, h - 3);
}

function ensureSelection() {
  if (selection) return selection;
  const map = host && host.getMap();
  if (!map) return null;
  selection = createSelection(map, {
    toLatLng, fromLatLng,
    onChange: (box, { dragging }) => {
      state.box = box;
      refreshUI();
      if (!dragging) scheduleSurvey();
    },
    onCreate: () => create(),
  });
  return selection;
}

/** The box: from the map, the sidebar or a shortcut — always through here. */
export function setBox(box) {
  state.box = { minX: box.minX, minZ: box.minZ, sizeX: box.sizeX, sizeZ: box.sizeZ };
  if (selection) selection.set(state.box);
  refreshUI();
  scheduleSurvey();
}

export function getBox() {
  return state.box ? { ...state.box } : null;
}

/** Put the box on a point, keeping its size (the map's «vedi in 3D»). */
export function focusOn(x, z) {
  const b = state.box;
  setBox(boxAround(x, z, b ? b.sizeX : RECOMMENDED, b ? b.sizeZ : RECOMMENDED));
  if (selection) selection.reveal();
}

// -------------------------------------------------------------- il viewer ---

/**
 * Put the viewer in a container. The default is the map area (3e); a
 * floating window (3f) would only need to call this with its own element.
 */
export function mountViewer(node) {
  container = node;
  if (el.stage.parentElement !== node) node.appendChild(el.stage);
}

function showViewer() {
  if (!container) mountViewer(el.stage.parentElement);
  state.viewerShown = true;
  container.classList.add('showing-3d');
  el.stage.classList.remove('hidden');
  if (selection) selection.hide();
  el.setup.classList.add('hidden');
  el.ready.classList.remove('hidden');
  el.badge.classList.remove('hidden');
  ensureViewer();
  viewer.resize();
  viewer.start();
}

/** Back to the map, with the box where it was. */
export function backToMap() {
  if (!state.viewerShown) return;
  state.viewerShown = false;
  document.dispatchEvent(new CustomEvent('a3d:viewer-hidden'));
  el.stage.classList.add('hidden');
  if (container) container.classList.remove('showing-3d');
  if (viewer) viewer.stop();
  el.ready.classList.add('hidden');
  el.badge.classList.add('hidden');
  el.setup.classList.remove('hidden');
  el.review.classList.toggle('hidden', !state.loaded);
  const map = host && host.getMap();
  if (map) setTimeout(() => map.invalidateSize(), 30);
  if (state.tabActive && selection && state.box) selection.show(state.box);
}

export const isViewerShown = () => state.viewerShown;

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

// -------------------------------------------------------------- il caricamento ---

/** «Crea modello 3D»: read the box and show it in place of the map. */
export async function create() {
  if (state.loading) return;
  if (!(await syncWorld())) return;
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
  setStatus(el.loadStatus, '');
  showViewer();
  viewer.reset(box);
  if (!useTextures()) viewer.clearTextures();
  el.cut.disabled = true;
  el.progress.classList.remove('hidden');
  el.progressBar.style.width = '0%';
  el.progressLbl.textContent = 'Lettura del salvataggio…';
  drawMinimap(box);
  const started = performance.now();

  try {
    const phases = {
      read: { from: 0, to: 35, label: 'Lettura dei chunk' },
      textures: { from: 35, to: 55, label: 'Lettura delle texture' },
      mesh: { from: 55, to: 100, label: 'Costruzione della geometria' },
    };
    const result = await engine.load(
      { dimId: state.dimension, box, hiddenBlocks: hiddenBlocks(), textured: useTextures() },
      {
        onProgress: ({ phase, value }) => {
          const step = phases[phase] || phases.mesh;
          el.progressBar.style.width = `${(step.from + value * (step.to - step.from)).toFixed(0)}%`;
          el.progressLbl.textContent = `${step.label}… ${(value * 100) | 0}%`;
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
    writeRate(blocks / Math.max(0.5, (performance.now() - started) / 1000));

    el.cut.min = String(box.minY);
    el.cut.max = String(box.minY + box.sizeY);
    el.cut.value = String(box.minY + box.sizeY);
    el.cutLabel.textContent = '—';
    const { chunks, missing, unparsed } = result.stats;
    const tris = viewer.triangles;
    const notes = [`${fmt(chunks)} chunk`, tris >= 1e6
      ? `${(tris / 1e6).toLocaleString('it-IT', { maximumFractionDigits: 1 })} M triangoli`
      : `${fmt(tris / 1000)}k triangoli`];
    if (result.textured) notes.push(`${result.textureLayers} texture`);
    if (missing) notes.push(`${missing} chunk mai generati`);
    if (unparsed) notes.push(`${unparsed} illeggibili`);
    setStatus(el.viewStats, notes.join(' · '), unparsed ? 'warn' : '');
    drawMinimap(box);
  } catch (err) {
    setStatus(el.viewStats, err.message, 'err');
    setStatus(el.loadStatus, err.message, 'err');
  } finally {
    state.loading = false;
    el.load.disabled = false;
    el.cut.disabled = false;
    el.progress.classList.add('hidden');
    refreshUI();
  }
}

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
  openPack(found.files, { remembered: true });
};

const resize = (delta) => { if (state.box) setBox(growBox(state.box, delta)); };
el.minus.onclick = () => resize(-16);
el.plus.onclick = () => resize(16);

el.presets.innerHTML = PRESETS.map((n) => (
  `<button class="btn btn-sm${n >= 512 ? ' m3-warn' : ''}${n === RECOMMENDED ? ' m3-recommended' : ''}" data-side="${n}">${n}${n >= 512 ? ' ⚠' : ''}</button>`
)).join('');
el.presets.querySelectorAll('button').forEach((b) => {
  b.onclick = () => {
    const c = state.box ? centerOf(state.box) : { x: 0, z: 0 };
    setBox(boxAround(c.x, c.z, Number(b.dataset.side)));
  };
});
el.rec.textContent = `${RECOMMENDED} consigliato per questo computer`;

el.heightMode.onchange = () => {
  el.heightManual.classList.toggle('hidden', el.heightMode.value !== 'manual');
  if (el.heightMode.value === 'manual' && state.survey && state.survey.ground) {
    const lo = snapDown16(state.survey.ground.lo - 16);
    el.minY.value = String(lo);
    el.heightBlocks.value = String(Math.max(16, snapUp16(state.survey.ground.hi + 12) - lo));
  }
  refreshUI();
};
el.minY.onchange = refreshUI;
el.heightBlocks.onchange = refreshUI;
el.hiddenBlocks.onchange = scheduleSurvey;

el.load.onclick = () => create();
el.review.onclick = () => { if (state.loaded) showViewer(); };
el.backMap.onclick = () => backToMap();
el.changeZone.onclick = () => backToMap();

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
  if (!viewer || !state.viewerShown) return;
  const blob = await viewer.snapshot();
  if (!blob) return;
  save(blob, `${worldName()}_3D.png`);
};

// ----------------------------------------------------------------- ingresso ---

/**
 * Wire the tab up. `bridge` is how main.js hands over what it already knows:
 * which folder the world came from, which dimension is selected, the map.
 */
export function init(bridge) {
  host = bridge;
  mountViewer(el.stage.parentElement);
  refreshUI();
  (async () => {
    const lastPack = await restoreLastPack();
    if (!lastPack) return;
    if (lastPack.needsPermission) {
      el.reopenPack.classList.remove('hidden');
      el.reopenPack.textContent = `riapri «${lastPack.names.join(' + ')}»`;
    } else {
      openPack(lastPack.files, { remembered: true });
    }
  })();
}

/** The «Modello 3D» tab became active: show the box on the map. */
export async function openTab() {
  state.tabActive = true;
  if (!(await syncWorld()) || !state.tabActive) return;
  if (state.viewerShown) return;
  const sel = ensureSelection();
  if (!sel) return;
  if (!state.box) {
    const map = host.getMap();
    const c = fromLatLng(map.getCenter());
    state.box = boxAround(c.x, c.z, RECOMMENDED);
  }
  sel.show(state.box);
  if (container) container.classList.add('sel-mode');
  refreshUI();
  scheduleSurvey();
}

/** Another tab was chosen: the map comes back, the box goes away. */
export function closeTab() {
  state.tabActive = false;
  if (container) container.classList.remove('sel-mode');
  if (state.viewerShown) backToMap();
  if (selection) selection.hide();
}

/**
 * Keys while the tab is active. Returns what happened so the caller can stop
 * the event: 'handled', 'exit' (Esc: leave the tab) or null.
 */
export function handleKey(e) {
  if (!state.tabActive) return null;
  if (state.viewerShown) {
    if (e.key === 'Escape') { backToMap(); return 'handled'; }
    return null;
  }
  if (!state.box) return null;
  const step = (side) => (e.shiftKey ? side : 16);
  const moves = {
    ArrowLeft: [-step(state.box.sizeX), 0], ArrowRight: [step(state.box.sizeX), 0],
    ArrowUp: [0, -step(state.box.sizeZ)], ArrowDown: [0, step(state.box.sizeZ)],
  };
  if (moves[e.key]) {
    setBox(moveBox(state.box, ...moves[e.key]));
    if (selection) selection.reveal();
    return 'handled';
  }
  if (e.key === '+' || e.key === '=') { resize(16); return 'handled'; }
  if (e.key === '-' || e.key === '_') { resize(-16); return 'handled'; }
  if (e.key === 'Enter') { create(); return 'handled'; }
  if (e.key === 'Escape') return 'exit';
  return null;
}

/** The Editor closed or swapped the world: forget what we knew about it. */
export function worldChanged() {
  state.scan = null;
  state.init = null;
  state.survey = null;
  state.box = null;
  if (state.viewerShown) backToMap();
  if (selection) selection.hide();
}
