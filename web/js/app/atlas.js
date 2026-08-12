/*
 * Cube-Atlas — the map screen: tile background, vector layers (roads /
 * points of interest / areas), drawing + editing tools, and export.
 *
 * Terrain tiles come from the map worker as ImageBitmaps and are painted into
 * canvas tiles, so nothing on this thread ever parses a region file.
 */

import {
  state, el, escapeHtml, toast, toLatLng, fromLatLng, roundCoord,
  debounce, newId, confirmDialog, download, slugify, setStatus, markDirty,
  findLayer, selectedLayer, findFeature, selectedFeature, engine,
} from './ui-core.js';

const DASHES = {
  solid: null,
  dashed: '12,8',
  dotted: '1,7',
  dashdot: '14,7,3,7',
};
const DASH_LABELS = { solid: 'continuo', dashed: 'tratteggiato', dotted: 'punteggiato', dashdot: 'tratto-punto' };

const PALETTE = [
  '#e8453c', '#f2c14e', '#5fa839', '#4fa3d1', '#8a63d2', '#e07a3f',
  '#e888c0', '#f5f0e6', '#8b6b4a', '#3c3c3c', '#2bb5a0', '#c9d63f',
];

const POI_SHAPES = ['circle', 'square', 'triangle', 'diamond', 'star', 'pin'];

const POI_CATEGORIES = [
  'abitazione', 'negozio', 'fattoria', 'industria', 'monumento',
  'stazione', 'porto', 'tempio', 'castello', 'miniera', 'altro',
];

// Runtime map objects, keyed by feature id. Rebuilt whenever the project
// reloads; the project JSON stays the single source of truth.
const rendered = new Map();     // featureId -> { layerId, group, primary, feature }
const layerGroups = new Map();  // layerId -> L.LayerGroup

let map = null;
let tileLayer = null;
let worldBounds = null;
let currentDim = null;
let drawHandler = null;
let editingFeatureId = null;
let currentTool = 'select';

// ------------------------------------------------------------------ map
function initMap() {
  map = L.map('map', {
    crs: L.CRS.Simple,
    minZoom: -6,
    maxZoom: 5,
    zoomSnap: 0.5,
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 90,
    attributionControl: false,
    zoomControl: true,
    doubleClickZoom: false, // double-click finishes a drawing instead
  });
  state.map = map;
  map.setView([0, 0], -2);
  // Handles for debugging and for the browser test harness.
  window.__map = map;
  window.__fromLatLng = fromLatLng;

  map.on('mousemove', (e) => {
    const { x, z } = fromLatLng(e.latlng);
    el('coord-readout').innerHTML = `X <b>${Math.floor(x)}</b>&nbsp; Z <b>${Math.floor(z)}</b>`;
  });
  map.on('moveend zoomend', () => { persistView(); updateViewInfo(); });
  map.on(L.Draw.Event.CREATED, onDrawCreated);
  // Clicking empty map clears the selection — but a click that landed on a
  // feature must not, and Leaflet still fires the map's click after the
  // layer's, so check what was actually hit rather than relying on
  // propagation being stopped.
  map.on('click', (e) => {
    if (currentTool !== 'select') return;
    if (hitsFeature(e.originalEvent)) return;
    selectFeature(null);
  });

  return map;
}

/** True when a DOM event landed on a drawn feature (vector path, POI icon
 *  or its label) rather than on the bare map. */
function hitsFeature(domEvent) {
  const target = domEvent && domEvent.target;
  if (!target || !target.closest) return false;
  return !!(target.closest('.leaflet-interactive')
    || target.closest('.ca-poi')
    || target.closest('.ca-label'));
}

function persistView() {
  if (!state.project || !map) return;
  const c = fromLatLng(map.getCenter());
  state.project.view = { center: [roundCoord(c.x), roundCoord(c.z)], zoom: map.getZoom() };
  markDirty();
}

/**
 * Terrain layer: each Leaflet tile is a canvas the worker paints into.
 * Tiles arrive as ImageBitmaps (transferred, not copied) and a tile the
 * worker reports as "partial" is re-requested shortly after, which is how the
 * map fills in while a generation job runs.
 */
function makeTerrainLayer(dimId) {
  const TerrainLayer = L.GridLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement('canvas');
      tile.width = 256;
      tile.height = 256;
      const ctx = tile.getContext('2d');
      engine.tile(dimId, coords.z, coords.x, coords.y).then((res) => {
        if (res && !res.empty && res.bitmap) {
          ctx.drawImage(res.bitmap, 0, 0);
          res.bitmap.close();
        }
        tile.dataset.partial = res && res.partial ? '1' : '';
        done(null, tile);
      }).catch((err) => done(err, tile));
      return tile;
    },
  });
  return new TerrainLayer({
    tileSize: 256,
    minZoom: -6, maxZoom: 5,
    minNativeZoom: -6, maxNativeZoom: 0,
    noWrap: true,
    keepBuffer: 2,
    updateWhenZooming: false,
    className: 'ca-terrain-tiles',
  });
}

