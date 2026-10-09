/*
 * Everything drawn over the terrain tiles, on one canvas the size of the map:
 * the selection (fill + marching ants), shapes being drawn, the brush cursor,
 * the spawn, search hits and the chunk / region grids.
 *
 * The selection is drawn the way it is stored — as which block columns are in
 * it — sampled at the resolution of the screen: one sample per block when
 * zoomed in, one per N blocks when zoomed out, so any combination of shapes
 * (subtracted, intersected, inverted) draws correctly at any zoom.
 *
 * Overlay colours come from the design's tokens (--ov-*) and are the same in
 * both themes: a double light/dark outline reads on snow, sea, sand and Nether.
 */

import { chunkMask, selectionBounds } from '../core/selection.js';

const SEL_FILL = 'rgba(34,211,238,.16)';
const FIND = '#ff3d8b';
const MAX_CELLS = 1_600_000;

export class MapOverlay {
  constructor(map, canvas, getState) {
    this.map = map;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.getState = getState;
    this.maskCache = new Map();
    this.maskFor = null;
    this.ants = 0;
    this.selPath = null;
    this.selKey = '';
    map.on('move zoom resize viewreset', () => this.draw(true));
    new ResizeObserver(() => this.draw(true)).observe(canvas.parentElement);
    // Marching ants: only the dash offset moves, the outline path is reused.
    setInterval(() => {
      if (!this.selPath || document.hidden) return;
      this.ants = (this.ants + 1) % 14;
      this.draw(false);
    }, 110);
  }

  px(x, z) { return this.map.latLngToContainerPoint(L.latLng(-z, x)); }
  get scale() { return Math.pow(2, this.map.getZoom()); }

  mask(sel, cx, cz) {
    if (this.maskFor !== sel) { this.maskFor = sel; this.maskCache.clear(); }
    const k = `${cx},${cz}`;
    if (!this.maskCache.has(k)) this.maskCache.set(k, chunkMask(sel, cx, cz));
    return this.maskCache.get(k);
  }

  inside(sel, x, z) {
    const m = this.mask(sel, x >> 4, z >> 4);
    return !!m && m[(z & 15) * 16 + (x & 15)] === 1;
  }

