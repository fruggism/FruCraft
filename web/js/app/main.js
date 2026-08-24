/*
 * Cube-Atlas — app shell: screen switching, picking the world, project
 * lifecycle, the layer list, map generation and every sidebar control.
 *
 * There is no server: the world is read in a Web Worker and the projects live
 * in IndexedDB.
 */

import {
  state, el, escapeHtml, toast, debounce, setStatus, markDirty, fromLatLng,
  confirmDialog, promptDialog, pickDialog, download, slugify, newId, engine, projects,
} from './ui-core.js';
import * as Atlas from './atlas.js';
import * as Archive from './archive.js';
import * as Reader from './reader.js';
import {
  supportsHandles, pickDirectory, restoreLastWorld, sourceFromFileList, pickerHint, forgetWorld,
} from './worldPicker.js';
import { getInterfaceMode, setInterfaceMode } from './interfaceMode.js';

const LAYER_ICONS = { roads: '🛣️', pois: '📍', areas: '⬟', transit: '🚇', notes: '📝' };
const LAYER_KIND_LABEL = { roads: 'Strade', pois: 'Punti', areas: 'Aree', transit: 'Trasporti', notes: 'Note' };

// The description of the currently open folder, kept so a project reopened
// later can be matched against the world actually loaded in the worker.
let openWorldInit = null;

// ---------------------------------------------------------------- screens
// The app is really two programs sharing one page: the Editor (Atlante +
// Archivio, everything that touches a world/project) and the Lettore, a
// standalone viewer for files the Editor has already exported. Switching
// mode never touches world/project state — only which screen is visible.
let lastEditorScreen = 'atlas';
let lastReaderScreen = 'reader-atlas';

