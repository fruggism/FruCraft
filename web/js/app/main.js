/*
 * Cube-Atlas — app shell: screen switching, picking the world, project
 * lifecycle, the layer list, map generation and every sidebar control.
 *
 * There is no server: the world is read in a Web Worker and the projects live
 * in IndexedDB.
 */

import {
  state, el, escapeHtml, toast, debounce, setStatus, markDirty,
  confirmDialog, promptDialog, pickDialog, download, slugify, newId, engine, projects,
} from './ui-core.js';
import * as Atlas from './atlas.js';
import * as Archive from './archive.js';
import * as Reader from './reader.js';
import * as Atlas3D from './atlas3d.js';
import * as Entry from './entry.js';
import * as WorldTab from './worldTab.js';
import * as Tabs from './redesign.js';
import { GlbViewer } from './glbReader.js';
import { getInterfaceMode, setInterfaceMode } from './interfaceMode.js';

const LAYER_ICONS = { roads: '🛣️', pois: '📍', areas: '⬟', transit: '🚇', notes: '📝' };
const LAYER_KIND_LABEL = { roads: 'Strade', pois: 'Punti', areas: 'Aree', transit: 'Trasporti', notes: 'Note' };

function closeMapPopovers() {
  el('map-utility-panel').classList.add('hidden');
  el('btn-compass').classList.remove('active');
  el('map-search-panel').classList.add('hidden');
  el('btn-map-search').classList.remove('active');
}

/** Renders search results (from Atlas.searchByName) into a <ul>, shared
 *  markup/behaviour between the Editor's and the Lettore's search panels. */
function renderMapSearchResults(hostId, results, onPick) {
  const host = el(hostId);
  if (!host) return;
  if (!results.length) {
    host.innerHTML = `<li class="sr-empty">${el(hostId.replace('-results', '-input')).value.trim() ? 'Nessun risultato' : 'Scrivi un nome…'}</li>`;
    return;
  }
  host.innerHTML = results.map((item, i) => `
    <li data-i="${i}">${item.kind === 'station' ? '🚉' : (LAYER_ICONS[item.layerType] || '•')} ${escapeHtml(item.name)}
      <span class="sr-layer">${escapeHtml(item.layerName)}</span></li>`).join('');
  host.querySelectorAll('li[data-i]').forEach((node) => {
    node.addEventListener('click', () => onPick(results[Number(node.dataset.i)]));
  });
}

// The description of the currently open folder, kept so a project reopened
// later can be matched against the world actually loaded in the worker.
let openWorldInit = null;

// ---------------------------------------------------------------- screens
/*
 * Navigation has two axes: *what* you are looking at and *how*.
 *
 * The three sections are three ways of looking at the same world — from
 * above, from inside, and as the documents written in it. Each has an Editor,
 * which needs the world open and makes something, and a Lettura, which needs
 * nothing but a file the Editor exported. Six screens, one per pair.
 *
 * Switching never touches world or project state: it only decides which
 * screen is visible.
 */
const SECTIONS = {
  // The 3D model is a tab of the Atlante editor now (atlas3d.js); a saved
  // .glb is still read back in the Atlante's Lettura, next to the map.
  atlas2d: { label: 'Atlante', editor: 'atlas', reader: () => (readerSub === 'glb' ? 'reader-atlas3d' : 'reader-atlas') },
  docs: { label: 'Documenti', editor: 'archive', reader: 'reader-archive' },
};

let section = 'atlas2d';
let readerSub = 'map';
// Which mode each section was left in, so coming back lands where you were.
const lastMode = { atlas2d: 'editor', docs: 'editor' };
let glbViewer = null;

/** Show one screen and let it know, for the ones that need to measure. */
function showScreen(name) {
  document.querySelectorAll('.screen').forEach((s) => (
    s.classList.toggle('active', s.id === `screen-${name}`)
  ));
  // A Leaflet map and a WebGL canvas are both sized to their container, which
  // is zero while the screen is hidden: they have to measure once shown.
  if (name === 'atlas' && Atlas.getMap()) setTimeout(() => Atlas.getMap().invalidateSize(), 60);
  if (name === 'archive') Archive.renderList();
  if (name === 'reader-atlas3d' && glbViewer) glbViewer.resize();
  document.querySelectorAll('.reader-switch button').forEach((b) => (
    b.classList.toggle('active', b.dataset.reader === readerSub)
  ));
}

