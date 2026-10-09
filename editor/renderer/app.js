/*
 * Cantiere window. No filesystem here: everything goes through window.cantiere
 * (preload.cjs). The map is Leaflet in CRS.Simple with block coordinates as
 * map units — lng = blockX, lat = -blockZ — exactly like the Cube-Atlas app.
 */

const api = window.cantiere;
const $ = (id) => document.getElementById(id);
const toLatLng = (x, z) => L.latLng(-z, x);
const fromLatLng = (ll) => ({ x: ll.lng, z: -ll.lat });

const state = {
  tabs: [],
  active: null,        // tab id
  menu: 'file',
  tool: 'pan',
  panelTab: 'props',
  settings: null,
  cursor: null,        // { x, z, probe }
};

const MENUS = ['File', 'Modifica', 'Selezione', 'Mondo', 'Vista', 'Impostazioni'];

// Tools of the brief; the ones whose phase hasn't landed yet are disabled.
const TOOLS = [
  { id: 'pan', icon: '✋', label: 'Sposta' },
  { id: 'select', icon: '▭', label: 'Selezione', phase: 2 },
  { id: 'biome', icon: '🎨', label: 'Pennello bioma', phase: 2 },
  { id: 'terrain', icon: '⛰', label: 'Pennelli terreno', phase: 5 },
  { id: 'plants', icon: '🌳', label: 'Vegetazione', phase: 6 },
  { id: 'river', icon: '🌊', label: 'Fiume / Lago', phase: 6 },
  { id: 'replace', icon: '🔁', label: 'Sostituisci', phase: 2 },
  { id: 'spawn', icon: '📍', label: 'Spawn' },
  { id: 'search', icon: '🔍', label: 'Cerca', phase: 2 },
  { id: 'prune', icon: '✂', label: 'Pota chunk', phase: 7 },
  { id: 'players', icon: '🧍', label: 'Giocatori', phase: 7 },
];

const DAY_PRESETS = [['Alba', 0], ['Giorno', 1000], ['Mezzogiorno', 6000], ['Tramonto', 12000], ['Notte', 13000], ['Mezzanotte', 18000]];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tab = () => state.tabs.find((t) => t.id === state.active) || null;

function toast(message, kind = '') {
  let node = $('toast');
  if (!node) { node = document.createElement('div'); node.id = 'toast'; document.body.appendChild(node); }
  node.className = kind;
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 4200);
}

async function guard(fn) {
  try { return await fn(); } catch (err) {
    toast(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

let map = null;
let layer = null;
let spawnPin = null;

function initMap() {
  map = L.map('map', {
    crs: L.CRS.Simple, minZoom: -6, maxZoom: 5, zoomSnap: 0.5, zoomDelta: 0.5,
    wheelPxPerZoomLevel: 90, attributionControl: false, doubleClickZoom: false,
  });
  map.setView([0, 0], 0);
  map.on('mousemove', onMouseMove);
  map.on('click', onMapClick);
  map.on('moveend zoomend', () => {
    const t = tab();
    if (t) t.view = { center: fromLatLng(map.getCenter()), zoom: map.getZoom() };
    renderStatus();
  });
}

function makeLayer(t) {
  const Terrain = L.GridLayer.extend({
    createTile(coords, done) {
      const canvas = document.createElement('canvas');
      canvas.width = 256; canvas.height = 256;
      api.world.tile(t.id, t.dim, coords.z, coords.x, coords.y, t.cut ? t.maxY : null).then((buf) => {
        if (buf) canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.byteLength), 256, 256), 0, 0);
        done(null, canvas);
      }).catch((err) => done(err, canvas));
      return canvas;
    },
  });
  return new Terrain({
    tileSize: 256, minZoom: -6, maxZoom: 5, minNativeZoom: -6, maxNativeZoom: 0,
    noWrap: true, keepBuffer: 2, updateWhenZooming: false,
  });
}

