/*
 * The window's dialogs: Apply (Applica.dc.html), Replace (Sostituisci.dc.html),
 * and the small ones (go to coordinates, save a selection, the Development
 * menu's fill). Each gets the app's context and talks to the main process
 * only through ctx.api.
 */

import { esc, fmt, signed, rgb, modal, closeModal, cleanError, toast, pickFrom, icon } from './ui.js';
import { blockMatcher, matcherKind, parseMix, TAG_NAMES } from '../core/blocks.js';
import { selectionBounds, isEmptySelection, yRange } from '../core/selection.js';
import { biomesFor, biomeColor, biomeLabel } from '../core/biomes.js';
import { dimensionInfo } from '../core/dimensions.js';
import { colorFor, COLORS } from '../../web/js/core/blockColors.js';

export const OP_LABELS = {
  setIcon: 'Icona del mondo', setSpawn: 'Spawn', setGameRule: 'Regole di gioco', setLevelValue: 'Ora e meteo', setDayTime: 'Ora e meteo', setWeather: 'Ora e meteo',
  fillBox: 'Riempimenti', replaceBlocks: 'Sostituzioni', paintBiome: 'Biomi dipinti',
  group: 'Modifiche di Claude', setTerrain: 'Terreno', placeFeatures: 'Alberi e piante',
};

const newTaskId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export async function applyDialog(ctx) {
  const t = ctx.tab();
  if (!t || !t.info.journal.size) return;
  let pre;
  try { pre = await ctx.api.apply.check(t.id); } catch (err) { toast(cleanError(err), 'err'); return; }
  const summary = Object.entries(t.info.journal.summary)
    .map(([k, v]) => `<div><span>${esc(OP_LABELS[k] || k)}</span><b>${fmt(v)}</b></div>`).join('')
    + `<div><span>Chunk toccati</span><b>${fmt(pre.stats.chunks)}</b></div>`;
  const parent = t.info.path.replace(/[/\\][^/\\]+$/, '/');
  const m = modal(`
    <div class="dh"><div><h2>Applica le modifiche</h2><p>Il mondo originale non viene toccato: il Cantiere crea una copia e scrive lì ${t.info.journal.size === 1 ? 'la modifica' : `le ${fmt(t.info.journal.size)} modifiche`} in sospeso.</p></div></div>
    <div class="scroll">
      <div class="dsec">
        <label class="lbl" for="copy-name">Nome della copia</label>
        <input id="copy-name" class="fld text" value="${esc(pre.copyName)}" spellcheck="false">
        <div class="path">${icon('i-open')}${esc(parent)}</div>
      </div>
      <div class="dsec"><div class="caps">Riepilogo</div><div class="sum">${summary}</div></div>
      <div class="dsec"><div class="caps">Controlli</div>
        ${(pre.checks || []).map((c) => `<div class="chk"><span class="${c.ok ? 'ok' : 'ko'}">${c.ok ? '✓' : '✕'}</span>${esc(c.label)}<small>${esc(c.detail || '')}</small></div>`).join('')}
        ${pre.errors.filter((e) => !/Minecraft|Spazio/.test(e)).map((e) => `<p class="warnline" style="color:var(--rd)">${esc(e)}</p>`).join('')}
        ${pre.warnings.map((w) => `<p class="warnline">${esc(w)}</p>`).join('')}
      </div>
      <div class="dsec hidden" id="ap-progress"><div class="caps" id="ap-phase">Scrittura in corso…</div><div class="pb"><i></i></div><p class="hint" id="ap-file" style="margin:6px 0 0"></p></div>
    </div>
    <div class="df"><span class="hint">${fmt(pre.stats.regions)} file di regione da riscrivere</span>
      <span class="end"><button class="btn big" id="ap-cancel">Annulla</button><button class="btn big pri" id="ap-go" ${pre.ok ? '' : 'disabled'}>Crea la copia e applica</button></span></div>`, { label: 'Applica le modifiche' });

  let taskId = null;
  m.querySelector('#ap-cancel').onclick = async () => {
    if (taskId) { await ctx.api.task.cancel(taskId); return; }
    closeModal();
  };
  m.querySelector('#ap-go').onclick = async () => {
    const name = m.querySelector('#copy-name').value.trim();
    if (!name || /[/\\:]/.test(name)) { toast('Nome della copia non valido.', 'err'); return; }
    taskId = newTaskId();
    m.querySelector('#ap-go').disabled = true;
    m.querySelector('#copy-name').disabled = true;
    m.querySelector('#ap-progress').classList.remove('hidden');
    const phases = { copia: 'Copia del mondo…', scrittura: 'Scrittura in corso…', verifica: 'Verifica…', fine: 'Fatto' };
    const off = ctx.api.task.onProgress((id, p) => {
      if (id !== taskId) return;
      m.querySelector('#ap-phase').textContent = phases[p.phase] || p.phase;
      m.querySelector('.pb i').style.width = `${Math.round((p.done / Math.max(1, p.total)) * 100)}%`;
      m.querySelector('#ap-file').textContent = p.file ? `${p.file} · ${p.done + 1} di ${p.total}` : '';
    });
    try {
      const res = await ctx.api.apply.run(t.id, { copyName: name }, taskId);
      off();
      t.info = res.info;
      ctx.afterJournal(t, { dirty: [{ dim: null }] });
      const done = modal(`
        <div class="dh"><div><h2 class="done-title">Copia creata</h2><p>${fmt(res.chunks)} chunk riscritti in ${fmt(res.regions)} file, 0 errori. Il mondo originale non è stato toccato.</p></div></div>
        <div class="dsec"><div class="path">${icon('i-open')}${esc(res.targetDir)}</div>
          ${res.warnings.map((w) => `<p class="warnline">${esc(w)}</p>`).join('')}
          <p class="hint" style="margin:10px 0 0">Aprila in Minecraft dall'elenco dei mondi e controlla le modifiche.</p></div>
        <div class="df"><button class="btn big" id="d-reveal">Mostra nel Finder</button>
          <span class="end"><button class="btn big" id="d-close">Chiudi</button><button class="btn big pri" id="d-open">Apri la copia</button></span></div>`, { label: 'Copia creata' });
      done.querySelector('#d-close').onclick = closeModal;
      done.querySelector('#d-reveal').onclick = () => ctx.api.reveal(res.targetDir);
      done.querySelector('#d-open').onclick = () => { closeModal(); ctx.openWorld(res.targetDir); };
    } catch (err) {
      off();
      closeModal();
      if (err && /Annullato/.test(cleanError(err))) toast('Applica annullata: la copia incompleta è stata rimossa. L\'originale non è cambiato.', 'warn');
      else toast(`Applica non è riuscita: ${cleanError(err)}`, 'err');
    }
  };
}

