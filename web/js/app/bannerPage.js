/*
 * Cube-Atlas — Stemmi: standalone banner builder. Self-contained (no shared
 * app state/IndexedDB) since it's a one-off tool, not part of the
 * world/project workflow the rest of the app is built around.
 */

import {
  DYES, PATTERNS, dyeById, patternById, exportBanner, MAX_PATTERNS,
} from '../core/banner.js';

const el = (id) => document.getElementById(id);

const state = {
  baseColor: 'white',
  layers: [], // { pattern, color }
};

// ------------------------------------------------------------------ toast
let toastTimer = null;
function toast(message, kind) {
  const host = el('toast-host');
  const node = document.createElement('div');
  node.className = `toast ${kind || ''}`;
  node.textContent = message;
  host.appendChild(node);
  clearTimeout(toastTimer);
  setTimeout(() => node.remove(), 3200);
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime || 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --------------------------------------------------------- base colour ui
function renderBaseColors() {
  const host = el('base-color-grid');
  host.innerHTML = DYES.map((d) => (
    `<button class="swatch ${d.id === state.baseColor ? 'selected' : ''}" data-color="${d.id}" style="background:${d.hex}" title="${d.label}"></button>`
  )).join('');
  host.querySelectorAll('.swatch').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.baseColor = btn.dataset.color;
      renderBaseColors();
      refresh();
    });
  });
}

// ------------------------------------------------------------ pattern ui
function patternOptionsHtml(selected) {
  return PATTERNS.map((p) => (
    `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${p.label}${p.craftable === false ? ' ⚠' : ''}</option>`
  )).join('');
}

function colorOptionsHtml(selected) {
  return DYES.map((d) => (
    `<option value="${d.id}" ${d.id === selected ? 'selected' : ''}>${d.label}</option>`
  )).join('');
}

let dragIndex = null;

function renderPatternList() {
  el('pattern-count').textContent = `(${state.layers.length}/${MAX_PATTERNS})`;
  const host = el('pattern-list');
  if (!state.layers.length) {
    host.innerHTML = '<li class="pattern-empty">Nessun disegno ancora: aggiungine uno qui sotto.</li>';
  } else {
    host.innerHTML = state.layers.map((l, i) => `
      <li class="pattern-row" draggable="true" data-i="${i}">
        <span class="drag-handle" title="Trascina per riordinare">⠿</span>
        <select data-role="pattern" data-i="${i}">${patternOptionsHtml(l.pattern)}</select>
        <input type="color" class="p-swatch" data-role="color" data-i="${i}" value="${dyeById(l.color).hex}" title="Colore">
        <select data-role="colorname" data-i="${i}" style="max-width:74px">${colorOptionsHtml(l.color)}</select>
        <span class="p-kill" data-role="kill" data-i="${i}" title="Rimuovi">🗑</span>
      </li>`).join('');
  }

  host.querySelectorAll('select[data-role="pattern"]').forEach((sel) => {
    sel.addEventListener('change', () => {
      state.layers[Number(sel.dataset.i)].pattern = sel.value;
      refresh();
    });
  });
  host.querySelectorAll('select[data-role="colorname"]').forEach((sel) => {
    sel.addEventListener('change', () => {
      state.layers[Number(sel.dataset.i)].color = sel.value;
      refresh();
    });
  });
  host.querySelectorAll('input[data-role="color"]').forEach((input) => {
    input.addEventListener('input', () => {
      // Snap the picked colour to the nearest dye so it stays a legal banner colour.
      const nearest = nearestDye(input.value);
      state.layers[Number(input.dataset.i)].color = nearest.id;
      refresh();
    });
  });
  host.querySelectorAll('.p-kill').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.layers.splice(Number(btn.dataset.i), 1);
      refresh();
    });
  });

  host.querySelectorAll('.pattern-row').forEach((row) => {
    row.addEventListener('dragstart', () => {
      dragIndex = Number(row.dataset.i);
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    row.addEventListener('dragover', (e) => e.preventDefault());
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const targetIndex = Number(row.dataset.i);
      if (dragIndex === null || dragIndex === targetIndex) return;
      const [moved] = state.layers.splice(dragIndex, 1);
      state.layers.splice(targetIndex, 0, moved);
      dragIndex = null;
      refresh();
    });
  });
}

function nearestDye(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  let best = DYES[0];
  let bestDist = Infinity;
  for (const d of DYES) {
    const dr = parseInt(d.hex.slice(1, 3), 16) - r;
    const dg = parseInt(d.hex.slice(3, 5), 16) - g;
    const db = parseInt(d.hex.slice(5, 7), 16) - b;
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) { bestDist = dist; best = d; }
  }
  return best;
}

