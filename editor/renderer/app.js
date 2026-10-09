/*
 * Cantiere window. No filesystem here: everything goes through window.cantiere
 * (preload.cjs). The map is Leaflet in CRS.Simple with block coordinates as
 * map units — lng = blockX, lat = -blockZ — exactly like the Cube-Atlas app.
 *
 * Layout and look follow the approved design (editor/design/): menus and
 * ribbon on top, one tab per world, tool options, tools on the left, the map,
 * a panel on the right, the status bar with Apply at the bottom.
 */

import { $, esc, icon, fmt, signed, rgb, toast, guard, modalOpen, closeModal, pickFrom, ago, whenText, cleanError } from './ui.js';
import { MapOverlay, scaleBar } from './mapdraw.js';
import { applyDialog, replaceDialog, gotoDialog, saveSelectionDialog, devFillDialog, OP_LABELS } from './dialogs.js';
import {
  emptySelection, isEmptySelection, combine, invert, selectionBounds, measure, simplifyPoints, yRange,
} from '../core/selection.js';
import { biomesFor, biomeColor, biomeLabel } from '../core/biomes.js';
import { dimensionInfo } from '../core/dimensions.js';

const api = window.cantiere;
const toLatLng = (x, z) => L.latLng(-z, x);
const fromLatLng = (ll) => ({ x: ll.lng, z: -ll.lat });

const state = {
  tabs: [],
  active: null,
  menu: 'Modifica',
  tool: 'move',
  selMode: 'new',          // new | add | sub | and
  brushR: 8,
  biome: 'minecraft:plains',
  panelTab: 'props',
  settings: null,
  cursor: null,            // { x, z, fx, fz, probe }
  draft: null,             // shape being drawn
  space: false,            // space held: pan with any tool
  grid: false,
  search: { kind: 'block', block: 'diamond_ore', id: '', item: '', text: '', scope: 'auto', running: null, progress: 0 },
};

const DIM_ICON = { overworld: 'd-over', the_nether: 'd-nether', the_end: 'd-end' };
const tab = () => state.tabs.find((t) => t.id === state.active) || null;
const ui = (() => { try { return JSON.parse(localStorage.getItem('cantiere.ui') || '{}'); } catch { return {}; } })();
const saveUi = () => { try { localStorage.setItem('cantiere.ui', JSON.stringify(ui)); } catch { /* private storage */ } };

// ---------------------------------------------------------------------------
// Tools (Sidebar.dc.html)
// ---------------------------------------------------------------------------

const TOOL_GROUPS = [
  ['Naviga', [['move', 'Sposta', 'V']]],
  ['Seleziona', [['rect', 'Rettangolo', 'M'], ['poly', 'Poligono', 'P'], ['lasso', 'Lazo', 'L'], ['sbrush', 'Pennello', 'S']]],
  ['Modifica', [['biome', 'Bioma', 'B'], ['terrain', 'Terreno', '', 5], ['veg', 'Vegetazione', '', 6], ['river', 'Fiume e lago', '', 6], ['replace', 'Sostituisci', 'R']]],
  ['Mondo', [['spawn', 'Spawn', ''], ['border', 'Bordo del mondo', '', 7], ['players', 'Giocatori', '', 7], ['search', 'Cerca', 'F'], ['prune', 'Pota chunk', '', 7]]],
];
const TOOL = Object.fromEntries(TOOL_GROUPS.flatMap(([, items]) => items.map(([id, label, key, phase]) => [id, { id, label, key, phase }])));
const SELECT_TOOLS = new Set(['rect', 'poly', 'lasso', 'sbrush']);
const BRUSH_TOOLS = new Set(['sbrush', 'biome']);

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

let map = null;
let layer = null;
let overlay = null;

function initMap() {
  map = L.map('map', {
    crs: L.CRS.Simple, minZoom: -6, maxZoom: 5, zoomSnap: 0.5, zoomDelta: 0.5,
    wheelPxPerZoomLevel: 90, attributionControl: false, zoomControl: false, doubleClickZoom: false,
    boxZoom: false, keyboard: false,
  });
  map.setView([0, 0], 0);
  overlay = new MapOverlay(map, $('overlay'), overlayState);
  map.on('mousemove', onMove);
  map.on('mousedown', onDown);
  map.on('mouseup', onUp);
  map.on('click', onClick);
  map.on('dblclick', onDblClick);
  map.on('mouseout', () => { state.cursor = null; overlay.draw(false); renderStatus(); });
  map.on('moveend zoomend', () => {
    const t = tab();
    if (t) t.mapView = { center: fromLatLng(map.getCenter()), zoom: map.getZoom() };
    renderStatus(); renderChips();
  });
}

function overlayState() {
  const t = tab();
  const c = state.cursor;
  return {
    tab: t,
    selection: t && t.selection,
    selKey: t ? t.selKey : '',
    draft: state.draft,
    grid: state.grid,
    spawn: t && t.dim === 'overworld' ? { ...t.info.spawn, radius: Number(t.info.gameRules.spawnRadius ?? t.info.gameRules['minecraft:respawn_radius'] ?? 10) } : null,
    hits: t && t.search ? t.search.items : null,
    hitChunks: t && t.search ? t.search.chunks : null,
    focusHit: t && t.focusHit,
    cursor: c && BRUSH_TOOLS.has(state.tool) && !state.space
      ? { x: c.fx, z: c.fz, r: state.brushR, color: state.tool === 'biome' ? rgb(biomeColor(state.biome)) : null }
      : null,
  };
}

function makeLayer(t) {
  const paint = (canvas, coords) => api.world.tile(t.id, t.dim, coords.z, coords.x, coords.y, t.maxY, t.view)
    .then((buf) => {
      const g = canvas.getContext('2d');
      g.clearRect(0, 0, 256, 256);
      if (buf) g.putImageData(new ImageData(new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.byteLength), 256, 256), 0, 0);
    });
  const Terrain = L.GridLayer.extend({
    createTile(coords, done) {
      const canvas = document.createElement('canvas');
      canvas.width = 256; canvas.height = 256;
      paint(canvas, coords).then(() => done(null, canvas), (err) => done(err, canvas));
      return canvas;
    },
  });
  const l = new Terrain({
    tileSize: 256, minZoom: -6, maxZoom: 5, minNativeZoom: -6, maxNativeZoom: 0,
    noWrap: true, keepBuffer: 2, updateWhenZooming: false,
  });
  /** Repaint, in place, the tiles over the given block boxes (null bounds: all). */
  l.refreshIn = (boxes) => {
    if (boxes.some((b) => !b.bounds)) { l.redraw(); return; }
    for (const key of Object.keys(l._tiles)) {
      const tl = l._tiles[key];
      const c = tl.coords;
      const span = 256 * Math.pow(2, -c.z);
      const tb = { minX: c.x * span, minZ: c.y * span, maxX: (c.x + 1) * span - 1, maxZ: (c.y + 1) * span - 1 };
      if (boxes.some((b) => (!b.dim || b.dim === t.dim) && b.bounds.minX <= tb.maxX && b.bounds.maxX >= tb.minX && b.bounds.minZ <= tb.maxZ && b.bounds.maxZ >= tb.minZ)) {
        paint(tl.el, c);
      }
    }
  };
  return l;
}

function showTab() {
  const t = tab();
  if (layer) { map.removeLayer(layer); layer = null; }
  if (!t) { overlay.draw(); return; }
  layer = makeLayer(t).addTo(map);
  const d = t.info.dimensions.find((x) => x.id === t.dim);
  if (d) {
    const b = d.bounds;
    map.setMaxBounds(L.latLngBounds(toLatLng(b.minX, b.minZ), toLatLng(b.maxX + 1, b.maxZ + 1)).pad(1.0));
  }
  const v = t.mapView || { center: t.dim === 'overworld' ? { x: t.info.spawn.x, z: t.info.spawn.z } : centerOf(d.bounds), zoom: 0 };
  map.setView(toLatLng(v.center.x, v.center.z), v.zoom, { animate: false });
  overlay.draw();
}

const centerOf = (b) => ({ x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 });

function fitDimension() {
  const t = tab();
  if (!t) return;
  const b = t.info.dimensions.find((x) => x.id === t.dim).bounds;
  map.fitBounds(L.latLngBounds(toLatLng(b.minX, b.minZ), toLatLng(b.maxX + 1, b.maxZ + 1)), { animate: false });
}

function goTo(x, z, zoom = null) { map.setView(toLatLng(x + 0.5, z + 0.5), zoom ?? Math.max(map.getZoom(), 0)); }

function setCut(t, value) {
  const info = dimensionInfo(t.dim);
  const top = info.minY + info.height - 1;
  t.maxY = value >= top ? null : value;
  if (layer) layer.redraw();
}