// ---------------------------------------------------------------------------
// Replace
// ---------------------------------------------------------------------------

const BLOCK_NAMES = Object.keys(COLORS).filter((n) => n.startsWith('minecraft:')).map((n) => n.slice(10)).sort();

function swatchFor(text) {
  const t = String(text || '').trim();
  if (!t) return 'transparent';
  if (t.startsWith('#') || t.includes('*')) return 'repeating-linear-gradient(45deg,#8a939e 0 3px,#454c55 3px 6px)';
  return rgb(colorFor(t.includes(':') ? t.replace(/\[.*$/, '') : `minecraft:${t.replace(/\[.*$/, '')}`, null));
}

function mixBar(text) {
  try {
    const mix = parseMix(text);
    const total = mix.reduce((s, p) => s + p.weight, 0) || 1;
    return mix.map((p) => `<i style="background:${rgb(colorFor(p.state.Name, null))};width:${(p.weight / total) * 100}%"></i>`).join('');
  } catch { return ''; }
}

export function replaceDialog(ctx, preset = null) {
  const t = ctx.tab();
  if (!t) return;
  const sel = ctx.selection();
  const dim = t.dim;
  const info = dimensionInfo(dim);
  const useSel = !isEmptySelection(sel);
  const dimBounds = t.info.dimensions.find((d) => d.id === dim).bounds;
  const region = useSel ? sel : { items: [{ mode: 'add', shape: { type: 'rect', ...dimBounds } }], yMin: null, yMax: null };
  const [y0, y1] = yRange(region, info.minY, info.height);
  const st = {
    rules: preset || [{ from: '', to: '' }],
    yMin: y0, yMax: y1, exposedOnly: false, keepProps: true, biomes: [],
  };
  let countTask = null;
  let countTimer = null;

  const m = modal(`
    <div class="dh"><div style="flex:1"><h2>Sostituisci blocchi</h2><p>Ogni regola cambia un blocco, un tag o un pattern in un altro, anche a percentuali. ${useSel ? 'Ambito: la selezione attiva.' : `Ambito: <b>tutta la dimensione</b> (${esc(t.info.dimensions.find((d) => d.id === dim).label)}) — nessuna selezione attiva.`}</p></div><button class="x" id="rp-x" aria-label="Chiudi">✕</button></div>
    <div class="scroll"><div class="rules" id="rp-rules"></div><button class="add-rule" id="rp-add">+ Aggiungi regola</button>
    <div class="flt">
      <div class="lab"><span class="hint">Y</span><input class="fld" id="rp-ymin" value="${st.yMin}" aria-label="Y minima"><span class="hint">–</span><input class="fld" id="rp-ymax" value="${st.yMax}" aria-label="Y massima"></div>
      <div class="lab"><span>Solo esposti all'aria</span><button class="sw" id="rp-exp" role="switch" aria-checked="false" aria-label="Solo esposti all'aria"></button></div>
      <div class="lab"><span>Mantieni proprietà</span><button class="sw on" id="rp-keep" role="switch" aria-checked="true" aria-label="Mantieni proprietà"></button></div>
      <div class="lab"><span class="hint">Biomi</span><span id="rp-biomes"></span><button class="bchip" id="rp-addbiome" style="color:var(--tx3)">+ aggiungi</button></div>
    </div></div>
    <datalist id="rp-blocks">${[...TAG_NAMES, ...BLOCK_NAMES].map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
    <div class="df"><span class="cnt mono" id="rp-count">—</span><span class="hint" id="rp-count-label">blocchi da cambiare</span>
      <span class="end"><button class="btn" id="rp-cancel">Annulla</button><button class="btn pri" id="rp-ok">Metti in sospeso</button></span></div>`, { wide: true, label: 'Sostituisci blocchi' });

  const ruleValid = (r) => {
    try { blockMatcher(r.from); parseMix(r.to); return true; } catch { return false; }
  };
  const op = () => ({
    type: 'replaceBlocks', dim, region,
    rules: st.rules.filter((r) => r.from.trim() && r.to.trim()).map((r) => ({ from: r.from.trim(), to: r.to.trim() })),
    yMin: Number(st.yMin), yMax: Number(st.yMax), exposedOnly: st.exposedOnly, keepProps: st.keepProps,
    biomes: st.biomes, seed: Math.floor(Math.random() * 1e9),
  });
  const seed = op().seed;

  const drawRules = () => {
    m.querySelector('#rp-rules').innerHTML = st.rules.map((r, i) => {
      let kind = r.from.trim() ? matcherKind(r.from) : '';
      let bad = false;
      if (r.from.trim()) { try { blockMatcher(r.from); } catch { bad = true; kind = 'sconosciuto'; } }
      return `<div class="rl" data-i="${i}">
        <span class="ix">${i + 1}</span>
        <div class="src"><i class="tile" style="background:${swatchFor(r.from)}"></i><input data-k="from" value="${esc(r.from)}" placeholder="stone, #minecraft:logs, *_planks" list="rp-blocks" spellcheck="false" aria-label="Blocco da sostituire"><span class="kind${bad ? ' bad' : ''}">${esc(kind)}</span></div>
        <span class="arrow">→</span>
        <div class="dst"><div class="mix">${mixBar(r.to)}</div><input data-k="to" value="${esc(r.to)}" placeholder="andesite oppure 70% stone, 30% tuff" list="rp-blocks" spellcheck="false" aria-label="Blocco o mix di destinazione"></div>
        <button class="x" data-del="${i}" aria-label="Rimuovi la regola">✕</button></div>`;
    }).join('');
  };
  const drawBiomes = () => {
    m.querySelector('#rp-biomes').innerHTML = st.biomes.map((b) => `<button class="bchip" data-unbiome="${esc(b)}" title="Togli"><i class="tile" style="background:${rgb(biomeColor(b))}"></i>${esc(biomeLabel(b))} ✕</button>`).join(' ');
  };
  const recount = () => {
    clearTimeout(countTimer);
    countTimer = setTimeout(async () => {
      if (countTask) ctx.api.task.cancel(countTask);
      const o = { ...op(), seed };
      const label = m.querySelector('#rp-count-label');
      if (!o.rules.length || !st.rules.every((r) => (!r.from.trim() && !r.to.trim()) || ruleValid(r))) {
        m.querySelector('#rp-count').textContent = '—';
        label.textContent = 'completa le regole';
        return;
      }
      const id = newTaskId();
      countTask = id;
      m.querySelector('#rp-count').textContent = '…';
      try {
        const c = await ctx.api.world.countReplace(t.id, o, id);
        if (countTask !== id) return;
        m.querySelector('#rp-count').textContent = fmt(c.changed);
        label.textContent = `blocchi cambiati da ${o.rules.length === 1 ? '1 regola' : `${o.rules.length} regole`}${c.dropped ? ` · ${fmt(c.dropped)} perdono le proprietà` : ''}`;
      } catch (err) {
        if (countTask === id && !/Annullato/.test(cleanError(err))) { m.querySelector('#rp-count').textContent = '!'; label.textContent = cleanError(err); }
      }
    }, 450);
  };

  drawRules(); drawBiomes(); recount();
  m.addEventListener('input', (e) => {
    const row = e.target.closest('.rl');
    if (row) {
      const r = st.rules[Number(row.dataset.i)];
      r[e.target.dataset.k] = e.target.value;
      // Update swatch, kind and mix bar in place, keeping the caret.
      row.querySelector('.src .tile').style.background = swatchFor(r.from);
      const k = row.querySelector('.kind');
      let bad = false;
      try { if (r.from.trim()) blockMatcher(r.from); } catch { bad = true; }
      k.textContent = r.from.trim() ? (bad ? 'sconosciuto' : matcherKind(r.from)) : '';
      k.classList.toggle('bad', bad);
      row.querySelector('.mix').innerHTML = mixBar(r.to);
    }
    if (e.target.id === 'rp-ymin') st.yMin = e.target.value;
    if (e.target.id === 'rp-ymax') st.yMax = e.target.value;
    recount();
  });
  m.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) { st.rules.splice(Number(del.dataset.del), 1); if (!st.rules.length) st.rules.push({ from: '', to: '' }); drawRules(); recount(); return; }
    const ub = e.target.closest('[data-unbiome]');
    if (ub) { st.biomes = st.biomes.filter((b) => b !== ub.dataset.unbiome); drawBiomes(); recount(); return; }
    const id = e.target.id;
    if (id === 'rp-add') { st.rules.push({ from: '', to: '' }); drawRules(); m.querySelector(`.rl[data-i="${st.rules.length - 1}"] input`).focus(); }
    else if (id === 'rp-exp' || id === 'rp-keep') {
      const key = id === 'rp-exp' ? 'exposedOnly' : 'keepProps';
      st[key] = !st[key];
      e.target.classList.toggle('on', st[key]); e.target.setAttribute('aria-checked', String(st[key]));
      recount();
    } else if (id === 'rp-addbiome') {
      const b = await pickFrom(e.target, biomesFor(dim).map((x) => ({ id: x.id, label: x.label, swatch: rgb(x.color) })), { placeholder: 'Cerca un bioma…' });
      if (b && !st.biomes.includes(b)) { st.biomes.push(b); drawBiomes(); recount(); }
    } else if (id === 'rp-cancel' || id === 'rp-x') {
      if (countTask) ctx.api.task.cancel(countTask);
      closeModal();
    } else if (id === 'rp-ok') {
      const o = { ...op(), seed };
      const wrong = st.rules.find((r) => (r.from.trim() || r.to.trim()) && !ruleValid(r));
      if (wrong) { toast(`Regola non valida: ${wrong.from || '(vuota)'} → ${wrong.to || '(vuota)'}`, 'err'); return; }
      if (!o.rules.length) { toast('Aggiungi almeno una regola.', 'err'); return; }
      if (countTask) ctx.api.task.cancel(countTask);
      closeModal();
      await ctx.pushOp(o);
    }
  });
}

