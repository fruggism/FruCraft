'use strict';
/*
 * Cube-Atlas — app shell: screen switching, world scanning, project
 * lifecycle, the layer list, and wiring for every sidebar control.
 */

const Main = (function () {
  const { state, el, escapeHtml, toast } = CA;

  const LAYER_ICONS = { roads: '🛣️', pois: '📍', areas: '⬟' };
  const LAYER_KIND_LABEL = { roads: 'Strade', pois: 'Punti', areas: 'Aree' };
  const DIM_LABELS = { overworld: 'Overworld', the_nether: 'Nether', the_end: 'End' };

  // -------------------------------------------------------------- screens
  function showScreen(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.screen === name));
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${name}`));
    if (name === 'atlas' && Atlas.map) setTimeout(() => Atlas.map.invalidateSize(), 60);
    if (name === 'archive') Archive.renderList();
  }

  // ----------------------------------------------------------------- world
  async function loadSuggestions() {
    try {
      const { worlds } = await CA.api.suggestions();
      if (!worlds.length) return;
      const host = el('world-picks');
      host.classList.remove('hidden');
      host.innerHTML = `<div class="hint">Mondi trovati automaticamente:</div>` + worlds.map((w) => (
        `<div class="world-pick" data-path="${escapeHtml(w.path)}"><b>${escapeHtml(w.name)}</b><small>${escapeHtml(w.path)}</small></div>`
      )).join('');
      host.querySelectorAll('.world-pick').forEach((node) => {
        node.addEventListener('click', () => {
          el('world-path').value = node.dataset.path;
          scanWorld();
        });
      });
    } catch { /* suggestions are a convenience, not a requirement */ }
  }

  async function scanWorld() {
    const path = el('world-path').value.trim();
    if (!path) { CA.setStatus('world-status', 'Indica il percorso della cartella del mondo.', 'err'); return; }
    CA.setStatus('world-status', 'Analisi del salvataggio…', 'busy');
    el('world-details').classList.add('hidden');
    try {
      const world = await CA.api.scanWorld(path);
      state.world = world;
      const dimSelect = el('world-dimension');
      dimSelect.innerHTML = world.dimensions.map((d) => {
        const wKm = Math.round((d.bounds.maxX - d.bounds.minX + 1) / 1000);
        const hKm = Math.round((d.bounds.maxZ - d.bounds.minZ + 1) / 1000);
        const size = wKm || hKm
          ? `estensione ~${wKm}k×${hKm}k blocchi`
          : `${d.bounds.maxX - d.bounds.minX + 1}×${d.bounds.maxZ - d.bounds.minZ + 1} blocchi`;
        return `<option value="${escapeHtml(d.id)}">${escapeHtml(d.label)} — ${d.regionCount} regioni, ${size}</option>`;
      }).join('');
      el('world-details').classList.remove('hidden');
      const mb = (world.dimensions.reduce((n, d) => n + d.bytes, 0) / 1048576).toFixed(0);
      CA.setStatus('world-status',
        `${world.levelName}${world.version ? ` (${world.version})` : ''} — ${mb} MB di regioni`, 'ok');
    } catch (err) {
      state.world = null;
      CA.setStatus('world-status', err.message, 'err');
      // The server tells us when the folder actually contains several worlds.
      if (Array.isArray(err.candidates)) showCandidates(err.candidates);
    }
  }

  /** Render a pick-list when the chosen folder holds more than one world. */
  function showCandidates(list) {
    const host = el('world-picks');
    host.classList.remove('hidden');
    host.innerHTML = '<div class="hint">Mondi trovati in questa cartella:</div>' + list.map((w) => (
      `<div class="world-pick" data-path="${escapeHtml(w.path)}"><b>${escapeHtml(w.name)}</b><small>${escapeHtml(w.path)}</small></div>`
    )).join('');
    host.querySelectorAll('.world-pick').forEach((node) => {
      node.addEventListener('click', () => {
        el('world-path').value = node.dataset.path;
        scanWorld();
      });
    });
  }

  // --------------------------------------------------------------- project
  async function refreshProjectList(selectId) {
    try {
      const list = await CA.api.listProjects();
      const sel = el('project-list');
      sel.innerHTML = '<option value="">— nessuno —</option>' + list.map((p) => (
        `<option value="${p.id}">${escapeHtml(p.name)} (${p.featureCount} elem., ${p.documentCount} doc.)</option>`
      )).join('');
      if (selectId) sel.value = selectId;
    } catch (err) {
      CA.setStatus('save-status', err.message, 'err');
    }
  }

  async function createProject() {
    if (!state.world) { toast('Analizza prima un mondo', 'err'); return; }
    const dimension = el('world-dimension').value;
    const name = await CA.promptDialog({
      title: 'Nuovo atlante',
      message: 'Come vuoi chiamarlo?',
      value: state.world.levelName || 'Il mio atlante',
      confirmLabel: 'Crea',
    });
    if (name === null) return;
    try {
      const project = await CA.api.createProject({
        name: name.trim() || 'Il mio atlante',
        world: {
          path: state.world.worldPath,
          id: state.world.worldId,
          dimension,
          levelName: state.world.levelName,
        },
      });
      await openProject(project);
      await refreshProjectList(project.id);
      toast('Atlante creato', 'ok');
    } catch (err) {
      CA.setStatus('save-status', err.message, 'err');
    }
  }

  async function openProjectById(id) {
    if (!id) return;
    try {
      const project = await CA.api.getProject(id);
      await openProject(project);
    } catch (err) {
      CA.setStatus('save-status', err.message, 'err');
    }
  }

  async function openProject(project) {
    state.project = project;
    state.selectedLayerId = project.layers.length ? project.layers[0].id : null;
    state.selectedFeature = null;

    el('project-name').value = project.name;
    el('project-name').disabled = false;
    el('topbar-info').innerHTML = `<span>${escapeHtml(project.name)}</span> · ${escapeHtml(project.world.levelName || '')} · ${escapeHtml(dimLabel(project))}`;

    // The world may not be the one currently scanned (e.g. after reopening
    // the app), so make sure the server knows about it before asking for tiles.
    if (!state.world || state.world.worldId !== project.world.id) {
      try {
        state.world = await CA.api.scanWorld(project.world.path);
      } catch (err) {
        CA.setStatus('world-status', `Mondo non raggiungibile: ${err.message}`, 'err');
        el('map-overlay').classList.remove('hidden');
        el('map-overlay').querySelector('.inner').innerHTML =
          `<h3>Mondo non trovato</h3><p>${escapeHtml(project.world.path)}</p>
           <p>Sposta il salvataggio al suo posto oppure crea un nuovo atlante.</p>`;
        return;
      }
    }

    // Restore per-project background settings.
    el('chk-terrain').checked = project.settings.showTerrain !== false;
    Atlas.attachWorld(state.world, project.world.dimension, project.view);
    Atlas.renderAllLayers();
    Atlas.setTerrainVisible(el('chk-terrain').checked);
    Atlas.refreshProps();
    renderLayerList();
    Archive.onProjectLoaded();
    CA.setStatus('save-status', 'Atlante aperto', 'ok');

    // Seed the "generate around" fields with somewhere useful, and tell the
    // user whether this dimension has been rendered yet.
    const spawn = state.world.spawn || { x: 0, z: 0 };
    el('render-x').value = Math.round(spawn.x);
    el('render-z').value = Math.round(spawn.z);
    el('goto-x').value = Math.round(spawn.x);
    el('goto-z').value = Math.round(spawn.z);
    updateRenderEstimate();
    pollRenderStatus(true);
  }

  function dimLabel(project) {
    const dim = state.world && state.world.dimensions.find((d) => d.id === project.world.dimension);
    return dim ? dim.label : (DIM_LABELS[project.world.dimension] || project.world.dimension);
  }

  async function deleteProject() {
    const id = el('project-list').value;
    if (!id) return;
    const ok = await CA.confirmDialog({
      title: 'Eliminare l\'atlante?',
      message: 'Verranno persi i layer e i documenti che contiene. La mappa del mondo non viene toccata.',
      confirmLabel: 'Elimina', danger: true,
    });
    if (!ok) return;
    await CA.api.deleteProject(id);
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
    CA.download(`${CA.slugify(state.project.name)}.cubeatlas.json`,
      JSON.stringify(state.project, null, 2), 'application/json');
    toast('Progetto esportato', 'ok');
  }

  function importProject() {
    el('import-file').click();
  }

  async function onImportFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const project = await CA.api.importProject(parsed);
      await openProject(project);
      await refreshProjectList(project.id);
      toast('Progetto importato', 'ok');
    } catch (err) {
      CA.setStatus('save-status', `Import fallito: ${err.message}`, 'err');
      toast(`Import fallito: ${err.message}`, 'err');
    } finally {
      e.target.value = '';
    }
  }

  // ---------------------------------------------------------------- layers
  function renderLayerList() {
    const host = el('layer-list');
    if (!state.project) { host.innerHTML = ''; updateToolAvailability(); return; }

    host.innerHTML = state.project.layers.map((layer) => `
      <li class="layer-item ${layer.id === state.selectedLayerId ? 'selected' : ''}" data-id="${layer.id}">
        <span class="eye ${layer.visible === false ? 'off' : ''}" data-eye="${layer.id}" title="Mostra/nascondi">👁</span>
        <span class="kind" title="${LAYER_KIND_LABEL[layer.type]}">${LAYER_ICONS[layer.type]}</span>
        <span class="lname">${escapeHtml(layer.name)}</span>
        <span class="count">${layer.features.length}</span>
      </li>`).join('');

    host.querySelectorAll('.layer-item').forEach((node) => {
      node.addEventListener('click', (e) => {
        if (e.target.dataset.eye) return; // handled below
        selectLayer(node.dataset.id);
      });
    });
    host.querySelectorAll('.eye').forEach((node) => {
      node.addEventListener('click', (e) => {
        e.stopPropagation();
        const layer = CA.findLayer(node.dataset.eye);
        if (!layer) return;
        layer.visible = layer.visible === false;
        Atlas.setLayerVisibility(layer.id, layer.visible);
        CA.markDirty();
        renderLayerList();
      });
    });

    const layer = CA.selectedLayer();
    el('layer-edit').classList.toggle('hidden', !layer);
    if (layer) el('layer-name').value = layer.name;
    updateToolAvailability();
  }

  function selectLayer(id) {
    state.selectedLayerId = id;
    Atlas.setTool('select');
    renderLayerList();
  }

  function updateToolAvailability() {
    const layer = CA.selectedLayer();
    const has = !!layer;
    for (const id of ['tool-draw', 'tool-edit', 'tool-delete']) el(id).disabled = !has;
    if (has) {
      const label = { roads: 'Traccia strada', pois: 'Aggiungi punto', areas: 'Disegna area' }[layer.type];
      el('tool-draw-label').textContent = label;
      el('tool-draw-ico').textContent = LAYER_ICONS[layer.type];
      el('tool-edit').disabled = layer.type === 'pois'; // points move by dragging
      el('tool-hint').textContent = layer.type === 'pois'
        ? 'I punti si spostano trascinandoli. Usa "Cancella" e poi clicca per eliminare.'
        : 'Disegna un nuovo elemento, oppure selezionane uno e usa "Modifica nodi" per spostarne i vertici.';
    } else {
      el('tool-draw-label').textContent = 'Disegna';
      el('tool-hint').textContent = 'Seleziona un layer per attivare gli strumenti.';
    }
  }

  async function addLayer(type) {
    if (!state.project) { toast('Apri prima un atlante', 'err'); return; }
    const name = await CA.promptDialog({
      title: `Nuovo layer — ${LAYER_KIND_LABEL[type]}`,
      message: 'Nome del layer',
      value: LAYER_KIND_LABEL[type],
      confirmLabel: 'Crea',
    });
    if (name === null) return;
    const defaults = {
      roads: { color: '#f2c14e', width: 4, dash: 'solid', opacity: 1, casingColor: '#2b2b2b', casingWidth: 2, showName: true },
      pois: { shape: 'circle', color: '#e05a47', size: 10, showName: true },
      areas: { fillColor: '#4fa3d1', fillOpacity: 0.25, strokeColor: '#4fa3d1', strokeWidth: 2, dash: 'solid', showName: true },
    }[type];
    const layer = {
      id: CA.newId('lay'),
      type,
      name: name.trim() || LAYER_KIND_LABEL[type],
      visible: true,
      locked: false,
      defaultStyle: defaults,
      features: [],
    };
    state.project.layers.push(layer);
    state.selectedLayerId = layer.id;
    CA.markDirty();
    Atlas.renderAllLayers();
    renderLayerList();
    toast(`Layer "${layer.name}" creato`, 'ok');
  }

  async function deleteLayer() {
    const layer = CA.selectedLayer();
    if (!layer) return;
    const ok = await CA.confirmDialog({
      title: 'Eliminare il layer?',
      message: `"${layer.name}" e i suoi ${layer.features.length} elementi verranno rimossi.`,
      confirmLabel: 'Elimina', danger: true,
    });
    if (!ok) return;
    state.project.layers = state.project.layers.filter((l) => l.id !== layer.id);
    state.selectedLayerId = state.project.layers.length ? state.project.layers[0].id : null;
    state.selectedFeature = null;
    CA.markDirty();
    Atlas.renderAllLayers();
    Atlas.refreshProps();
    renderLayerList();
    toast('Layer eliminato');
  }


  // --------------------------------------------------- map generation job
  let renderPollTimer = null;

  function renderArea() {
    if (el('render-extent').value === 'all') return null;
    const x = Number(el('render-x').value) || 0;
    const z = Number(el('render-z').value) || 0;
    const r = Math.max(256, Number(el('render-radius').value) || 1024);
    return { minX: x - r, minZ: z - r, maxX: x + r, maxZ: z + r };
  }

  /** Rough "how long will this take" estimate, from tile count. */
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
    // One base tile is 256x256 blocks and takes roughly half a second.
    const tiles = Math.ceil((maxX - minX + 1) / 256) * Math.ceil((maxZ - minZ + 1) / 256);
    const seconds = Math.round(tiles * 0.6);
    const pretty = seconds > 90 ? `~${Math.round(seconds / 60)} min` : `~${seconds} s`;
    node.textContent = `Circa ${tiles} tile di dettaglio, ${pretty} di elaborazione.`;
  }

  async function startRender(force) {
    if (!state.project || !state.world) { toast('Apri prima un atlante', 'err'); return; }
    const dimId = state.project.world.dimension;
    try {
      CA.setStatus('render-status', 'Avvio generazione…', 'busy');
      await CA.api.startRender(state.world.worldId, dimId, { area: renderArea(), force: !!force });
      el('btn-render').disabled = true;
      el('btn-render-cancel').classList.remove('hidden');
      el('render-progress').classList.remove('hidden');
      pollRenderStatus();
    } catch (err) {
      CA.setStatus('render-status', err.message, 'err');
    }
  }

  async function pollRenderStatus(quiet) {
    if (!state.project || !state.world) return;
    clearTimeout(renderPollTimer);
    const dimId = state.project.world.dimension;
    let status;
    try {
      status = await CA.api.renderStatus(state.world.worldId, dimId);
    } catch {
      return;
    }

    const running = status.state === 'running';
    el('btn-render').disabled = running;
    el('btn-render-cancel').classList.toggle('hidden', !running);
    el('render-progress').classList.toggle('hidden', !running && status.state !== 'done');
    el('render-bar').style.width = `${status.percent || 0}%`;

    if (running) {
      const eta = status.etaMs != null ? ` — restano ~${formatDuration(status.etaMs)}` : '';
      CA.setStatus('render-status', `${status.phase}: ${status.done}/${status.total} (${status.percent}%)${eta}`, 'busy');
      Atlas.refreshTiles();
      renderPollTimer = setTimeout(pollRenderStatus, 1500);
      return;
    }

    if (status.state === 'done') {
      // Say which area was generated: if only part of the world was rendered,
      // the blank rest is a choice, not a failure.
      const b = status.bounds;
      const where = b
        ? ` (area X ${Math.round(b.minX)}…${Math.round(b.maxX)}, Z ${Math.round(b.minZ)}…${Math.round(b.maxZ)})`
        : '';
      CA.setStatus('render-status', `Mappa generata${where}.`, 'ok');
      Atlas.refreshTiles();
    } else if (status.state === 'error') {
      CA.setStatus('render-status', `Generazione fallita: ${status.error}`, 'err');
    } else if (status.state === 'cancelled') {
      CA.setStatus('render-status', 'Generazione interrotta (la parte già fatta resta).', 'busy');
      Atlas.refreshTiles();
    } else {
      CA.setStatus('render-status',
        'Questa dimensione non è ancora stata generata: scegli l\'area e premi "Genera mappa".', 'busy');
    }
  }

  function formatDuration(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    return `${m} min ${s % 60} s`;
  }

  // ------------------------------------------------------------------ init
  function init() {
    Atlas.initMap();
    Archive.init();

    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => showScreen(tab.dataset.screen));
    });

    el('btn-scan').addEventListener('click', scanWorld);
    el('world-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') scanWorld(); });
    el('btn-new-project').addEventListener('click', createProject);
    el('btn-open-project').addEventListener('click', () => openProjectById(el('project-list').value));
    el('btn-delete-project').addEventListener('click', deleteProject);
    el('btn-export-project').addEventListener('click', exportProject);
    el('btn-import-project').addEventListener('click', importProject);
    el('import-file').addEventListener('change', onImportFile);

    el('project-name').addEventListener('input', CA.debounce(() => {
      if (!state.project) return;
      state.project.name = el('project-name').value.trim() || 'Senza nome';
      el('topbar-info').innerHTML = `<span>${escapeHtml(state.project.name)}</span> · ${escapeHtml(state.project.world.levelName || '')}`;
      CA.markDirty();
      refreshProjectList(state.project.id);
    }, 500));

    el('chk-terrain').addEventListener('change', () => {
      Atlas.setTerrainVisible(el('chk-terrain').checked);
      if (state.project) { state.project.settings.showTerrain = el('chk-terrain').checked; CA.markDirty(); }
    });
    el('render-extent').addEventListener('change', () => {
      el('render-around').classList.toggle('hidden', el('render-extent').value === 'all');
      updateRenderEstimate();
    });
    for (const id of ['render-x', 'render-z', 'render-radius']) {
      el(id).addEventListener('input', CA.debounce(updateRenderEstimate, 250));
    }
    el('btn-render-here').addEventListener('click', () => {
      if (!Atlas.map) return;
      const c = CA.fromLatLng(Atlas.map.getCenter());
      el('render-x').value = Math.round(c.x);
      el('render-z').value = Math.round(c.z);
      updateRenderEstimate();
    });
    el('btn-render').addEventListener('click', () => startRender(false));
    el('btn-render-cancel').addEventListener('click', async () => {
      if (!state.project || !state.world) return;
      await CA.api.cancelRender(state.world.worldId, state.project.world.dimension);
      pollRenderStatus();
    });

    el('btn-goto').addEventListener('click', () => {
      Atlas.goTo(Number(el('goto-x').value) || 0, Number(el('goto-z').value) || 0, Math.max(Atlas.map.getZoom(), -2));
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

    el('btn-clear-cache').addEventListener('click', async () => {
      if (!state.world) { toast('Nessun mondo caricato', 'err'); return; }
      if (!state.project) { toast('Apri prima un atlante', 'err'); return; }
      CA.setStatus('cache-status', 'Svuoto la cache dei tile…', 'busy');
      try {
        await CA.api.clearCache(state.world.worldId, state.project.world.dimension);
        Atlas.refreshTiles();
        CA.setStatus('cache-status', 'Cache svuotata.', 'ok');
        await startRender(true);
      } catch (err) {
        CA.setStatus('cache-status', err.message, 'err');
      }
    });

    document.querySelectorAll('[data-add-layer]').forEach((btn) => {
      btn.addEventListener('click', () => addLayer(btn.dataset.addLayer));
    });
    el('btn-delete-layer').addEventListener('click', deleteLayer);
    el('layer-name').addEventListener('input', CA.debounce(() => {
      const layer = CA.selectedLayer();
      if (!layer) return;
      layer.name = el('layer-name').value.trim() || 'Layer';
      CA.markDirty();
      renderLayerList();
    }, 400));

    document.querySelectorAll('.tool').forEach((btn) => {
      btn.addEventListener('click', () => Atlas.setTool(btn.dataset.tool));
    });

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

    // Don't lose unsaved edits to a stray tab close.
    window.addEventListener('beforeunload', (e) => {
      if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
    });

    refreshProjectList();
    loadSuggestions();
  }

  return { init, showScreen, renderLayerList, openProject, refreshProjectList, selectLayer };
})();

window.Main = Main;
document.addEventListener('DOMContentLoaded', Main.init);