function addPattern() {
  if (state.layers.length >= MAX_PATTERNS) { toast(`Massimo ${MAX_PATTERNS} disegni per stendardo`, 'err'); return; }
  state.layers.push({ pattern: 'border', color: state.baseColor === 'white' ? 'black' : 'white' });
  refresh();
}

// ------------------------------------------------------------------ canvas
// Approximate renders of each pattern, drawn as flat fractions of the
// banner's 20×40 cloth grid — visually close to the game's masks, not a
// pixel-perfect reproduction of them.
function drawPattern(ctx, w, h, id, color) {
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  const rect = (x, y, rw, rh) => ctx.fillRect(x * w, y * h, rw * w, rh * h);
  switch (id) {
    case 'stripe_bottom': rect(0, 0.8, 1, 0.2); break;
    case 'stripe_top': rect(0, 0, 1, 0.2); break;
    case 'stripe_left': rect(0, 0, 0.2, 1); break;
    case 'stripe_right': rect(0.8, 0, 0.2, 1); break;
    case 'stripe_center': rect(0.4, 0, 0.2, 1); break;
    case 'stripe_middle': rect(0, 0.4, 1, 0.2); break;
    case 'small_stripes':
      for (let i = 0; i < 4; i++) rect(i * 0.25 + 0.02, 0, 0.14, 1);
      break;
    case 'stripe_downright': diagonalBand(ctx, w, h, true); break;
    case 'stripe_downleft': diagonalBand(ctx, w, h, false); break;
    case 'cross':
      diagonalBand(ctx, w, h, true);
      diagonalBand(ctx, w, h, false);
      break;
    case 'straight_cross': rect(0.4, 0, 0.2, 1); rect(0, 0.4, 1, 0.2); break;
    case 'triangle_bottom': triangle(ctx, w, h, [0.5, 0.4], [0, 1], [1, 1]); break;
    case 'triangle_top': triangle(ctx, w, h, [0.5, 0.6], [0, 0], [1, 0]); break;
    case 'triangles_bottom':
      for (let i = 0; i < 4; i++) triangle(ctx, w, h, [i * 0.25 + 0.125, 0.75], [i * 0.25, 1], [i * 0.25 + 0.25, 1]);
      break;
    case 'triangles_top':
      for (let i = 0; i < 4; i++) triangle(ctx, w, h, [i * 0.25 + 0.125, 0.25], [i * 0.25, 0], [i * 0.25 + 0.25, 0]);
      break;
    case 'diagonal_left': triangle(ctx, w, h, [0, 0], [1, 0], [0, 1]); break;
    case 'diagonal_right': triangle(ctx, w, h, [1, 0], [1, 1], [0, 0]); break;
    case 'diagonal_up_left': triangle(ctx, w, h, [0, 1], [0, 0], [1, 1]); break;
    case 'diagonal_up_right': triangle(ctx, w, h, [1, 1], [1, 0], [0, 1]); break;
    case 'circle':
      ctx.beginPath(); ctx.ellipse(w / 2, h * 0.4, w * 0.28, w * 0.28, 0, 0, Math.PI * 2); ctx.fill();
      break;
    case 'rhombus':
      diamond(ctx, w, h, 0.5, 0.4, 0.3, 0.24);
      break;
    case 'half_vertical': rect(0, 0, 0.5, 1); break;
    case 'half_vertical_right': rect(0.5, 0, 0.5, 1); break;
    case 'half_horizontal': rect(0, 0, 1, 0.5); break;
    case 'half_horizontal_bottom': rect(0, 0.5, 1, 0.5); break;
    case 'border':
      rect(0, 0, 1, 0.06); rect(0, 0.94, 1, 0.06); rect(0, 0, 0.06, 1); rect(0.94, 0, 0.06, 1);
      break;
    case 'curly_border':
      ctx.save(); ctx.setLineDash([w * 0.06, w * 0.04]); ctx.lineWidth = h * 0.05;
      ctx.strokeRect(h * 0.03, h * 0.03, w - h * 0.06, h - h * 0.06);
      ctx.restore();
      break;
    case 'gradient': {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, 'transparent'); g.addColorStop(1, color);
      ctx.fillStyle = g; rect(0, 0, 1, 1);
      break;
    }
    case 'gradient_up': {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, color); g.addColorStop(1, 'transparent');
      ctx.fillStyle = g; rect(0, 0, 1, 1);
      break;
    }
    case 'bricks':
      ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = Math.max(1, h * 0.012);
      for (let row = 0; row < 5; row++) {
        const y = row * 0.2 * h;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
        const offset = row % 2 ? w / 2 : 0;
        for (let x = offset; x < w; x += w / 2) {
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 0.2 * h); ctx.stroke();
        }
      }
      ctx.restore();
      break;
    default:
      // Icon-style charges (globe, creeper, skull, flower, mojang, piglin,
      // flow, guster) — no faithful mask, just a centred blob as a stand-in.
      ctx.beginPath(); ctx.roundRect
        ? ctx.roundRect(w * 0.3, h * 0.28, w * 0.4, h * 0.24, 4)
        : ctx.rect(w * 0.3, h * 0.28, w * 0.4, h * 0.24);
      ctx.fill();
  }
}

