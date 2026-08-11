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
        const size = `${Math.round((d.bounds.maxX - d.bounds.minX + 1) / 16)}×${Math.round((d.bounds.maxZ - d.bounds.minZ + 1) / 16)} chunk`;
        return `<option value="${d.dimension}">${DIM_LABELS[d.dimension] || d.dimension} — ${d.regionCount} regioni, ${size}</option>`;
      }).join('');
      el('world-details').classList.remove('hidden');
      const mb = (world.dimensions.reduce((n, d) => n + d.bytes, 0) / 1048576).toFixed(0);
      CA.setStatus('world-status',
        `${world.levelName}${world.version ? ` (${world.version})` : ''} — ${mb} MB di regioni`, 'ok');
    } catch (err) {
      state.world = null;
      CA.setStatus('world-status', err.message, 'err');
    }
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
    el('topbar-info').innerHTML = `<span>${escapeHtml(project.name)}</span> · ${escapeHtml(project.world.levelName || '')} · ${DIM_LABELS[project.world.dimension] || project.world.dimension}`;

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
    el('btn-clear-cache').addEventListener('click', async () => {
      if (!state.world) { toast('Nessun mondo caricato', 'err'); return; }
      CA.setStatus('cache-status', 'Svuoto la cache dei tile…', 'busy');
      try {
        await CA.api.clearCache(state.world.worldId, state.project && state.project.world.dimension);
        // Force Leaflet to refetch every tile currently on screen.
        if (Atlas.map) Atlas.map.eachLayer((l) => { if (l instanceof L.TileLayer) l.redraw(); });
        CA.setStatus('cache-status', 'Cache svuotata: la mappa si sta rigenerando.', 'ok');
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