/** Point the map at a world + dimension. */
function attachWorld(world, dimId, view) {
  if (tileLayer) { map.removeLayer(tileLayer); tileLayer = null; }
  const dim = world.dimensions.find((d) => d.id === dimId) || world.dimensions[0];
  currentDim = dim;

  tileLayer = makeTerrainLayer(dim.id);
  if (el('chk-terrain').checked) tileLayer.addTo(map);

  // Panning is bounded by the generated area, but generously: a tight bound
  // makes the map feel stuck, which is worse than letting the user drift a
  // little into the void.
  const b = dim.bounds;
  worldBounds = L.latLngBounds(toLatLng(b.minX, b.minZ), toLatLng(b.maxX + 1, b.maxZ + 1));
  map.setMaxBounds(worldBounds.pad(1.0));

  if (view && Array.isArray(view.center)) {
    map.setView(toLatLng(view.center[0], view.center[1]), view.zoom ?? -2);
  } else {
    // A freshly opened world starts where the player does, at one pixel per
    // block — not zoomed out over an explored area that can be tens of
    // thousands of blocks wide, where a whole town is a few pixels.
    const spawn = world.spawn || { x: 0, z: 0 };
    goTo(spawn.x, spawn.z, 0);
  }
  el('map-overlay').classList.add('hidden');
  updateViewInfo();
}

/** Centre the map on a block coordinate. */
function goTo(x, z, zoom) {
  if (!map) return;
  const target = toLatLng(Number(x) || 0, Number(z) || 0);
  // Don't let maxBounds silently refuse a jump to a far-away coordinate.
  if (worldBounds && !worldBounds.pad(1.0).contains(target)) {
    map.setMaxBounds(null);
    map.setView(target, zoom ?? map.getZoom());
    return;
  }
  map.setView(target, zoom ?? map.getZoom());
}

function fitWorld() {
  if (worldBounds) {
    map.setMaxBounds(worldBounds.pad(1.0));
    map.fitBounds(worldBounds);
  }
}

function updateViewInfo() {
  const node = el('view-info');
  if (!node || !map) return;
  const c = fromLatLng(map.getCenter());
  const z = map.getZoom();
  const scale = Math.pow(2, z);
  const blocksAcross = Math.round(map.getSize().x / scale);
  node.textContent = `Centro X ${Math.round(c.x)}, Z ${Math.round(c.z)} — larghezza vista ~${blocksAcross} blocchi`;
}

/** Re-request the terrain tiles (after a render job produced new ones). */
function refreshTiles() {
  if (tileLayer) tileLayer.redraw();
}

function currentDimension() { return currentDim; }

// -------------------------------------------------------------- styling
function styleOf(feature, layer) {
  return { ...(layer.defaultStyle || {}), ...(feature.style || {}) };
}

function dashFor(style) {
  const key = style.dash || 'solid';
  return DASHES[key] !== undefined ? DASHES[key] : null;
}

