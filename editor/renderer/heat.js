/*
 * The Free space heat layer as an image: one pixel per chunk (or per N×N
 * chunks for a world wider than 4096 chunks), coloured by what the plan does
 * with it and, for the chunks that stay, by the time spent there.
 */

// STATE in core/freeSpace.js: KEEP, DELETE, MARGIN, EXCLUDED, OUT, ORPHAN.
export const STATE_COLORS = {
  1: [238, 106, 98, 135],
  2: [242, 177, 59, 100],
  3: [34, 211, 238, 110],
};
const MAX_SIDE = 4096;
// The time scale tops at 10 hours.
const LOG_TOP = Math.log10(36000 + 1);

export function heatImage(heat) {
  const n = heat.cx.length;
  if (!n) return null;
  let minCx = Infinity, minCz = Infinity, maxCx = -Infinity, maxCz = -Infinity;
  for (let i = 0; i < n; i++) {
    if (heat.cx[i] < minCx) minCx = heat.cx[i];
    if (heat.cx[i] > maxCx) maxCx = heat.cx[i];
    if (heat.cz[i] < minCz) minCz = heat.cz[i];
    if (heat.cz[i] > maxCz) maxCz = heat.cz[i];
  }
  const step = Math.max(1, Math.ceil(Math.max(maxCx - minCx + 1, maxCz - minCz + 1) / MAX_SIDE));
  const w = Math.floor((maxCx - minCx) / step) + 1;
  const h = Math.floor((maxCz - minCz) / step) + 1;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const g = canvas.getContext('2d');
  const data = g.createImageData(w, h);
  const px = data.data;
  // With several chunks per pixel, "deleted" wins only if nothing there stays.
  const rank = (s) => (s === 1 ? 1 : s === 0 ? 4 : s === 2 ? 3 : s === 3 ? 2 : 0);
  const best = new Uint8Array(w * h);
  for (let i = 0; i < n; i++) {
    const s = heat.state[i];
    if (s === 4) continue;
    const j = Math.floor((heat.cz[i] - minCz) / step) * w + Math.floor((heat.cx[i] - minCx) / step);
    if (rank(s) < best[j]) continue;
    best[j] = rank(s);
    let c = STATE_COLORS[s];
    if (!c) {
      const t = Math.min(1, Math.log10(heat.seconds[i] + 1) / LOG_TOP);
      c = [Math.round(98 - 58 * t), Math.round(184 - 64 * t), Math.round(76 - 36 * t), Math.round(25 + 125 * t)];
    }
    px.set(c, j * 4);
  }
  g.putImageData(data, 0, 0);
  return { canvas, minCx, minCz, w, h, step };
}
