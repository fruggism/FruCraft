/*
 * Libera spazio: the panel of the "Libera spazio" tool. It asks the main
 * process to read the world once (in a worker), then every change of the
 * criteria asks for a new plan — numbers and the heat layer of the map —
 * and "Metti in sospeso" puts the plan in the journal like any other change.
 * Nothing is deleted before Apply, and Apply works on the copy.
 */

import { esc, fmt, toast, cleanError, icon } from './ui.js';

const SECONDS = [[10, '10 secondi'], [60, '1 minuto'], [300, '5 minuti'], [900, '15 minuti'], [3600, '1 ora']];

export const freeState = {
  criteria: {
    dims: null, inhabited: true, seconds: 60, blocks: true, blockEntities: true, margin: 2,
    emptyRegions: true, orphanMcc: true, orphanChunks: true, compact: true, legacy: false,
  },
  excludeSelection: true,    // the active selection is never touched
  excludeSaved: [],          // names of saved selections never touched
};

/** "312 MB", "1,4 GB", "820 kB". */
export function bytesText(n) {
  const v = Math.max(0, n);
  if (v >= 1e9) return `${(v / 1e9).toFixed(1).replace('.', ',')} GB`;
  if (v >= 1e6) return `${Math.round(v / 1e6)} MB`;
  if (v >= 1e3) return `${Math.round(v / 1e3)} kB`;
  return `${v} byte`;
}