// ------------------------------------------------------- POI shape icon
function poiSvg(shape, color, size) {
  const s = size;
  const half = s / 2;
  const stroke = '#0d0d0d';
  const common = `stroke="${stroke}" stroke-width="2" vector-effect="non-scaling-stroke"`;
  let body;
  switch (shape) {
    case 'square':
      body = `<rect x="1" y="1" width="${s - 2}" height="${s - 2}" fill="${color}" ${common}/>`;
      break;
    case 'triangle':
      body = `<polygon points="${half},1 ${s - 1},${s - 1} 1,${s - 1}" fill="${color}" ${common}/>`;
      break;
    case 'diamond':
      body = `<polygon points="${half},1 ${s - 1},${half} ${half},${s - 1} 1,${half}" fill="${color}" ${common}/>`;
      break;
    case 'star': {
      const pts = [];
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? half - 1 : half * 0.45;
        const a = (Math.PI / 5) * i - Math.PI / 2;
        pts.push(`${(half + r * Math.cos(a)).toFixed(1)},${(half + r * Math.sin(a)).toFixed(1)}`);
      }
      body = `<polygon points="${pts.join(' ')}" fill="${color}" ${common}/>`;
      break;
    }
    case 'pin':
      body = `<path d="M ${half} ${s - 1} L 1 ${half * 0.85} A ${half - 1} ${half - 1} 0 1 1 ${s - 1} ${half * 0.85} Z" fill="${color}" ${common}/>`;
      break;
    case 'circle':
    default:
      body = `<circle cx="${half}" cy="${half}" r="${half - 1.5}" fill="${color}" ${common}/>`;
  }
  return `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
}

// ----------------------------------------------------- feature rendering
function buildFeatureLayer(feature, layer) {
  const style = styleOf(feature, layer);
  const group = L.layerGroup();
  let primary;

  if (layer.type === 'roads') {
    const latlngs = feature.coords.map(([x, z]) => toLatLng(x, z));
    const casingWidth = Number(style.casingWidth) || 0;
    if (casingWidth > 0) {
      group.addLayer(L.polyline(latlngs, {
        color: style.casingColor || '#000',
        weight: (Number(style.width) || 4) + casingWidth * 2,
        opacity: style.opacity ?? 1,
        lineCap: 'round', lineJoin: 'round',
        interactive: false,
      }));
    }
    primary = L.polyline(latlngs, {
      color: style.color || '#f2c14e',
      weight: Number(style.width) || 4,
      opacity: style.opacity ?? 1,
      dashArray: dashFor(style),
      lineCap: style.dash === 'dotted' ? 'round' : 'butt',
      lineJoin: 'round',
    });
    group.addLayer(primary);

  } else if (layer.type === 'areas') {
    const latlngs = feature.coords.map(([x, z]) => toLatLng(x, z));
    primary = L.polygon(latlngs, {
      color: style.strokeColor || '#4fa3d1',
      weight: Number(style.strokeWidth) || 2,
      dashArray: dashFor(style),
      fillColor: style.fillColor || '#4fa3d1',
      fillOpacity: style.fillOpacity ?? 0.25,
    });
    group.addLayer(primary);

  } else { // pois
    const size = Number(style.size) || 10;
    const icon = L.divIcon({
      className: 'ca-poi',
      html: poiSvg(style.shape || 'circle', style.color || '#e05a47', size),
      iconSize: [size, size],
      iconAnchor: style.shape === 'pin' ? [size / 2, size] : [size / 2, size / 2],
    });
    primary = L.marker(toLatLng(feature.coord[0], feature.coord[1]), {
      icon,
      draggable: !layer.locked,
      keyboard: false,
    });
    primary.on('dragend', () => {
      const p = fromLatLng(primary.getLatLng());
      feature.coord = [Math.round(p.x), Math.round(p.z)];
      markDirty();
      refreshProps();
    });
    group.addLayer(primary);
  }

  if (style.showName !== false && feature.name) {
    primary.bindTooltip(escapeHtml(feature.name), {
      permanent: true,
      direction: layer.type === 'pois' ? 'right' : 'center',
      offset: layer.type === 'pois' ? [Number(style.size) / 2 + 2 || 8, 0] : [0, 0],
      className: `ca-label${layer.type === 'areas' ? ' big' : ''}`,
      sticky: false,
    });
  }

  // Hover-only info bubble. It must not swallow clicks: it appears under the
  // cursor the moment you hover a feature, so a click aimed at the feature
  // would otherwise land on the popup and select nothing.
  primary.bindPopup(popupHtml(feature, layer), {
    closeButton: false,
    autoPan: false,
    className: 'ca-info-popup',
  });
  primary.on('mouseover', () => { if (currentTool !== 'draw') primary.openPopup(); });
  primary.on('mouseout', () => primary.closePopup());
  primary.on('click', (e) => {
    if (e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
    if (currentTool === 'delete') { deleteFeature(layer.id, feature.id); return; }
    selectFeature(layer.id, feature.id);
    if (currentTool === 'edit') toggleVertexEditing(feature.id, true);
  });

  rendered.set(feature.id, { layerId: layer.id, group, primary, feature });
  return group;
}

function popupHtml(feature, layer) {
  const kind = { roads: 'Strada', pois: 'Punto di interesse', areas: 'Area' }[layer.type];
  const cat = layer.type === 'pois' && feature.category ? ` · ${escapeHtml(feature.category)}` : '';
  const len = layer.type === 'roads' ? ` · ${lengthOf(feature.coords)} blocchi` : '';
  const area = layer.type === 'areas' ? ` · ${areaOf(feature.coords)} blocchi²` : '';
  return `<div class="ca-popup">
    <h4>${escapeHtml(feature.name || '(senza nome)')}</h4>
    ${feature.description ? `<p class="desc">${escapeHtml(feature.description)}</p>` : ''}
    <div class="meta">${kind}${cat}${len}${area} · ${escapeHtml(layer.name)}</div>
  </div>`;
}

function lengthOf(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]);
  }
  return Math.round(total);
}

function areaOf(coords) {
  let sum = 0;
  for (let i = 0; i < coords.length; i++) {
    const [x1, z1] = coords[i];
    const [x2, z2] = coords[(i + 1) % coords.length];
    sum += x1 * z2 - x2 * z1;
  }
  return Math.round(Math.abs(sum) / 2);
}

/** Rebuild every vector layer from the project (called after load/import). */
function renderAllLayers() {
  for (const g of layerGroups.values()) map.removeLayer(g);
  layerGroups.clear();
  rendered.clear();

  if (!state.project) return;
  for (const layer of state.project.layers) {
    const group = L.layerGroup();
    for (const feature of layer.features) group.addLayer(buildFeatureLayer(feature, layer));
    layerGroups.set(layer.id, group);
    if (layer.visible !== false) group.addTo(map);
  }
}

/** Re-render a single feature in place (after a style or geometry change). */
function refreshFeature(layerId, featureId) {
  const layer = findLayer(layerId);
  const feature = findFeature(layerId, featureId);
  const entry = rendered.get(featureId);
  const group = layerGroups.get(layerId);
  if (!layer || !feature || !group) return;
  if (entry) group.removeLayer(entry.group);
  const fresh = buildFeatureLayer(feature, layer);
  group.addLayer(fresh);
}

function setLayerVisibility(layerId, visible) {
  const group = layerGroups.get(layerId);
  if (!group) return;
  if (visible && !map.hasLayer(group)) group.addTo(map);
  if (!visible && map.hasLayer(group)) map.removeLayer(group);
}

// ------------------------------------------------------------ selection
function selectFeature(layerId, featureId) {
  // Drop any half-finished vertex editing on the previous selection.
  if (editingFeatureId && editingFeatureId !== featureId) toggleVertexEditing(editingFeatureId, false);
  state.selectedFeature = layerId && featureId ? { layerId, featureId } : null;
  refreshProps();
}

function toggleVertexEditing(featureId, on) {
  const entry = rendered.get(featureId);
  if (!entry || !entry.primary.editing) return;
  if (on) {
    entry.primary.editing.enable();
    editingFeatureId = featureId;
  } else {
    const layer = findLayer(entry.layerId);
    if (entry.primary.editing.enabled()) {
      entry.primary.editing.disable();
      // Read the moved vertices back into the project.
      const latlngs = layer.type === 'areas'
        ? entry.primary.getLatLngs()[0]
        : entry.primary.getLatLngs();
      entry.feature.coords = latlngs.map((ll) => {
        const p = fromLatLng(ll);
        return [Math.round(p.x), Math.round(p.z)];
      });
      markDirty();
      refreshFeature(entry.layerId, featureId);
    }
    editingFeatureId = null;
  }
}

function deleteFeature(layerId, featureId) {
  const layer = findLayer(layerId);
  if (!layer) return;
  const idx = layer.features.findIndex((f) => f.id === featureId);
  if (idx < 0) return;
  const entry = rendered.get(featureId);
  const group = layerGroups.get(layerId);
  if (entry && group) group.removeLayer(entry.group);
  rendered.delete(featureId);
  layer.features.splice(idx, 1);
  if (state.selectedFeature && state.selectedFeature.featureId === featureId) selectFeature(null);
  markDirty();
  Main.renderLayerList();
  toast('Elemento eliminato');
}

// -------------------------------------------------------------- drawing
function setTool(tool) {
  if (drawHandler) { drawHandler.disable(); drawHandler = null; }
  if (editingFeatureId) toggleVertexEditing(editingFeatureId, false);
  currentTool = tool;

  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  const hint = el('draw-hint');

  if (tool === 'draw') {
    const layer = selectedLayer();
    if (!layer) { currentTool = 'select'; return; }
    startDrawing(layer);
    hint.classList.remove('hidden');
    hint.innerHTML = layer.type === 'pois'
      ? 'Clicca sulla mappa per posizionare il punto. <kbd>Esc</kbd> per annullare.'
      : `Clicca per aggiungere i vertici, <kbd>doppio clic</kbd> per finire${layer.type === 'areas' ? ' (l\'area si chiude da sola)' : ''}. <kbd>Esc</kbd> per annullare.`;
  } else {
    hint.classList.add('hidden');
    if (tool === 'edit' && state.selectedFeature) toggleVertexEditing(state.selectedFeature.featureId, true);
    if (tool === 'delete') toast('Clicca un elemento sulla mappa per eliminarlo', 'err');
  }
}

function startDrawing(layer) {
  const style = layer.defaultStyle || {};
  if (layer.type === 'pois') {
    drawHandler = new L.Draw.Marker(map, {
      icon: L.divIcon({
        className: 'ca-poi',
        html: poiSvg(style.shape || 'circle', style.color || '#e05a47', Number(style.size) || 10),
        iconSize: [Number(style.size) || 10, Number(style.size) || 10],
      }),
    });
  } else if (layer.type === 'areas') {
    drawHandler = new L.Draw.Polygon(map, {
      allowIntersection: true,
      showArea: false,
      shapeOptions: {
        color: style.strokeColor || '#4fa3d1',
        weight: Number(style.strokeWidth) || 2,
        fillColor: style.fillColor || '#4fa3d1',
        fillOpacity: style.fillOpacity ?? 0.25,
      },
    });
  } else {
    drawHandler = new L.Draw.Polyline(map, {
      shapeOptions: {
        color: style.color || '#f2c14e',
        weight: Number(style.width) || 4,
      },
    });
  }
  drawHandler.enable();
}

function onDrawCreated(e) {
  const layer = selectedLayer();
  if (!layer) return;

  const feature = {
    id: newId('f'),
    name: '',
    description: '',
    style: {},
  };

  if (layer.type === 'pois') {
    const p = fromLatLng(e.layer.getLatLng());
    feature.coord = [Math.round(p.x), Math.round(p.z)];
    feature.category = 'altro';
    feature.name = `Punto ${layer.features.length + 1}`;
  } else {
    const latlngs = layer.type === 'areas' ? e.layer.getLatLngs()[0] : e.layer.getLatLngs();
    feature.coords = latlngs.map((ll) => {
      const p = fromLatLng(ll);
      return [Math.round(p.x), Math.round(p.z)];
    });
    feature.name = layer.type === 'roads'
      ? `Via ${layer.features.length + 1}`
      : `Area ${layer.features.length + 1}`;
  }

  layer.features.push(feature);
  const group = layerGroups.get(layer.id);
  if (group) group.addLayer(buildFeatureLayer(feature, layer));
  markDirty();
  Main.renderLayerList();
  selectFeature(layer.id, feature.id);
  setTool('select');
  // Focus the name field so naming the new element is the natural next step.
  const nameInput = document.querySelector('#props .f-name');
  if (nameInput) { nameInput.focus(); nameInput.select(); }
}

// ----------------------------------------------------- properties panel
function refreshProps() {
  const host = el('props');
  const feature = selectedFeature();
  if (!feature) {
    host.innerHTML = '<div class="prop-empty">Nessun elemento selezionato.<br>Clicca un elemento sulla mappa.</div>';
    return;
  }
  const layer = findLayer(state.selectedFeature.layerId);
  const style = styleOf(feature, layer);

  const swatches = (current, cls) => `<div class="swatch-row">${PALETTE
    .map((c) => `<div class="swatch ${c.toLowerCase() === String(current).toLowerCase() ? 'sel' : ''}" data-swatch="${cls}" style="background:${c}" title="${c}"></div>`)
    .join('')}</div>`;

  const dashSelect = (current) => `<select class="f-dash">${Object.keys(DASHES)
    .map((d) => `<option value="${d}" ${d === (current || 'solid') ? 'selected' : ''}>${DASH_LABELS[d]}</option>`)
    .join('')}</select>`;

  let specific = '';
  if (layer.type === 'roads') {
    specific = `
      <label><span class="lbl">Colore tracciato</span>
        <input type="color" class="f-color" value="${style.color || '#f2c14e'}">${swatches(style.color, 'color')}</label>
      <label><span class="lbl">Spessore: <b class="v-width">${style.width || 4}</b> px</span>
        <input type="range" class="f-width" min="1" max="16" step="1" value="${style.width || 4}"></label>
      <label><span class="lbl">Tratteggio</span>${dashSelect(style.dash)}</label>
      <label><span class="lbl">Colore bordo (abbinamento)</span>
        <input type="color" class="f-casingColor" value="${style.casingColor || '#2b2b2b'}">${swatches(style.casingColor, 'casingColor')}</label>
      <label><span class="lbl">Spessore bordo: <b class="v-casing">${style.casingWidth ?? 2}</b> px</span>
        <input type="range" class="f-casingWidth" min="0" max="8" step="1" value="${style.casingWidth ?? 2}"></label>
      <div class="hint">Lunghezza: ${lengthOf(feature.coords)} blocchi · ${feature.coords.length} vertici</div>`;
  } else if (layer.type === 'areas') {
    specific = `
      <label><span class="lbl">Colore riempimento</span>
        <input type="color" class="f-fillColor" value="${style.fillColor || '#4fa3d1'}">${swatches(style.fillColor, 'fillColor')}</label>
      <label><span class="lbl">Opacità: <b class="v-opacity">${Math.round((style.fillOpacity ?? 0.25) * 100)}</b>%</span>
        <input type="range" class="f-fillOpacity" min="0" max="100" step="5" value="${Math.round((style.fillOpacity ?? 0.25) * 100)}"></label>
      <label><span class="lbl">Colore bordo</span>
        <input type="color" class="f-strokeColor" value="${style.strokeColor || '#4fa3d1'}">${swatches(style.strokeColor, 'strokeColor')}</label>
      <label><span class="lbl">Spessore bordo: <b class="v-stroke">${style.strokeWidth || 2}</b> px</span>
        <input type="range" class="f-strokeWidth" min="0" max="10" step="1" value="${style.strokeWidth || 2}"></label>
      <label><span class="lbl">Tratteggio bordo</span>${dashSelect(style.dash)}</label>
      <div class="hint">Superficie: ${areaOf(feature.coords)} blocchi² · ${feature.coords.length} vertici</div>`;
  } else {
    const shapeBtns = POI_SHAPES.map((s) => `
      <button class="shape-btn ${s === (style.shape || 'circle') ? 'sel' : ''}" data-shape="${s}" title="${s}">
        ${poiSvg(s, '#ffffff', 16)}
      </button>`).join('');
    specific = `
      <label><span class="lbl">Categoria</span>
        <select class="f-category">${POI_CATEGORIES
          .map((c) => `<option value="${c}" ${c === (feature.category || 'altro') ? 'selected' : ''}>${c}</option>`).join('')}
        </select></label>
      <label><span class="lbl">Simbolo</span><div class="shape-row">${shapeBtns}</div></label>
      <label><span class="lbl">Colore</span>
        <input type="color" class="f-color" value="${style.color || '#e05a47'}">${swatches(style.color, 'color')}</label>
      <label><span class="lbl">Dimensione: <b class="v-size">${style.size || 10}</b> px</span>
        <input type="range" class="f-size" min="6" max="30" step="1" value="${style.size || 10}"></label>
      <div class="hint">Posizione: X ${feature.coord[0]}, Z ${feature.coord[1]} — trascinabile sulla mappa</div>`;
  }

  host.innerHTML = `
    <label><span class="lbl">Nome</span><input type="text" class="f-name" value="${escapeHtml(feature.name)}"></label>
    <label><span class="lbl">Descrizione</span><textarea class="f-description" rows="3">${escapeHtml(feature.description)}</textarea></label>
    <label style="display:flex;align-items:center;gap:8px">
      <input type="checkbox" class="f-showName" ${style.showName !== false ? 'checked' : ''}> Mostra il nome sulla mappa
    </label>
    ${specific}
    <div class="row">
      <button class="btn btn-sm" data-act="zoom">Vai all'elemento</button>
      <button class="btn btn-sm btn-danger" data-act="delete">Elimina</button>
    </div>`;

  wireProps(host, feature, layer);
}

function wireProps(host, feature, layer) {
  const commit = (rerender) => {
    markDirty();
    if (rerender) refreshFeature(layer.id, feature.id);
    Main.renderLayerList();
  };
  const setStyle = (key, value, rerender = true) => {
    feature.style = { ...(feature.style || {}), [key]: value };
    commit(rerender);
  };

  const bindText = (sel, apply) => {
    const node = host.querySelector(sel);
    if (node) node.addEventListener('input', debounce(() => apply(node.value), 250));
  };
  bindText('.f-name', (v) => { feature.name = v; commit(true); });
  bindText('.f-description', (v) => { feature.description = v; commit(true); });

  const showName = host.querySelector('.f-showName');
  if (showName) showName.addEventListener('change', () => setStyle('showName', showName.checked));

  // Colors: both the native picker and the quick palette swatches.
  for (const key of ['color', 'casingColor', 'fillColor', 'strokeColor']) {
    const input = host.querySelector(`.f-${key}`);
    if (input) input.addEventListener('input', debounce(() => setStyle(key, input.value), 120));
  }
  host.querySelectorAll('.swatch').forEach((sw) => {
    sw.addEventListener('click', () => {
      const key = sw.dataset.swatch;
      const color = sw.style.backgroundColor;
      // Normalize rgb() from the DOM back into hex for storage.
      const m = color.match(/\d+/g);
      const hex = m ? `#${m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}` : color;
      const input = host.querySelector(`.f-${key}`);
      if (input) input.value = hex;
      setStyle(key, hex);
      host.querySelectorAll(`.swatch[data-swatch="${key}"]`).forEach((s) => s.classList.remove('sel'));
      sw.classList.add('sel');
    });
  });

  // Numeric sliders, with their live value readout.
  const sliders = [
    ['.f-width', 'width', '.v-width', (v) => v],
    ['.f-casingWidth', 'casingWidth', '.v-casing', (v) => v],
    ['.f-strokeWidth', 'strokeWidth', '.v-stroke', (v) => v],
    ['.f-size', 'size', '.v-size', (v) => v],
    ['.f-fillOpacity', 'fillOpacity', '.v-opacity', (v) => v / 100],
  ];
  for (const [sel, key, valSel, transform] of sliders) {
    const node = host.querySelector(sel);
    if (!node) continue;
    node.addEventListener('input', () => {
      const readout = host.querySelector(valSel);
      if (readout) readout.textContent = node.value;
      setStyle(key, transform(Number(node.value)));
    });
  }

  const dash = host.querySelector('.f-dash');
  if (dash) dash.addEventListener('change', () => setStyle('dash', dash.value));

  const category = host.querySelector('.f-category');
  if (category) category.addEventListener('change', () => { feature.category = category.value; commit(true); });

  host.querySelectorAll('.shape-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      host.querySelectorAll('.shape-btn').forEach((b) => b.classList.remove('sel'));
      btn.classList.add('sel');
      setStyle('shape', btn.dataset.shape);
    });
  });

  const zoomBtn = host.querySelector('[data-act="zoom"]');
  if (zoomBtn) zoomBtn.addEventListener('click', () => zoomToFeature(feature, layer));
  const delBtn = host.querySelector('[data-act="delete"]');
  if (delBtn) {
    delBtn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Eliminare l\'elemento?',
        message: `"${feature.name || 'senza nome'}" verrà rimosso dal layer "${layer.name}".`,
        confirmLabel: 'Elimina', danger: true,
      });
      if (ok) deleteFeature(layer.id, feature.id);
    });
  }
}