// ---------------------------------------------------------------------------
// Pointer: selection tools, brushes, spawn
// ---------------------------------------------------------------------------

const blockAt = (e) => { const p = fromLatLng(e.latlng); return { x: Math.floor(p.x), z: Math.floor(p.z), fx: p.x, fz: p.z }; };
const half = (v) => Math.round(v * 2) / 2;
const modeFrom = (ev) => (ev.shiftKey ? 'add' : ev.altKey ? 'sub' : state.selMode);
let dragging = false;
let probeTimer = null;

function onMove(e) {
  const t = tab();
  if (!t) return;
  const b = blockAt(e);
  state.cursor = { ...b, probe: state.cursor && state.cursor.x === b.x && state.cursor.z === b.z ? state.cursor.probe : null };
  const d = state.draft;
  if (d && dragging) {
    if (d.type === 'rect') d.b = [b.x, b.z];
    else if (d.type === 'lasso' || d.type === 'stroke') {
      const last = d.points[d.points.length - 1];
      if (Math.hypot(b.fx - last[0], b.fz - last[1]) >= Math.max(0.5, 2 / Math.pow(2, map.getZoom()))) d.points.push([half(b.fx), half(b.fz)]);
    }
  } else if (d && d.type === 'poly') {
    d.hover = [half(b.fx), half(b.fz)];
  }
  overlay.draw(false);
  renderStatus();
  clearTimeout(probeTimer);
  probeTimer = setTimeout(async () => {
    const c = state.cursor;
    if (!c || !tab()) return;
    const p = await api.world.probe(t.id, t.dim, c.x, c.z, t.maxY).catch(() => null);
    if (state.cursor === c) { c.probe = p; renderStatus(); }
  }, 80);
}

function onDown(e) {
  const t = tab();
  const ev = e.originalEvent;
  if (!t || state.space || ev.button !== 0 || state.tool === 'move') return;
  const b = blockAt(e);
  if (state.tool === 'rect') { state.draft = { type: 'rect', a: [b.x, b.z], b: [b.x, b.z], mode: modeFrom(ev) }; dragging = true; }
  else if (state.tool === 'lasso') { state.draft = { type: 'lasso', points: [[half(b.fx), half(b.fz)]], mode: modeFrom(ev) }; dragging = true; }
  else if (state.tool === 'sbrush') { state.draft = { type: 'stroke', r: state.brushR, points: [[half(b.fx), half(b.fz)]], mode: modeFrom(ev) }; dragging = true; }
  else if (state.tool === 'biome') {
    if (t.info.readOnly) { toast('Mondo in sola lettura.', 'warn'); return; }
    const c = biomeColor(state.biome);
    state.draft = { type: 'stroke', r: state.brushR, points: [[half(b.fx), half(b.fz)]], fill: `rgba(${c[0]},${c[1]},${c[2]},.55)` };
    dragging = true;
  }
  overlay.draw(false);
}

async function onUp() {
  if (!dragging) return;
  dragging = false;
  const t = tab();
  const d = state.draft;
  if (!t || !d) return;
  if (d.type === 'rect') {
    commitShape({ type: 'rect', minX: Math.min(d.a[0], d.b[0]), minZ: Math.min(d.a[1], d.b[1]), maxX: Math.max(d.a[0], d.b[0]), maxZ: Math.max(d.a[1], d.b[1]) }, d.mode);
  } else if (d.type === 'lasso') {
    const pts = simplifyPoints(d.points);
    if (pts.length >= 3) commitShape({ type: 'poly', points: pts }, d.mode);
    else state.draft = null;
  } else if (d.type === 'stroke' && state.tool === 'sbrush') {
    commitShape({ type: 'stroke', r: d.r, points: simplifyPoints(d.points) }, d.mode);
  } else if (d.type === 'stroke' && state.tool === 'biome') {
    state.draft = null;
    await paintBiome({ type: 'stroke', r: d.r, points: simplifyPoints(d.points) });
  }
  overlay.draw(false);
}

async function onClick(e) {
  const t = tab();
  if (!t || state.space) return;
  const b = blockAt(e);
  if (state.tool === 'spawn') {
    if (t.dim !== 'overworld') { toast('Lo spawn del mondo sta nell\'Overworld.', 'warn'); return; }
    const p = await api.world.probe(t.id, t.dim, b.x, b.z, null);
    await pushOp({ type: 'setSpawn', x: b.x, y: p ? p.y + 1 : t.info.spawn.y, z: b.z });
  } else if (state.tool === 'poly') {
    const pt = [half(b.fx), half(b.fz)];
    if (!state.draft || state.draft.type !== 'poly') state.draft = { type: 'poly', points: [], mode: modeFrom(e.originalEvent) };
    const d = state.draft;
    const first = d.points[0];
    const near = first && Math.hypot(pt[0] - first[0], pt[1] - first[1]) * Math.pow(2, map.getZoom()) < 8;
    if (near && d.points.length >= 3) closePoly();
    else d.points.push(pt);
    overlay.draw(false);
  }
}

function onDblClick() { if (state.draft && state.draft.type === 'poly') closePoly(); }

