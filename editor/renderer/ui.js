/*
 * Small DOM helpers shared by the window's modules: escaping, icons from the
 * inline sprite, number formatting, toasts, dialogs and popovers.
 */

export const $ = (id) => document.getElementById(id);

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** An icon of the sprite in index.html (design icons: t-* tools, i-* commands, d-* dimensions). */
export const icon = (id, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true"><use href="#${id}"/></svg>`;

const nf = new Intl.NumberFormat('it-IT');
export const fmt = (n) => nf.format(n);
/** Minus sign as the design writes it (−64, not -64). */
export const signed = (n) => String(n).replace('-', '−');

export const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

export const cleanError = (err) => String((err && err.message) || err)
  .replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function toast(message, kind = 'ok', action = null) {
  const host = $('toast-host');
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.innerHTML = `<b>${kind === 'ok' ? '✓' : '!'}</b><span>${esc(message)}</span>${action ? `<button>${esc(action.label)}</button>` : ''}`;
  if (action) node.querySelector('button').onclick = () => { node.remove(); action.run(); };
  host.appendChild(node);
  setTimeout(() => node.remove(), kind === 'err' ? 7000 : 4200);
}

export async function guard(fn) {
  try { return await fn(); } catch (err) {
    toast(cleanError(err), 'err');
    return undefined;
  }
}

export function modal(html, { wide = false, label = '' } = {}) {
  const host = $('modal-host');
  host.innerHTML = `<div class="dlg${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(label)}">${html}</div>`;
  const el = host.firstElementChild;
  const first = el.querySelector('input, button.pri, button');
  if (first) setTimeout(() => first.focus(), 0);
  return el;
}

export const closeModal = () => { $('modal-host').innerHTML = ''; };
export const modalOpen = () => $('modal-host').children.length > 0;

/**
 * A searchable list anchored under an element. items: [{ id, label, swatch? }].
 * Resolves with the chosen id, or null.
 */
export function pickFrom(anchor, items, { placeholder = 'Cerca…', current = null, allowCustom = false } = {}) {
  return new Promise((resolve) => {
    const host = $('popover-host');
    const r = anchor.getBoundingClientRect();
    host.innerHTML = `<div class="popover" style="left:${Math.min(r.left, innerWidth - 310)}px;top:${r.bottom + 6}px">
      <input class="fld text" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}"><div class="list"></div></div>`;
    const pop = host.firstElementChild;
    const input = pop.querySelector('input');
    const list = pop.querySelector('.list');
    const done = (v) => { host.innerHTML = ''; document.removeEventListener('mousedown', outside, true); resolve(v); };
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      const shown = items.filter((i) => !q || i.label.toLowerCase().includes(q) || i.id.toLowerCase().includes(q)).slice(0, 200);
      list.innerHTML = shown.map((i) => `<button class="opt${i.id === current ? ' on' : ''}" data-id="${esc(i.id)}">${i.swatch ? `<i class="tile" style="background:${i.swatch}"></i>` : ''}<span>${esc(i.label)}</span></button>`).join('')
        + (allowCustom && q && !shown.some((i) => i.id === q) ? `<button class="opt" data-id="${esc(input.value.trim())}">Usa “${esc(input.value.trim())}”</button>` : '');
    };
    const outside = (e) => { if (!pop.contains(e.target)) done(null); };
    list.addEventListener('click', (e) => { const b = e.target.closest('[data-id]'); if (b) done(b.dataset.id); });
    input.addEventListener('input', draw);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') done(null);
      if (e.key === 'Enter') { const b = list.querySelector('[data-id]'); if (b) done(b.dataset.id); }
    });
    document.addEventListener('mousedown', outside, true);
    draw();
    input.focus();
  });
}

/** "6 min fa" for a timestamp. */
export function ago(t) {
  if (!t) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'ora';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min fa`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h fa`;
  return new Date(t).toLocaleDateString('it-IT');
}

export function whenText(ms) {
  const d = new Date(ms);
  const today = new Date();
  const time = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `oggi, ${time}`;
  return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