function zoomToFeature(feature, layer) {
  if (layer.type === 'pois') {
    map.setView(toLatLng(feature.coord[0], feature.coord[1]), Math.max(map.getZoom(), -1));
  } else {
    const b = L.latLngBounds(feature.coords.map(([x, z]) => toLatLng(x, z)));
    map.fitBounds(b.pad(0.2));
  }
}

function setTerrainVisible(visible) {
  if (!tileLayer) return;
  if (visible && !map.hasLayer(tileLayer)) tileLayer.addTo(map);
  if (!visible && map.hasLayer(tileLayer)) map.removeLayer(tileLayer);
}

// --------------------------------------------------------------- export
/** Block bounds to export, either the current view or the whole dimension. */
function exportBounds(mode) {
  if (mode === 'all' && state.world) {
    const dim = state.world.dimensions.find((d) => d.id === state.project.world.dimension)
      || state.world.dimensions[0];
    return { ...dim.bounds };
  }
  const b = map.getBounds();
  const nw = fromLatLng(b.getNorthWest());
  const se = fromLatLng(b.getSouthEast());
  return {
    minX: Math.floor(nw.x), minZ: Math.floor(nw.z),
    maxX: Math.ceil(se.x), maxZ: Math.ceil(se.z),
  };
}

const MAX_EXPORT_PX = 8000;
/** Pick the native tile zoom whose pixel size stays under the export cap. */
function pickExportZoom(bounds) {
  const wBlocks = bounds.maxX - bounds.minX + 1;
  const hBlocks = bounds.maxZ - bounds.minZ + 1;
  for (let z = 0; z >= -6; z--) {
    const scale = Math.pow(2, z);
    if (wBlocks * scale <= MAX_EXPORT_PX && hBlocks * scale <= MAX_EXPORT_PX) return z;
  }
  return -6;
}

