/*
 * La scheda Mondo dell'editor (3c): dove sei e come ci arrivi.
 *
 * Vai a coordinate — anche incollate dal gioco, un /tp o i numeri di F3 —
 * spawn, dov'eri tu l'ultima volta, tutto il mondo, e i luoghi che ti sei
 * segnato. Quando la mappa salta da qualche parte, un mirino col numero
 * resta lì tre secondi: altrimenti, su una mappa tutta uguale, non sai dove
 * guardare.
 */

import {
  state, el, escapeHtml, toast, markDirty, promptDialog, engine, toLatLng, fromLatLng,
} from './ui-core.js';
import { parseCoords } from './coords.js';
import { PLACE_ICONS, newId } from './projects.js';

let bridge = null;
let marker = null;
let markerTimer = null;

/** Jump there and leave a crosshair for a moment. */
function jump(x, z, zoom) {
  const map = bridge.getMap();
  if (!map) return;
  bridge.goTo(x, z, zoom ?? Math.max(map.getZoom(), -1));
  el('goto-x').value = Math.round(x);
  el('goto-z').value = Math.round(z);
  if (marker) marker.remove();
  clearTimeout(markerTimer);
  marker = L.marker(toLatLng(x, z), {
    interactive: false, keyboard: false, zIndexOffset: 2000,
    icon: L.divIcon({
      className: 'goto-mark', iconSize: [40, 40], iconAnchor: [20, 20],
      html: `<span class="goto-cross"></span><span class="goto-lbl">X ${Math.round(x)} Z ${Math.round(z)}</span>`,
    }),
  }).addTo(map);
  markerTimer = setTimeout(() => { if (marker) { marker.remove(); marker = null; } }, 3000);
}

function goFromFields() {
  const raw = `${el('goto-x').value} ${el('goto-z').value}`;
  const p = parseCoords(raw);
  if (!p) { toast('Scrivi due numeri, X e Z', 'err'); return; }
  jump(p.x, p.z);
}

/** Pasting "/tp 812 72 -344" in X fills X and Z. */
function onCoordInput(e) {
  const p = parseCoords(e.target.value);
  if (!p || !/[\s,/]/.test(e.target.value.trim())) return;
  el('goto-x').value = p.x;
  el('goto-z').value = p.z;
}

// ---------------------------------------------------------------- places ---

function renderPlaces() {
  const host = el('wt-places');
  const places = (state.project && state.project.places) || [];
  if (!places.length) {
    host.innerHTML = '<li class="wt-place-empty">Nessun luogo: sposta la mappa e «+ salva la vista».</li>';
    return;
  }
  host.innerHTML = places.map((p) => `
    <li class="wt-place" data-id="${escapeHtml(p.id)}" title="Clic: vai lì · clic destro: elimina">
      <img src="img/icons/${p.icon}.png" alt="">
      <span class="wt-place-name">${escapeHtml(p.name)}</span>
      <span class="wt-place-xz">${p.x.toLocaleString('it-IT')}, ${p.z.toLocaleString('it-IT')}</span>
      <button class="wt-place-x" title="Elimina">×</button>
    </li>`).join('');
  host.querySelectorAll('.wt-place').forEach((li) => {
    const place = places.find((p) => p.id === li.dataset.id);
    li.addEventListener('click', () => jump(place.x, place.z));
    const remove = (e) => {
      e.preventDefault();
      e.stopPropagation();
      state.project.places = state.project.places.filter((p) => p.id !== place.id);
      markDirty();
      renderPlaces();
    };
    li.addEventListener('contextmenu', remove);
    li.querySelector('.wt-place-x').addEventListener('click', remove);
  });
}

async function savePlace() {
  if (!state.project) return;
  const map = bridge.getMap();
  const c = fromLatLng(map.getCenter());
  const name = await promptDialog({
    title: 'Salva la vista', message: 'Come si chiama questo posto?', value: '', confirmLabel: 'Salva',
  });
  if (name === null) return;
  const places = state.project.places || (state.project.places = []);
  places.push({
    id: newId('pl'), name: name.trim() || 'Luogo',
    x: Math.round(c.x), z: Math.round(c.z),
    icon: PLACE_ICONS[places.length % PLACE_ICONS.length],
  });
  markDirty();
  renderPlaces();
}

// ---------------------------------------------------------------- header ---

let iconUrl = null;

/** Refresh the whole tab for the atlas just opened (or closed). */
export function render() {
  const info = state.worldInfo || {};
  const world = state.world;
  const dim = world && state.project
    && world.dimensions.find((d) => d.id === state.project.world.dimension);
  el('wt-name').textContent = (world && world.levelName) || info.levelName || 'Nessun mondo';
  el('wt-meta').textContent = [world && world.version, dim && dim.label].filter(Boolean).join(' · ');
  if (iconUrl) { URL.revokeObjectURL(iconUrl); iconUrl = null; }
  if (info.icon) {
    iconUrl = URL.createObjectURL(new Blob([info.icon], { type: 'image/png' }));
    el('wt-icon').src = iconUrl;
  } else {
    el('wt-icon').src = 'img/icons/grass.png';
  }
  renderPlaces();
}

export function init(b) {
  bridge = b;
  el('btn-goto').addEventListener('click', goFromFields);
  for (const id of ['goto-x', 'goto-z']) {
    el(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') goFromFields(); });
  }
  el('goto-x').addEventListener('input', onCoordInput);
  el('goto-x').addEventListener('paste', () => setTimeout(() => onCoordInput({ target: el('goto-x') }), 0));
  el('btn-goto-spawn').addEventListener('click', () => {
    const spawn = (state.world && state.world.spawn) || { x: 0, z: 0 };
    jump(spawn.x, spawn.z, 0);
  });
  el('btn-goto-player').addEventListener('click', async () => {
    const pos = state.world ? await engine.player() : null;
    if (!pos) { toast('Il salvataggio non registra dov\'eri', 'err'); return; }
    jump(pos.x, pos.z, 0);
  });
  el('btn-goto-fit').addEventListener('click', () => bridge.fitWorld());
  el('btn-place-add').addEventListener('click', savePlace);
  el('wt-change').addEventListener('click', (e) => { e.preventDefault(); bridge.changeWorld(); });
}
