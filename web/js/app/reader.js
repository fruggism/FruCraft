/*
 * Cube-Atlas Lettore: opens files already exported by the Editor — a map
 * (interactive layers over a flat terrain image), or a document exported
 * from the Archivio. It needs no world and no project open: everything
 * shown here comes from a file the user picks on their own computer, read
 * locally like everything else in the app.
 *
 * The map's layer rendering (icons, popups, dash styles…) is not
 * reimplemented here: it's imported from atlas.js, which exports the
 * read-only pieces precisely so a feature looks and behaves the same
 * whether it's being edited or just viewed.
 */

import { el, escapeHtml, toast, setStatus, toLatLng } from './ui-core.js';
import * as Atlas from './atlas.js';
import { READER_DOC_FORMAT } from './archive.js';

const READER_MAP_FORMAT = Atlas.READER_MAP_FORMAT || 'cube-atlas/map';

// ------------------------------------------------------------- view state
function showEmpty() {
  el('reader-empty').classList.remove('hidden');
  el('reader-map-view').classList.add('hidden');
  el('reader-image-view').classList.add('hidden');
  el('reader-doc-view').classList.add('hidden');
  el('reader-map-layers').classList.add('hidden');
}

function showMap() {
  el('reader-empty').classList.add('hidden');
  el('reader-map-view').classList.remove('hidden');
  el('reader-image-view').classList.add('hidden');
  el('reader-doc-view').classList.add('hidden');
  el('reader-map-layers').classList.remove('hidden');
}

function showImage() {
  el('reader-empty').classList.add('hidden');
  el('reader-map-view').classList.add('hidden');
  el('reader-image-view').classList.remove('hidden');
  el('reader-doc-view').classList.add('hidden');
  el('reader-map-layers').classList.add('hidden');
}

function showDoc() {
  el('reader-empty').classList.add('hidden');
  el('reader-map-view').classList.add('hidden');
  el('reader-image-view').classList.add('hidden');
  el('reader-doc-view').classList.remove('hidden');
  el('reader-map-layers').classList.add('hidden');
}

// -------------------------------------------------------- interactive map
let readerMap = null;
let readerLayers = [];              // the opened bundle's layers, as-is
const readerLayerGroups = new Map(); // layerId -> L.LayerGroup

function initReaderMap() {
  if (readerMap) return readerMap;
  readerMap = L.map('reader-map', {
    crs: L.CRS.Simple,
    minZoom: -6,
    maxZoom: 4,
    zoomSnap: 0.25,
    attributionControl: false,
    zoomControl: true,
  });
  return readerMap;
}

/** Same ancestor-chain rule as the Editor's layerVisible: hiding a layer
 *  hides its sublayers too. Reimplemented here (rather than imported)
 *  because it needs to walk *this* bundle's layers, not state.project. */
function readerLayerVisible(layer) {
  let cur = layer;
  const seen = new Set();
  while (cur) {
    if (cur.visible === false) return false;
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
    cur = cur.parentId ? readerLayers.find((l) => l.id === cur.parentId) : null;
  }
  return true;
}

/** A read-only rendering of one feature: same look as the Editor
 *  (Atlas.poiSvg / noteSvg / stationSvg / popupHtml…), no dragging or tools. */
function buildReadOnlyFeature(feature, layer) {
  const style = Atlas.styleOf(feature, layer);
  const group = L.layerGroup();
  let primary;

  if (layer.type === 'areas') {
    primary = L.polygon(feature.coords.map(([x, z]) => toLatLng(x, z)), {
      color: style.strokeColor || '#4fa3d1',
      weight: Number(style.strokeWidth) || 2,
      dashArray: Atlas.dashFor(style),
      fillColor: style.fillColor || '#4fa3d1',
      fillOpacity: style.fillOpacity ?? 0.25,
    });
  } else if (layer.type === 'roads' || layer.type === 'transit') {
    const coords = layer.type === 'transit' ? Atlas.offsetTransitCoords(feature, layer) : feature.coords;
    primary = L.polyline(coords.map(([x, z]) => toLatLng(x, z)), {
      color: style.color || (layer.type === 'transit' ? '#4fa3d1' : '#f2c14e'),
      weight: Number(style.width) || (layer.type === 'transit' ? 5 : 4),
      opacity: style.opacity ?? 1,
      dashArray: Atlas.dashFor(style),
      lineJoin: 'round',
    });
  } else if (layer.type === 'notes') {
    const size = Number(style.size) || 16;
    primary = L.marker(toLatLng(feature.coord[0], feature.coord[1]), {
      icon: L.divIcon({
        className: 'ca-poi ca-note', html: Atlas.noteSvg(style.color || '#f5e14a', size),
        iconSize: [size, size], iconAnchor: [size / 2, size],
      }),
      keyboard: false,
    });
  } else { // pois
    const size = Number(style.size) || 10;
    primary = L.marker(toLatLng(feature.coord[0], feature.coord[1]), {
      icon: L.divIcon({
        className: 'ca-poi', html: Atlas.poiSvg(style.shape || 'circle', style.color || '#e05a47', size),
        iconSize: [size, size], iconAnchor: style.shape === 'pin' ? [size / 2, size] : [size / 2, size / 2],
      }),
      keyboard: false,
    });
  }
  group.addLayer(primary);
  if (feature.image) group.addLayer(Atlas.bannerMarker(feature, layer));

  if (style.showName !== false && feature.name) {
    primary.bindTooltip(escapeHtml(feature.name), {
      permanent: true,
      direction: Atlas.isPointLayer(layer.type) ? 'right' : 'center',
      offset: Atlas.isPointLayer(layer.type) ? [Number(style.size) / 2 + 2 || 8, 0] : [0, 0],
      className: `ca-label${layer.type === 'areas' ? ' big' : ''}`,
      sticky: false,
    });
  }
  primary.bindPopup(Atlas.popupHtml(feature, layer), { closeButton: false, autoPan: false, className: 'ca-info-popup' });
  primary.on('mouseover', () => primary.openPopup());
  primary.on('mouseout', () => primary.closePopup());
  return group;
}