/** Point the map at the active tab (new layer, remembered view). */
function showTab(first = false) {
  const t = tab();
  if (layer) { map.removeLayer(layer); layer = null; }
  if (spawnPin) { map.removeLayer(spawnPin); spawnPin = null; }
  if (!t) return;
  layer = makeLayer(t).addTo(map);
  const d = t.info.dimensions.find((x) => x.id === t.dim);
  if (d) {
    const b = d.bounds;
    map.setMaxBounds(L.latLngBounds(toLatLng(b.minX, b.minZ), toLatLng(b.maxX + 1, b.maxZ + 1)).pad(1.0));
  }
  const v = t.view || { center: [t.info.spawn.x, t.info.spawn.z], zoom: 0 };
  map.setView(toLatLng(v.center[0], v.center[1]), v.zoom, { animate: false });
  drawSpawn();
}

function refreshTiles() { if (layer) layer.redraw(); }

function drawSpawn() {
  const t = tab();
  if (spawnPin) { map.removeLayer(spawnPin); spawnPin = null; }
  if (!t || t.dim !== 'overworld') return;
  spawnPin = L.marker(toLatLng(t.info.spawn.x + 0.5, t.info.spawn.z + 0.5), {
    icon: L.divIcon({ className: '', html: '<div class="spawn-pin" title="Spawn del mondo"></div>', iconSize: [0, 0] }),
    interactive: false,
  }).addTo(map);
}

let probeTimer = null;
function onMouseMove(e) {
  const t = tab();
  if (!t) return;
  const { x, z } = fromLatLng(e.latlng);
  state.cursor = { x: Math.floor(x), z: Math.floor(z), probe: state.cursor && state.cursor.probe };
  renderStatus();
  clearTimeout(probeTimer);
  probeTimer = setTimeout(async () => {
    const c = state.cursor;
    if (!c || !tab()) return;
    c.probe = await api.world.probe(t.id, t.dim, c.x, c.z, t.cut ? t.maxY : null).catch(() => null);
    renderStatus();
  }, 90);
}

async function onMapClick(e) {
  const t = tab();
  if (!t || state.tool !== 'spawn') return;
  const { x, z } = fromLatLng(e.latlng);
  const bx = Math.floor(x), bz = Math.floor(z);
  const p = await api.world.probe(t.id, t.dim, bx, bz, null);
  await pushOp({ type: 'setSpawn', x: bx, y: p ? p.y + 1 : t.info.spawn.y, z: bz });
}

// ---------------------------------------------------------------------------
// Worlds and tabs
// ---------------------------------------------------------------------------

async function openWorld(dir) {
  if (!dir) return;
  const existing = state.tabs.find((t) => t.info.path === dir);
  if (existing) { activate(existing.id); return; }
  const res = await guard(() => api.world.open(dir));
  if (!res) return;
  const t = { id: res.id, info: res.info, dim: res.info.dimensions[0].id, cut: false, maxY: 320, view: null };
  state.tabs.push(t);
  if (res.info.readOnly) toast('Mondo anteriore alla 1.18: aperto in sola lettura.');
  activate(t.id);
}

function activate(id) {
  state.active = id;
  showTab();
  render();
}

async function closeTab(id) {
  const t = state.tabs.find((x) => x.id === id);
  if (!t) return;
  if (t.info.journal.size > 0 && !confirm(`"${t.info.name}" ha ${t.info.journal.size} modifiche non applicate. Restano salvate e le ritroverai riaprendo il mondo. Chiudere la scheda?`)) return;
  await api.world.close(id);
  state.tabs = state.tabs.filter((x) => x.id !== id);
  if (state.active === id) state.active = state.tabs.length ? state.tabs[state.tabs.length - 1].id : null;
  showTab();
  render();
}

async function pickAndOpen() { await openWorld(await api.worlds.pick()); }

async function pushOp(op) {
  const t = tab();
  if (!t) return;
  const info = await guard(() => api.journal.push(t.id, op));
  if (info) afterJournal(t, info);
}

function afterJournal(t, info) {
  t.info = info;
  refreshTiles();
  drawSpawn();
  render();
}

async function undo() { const t = tab(); if (t && t.info.journal.canUndo) afterJournal(t, await api.journal.undo(t.id)); }
async function redo() { const t = tab(); if (t && t.info.journal.canRedo) afterJournal(t, await api.journal.redo(t.id)); }

// ---------------------------------------------------------------------------
// Top bars
// ---------------------------------------------------------------------------

function renderMenu() {
  $('menu').innerHTML = MENUS.map((m) => `<button data-menu="${m}" class="${state.menu === m ? 'active' : ''}">${m}</button>`).join('');
}