// ---------------------------------------------------------------------------
// Small dialogs
// ---------------------------------------------------------------------------

export function gotoDialog(ctx) {
  const c = ctx.center();
  const m = modal(`
    <div class="dh"><div><h2>Vai a coordinate</h2><p>Centra la mappa su un punto del mondo.</p></div></div>
    <div class="dsec"><div class="form-grid"><label for="g-x">X</label><input class="fld" id="g-x" value="${Math.round(c.x)}"><label for="g-z">Z</label><input class="fld" id="g-z" value="${Math.round(c.z)}"></div></div>
    <div class="df"><span class="end"><button class="btn" id="g-no">Annulla</button><button class="btn pri" id="g-go">Vai</button></span></div>`, { label: 'Vai a coordinate' });
  const go = () => {
    const x = Number(m.querySelector('#g-x').value), z = Number(m.querySelector('#g-z').value);
    if (!Number.isFinite(x) || !Number.isFinite(z)) { toast('Coordinate non valide.', 'err'); return; }
    closeModal(); ctx.goTo(x, z);
  };
  m.querySelector('#g-no').onclick = closeModal;
  m.querySelector('#g-go').onclick = go;
  m.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

/**
 * The world's icon (icon.png, the picture Minecraft shows in the world list):
 * from an image file, or from the middle square of what the map shows now.
 */
export function iconDialog(ctx) {
  const t = ctx.tab();
  const m = modal(`
    <div class="dh">${t.info.icon ? `<img src="${t.info.icon}" alt="Icona attuale" width="64" height="64" style="image-rendering:pixelated;border-radius:6px;flex:none">` : ''}
      <div><h2>Icona del mondo</h2><p>L'immagine che Minecraft mostra nell'elenco dei mondi (64 × 64). Resta in sospeso: Applica la scrive nella copia.</p></div></div>
    <div class="df"><span class="end"><button class="btn" id="ic-no">Annulla</button><button class="btn" id="ic-view">Usa la vista della mappa</button><button class="btn pri" id="ic-file">Scegli immagine…</button></span></div>`, { label: 'Icona del mondo' });
  const use = async (get) => {
    try {
      const png = await get();
      if (png) await ctx.pushOp({ type: 'setIcon', png });
    } catch (err) { toast(cleanError(err), 'err'); }
  };
  m.querySelector('#ic-no').onclick = closeModal;
  m.querySelector('#ic-file').onclick = () => { closeModal(); use(() => ctx.api.icon.fromFile()); };
  m.querySelector('#ic-view').onclick = () => {
    closeModal();
    // Wait for the dialog to leave the screen before taking the picture.
    use(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))).then(() => {
      const r = ctx.mapRect();
      const side = Math.min(r.width, r.height);
      return ctx.api.icon.fromView({ x: r.left + (r.width - side) / 2, y: r.top + (r.height - side) / 2, width: side, height: side });
    }));
  };
}