function buildReadOnlyStation(station, layer) {
  const size = 14;
  const marker = L.marker(toLatLng(station.x, station.z), {
    icon: L.divIcon({
      className: 'ca-poi ca-station', html: Atlas.stationSvg(size),
      iconSize: [size, size], iconAnchor: [size / 2, size / 2],
    }),
    keyboard: false,
  });
  if (station.name) {
    marker.bindTooltip(escapeHtml(station.name), {
      permanent: true, direction: 'right', offset: [size / 2 + 2, 0], className: 'ca-label', sticky: false,
    });
  }
  const lines = (layer.features || [])
    .filter((f) => (f.stationIds || []).includes(station.id))
    .map((f) => f.name || '(senza nome)');
  marker.bindPopup(`<div class="ca-popup">
      <h4>${escapeHtml(station.name || '(stazione)')}</h4>
      ${station.description ? `<p class="desc">${escapeHtml(station.description)}</p>` : ''}
      <div class="meta">Stazione · ${lines.length ? escapeHtml(lines.join(', ')) : 'nessuna linea collegata'}</div>
    </div>`, { closeButton: false, autoPan: false, className: 'ca-info-popup' });
  marker.on('mouseover', () => marker.openPopup());
  marker.on('mouseout', () => marker.closePopup());
  return marker;
}

function renderReaderLayers() {
  for (const g of readerLayerGroups.values()) readerMap.removeLayer(g);
  readerLayerGroups.clear();
  for (const layer of readerLayers) {
    const group = L.layerGroup();
    for (const feature of layer.features || []) group.addLayer(buildReadOnlyFeature(feature, layer));
    if (layer.type === 'transit') {
      for (const station of layer.stations || []) group.addLayer(buildReadOnlyStation(station, layer));
    }
    readerLayerGroups.set(layer.id, group);
    if (readerLayerVisible(layer)) group.addTo(readerMap);
  }
}

function applyReaderVisibility() {
  for (const layer of readerLayers) {
    const group = readerLayerGroups.get(layer.id);
    if (!group) continue;
    const visible = readerLayerVisible(layer);
    if (visible && !readerMap.hasLayer(group)) group.addTo(readerMap);
    if (!visible && readerMap.hasLayer(group)) readerMap.removeLayer(group);
  }
}

const LAYER_ICONS = { roads: '🛣️', pois: '📍', areas: '⬟', transit: '🚇', notes: '📝' };

function renderReaderLayerList() {
  const host = el('reader-layer-list');
  const byParent = new Map();
  for (const l of readerLayers) {
    const key = l.parentId || '';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(l);
  }
  const order = [];
  const visit = (key, depth) => {
    for (const l of byParent.get(key) || []) { order.push({ layer: l, depth }); visit(l.id, depth + 1); }
  };
  visit('', 0);
  const seen = new Set(order.map((o) => o.layer.id));
  for (const l of readerLayers) if (!seen.has(l.id)) order.push({ layer: l, depth: 0 });

  host.innerHTML = order.map(({ layer, depth }) => `
    <li class="layer-item" data-id="${layer.id}" style="padding-left:${7 + depth * 16}px">
      <span class="eye ${layer.visible === false ? 'off' : ''}" data-eye="${layer.id}" title="Mostra/nascondi">👁</span>
      <span class="kind" title="${layer.type}">${LAYER_ICONS[layer.type] || '•'}</span>
      <span class="lname">${escapeHtml(layer.name)}</span>
      <span class="count">${(layer.features || []).length}</span>
    </li>`).join('');

  host.querySelectorAll('.eye').forEach((node) => {
    node.addEventListener('click', () => {
      const layer = readerLayers.find((l) => l.id === node.dataset.eye);
      if (!layer) return;
      layer.visible = layer.visible === false;
      applyReaderVisibility();
      renderReaderLayerList();
    });
  });
}

