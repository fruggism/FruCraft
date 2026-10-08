/*
 * The way in: the title screen (3a) and the world list (3b).
 *
 * The first thing asked is the saves folder, not a single world: picked once,
 * it is remembered, and every world in it is one click away from then on.
 * A world kept somewhere else (a server backup, a download) is added to the
 * list by hand and remembered too.
 *
 * What a world *is* stays where it was: main.js opens it (openWorldFromInit)
 * and creates or opens its atlas. This module only decides which one, and
 * owns the two full-screen pages that ask.
 */

import { state, el, escapeHtml, toast, engine, projects } from './ui-core.js';
import { supportsHandles, sourceFromFileList } from './worldPicker.js';
import { idbGet, idbPut, idbDelete, idbEntriesPrefix } from './db.js';

const SAVES_KEY = 'lastSaves';
const EXTRA_PREFIX = 'extraWorld:';
const BACKDROP_KEY = 'titleBackdrop';
const DEV = typeof location !== 'undefined' && new URLSearchParams(location.search).has('dev');

let bridge = null;
let wsOpen = false;
let savesInit = null;     // the folder the list was read from
let rows = [];            // what the list shows, see describeRows()
let selected = -1;
let selectToken = 0;
let iconUrls = [];
const looseExtras = [];   // worlds added through the file input: this session only

// ------------------------------------------------------------- permissions ---

async function granted(handle, prompt) {
  if (!handle || typeof handle.queryPermission !== 'function') return false;
  const opts = { mode: 'read' };
  try {
    let s = await handle.queryPermission(opts);
    if (s !== 'granted' && prompt) s = await handle.requestPermission(opts);
    return s === 'granted';
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ title screen ---

function navWantsTitle() {
  const nav = bridge.getNav();
  return nav.section === 'atlas2d' && nav.mode === 'editor';
}

/** Show whichever page is due: world list, title screen, or the app. */
export function sync() {
  if (!bridge) return;
  const title = !wsOpen && !state.project && navWantsTitle();
  el('title-screen').classList.toggle('hidden', !title);
  el('world-select-screen').classList.toggle('hidden', !wsOpen);
  el('app').classList.toggle('title-on', title || wsOpen);
  if (title) refreshTitle();
}

const sameDay = (a, b) => a.toDateString() === b.toDateString();
function when(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return 'oggi';
  if (sameDay(d, yesterday)) return 'ieri';
  return d.toLocaleDateString('it-IT');
}

let latestProject = null;

async function refreshTitle() {
  let list = [];
  try { list = await projects.listProjects(); } catch { /* no IndexedDB */ }
  latestProject = list[0] || null;
  const btn = el('btn-title-resume');
  btn.classList.toggle('hidden', !latestProject);
  if (latestProject) {
    el('ts-resume-name').textContent = `Riprendi «${latestProject.name}»`;
    el('ts-resume-date').textContent = when(latestProject.updatedAt);
  }
  let saves = null;
  try { saves = await idbGet('handles', SAVES_KEY); } catch { /* ignore */ }
  el('ts-saves-hint').innerHTML = saves
    ? `cartella ricordata: <b>${escapeHtml(saves.name)}</b>`
    : 'di solito <b>.minecraft/saves</b>: la scegli una volta, poi viene ricordata';
  showBackdrop();
}

async function showBackdrop() {
  const node = el('ts-backdrop');
  let blob = null;
  try { blob = await idbGet('meta', BACKDROP_KEY); } catch { /* ignore */ }
  if (node.dataset.url) URL.revokeObjectURL(node.dataset.url);
  if (blob instanceof Blob) {
    const url = URL.createObjectURL(blob);
    node.dataset.url = url;
    node.style.backgroundImage = `url("${url}")`;
    node.classList.add('has-map');
  } else {
    node.style.backgroundImage = '';
    node.classList.remove('has-map');
  }
}

/**
 * Keep a small picture of the map for the title screen's background: the
 * last view, blurred, says "this is your world" better than any texture.
 * Only the terrain tiles are drawn (they are canvases); the layers are SVG
 * and do not matter at that blur.
 */
export async function captureBackdrop(map) {
  if (!map || !state.project) return;
  const box = map.getContainer().getBoundingClientRect();
  if (box.width < 50 || box.height < 50) return;
  const k = 640 / box.width;
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = Math.round(box.height * k);
  const g = canvas.getContext('2d');
  g.fillStyle = '#10120e';
  g.fillRect(0, 0, canvas.width, canvas.height);
  let drawn = 0;
  for (const tile of map.getContainer().querySelectorAll('canvas.leaflet-tile')) {
    const r = tile.getBoundingClientRect();
    if (r.right < box.left || r.left > box.right || r.bottom < box.top || r.top > box.bottom) continue;
    try {
      g.drawImage(tile, (r.left - box.left) * k, (r.top - box.top) * k, r.width * k, r.height * k);
      drawn++;
    } catch { /* a tile still empty */ }
  }
  if (drawn < 2) return;
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.7));
  if (blob) { try { await idbPut('meta', blob, BACKDROP_KEY); } catch { /* ignore */ } }
}