/** Draw the terrain for `bounds` onto a canvas at `zoom`, via the worker. */
async function drawTerrain(ctx, bounds, zoom) {
  const scale = Math.pow(2, zoom);
  const span = 256 / scale; // blocks covered by one tile
  const t0x = Math.floor(bounds.minX / span);
  const t1x = Math.floor(bounds.maxX / span);
  const t0y = Math.floor(bounds.minZ / span);
  const t1y = Math.floor(bounds.maxZ / span);
  const dimId = state.project.world.dimension;

  const jobs = [];
  for (let ty = t0y; ty <= t1y; ty++) {
    for (let tx = t0x; tx <= t1x; tx++) jobs.push({ tx, ty });
  }
  // Small batches: a whole-world export can be thousands of tiles and we
  // don't want to queue them all into the worker at once.
  const BATCH = 8;
  for (let i = 0; i < jobs.length; i += BATCH) {
    const slice = jobs.slice(i, i + BATCH);
    const results = await Promise.all(slice.map(({ tx, ty }) => (
      engine.tile(dimId, zoom, tx, ty).catch(() => null)
    )));
    results.forEach((res, k) => {
      if (!res || res.empty || !res.bitmap) return;
      const { tx, ty } = slice[k];
      ctx.drawImage(res.bitmap, (tx * span - bounds.minX) * scale, (ty * span - bounds.minZ) * scale, 256, 256);
      res.bitmap.close();
    });
  }
}

