/*
 * The 3D selection box, drawn on the Leaflet map (scheda «Modello 3D»).
 *
 * The map is the preview: you frame the zone where you already know your way
 * around, instead of on a separate thumbnail. Outside the box the map darkens,
 * inside a faint grid shows the chunks. The body drags, the corner handles
 * resize both sides, the mid-side ones a single side — that is what makes it
 * rectangular. Every rule (snapping to 16, 32–1024) lives in boxMath.js; this
 * file only turns pointer events into those calls and draws the result.
 *
 * Pointer events are listened to on the DOM elements Leaflet creates, not
 * through Leaflet's own drag machinery: one code path for mouse, pen and
 * touch, and the map's own panning is switched off only while a drag runs.
 */

import { moveBox, resizeBox } from './boxMath.js';

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const FAR = 400000; // blocks: the darkening reaches far past any real world

export function createSelection(map, { toLatLng, fromLatLng, onChange, onCreate }) {
  map.createPane('selMask').style.zIndex = 430;
  map.createPane('selBox').style.zIndex = 440;
  const maskPane = map.getPane('selMask');
  maskPane.style.pointerEvents = 'none';

  let box = null;
  let visible = false;
  const group = L.layerGroup();

  const mask = L.polygon([[]], {
    pane: 'selMask', stroke: false, fillColor: '#000', fillOpacity: 0.5, interactive: false,
  }).addTo(group);
  const grid = L.polyline([], {
    pane: 'selMask', color: '#7fd44f', weight: 1, opacity: 0.35, interactive: false,
  }).addTo(group);
  const outline = L.rectangle([[0, 0], [1, 1]], {
    pane: 'selBox', color: '#000', weight: 7, fill: false, interactive: false,
  }).addTo(group);
  const rect = L.rectangle([[0, 0], [1, 1]], {
    pane: 'selBox', color: '#7fd44f', weight: 3, fillColor: '#7fd44f', fillOpacity: 0.08,
    interactive: true, className: 'sel-rect',
  }).addTo(group);

  const handles = {};
  for (const h of HANDLES) {
    handles[h] = L.marker([0, 0], {
      icon: L.divIcon({ className: `sel-handle sel-${h}`, iconSize: [14, 14] }),
      keyboard: false, zIndexOffset: 1000,
    }).addTo(group);
  }
  const label = L.marker([0, 0], {
    icon: L.divIcon({ className: 'sel-label', html: '<span></span>', iconSize: null }),
    interactive: false, keyboard: false,
  }).addTo(group);
  const createBtn = L.marker([0, 0], {
    icon: L.divIcon({
      className: 'sel-create-wrap', iconSize: null,
      html: '<button class="btn btn-primary sel-create"><img src="img/icons/stone.png" alt=""> Crea modello 3D</button>',
    }),
    keyboard: false, zIndexOffset: 1100,
  }).addTo(group);

  const corners = (b) => {
    const x0 = b.minX, z0 = b.minZ, x1 = b.minX + b.sizeX, z1 = b.minZ + b.sizeZ;
    return { x0, z0, x1, z1, xm: (x0 + x1) / 2, zm: (z0 + z1) / 2 };
  };

  function draw() {
    if (!box) return;
    const { x0, z0, x1, z1, xm, zm } = corners(box);
    const ll = (x, z) => toLatLng(x, z);
    const bounds = L.latLngBounds(ll(x0, z0), ll(x1, z1));
    rect.setBounds(bounds);
    outline.setBounds(bounds);
    mask.setLatLngs([
      [ll(x0 - FAR, z0 - FAR), ll(x1 + FAR, z0 - FAR), ll(x1 + FAR, z1 + FAR), ll(x0 - FAR, z1 + FAR)],
      [ll(x0, z0), ll(x1, z0), ll(x1, z1), ll(x0, z1)],
    ]);
    const lines = [];
    for (let x = x0 + 16; x < x1; x += 16) lines.push([ll(x, z0), ll(x, z1)]);
    for (let z = z0 + 16; z < z1; z += 16) lines.push([ll(x0, z), ll(x1, z)]);
    grid.setLatLngs(lines);
    const at = { nw: [x0, z0], n: [xm, z0], ne: [x1, z0], e: [x1, zm], se: [x1, z1], s: [xm, z1], sw: [x0, z1], w: [x0, zm] };
    for (const h of HANDLES) handles[h].setLatLng(ll(...at[h]));
    label.setLatLng(ll(x0, z0));
    const span = label.getElement() && label.getElement().querySelector('span');
    if (span) span.textContent = `${box.sizeX} × ${box.sizeZ} blocchi · trascina per spostare`;
    createBtn.setLatLng(ll(x1, z1));
  }

  // ---------------------------------------------------------------- drags
  function drag(e, apply) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const start = fromLatLng(map.mouseEventToLatLng(e));
    const startBox = { ...box };
    map.dragging.disable();
    document.body.classList.add('sel-dragging');
    const move = (ev) => {
      const p = fromLatLng(map.mouseEventToLatLng(ev));
      const next = apply(startBox, p, start);
      if (next.minX !== box.minX || next.minZ !== box.minZ
        || next.sizeX !== box.sizeX || next.sizeZ !== box.sizeZ) {
        box = next;
        draw();
        onChange(box, { dragging: true });
      }
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      map.dragging.enable();
      document.body.classList.remove('sel-dragging');
      onChange(box, { dragging: false });
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  }

  function wire() {
    const body = rect.getElement();
    if (body && !body.dataset.wired) {
      body.dataset.wired = '1';
      body.addEventListener('pointerdown', (e) => drag(e,
        (b, p, s) => moveBox(b, p.x - s.x, p.z - s.z)));
    }
    for (const h of HANDLES) {
      const node = handles[h].getElement();
      if (!node || node.dataset.wired) continue;
      node.dataset.wired = '1';
      node.addEventListener('pointerdown', (e) => drag(e, (b, p) => resizeBox(b, h, p.x, p.z)));
    }
    const btn = createBtn.getElement() && createBtn.getElement().querySelector('button');
    if (btn && !btn.dataset.wired) {
      btn.dataset.wired = '1';
      L.DomEvent.disableClickPropagation(createBtn.getElement());
      btn.addEventListener('click', () => onCreate());
    }
  }

  return {
    show(b) {
      box = { ...b };
      if (!visible) { group.addTo(map); visible = true; }
      draw();
      wire();
    },
    hide() {
      if (visible) { group.remove(); visible = false; }
    },
    set(b) {
      box = { ...b };
      if (visible) draw();
    },
    get: () => (box ? { ...box } : null),
    isVisible: () => visible,
    /** Bring the box into view if the user has panned it off screen. */
    reveal() {
      if (!box || !visible) return;
      const { x0, z0, x1, z1 } = corners(box);
      const bounds = L.latLngBounds(toLatLng(x0, z0), toLatLng(x1, z1));
      if (!map.getBounds().contains(bounds)) map.fitBounds(bounds.pad(0.6));
    },
  };
}
