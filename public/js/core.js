'use strict';
/*
 * Cube-Atlas — shared state, API client and small UI utilities.
 * Exposed as window.CA so the other scripts can build on it without a bundler.
 */

const CA = (function () {

  // -------------------------------------------------------------- state
  const state = {
    world: null,        // result of /api/world/scan
    project: null,      // the open project (source of truth for layers/docs)
    selectedLayerId: null,
    selectedFeature: null, // { layerId, featureId }
    map: null,
    dirty: false,
  };

  // ---------------------------------------------------------------- api
  async function api(url, options) {
    const res = await fetch(url, options);
    const isJson = (res.headers.get('content-type') || '').includes('application/json');
    const body = isJson ? await res.json() : await res.text();
    if (!res.ok) {
      const message = (body && body.error) || `Errore ${res.status}`;
      throw new Error(message);
    }
    return body;
  }

  const api_ = {
    scanWorld: (path) => api(`/api/world/scan?path=${encodeURIComponent(path)}`),
    suggestions: () => api('/api/world/suggestions'),
    listProjects: () => api('/api/projects'),
    getProject: (id) => api(`/api/projects/${id}`),
    createProject: (body) => api('/api/projects', jsonPost(body)),
    saveProject: (id, body) => api(`/api/projects/${id}`, { ...jsonPost(body), method: 'PUT' }),
    deleteProject: (id) => api(`/api/projects/${id}`, { method: 'DELETE' }),
    importProject: (body) => api('/api/projects/import', jsonPost(body)),
    probe: (worldId, params) => api(`/api/world/${worldId}/probe?${new URLSearchParams(params)}`),
    clearCache: (worldId, dimension) => api(`/api/tiles/${worldId}/clear-cache`, jsonPost({ dimension })),
    exportBook: (body) => api('/api/books/export', jsonPost(body)),
  };

  function jsonPost(body) {
    return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) };
  }

  // -------------------------------------------------------- coordinates
  // Leaflet CRS.Simple with block coordinates as CRS units:
  //   lng = blockX, lat = -blockZ  (so north is up and X grows east)
  const toLatLng = (x, z) => L.latLng(-z, x);
  const fromLatLng = (ll) => ({ x: ll.lng, z: -ll.lat });
  const roundCoord = (v) => Math.round(v * 100) / 100;

  // ------------------------------------------------------------- utils
  const el = (id) => document.getElementById(id);

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  let toastTimer = null;
  function toast(message, kind) {
    const host = el('toast-host');
    const node = document.createElement('div');
    node.className = `toast ${kind || ''}`;
    node.textContent = message;
    host.appendChild(node);
    clearTimeout(toastTimer);
    setTimeout(() => node.remove(), 3200);
  }

  function setStatus(id, message, kind) {
    const node = el(id);
    if (!node) return;
    node.textContent = message || '';
    node.className = `status ${kind || ''}`;
  }

  /** Minecraft-styled replacement for window.confirm. */
  function confirmDialog({ title, message, confirmLabel = 'Conferma', danger = false }) {
    return new Promise((resolve) => {
      const host = el('modal-host');
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML = `
        <div class="modal">
          <h3>${escapeHtml(title)}</h3>
          <div class="modal-body">${escapeHtml(message)}</div>
          <div class="row">
            <button class="btn" data-act="cancel">Annulla</button>
            <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${escapeHtml(confirmLabel)}</button>
          </div>
        </div>`;
      const done = (value) => { backdrop.remove(); resolve(value); };
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) done(false);
        const act = e.target.dataset && e.target.dataset.act;
        if (act === 'ok') done(true);
        if (act === 'cancel') done(false);
      });
      host.appendChild(backdrop);
      backdrop.querySelector('[data-act="ok"]').focus();
    });
  }

  /** Minecraft-styled replacement for window.prompt. */
  function promptDialog({ title, message, value = '', confirmLabel = 'OK' }) {
    return new Promise((resolve) => {
      const host = el('modal-host');
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML = `
        <div class="modal">
          <h3>${escapeHtml(title)}</h3>
          <div class="modal-body">
            <label><span class="lbl">${escapeHtml(message)}</span>
            <input type="text" class="prompt-input" value="${escapeHtml(value)}"></label>
          </div>
          <div class="row">
            <button class="btn" data-act="cancel">Annulla</button>
            <button class="btn btn-primary" data-act="ok">${escapeHtml(confirmLabel)}</button>
          </div>
        </div>`;
      const input = backdrop.querySelector('.prompt-input');
      const done = (value2) => { backdrop.remove(); resolve(value2); };
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) done(null);
        const act = e.target.dataset && e.target.dataset.act;
        if (act === 'ok') done(input.value);
        if (act === 'cancel') done(null);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') done(input.value);
        if (e.key === 'Escape') done(null);
      });
      host.appendChild(backdrop);
      input.focus();
      input.select();
    });
  }

  function download(filename, content, mime) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function slugify(s) {
    return String(s || 'cube-atlas').trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cube-atlas';
  }

  function newId(prefix) {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  // --------------------------------------------------- project helpers
  function findLayer(layerId) {
    if (!state.project) return null;
    return state.project.layers.find((l) => l.id === layerId) || null;
  }

  function selectedLayer() { return findLayer(state.selectedLayerId); }

  function findFeature(layerId, featureId) {
    const layer = findLayer(layerId);
    if (!layer) return null;
    return layer.features.find((f) => f.id === featureId) || null;
  }

  function selectedFeature() {
    if (!state.selectedFeature) return null;
    return findFeature(state.selectedFeature.layerId, state.selectedFeature.featureId);
  }

  // Autosave: coalesce rapid edits into a single PUT.
  const saveNow = async () => {
    if (!state.project) return;
    try {
      const saved = await api_.saveProject(state.project.id, state.project);
      // Keep local layer/feature ids stable by merging only bookkeeping fields.
      state.project.updatedAt = saved.updatedAt;
      state.dirty = false;
      setStatus('save-status', `Salvato alle ${new Date().toLocaleTimeString('it-IT')}`, 'ok');
    } catch (err) {
      setStatus('save-status', `Salvataggio fallito: ${err.message}`, 'err');
    }
  };
  const scheduleSave = debounce(saveNow, 600);

  function markDirty() {
    if (!state.project) return;
    state.dirty = true;
    setStatus('save-status', 'Modifiche non salvate…', 'busy');
    scheduleSave();
  }

  /** Push any debounced-but-unsaved edits before the page goes away.
   *  sendBeacon survives unload, which a normal fetch does not. */
  function flushOnExit() {
    if (!state.project || !state.dirty) return;
    try {
      const blob = new Blob([JSON.stringify(state.project)], { type: 'application/json' });
      navigator.sendBeacon(`/api/projects/${state.project.id}/flush`, blob);
      state.dirty = false;
    } catch { /* nothing more we can do at unload time */ }
  }
  window.addEventListener('pagehide', flushOnExit);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushOnExit();
  });

  return {
    state, api: api_, el, escapeHtml, toast, setStatus, confirmDialog, promptDialog,
    download, slugify, newId, debounce,
    toLatLng, fromLatLng, roundCoord,
    findLayer, selectedLayer, findFeature, selectedFeature,
    markDirty, saveNow, flushOnExit,
  };
})();

window.CA = CA;