export function timeText(sec) {
  if (sec < 1) return 'mai';
  if (sec < 60) return `${Math.round(sec)} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  const h = sec / 3600;
  return `${h < 10 ? h.toFixed(1).replace('.', ',') : Math.round(h)} h`;
}

const newTaskId = () => `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export function createFreeSpace(ctx) {
  let planTimer = null;
  let planSerial = 0;

  /** The criteria as the main process wants them, with the excluded areas. */
  const criteria = (t) => {
    const exclude = [];
    if (freeState.excludeSelection && ctx.hasSelection()) exclude.push({ dim: t.dim, sel: ctx.selection() });
    for (const s of ctx.savedSelections(t)) if (freeState.excludeSaved.includes(s.name)) exclude.push({ dim: s.dim, sel: s.sel });
    return { ...freeState.criteria, exclude };
  };

  async function scan() {
    const t = ctx.tab();
    if (!t || (t.free && t.free.running)) return;
    const taskId = newTaskId();
    t.free = { running: taskId, progress: 0, summary: null, plan: null };
    ctx.renderPanel();
    const off = ctx.api.task.onProgress((id, p) => {
      if (id !== taskId || !t.free) return;
      t.free.progress = p.done / Math.max(1, p.total);
      const bar = document.querySelector('#panel-body .pb i');
      if (bar) bar.style.width = `${Math.round(t.free.progress * 100)}%`;
    });
    try {
      const summary = await ctx.api.free.scan(t.id, taskId);
      if (!t.free || t.free.running !== taskId) return;
      t.free = { running: null, summary, plan: null };
      await replan(t);
    } catch (err) {
      if (t.free && t.free.running === taskId) t.free = null;
      if (!/Annullato/.test(cleanError(err))) toast(cleanError(err), 'err');
    } finally {
      off();
      ctx.renderPanel();
      ctx.redraw();
    }
  }

  function cancel() {
    const t = ctx.tab();
    if (t && t.free && t.free.running) { ctx.api.task.cancel(t.free.running); t.free = null; ctx.renderPanel(); }
  }

  async function replan(t = ctx.tab()) {
    if (!t || !t.free || !t.free.summary) return;
    const serial = ++planSerial;
    try {
      const plan = await ctx.api.free.plan(t.id, criteria(t), t.dim);
      if (serial !== planSerial || !t.free) return;
      t.free.plan = plan;
      t.free.lookup = null;
    } catch (err) {
      // The world changed under the scan (a change was made): read it again.
      t.free = null;
      if (!/analizza/i.test(cleanError(err))) toast(cleanError(err), 'err');
    }
    if (ctx.tab() === t) { ctx.renderPanel(); ctx.redraw(); }
  }

  /** After a click on a criterion: redraw the switches now, the numbers when the plan comes. */
  function changed() {
    ctx.renderPanel();
    clearTimeout(planTimer);
    planTimer = setTimeout(() => replan(), 120);
  }

  async function push() {
    const t = ctx.tab();
    if (!t || !t.free || !t.free.plan) return;
    if (!t.free.plan.bytes.total) { toast('Con questi criteri non si libera niente.', 'warn'); return; }
    const res = await ctx.guard(() => ctx.api.free.push(t.id, criteria(t)));
    if (!res) return;
    const freed = t.free.plan.bytes.total;
    t.free = null;
    ctx.afterJournal(t, res);
    toast(`In sospeso: si liberano ${bytesText(freed)} quando premi Applica (nella copia).`);
  }

  const sw = (key, on, label, disabled = false) => `<button class="sw${on ? ' on' : ''}" data-free="${key}" role="switch" aria-checked="${on}" aria-label="${esc(label)}" ${disabled ? 'disabled' : ''}></button>`;
  const row = (key, on, label, hint = '', disabled = false) => `<div class="row"><span${hint ? ` title="${esc(hint)}"` : ''}>${label}</span>${sw(key, on, label.replace(/<[^>]+>/g, ''), disabled)}</div>`;

  function html(t) {
    const f = t.free;
    const c = freeState.criteria;
    const intro = `<div class="sec"><div class="caps sh">Libera spazio</div>
      <p class="hint" style="margin:0 0 10px">Elimina i chunk dove non vai mai e dove non c'è niente di costruito: il gioco li rigenera uguali dal seme quando ci torni. Più i file che non servono. Tutto resta in sospeso; Applica lo fa nella copia.</p>`;
    if (!f || (!f.summary && !f.running)) {
      return `${intro}<div class="actions"><button class="btn pri" data-act="freescan" ${t.info.readOnly ? 'disabled' : ''}>Analizza il mondo</button></div>
        <p class="hint" style="margin:10px 0 0">Legge una volta tutti i chunk (su un mondo di qualche GB ci vuole circa un minuto).</p></div>`;
    }
    if (f.running) {
      return `${intro}<div class="caps sh">Analizzo i chunk…</div><div class="pb"><i style="width:${Math.round((f.progress || 0) * 100)}%"></i></div>
        <div class="actions" style="margin-top:10px"><button class="btn" data-act="freecancel">Annulla</button></div></div>`;
    }
    const p = f.plan;
    const dims = f.summary.dims;
    const dimOn = (id) => !c.dims || c.dims.includes(id);
    const saved = ctx.savedSelections(t);
    const legacy = f.summary.legacy || [];
    const b = p ? p.bytes : null;
    const line = (label, v, n) => (v ? `<div class="row"><span>${label}${n ? ` <span class="hint">· ${fmt(n)}</span>` : ''}</span><span class="v mono">${bytesText(v)}</span></div>` : '');
    const total = p ? `
      <div class="sec"><div class="caps sh">Si liberano</div>
        <div class="row"><span class="cnt mono" style="font-size:22px">${bytesText(b.total)}</span><span class="v">${fmt(p.counts.chunks)} chunk</span></div>
        ${line('Chunk eliminati (terreno)', b.chunks, p.counts.chunks)}
        ${line('Entità e punti di interesse', b.side, p.counts.side)}
        ${line('Entità e POI senza terreno', b.orphans, p.counts.orphans)}
        ${line('Buchi nei file (compattazione)', b.compact, p.counts.filesRewritten)}
        ${line('Region vuote', b.empty, p.counts.emptyFiles)}
        ${line('File .mcc orfani', b.mcc, p.counts.mcc)}
        ${line('Cartelle non usate', b.legacy, p.counts.legacy)}
        ${p.counts.emptyFiles && !b.empty ? `<div class="row"><span>Region vuote <span class="hint">· ${fmt(p.counts.emptyFiles)}</span></span><span class="v mono">0 byte</span></div>` : ''}
        ${p.perDim.filter((d) => dimOn(d.id)).map((d) => `<div class="row"><span class="hint">${esc(d.label)}</span><span class="v mono">${fmt(d.deleted)} di ${fmt(d.chunks)} chunk</span></div>`).join('')}
        <div class="actions" style="margin-top:10px"><button class="btn pri" data-act="freepush" ${b.total > 0 && !t.info.readOnly ? '' : 'disabled'}>Metti in sospeso</button><button class="btn" data-act="freescan">Analizza di nuovo</button></div>
      </div>
      <div class="sec"><div class="caps sh">Sulla mappa</div>
        <div class="legend-row"><i class="tile" style="background:rgba(238,106,98,.55)"></i>si elimina</div>
        <div class="legend-row"><i class="tile" style="background:rgba(242,177,59,.45)"></i>resta per il margine</div>
        <div class="legend-row"><i class="tile" style="background:rgba(34,211,238,.45)"></i>escluso o con modifiche in sospeso</div>
        <div class="legend-row"><i class="tile" style="background:linear-gradient(90deg,rgba(98,184,76,.15),rgba(40,120,40,.6))"></i>resta: più scuro = più tempo passato lì</div>
      </div>` : '<div class="sec"><p class="hint">Calcolo…</p></div>';
    return `${intro}</div>
      <div class="sec"><div class="caps sh">Chunk da eliminare</div>
        <div class="row"><span>Tempo passato lì meno di</span><span style="display:flex;gap:6px;align-items:center"><select class="fld" id="free-seconds" ${c.inhabited ? '' : 'disabled'}>${SECONDS.map(([v, l]) => `<option value="${v}" ${Number(c.seconds) === v ? 'selected' : ''}>${l}</option>`).join('')}</select>${sw('inhabited', c.inhabited, 'Tempo passato lì')}</span></div>
        ${row('blocks', c.blocks, 'Niente di costruito', 'Solo blocchi naturali: niente assi, vetro, torce… né cornici, supporti, barche o animali con nome. Anche villaggi e miniere contano come costruiti.')}
        ${row('blockEntities', c.blockEntities, 'Nessun contenitore o block entity', 'Casse, cartelli, fornaci, spawner: anche quelli generati dal gioco')}
        <div class="row"><span title="Chunk tenuti attorno a quelli che restano, perché il terreno rigenerato non faccia uno scalino accanto alle costruzioni">Margine attorno a ciò che resta</span><span style="display:flex;gap:6px;align-items:center"><input type="range" id="free-margin" min="0" max="8" value="${c.margin}" style="width:90px"><span class="mono" style="width:56px;text-align:right">${c.margin} chunk</span></span></div>
        ${dims.length > 1 ? dims.map((d) => row(`dim:${d.id}`, dimOn(d.id), esc(d.label))).join('') : ''}
        ${!c.inhabited && !c.blocks && !c.blockEntities ? '<p class="warnline">Accendi almeno un criterio: senza, nessun chunk viene eliminato.</p>' : ''}
      </div>
      <div class="sec"><div class="caps sh">Non toccare</div>
        ${row('excludeSelection', freeState.excludeSelection && ctx.hasSelection(), 'La selezione attiva', '', !ctx.hasSelection())}
        ${saved.length ? saved.map((s) => row(`saved:${s.name}`, freeState.excludeSaved.includes(s.name), `${esc(s.name)} <span class="hint">· ${esc(dims.find((d) => d.id === s.dim)?.label || s.dim)}</span>`)).join('') : '<p class="hint" style="margin:0">Le selezioni salvate compaiono qui.</p>'}
      </div>
      <div class="sec"><div class="caps sh">Altro spazio</div>
        ${row('emptyRegions', c.emptyRegions, 'Region vuote')}
        ${row('orphanMcc', c.orphanMcc, 'File .mcc orfani', 'Chunk enormi salvati a parte che nessuna region usa più')}
        ${row('orphanChunks', c.orphanChunks, 'Entità e POI senza terreno', 'Chunk di entities/ e poi/ il cui chunk di terreno non c\'è')}
        ${row('compact', c.compact, 'Compatta i file', 'Riscrive le region senza i buchi che il gioco lascia quando un chunk cambia dimensione')}
        ${row('legacy', c.legacy && legacy.length > 0, `Cartelle non usate${legacy.length ? ` <span class="hint">· ${legacy.map((l) => esc(l.rel)).join(', ')}</span>` : ''}`, legacy.length ? 'Cartelle del vecchio formato (region/, DIM-1/, DIM1/) che un mondo 26.x non legge più' : 'Nessuna in questo mondo', !legacy.length)}
      </div>
      ${total}
      <div class="sec"><div class="safe-note">${icon('i-shield')}<span>Un chunk eliminato torna com'era all'origine dal seme del mondo: perdi le modifiche fatte lì e ritrovi il terreno della versione attuale. L'originale non si tocca.</span></div></div>`;
  }

  function click(key, el) {
    const t = ctx.tab();
    if (!t) return;
    const c = freeState.criteria;
    if (key.startsWith('dim:')) {
      const id = key.slice(4);
      const all = t.free.summary.dims.map((d) => d.id);
      const on = new Set(c.dims || all);
      if (on.has(id)) on.delete(id); else on.add(id);
      c.dims = on.size === all.length ? null : [...on];
    } else if (key.startsWith('saved:')) {
      const name = key.slice(6);
      freeState.excludeSaved = freeState.excludeSaved.includes(name) ? freeState.excludeSaved.filter((x) => x !== name) : [...freeState.excludeSaved, name];
    } else if (key === 'excludeSelection') freeState.excludeSelection = !el.classList.contains('on');
    else c[key] = !c[key];
    changed();
  }

  function input(el) {
    if (el.id === 'free-margin') { freeState.criteria.margin = Number(el.value); el.nextElementSibling.textContent = `${el.value} chunk`; clearTimeout(planTimer); planTimer = setTimeout(() => replan(), 150); return true; }
    if (el.id === 'free-seconds') { freeState.criteria.seconds = Number(el.value); changed(); return true; }
    return false;
  }

  /** Time spent and fate of the chunk under the cursor, for the status bar. */
  function at(t, cx, cz) {
    const p = t && t.free && t.free.plan;
    if (!p) return null;
    if (!t.free.lookup) {
      const m = new Map();
      for (let i = 0; i < p.heat.cx.length; i++) m.set(`${p.heat.cx[i]},${p.heat.cz[i]}`, i);
      t.free.lookup = m;
    }
    const i = t.free.lookup.get(`${cx},${cz}`);
    if (i === undefined) return null;
    return { seconds: p.heat.seconds[i], state: p.heat.state[i] };
  }

  return { scan, cancel, replan, push, html, click, input, at };
}
