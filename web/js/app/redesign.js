/*
 * Redesign: schede della barra laterale, hotbar, scorciatoie, schermo intero.
 *
 * Solo comportamento di interfaccia: non tocca lo stato dell'app. È importato
 * da main.js (che apre la scheda Layer dopo aver aperto un atlante, o la
 * scheda 3D dal pulsante sulla mappa) e quindi esporta setTab.
 */

import * as Atlas3D from './atlas3d.js';

const $ = (id) => document.getElementById(id);
const app = $('app');
const sidebar = $('atlas-sidebar');
const TAB_KEY = 'cube-atlas-side-tab';
const TABS = ['world', 'project', 'layers', 'props', 'export', 'model3d'];

/* ------------------------------------------------ schede della sidebar (1e) */
let activeTab = 'world';
let tabBeforeProps = null;
let tabBefore3d = 'layers';

export function setTab(name, { remember = true } = {}) {
  if (!TABS.includes(name)) name = 'layers';
  const previous = activeTab;
  if (name === 'model3d' && previous !== 'model3d') tabBefore3d = previous;
  activeTab = name;
  sidebar.dataset.active = name;
  document.querySelectorAll('.side-tab').forEach((b) => {
    const on = b.dataset.panel === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on);
  });
  sidebar.scrollTop = 0;
  // The 3D tab owns the map while it is open: the box on it, or the model
  // in its place. Any other tab gives the map back.
  if (name === 'model3d' && previous !== 'model3d') Atlas3D.openTab();
  if (name !== 'model3d' && previous === 'model3d') Atlas3D.closeTab();
  if (remember && name !== 'props') { try { localStorage.setItem(TAB_KEY, name); } catch { /* ignore */ } }
}

export const getTab = () => activeTab;

document.querySelectorAll('.side-tab').forEach((b) => {
  b.addEventListener('click', () => { tabBeforeProps = null; setTab(b.dataset.panel); });
});

/* ------------------------------ Proprietà accanto a ciò che hai selezionato */
const props = $('props');
new MutationObserver(() => {
  const hasSelection = !props.querySelector('.prop-empty') && props.children.length > 0;
  if (hasSelection && activeTab !== 'props' && activeTab !== 'model3d') {
    tabBeforeProps = activeTab;
    setTab('props', { remember: false });
  } else if (!hasSelection && activeTab === 'props' && tabBeforeProps) {
    setTab(tabBeforeProps, { remember: false });
    tabBeforeProps = null;
  }
}).observe(props, { childList: true });

/* --------------------------------------------------------- hotbar editor */
const stationBtn = $('btn-new-independent-station');
const hbStation = $('hb-station');
const syncStation = () => hbStation.classList.toggle('hidden', stationBtn.classList.contains('hidden'));
new MutationObserver(syncStation).observe(stationBtn, { attributes: true, attributeFilter: ['class'] });
syncStation();
hbStation.addEventListener('click', () => stationBtn.click());

/* ---------------------------------------- 3D: schermo intero (1g) */
function setFull(on) {
  if (on && !Atlas3D.isViewerShown()) return;
  app.classList.toggle('a3d-full', on);
  // renderer e camera leggono la dimensione del contenitore
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}
$('a3d-full-btn').addEventListener('click', () => setFull(!app.classList.contains('a3d-full')));
$('a3d-exit-full').addEventListener('click', () => setFull(false));
document.querySelectorAll('#a3d-hotbar [data-click]').forEach((b) => {
  b.addEventListener('click', () => { const t = $(b.dataset.click); if (t && !t.disabled) t.click(); });
});
// When the model goes away (Torna alla mappa, another tab), so does full screen.
document.addEventListener('a3d:viewer-hidden', () => setFull(false));

/* ------------------------------------------------------------- scorciatoie */
const typing = (t) => t instanceof Element
  && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
const press = (id) => { const b = $(id); if (b && !b.disabled && !b.classList.contains('hidden')) b.click(); };

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
  const atlasOn = $('screen-atlas').classList.contains('active');
  if (!atlasOn || app.classList.contains('title-on')) return;

  // Model on screen: full screen, its hotbar, Esc.
  if (Atlas3D.isViewerShown()) {
    const full = app.classList.contains('a3d-full');
    if (e.key === 'f' || e.key === 'F') { setFull(!full); e.preventDefault(); return; }
    if (e.key === 'Escape' && full) { setFull(false); e.preventDefault(); return; }
    if (full) {
      const b = document.querySelectorAll('#a3d-hotbar [data-click]')[Number(e.key) - 1];
      if (b) { b.click(); e.preventDefault(); return; }
    }
  }

  // The 3D tab takes arrows, + / −, Enter and Esc for the box.
  if (activeTab === 'model3d') {
    const what = Atlas3D.handleKey(e);
    if (what === 'exit') { setTab(tabBefore3d === 'model3d' ? 'layers' : tabBefore3d); e.preventDefault(); return; }
    if (what) { e.preventDefault(); return; }
  }

  if (e.key === 'm' || e.key === 'M') {
    setTab(activeTab === 'model3d' ? tabBefore3d : 'model3d');
    e.preventDefault();
    return;
  }
  if (activeTab === 'model3d') return;
  const map = { 1: 'tool-draw', 2: 'tool-select', 3: 'tool-edit', 4: 'tool-delete', 5: 'hb-station', 6: 'btn-map-search', 7: 'btn-compass', 8: 'btn-see-3d' };
  if (map[e.key]) { press(map[e.key]); e.preventDefault(); return; }
  if (e.key === 'e' || e.key === 'E') { setTab(activeTab === 'layers' ? (tabBeforeProps || 'project') : 'layers'); e.preventDefault(); }
});

// Start on the tab used last (the title screen covers the app until an atlas
// is open, and opening one goes to Layer anyway).
let saved = null;
try { saved = localStorage.getItem(TAB_KEY); } catch { /* ignore */ }
setTab(saved && saved !== 'model3d' ? saved : 'world', { remember: false });