/** Draw all visible vector layers onto a canvas. */
function drawVectors(ctx, bounds, scale) {
  const toPx = (x, z) => [(x - bounds.minX) * scale, (z - bounds.minZ) * scale];

  const applyDash = (style) => {
    const dash = dashFor(style);
    ctx.setLineDash(dash ? dash.split(',').map((n) => Number(n) * scale) : []);
  };

  for (const layer of state.project.layers) {
    if (layer.visible === false) continue;
    for (const feature of layer.features) {
      const style = styleOf(feature, layer);

      if (layer.type === 'areas') {
        ctx.beginPath();
        feature.coords.forEach(([x, z], i) => {
          const [px, py] = toPx(x, z);
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        });
        ctx.closePath();
        ctx.globalAlpha = style.fillOpacity ?? 0.25;
        ctx.fillStyle = style.fillColor || '#4fa3d1';
        ctx.fill();
        ctx.globalAlpha = 1;
        if ((style.strokeWidth || 0) > 0) {
          applyDash(style);
          ctx.strokeStyle = style.strokeColor || '#4fa3d1';
          ctx.lineWidth = style.strokeWidth;
          ctx.stroke();
          ctx.setLineDash([]);
        }

      } else if (layer.type === 'roads') {
        const stroke = (color, width, dashed) => {
          ctx.beginPath();
          feature.coords.forEach(([x, z], i) => {
            const [px, py] = toPx(x, z);
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          });
          ctx.strokeStyle = color;
          ctx.lineWidth = width;
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          if (dashed) applyDash(style); else ctx.setLineDash([]);
          ctx.stroke();
          ctx.setLineDash([]);
        };
        const casing = Number(style.casingWidth) || 0;
        if (casing > 0) stroke(style.casingColor || '#000', (Number(style.width) || 4) + casing * 2, false);
        stroke(style.color || '#f2c14e', Number(style.width) || 4, true);

      } else {
        const [px, py] = toPx(feature.coord[0], feature.coord[1]);
        drawPoiShape(ctx, style.shape || 'circle', px, py, Number(style.size) || 10, style.color || '#e05a47');
      }

      // Labels
      if (style.showName !== false && feature.name) {
        const [lx, ly] = layer.type === 'pois'
          ? toPx(feature.coord[0], feature.coord[1])
          : centroidPx(feature.coords, toPx);
        ctx.font = `${layer.type === 'areas' ? 15 : 12}px monospace`;
        ctx.textAlign = layer.type === 'pois' ? 'left' : 'center';
        ctx.textBaseline = 'middle';
        const offset = layer.type === 'pois' ? (Number(style.size) || 10) / 2 + 4 : 0;
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText(feature.name, lx + offset, ly);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(feature.name, lx + offset, ly);
      }
    }
  }
}