function closePoly() {
  const d = state.draft;
  if (d && d.points.length >= 3) commitShape({ type: 'poly', points: d.points }, d.mode);
  else state.draft = null;
  overlay.draw(false);
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

let selSerial = 0;
function setSelection(t, sel) {
  t.selection = sel;
  t.selKey = `s${++selSerial}`;
  t.measure = null;
  overlay.draw();
  renderOptions(); renderPanel();
  // Exact counts can take a moment on a selection thousands of blocks wide.
  const key = t.selKey;
  setTimeout(() => {
    if (t.selKey !== key) return;
    t.measure = measure(sel);
    if (tab() === t) { renderOptions(); renderPanel(); }
  }, 0);
}

function commitShape(shape, mode) {
  const t = tab();
  state.draft = null;
  if (!t) return;
  const prev = t.selection || emptySelection();
  const next = combine(prev, mode === 'new' ? 'new' : mode, shape);
  setSelection(t, { ...next, yMin: prev.yMin, yMax: prev.yMax });
}

const selection = () => { const t = tab(); return t ? t.selection : null; };
const hasSelection = () => !isEmptySelection(selection());

function selectAll() {
  const t = tab(); if (!t) return;
  const b = t.info.dimensions.find((d) => d.id === t.dim).bounds;
  setSelection(t, { items: [{ mode: 'add', shape: { type: 'rect', ...b } }], yMin: t.selection?.yMin ?? null, yMax: t.selection?.yMax ?? null });
}
function deselect() { const t = tab(); if (t) { state.draft = null; setSelection(t, { ...emptySelection(), yMin: t.selection?.yMin ?? null, yMax: t.selection?.yMax ?? null }); } }
function invertSelection() {
  const t = tab(); if (!t) return;
  setSelection(t, invert(t.selection, t.info.dimensions.find((d) => d.id === t.dim).bounds));
}
function setYRange(lo, hi) {
  const t = tab(); if (!t) return;
  const s = t.selection || emptySelection();
  setSelection(t, { ...s, yMin: lo, yMax: hi });
}

const savedKey = (t) => `cantiere.sel.${t.info.path}`;
function savedSelections(t) { try { return JSON.parse(localStorage.getItem(savedKey(t)) || '[]'); } catch { return []; } }
function saveSelection(name) {
  const t = tab(); if (!t || !hasSelection()) return;
  const list = savedSelections(t).filter((s) => s.name !== name);
  list.unshift({ name, dim: t.dim, sel: t.selection, at: Date.now() });
  try { localStorage.setItem(savedKey(t), JSON.stringify(list.slice(0, 50))); } catch { toast('Spazio per le selezioni salvate esaurito.', 'err'); return; }
  toast(`Selezione “${name}” salvata.`);
  renderPanel();
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function pushOp(op) {
  const t = tab();
  if (!t) return;
  const res = await guard(() => api.journal.push(t.id, { ...op, at: Date.now() }));
  if (res) afterJournal(t, res);
}

function afterJournal(t, res) {
  const { dirty, ...info } = res;
  if (info.path) t.info = info;
  if (t === tab() && layer) layer.refreshIn(dirty && dirty.length ? dirty : []);
  if (t.search) t.search.stale = true;
  overlay.draw(false);
  render();
}

async function undo() { const t = tab(); if (t && t.info.journal.canUndo) afterJournal(t, await api.journal.undo(t.id)); }
async function redo() { const t = tab(); if (t && t.info.journal.canRedo) afterJournal(t, await api.journal.redo(t.id)); }
async function removeOp(i) { const t = tab(); if (t) afterJournal(t, await api.journal.remove(t.id, i)); }

/** Paint the chosen biome: a brush stroke, clipped to the selection if there is one. */
async function paintBiome(shape) {
  const t = tab();
  const sel = t.selection;
  const items = [{ mode: 'add', shape }];
  if (!isEmptySelection(sel)) items.push({ mode: 'and', shape: { type: 'region', region: { items: sel.items, yMin: null, yMax: null } } });
  await pushOp({ type: 'paintBiome', dim: t.dim, biome: state.biome, region: { items, yMin: sel?.yMin ?? null, yMax: sel?.yMax ?? null } });
}

async function fillSelectionWithBiome() {
  const t = tab();
  if (!t || !hasSelection()) { toast('Prima seleziona un\'area.', 'warn'); return; }
  await pushOp({ type: 'paintBiome', dim: t.dim, biome: state.biome, region: t.selection });
}

function setWeather(kind) { return pushOp({ type: 'setWeather', kind }); }

// ---------------------------------------------------------------------------
// Worlds and tabs
// ---------------------------------------------------------------------------

async function openWorld(dir) {
  if (!dir) return;
  const existing = state.tabs.find((t) => t.info.path === dir);
  if (existing) { activate(existing.id); return; }
  const res = await guard(() => api.world.open(dir));
  if (!res) return;
  const t = {
    id: res.id, info: res.info, dim: res.info.dimensions[0].id, maxY: null, view: 'blocks', mapView: null,
    selection: emptySelection(), selKey: 's0', measure: null, search: null, focusHit: null,
  };
  state.tabs.push(t);
  if (res.info.readOnly) toast('Mondo anteriore alla 1.18: aperto in sola lettura.', 'warn');
  if (res.info.journal.size) toast(`Ritrovate ${res.info.journal.size} modifiche in sospeso dall'ultima volta.`, 'warn');
  activate(t.id);
}

function activate(id) {
  state.active = id;
  state.draft = null;
  showTab();
  render();
}

async function closeTab(id) {
  const t = state.tabs.find((x) => x.id === id);
  if (!t) return;
  if (t.info.journal.size > 0 && !confirm(`“${t.info.name}” ha ${t.info.journal.size} modifiche non applicate. Restano salvate e le ritroverai riaprendo il mondo. Chiudere la scheda?`)) return;
  await api.world.close(id);
  state.tabs = state.tabs.filter((x) => x.id !== id);
  if (state.active === id) state.active = state.tabs.length ? state.tabs[state.tabs.length - 1].id : null;
  showTab();
  render();
}

async function pickAndOpen() { await openWorld(await api.worlds.pick()); }

function setDim(id) {
  const t = tab(); if (!t || t.dim === id) return;
  t.dim = id; t.view = 'blocks'; t.maxY = null; t.mapView = null; t.search = null;
  setSelection(t, emptySelection());
  showTab(); render();
}

// ---------------------------------------------------------------------------
// Top: menus and ribbon (Chrome.dc.html)
// ---------------------------------------------------------------------------

const MENUS = ['File', 'Modifica', 'Selezione', 'Mondo', 'Vista', 'Impostazioni'];

function ribbonItems() {
  const t = tab();
  const has = !!t;
  const j = t && t.info.journal;
  const ro = t && t.info.readOnly;
  const b = (act, ic, label, kb = '', enabled = true, on = false, title = '') => ({ act, ic, label, kb, enabled, on, title });
  const soon = (ic, label, phase) => b('', ic, label, '', false, false, `In arrivo (fase ${phase})`);
  switch (state.menu) {
    case 'File': return [b('open', 'i-open', 'Apri mondo…', '⌘O'), b('opensaves', 'i-open', 'Apri cartella saves'), b('close', 'i-plus', 'Chiudi mondo', '⌘W', has), '|',
      b('apply', 'i-check', 'Applica…', '⌘↩', has && j.size > 0 && !ro), b('reveal', 'i-eye', 'Mostra nel Finder', '', has)];
    case 'Modifica': return [b('undo', 'i-undo', 'Annulla', '⌘Z', has && j.canUndo), b('redo', 'i-redo', 'Ripeti', '⇧⌘Z', has && j.canRedo), '|',
      soon('i-cut', 'Taglia', 3), soon('i-copy', 'Copia', 3), soon('i-paste', 'Incolla', 3), '|', soon('i-rot', 'Ruota', 3), soon('i-flip', 'Specchia', 3), '|',
      b('replace', 't-replace', 'Sostituisci…', '', has && !ro)];
    case 'Selezione': return [b('selall', 'i-grid', 'Seleziona tutto', '⌘A', has), b('deselect', 'i-eye', 'Deseleziona', '⌘D', has && hasSelection()),
      b('invert', 'i-flip', 'Inverti', '⇧⌘I', has), '|', b('savesel', 'i-down', 'Salva selezione…', '', has && hasSelection()),
      b('ycut', 'i-fill', 'Y dalla quota di taglio', '', has && t.maxY !== null), '|', b('fillbiome', 't-biome', 'Riempi con il bioma', '', has && hasSelection() && !ro)];
    case 'Mondo': return [b('tool:spawn', 't-spawn', 'Spawn e regole', '', has, state.tool === 'spawn'), b('tool:search', 't-search', 'Cerca blocchi', '⌘F', has, state.tool === 'search'),
      b('replace', 't-replace', 'Sostituisci…', '', has && !ro), '|', soon('t-border', 'Bordo del mondo', 7), soon('t-players', 'Giocatori', 7), soon('t-prune', 'Pota chunk', 7)];
    case 'Vista': return has ? [
      ...t.info.dimensions.map((d) => b(`dim:${d.id}`, DIM_ICON[d.id] || 'd-over', d.label, '', true, t.dim === d.id)), '|',
      b('biomeview', 't-biome', 'Vista biomi', '', true, t.view === 'biomes'), b('grid', 'i-grid', 'Griglia chunk', '', true, state.grid), '|',
      b('fit', 'i-target', 'Adatta alla finestra', '⌘0'), b('goto', 'i-target', 'Vai a coordinate…', '⌘G'),
    ] : [{ text: 'Apri un mondo per le opzioni di vista.' }];
    case 'Impostazioni': return [b('savesdir', 'i-open', 'Cartella saves…'), { text: state.settings ? state.settings.savesDir : '' }, '|',
      b('theme:dark', 'i-eye', 'Scuro', '', true, state.settings?.theme === 'dark'), b('theme:light', 'i-eye', 'Chiaro', '', true, state.settings?.theme === 'light'),
      b('theme:system', 'i-eye', 'Come il sistema', '', true, state.settings?.theme === 'system'), '|', b('devtoggle', 'i-gear', 'Menu Sviluppo', '', true, !!state.settings?.dev)];
    case 'Sviluppo': return [b('devfill', 'i-fill', 'Riempi area con blocco…', '', has && !ro), { text: 'Comandi di prova per verificare in gioco la scrittura delle region.' }];
    default: return [];
  }
}

function renderMenu() {
  const menus = state.settings?.dev ? [...MENUS, 'Sviluppo'] : MENUS;
  if (!menus.includes(state.menu)) state.menu = 'Modifica';
  $('menu').innerHTML = menus.map((m) => `<button class="mn${state.menu === m ? ' on' : ''}" data-menu="${m}">${m}</button>`).join('');
  $('ribbon').innerHTML = ribbonItems().map((it) => {
    if (it === '|') return '<i class="rsep"></i>';
    if (it.text !== undefined) return `<span class="rtext">${esc(it.text)}</span>`;
    const title = it.title || (it.kb ? `${it.label}  ${it.kb}` : it.label);
    return `<button class="rb${it.on ? ' on' : ''}" data-act="${it.act}" ${it.enabled ? '' : 'disabled'} title="${esc(title)}">${icon(it.ic)}${esc(it.label)}</button>`;
  }).join('');
}

function renderTabs() {
  $('tabs').innerHTML = state.tabs.map((t) => `
    <button class="wt${t.id === state.active ? ' on' : ''}" data-tab="${t.id}" role="tab" aria-selected="${t.id === state.active}">
      ${icon(DIM_ICON[t.dim] || 'd-over')}${esc(t.info.name)}${t.info.dimensions.length > 1 ? `<span class="hint">· ${esc(t.info.dimensions.find((d) => d.id === t.dim)?.label || '')}</span>` : ''}
      ${t.info.journal.size ? '<i class="dot" title="Modifiche in sospeso"></i>' : ''}
      <span class="x" data-close="${t.id}" role="button" aria-label="Chiudi ${esc(t.info.name)}"><svg width="8" height="8" viewBox="0 0 8 8"><path d="M1 1l6 6M7 1L1 7" stroke="currentColor" stroke-width="1.4" fill="none"/></svg></span>
    </button>`).join('') + `<button class="wt-add" data-act="open" aria-label="Apri un altro mondo" title="Apri un mondo  ⌘O">${icon('i-plus')}</button>`;
}

function renderTools() {
  $('tools').innerHTML = TOOL_GROUPS.map(([label, items]) => `<div class="grp"><div class="gl caps">${label}</div>${items.map(([id, name, key, phase]) => {
    const title = phase ? `${name} — in arrivo (fase ${phase})` : key ? `${name}  ${key}` : name;
    return `<button class="tool${state.tool === id ? ' on' : ''}" data-tool="${id}" ${phase ? 'disabled' : ''} title="${esc(title)}" aria-pressed="${state.tool === id}">${icon(`t-${id}`)}<span>${name}</span>${id === 'sbrush' || id === 'terrain' ? '<i class="tri"></i>' : ''}</button>`;
  }).join('')}</div>`).join('')
    + `<button class="tools-foot" data-act="collapse-tools" title="Comprimi la colonna  ⌘\\">${icon('i-collapse')}<span>Comprimi</span></button>`;
  const c = map && map.getContainer();
  if (c) {
    c.classList.toggle('tool-draw', ['rect', 'poly', 'lasso', 'spawn'].includes(state.tool));
    c.classList.toggle('tool-brush', BRUSH_TOOLS.has(state.tool));
  }
  if (map) {
    if (state.tool === 'move' || state.space) map.dragging.enable(); else map.dragging.disable();
  }
}

// ---------------------------------------------------------------------------
// Tool options bar
// ---------------------------------------------------------------------------

function yFields(sel, info) {
  const full = !sel || sel.yMin === null || sel.yMin === undefined;
  const [lo, hi] = yRange(sel, info.minY, info.height);
  return `<label>Y min <input class="fld" id="y-min" value="${signed(lo)}" ${full ? 'disabled' : ''} aria-label="Y minima"></label>
    <label>Y max <input class="fld" id="y-max" value="${signed(hi)}" ${full ? 'disabled' : ''} aria-label="Y massima"></label>
    <label>Tutta la colonna <button class="sw${full ? ' on' : ''}" id="y-full" role="switch" aria-checked="${full}" aria-label="Tutta la colonna"></button></label>`;
}

function selectionSummary(t) {
  const m = t.measure;
  if (!hasSelection()) return '<span class="hint right">Nessuna selezione</span>';
  if (!m) return '<span class="hint right">…</span>';
  const info = dimensionInfo(t.dim);
  const [lo, hi] = yRange(t.selection, info.minY, info.height);
  const b = m.bounds;
  return `<span class="hint right"><b class="mono" style="color:var(--tx)">${fmt(b.maxX - b.minX + 1)} × ${fmt(b.maxZ - b.minZ + 1)}</b> · ${fmt(m.columns * (hi - lo + 1))} blocchi</span>`;
}

function renderOptions() {
  const t = tab();
  const el = $('options');
  if (!t) { el.innerHTML = ''; return; }
  const info = dimensionInfo(t.dim);
  const name = `<span class="nm">${esc(TOOL[state.tool].label)}</span>`;
  const brush = `<label>Dimensione <input type="range" id="brush-r" min="1" max="64" value="${state.brushR}" style="width:120px"><span class="mono" style="color:var(--tx)">${state.brushR * 2}</span></label>`;
  if (state.tool === 'move') {
    el.innerHTML = `${name}<span class="hint">Trascina per spostarti · scorri per ingrandire · tieni premuto spazio con qualsiasi strumento</span>
      <button class="btn right" data-act="fit">Adatta alla finestra</button><button class="btn" data-act="goto">Vai a coordinate…</button>`;
  } else if (SELECT_TOOLS.has(state.tool)) {
    const seg = [['new', 'Nuova'], ['add', 'Aggiungi'], ['sub', 'Sottrai'], ['and', 'Interseca']]
      .map(([id, l]) => `<button class="sg${state.selMode === id ? ' on' : ''}" data-selmode="${id}" title="${id === 'add' ? 'oppure tieni ⇧' : id === 'sub' ? 'oppure tieni ⌥' : ''}">${l}</button>`).join('');
    const hint = { rect: '', poly: '<span class="hint">Clic per i vertici · doppio clic o ↩ per chiudere</span>', lasso: '', sbrush: brush }[state.tool];
    el.innerHTML = `${name}<div class="seg" style="width:268px">${seg}</div>${hint}${yFields(t.selection, info)}${selectionSummary(t)}`;
  } else if (state.tool === 'biome') {
    el.innerHTML = `${name}<button class="picker-btn" id="biome-pick"><i class="tile" style="background:${rgb(biomeColor(state.biome))}"></i>${esc(biomeLabel(state.biome))} ▾</button>${brush}
      <span class="hint">${hasSelection() ? 'Il pennello dipinge solo dentro la selezione' : 'Dipingi sulla mappa · i biomi si cambiano a celle di 4×4'}</span>
      <button class="btn right" data-act="fillbiome" ${hasSelection() ? '' : 'disabled'}>Riempi la selezione</button>`;
  } else if (state.tool === 'replace') {
    el.innerHTML = `${name}<span class="hint">Ambito: ${hasSelection() ? `selezione attiva${t.measure ? ` · ${fmt(t.measure.columns)} colonne` : ''}` : 'tutta la dimensione (nessuna selezione)'}</span>
      <span class="hint right">Le sostituzioni restano in sospeso finché non premi Applica</span><button class="btn pri" data-act="replace">Regole…</button>`;
  } else if (state.tool === 'spawn') {
    el.innerHTML = `${name}<span class="hint">${t.dim === 'overworld' ? 'Clicca sulla mappa dove vuoi il punto di partenza (Y = superficie + 1)' : 'Lo spawn del mondo si imposta nell\'Overworld'}</span>
      <span class="hint right">Spawn attuale <b class="mono" style="color:var(--tx)">${signed(t.info.spawn.x)}, ${signed(t.info.spawn.y)}, ${signed(t.info.spawn.z)}</b></span>`;
  } else if (state.tool === 'search') {
    el.innerHTML = `${name}<span class="hint">${hasSelection() ? 'Cerca nella selezione' : 'Cerca in tutta la dimensione'} · i risultati compaiono nel pannello e sulla mappa</span>`;
  } else {
    el.innerHTML = `${name}<span class="hint">In arrivo.</span>`;
  }
}

// ---------------------------------------------------------------------------
// Right panel
// ---------------------------------------------------------------------------

const PANEL_TABS = [['props', 'Proprietà', 'i-gear'], ['clip', 'Appunti', 'i-paste'], ['history', 'Cronologia', 'i-undo'], ['results', 'Risultati', 't-search']];

function renderPanel() {
  const t = tab();
  $('panel-tabs').innerHTML = PANEL_TABS.map(([id, label, ic]) => `<button class="pt${state.panelTab === id ? ' on' : ''}" data-ptab="${id}" title="${label}">${ui.panelCollapsed ? icon(ic) : ''}<span>${label}</span>${id === 'history' && t && t.info.journal.size ? '<i class="pd"></i>' : ''}</button>`).join('');
  const body = $('panel-body');
  if (!t) { body.innerHTML = ''; return; }
  if (state.panelTab === 'props') body.innerHTML = propsHtml(t);
  else if (state.panelTab === 'history') historyHtml(t).then((h) => { if (state.panelTab === 'history') body.innerHTML = h; });
  else if (state.panelTab === 'results') body.innerHTML = searchHtml(t);
  else body.innerHTML = '<div class="sec"><div class="caps sh">Appunti</div><p class="empty-note">La libreria dei pezzi copiati, con le schematiche .schem e .nbt, arriva con il copia e incolla (fasi 3–4).</p></div>';
}

const sw = (id, on, label) => `<button class="sw${on ? ' on' : ''}" id="${id}" role="switch" aria-checked="${on}" aria-label="${esc(label)}"></button>`;

function propsHtml(t) {
  const i = t.info;
  const dimLabel = i.dimensions.find((d) => d.id === t.dim)?.label || t.dim;
  if (SELECT_TOOLS.has(state.tool)) return selectionPanel(t);
  if (state.tool === 'biome') return biomePanel(t);
  if (state.tool === 'spawn') return levelPanel(t);
  if (state.tool === 'search') return searchHtml(t);
  if (state.tool === 'replace') {
    return `<div class="sec"><div class="caps sh">Sostituisci</div><p class="hint" style="margin:0 0 10px">Le regole si scrivono nella finestra “Sostituisci blocchi”. ${hasSelection() ? 'Valgono dentro la selezione attiva.' : 'Senza selezione valgono in tutta la dimensione.'}</p>
      <div class="actions"><button class="btn pri" data-act="replace">Apri le regole…</button>${hasSelection() ? '<button class="btn" data-act="deselect">Deseleziona</button>' : ''}</div></div>${selectionPanel(t, true)}`;
  }
  return `
    <div class="sec"><div class="caps sh">Vista</div>
      <div class="row"><span>Griglia dei chunk</span>${sw('pv-grid', state.grid, 'Griglia dei chunk')}</div>
      <div class="row"><span>Vista biomi</span>${sw('pv-biomes', t.view === 'biomes', 'Vista biomi')}</div>
    </div>
    <div class="sec"><div class="caps sh">Mondo</div>
      <div class="row"><span>${esc(i.name)}</span><span class="v">${esc(dimLabel)}</span></div>
      <div class="row"><span>Versione</span><span class="v mono">${esc(i.version || '?')}</span></div>
      <div class="row"><span>Region</span><span class="v mono">${fmt(i.dimensions.find((d) => d.id === t.dim)?.regionCount || 0)}</span></div>
      ${i.isCopy ? '<div class="row"><span>Copia creata dal Cantiere</span><span class="v">sì</span></div>' : ''}
      ${i.readOnly ? '<div class="row"><span style="color:var(--rd)">Sola lettura: serve 1.18 o più recente</span></div>' : ''}
    </div>
    <div class="sec"><div class="safe-note">${icon('i-shield')}<span><b>Originale al sicuro.</b> Le modifiche restano in sospeso; Applica le scrive in una copia, “${esc(i.name)} (Cantiere)”.</span></div></div>`;
}

function selectionPanel(t, compact = false) {
  const m = t.measure;
  const info = dimensionInfo(t.dim);
  const [lo, hi] = yRange(t.selection, info.minY, info.height);
  const full = !t.selection || t.selection.yMin === null || t.selection.yMin === undefined;
  const saved = savedSelections(t).filter((s) => s.dim === t.dim);
  const stats = hasSelection() && m ? `
      <div class="row"><span>Dimensioni</span><span class="v mono">${fmt(m.bounds.maxX - m.bounds.minX + 1)} × ${fmt(m.bounds.maxZ - m.bounds.minZ + 1)}</span></div>
      <div class="row"><span>Colonne</span><span class="v mono">${fmt(m.columns)}</span></div>
      <div class="row"><span>Blocchi</span><span class="v mono">${fmt(m.columns * (hi - lo + 1))}</span></div>
      <div class="row"><span>Angolo</span><span class="v mono">X ${signed(m.bounds.minX)}, Z ${signed(m.bounds.minZ)}</span></div>
      <div class="row"><span>Chunk toccati</span><span class="v mono">${fmt(m.chunks)}</span></div>`
    : `<p class="empty-note" style="padding:0">${hasSelection() ? 'Misuro…' : 'Disegna sulla mappa con Rettangolo, Poligono, Lazo o Pennello. ⇧ aggiunge, ⌥ sottrae.'}</p>`;
  if (compact) return `<div class="sec"><div class="caps sh">Selezione</div>${stats}</div>`;
  return `
    <div class="sec"><div class="caps sh">Selezione</div>${stats}</div>
    <div class="sec"><div class="caps sh">Intervallo Y</div>
      <div class="row"><span>Da</span><input class="fld" id="py-min" value="${signed(lo)}" ${full ? 'disabled' : ''} aria-label="Y minima"></div>
      <div class="row"><span>A</span><input class="fld" id="py-max" value="${signed(hi)}" ${full ? 'disabled' : ''} aria-label="Y massima"></div>
      <div class="row"><span>Tutta la colonna</span>${sw('py-full', full, 'Tutta la colonna')}</div>
    </div>
    <div class="sec"><div class="caps sh">Azioni</div><div class="actions">
      <button class="btn" data-act="fillbiome" ${hasSelection() && !t.info.readOnly ? '' : 'disabled'}>Riempi con il bioma</button>
      <button class="btn" data-act="replace" ${t.info.readOnly ? 'disabled' : ''}>Sostituisci…</button>
      <button class="btn" data-act="searchhere" ${hasSelection() ? '' : 'disabled'}>Cerca qui</button>
      <button class="btn" data-act="savesel" ${hasSelection() ? '' : 'disabled'}>Salva…</button>
      <button class="btn" data-act="invert">Inverti</button>
      <button class="btn" data-act="deselect" ${hasSelection() ? '' : 'disabled'}>Deseleziona</button>
      ${state.settings?.dev ? `<button class="btn" data-act="devfill" ${t.info.readOnly ? 'disabled' : ''}>Riempi con blocco… (prova)</button>` : ''}
    </div></div>
    <div class="sec"><div class="caps sh">Selezioni salvate</div>
      ${saved.length ? saved.map((s) => `<div class="row"><button class="btn" data-loadsel="${esc(s.name)}" style="flex:1;justify-content:flex-start">${esc(s.name)}</button><button class="btn" data-delsel="${esc(s.name)}" aria-label="Elimina ${esc(s.name)}">${icon('i-trash')}</button></div>`).join('') : '<p class="empty-note" style="padding:0">Nessuna. “Salva…” tiene la selezione per questo mondo.</p>'}
    </div>`;
}

function biomePanel(t) {
  const list = biomesFor(t.dim);
  return `
    <div class="sec"><div class="caps sh">Bioma da dipingere</div>
      <div class="row"><span style="display:flex;align-items:center;gap:8px"><i class="tile" style="background:${rgb(biomeColor(state.biome))}"></i>${esc(biomeLabel(state.biome))}</span><span class="v mono">${esc(state.biome.replace('minecraft:', ''))}</span></div>
      <div class="actions" style="margin-top:8px"><button class="btn" data-act="fillbiome" ${hasSelection() ? '' : 'disabled'}>Riempi la selezione</button><button class="btn" data-act="biomeview">${t.view === 'biomes' ? 'Torna ai blocchi' : 'Mostra la vista biomi'}</button></div>
      <p class="hint" style="margin:10px 0 0">Si cambia solo il bioma (erba, fogliame, acqua, mob, meteo): i blocchi restano. ${hasSelection() ? 'Il pennello resta dentro la selezione e il suo intervallo Y.' : 'Tutta la colonna, dal fondo al cielo.'}</p>
    </div>
    <div class="sec"><div class="caps sh">Biomi</div>
      ${list.map((b) => `<button class="res" data-biome="${b.id}" ${b.id === state.biome ? 'style="background:var(--grDim)"' : ''}><i class="tile" style="background:${rgb(b.color)}"></i>${esc(b.label)}</button>`).join('')}
    </div>`;
}

/** 'minecraft:keep_inventory' (26.x) shows as 'keep_inventory'; older names stay as they are. */
const ruleLabel = (k) => k.replace(/^minecraft:/, '');

const DAY_PRESETS = [['Alba', 0], ['Giorno', 1000], ['Mezzogiorno', 6000], ['Tramonto', 12000], ['Notte', 13000], ['Mezzanotte', 18000]];

function levelPanel(t) {
  const i = t.info;
  const ro = i.readOnly ? 'disabled' : '';
  const weather = i.time.thundering ? 'storm' : i.time.raining ? 'rain' : 'clear';
  const rules = Object.entries(i.gameRules).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => (
    v === 'true' || v === 'false'
      ? `<div class="rule-row"><span title="${esc(k)}">${esc(ruleLabel(k))}</span><button class="sw${v === 'true' ? ' on' : ''}" data-rule="${esc(k)}" data-bool="1" role="switch" aria-checked="${v === 'true'}" aria-label="${esc(k)}" ${ro}></button></div>`
      : `<div class="rule-row"><span title="${esc(k)}">${esc(ruleLabel(k))}</span><input class="fld" data-rule="${esc(k)}" value="${esc(v)}" ${ro} aria-label="${esc(k)}"></div>`)).join('');
  return `
    <div class="sec"><div class="caps sh">Spawn del mondo</div>
      <div class="row"><span>X · Y · Z</span><span style="display:flex;gap:4px"><input class="fld" id="sp-x" value="${i.spawn.x}" ${ro} aria-label="X"><input class="fld" id="sp-y" value="${i.spawn.y}" ${ro} aria-label="Y"><input class="fld" id="sp-z" value="${i.spawn.z}" ${ro} aria-label="Z"></span></div>
      <div class="actions" style="margin-top:6px"><button class="btn" id="sp-set" ${ro}>Imposta</button><button class="btn" data-act="gospawn">Vai allo spawn</button></div>
      <p class="hint" style="margin:8px 0 0">Oppure clicca sulla mappa con lo strumento Spawn. Il raggio è la regola <span class="mono">${i.splitLevel ? 'respawn_radius' : 'spawnRadius'}</span>.</p>
    </div>
    <div class="sec"><div class="caps sh">Ora del giorno</div>
      <div class="row"><select class="fld" id="day-preset" ${ro}><option value="">Scegli…</option>${DAY_PRESETS.map(([n, v]) => `<option value="${v}">${n}</option>`).join('')}</select><input class="fld" id="day-time" value="${esc(i.time.dayTime)}" ${ro} aria-label="Tick del giorno" style="width:90px"></div>
    </div>
    <div class="sec"><div class="caps sh">Meteo</div>
      <div class="seg">${[['clear', 'Sereno'], ['rain', 'Pioggia'], ['storm', 'Temporale']].map(([v, l]) => `<button class="sg${weather === v ? ' on' : ''}" data-weather="${v}" ${ro}>${l}</button>`).join('')}</div>
    </div>
    <div class="sec"><div class="caps sh">Regole di gioco</div>${rules || '<p class="empty-note">Nessuna regola salvata.</p>'}</div>`;
}

const OP_COLOR = { setSpawn: '#ee6a62', setGameRule: '#62a8f0', setLevelValue: '#f2b13b', setDayTime: '#f2b13b', setWeather: '#f2b13b', fillBox: '#d9a033', replaceBlocks: '#76ba5a', paintBiome: '#3f7d35' };

function describeOp(op) {
  const c = (n) => fmt(n);
  switch (op.type) {
    case 'setSpawn': return ['Spawn spostato', `X ${signed(op.x)}, Y ${signed(op.y)}, Z ${signed(op.z)}`];
    case 'setGameRule': return [`Regola ${ruleLabel(op.rule)}`, `= ${op.value}`];
    case 'setDayTime': return ['Ora del giorno', String(op.value)];
    case 'setWeather': return ['Meteo', { clear: 'Sereno', rain: 'Pioggia', storm: 'Temporale' }[op.kind] || op.kind];
    case 'setLevelValue': return [{ DayTime: 'Ora del giorno', raining: 'Pioggia', thundering: 'Temporale', rainTime: 'Durata pioggia', thunderTime: 'Durata temporale', clearWeatherTime: 'Durata sereno' }[op.path[op.path.length - 1]] || op.path.join('.'), String(op.value)];
    case 'fillBox': return [`Riempi · ${op.state}`, `${c(Math.abs(op.x2 - op.x1) + 1)} × ${c(Math.abs(op.z2 - op.z1) + 1)} × ${c(Math.abs(op.y2 - op.y1) + 1)}`];
    case 'replaceBlocks': return [`Sostituisci · ${op.rules.length === 1 ? `${op.rules[0].from} → ${op.rules[0].to}` : `${op.rules.length} regole`}`, bboxText(op.region)];
    case 'paintBiome': return [`Bioma · ${biomeLabel(op.biome)}`, bboxText(op.region)];
    default: return [op.type, ''];
  }
}
const bboxText = (sel) => { const b = selectionBounds(sel); return b ? `${fmt(b.maxX - b.minX + 1)} × ${fmt(b.maxZ - b.minZ + 1)}` : ''; };

async function historyHtml(t) {
  const { done, undone } = await api.journal.ops(t.id);
  if (!done.length && !undone.length) return '<div class="sec"><div class="caps sh">In sospeso · 0</div><p class="empty-note">Nessuna modifica in sospeso. Quello che fai resta qui finché non premi Applica.</p></div>';
  const row = (op, i, isUndone) => {
    const [title, sub] = describeOp(op);
    return `<div class="hi${isUndone ? ' undone' : ''}"><i class="tile" style="background:${OP_COLOR[op.type] || '#8b8e93'}"></i><div class="t"><div>${esc(title)}</div><small>${esc([sub, ago(op.at)].filter(Boolean).join(' · '))}</small></div>
      ${isUndone ? '' : `<button class="undo" data-unop="${i}" title="Togli questa modifica" aria-label="Togli ${esc(title)}">↶</button>`}</div>`;
  };
  return `<div class="sec"><div class="caps sh">In sospeso · ${done.length}</div>${done.map((o, i) => [o, i]).reverse().map(([o, i]) => row(o, i, false)).join('')}</div>
    ${undone.length ? `<div class="sec"><div class="caps sh">Annullate · ⇧⌘Z per ripetere</div>${undone.slice().reverse().map((o) => row(o, -1, true)).join('')}</div>` : ''}`;
}

// ---------------------------------------------------------------------------
// Search (Risultati)
// ---------------------------------------------------------------------------

function searchHtml(t) {
  const s = state.search;
  const r = t.search;
  const kinds = [['block', 'Blocco'], ['blockEntity', 'Contenuto'], ['entity', 'Entità']];
  const fields = s.kind === 'block'
    ? `<label for="q-block">Blocco</label><input class="fld text" id="q-block" value="${esc(s.block)}" placeholder="diamond_ore, #minecraft:logs, *_ore" list="q-blocks" spellcheck="false">`
    : s.kind === 'blockEntity'
      ? `<label for="q-id">Tipo</label><input class="fld text" id="q-id" value="${esc(s.id)}" placeholder="chest, spawner, *sign (vuoto: tutti)" spellcheck="false">
         <label for="q-item">Contiene</label><input class="fld text" id="q-item" value="${esc(s.item)}" placeholder="diamond (oggetto nel contenitore)" spellcheck="false">
         <label for="q-text">Testo</label><input class="fld text" id="q-text" value="${esc(s.text)}" placeholder="testo di un cartello, un nome…">`
      : `<label for="q-id">Tipo</label><input class="fld text" id="q-id" value="${esc(s.id)}" placeholder="villager, *_golem (vuoto: tutte)" spellcheck="false">
         <label for="q-text">Testo</label><input class="fld text" id="q-text" value="${esc(s.text)}" placeholder="nome personalizzato…">`;
  const running = !!s.running;
  let results = '';
  if (running) results = `<div class="sec"><div class="caps sh">Cerco…</div><div class="pb"><i style="width:${Math.round(s.progress * 100)}%"></i></div></div>`;
  else if (r) {
    results = `<div class="sec"><div class="caps sh">Risultati · ${fmt(r.total)}${r.stale ? ' · <span style="color:var(--am)">da aggiornare</span>' : ''}</div>
      ${r.total ? `<p class="hint" style="margin:0 0 8px">${r.truncated ? `Mostro i primi ${fmt(r.items.length)}; sulla mappa sono segnati quelli. ` : ''}In ${fmt(r.chunks.length)} chunk.</p>
        <div class="actions" style="margin-bottom:8px"><button class="btn" data-act="exportcsv">${icon('i-down')}Esporta CSV</button><button class="btn" data-act="clearsearch">Pulisci</button></div>
        ${r.items.slice(0, 400).map((h, i) => `<button class="res" data-hit="${i}"><i class="tile" style="background:#ff3d8b"></i>${esc(h.label)}<span class="mono">${signed(h.x)}, ${signed(h.y)}, ${signed(h.z)}</span></button>`).join('')}
        ${r.items.length > 400 ? `<p class="hint">… e altri ${fmt(r.items.length - 400)} nel CSV.</p>` : ''}`
    : '<p class="empty-note" style="padding:0">Nessun risultato.</p>'}</div>`;
  }
  return `<div class="sec"><div class="caps sh">Cerca</div>
      <div class="seg" style="margin-bottom:10px">${kinds.map(([k, l]) => `<button class="sg${s.kind === k ? ' on' : ''}" data-qkind="${k}">${l}</button>`).join('')}</div>
      <div class="form-grid">${fields}</div>
      <p class="hint" style="margin:10px 0">${hasSelection() ? 'Ambito: la selezione attiva (e il suo intervallo Y).' : 'Ambito: tutta la dimensione.'}</p>
      <div class="actions">${running ? '<button class="btn" data-act="cancelsearch">Annulla</button>' : '<button class="btn pri" data-act="runsearch">Cerca</button>'}</div>
      <datalist id="q-blocks"></datalist>
    </div>${results}`;
}

async function runSearch() {
  const t = tab();
  if (!t) return;
  const s = state.search;
  const query = s.kind === 'block' ? { kind: 'block', block: s.block } : s.kind === 'blockEntity' ? { kind: 'blockEntity', id: s.id, item: s.item, text: s.text } : { kind: 'entity', id: s.id || '*', text: s.text };
  if (s.kind === 'block' && !s.block.trim()) { toast('Scrivi un blocco da cercare.', 'warn'); return; }
  const taskId = `q${Date.now()}`;
  s.running = taskId; s.progress = 0;
  renderPanel();
  const off = api.task.onProgress((id, p) => {
    if (id !== taskId) return;
    s.progress = p.done / Math.max(1, p.total);
    const bar = document.querySelector('#panel-body .pb i');
    if (bar) bar.style.width = `${Math.round(s.progress * 100)}%`;
  });
  try {
    const r = await api.world.search(t.id, t.dim, hasSelection() ? t.selection : null, query, taskId);
    t.search = r; t.focusHit = null;
    if (r.total) toast(`${fmt(r.total)} trovati.`); else toast('Nessun risultato.', 'warn');
  } catch (err) {
    if (!/Annullato/.test(cleanError(err))) toast(cleanError(err), 'err');
  } finally {
    off();
    s.running = null;
    renderPanel(); overlay.draw(false);
  }
}

async function exportCsv() {
  const t = tab(); if (!t || !t.search) return;
  const lines = ['x,y,z,cosa', ...t.search.items.map((h) => `${h.x},${h.y},${h.z},${h.label}`)];
  const path = await guard(() => api.saveText(`ricerca-${t.info.name}.csv`, `${lines.join('\n')}\n`));
  if (path) toast('CSV salvato.');
}

// ---------------------------------------------------------------------------
// Status bar (StatusBar.dc.html) and map chips
// ---------------------------------------------------------------------------

function renderStatus() {
  const t = tab();
  const c = state.cursor;
  const parts = [];
  if (t && c) {
    parts.push(`<span class="mono">X ${signed(c.x)}</span><span class="mono">Z ${signed(c.z)}</span>${c.probe ? `<span class="mono">Y ${signed(c.probe.y)}</span>` : ''}`);
    if (c.probe) parts.push(`<span>${esc(c.probe.block.replace('minecraft:', ''))}${c.probe.biome ? ` · ${esc(biomeLabel(c.probe.biome))}` : ''}</span>`);
    parts.push(`<span class="where">Chunk ${signed(c.x >> 4)}, ${signed(c.z >> 4)} · r.${signed(c.x >> 9)}.${signed(c.z >> 9)}</span>`);
  }
  if (map && t) parts.push(`<span>Zoom ${fmt(Math.round(Math.pow(2, map.getZoom()) * 100))}%</span>`);
  let cut = '';
  if (t) {
    const info = dimensionInfo(t.dim);
    const top = info.minY + info.height - 1;
    cut = `<div class="cut"><label for="cut-y">Quota di taglio</label><input id="cut-y" type="range" min="${info.minY}" max="${top}" value="${t.maxY ?? top}"><span class="mono" id="cut-val">${t.maxY === null ? 'Tutta la colonna' : `Y ${signed(t.maxY)}`}</span></div>`;
  }
  const n = t ? t.info.journal.size : 0;
  $('status').innerHTML = `${parts.join('<i class="sep"></i>')}${cut || '<span style="margin-left:auto"></span>'}
    ${n ? `<i class="sep"></i><div class="pend"><i></i>${fmt(n)} modific${n === 1 ? 'a' : 'he'} in sospeso</div>` : ''}
    <button class="ap" data-act="apply" ${n && !t.info.readOnly ? '' : 'disabled'}>Applica<span class="kb">⌘↩</span></button>`;
}

function renderChips() {
  const t = tab();
  if (!t || !map) { $('map-chips').innerHTML = ''; return; }
  const sb = scaleBar(Math.pow(2, map.getZoom()));
  $('map-chips').innerHTML = `<div class="chip" style="font-weight:700;width:26px;text-align:center;padding:5px 0">N</div>
    <div><div class="chip" style="padding:3px 8px;margin-bottom:4px;font-size:11px;display:inline-block">${fmt(sb.blocks)} blocchi</div><div class="scale-bar" style="width:${Math.round(sb.width)}px"></div></div>
    ${t.view === 'biomes' ? '<div class="chip">Vista biomi</div>' : ''}${t.maxY !== null ? `<div class="chip">Taglio a Y ${signed(t.maxY)}</div>` : ''}`;
}

// ---------------------------------------------------------------------------
// Start screen (Avvio.dc.html)
// ---------------------------------------------------------------------------

async function renderStart() {
  document.body.classList.toggle('no-world', state.tabs.length === 0);
  if (state.tabs.length) return;
  const { dir, worlds } = await api.worlds.list();
  $('start').innerHTML = `<div class="start-col">
    <div class="start-hd">${icon('logo', '')}<div><h1>Cantiere</h1><p>Scegli un mondo da modificare. Le modifiche vanno sempre in una copia.</p></div></div>
    <div class="caps" style="margin:0 0 8px 2px">Cartella dei salvataggi</div>
    <div class="start-dir">${icon('i-open')}<b title="${esc(dir)}">${esc(dir)}</b><button class="btn" data-act="savesdir">Apri altra cartella…</button></div>
    <div class="caps" style="margin:0 0 8px 2px">${worlds.length === 1 ? '1 mondo trovato' : `${worlds.length} mondi trovati`}</div>
    ${worlds.length ? worlds.slice(0, 60).map((w) => `
      <button class="wr${w.readOnly ? ' off' : ''}" data-open="${esc(w.path)}">
        <div class="th" ${w.icon ? `style="background-image:url('${w.icon}')"` : ''}>${w.icon ? '' : icon('logo', '')}</div>
        <div style="flex:1;min-width:0"><div class="nm">${esc(w.name)}</div><div class="meta">${esc(w.dimensions.join(', '))} · modificato ${esc(whenText(w.modified))}${w.folder !== w.name ? ` · cartella “${esc(w.folder)}”` : ''}</div></div>
        <span class="ver${w.readOnly ? ' bad' : ''}">${esc(w.version || '?')}</span>
        <div class="note">${w.readOnly ? 'Sola lettura · serve 1.18 o più recente' : w.cantiere ? 'Copia del Cantiere' : ''}</div>
      </button>`).join('') : `<p class="empty-note">Nessun mondo in questa cartella. Scegline un'altra, oppure apri un mondo da qualsiasi posizione con ⌘O.</p>`}
    <div class="start-foot"><i></i>L'originale non viene mai modificato: Applica crea “nome (Cantiere)” accanto al mondo.</div>
    <div style="margin-top:14px"><button class="btn" data-act="open">Apri un mondo da un'altra posizione…  ⌘O</button></div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Render everything
// ---------------------------------------------------------------------------

function render() {
  renderMenu(); renderTabs(); renderTools(); renderOptions(); renderStatus(); renderChips();
  renderPanel(); renderStart();
}

function applyTheme() {
  const th = state.settings?.theme || 'dark';
  const dark = th === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches : th === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

function setTool(id) {
  if (!TOOL[id] || TOOL[id].phase) return;
  if (state.draft && state.draft.type === 'poly' && id !== 'poly') state.draft = null;
  state.tool = id;
  if (id === 'search') state.panelTab = 'props';
  if (['biome', 'spawn', 'replace'].includes(id) || SELECT_TOOLS.has(id)) state.panelTab = 'props';
  render();
  overlay && overlay.draw(false);
  if (id === 'replace' && tab()) replaceDialog(ctx);
}

const ctx = {
  api, tab, selection, pushOp, afterJournal, openWorld, saveSelection,
  center: () => fromLatLng(map.getCenter()),
  goTo: (x, z) => goTo(x, z),
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const ACTIONS = {
  open: pickAndOpen,
  opensaves: () => state.settings && api.openPath(state.settings.savesDir),
  close: () => state.active && closeTab(state.active),
  undo, redo,
  apply: () => applyDialog(ctx),
  reveal: () => tab() && api.reveal(tab().info.path),
  replace: () => tab() && replaceDialog(ctx),
  selall: selectAll, deselect, invert: invertSelection,
  savesel: () => hasSelection() && saveSelectionDialog(ctx),
  ycut: () => { const t = tab(); if (t && t.maxY !== null) setYRange(dimensionInfo(t.dim).minY, t.maxY); },
  fillbiome: fillSelectionWithBiome,
  searchhere: () => setTool('search'),
  runsearch: runSearch,
  cancelsearch: () => state.search.running && api.task.cancel(state.search.running),
  clearsearch: () => { const t = tab(); if (t) { t.search = null; t.focusHit = null; renderPanel(); overlay.draw(false); } },
  exportcsv: exportCsv,
  biomeview: () => { const t = tab(); if (!t) return; t.view = t.view === 'biomes' ? 'blocks' : 'biomes'; if (layer) layer.redraw(); render(); },
  grid: () => { state.grid = !state.grid; overlay.draw(false); render(); },
  fit: fitDimension,
  goto: () => tab() && gotoDialog(ctx),
  gospawn: () => { const t = tab(); if (t) goTo(t.info.spawn.x, t.info.spawn.z); },
  savesdir: async () => { const d = await api.settings.pickSavesDir(); if (d) { state.settings = await api.settings.get(); render(); } },
  devtoggle: async () => { state.settings = await api.settings.set({ dev: !state.settings.dev }); if (state.settings.dev) state.menu = 'Sviluppo'; render(); },
  devfill: () => devFillDialog(ctx),
  'collapse-tools': () => { ui.toolsCollapsed = !ui.toolsCollapsed; saveUi(); applyLayout(); },
};

function applyLayout() {
  document.body.classList.toggle('tools-collapsed', !!ui.toolsCollapsed);
  document.body.classList.toggle('panel-collapsed', !!ui.panelCollapsed);
  setTimeout(() => map && map.invalidateSize(), 0);
  renderPanel();
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-menu],[data-act],[data-tab],[data-close],[data-tool],[data-open],[data-ptab],[data-selmode],[data-hit],[data-biome],[data-unop],[data-loadsel],[data-delsel],[data-qkind],[data-weather],[data-rule][data-bool]');
  if (!el) {
    if (e.target.id === 'sp-set') pushOp({ type: 'setSpawn', x: Number($('sp-x').value), y: Number($('sp-y').value), z: Number($('sp-z').value) });
    else if (e.target.id === 'biome-pick') {
      const t = tab();
      const b = await pickFrom(e.target, biomesFor(t.dim).map((x) => ({ id: x.id, label: x.label, swatch: rgb(x.color) })), { placeholder: 'Cerca un bioma…', current: state.biome, allowCustom: true });
      if (b) { state.biome = b.includes(':') ? b : `minecraft:${b}`; render(); }
    } else if (['y-full', 'py-full'].includes(e.target.id)) {
      const t = tab(); const s = t.selection || emptySelection();
      const info = dimensionInfo(t.dim);
      if (s.yMin === null || s.yMin === undefined) setYRange(info.minY, t.maxY ?? info.minY + info.height - 1);
      else setYRange(null, null);
    } else if (e.target.id === 'pv-grid') ACTIONS.grid();
    else if (e.target.id === 'pv-biomes') ACTIONS.biomeview();
    return;
  }
  const d = el.dataset;
  if (d.close) { e.stopPropagation(); closeTab(Number(d.close)); }
  else if (d.tab) activate(Number(d.tab));
  else if (d.menu) { state.menu = d.menu; renderMenu(); }
  else if (d.act) {
    if (d.act.startsWith('dim:')) setDim(d.act.slice(4));
    else if (d.act.startsWith('tool:')) setTool(d.act.slice(5));
    else if (d.act.startsWith('theme:')) { state.settings = await api.settings.set({ theme: d.act.slice(6) }); applyTheme(); render(); }
    else if (ACTIONS[d.act]) ACTIONS[d.act]();
  } else if (d.tool) setTool(d.tool);
  else if (d.open) openWorld(d.open);
  else if (d.ptab) {
    if (ui.panelCollapsed) { ui.panelCollapsed = false; saveUi(); applyLayout(); }
    state.panelTab = d.ptab; renderPanel();
  } else if (d.selmode) { state.selMode = d.selmode; renderOptions(); }
  else if (d.hit !== undefined) { const t = tab(); const h = t.search.items[Number(d.hit)]; t.focusHit = h; goTo(h.x, h.z, Math.max(map.getZoom(), 1)); overlay.draw(false); }
  else if (d.biome) { state.biome = d.biome; render(); }
  else if (d.unop !== undefined) removeOp(Number(d.unop));
  else if (d.loadsel) { const t = tab(); const s = savedSelections(t).find((x) => x.name === d.loadsel); if (s) { setSelection(t, s.sel); const b = selectionBounds(s.sel); if (b) map.fitBounds(L.latLngBounds(toLatLng(b.minX, b.minZ), toLatLng(b.maxX + 1, b.maxZ + 1)).pad(0.2)); } }
  else if (d.delsel) { const t = tab(); try { localStorage.setItem(savedKey(t), JSON.stringify(savedSelections(t).filter((x) => x.name !== d.delsel))); } catch { /* ignore */ } renderPanel(); }
  else if (d.qkind) { state.search.kind = d.qkind; renderPanel(); }
  else if (d.weather) setWeather(d.weather);
  else if (d.rule && d.bool) pushOp({ type: 'setGameRule', rule: d.rule, value: !el.classList.contains('on') });
});

const parseY = (v) => Number(String(v).replace('−', '-'));

document.addEventListener('change', (e) => {
  const t = tab();
  if (!t) return;
  const el = e.target;
  if (el.id === 'cut-y') { setCut(t, Number(el.value)); renderStatus(); renderChips(); overlay.draw(false); }
  else if (['y-min', 'y-max', 'py-min', 'py-max'].includes(el.id)) {
    const lo = parseY(($('y-min') || $('py-min')).value), hi = parseY(($('y-max') || $('py-max')).value);
    const a = el.id.endsWith('min') ? parseY(el.value) : lo, b = el.id.endsWith('max') ? parseY(el.value) : hi;
    if (Number.isFinite(a) && Number.isFinite(b)) setYRange(Math.min(a, b), Math.max(a, b));
  } else if (el.dataset.rule && !el.dataset.bool) pushOp({ type: 'setGameRule', rule: el.dataset.rule, value: Number(el.value) });
  else if (el.id === 'day-preset') { if (el.value !== '') pushOp({ type: 'setDayTime', value: Number(el.value) }); }
  else if (el.id === 'day-time') pushOp({ type: 'setDayTime', value: Math.max(0, Math.floor(Number(el.value) || 0)) });
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.id === 'cut-y') {
    const t = tab(); const info = dimensionInfo(t.dim); const top = info.minY + info.height - 1;
    $('cut-val').textContent = Number(el.value) >= top ? 'Tutta la colonna' : `Y ${signed(el.value)}`;
  } else if (el.id === 'brush-r') {
    state.brushR = Number(el.value);
    el.nextElementSibling.textContent = String(state.brushR * 2);
    overlay.draw(false);
  } else if (el.id === 'q-block') state.search.block = el.value;
  else if (el.id === 'q-id') state.search.id = el.value;
  else if (el.id === 'q-item') state.search.item = el.value;
  else if (el.id === 'q-text') state.search.text = el.value;
});

const typing = () => /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName);