/** Go to a section, in a mode — remembering the mode per section. */
function go(nextSection, mode) {
  if (!SECTIONS[nextSection]) nextSection = 'atlas2d';
  section = nextSection;
  const chosen = mode || lastMode[section];
  lastMode[section] = chosen;

  document.querySelectorAll('#section-tabs .tab').forEach((t) => (
    t.classList.toggle('active', t.dataset.section === section)
  ));
  document.querySelectorAll('#mode-tabs .tab').forEach((t) => (
    t.classList.toggle('active', t.dataset.mode === chosen)
  ));
  el('mode-label').textContent = ` ${SECTIONS[section].label}`;
  const target = SECTIONS[section][chosen];
  showScreen(typeof target === 'function' ? target() : target);
  Entry.sync();
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
    Atlas3D.worldChanged();
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
  if (!subPath) return init;
  if (init.kind === 'http') {
    const prefix = [init.prefix, subPath].filter(Boolean).join('/');
    return { ...init, prefix, name: subPath.split('/').pop() };
  }
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

async function createProject({ name: givenName } = {}) {
  if (!state.world) { toast('Scegli prima un mondo', 'err'); return null; }
  const dimension = el('world-dimension').value;
  const name = givenName != null ? givenName : await promptDialog({
    title: 'Nuovo atlante',
    message: 'Come vuoi chiamarlo?',
    value: state.world.levelName || 'Il mio atlante',
    confirmLabel: 'Crea',
  });
  if (name === null) return null;
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
    return project;
  } catch (err) {
    setStatus('save-status', err.message, 'err');
    toast(err.message, 'err');
    return null;
  }
}

/**
 * «Apri» in the world list: the atlas of this world and dimension if there
 * already is one, a new one otherwise. An atlas belongs to one dimension —
 * its roads and stations are in that dimension's coordinates — so the Nether
 * of a world gets an atlas of its own rather than sharing the Overworld's.
 */
async function openAtlas() {
  if (!state.world) return false;
  const dimension = el('world-dimension').value;
  const list = await projects.listProjects();
  const existing = list.find((p) => p.world && p.world.id === state.world.worldKey
    && p.world.dimension === dimension);
  if (existing) {
    await openProjectById(existing.id);
    return !!state.project;
  }
  const dim = state.world.dimensions.find((d) => d.id === dimension);
  const base = state.world.levelName || 'Il mio atlante';
  const name = dim && dim.id !== 'overworld' ? `${base} · ${dim.label}` : base;
  return !!(await createProject({ name }));
}