// ------------------------------------------------------------ saves folder ---

let fileInputResolve = null;

/** The folder to list. Remembered after the first time, unless asked anew. */
async function pickSaves({ forcePicker = false } = {}) {
  if (DEV) return { kind: 'http', base: '/__world', name: 'saves' };
  if (!forcePicker) {
    let stored = null;
    try { stored = await idbGet('handles', SAVES_KEY); } catch { /* ignore */ }
    if (stored && await granted(stored, true)) return { kind: 'handle', handle: stored, name: stored.name };
  }
  if (supportsHandles) {
    try {
      const handle = await window.showDirectoryPicker({ id: 'cube-atlas-saves', mode: 'read' });
      try { await idbPut('handles', handle, SAVES_KEY); } catch { /* private mode */ }
      return { kind: 'handle', handle, name: handle.name };
    } catch (err) {
      if (err && err.name === 'AbortError') return null;
      // The API exists but refused: fall back to the file input below.
    }
  }
  // Safari, Firefox: a file list, read fine but not remembered.
  return new Promise((resolve) => {
    fileInputResolve = resolve;
    el('world-input').click();
  });
}

function onWorldInput(e) {
  const files = e.target.files;
  const resolve = fileInputResolve;
  fileInputResolve = null;
  if (resolve) resolve(files && files.length ? sourceFromFileList(files) : null);
  e.target.value = '';
}

// -------------------------------------------------------------- the list ---

/** How the app will know this world again: the key its atlases carry. */
function keyFor(init, w) {
  if (init.kind === 'handle') return `handle:${w.path ? w.folder : init.handle.name}`;
  if (init.kind === 'http') {
    const base = `http:${init.base}`;
    const inner = [init.prefix, w.path].filter(Boolean).join('/');
    return inner ? `${base}/${inner}` : base;
  }
  return `files:${w.path || init.name}:`;
}

const keyMatches = (project, key) => project.world && project.world.id
  && (project.world.id === key || (key.startsWith('files:') && project.world.id.startsWith(key)));

async function describeExtras() {
  const out = [];
  let stored = [];
  try { stored = await idbEntriesPrefix('handles', EXTRA_PREFIX); } catch { /* ignore */ }
  for (const [key, handle] of stored) {
    const init = { kind: 'handle', handle, name: handle.name };
    if (await granted(handle, false)) {
      try {
        const { worlds } = await engine.listWorlds(init);
        if (worlds[0]) out.push({ w: worlds[0], init, manual: true, extraKey: key });
        continue;
      } catch { /* fall through to the "ask" row */ }
    }
    out.push({
      w: { levelName: handle.name, folder: handle.name, path: '', readable: true, needsPermission: true },
      init, manual: true, extraKey: key,
    });
  }
  for (const loose of looseExtras) out.push(loose);
  return out;
}