function diagonalBand(ctx, w, h, downRight) {
  const bandW = w * 0.22;
  ctx.save();
  ctx.beginPath();
  if (downRight) {
    ctx.moveTo(0, 0); ctx.lineTo(bandW, 0); ctx.lineTo(w, h - bandW); ctx.lineTo(w, h); ctx.lineTo(w - bandW, h); ctx.lineTo(0, bandW);
  } else {
    ctx.moveTo(w, 0); ctx.lineTo(w - bandW, 0); ctx.lineTo(0, h - bandW); ctx.lineTo(0, h); ctx.lineTo(bandW, h); ctx.lineTo(w, bandW);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function triangle(ctx, w, h, a, b, c) {
  ctx.beginPath();
  ctx.moveTo(a[0] * w, a[1] * h);
  ctx.lineTo(b[0] * w, b[1] * h);
  ctx.lineTo(c[0] * w, c[1] * h);
  ctx.closePath();
  ctx.fill();
}

function diamond(ctx, w, h, cx, cy, rx, ry) {
  ctx.beginPath();
  ctx.moveTo(cx * w, (cy - ry) * h);
  ctx.lineTo((cx + rx) * w, cy * h);
  ctx.lineTo(cx * w, (cy + ry) * h);
  ctx.lineTo((cx - rx) * w, cy * h);
  ctx.closePath();
  ctx.fill();
}

function drawBanner() {
  const canvas = el('banner-canvas');
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Cloth base + the little pole flap at the bottom.
  ctx.fillStyle = dyeById(state.baseColor).hex;
  ctx.fillRect(0, 0, w, h * 0.88);
  ctx.fillRect(w * 0.4, h * 0.88, w * 0.2, h * 0.12);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h * 0.88);
  ctx.clip();
  for (const layer of state.layers) {
    drawPattern(ctx, w, h * 0.88, patternById(layer.pattern).id, dyeById(layer.color).hex);
  }
  ctx.restore();
}

// -------------------------------------------------------------- command
function refresh() {
  renderPatternList();
  drawBanner();

  const result = exportBanner({ baseColor: state.baseColor, patterns: state.layers, count: el('banner-count').value });
  const modern = el('banner-version').value === 'modern';
  el('banner-command').textContent = modern ? result.commandModern : result.command;

  const nonCraftable = state.layers.filter((l) => patternById(l.pattern).craftable === false);
  el('craftable-warning').textContent = nonCraftable.length
    ? `⚠ ${nonCraftable.map((l) => patternById(l.pattern).label).join(', ')} non si ottiene tingendo in sopravvivenza: il comando funziona comunque, ma serve creativa o l'oggetto speciale corrispondente.`
    : '';

  window._bannerExport = result;
}

async function copyCommand() {
  const text = el('banner-command').textContent;
  if (!text || text === '—') return;
  try {
    await navigator.clipboard.writeText(text);
    toast('Comando copiato', 'ok');
  } catch {
    const range = document.createRange();
    range.selectNodeContents(el('banner-command'));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    toast('Seleziona e copia manualmente (Ctrl/Cmd+C)', 'err');
  }
}

function downloadMcfunction() {
  const result = window._bannerExport;
  if (!result) return;
  const modern = el('banner-version').value === 'modern';
  download('banner.mcfunction', modern ? result.mcfunction : result.mcfunctionLegacy, 'text/plain');
  toast('.mcfunction scaricato', 'ok');
}

// ---------------------------------------------------------------- init
function init() {
  renderBaseColors();
  refresh();

  el('btn-add-pattern').addEventListener('click', addPattern);
  el('banner-version').addEventListener('change', refresh);
  el('banner-count').addEventListener('input', refresh);
  el('btn-copy-cmd').addEventListener('click', copyCommand);
  el('btn-download-mcfunction').addEventListener('click', downloadMcfunction);
}

document.addEventListener('DOMContentLoaded', init);