export function saveSelectionDialog(ctx) {
  const m = modal(`
    <div class="dh"><div><h2>Salva la selezione</h2><p>La ritrovi nel pannello Proprietà quando usi uno strumento di selezione, per questo mondo.</p></div></div>
    <div class="dsec"><label class="lbl" for="ss-name">Nome</label><input class="fld text" id="ss-name" value="Selezione ${new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}"></div>
    <div class="df"><span class="end"><button class="btn" id="ss-no">Annulla</button><button class="btn pri" id="ss-ok">Salva</button></span></div>`, { label: 'Salva la selezione' });
  const ok = () => { const n = m.querySelector('#ss-name').value.trim(); if (!n) return; closeModal(); ctx.saveSelection(n); };
  m.querySelector('#ss-no').onclick = closeModal;
  m.querySelector('#ss-ok').onclick = ok;
  m.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
}

/** Development menu: fill a box with one block, to test region writing in game. */
export function devFillDialog(ctx) {
  const t = ctx.tab();
  if (!t) return;
  const info = dimensionInfo(t.dim);
  const sel = ctx.selection();
  const b = selectionBounds(sel);
  // Without an explicit Y range, one layer just under the spawn: easy to find in game.
  const hasY = sel && sel.yMin !== null && sel.yMin !== undefined;
  const [ylo, yhi] = hasY ? yRange(sel, info.minY, info.height) : [t.info.spawn.y - 1, t.info.spawn.y - 1];
  const box = b
    ? { x1: b.minX, z1: b.minZ, x2: b.maxX, z2: b.maxZ, y1: ylo, y2: yhi }
    : { x1: t.info.spawn.x - 1, z1: t.info.spawn.z - 1, x2: t.info.spawn.x + 1, z2: t.info.spawn.z + 1, y1: ylo, y2: yhi };
  const f = (k, label) => `<label for="df-${k}">${label}</label><input class="fld" id="df-${k}" value="${box[k]}">`;
  const m = modal(`
    <div class="dh"><div><h2>Riempi un'area con un blocco</h2><p>Comando di prova (menu Sviluppo): serve a verificare in gioco la scrittura delle region — luce, heightmap, chunk vicini intatti. Riempie la scatola, non la forma della selezione.</p></div></div>
    <div class="dsec"><label class="lbl" for="df-state">Blocco</label><input class="fld text" id="df-state" value="gold_block" spellcheck="false"></div>
    <div class="dsec"><div class="form-grid" style="grid-template-columns:auto 1fr auto 1fr auto 1fr">${f('x1', 'X da')}${f('y1', 'Y da')}${f('z1', 'Z da')}${f('x2', 'X a')}${f('y2', 'Y a')}${f('z2', 'Z a')}</div></div>
    <div class="dsec"><div class="caps">Heightmap</div><div class="seg" id="df-hm" style="width:340px"><button class="sg on" data-hm="recompute">Ricalcola il Cantiere</button><button class="sg" data-hm="drop">Lascia fare al gioco</button></div>
      <p class="hint" style="margin:8px 0 0">Prova entrambe su copie diverse e guarda pioggia, neve e mob sopra il blocco.</p></div>
    <div class="df"><span class="hint">${signed(box.x2 - box.x1 + 1)} × ${signed(box.z2 - box.z1 + 1)} × ${signed(box.y2 - box.y1 + 1)}</span><span class="end"><button class="btn" id="df-no">Annulla</button><button class="btn pri" id="df-ok">Metti in sospeso</button></span></div>`, { label: 'Riempi un\'area' });
  let hm = 'recompute';
  m.querySelector('#df-hm').onclick = (e) => {
    const bt = e.target.closest('[data-hm]'); if (!bt) return;
    hm = bt.dataset.hm;
    m.querySelectorAll('[data-hm]').forEach((x) => x.classList.toggle('on', x === bt));
  };
  m.querySelector('#df-no').onclick = closeModal;
  m.querySelector('#df-ok').onclick = async () => {
    const v = (k) => Number(m.querySelector(`#df-${k}`).value);
    const op = { type: 'fillBox', dim: t.dim, x1: v('x1'), y1: v('y1'), z1: v('z1'), x2: v('x2'), y2: v('y2'), z2: v('z2'), state: m.querySelector('#df-state').value.trim(), heightmaps: hm };
    if (['x1', 'y1', 'z1', 'x2', 'y2', 'z2'].some((k) => !Number.isFinite(op[k]))) { toast('Coordinate non valide.', 'err'); return; }
    if ((Math.abs(op.x2 - op.x1) + 1) * (Math.abs(op.z2 - op.z1) + 1) * (Math.abs(op.y2 - op.y1) + 1) > 4_000_000) { toast('Area troppo grande per una prova (max 4 milioni di blocchi).', 'err'); return; }
    closeModal();
    await ctx.pushOp(op);
  };
}