function centroidPx(coords, toPx) {
  let sx = 0, sz = 0;
  for (const [x, z] of coords) { sx += x; sz += z; }
  return toPx(sx / coords.length, sz / coords.length);
}

function drawPoiShape(ctx, shape, cx, cy, size, color) {
  const r = size / 2;
  ctx.beginPath();
  switch (shape) {
    case 'square': ctx.rect(cx - r, cy - r, size, size); break;
    case 'triangle':
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy + r); ctx.lineTo(cx - r, cy + r); ctx.closePath();
      break;
    case 'diamond':
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy); ctx.closePath();
      break;
    case 'star':
      for (let i = 0; i < 10; i++) {
        const rr = i % 2 === 0 ? r : r * 0.45;
        const a = (Math.PI / 5) * i - Math.PI / 2;
        const px = cx + rr * Math.cos(a);
        const py = cy + rr * Math.sin(a);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    case 'pin':
      ctx.moveTo(cx, cy + r);
      ctx.lineTo(cx - r, cy - r * 0.2);
      ctx.arc(cx, cy - r * 0.2, r, Math.PI, 0);
      ctx.closePath();
      break;
    default: ctx.arc(cx, cy, r, 0, Math.PI * 2);
  }
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#0d0d0d';
  ctx.setLineDash([]);
  ctx.stroke();
}

async function exportPNG() {
  if (!state.project || !state.world) { toast('Apri prima un atlante', 'err'); return; }
  const bounds = exportBounds(el('export-extent').value);
  const zoom = pickExportZoom(bounds);
  const scale = Math.pow(2, zoom);
  const w = Math.max(1, Math.round((bounds.maxX - bounds.minX + 1) * scale));
  const h = Math.max(1, Math.round((bounds.maxZ - bounds.minZ + 1) * scale));

  setStatus('export-status', `Composizione immagine ${w}×${h}…`, 'busy');
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#10120e';
  ctx.fillRect(0, 0, w, h);

  try {
    if (el('chk-terrain').checked) await drawTerrain(ctx, bounds, zoom);
    drawVectors(ctx, bounds, scale);
    await new Promise((resolve) => canvas.toBlob((blob) => {
      download(`${slugify(state.project.name)}.png`, blob);
      resolve();
    }, 'image/png'));
    setStatus('export-status', `PNG esportato (${w}×${h} px)`, 'ok');
  } catch (err) {
    setStatus('export-status', `Export fallito: ${err.message}`, 'err');
  }
}

