/*
 * Redesign (mockup 1b · 1e · 1h⇄1g).
 *
 * Solo comportamento di interfaccia: non tocca lo stato dell'app. Tutti gli ID
 * esistenti restano, quindi main.js / atlas.js / atlas3d.js funzionano come
 * prima; qui si aggiungono schede, hotbar, scorciatoie e il 3D a tutto schermo.
 */

const $ = (id) => document.getElementById(id);
const app = $('app');
const sidebar = $('atlas-sidebar');
const TAB_KEY = 'cube-atlas-side-tab';

/* ------------------------------------------------ schede della sidebar (1e) */
let activeTab = 'world';
let tabBeforeProps = null;

function setTab(name, { remember = true } = {}) {
  activeTab = name;
  sidebar.dataset.active = name;
  document.querySelectorAll('.side-tab').forEach((b) => {
    const on = b.dataset.panel === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on);
  });
  sidebar.scrollTop = 0;
  if (remember) { try { localStorage.setItem(TAB_KEY, name); } catch { /* ignore */ } }
}

document.querySelectorAll('.side-tab').forEach((b) => {
  b.addEventListener('click', () => { tabBeforeProps = null; setTab(b.dataset.panel); });
});

/* ------------------------------------------------- benvenuto a schermo (1b) */
// Finché la mappa non ha un atlante aperto (#map-overlay visibile), il pannello
// Mondo diventa la schermata "Seleziona il mondo".
const overlay = $('map-overlay');
let wasWelcome = null;
function syncWelcome() {
  const welcome = !overlay.classList.contains('hidden');
  app.classList.toggle('welcome', welcome);
  if (welcome) setTab('world', { remember: false });
  else if (wasWelcome) {
    let saved = null;
    try { saved = localStorage.getItem(TAB_KEY); } catch { /* ignore */ }
    setTab(saved && saved !== 'world' ? saved : 'layers');
    setTimeout(() => window.dispatchEvent(new Event('resize')), 30);
  }
  wasWelcome = welcome;
}
new MutationObserver(syncWelcome).observe(overlay, { attributes: true, attributeFilter: ['class'] });
syncWelcome();

/* ------------------------------ Proprietà accanto a ciò che hai selezionato */
const props = $('props');
new MutationObserver(() => {
  const hasSelection = !props.querySelector('.prop-empty') && props.children.length > 0;
  if (hasSelection && activeTab !== 'props') {
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

/* ------------------------------------------------ 3D: 1h ⇄ 1g schermo intero */
function setFull(on) {
  app.classList.toggle('a3d-full', on);
  // renderer e camera leggono la dimensione del contenitore
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}
$('a3d-full-btn').addEventListener('click', () => setFull(!app.classList.contains('a3d-full')));
$('a3d-exit-full').addEventListener('click', () => setFull(false));
document.querySelectorAll('#a3d-hotbar [data-click]').forEach((b) => {
  b.addEventListener('click', () => { const t = $(b.dataset.click); if (t && !t.disabled) t.click(); });
});
// Uscendo dalla sezione 3D si esce anche dallo schermo intero.
new MutationObserver(() => {
  if (!$('screen-atlas3d').classList.contains('active') && app.classList.contains('a3d-full')) setFull(false);
}).observe($('screen-atlas3d'), { attributes: true, attributeFilter: ['class'] });

/* ------------------------------------------------------------- scorciatoie */
const typing = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
const press = (id) => { const b = $(id); if (b && !b.disabled && !b.classList.contains('hidden')) b.click(); };

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
  const atlasOn = $('screen-atlas').classList.contains('active');
  const a3dOn = $('screen-atlas3d').classList.contains('active');

  if (atlasOn && !app.classList.contains('welcome')) {
    const map = { 1: 'tool-draw', 2: 'tool-select', 3: 'tool-edit', 4: 'tool-delete', 5: 'hb-station', 6: 'btn-map-search', 7: 'btn-compass', 8: 'btn-see-3d' };
    if (map[e.key]) { press(map[e.key]); e.preventDefault(); return; }
    if (e.key === 'e' || e.key === 'E') { setTab(activeTab === 'layers' ? (tabBeforeProps || 'project') : 'layers'); e.preventDefault(); }
  }

  if (a3dOn) {
    const sceneReady = !$('scene').classList.contains('hidden');
    if ((e.key === 'f' || e.key === 'F') && sceneReady) { setFull(!app.classList.contains('a3d-full')); e.preventDefault(); }
    else if (e.key === 'Escape' && app.classList.contains('a3d-full')) setFull(false);
    else if (app.classList.contains('a3d-full')) {
      const b = document.querySelectorAll('#a3d-hotbar [data-click]')[Number(e.key) - 1];
      if (b) { b.click(); e.preventDefault(); }
    }
  }
});