function ribbonItems() {
  const t = tab();
  const has = !!t;
  const j = t && t.info.journal;
  const b = (id, label, enabled = true) => ({ id, label, enabled });
  switch (state.menu) {
    case 'File': return [b('open', 'Apri mondo… ⌘O'), b('close', 'Chiudi scheda ⌘W', has), 'sep', b('reveal', 'Mostra nel Finder', has)];
    case 'Modifica': return [b('undo', 'Annulla ⌘Z', has && j.canUndo), b('redo', 'Ripeti ⇧⌘Z', has && j.canRedo), 'sep', b('cut', 'Taglia', false), b('copy', 'Copia', false), b('paste', 'Incolla', false)];
    case 'Selezione': return [b('x', 'Rettangolo', false), b('x', 'Poligono', false), b('x', 'Lazo', false), b('x', 'Pennello', false), 'sep', b('x', 'Disponibile dalla fase 2', false)];
    case 'Mondo': return [b('apply', 'Applica… ⌘↩', has && j.size > 0), 'sep', b('spawntool', 'Imposta lo spawn', has)];
    case 'Vista': return has ? [{ dims: true }, 'sep', { cut: true }] : [];
    case 'Impostazioni': return [b('savesdir', 'Cartella dei mondi…'), { text: state.settings ? state.settings.savesDir : '' }];
    default: return [];
  }
}

function renderRibbon() {
  const t = tab();
  $('ribbon').innerHTML = ribbonItems().map((it) => {
    if (it === 'sep') return '<span class="sep"></span>';
    if (it.text !== undefined) return `<span class="empty-note">${esc(it.text)}</span>`;
    if (it.dims) return t.info.dimensions.map((d) => `<button data-dim="${esc(d.id)}" class="${t.dim === d.id ? 'primary' : ''}">${esc(d.label)}</button>`).join('');
    if (it.cut) return `<label><input type="checkbox" id="cut-on" ${t.cut ? 'checked' : ''}> Taglio orizzontale</label>`;
    return `<button data-act="${it.id}" ${it.enabled ? '' : 'disabled'}>${esc(it.label)}</button>`;
  }).join('');
}

function renderTabs() {
  $('tabs').innerHTML = state.tabs.map((t) => `
    <div class="tab ${t.id === state.active ? 'active' : ''}" data-tab="${t.id}" role="tab">
      <span>${esc(t.info.name)}</span><span class="dim">${esc(t.info.dimensions.find((d) => d.id === t.dim)?.label || '')}</span>
      ${t.info.journal.size ? '<span class="dot" title="Modifiche in sospeso"></span>' : ''}
      <span class="x" data-close="${t.id}" title="Chiudi">×</span>
    </div>`).join('');
}

function renderTools() {
  $('tools').innerHTML = TOOLS.map((t) => {
    const off = t.phase ? `disabled title="In arrivo (fase ${t.phase})"` : '';
    return `<button data-tool="${t.id}" class="${state.tool === t.id ? 'active' : ''}" ${off}><span class="ico">${t.icon}</span>${t.label}</button>`;
  }).join('');
  $('main').classList.toggle('map-spawn-tool', state.tool === 'spawn');
  document.body.classList.toggle('map-spawn-tool', state.tool === 'spawn');
}

function renderOptions() {
  const t = tab();
  if (!t) { $('options').textContent = ''; return; }
  $('options').innerHTML = state.tool === 'spawn'
    ? 'Spawn: clicca sulla mappa dove vuoi il nuovo punto di partenza (Y = superficie + 1).'
    : `${esc(t.info.name)} · ${esc(t.info.version || '')} · trascina per spostarti, rotella per lo zoom`;
}

// ---------------------------------------------------------------------------
// Right panel
// ---------------------------------------------------------------------------

const PANEL_TABS = [['props', 'Proprietà'], ['clip', 'Appunti'], ['history', 'Cronologia'], ['results', 'Risultati']];

function renderPanelTabs() {
  $('panel-tabs').innerHTML = PANEL_TABS.map(([id, label]) => `<button data-ptab="${id}" class="${state.panelTab === id ? 'active' : ''}">${label}</button>`).join('');
}