function openMapBundle(raw) {
  const map = initReaderMap();
  readerLayers = Array.isArray(raw.layers) ? raw.layers : [];
  showMap();
  setTimeout(() => map.invalidateSize(), 30);

  const b = raw.bounds || {};
  const bounds = L.latLngBounds(toLatLng(b.minX || 0, b.minZ || 0), toLatLng(b.maxX || 0, b.maxZ || 0));
  // Opening a second map replaces the first: drop any previous background image.
  map.eachLayer((l) => { if (l instanceof L.ImageOverlay) map.removeLayer(l); });
  if (raw.image) L.imageOverlay(raw.image, bounds).addTo(map);
  map.fitBounds(bounds);

  renderReaderLayers();
  renderReaderLayerList();
}

function openPlainImage(file) {
  const img = el('reader-image');
  img.src = URL.createObjectURL(file);
  img.className = 'fit';
  el('reader-image-name').textContent = file.name;
  showImage();
}

async function openMapFile(file) {
  if (!file) return;
  try {
    const looksJson = file.name.toLowerCase().endsWith('.json') || file.type === 'application/json';
    if (looksJson) {
      const raw = JSON.parse(await file.text());
      if (!raw || raw.format !== READER_MAP_FORMAT) {
        throw new Error('Questo file non è una mappa Cube-Atlas per il Lettore');
      }
      openMapBundle(raw);
    } else {
      openPlainImage(file);
    }
    setStatus('reader-map-status', `"${file.name}" aperta`, 'ok');
  } catch (err) {
    setStatus('reader-map-status', `Apertura fallita: ${err.message}`, 'err');
    toast(`Apertura fallita: ${err.message}`, 'err');
  }
}

// ------------------------------------------------------------- documents
function renderDocument(doc) {
  const pages = doc.pages && doc.pages.length ? doc.pages : [''];
  el('reader-doc-title').textContent = doc.title || 'Senza titolo';
  el('reader-doc-author').textContent = doc.author ? `di ${doc.author}` : '';
  el('reader-doc-pages').innerHTML = pages.map((p, i) => (
    `<div class="book-page">${escapeHtml(p) || '<i>(pagina vuota)</i>'}<span class="page-no">${i + 1}/${pages.length}</span></div>`
  )).join('');
  showDoc();
}

/** The plain .txt fallback mirrors what "Scarica testo .txt" writes:
 *  title, then an optional "di AUTORE" line, a blank line, then the body. */
function parsePlainTxt(text, filename) {
  const lines = text.split(/\r\n?|\n/);
  let i = 0;
  const title = lines[i] || filename;
  i++;
  let author = '';
  if (lines[i] && lines[i].startsWith('di ')) { author = lines[i].slice(3); i++; }
  while (lines[i] === '') i++;
  return { title, author, pages: [lines.slice(i).join('\n')] };
}

async function openDocFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const looksJson = file.name.toLowerCase().endsWith('.json') || file.type === 'application/json';
    if (looksJson) {
      const raw = JSON.parse(text);
      if (raw && raw.format && raw.format !== READER_DOC_FORMAT) {
        throw new Error('Questo file non è un documento Cube-Atlas');
      }
      renderDocument({
        title: typeof raw.title === 'string' ? raw.title : file.name,
        author: typeof raw.author === 'string' ? raw.author : '',
        pages: Array.isArray(raw.pages) ? raw.pages : null,
      });
    } else {
      renderDocument(parsePlainTxt(text, file.name));
    }
    setStatus('reader-doc-status', `"${file.name}" aperto`, 'ok');
  } catch (err) {
    setStatus('reader-doc-status', `Apertura fallita: ${err.message}`, 'err');
    toast(`Apertura fallita: ${err.message}`, 'err');
  }
}

// ------------------------------------------------------------------ init
function init() {
  el('btn-reader-open-map').addEventListener('click', () => el('reader-map-input').click());
  el('reader-map-input').addEventListener('change', (e) => {
    openMapFile(e.target.files && e.target.files[0]);
    e.target.value = '';
  });

  el('btn-reader-open-doc').addEventListener('click', () => el('reader-doc-input').click());
  el('reader-doc-input').addEventListener('change', (e) => {
    openDocFile(e.target.files && e.target.files[0]);
    e.target.value = '';
  });

  el('btn-reader-image-fit').addEventListener('click', () => { el('reader-image').className = 'fit'; });
  el('btn-reader-image-full').addEventListener('click', () => { el('reader-image').className = 'full'; });

  showEmpty();
}

export { init };