  /** Rebuild the selection outline when the view or the selection changed. */
  buildSelection(sel) {
    const b = selectionBounds(sel);
    if (!b) { this.selPath = null; return; }
    const vb = this.map.getBounds();
    const view = {
      minX: Math.floor(vb.getWest()) - 1, maxX: Math.ceil(vb.getEast()) + 1,
      minZ: Math.floor(-vb.getNorth()) - 1, maxZ: Math.ceil(-vb.getSouth()) + 1,
    };
    const minX = Math.max(b.minX, view.minX), maxX = Math.min(b.maxX, view.maxX);
    const minZ = Math.max(b.minZ, view.minZ), maxZ = Math.min(b.maxZ, view.maxZ);
    if (minX > maxX || minZ > maxZ) { this.selPath = null; return; }
    let step = Math.max(1, Math.ceil(1 / this.scale));
    while (((maxX - minX) / step + 1) * ((maxZ - minZ) / step + 1) > MAX_CELLS) step *= 2;
    // Align the sampling grid to world coordinates so panning doesn't shimmer.
    const gx0 = Math.floor(minX / step) * step, gz0 = Math.floor(minZ / step) * step;
    const w = Math.floor((maxX - gx0) / step) + 1, h = Math.floor((maxZ - gz0) / step) + 1;
    const grid = new Uint8Array(w * h);
    const half = step >> 1;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) grid[j * w + i] = this.inside(sel, gx0 + i * step + half, gz0 + j * step + half) ? 1 : 0;
    }
    const fill = new Path2D();
    const edge = new Path2D();
    const at = (i, j) => (i < 0 || j < 0 || i >= w || j >= h ? 0 : grid[j * w + i]);
    const P = (x, z) => this.px(x, z);
    for (let j = 0; j < h; j++) {
      let run = -1;
      for (let i = 0; i <= w; i++) {
        const v = i < w ? grid[j * w + i] : 0;
        if (v && run < 0) run = i;
        if (!v && run >= 0) {
          const a = P(gx0 + run * step, gz0 + j * step), c = P(gx0 + i * step, gz0 + (j + 1) * step);
          fill.rect(a.x, a.y, c.x - a.x, c.y - a.y);
          run = -1;
        }
      }
    }
    // Horizontal edges (between rows) and vertical edges (between columns), merged into runs.
    for (let j = 0; j <= h; j++) {
      let run = -1;
      for (let i = 0; i <= w; i++) {
        const diff = i < w && at(i, j - 1) !== at(i, j);
        if (diff && run < 0) run = i;
        if (!diff && run >= 0) {
          const a = P(gx0 + run * step, gz0 + j * step), c = P(gx0 + i * step, gz0 + j * step);
          edge.moveTo(a.x, a.y); edge.lineTo(c.x, c.y);
          run = -1;
        }
      }
    }
    for (let i = 0; i <= w; i++) {
      let run = -1;
      for (let j = 0; j <= h; j++) {
        const diff = j < h && at(i - 1, j) !== at(i, j);
        if (diff && run < 0) run = j;
        if (!diff && run >= 0) {
          const a = P(gx0 + i * step, gz0 + run * step), c = P(gx0 + i * step, gz0 + j * step);
          edge.moveTo(a.x, a.y); edge.lineTo(c.x, c.y);
          run = -1;
        }
      }
    }
    this.selPath = { fill, edge };
  }

  draw(rebuild = true) {
    const { canvas, ctx } = this;
    const st = this.getState();
    const w = canvas.parentElement.clientWidth, h = canvas.parentElement.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
      rebuild = true;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!st.tab) { this.selPath = null; return; }

    if (st.grid) this.drawGrid(w, h);

    if (rebuild || this.selKey !== st.selKey) {
      this.selKey = st.selKey;
      this.buildSelection(st.selection);
    }
    if (this.selPath) {
      ctx.fillStyle = SEL_FILL;
      ctx.fill(this.selPath.fill);
      ctx.lineJoin = 'round';
      ctx.setLineDash([7, 7]);
      ctx.lineDashOffset = -this.ants;
      ctx.strokeStyle = '#000'; ctx.lineWidth = 3; ctx.stroke(this.selPath.edge);
      ctx.lineDashOffset = -this.ants - 7;
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke(this.selPath.edge);
      ctx.setLineDash([]);
    }

    if (st.draft) this.drawDraft(st.draft);
    if (st.spawn) this.drawSpawn(st.spawn);
    if (st.hits && st.hits.length) this.drawHits(st.hits, st.focusHit, st.hitChunks);
    if (st.cursor) this.drawCursor(st.cursor);
  }

  drawGrid(w, h) {
    const { ctx } = this;
    const s = this.scale;
    const vb = this.map.getBounds();
    const lines = (every, color, width) => {
      if (every * s < 6) return;
      ctx.beginPath();
      for (let x = Math.floor(vb.getWest() / every) * every; x <= vb.getEast(); x += every) {
        const p = this.px(x, 0).x; ctx.moveTo(p, 0); ctx.lineTo(p, h);
      }
      for (let z = Math.floor(-vb.getNorth() / every) * every; z <= -vb.getSouth(); z += every) {
        const p = this.px(0, z).y; ctx.moveTo(0, p); ctx.lineTo(w, p);
      }
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
    };
    lines(16, 'rgba(255,255,255,.2)', 1);
    lines(512, 'rgba(255,255,255,.45)', 1.5);
  }

  drawDraft(d) {
    const { ctx } = this;
    const outline = (path) => {
      ctx.fillStyle = d.fill || SEL_FILL; ctx.fill(path);
      ctx.setLineDash([7, 7]);
      ctx.strokeStyle = '#000'; ctx.lineWidth = 3; ctx.stroke(path);
      ctx.lineDashOffset = -7; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke(path);
      ctx.setLineDash([]); ctx.lineDashOffset = 0;
    };
    if (d.type === 'rect') {
      const a = this.px(Math.min(d.a[0], d.b[0]), Math.min(d.a[1], d.b[1]));
      const c = this.px(Math.max(d.a[0], d.b[0]) + 1, Math.max(d.a[1], d.b[1]) + 1);
      const p = new Path2D(); p.rect(a.x, a.y, c.x - a.x, c.y - a.y); outline(p);
    } else if (d.type === 'poly' || d.type === 'lasso') {
      const pts = d.hover ? [...d.points, d.hover] : d.points;
      if (!pts.length) return;
      const p = new Path2D();
      pts.forEach(([x, z], i) => { const q = this.px(x, z); if (i) p.lineTo(q.x, q.y); else p.moveTo(q.x, q.y); });
      if (d.type === 'lasso' || pts.length > 2) p.closePath();
      outline(p);
      if (d.type === 'poly') {
        ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
        for (const [x, z] of d.points) { const q = this.px(x, z); ctx.fillRect(q.x - 5, q.y - 5, 10, 10); ctx.strokeRect(q.x - 5, q.y - 5, 10, 10); }
      }
    } else if (d.type === 'stroke') {
      // One thick round-capped line: translucent, without darker overlaps.
      ctx.beginPath();
      d.points.forEach(([x, z], i) => { const q = this.px(x, z); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); });
      if (d.points.length === 1) { const q = this.px(d.points[0][0], d.points[0][1]); ctx.lineTo(q.x + 0.01, q.y); }
      ctx.lineWidth = Math.max(2, d.r * 2 * this.scale);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = d.fill || SEL_FILL;
      ctx.stroke();
      ctx.lineCap = 'butt';
    }
  }

  drawCursor(c) {
    const { ctx } = this;
    const q = this.px(c.x, c.z);
    const r = Math.max(3, c.r * this.scale);
    ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = '#000'; ctx.lineWidth = 3; ctx.stroke();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.2; ctx.stroke();
    if (c.color) { ctx.fillStyle = c.color; ctx.globalAlpha = 0.35; ctx.fill(); ctx.globalAlpha = 1; }
  }

  drawSpawn(sp) {
    const { ctx } = this;
    const q = this.px(sp.x + 0.5, sp.z + 0.5);
    const r = Math.max(10, (sp.radius || 0) * this.scale);
    ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,.1)'; ctx.fill();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = '#000'; ctx.lineWidth = 3; ctx.stroke();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.setLineDash([]);
    // The design's 16x16 pixel flag, 24 px tall, foot on the spawn.
    const k = 1.5, ox = q.x - 3 * k, oy = q.y - 15 * k;
    const px = (color, rects) => { ctx.fillStyle = color; for (const [x, y, w, h] of rects) ctx.fillRect(ox + x * k, oy + y * k, w * k, h * k); };
    px('#000', [[2, 1, 2, 14], [4, 1, 10, 7]]);
    px('#fff', [[3, 2, 1, 12]]);
    px('#ee6a62', [[4, 2, 9, 1], [4, 3, 8, 1], [4, 4, 9, 1], [4, 5, 8, 1], [4, 6, 7, 1]]);
  }

  /**
   * Search hits: a ring per hit when there are few; when there are many, a
   * tinted square per chunk (darker = more hits) — rings would pile up into
   * one blob — plus the ring of the hit picked in the list.
   */
  drawHits(hits, focus, chunks) {
    const { ctx } = this;
    const vb = this.map.getBounds();
    const visible = (x, z, pad) => !(x < vb.getWest() - pad || x > vb.getEast() + pad || -z > vb.getNorth() + pad || -z < vb.getSouth() - pad);
    const ring = (h, big) => {
      const q = this.px(h.x + 0.5, h.z + 0.5);
      ctx.beginPath(); ctx.arc(q.x, q.y, big ? 14 : 7, 0, Math.PI * 2);
      ctx.lineWidth = 6; ctx.strokeStyle = '#000'; ctx.stroke();
      ctx.lineWidth = 4.5; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.lineWidth = 3; ctx.strokeStyle = FIND; ctx.stroke();
    };
    if (hits.length > 150 && chunks && chunks.length) {
      const max = Math.max(...chunks.map((c) => c.n));
      for (const c of chunks) {
        if (!visible(c.cx * 16 + 8, c.cz * 16 + 8, 24)) continue;
        const a = this.px(c.cx * 16, c.cz * 16), b = this.px(c.cx * 16 + 16, c.cz * 16 + 16);
        ctx.fillStyle = `rgba(255,61,139,${(0.18 + 0.5 * Math.sqrt(c.n / max)).toFixed(3)})`;
        ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
        if (b.x - a.x > 6) { ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = 1; ctx.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x - 1, b.y - a.y - 1); }
      }
      if (focus) ring(focus, true);
      return;
    }
    for (const h of hits) if (visible(h.x, h.z, 2)) ring(h, h === focus);
  }
}

/** A round length in blocks for a scale bar about `px` pixels wide. */
export function scaleBar(scale, px = 150) {
  const raw = px / scale;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const nice = [1, 2, 5, 10].map((m) => m * p).filter((v) => v <= raw).pop() || p;
  return { blocks: nice, width: nice * scale };
}