/** Leave the open atlas (before choosing another world). */
function closeProject() {
  if (!state.project) return;
  state.project = null;
  state.selectedFeature = null;
  el('project-name').value = '';
  el('project-name').disabled = true;
  el('topbar-info').textContent = 'Nessun progetto aperto';
  el('map-overlay').classList.remove('hidden');
  Atlas.renderAllLayers();
  renderLayerList();
  Archive.onProjectLoaded();
  WorldTab.render();
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
       <p>Usa <b>cambia mondo</b> nella scheda Mondo.</p>`;
    el('topbar-info').innerHTML = `<span>${escapeHtml(project.name)}</span> · mondo non aperto`;
    renderLayerList();
    Archive.onProjectLoaded();
    WorldTab.render();
    Entry.sync();
    return;
  }

  const dim = state.world.dimensions.find((d) => d.id === project.world.dimension)
    || state.world.dimensions[0];
  project.world.dimension = dim.id;
  // "Mondo · Dimensione", with the atlas name first only when it says
  // something more (atlases are named after the world by default).
  const level = state.world.levelName || '';
  const auto = [level, `${level} · ${dim.label}`];
  el('topbar-info').innerHTML = (auto.includes(project.name) ? '' : `<span>${escapeHtml(project.name)}</span> · `)
    + `${escapeHtml(level)} · <span>${escapeHtml(dim.label)}</span>`;

  renderBlockFilter();
  // The worker has to know the filter before the first tile is asked for.
  await engine.setRenderSettings({ hiddenBlocks: project.settings.hiddenBlocks || [] });
  Atlas.attachWorld(state.world, dim.id, project.view);
  Atlas.renderAllLayers();
  Atlas.setTerrainVisible(true);
  Atlas.refreshProps();
  renderLayerList();
  Archive.onProjectLoaded();
  setStatus('save-status', 'Atlante aperto', 'ok');

  const spawn = state.world.spawn || { x: 0, z: 0 };
  el('goto-x').value = Math.round(spawn.x);
  el('goto-z').value = Math.round(spawn.z);
  el('world-dimension').value = dim.id;
  WorldTab.render();
  Entry.sync();
  maybeAutoGenerate();
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
const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry',
  'azalea', 'flowering_azalea', 'pale_oak'];
const mc = (n) => `minecraft:${n}`;

// A preset can stand for a whole family: "vetro" is the plain block, the
// panes and the sixteen stained ones; "foglie" every kind of leaves.
const BLOCK_PRESETS = [
  { names: [mc('barrier')], label: 'Barriere', icon: 'barrier' },
  { names: [mc('glass'), mc('glass_pane'), mc('tinted_glass'),
    ...COLORS.flatMap((c) => [mc(`${c}_stained_glass`), mc(`${c}_stained_glass_pane`)])],
  label: 'Vetro', icon: 'glass' },
  { names: WOODS.map((w) => mc(`${w}_leaves`)), label: 'Foglie', icon: 'leaves' },
  { names: [mc('light')], label: 'Blocchi luce', icon: 'bottle' },
  { names: [mc('structure_void'), mc('structure_block'), mc('jigsaw')], label: 'Blocchi tecnici', icon: 'crafting' },
];

function currentHiddenBlocks() {
  const chosen = [...document.querySelectorAll('#block-presets input:checked')]
    .flatMap((i) => i.value.split(','));
  const custom = String(el('block-custom').value || '').split(/[\n,]/);
  return projects.normalizeBlockList([...chosen, ...custom]);
}

function renderBlockFilter() {
  // Before an atlas exists there is no project.settings to read yet, so the
  // checkboxes fall back to the same defaults a brand-new project would get.
  const hidden = state.project ? state.project.settings.hiddenBlocks : projects.DEFAULT_HIDDEN_BLOCKS;
  el('block-presets').innerHTML = BLOCK_PRESETS.map((p) => `
    <label class="check-row">
      <input type="checkbox" value="${p.names.join(',')}" ${p.names.every((n) => hidden.includes(n)) ? 'checked' : ''}>
      <img src="img/icons/${p.icon}.png" alt=""> ${escapeHtml(p.label)}
    </label>`).join('');
  const extras = hidden.filter((h) => !BLOCK_PRESETS.some((p) => p.names.includes(h)));
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
// Generation has no panel of its own any more: it just happens, around the
// world's spawn point, the moment an atlas is created or opened and its
// dimension hasn't been generated yet — see maybeAutoGenerate().
let renderRunning = false;
const DEFAULT_RENDER_RADIUS = 1024;

function renderArea() {
  const spawn = (state.world && state.world.spawn) || { x: 0, z: 0 };
  const r = DEFAULT_RENDER_RADIUS;
  return { minX: spawn.x - r, minZ: spawn.z - r, maxX: spawn.x + r, maxZ: spawn.z + r };
}

async function startRender() {
  if (!state.project || !state.world) { toast('Apri prima un atlante', 'err'); return; }
  if (renderRunning) return;
  renderRunning = true;
  toast('Generazione della mappa in corso…', 'busy');

  let lastRefresh = 0;
  try {
    const result = await engine.render(state.project.world.dimension, renderArea(), false, (p) => {
      // Show the tiles appearing, without redrawing on every single one.
      if (Date.now() - lastRefresh > 1500) {
        lastRefresh = Date.now();
        Atlas.refreshTiles();
      }
    });
    Atlas.refreshTiles();
    toast(`Mappa generata${describeBounds(result.bounds)}.`, 'ok');
  } catch (err) {
    toast(`Generazione fallita: ${err.message}`, 'err');
  } finally {
    renderRunning = false;
  }
}

function describeBounds(b) {
  if (!b) return '';
  return ` (area X ${Math.round(b.minX)}…${Math.round(b.maxX)}, Z ${Math.round(b.minZ)}…${Math.round(b.maxZ)})`;
}

/** No more "Genera mappa" button: opening or creating an atlas generates a
 *  reasonable area around spawn by itself the first time, so there's always
 *  something to look at. A dimension already generated is left alone. */
async function maybeAutoGenerate() {
  if (!state.project || !state.world) return;
  try {
    const status = await engine.renderStatus(state.project.world.dimension);
    if (status.state === 'done' || status.state === 'running') return;
  } catch { /* the worker will report properly when asked to render */ }
  await startRender();
}

// -------------------------------------------------------------------- init
async function init() {
  // Navigation is wired first and outside the try/catch below, on purpose:
  // if literally anything else in this function throws (stale cached JS
  // after a deploy, a corrupted saved project, whatever), the mode/screen
  // tabs must still respond instead of leaving the whole page inert.
  document.querySelectorAll('#section-tabs .tab').forEach((btn) => {
    btn.addEventListener('click', () => go(btn.dataset.section));
  });
  document.querySelectorAll('#mode-tabs .tab').forEach((btn) => {
    btn.addEventListener('click', () => go(section, btn.dataset.mode));
  });
  // interfaceMode.js already applied the stored choice to <html> on import;
  // this just syncs the select and wires switching it further, same
  // "must survive anything else throwing" reasoning as the tabs above.
  // The 3D screen reads the world the Editor already has open rather than
  // asking for the folder again; the worker behind it is its own.
  Atlas3D.init({
    getWorldInit: () => openWorldInit,
    getDimension: () => (state.project ? state.project.world.dimension : el('world-dimension').value),
    getMap: () => Atlas.getMap(),
  });
  // «Vedi in 3D»: the Modello 3D tab, with the box on what the map shows.
  el('btn-see-3d').addEventListener('click', () => {
    if (!state.project || !openWorldInit) { toast('Apri prima un atlante', 'err'); return; }
    const c = Atlas.fromLatLng(Atlas.getMap().getCenter());
    Tabs.setTab('model3d');
    Atlas3D.focusOn(Math.round(c.x), Math.round(c.z));
  });

  document.querySelectorAll('.reader-switch button').forEach((b) => {
    b.addEventListener('click', () => { readerSub = b.dataset.reader; go('atlas2d', 'reader'); });
  });

  // Atlante 3D · Lettura: a model opened from disk, no world needed.
  el('btn-reader-open-glb').addEventListener('click', () => el('reader-glb-input').click());
  el('reader-glb-input').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setStatus('reader-glb-status', `Sto aprendo ${file.name}…`, 'busy');
    try {
      if (!glbViewer) {
        glbViewer = new GlbViewer(el('reader-glb-scene'));
        new ResizeObserver(() => glbViewer.resize()).observe(el('reader-glb-stage'));
      }
      const info = await glbViewer.load(await file.arrayBuffer());
      el('reader-glb-empty').classList.add('hidden');
      el('reader-glb-scene').classList.remove('hidden');
      el('reader-glb-panel').classList.remove('hidden');
      glbViewer.resize();
      glbViewer.start();
      setStatus('reader-glb-status', file.name, 'ok');
      const from = info.extras && info.extras.world
        ? ` · da X ${info.extras.world.minX}, Z ${info.extras.world.minZ}` : '';
      setStatus('reader-glb-stats',
        `${(info.triangles / 1000).toFixed(0)}k triangoli · ${info.textures} texture`
        + ` · ${info.size.x}×${info.size.y}×${info.size.z} blocchi${from}`);
    } catch (err) {
      setStatus('reader-glb-status', `Non riesco a leggerlo: ${err.message}`, 'err');
    }
  });
  el('btn-reader-glb-snapshot').addEventListener('click', async () => {
    if (!glbViewer) return;
    const blob = await glbViewer.snapshot();
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'modello.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

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

  Entry.init({
    getNav: () => ({ section, mode: lastMode[section] }),
    go,
    narrowInit,
    openWorld: (init) => openWorldFromInit(init),
    openAtlas,
    openProjectById,
    onAtlasOpened: () => { go('atlas2d', 'editor'); Tabs.setTab('layers'); },
    blockPresets: BLOCK_PRESETS,
  });
  WorldTab.init({
    getMap: () => Atlas.getMap(),
    goTo: (x, z, zoom) => Atlas.goTo(x, z, zoom),
    fitWorld: () => Atlas.fitWorld(),
    changeWorld: () => { closeProject(); Entry.changeWorld(); },
  });
  // The title screen's background: the last view of the map, kept small.
  Atlas.getMap().on('moveend', debounce(() => Entry.captureBackdrop(Atlas.getMap()), 2500));

  // An atlas belongs to one dimension: choosing another one opens (or
  // creates) that dimension's atlas for the same world.
  el('world-dimension').addEventListener('change', async () => {
    if (!state.project) return;
    const next = el('world-dimension').value;
    if (next === state.project.world.dimension) return;
    const dim = state.world && state.world.dimensions.find((d) => d.id === next);
    const ok = await confirmDialog({
      title: `Passare a ${dim ? dim.label : next}?`,
      message: 'Ogni atlante è di una dimensione sola: le sue strade e stazioni hanno le coordinate di quella. Apro l\'atlante di questa dimensione, o lo creo se non c\'è ancora.',
      confirmLabel: 'Apri',
    });
    if (!ok) { el('world-dimension').value = state.project.world.dimension; return; }
    await openAtlas();
  });

  el('btn-new-project').addEventListener('click', () => createProject());
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

  el('btn-apply-filter').addEventListener('click', applyBlockFilter);

  // The compass used to open a popover; «Vai a» lives in the Mondo tab now.
  el('btn-compass').addEventListener('click', (e) => {
    e.stopPropagation();
    closeMapPopovers();
    Tabs.setTab('world');
    el('goto-x').focus();
    el('goto-x').select();
  });

  el('btn-map-search').addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = el('map-search-panel').classList.contains('hidden');
    closeMapPopovers();
    el('map-search-panel').classList.toggle('hidden', !opening);
    el('btn-map-search').classList.toggle('active', opening);
    if (opening) { el('map-search-input').value = ''; el('map-search-results').innerHTML = ''; el('map-search-input').focus(); }
  });
  el('map-search-panel').addEventListener('click', (e) => e.stopPropagation());
  el('map-search-input').addEventListener('input', debounce(() => {
    const results = state.project ? Atlas.searchByName(state.project.layers, el('map-search-input').value) : [];
    renderMapSearchResults('map-search-results', results, (item) => {
      Atlas.goToSearchResult(item);
      closeMapPopovers();
    });
  }, 150));

  document.addEventListener('click', () => closeMapPopovers());

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

  el('btn-export-atlas').addEventListener('click', () => Atlas.exportForReader());
  el('btn-export-svg-layer').addEventListener('click', () => Atlas.exportSVG());
  el('btn-export-png').addEventListener('click', () => Atlas.exportPNG());

  document.addEventListener('keydown', (e) => {
    // The target is not always an element (an event sent to document).
    if (e.target instanceof Element && e.target.matches('input, textarea, select')) return;
    if (e.key === 'Escape') Atlas.setTool('select');
    if (e.key === 'Delete' && state.selectedFeature) {
      Atlas.deleteFeature(state.selectedFeature.layerId, state.selectedFeature.featureId);
    }
  });

  await refreshProjectList();

  // No more silent reopening of the last world: the title screen offers
  // «Riprendi» and the saves folder, which ask for permission themselves.
  // (In development, ?dev points the saves folder at tools/serve.js.)
  Entry.sync();
}

// Expose the pieces the other modules call back into.
window.Main = { renderLayerList, showScreen, go, openProject, refreshProjectList, selectLayer };

document.addEventListener('DOMContentLoaded', init);

export { renderLayerList, showScreen, go, openProject };