async function renderPanel() {
  renderPanelTabs();
  const t = tab();
  const body = $('panel-body');
  if (!t) { body.innerHTML = '<p class="empty-note">Nessun mondo aperto.</p>'; return; }
  if (state.panelTab === 'props') body.innerHTML = propsHtml(t);
  else if (state.panelTab === 'history') body.innerHTML = await historyHtml(t);
  else body.innerHTML = '<p class="empty-note">Disponibile in una fase successiva.</p>';
}

function weatherOf(time) { return time.thundering ? 'storm' : time.raining ? 'rain' : 'clear'; }

function propsHtml(t) {
  const i = t.info;
  const ro = i.readOnly ? 'disabled' : '';
  const rules = Object.entries(i.gameRules).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => (
    v === 'true' || v === 'false'
      ? `<label class="rule">${esc(k)}<input type="checkbox" data-rule="${esc(k)}" ${v === 'true' ? 'checked' : ''} ${ro}></label>`
      : `<label class="rule">${esc(k)}<input type="number" data-rule="${esc(k)}" value="${esc(v)}" ${ro}></label>`)).join('');
  return `
    <h3>Spawn del mondo</h3>
    <div class="coords">
      <input type="number" id="sp-x" value="${i.spawn.x}" ${ro}><input type="number" id="sp-y" value="${i.spawn.y}" ${ro}><input type="number" id="sp-z" value="${i.spawn.z}" ${ro}>
    </div>
    <div class="field wide"><button id="sp-set" ${ro}>Imposta lo spawn</button></div>
    <h3>Ora del giorno</h3>
    <div class="field"><select id="day-preset" ${ro}>${DAY_PRESETS.map(([n, v]) => `<option value="${v}">${n} (${v})</option>`).join('')}<option value="" selected>Altro…</option></select>
      <input type="number" id="day-time" value="${esc(i.time.dayTime)}" ${ro}></div>
    <h3>Meteo</h3>
    <div class="field wide"><select id="weather" ${ro}>
      <option value="clear" ${weatherOf(i.time) === 'clear' ? 'selected' : ''}>Sereno</option>
      <option value="rain" ${weatherOf(i.time) === 'rain' ? 'selected' : ''}>Pioggia</option>
      <option value="storm" ${weatherOf(i.time) === 'storm' ? 'selected' : ''}>Temporale</option></select></div>
    <h3>Regole di gioco</h3>
    ${rules || '<p class="empty-note">Nessuna regola salvata.</p>'}`;
}

function describeOp(op) {
  switch (op.type) {
    case 'setSpawn': return `Spawn → ${op.x}, ${op.y}, ${op.z}`;
    case 'setGameRule': return `Regola ${op.rule} = ${op.value}`;
    case 'setLevelValue': return `${op.path.slice(1).join('.')} = ${op.value}`;
    case 'fillBox': return `Riempi ${op.state}`;
    default: return op.type;
  }
}

const OP_LABELS = { setSpawn: 'Spawn', setGameRule: 'Regole di gioco', setLevelValue: 'Ora e meteo', fillBox: 'Riempimenti' };