export async function openWorldSelect(init) {
  if (!init) return;
  savesInit = init;
  wsOpen = true;
  sync();
  el('ws-folder').textContent = init.handle ? init.handle.name : init.name;
  el('ws-count').textContent = '';
  el('ws-search').value = '';
  el('ws-list').innerHTML = '<li class="ws-empty">Leggo i mondi…</li>';
  resetSide();
  let listed = { worlds: [] };
  try {
    listed = await engine.listWorlds(init);
  } catch (err) {
    el('ws-list').innerHTML = `<li class="ws-empty err">${escapeHtml(err.message)}</li>`;
  }
  rows = listed.worlds.map((w) => ({ w, init: null, manual: false }));
  rows.push(...await describeExtras());
  let saved = [];
  try { saved = await projects.listProjects(); } catch { /* ignore */ }
  for (const r of rows) {
    const key = keyFor(r.init || savesInit, r.w);
    r.hasAtlas = saved.some((p) => keyMatches(p, key))
      || saved.some((p) => p.world && p.world.levelName && p.world.levelName === r.w.levelName);
  }
  const readable = rows.filter((r) => r.w.readable).length;
  el('ws-count').textContent = `${rows.length} ${rows.length === 1 ? 'mondo' : 'mondi'}`
    + (readable < rows.length ? ` · ${readable} leggibili` : '');
  renderList();
  const first = rows.findIndex((r) => r.w.readable && !r.w.needsPermission);
  if (first >= 0) selectRow(first);
}