// ---------------------------------------------------------------------------
// Ask Claude
// ---------------------------------------------------------------------------

const CLAUDE_EXAMPLES = [
  'Trasforma in una collina boscosa di querce e betulle',
  'Spiana tutto alla quota media, prato con qualche fiore',
  'Scava un laghetto al centro con la riva di sabbia',
  'Fai una valle con un fiume da ovest a est',
];
const CLAUDE_STEPS = { avvio: 'avvia Claude Code…', pensa: 'pensa…', scrive: 'scrive la ricetta…', fatto: 'ha risposto' };

/** Last request per world, so "ask again" and reopening keep the text. */
const lastRequest = new Map();

/**
 * "Chiedi a Claude…": the selected area is described to Claude (through the
 * user's Claude Code, on their subscription) and its answer comes back as one
 * group of operations, shown here before it goes into the journal.
 */
export async function claudeDialog(ctx) {
  const t = ctx.tab();
  if (!t) return;
  const sel = ctx.selection();
  if (isEmptySelection(sel)) { toast('Prima seleziona un\'area: Rettangolo (M), Poligono (P), Lazo (L) o Pennello (S).', 'warn'); return; }
  const b = selectionBounds(sel);
  const w = b.maxX - b.minX + 1, d = b.maxZ - b.minZ + 1;
  const tooBig = w > 256 || d > 256;
  let model = ctx.settings()?.claudeModel || 'opus';
  let taskId = null;

  const m = modal(`
    <div class="dh"><div style="flex:1"><h2>Chiedi a Claude</h2><p>Descrivi cosa vuoi nell'area selezionata. Claude riceve un riassunto del terreno (altezze, blocchi in superficie, acqua, biomi) e propone le modifiche; tu le vedi qui e sulla mappa prima di tenerle. Usa il tuo abbonamento Claude tramite Claude Code: nessun costo a consumo.</p></div><button class="x" id="cl-x" aria-label="Chiudi">✕</button></div>
    <div class="scroll">
      <div class="dsec" id="cl-ask">
        <label class="lbl" for="cl-req">Richiesta</label>
        <textarea id="cl-req" class="fld text cl-req" rows="4" placeholder="es. trasforma in una collina boscosa" spellcheck="true">${esc(lastRequest.get(t.info.path) || '')}</textarea>
        <div class="cl-ex">${CLAUDE_EXAMPLES.map((x) => `<button class="bchip" data-ex="${esc(x)}">${esc(x)}</button>`).join('')}</div>
        <div class="cl-row"><span class="hint">Modello</span><div class="seg" id="cl-model" style="width:340px"><button class="sg${model === 'opus' ? ' on' : ''}" data-model="opus">Opus · più accurato</button><button class="sg${model === 'sonnet' ? ' on' : ''}" data-model="sonnet">Sonnet · più veloce</button></div></div>
        <div class="chk" id="cl-status"><span class="ok">…</span>Controllo Claude Code…</div>
        ${tooBig ? `<p class="warnline" style="color:var(--rd)">L'area è ${fmt(w)} × ${fmt(d)}: il lato massimo è 256 blocchi. Seleziona un'area più piccola.</p>` : ''}
      </div>
      <div class="dsec hidden" id="cl-run"><div class="caps" id="cl-phase">Lettura dell'area…</div><div class="pb"><i></i></div><p class="hint" id="cl-detail" style="margin:6px 0 0"></p></div>
      <div class="dsec hidden" id="cl-result"></div>
    </div>
    <div class="df"><span class="hint" id="cl-foot">${fmt(w)} × ${fmt(d)} blocchi · ${esc(t.info.dimensions.find((x) => x.id === t.dim).label)}</span>
      <span class="end" id="cl-buttons"><button class="btn big" id="cl-cancel">Annulla</button><button class="btn big pri" id="cl-go" ${tooBig ? 'disabled' : ''}>Chiedi a Claude</button></span></div>`, { wide: true, label: 'Chiedi a Claude' });

  const $m = (sel2) => m.querySelector(sel2);
  setTimeout(() => $m('#cl-req').focus(), 0);
  ctx.api.claude.status().then((st) => {
    if (!m.isConnected) return;
    $m('#cl-status').innerHTML = st.ok
      ? `<span class="ok">✓</span>Claude Code collegato al tuo account<small>${esc(st.exe || '')}</small>`
      : `<span class="ko">✕</span>${esc(st.error)}`;
    if (!st.ok) $m('#cl-go').disabled = true;
  }).catch(() => {});

  const cancelRun = async () => { if (taskId) { const id = taskId; taskId = null; await ctx.api.task.cancel(id); } };
  // Esc while Claude works: stop it, don't just hide the dialog.
  m.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); cancelRun(); closeModal(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !taskId && !$m('#cl-go').disabled && !$m('#cl-ask').classList.contains('hidden')) ask();
  });

  const showAsk = () => {
    $m('#cl-ask').classList.remove('hidden');
    $m('#cl-run').classList.add('hidden');
    $m('#cl-result').classList.add('hidden');
    $m('#cl-buttons').innerHTML = `<button class="btn big" id="cl-cancel">Annulla</button><button class="btn big pri" id="cl-go">Chiedi a Claude</button>`;
  };

  const showResult = (res) => {
    $m('#cl-run').classList.add('hidden');
    const r = $m('#cl-result');
    r.classList.remove('hidden');
    const s = res.stats;
    const rows = [
      ['Colonne di terreno rifatte', s.columns], ['…alzate', s.raised], ['…abbassate', s.lowered],
      ['Alberi', s.trees], ['Piante', s.plants], ['Altre modifiche', s.edits],
    ].filter(([, v]) => v > 0);
    r.innerHTML = `<div class="caps">Proposta di Claude · ${res.seconds} s · ${esc(res.model)}</div>
      <p class="cl-expl">${esc(res.explanation || '(nessuna spiegazione)')}</p>
      ${rows.length ? `<div class="sum">${rows.map(([k, v]) => `<div><span>${esc(k)}</span><b>${fmt(v)}</b></div>`).join('')}</div>` : '<p class="warnline">Claude non propone modifiche per questa richiesta.</p>'}
      ${res.warnings.map((x) => `<p class="warnline">${esc(x)}</p>`).join('')}
      <p class="hint" style="margin:10px 0 0">“Metti in sospeso” la aggiunge alle modifiche come una voce sola (⌘Z la toglie tutta) e la mappa si aggiorna. Il mondo si scrive solo con Applica, su una copia.</p>`;
    $m('#cl-buttons').innerHTML = `<button class="btn big" id="cl-again">Cambia la richiesta</button><button class="btn big" id="cl-cancel">Scarta</button><button class="btn big pri" id="cl-keep" ${res.op ? '' : 'disabled'}>Metti in sospeso</button>`;
    $m('#cl-keep').onclick = async () => {
      closeModal();
      await ctx.pushOp(res.op);
      toast('Modifiche di Claude in sospeso: guardale sulla mappa.', 'ok', { label: 'Annulla', run: () => ctx.undo() });
    };
  };

  const ask = async () => {
    const request = $m('#cl-req').value.trim();
    if (!request) { toast('Scrivi cosa vuoi che Claude faccia.', 'warn'); $m('#cl-req').focus(); return; }
    lastRequest.set(t.info.path, request);
    $m('#cl-ask').classList.add('hidden');
    $m('#cl-run').classList.remove('hidden');
    $m('#cl-buttons').innerHTML = '<button class="btn big" id="cl-cancel">Annulla</button>';
    taskId = newTaskId();
    const myTask = taskId;
    const bar = $m('.pb i');
    const off = ctx.api.task.onProgress((id, p) => {
      if (id !== myTask || !m.isConnected) return;
      if (p.phase === 'controllo') { $m('#cl-phase').textContent = 'Controllo Claude Code…'; bar.style.width = '2%'; }
      else if (p.phase === 'lettura') {
        $m('#cl-phase').textContent = 'Lettura dell\'area…';
        bar.style.width = `${Math.round(5 + (p.done / Math.max(1, p.total)) * 15)}%`;
      } else if (p.phase === 'claude') {
        $m('#cl-phase').textContent = `Claude ${CLAUDE_STEPS[p.step] || 'lavora…'}`;
        // No real percentage from Claude: the bar creeps towards 95% over a few minutes.
        bar.style.width = `${Math.round(20 + 75 * (1 - Math.exp(-p.seconds / 90)))}%`;
        $m('#cl-detail').textContent = `${p.seconds} s${p.chars ? ` · ${fmt(p.chars)} caratteri di risposta` : ''} · di solito 30 s – 3 min`;
      } else if (p.phase === 'compila') { $m('#cl-phase').textContent = 'Controllo la ricetta…'; bar.style.width = '98%'; }
    });
    try {
      const res = await ctx.api.claude.ask(t.id, { dim: t.dim, selection: sel, request, model }, myTask);
      off();
      if (taskId !== myTask || !m.isConnected) return;
      taskId = null;
      showResult(res);
    } catch (err) {
      off();
      if (taskId !== myTask) return; // cancelled from here
      taskId = null;
      if (!m.isConnected) return;
      showAsk();
      $m('#cl-status').innerHTML = `<span class="ko">✕</span>${esc(cleanError(err))}`;
    }
  };

  m.addEventListener('click', async (e) => {
    const ex = e.target.closest('[data-ex]');
    if (ex) { $m('#cl-req').value = ex.dataset.ex; $m('#cl-req').focus(); return; }
    const mb = e.target.closest('[data-model]');
    if (mb) {
      model = mb.dataset.model;
      m.querySelectorAll('[data-model]').forEach((x) => x.classList.toggle('on', x === mb));
      ctx.api.settings.set({ claudeModel: model }).catch(() => {});
      return;
    }
    const id = e.target.id;
    if (id === 'cl-go') ask();
    else if (id === 'cl-again') showAsk();
    else if (id === 'cl-cancel' || id === 'cl-x') {
      if (taskId) { await cancelRun(); showAsk(); toast('Richiesta a Claude annullata.', 'warn'); return; }
      closeModal();
    }
  });
}