async function exportSVG() {
  if (!state.project) { toast('Apri prima un atlante', 'err'); return; }
  const bounds = exportBounds(el('export-extent').value);
  const zoom = pickExportZoom(bounds);
  const scale = Math.pow(2, zoom);
  const w = Math.round((bounds.maxX - bounds.minX + 1) * scale);
  const h = Math.round((bounds.maxZ - bounds.minZ + 1) * scale);
  const toPx = (x, z) => [((x - bounds.minX) * scale).toFixed(1), ((z - bounds.minZ) * scale).toFixed(1)];

  setStatus('export-status', 'Composizione SVG…', 'busy');
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`];
  parts.push(`<rect width="${w}" height="${h}" fill="#10120e"/>`);

  // Terrain goes in as one flattened raster so the SVG stays a sane size.
  if (el('chk-terrain').checked) {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    try {
      await drawTerrain(ctx, bounds, zoom);
      parts.push(`<image x="0" y="0" width="${w}" height="${h}" href="${canvas.toDataURL('image/png')}" style="image-rendering:pixelated"/>`);
    } catch { /* terrain is optional in the SVG */ }
  }

  for (const layer of state.project.layers) {
    if (layer.visible === false) continue;
    parts.push(`<g id="${escapeHtml(layer.id)}" data-layer="${escapeHtml(layer.name)}" data-type="${layer.type}">`);
    for (const feature of layer.features) {
      const style = styleOf(feature, layer);
      const dash = dashFor(style);
      const dashAttr = dash ? ` stroke-dasharray="${dash.split(',').map((n) => Number(n) * scale).join(',')}"` : '';

      if (layer.type === 'areas') {
        const pts = feature.coords.map(([x, z]) => toPx(x, z).join(',')).join(' ');
        parts.push(`<polygon points="${pts}" fill="${style.fillColor || '#4fa3d1'}" fill-opacity="${style.fillOpacity ?? 0.25}" stroke="${style.strokeColor || '#4fa3d1'}" stroke-width="${style.strokeWidth || 2}"${dashAttr}/>`);
      } else if (layer.type === 'roads') {
        const d = `M ${feature.coords.map(([x, z]) => toPx(x, z).join(',')).join(' L ')}`;
        const casing = Number(style.casingWidth) || 0;
        if (casing > 0) {
          parts.push(`<path d="${d}" fill="none" stroke="${style.casingColor || '#000'}" stroke-width="${(Number(style.width) || 4) + casing * 2}" stroke-linejoin="round" stroke-linecap="round"/>`);
        }
        parts.push(`<path id="p-${escapeHtml(feature.id)}" d="${d}" fill="none" stroke="${style.color || '#f2c14e'}" stroke-width="${style.width || 4}" stroke-linejoin="round"${dashAttr}/>`);
      } else {
        const [px, py] = toPx(feature.coord[0], feature.coord[1]);
        const size = Number(style.size) || 10;
        parts.push(`<g transform="translate(${px - size / 2},${py - size / 2})">${poiSvg(style.shape || 'circle', style.color || '#e05a47', size)}</g>`);
      }

      if (style.showName !== false && feature.name) {
        const [lx, ly] = layer.type === 'pois'
          ? toPx(feature.coord[0], feature.coord[1])
          : (() => {
            let sx = 0, sz = 0;
            for (const [x, z] of feature.coords) { sx += x; sz += z; }
            return toPx(sx / feature.coords.length, sz / feature.coords.length);
          })();
        const anchor = layer.type === 'pois' ? 'start' : 'middle';
        const dx = layer.type === 'pois' ? (Number(style.size) || 10) / 2 + 4 : 0;
        const fs = layer.type === 'areas' ? 15 : 12;
        parts.push(`<text x="${Number(lx) + dx}" y="${ly}" font-family="monospace" font-size="${fs}" text-anchor="${anchor}" dominant-baseline="middle" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke">${escapeHtml(feature.name)}</text>`);
      }
    }
    parts.push('</g>');
  }
  parts.push('</svg>');

  download(`${slugify(state.project.name)}.svg`, parts.join('\n'), 'image/svg+xml');
  setStatus('export-status', `SVG esportato (${w}×${h})`, 'ok');
}

function exportGeoJSON() {
  if (!state.project) { toast('Apri prima un atlante', 'err'); return; }
  const features = [];
  for (const layer of state.project.layers) {
    for (const feature of layer.features) {
      const properties = {
        name: feature.name,
        description: feature.description,
        layer: layer.name,
        layerType: layer.type,
        category: feature.category,
        style: styleOf(feature, layer),
      };
      let geometry;
      if (layer.type === 'pois') {
        geometry = { type: 'Point', coordinates: feature.coord };
      } else if (layer.type === 'areas') {
        const ring = feature.coords.slice();
        const [fx, fz] = ring[0];
        const [lx, lz] = ring[ring.length - 1];
        if (fx !== lx || fz !== lz) ring.push([fx, fz]); // GeoJSON rings must close
        geometry = { type: 'Polygon', coordinates: [ring] };
      } else {
        geometry = { type: 'LineString', coordinates: feature.coords };
      }
      features.push({ type: 'Feature', properties, geometry });
    }
  }
  download(
    `${slugify(state.project.name)}.geojson`,
    JSON.stringify({ type: 'FeatureCollection', features }, null, 2),
    'application/geo+json'
  );
  setStatus('export-status', `GeoJSON esportato (${features.length} elementi)`, 'ok');
}


export {
  initMap, attachWorld, renderAllLayers, refreshFeature, setLayerVisibility,
  selectFeature, refreshProps, setTool, deleteFeature,
  setTerrainVisible, zoomToFeature, goTo, fitWorld, refreshTiles, updateViewInfo,
  currentDimension, exportPNG, exportSVG, exportGeoJSON,
  POI_SHAPES, PALETTE,
};
export function getMap() { return map; }
export function getCurrentTool() { return currentTool; }