function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.toLocaleDateString('it-IT')} ${d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`;
}

function renderList() {
  iconUrls.forEach((u) => URL.revokeObjectURL(u));
  iconUrls = [];
  const q = el('ws-search').value.trim().toLowerCase();
  const host = el('ws-list');
  const items = rows.map((r, i) => ({ r, i }))
    .filter(({ r }) => !q || r.w.levelName.toLowerCase().includes(q)
      || String(r.w.folder || '').toLowerCase().includes(q));
  if (!items.length) {
    host.innerHTML = `<li class="ws-empty">${rows.length ? 'Nessun mondo con questo nome.' : 'In questa cartella non ci sono mondi. Prova «Cambia cartella» o «Aggiungi un mondo».'}</li>`;
    return;
  }
  host.innerHTML = items.map(({ r, i }) => {
    const w = r.w;
    let thumb = '<img src="img/icons/grass.png" alt="">';
    if (w.icon) {
      const url = URL.createObjectURL(new Blob([w.icon], { type: 'image/png' }));
      iconUrls.push(url);
      thumb = `<img src="${url}" alt="">`;
    } else if (!w.readable) {
      thumb = '<img src="img/icons/barrier.png" alt="">';
    }
    const sub = [w.folder, fmtDate(w.lastPlayed)].filter(Boolean).join(' · ')
      + (r.manual ? ' · <span class="ws-manual">aggiunto a mano</span>' : '');
    let line;
    if (w.needsPermission) line = '<span class="ws-ask">tocca per concedere di nuovo l\'accesso</span>';
    else if (!w.readable) line = `<span class="ws-reason">${escapeHtml(w.reason || 'non leggibile')}</span>`;
    else line = escapeHtml([w.gameTypeLabel, w.version, `${(w.regionCount || 0).toLocaleString('it-IT')} regioni`].filter(Boolean).join(' · '));
    return `<li class="ws-row${w.readable ? '' : ' disabled'}${i === selected ? ' selected' : ''}" data-i="${i}">
      <div class="ws-thumb">${thumb}</div>
      <div class="ws-info">
        <div class="ws-name">${escapeHtml(w.levelName)}</div>
        <div class="ws-sub">${sub}</div>
        <div class="ws-sub2">${line}</div>
      </div>
      ${r.hasAtlas ? '<span class="ws-badge">Atlante salvato</span>' : ''}
      ${r.manual ? '<button class="ws-remove" title="Togli dall\'elenco">×</button>' : ''}
    </li>`;
  }).join('');
  host.querySelectorAll('.ws-row').forEach((node) => {
    const i = Number(node.dataset.i);
    node.addEventListener('click', () => selectRow(i));
    node.addEventListener('dblclick', () => { if (i === selected) el('btn-ws-open').click(); });
    const rm = node.querySelector('.ws-remove');
    if (rm) rm.addEventListener('click', (e) => { e.stopPropagation(); removeExtra(i); });
  });
}

function resetSide() {
  selected = -1;
  el('ws-dims').innerHTML = '';
  el('ws-dim-info').textContent = 'Scegli un mondo dall\'elenco.';
  el('btn-ws-open').disabled = true;
  el('btn-ws-open').textContent = 'Apri';
  renderBlocks();
}

async function selectRow(i) {
  const r = rows[i];
  if (!r) return;
  if (r.w.needsPermission) {
    if (!(await granted(r.init.handle, true))) { toast('Accesso non concesso', 'err'); return; }
    try {
      const { worlds } = await engine.listWorlds(r.init);
      if (worlds[0]) r.w = worlds[0];
    } catch { /* keep the placeholder */ }
    renderList();
  }
  if (!r.w.readable) return;
  selected = i;
  renderList();
  const token = ++selectToken;
  el('btn-ws-open').disabled = true;
  el('ws-dims').innerHTML = '';
  el('ws-dim-info').textContent = 'Apro il mondo…';
  const init = r.init || await bridge.narrowInit(savesInit, r.w.path);
  if (!init || token !== selectToken) return;
  const scan = await bridge.openWorld(init);
  if (token !== selectToken) return;
  if (!scan) { el('ws-dim-info').textContent = 'Questo mondo non si apre: vedi il messaggio qui sotto.'; return; }
  state.worldInfo = {
    levelName: scan.levelName || r.w.levelName,
    version: scan.version || r.w.version,
    icon: r.w.icon || null,
  };
  renderDims(scan);
  renderBlocks();
  el('btn-ws-open').disabled = false;
  el('btn-ws-open').textContent = `Apri «${r.w.levelName}»`;
}

const DIM_SLOTS = [
  { id: 'overworld', label: 'Overworld', icon: 'grass' },
  { id: 'the_nether', label: 'Nether', icon: 'netherrack' },
  { id: 'the_end', label: 'End', icon: 'endstone' },
];

function extent(d) {
  const w = d.bounds.maxX - d.bounds.minX + 1;
  const h = d.bounds.maxZ - d.bounds.minZ + 1;
  return w >= 2000 || h >= 2000
    ? `~${Math.round(w / 1000)}k × ${Math.round(h / 1000)}k blocchi`
    : `${w} × ${h} blocchi`;
}

function renderDims(scan) {
  const select = el('world-dimension');
  const custom = scan.dimensions.filter((d) => !DIM_SLOTS.some((s) => s.id === d.id))
    .map((d) => ({ id: d.id, label: d.label, icon: 'stone' }));
  const slots = [...DIM_SLOTS, ...custom];
  const draw = () => {
    el('ws-dims').innerHTML = slots.map((s) => {
      const present = scan.dimensions.some((d) => d.id === s.id);
      const on = select.value === s.id;
      return `<button class="ws-dim${on ? ' active' : ''}" data-dim="${escapeHtml(s.id)}" ${present ? '' : 'disabled'} title="${present ? '' : 'Mai visitata in questo mondo'}">
        <img src="img/icons/${s.icon}.png" alt=""><span>${escapeHtml(s.label)}</span></button>`;
    }).join('');
    el('ws-dims').querySelectorAll('.ws-dim:not([disabled])').forEach((b) => {
      b.addEventListener('click', () => { select.value = b.dataset.dim; draw(); });
    });
    const d = scan.dimensions.find((x) => x.id === select.value) || scan.dimensions[0];
    el('ws-dim-info').textContent = `${d.label} · ${d.regionCount.toLocaleString('it-IT')} regioni · ${extent(d)}`;
  };
  draw();
}

/** The air-block slots mirror the checkboxes of #block-presets (one truth). */
function renderBlocks() {
  const presets = bridge.blockPresets;
  const boxes = [...document.querySelectorAll('#block-presets input[type=checkbox]')];
  const isOn = (p) => boxes.some((b) => b.value === p.names.join(',') && b.checked);
  el('ws-blocks').innerHTML = presets.map((p, i) => `
    <button class="ws-block${isOn(p) ? ' on' : ''}" data-i="${i}" title="${escapeHtml(p.label)}">
      <img src="img/icons/${p.icon}.png" alt=""><span class="ws-check">✓</span></button>`).join('')
    + '<button class="ws-block ws-more" id="ws-block-more" title="Altri blocchi, uno per riga"><img src="img/icons/plus.png" alt=""></button>';
  el('ws-blocks').querySelectorAll('.ws-block[data-i]').forEach((b) => {
    b.addEventListener('click', () => {
      const p = presets[Number(b.dataset.i)];
      const box = boxes.find((x) => x.value === p.names.join(','));
      if (!box) return;
      box.checked = !box.checked;
      renderBlocks();
    });
  });
  el('ws-block-more').addEventListener('click', () => {
    const ta = el('ws-block-custom');
    ta.value = el('block-custom').value;
    ta.classList.toggle('hidden');
    if (!ta.classList.contains('hidden')) ta.focus();
  });
}

async function removeExtra(i) {
  const r = rows[i];
  if (!r || !r.manual) return;
  if (r.extraKey) { try { await idbDelete('handles', r.extraKey); } catch { /* ignore */ } }
  const loose = looseExtras.indexOf(r);
  if (loose >= 0) looseExtras.splice(loose, 1);
  rows.splice(i, 1);
  if (selected === i) resetSide();
  else if (selected > i) selected--;
  renderList();
}

/** «Aggiungi un mondo…»: one world folder from anywhere, kept in the list. */
async function addWorld() {
  let init = null;
  if (DEV) { toast('In modalità sviluppo il mondo di prova è già nell\'elenco'); return; }
  if (supportsHandles) {
    try {
      const handle = await window.showDirectoryPicker({ id: 'cube-atlas-extra', mode: 'read' });
      init = { kind: 'handle', handle, name: handle.name };
      try { await idbPut('handles', handle, `${EXTRA_PREFIX}${handle.name}`); } catch { /* ignore */ }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  if (!init) {
    init = await new Promise((resolve) => {
      const input = el('world-add-input');
      input.onchange = () => {
        resolve(input.files && input.files.length ? sourceFromFileList(input.files) : null);
        input.value = '';
      };
      input.click();
    });
    if (!init) return;
  }
  let w = null;
  try {
    const listed = await engine.listWorlds(init);
    w = listed.single ? listed.worlds[0] : null;
  } catch { /* handled below */ }
  if (!w) { toast('Questa cartella non è un mondo: dentro non c\'è né level.dat né region/', 'err'); return; }
  const row = { w, init, manual: true, extraKey: init.kind === 'handle' ? `${EXTRA_PREFIX}${init.handle.name}` : null };
  if (init.kind !== 'handle') looseExtras.push(row);
  const existing = rows.findIndex((r) => r.manual && r.extraKey && r.extraKey === row.extraKey);
  if (existing >= 0) rows.splice(existing, 1);
  rows.unshift(row);
  renderList();
  selectRow(0);
}

function closeWorldSelect() {
  wsOpen = false;
  selectToken++;
  sync();
}

// ------------------------------------------------------------------ resume ---

/** Find the folder a saved atlas was made from, asking permission if needed. */
async function resolveWorldFor(project) {
  const id = (project.world && project.world.id) || '';
  if (DEV && id.startsWith('http:/__world')) {
    const prefix = id.slice('http:/__world'.length).replace(/^\//, '');
    return { kind: 'http', base: '/__world', name: prefix || 'mondo', ...(prefix ? { prefix } : {}) };
  }
  if (!id.startsWith('handle:')) return null;
  const folder = id.slice('handle:'.length);
  const tryHandle = async (h) => (h && h.name === folder && await granted(h, true)
    ? { kind: 'handle', handle: h, name: h.name } : null);
  let saves = null;
  try { saves = await idbGet('handles', SAVES_KEY); } catch { /* ignore */ }
  if (saves) {
    const direct = await tryHandle(saves);
    if (direct) return direct;
    if (await granted(saves, true)) {
      try {
        const sub = await saves.getDirectoryHandle(folder);
        return { kind: 'handle', handle: sub, name: folder };
      } catch { /* not in this saves folder */ }
    }
  }
  try {
    const extra = await idbGet('handles', `${EXTRA_PREFIX}${folder}`);
    const r = await tryHandle(extra);
    if (r) return r;
  } catch { /* ignore */ }
  try {
    const legacy = await idbGet('handles', 'lastWorld');
    const r = await tryHandle(legacy);
    if (r) return r;
  } catch { /* ignore */ }
  return null;
}

async function resume() {
  const project = latestProject && await projects.getProject(latestProject.id);
  if (!project) return;
  const init = await resolveWorldFor(project);
  if (!init) {
    toast(`Per riaprire «${project.name}» indica di nuovo la cartella dei mondi`, 'err');
    openWorldSelect(await pickSaves({ forcePicker: true }));
    return;
  }
  const scan = await bridge.openWorld(init);
  if (!scan) { toast('Il mondo di questo atlante non si apre più', 'err'); return; }
  state.worldInfo = { levelName: scan.levelName, version: scan.version, icon: null };
  await bridge.openProjectById(project.id);
  bridge.onAtlasOpened();
}

// -------------------------------------------------------------------- init ---

export function init(b) {
  bridge = b;
  el('btn-title-saves').addEventListener('click', async () => openWorldSelect(await pickSaves()));
  el('btn-title-resume').addEventListener('click', resume);
  el('btn-title-reader').addEventListener('click', () => bridge.go('atlas2d', 'reader'));
  el('btn-title-docs').addEventListener('click', () => bridge.go('docs', 'editor'));
  el('world-input').addEventListener('change', onWorldInput);

  el('ws-search').addEventListener('input', renderList);
  el('ws-block-custom').addEventListener('input', () => {
    el('block-custom').value = el('ws-block-custom').value;
  });
  el('btn-ws-back').addEventListener('click', closeWorldSelect);
  el('btn-ws-change').addEventListener('click', async () => {
    const init = await pickSaves({ forcePicker: true });
    if (init) openWorldSelect(init);
  });
  el('btn-ws-add').addEventListener('click', addWorld);
  el('btn-ws-open').addEventListener('click', async () => {
    if (!state.world) return;
    el('btn-ws-open').disabled = true;
    const ok = await bridge.openAtlas();
    el('btn-ws-open').disabled = false;
    if (!ok) return;
    closeWorldSelect();
    bridge.onAtlasOpened();
  });
  document.addEventListener('keydown', (e) => {
    if (wsOpen && e.key === 'Escape' && !e.target.matches?.('input, textarea')) closeWorldSelect();
  });
  sync();
}

/** «cambia mondo» from the Mondo tab: back to the list of the same folder. */
export async function changeWorld() {
  if (savesInit) { openWorldSelect(savesInit); return; }
  openWorldSelect(await pickSaves());
}

export const isWorldSelectOpen = () => wsOpen;