document.addEventListener('keydown', (e) => {
  const meta = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (e.key === 'Escape') {
    if (document.querySelector('#popover-host .popover')) return;
    if (modalOpen()) { closeModal(); return; }
    if (state.draft) { state.draft = null; dragging = false; overlay.draw(false); return; }
  }
  if (modalOpen()) return;
  if (e.key === 'Enter' && !meta && state.draft && state.draft.type === 'poly') { closePoly(); return; }
  if (e.key === 'Enter' && typing() && document.activeElement.closest('#panel-body') && document.activeElement.id?.startsWith('q-')) { runSearch(); return; }
  if (typing()) return;
  if (e.code === 'Space' && !state.space) {
    state.space = true;
    map.dragging.enable();
    map.getContainer().classList.add('space-pan');
    overlay.draw(false);
    e.preventDefault();
    return;
  }
  if (meta) {
    if (k === 'o') { e.preventDefault(); pickAndOpen(); }
    else if (k === 'w') { e.preventDefault(); ACTIONS.close(); }
    else if (k === 'z') { e.preventDefault(); (e.shiftKey ? redo : undo)(); }
    else if (e.key === 'Enter') { e.preventDefault(); applyDialog(ctx); }
    else if (k === 'a') { e.preventDefault(); selectAll(); }
    else if (k === 'd') { e.preventDefault(); deselect(); }
    else if (k === 'i' && e.shiftKey) { e.preventDefault(); invertSelection(); }
    else if (k === '0') { e.preventDefault(); fitDimension(); }
    else if (k === 'g') { e.preventDefault(); ACTIONS.goto(); }
    else if (k === 'f') { e.preventDefault(); setTool('search'); }
    else if (e.key === '\\' || e.code === 'Backslash') { e.preventDefault(); if (e.altKey) { ui.panelCollapsed = !ui.panelCollapsed; } else { ui.toolsCollapsed = !ui.toolsCollapsed; } saveUi(); applyLayout(); }
    return;
  }
  const byKey = { v: 'move', m: 'rect', p: 'poly', l: 'lasso', s: 'sbrush', b: 'biome', r: 'replace', f: 'search' };
  if (byKey[k] && tab()) { setTool(byKey[k]); return; }
  if (e.key === '[' || e.key === ']') {
    state.brushR = Math.max(1, Math.min(64, state.brushR + (e.key === ']' ? 1 : -1) * Math.max(1, Math.round(state.brushR / 6))));
    renderOptions(); overlay.draw(false);
  }
});

document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && state.space) {
    state.space = false;
    if (state.tool !== 'move') map.dragging.disable();
    map.getContainer().classList.remove('space-pan');
    overlay.draw(false);
  }
});

api.onTilesReady((id, box) => { if (id === state.active && layer) layer.refreshIn([box]); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

(async function start() {
  if (api.platform === 'darwin') document.body.classList.add('mac');
  state.settings = await api.settings.get();
  applyTheme();
  initMap();
  applyLayout();
  render();
})();