function showScreen(name) {
  // Scoped to the sub-tabs, not a bare `.tab`: the mode tabs are also `.tab`
  // elements but have no `data-screen`, so a bare selector here would wrongly
  // clear their active state on every screen switch.
  document.querySelectorAll('#editor-tabs .tab, #reader-tabs .tab').forEach((t) => (
    t.classList.toggle('active', t.dataset.screen === name)
  ));
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${name}`));
  if (name === 'atlas' || name === 'archive') lastEditorScreen = name;
  if (name === 'reader-atlas' || name === 'reader-archive') lastReaderScreen = name;
  if (name === 'atlas' && Atlas.getMap()) setTimeout(() => Atlas.getMap().invalidateSize(), 60);
  if (name === 'archive') Archive.renderList();
}

function setMode(mode) {
  document.querySelectorAll('#mode-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
  el('editor-tabs').classList.toggle('hidden', mode !== 'editor');
  el('reader-tabs').classList.toggle('hidden', mode !== 'reader');
  el('mode-label').textContent = mode === 'reader' ? ' Lettore' : ' Editor';
  showScreen(mode === 'reader' ? lastReaderScreen : lastEditorScreen);
}

// ------------------------------------------------------------------ world
async function openWorldFromInit(init, { silent = false } = {}) {
  if (!silent) setStatus('world-status', 'Lettura del salvataggio…', 'busy');
  el('world-details').classList.add('hidden');
  el('world-picks').classList.add('hidden');
  try {
    const scan = await engine.openWorld(init);
    if (!scan.ok) {
      setStatus('world-status', scan.error, 'err');
      if (Array.isArray(scan.candidates) && scan.candidates.length) showCandidates(init, scan.candidates);
      return null;
    }
    openWorldInit = init;
    state.world = scan;
    fillDimensions(scan);
    el('world-details').classList.remove('hidden');
    // The filter now lives here, before the atlas exists, so it needs its
    // own defaults rather than reading a project that may not be open yet.
    renderBlockFilter();
    const mb = (scan.dimensions.reduce((n, d) => n + d.bytes, 0) / 1048576).toFixed(0);
    setStatus('world-status',
      `${scan.levelName}${scan.version ? ` (${scan.version})` : ''} — ${mb} MB di regioni`, 'ok');
    return scan;
  } catch (err) {
    setStatus('world-status', err.message, 'err');
    return null;
  }
}

function fillDimensions(scan) {
  el('world-dimension').innerHTML = scan.dimensions.map((d) => {
    const w = d.bounds.maxX - d.bounds.minX + 1;
    const h = d.bounds.maxZ - d.bounds.minZ + 1;
    const size = w >= 2000 || h >= 2000
      ? `estensione ~${Math.round(w / 1000)}k×${Math.round(h / 1000)}k blocchi`
      : `${w}×${h} blocchi`;
    return `<option value="${escapeHtml(d.id)}">${escapeHtml(d.label)} — ${d.regionCount} regioni, ${size}</option>`;
  }).join('');
}

/** When the picked folder holds several worlds, offer them. */
function showCandidates(init, list) {
  const host = el('world-picks');
  host.classList.remove('hidden');
  host.innerHTML = '<div class="hint">Mondi trovati in questa cartella:</div>' + list.map((w, i) => (
    `<div class="world-pick" data-index="${i}"><b>${escapeHtml(w.name)}</b><small>${escapeHtml(w.path)}</small></div>`
  )).join('');
  host.querySelectorAll('.world-pick').forEach((node) => {
    node.addEventListener('click', async () => {
      const chosen = list[Number(node.dataset.index)];
      const scoped = await narrowInit(init, chosen.path);
      if (scoped) openWorldFromInit(scoped);
    });
  });
}

/** Re-root a picked folder onto one of its sub-worlds. */
async function narrowInit(init, subPath) {
  if (init.kind === 'files') {
    const files = new Map();
    const prefix = `${subPath}/`;
    for (const [path, file] of init.files) {
      if (path.startsWith(prefix)) files.set(path.slice(prefix.length), file);
    }
    return { kind: 'files', files, name: subPath };
  }
  try {
    let handle = init.handle;
    for (const part of subPath.split('/')) handle = await handle.getDirectoryHandle(part);
    return { kind: 'handle', handle, name: subPath };
  } catch (err) {
    setStatus('world-status', `Impossibile aprire "${subPath}": ${err.message}`, 'err');
    return null;
  }
}

async function pickWorld() {
  if (supportsHandles) {
    try {
      const init = await pickDirectory();
      await openWorldFromInit(init);
      el('btn-reopen-world').classList.add('hidden');
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return; // user closed the picker
      // Fall through to the input-based picker if the API refused.
      setStatus('world-status', `Selezione non riuscita (${err.message}); provo il metodo alternativo.`, 'busy');
    }
  }
  el('world-input').click();
}

async function reopenLastWorld() {
  const restored = await restoreLastWorld({ prompt: true });
  if (!restored) {
    el('btn-reopen-world').classList.add('hidden');
    return;
  }
  if (restored.needsPermission) {
    setStatus('world-status', 'Permesso negato: scegli di nuovo la cartella.', 'err');
    return;
  }
  await openWorldFromInit(restored);
  el('btn-reopen-world').classList.add('hidden');
}

// ---------------------------------------------------------------- project
async function refreshProjectList(selectId) {
  try {
    const list = await projects.listProjects();
    el('project-list').innerHTML = '<option value="">— nessuno —</option>' + list.map((p) => (
      `<option value="${p.id}">${escapeHtml(p.name)} (${p.featureCount} elem.)</option>`
    )).join('');
    if (selectId) el('project-list').value = selectId;
  } catch (err) {
    setStatus('save-status', err.message, 'err');
  }
}

async function createProject() {
  if (!state.world) { toast('Scegli prima un mondo', 'err'); return; }
  const dimension = el('world-dimension').value;
  const name = await promptDialog({
    title: 'Nuovo atlante',
    message: 'Come vuoi chiamarlo?',
    value: state.world.levelName || 'Il mio atlante',
    confirmLabel: 'Crea',
  });
  if (name === null) return;
  try {
    const project = await projects.createProject({
      name: name.trim() || 'Il mio atlante',
      world: {
        id: state.world.worldKey,
        dimension,
        levelName: state.world.levelName,
        path: '',
      },
      // The filter is chosen before the atlas exists (section "1 Mondo"),
      // so a brand-new atlas starts already generating with it applied.
      settings: { hiddenBlocks: currentHiddenBlocks() },
    });
    await openProject(project);
    await refreshProjectList(project.id);
    toast('Atlante creato', 'ok');
  } catch (err) {
    setStatus('save-status', err.message, 'err');
  }
}

async function openProjectById(id) {
  if (!id) return;
  const project = await projects.getProject(id);
  if (!project) { setStatus('save-status', 'Progetto non trovato', 'err'); return; }
  await openProject(project);
}

async function openProject(project) {
  state.project = project;
  state.selectedLayerId = project.layers.length ? project.layers[0].id : null;
  state.selectedFeature = null;

  el('project-name').value = project.name;
  el('project-name').disabled = false;

  if (!state.world) {
    el('map-overlay').classList.remove('hidden');
    el('map-overlay').querySelector('.inner').innerHTML =
      `<h3>Scegli di nuovo il mondo</h3>
       <p>L'atlante <b>${escapeHtml(project.name)}</b> è salvato, ma il browser non può
       rileggere la cartella del salvataggio senza il tuo permesso.</p>
       <p>Usa <b>Scegli la cartella del mondo…</b> nel pannello a sinistra.</p>`;
    el('topbar-info').innerHTML = `<span>${escapeHtml(project.name)}</span> · mondo non aperto`;
    renderLayerList();
    Archive.onProjectLoaded();
    return;
  }

  const dim = state.world.dimensions.find((d) => d.id === project.world.dimension)
    || state.world.dimensions[0];
  project.world.dimension = dim.id;
  el('topbar-info').innerHTML =
    `<span>${escapeHtml(project.name)}</span> · ${escapeHtml(state.world.levelName || '')} · ${escapeHtml(dim.label)}`;

  el('chk-terrain').checked = project.settings.showTerrain !== false;
  el('chk-rails').checked = project.settings.showRails === true;
  renderBlockFilter();
  // The worker has to know the filter before the first tile is asked for.
  await engine.setRenderSettings({ hiddenBlocks: project.settings.hiddenBlocks || [] });
  Atlas.attachWorld(state.world, dim.id, project.view);
  Atlas.renderAllLayers();
  Atlas.setTerrainVisible(el('chk-terrain').checked);
  Atlas.refreshProps();
  renderLayerList();
  Archive.onProjectLoaded();
  setStatus('save-status', 'Atlante aperto', 'ok');

  const spawn = state.world.spawn || { x: 0, z: 0 };
  el('render-x').value = Math.round(spawn.x);
  el('render-z').value = Math.round(spawn.z);
  el('goto-x').value = Math.round(spawn.x);
  el('goto-z').value = Math.round(spawn.z);
  updateRenderEstimate();
  pollRenderStatus();
}

async function deleteProject() {
  const id = el('project-list').value;
  if (!id) return;
  const ok = await confirmDialog({
    title: "Eliminare l'atlante?",
    message: 'Verranno persi i layer e i documenti che contiene. Il mondo non viene toccato.',
    confirmLabel: 'Elimina', danger: true,
  });
  if (!ok) return;
  await projects.deleteProject(id);
  if (state.project && state.project.id === id) {
    state.project = null;
    el('project-name').value = '';
    el('project-name').disabled = true;
    el('topbar-info').textContent = 'Nessun progetto aperto';
    el('map-overlay').classList.remove('hidden');
    Atlas.renderAllLayers();
    renderLayerList();
    Archive.onProjectLoaded();
  }
  await refreshProjectList();
  toast('Atlante eliminato');
}

function exportProject() {
  if (!state.project) { toast('Apri prima un atlante', 'err'); return; }
  download(`${slugify(state.project.name)}.cubeatlas.json`,
    JSON.stringify(state.project, null, 2), 'application/json');
  toast('Progetto esportato', 'ok');
}

async function onImportFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const project = await projects.importProject(JSON.parse(await file.text()), ' (importato)');
    await openProject(project);
    await refreshProjectList(project.id);
    toast('Progetto importato', 'ok');
  } catch (err) {
    setStatus('save-status', `Import fallito: ${err.message}`, 'err');
    toast(`Import fallito: ${err.message}`, 'err');
  } finally {
    e.target.value = '';
  }
}

// ----------------------------------------------------------------- layers
/** Flatten the layer list into a depth-first order, honouring `parentId`, so
 *  a "quartiere" can list "strade"/"trasporti"/"edifici" nested under it.
 *  A layer whose parent doesn't exist (or was just deleted) is shown as a
 *  root rather than disappearing. */
function layerTree() {
  const layers = state.project.layers;
  const byParent = new Map();
  for (const l of layers) {
    const key = l.parentId || '';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(l);
  }
  const order = [];
  const visit = (parentKey, depth) => {
    for (const l of byParent.get(parentKey) || []) {
      order.push({ layer: l, depth });
      visit(l.id, depth + 1);
    }
  };
  visit('', 0);
  const seen = new Set(order.map((o) => o.layer.id));
  for (const l of layers) if (!seen.has(l.id)) order.push({ layer: l, depth: 0 });
  return order;
}

function renderLayerList() {
  const host = el('layer-list');
  if (!state.project) { host.innerHTML = ''; updateToolAvailability(); return; }

  host.innerHTML = layerTree().map(({ layer, depth }) => `
    <li class="layer-item ${layer.id === state.selectedLayerId ? 'selected' : ''}" data-id="${layer.id}" style="padding-left:${7 + depth * 16}px">
      <span class="eye ${layer.visible === false ? 'off' : ''}" data-eye="${layer.id}" title="Mostra/nascondi">👁</span>
      <span class="kind" title="${LAYER_KIND_LABEL[layer.type]}">${LAYER_ICONS[layer.type]}</span>
      <span class="lname">${escapeHtml(layer.name)}</span>
      <span class="count">${layer.features.length}</span>
      <span class="sub" data-sub="${layer.id}" title="Nuovo sublayer">➕</span>
      <span class="kill" data-kill="${layer.id}" title="Elimina questo layer">🗑</span>
    </li>`).join('');

  host.querySelectorAll('.layer-item').forEach((node) => {
    node.addEventListener('click', (e) => {
      if (e.target.dataset.eye || e.target.dataset.kill || e.target.dataset.sub) return;
      selectLayer(node.dataset.id);
    });
  });
  host.querySelectorAll('.kill').forEach((node) => {
    node.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteLayer(node.dataset.kill);
    });
  });
  host.querySelectorAll('.sub').forEach((node) => {
    node.addEventListener('click', (e) => {
      e.stopPropagation();
      addSubLayer(node.dataset.sub);
    });
  });
  host.querySelectorAll('.eye').forEach((node) => {
    node.addEventListener('click', (e) => {
      e.stopPropagation();
      const layer = state.project.layers.find((l) => l.id === node.dataset.eye);
      if (!layer) return;
      layer.visible = layer.visible === false;
      Atlas.applyLayerVisibility();
      markDirty();
      renderLayerList();
    });
  });

  const layer = state.project.layers.find((l) => l.id === state.selectedLayerId);
  el('layer-edit').classList.toggle('hidden', !layer);
  if (layer) el('layer-name').value = layer.name;
  updateToolAvailability();
}

function selectLayer(id) {
  state.selectedLayerId = id;
  Atlas.setTool('select');
  renderLayerList();
  const layer = state.project && state.project.layers.find((l) => l.id === id);
  if (layer && layer.type === 'transit') Atlas.openLineVisibilityMenu(layer);
}

function updateToolAvailability() {
  const layer = state.project && state.project.layers.find((l) => l.id === state.selectedLayerId);
  for (const id of ['tool-draw', 'tool-edit', 'tool-delete']) el(id).disabled = !layer;
  if (layer) {
    el('tool-draw-label').textContent = {
      roads: 'Traccia strada', pois: 'Aggiungi punto', areas: 'Disegna area',
      transit: 'Traccia linea', notes: 'Aggiungi nota',
    }[layer.type];
    el('tool-draw-ico').textContent = LAYER_ICONS[layer.type];
    const isPoint = layer.type === 'pois' || layer.type === 'notes';
    el('tool-edit').disabled = isPoint; // points move by dragging
    el('tool-hint').textContent = isPoint
      ? 'I punti si spostano trascinandoli. Usa "Cancella" e poi clicca per eliminare.'
      : 'Disegna un nuovo elemento, oppure selezionane uno e usa "Modifica nodi" per spostarne i vertici.';
  } else {
    el('tool-draw-label').textContent = 'Disegna';
    el('tool-hint').textContent = 'Seleziona un layer per attivare gli strumenti.';
  }
  const isTransit = !!layer && layer.type === 'transit';
  el('transit-layer-tools').classList.toggle('hidden', !isTransit);
  el('btn-new-independent-station').classList.toggle('hidden', !isTransit);
  if (isTransit) {
    const style = layer.defaultStyle || {};
    el('station-shape').value = style.stationShape || 'circle';
    const size = Number(style.stationSize) || 14;
    el('station-size').value = size;
    el('station-size-v').textContent = size;
  }
}

function pickLayerType() {
  return pickDialog({
    title: 'Tipo di layer',
    options: [
      { value: 'roads', label: `${LAYER_ICONS.roads} Strade` },
      { value: 'transit', label: `${LAYER_ICONS.transit} Trasporti` },
      { value: 'pois', label: `${LAYER_ICONS.pois} Punti di interesse` },
      { value: 'notes', label: `${LAYER_ICONS.notes} Note` },
      { value: 'areas', label: `${LAYER_ICONS.areas} Aree` },
    ],
  });
}

async function addLayer(type) {
  if (!state.project) { toast('Apri prima un atlante', 'err'); return; }
  const name = await promptDialog({
    title: `Nuovo layer — ${LAYER_KIND_LABEL[type]}`,
    message: 'Nome del layer',
    value: LAYER_KIND_LABEL[type],
    confirmLabel: 'Crea',
  });
  if (name === null) return;
  const layer = projects.makeLayer(type, name.trim() || LAYER_KIND_LABEL[type]);
  state.project.layers.push(layer);
  state.selectedLayerId = layer.id;
  markDirty();
  Atlas.renderAllLayers();
  renderLayerList();
  toast(`Layer "${layer.name}" creato`, 'ok');
}

/** A sublayer is just a layer with `parentId` set — used to build lists
 *  like regione > provincia > quartiere, with strade/trasporti/edifici
 *  nested at the bottom. */
async function addSubLayer(parentId) {
  if (!state.project) return;
  const parent = state.project.layers.find((l) => l.id === parentId);
  if (!parent) return;
  const type = await pickLayerType();
  if (!type) return;
  const name = await promptDialog({
    title: `Nuovo sublayer di "${parent.name}"`,
    message: 'Nome del layer',
    value: LAYER_KIND_LABEL[type],
    confirmLabel: 'Crea',
  });
  if (name === null) return;
  const layer = projects.makeLayer(type, name.trim() || LAYER_KIND_LABEL[type], parent.id);
  state.project.layers.push(layer);
  state.selectedLayerId = layer.id;
  markDirty();
  Atlas.renderAllLayers();
  renderLayerList();
  toast(`Sublayer "${layer.name}" creato dentro "${parent.name}"`, 'ok');
}

async function deleteLayer(layerId) {
  const id = layerId || state.selectedLayerId;
  const layer = state.project && state.project.layers.find((l) => l.id === id);
  if (!layer) return;
  const children = state.project.layers.filter((l) => l.parentId === layer.id);
  const childNote = children.length ? ` I suoi ${children.length} sublayer diventeranno layer di primo livello.` : '';
  const ok = await confirmDialog({
    title: 'Eliminare il layer?',
    message: `"${layer.name}" e i suoi ${layer.features.length} elementi verranno rimossi.${childNote}`,
    confirmLabel: 'Elimina', danger: true,
  });
  if (!ok) return;
  for (const child of children) child.parentId = null;
  state.project.layers = state.project.layers.filter((l) => l.id !== layer.id);
  if (state.selectedLayerId === layer.id) {
    state.selectedLayerId = state.project.layers.length ? state.project.layers[0].id : null;
  }
  state.selectedFeature = null;
  markDirty();
  Atlas.renderAllLayers();
  Atlas.refreshProps();
  renderLayerList();
  toast('Layer eliminato');
}

// --------------------------------------------------------- block filter
/* Presets for the blocks people most often want to look through: all of them
 * are invisible or near-invisible in game, so leaving them in draws walls and
 * blobs that exist nowhere on screen. */
const BLOCK_PRESETS = [
  { name: 'minecraft:barrier', label: 'Barriere' },
  { name: 'minecraft:light', label: 'Blocchi luce' },
  { name: 'minecraft:structure_void', label: 'Vuoti struttura' },
  { name: 'minecraft:structure_block', label: 'Blocchi struttura' },
  { name: 'minecraft:jigsaw', label: 'Blocchi jigsaw' },
];

function currentHiddenBlocks() {
  const chosen = [...document.querySelectorAll('#block-presets input:checked')].map((i) => i.value);
  const custom = String(el('block-custom').value || '').split(/[\n,]/);
  return projects.normalizeBlockList([...chosen, ...custom]);
}

function renderBlockFilter() {
  // Before an atlas exists there is no project.settings to read yet, so the
  // checkboxes fall back to the same defaults a brand-new project would get.
  const hidden = state.project ? state.project.settings.hiddenBlocks : projects.DEFAULT_HIDDEN_BLOCKS;
  el('block-presets').innerHTML = BLOCK_PRESETS.map((p) => `
    <label class="check-row">
      <input type="checkbox" value="${p.name}" ${hidden.includes(p.name) ? 'checked' : ''}>
      ${escapeHtml(p.label)} <code>${escapeHtml(p.name)}</code>
    </label>`).join('');
  const extras = hidden.filter((h) => !BLOCK_PRESETS.some((p) => p.name === h));
  el('block-custom').value = extras.join('\n');
}

async function applyBlockFilter() {
  // No atlas yet: nothing to push the filter into. The checkboxes are still
  // read directly when the atlas is created (see createProject), so this
  // button only matters for a project that's already open.
  if (!state.project) {
    toast('Il filtro è già pronto: verrà usato quando crei l\'atlante. Per un atlante già aperto, aprilo prima.', 'err');
    return;
  }
  const hiddenBlocks = currentHiddenBlocks();
  state.project.settings.hiddenBlocks = hiddenBlocks;
  markDirty();
  renderBlockFilter();
  await engine.setRenderSettings({ hiddenBlocks });
  Atlas.refreshTiles();
  setStatus('filter-status',
    hiddenBlocks.length
      ? `${hiddenBlocks.length} blocchi nascosti. Le parti già generate vanno rigenerate per aggiornarsi.`
      : 'Nessun blocco nascosto.', 'ok');
}

// ------------------------------------------------------- map generation
let renderRunning = false;

function renderArea() {
  if (el('render-extent').value === 'all') return null;
  const x = Number(el('render-x').value) || 0;
  const z = Number(el('render-z').value) || 0;
  const r = Math.max(256, Number(el('render-radius').value) || 1024);
  return { minX: x - r, minZ: z - r, maxX: x + r, maxZ: z + r };
}

/** Rough "how long will this take", from the tile count. */
function updateRenderEstimate() {
  const node = el('render-estimate');
  if (!state.project || !state.world) { node.textContent = ''; return; }
  const dim = state.world.dimensions.find((d) => d.id === state.project.world.dimension);
  if (!dim) { node.textContent = ''; return; }

  const area = renderArea();
  const b = dim.bounds;
  const minX = area ? Math.max(b.minX, area.minX) : b.minX;
  const maxX = area ? Math.min(b.maxX, area.maxX) : b.maxX;
  const minZ = area ? Math.max(b.minZ, area.minZ) : b.minZ;
  const maxZ = area ? Math.min(b.maxZ, area.maxZ) : b.maxZ;
  if (minX > maxX || minZ > maxZ) {
    node.textContent = "L'area scelta non tocca nessuna parte generata del mondo.";
    return;
  }
  const tiles = Math.ceil((maxX - minX + 1) / 256) * Math.ceil((maxZ - minZ + 1) / 256);
  // The rail overlay is a second pass over the same tiles.
  const withRails = el('chk-rails').checked;
  const seconds = Math.round(tiles * (withRails ? 1.5 : 0.8));
  const pretty = seconds > 90 ? `~${Math.round(seconds / 60)} min` : `~${seconds} s`;
  node.textContent = `Circa ${tiles} tile di dettaglio${withRails ? ' (più le ferrovie)' : ''}, ${pretty} di elaborazione.`;
}

async function startRender() {
  if (!state.project || !state.world) { toast('Apri prima un atlante', 'err'); return; }
  if (renderRunning) return;
  renderRunning = true;
  el('btn-render').disabled = true;
  el('btn-render-cancel').classList.remove('hidden');
  el('render-progress').classList.remove('hidden');
  setStatus('render-status', 'Avvio generazione…', 'busy');

  let lastRefresh = 0;
  try {
    const result = await engine.render(state.project.world.dimension, renderArea(), el('chk-rails').checked, (p) => {
      const percent = p.total ? Math.round((p.done / p.total) * 100) : 0;
      el('render-bar').style.width = `${percent}%`;
      setStatus('render-status', `${p.phase}: ${p.done}/${p.total} (${percent}%)`, 'busy');
      // Show the tiles appearing, without redrawing on every single one.
      if (Date.now() - lastRefresh > 1500) {
        lastRefresh = Date.now();
        Atlas.refreshTiles();
      }
    });
    Atlas.refreshTiles();
    if (result.state === 'cancelled') {
      setStatus('render-status', 'Generazione interrotta (la parte già fatta resta).', 'busy');
    } else {
      setStatus('render-status', `Mappa generata${describeBounds(result.bounds)}.`, 'ok');
    }
  } catch (err) {
    setStatus('render-status', `Generazione fallita: ${err.message}`, 'err');
  } finally {
    renderRunning = false;
    el('btn-render').disabled = false;
    el('btn-render-cancel').classList.add('hidden');
  }
}

function describeBounds(b) {
  if (!b) return '';
  return ` (area X ${Math.round(b.minX)}…${Math.round(b.maxX)}, Z ${Math.round(b.minZ)}…${Math.round(b.maxZ)})`;
}

async function pollRenderStatus() {
  if (!state.project || !state.world) return;
  try {
    const status = await engine.renderStatus(state.project.world.dimension);
    if (status.state === 'done') {
      setStatus('render-status', `Mappa già generata${describeBounds(status.bounds)}.`, 'ok');
    } else if (status.state !== 'running') {
      setStatus('render-status',
        'Questa dimensione non è ancora stata generata: scegli l\'area e premi "Genera mappa".', 'busy');
    }
  } catch { /* the worker will report properly when asked to render */ }
}

// -------------------------------------------------------------------- init
async function init() {
  // Navigation is wired first and outside the try/catch below, on purpose:
  // if literally anything else in this function throws (stale cached JS
  // after a deploy, a corrupted saved project, whatever), the mode/screen
  // tabs must still respond instead of leaving the whole page inert.
  document.querySelectorAll('#mode-tabs .tab').forEach((btn) => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });
  document.querySelectorAll('#editor-tabs .tab, #reader-tabs .tab').forEach((tab) => {
    tab.addEventListener('click', () => showScreen(tab.dataset.screen));
  });
  // interfaceMode.js already applied the stored choice to <html> on import;
  // this just syncs the select and wires switching it further, same
  // "must survive anything else throwing" reasoning as the tabs above.
  el('interface-mode-select').value = getInterfaceMode();
  el('interface-mode-select').addEventListener('change', (e) => {
    setInterfaceMode(e.target.value);
    el('sidebar-toggle').classList.toggle('hidden', e.target.value !== 'ipad');
    el('app').classList.remove('sidebar-hidden');
  });
  el('sidebar-toggle').classList.toggle('hidden', getInterfaceMode() !== 'ipad');
  el('sidebar-toggle').addEventListener('click', () => {
    el('app').classList.toggle('sidebar-hidden');
  });

  try {
    await initRest();
  } catch (err) {
    console.error('Errore in fase di avvio:', err);
    toast(`Errore di avvio (${err.message}). Prova a ricaricare la pagina con Ctrl+Shift+R / Cmd+Shift+R.`, 'err');
  }
}

async function initRest() {
  Atlas.initMap();
  Archive.init();
  Reader.init();
  el('picker-hint').textContent = pickerHint();

  el('btn-pick-world').addEventListener('click', pickWorld);
  el('btn-reopen-world').addEventListener('click', reopenLastWorld);
  el('world-input').addEventListener('change', async (e) => {
    if (!e.target.files || !e.target.files.length) return;
    await openWorldFromInit(sourceFromFileList(e.target.files));
    e.target.value = '';
  });

  el('btn-new-project').addEventListener('click', createProject);
  el('btn-open-project').addEventListener('click', () => openProjectById(el('project-list').value));
  el('btn-delete-project').addEventListener('click', deleteProject);
  el('btn-export-project').addEventListener('click', exportProject);
  el('btn-import-project').addEventListener('click', () => el('import-file').click());
  el('import-file').addEventListener('change', onImportFile);

  el('project-name').addEventListener('input', debounce(() => {
    if (!state.project) return;
    state.project.name = el('project-name').value.trim() || 'Senza nome';
    markDirty();
    refreshProjectList(state.project.id);
  }, 500));

  el('chk-terrain').addEventListener('change', () => {
    Atlas.setTerrainVisible(el('chk-terrain').checked);
    if (state.project) { state.project.settings.showTerrain = el('chk-terrain').checked; markDirty(); }
  });

  el('chk-rails').addEventListener('change', () => {
    Atlas.setRailsVisible(el('chk-rails').checked);
    if (state.project) { state.project.settings.showRails = el('chk-rails').checked; markDirty(); }
    updateRenderEstimate();
  });
  el('btn-apply-filter').addEventListener('click', applyBlockFilter);

  el('render-extent').addEventListener('change', () => {
    el('render-around').classList.toggle('hidden', el('render-extent').value === 'all');
    updateRenderEstimate();
  });
  for (const id of ['render-x', 'render-z', 'render-radius']) {
    el(id).addEventListener('input', debounce(updateRenderEstimate, 250));
  }
  el('btn-render-here').addEventListener('click', () => {
    const map = Atlas.getMap();
    if (!map) return;
    const c = fromLatLng(map.getCenter());
    el('render-x').value = Math.round(c.x);
    el('render-z').value = Math.round(c.z);
    updateRenderEstimate();
  });
  el('btn-render').addEventListener('click', startRender);
  el('btn-render-cancel').addEventListener('click', () => engine.cancelRender());

  el('btn-clear-cache').addEventListener('click', async () => {
    if (!state.project || !state.world) { toast('Apri prima un atlante', 'err'); return; }
    setStatus('cache-status', 'Svuoto la cache dei tile…', 'busy');
    try {
      const { removed } = await engine.clearCache(state.project.world.dimension);
      Atlas.refreshTiles();
      setStatus('cache-status', `Cache svuotata (${removed} tile).`, 'ok');
      await startRender();
    } catch (err) {
      setStatus('cache-status', err.message, 'err');
    }
  });

  el('btn-goto').addEventListener('click', () => {
    Atlas.goTo(Number(el('goto-x').value) || 0, Number(el('goto-z').value) || 0,
      Math.max(Atlas.getMap().getZoom(), -2));
  });
  for (const id of ['goto-x', 'goto-z']) {
    el(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') el('btn-goto').click(); });
  }
  el('btn-goto-spawn').addEventListener('click', () => {
    const spawn = (state.world && state.world.spawn) || { x: 0, z: 0 };
    el('goto-x').value = Math.round(spawn.x);
    el('goto-z').value = Math.round(spawn.z);
    Atlas.goTo(spawn.x, spawn.z, 0);
  });
  el('btn-goto-fit').addEventListener('click', () => Atlas.fitWorld());

  document.querySelectorAll('[data-add-layer]').forEach((btn) => {
    btn.addEventListener('click', () => addLayer(btn.dataset.addLayer));
  });
  el('btn-delete-layer').addEventListener('click', () => deleteLayer());
  el('btn-new-independent-station').addEventListener('click', () => {
    const layer = state.project && state.project.layers.find((l) => l.id === state.selectedLayerId);
    if (layer) Atlas.beginPlaceStation(layer);
  });
  el('station-shape').addEventListener('change', () => {
    const layer = state.project && state.project.layers.find((l) => l.id === state.selectedLayerId);
    if (layer) Atlas.setStationStyle(layer, { shape: el('station-shape').value });
  });
  el('station-size').addEventListener('input', () => {
    const layer = state.project && state.project.layers.find((l) => l.id === state.selectedLayerId);
    el('station-size-v').textContent = el('station-size').value;
    if (layer) Atlas.setStationStyle(layer, { size: el('station-size').value });
  });
  el('layer-name').addEventListener('input', debounce(() => {
    const layer = state.project && state.project.layers.find((l) => l.id === state.selectedLayerId);
    if (!layer) return;
    layer.name = el('layer-name').value.trim() || 'Layer';
    markDirty();
    renderLayerList();
  }, 400));

  document.querySelectorAll('.tool').forEach((btn) => {
    btn.addEventListener('click', () => Atlas.setTool(btn.dataset.tool));
  });

  el('btn-export-reader-map').addEventListener('click', () => Atlas.exportForReader());
  el('btn-export-png').addEventListener('click', () => Atlas.exportPNG());
  el('btn-export-svg').addEventListener('click', () => Atlas.exportSVG());
  el('btn-export-geojson').addEventListener('click', () => Atlas.exportGeoJSON());

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    if (e.key === 'Escape') Atlas.setTool('select');
    if (e.key === 'Delete' && state.selectedFeature) {
      Atlas.deleteFeature(state.selectedFeature.layerId, state.selectedFeature.featureId);
    }
  });

  await refreshProjectList();

  // Offer to reopen the world we mapped last time, if the browser kept it.
  const restored = await restoreLastWorld();
  if (restored && restored.kind === 'handle') {
    await openWorldFromInit(restored, { silent: true });
  } else if (restored && restored.needsPermission) {
    el('btn-reopen-world').classList.remove('hidden');
    el('btn-reopen-world').textContent = `Riapri "${restored.name}"`;
  }
}

// Expose the pieces the other modules call back into.
window.Main = { renderLayerList, showScreen, openProject, refreshProjectList, selectLayer };

document.addEventListener('DOMContentLoaded', init);

export { renderLayerList, showScreen, openProject };