async function historyHtml(t) {
  const { done, undone } = await api.journal.ops(t.id);
  if (!done.length && !undone.length) return '<p class="empty-note">Nessuna modifica in sospeso.</p>';
  return [...done.map((o, n) => `<div class="op">${n + 1}. ${esc(describeOp(o))}</div>`),
    ...undone.slice().reverse().map((o) => `<div class="op undone">${esc(describeOp(o))}</div>`)].join('');
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

function renderStatus() {
  const t = tab();
  const c = state.cursor;
  const parts = [];
  if (t && c) {
    parts.push(`X <b>${c.x}</b> Z <b>${c.z}</b>`);
    if (c.probe) parts.push(`Y <b>${c.probe.y}</b> <b>${esc(c.probe.block.replace('minecraft:', ''))}</b>${c.probe.biome ? ` · ${esc(c.probe.biome.replace('minecraft:', ''))}` : ''}`);
    parts.push(`chunk <b>${c.x >> 4}, ${c.z >> 4}</b> · regione <b>${c.x >> 9}, ${c.z >> 9}</b>`);
  }
  if (map && t) parts.push(`zoom <b>${map.getZoom()}</b>`);
  const cut = t ? `<span id="cut">Quota <input type="range" id="cut-y" min="-64" max="320" value="${t.maxY}" ${t.cut ? '' : 'disabled'}><b id="cut-val">${t.cut ? t.maxY : '—'}</b></span>` : '';
  const n = t ? t.info.journal.size : 0;
  $('status').innerHTML = `${parts.map((p) => `<span>${p}</span>`).join('')}<span class="grow"></span>${cut}
    <span id="pending">${n ? `${n} modific${n === 1 ? 'a' : 'he'} in sospeso` : ''}</span>
    <button class="primary" data-act="apply" ${n ? '' : 'disabled'}>Applica</button>`;
}

// ---------------------------------------------------------------------------
// Empty screen
// ---------------------------------------------------------------------------

async function renderEmpty() {
  $('empty').classList.toggle('hidden', state.tabs.length > 0);
  if (state.tabs.length) return;
  const { dir, worlds } = await api.worlds.list();
  $('saves-dir').textContent = worlds.length ? `Mondi trovati in ${dir}` : `Nessun mondo trovato in ${dir} — cambia cartella da Impostazioni.`;
  $('world-list').innerHTML = worlds.slice(0, 30).map((w) => `
    <button data-open="${esc(w.path)}"><span>${esc(w.name)}</span><span class="meta">${w.cantiere ? 'copia del Cantiere · ' : ''}${new Date(w.modified).toLocaleDateString('it-IT')}</span></button>`).join('');
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

function modal(html) {
  const host = $('modal-host');
  host.innerHTML = `<div class="modal" role="dialog">${html}</div>`;
  return host.firstElementChild;
}
const closeModal = () => { $('modal-host').innerHTML = ''; };

async function applyFlow() {
  const t = tab();
  if (!t || !t.info.journal.size) return;
  const pre = await guard(() => api.apply.check(t.id));
  if (!pre) return;
  const summary = Object.entries(t.info.journal.summary).map(([k, v]) => `<li>${esc(OP_LABELS[k] || k)} × ${v}</li>`).join('');
  const m = modal(`
    <h2>Applica le modifiche</h2>
    <p>Verrà creata una <b>copia</b> del mondo; l'originale non viene toccato.</p>
    <label>Nome della copia<input type="text" id="copy-name" value="${esc(pre.copyName)}"></label>
    <ul>${summary}</ul>
    <p>Chunk da riscrivere: <b>${pre.stats.chunks}</b> in ${pre.stats.regions} file di regione.</p>
    ${pre.errors.map((e) => `<p class="err">⛔ ${esc(e)}</p>`).join('')}
    ${pre.warnings.map((w) => `<p class="warn">⚠ ${esc(w)}</p>`).join('')}
    <div class="progress hidden"><div></div></div><p id="apply-phase" class="empty-note"></p>
    <div class="buttons"><button id="apply-cancel">Annulla</button><button class="primary" id="apply-go" ${pre.ok ? '' : 'disabled'}>Applica</button></div>`);
  m.querySelector('#apply-cancel').onclick = closeModal;
  m.querySelector('#apply-go').onclick = async () => {
    const name = m.querySelector('#copy-name').value.trim();
    m.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    m.querySelector('.progress').classList.remove('hidden');
    const off = api.apply.onProgress((id, p) => {
      if (id !== t.id) return;
      m.querySelector('.progress > div').style.width = `${Math.round((p.done / Math.max(1, p.total)) * 100)}%`;
      m.querySelector('#apply-phase').textContent = `${p.phase}${p.file ? ` — ${p.file}` : ''}`;
    });
    try {
      const res = await api.apply.run(t.id, { copyName: name });
      off();
      t.info = res.info;
      refreshTiles(); drawSpawn(); render();
      const done = modal(`<h2>Fatto</h2><p>Creata la copia <b>${esc(res.name)}</b>: ${res.chunks} chunk riscritti in ${res.regions} file.</p>
        ${res.warnings.map((w) => `<p class="warn">⚠ ${esc(w)}</p>`).join('')}
        <p class="empty-note">Aprila in Minecraft dall'elenco dei mondi e controlla le modifiche.</p>
        <div class="buttons"><button id="d-reveal">Mostra nel Finder</button><button id="d-open">Apri la copia qui</button><button class="primary" id="d-ok">Chiudi</button></div>`);
      done.querySelector('#d-ok').onclick = closeModal;
      done.querySelector('#d-reveal').onclick = () => api.reveal(res.targetDir);
      done.querySelector('#d-open').onclick = () => { closeModal(); openWorld(res.targetDir); };
    } catch (err) {
      off();
      closeModal();
      toast(`Applica non è riuscita: ${String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, 'error');
    }
  };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function render() {
  renderMenu(); renderRibbon(); renderTabs(); renderTools(); renderOptions(); renderStatus();
  renderPanel(); renderEmpty();
}

const ACTIONS = {
  open: pickAndOpen,
  close: () => state.active && closeTab(state.active),
  undo, redo,
  apply: applyFlow,
  reveal: () => tab() && api.reveal(tab().info.path),
  spawntool: () => { state.tool = 'spawn'; render(); },
  savesdir: async () => { const d = await api.settings.pickSavesDir(); if (d) { state.settings = await api.settings.get(); render(); } },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-menu],[data-act],[data-tab],[data-close],[data-tool],[data-dim],[data-open],[data-ptab]');
  if (!el) return;
  const d = el.dataset;
  if (d.close) { e.stopPropagation(); closeTab(Number(d.close)); }
  else if (d.tab) activate(Number(d.tab));
  else if (d.menu) { state.menu = d.menu; renderMenu(); renderRibbon(); }
  else if (d.act && ACTIONS[d.act]) ACTIONS[d.act]();
  else if (d.tool) { state.tool = d.tool; render(); }
  else if (d.dim) { const t = tab(); t.dim = d.dim; t.view = null; showTab(); render(); }
  else if (d.open) openWorld(d.open);
  else if (d.ptab) { state.panelTab = d.ptab; renderPanel(); }
});

document.addEventListener('change', (e) => {
  const t = tab();
  if (!t) return;
  const el = e.target;
  if (el.id === 'cut-on') { t.cut = el.checked; refreshTiles(); renderStatus(); }
  else if (el.id === 'cut-y') { t.maxY = Number(el.value); refreshTiles(); renderStatus(); }
  else if (el.dataset.rule) pushOp({ type: 'setGameRule', rule: el.dataset.rule, value: el.type === 'checkbox' ? el.checked : Number(el.value) });
  else if (el.id === 'day-preset') { if (el.value !== '') pushOp({ type: 'setLevelValue', path: ['Data', 'DayTime'], kind: 'long', value: Number(el.value) }); }
  else if (el.id === 'day-time') pushOp({ type: 'setLevelValue', path: ['Data', 'DayTime'], kind: 'long', value: Math.max(0, Math.floor(Number(el.value) || 0)) });
  else if (el.id === 'weather') setWeather(el.value);
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'cut-y') $('cut-val').textContent = e.target.value;
});

document.addEventListener('click', (e) => {
  if (e.target.id === 'sp-set') {
    pushOp({ type: 'setSpawn', x: Number($('sp-x').value), y: Number($('sp-y').value), z: Number($('sp-z').value) });
  }
  if (e.target.id === 'empty-open') pickAndOpen();
});

async function setWeather(kind) {
  const set = (name, k, v) => pushOp({ type: 'setLevelValue', path: ['Data', name], kind: k, value: v });
  const rain = kind !== 'clear', storm = kind === 'storm';
  await set('raining', 'byte', rain ? 1 : 0);
  await set('thundering', 'byte', storm ? 1 : 0);
  if (rain) await set('rainTime', 'int', 6000);
  if (storm) await set('thunderTime', 'int', 6000);
  if (!rain) await set('clearWeatherTime', 'int', 6000);
}

document.addEventListener('keydown', (e) => {
  const meta = e.metaKey || e.ctrlKey;
  if (!meta || /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
  const k = e.key.toLowerCase();
  if (k === 'o') { e.preventDefault(); pickAndOpen(); }
  else if (k === 'w') { e.preventDefault(); ACTIONS.close(); }
  else if (k === 'z') { e.preventDefault(); (e.shiftKey ? redo : undo)(); }
  else if (e.key === 'Enter') { e.preventDefault(); applyFlow(); }
});

(async function start() {
  state.settings = await api.settings.get();
  initMap();
  render();
})();
