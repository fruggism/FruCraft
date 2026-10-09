/*
 * Surveying an area for "Ask Claude": what the ground looks like, column by
 * column, read through the overlay (pending changes included), and a compact
 * text description of it for the prompt.
 *
 * The survey is plain typed arrays over the selection's bounding box, row by
 * row (z outer); unselected columns are marked. recipe.js reshapes it.
 */

import { walkChunks } from './search.js';
import { selectionBounds } from './selection.js';
import { dimensionInfo } from './dimensions.js';
import { readColumn, KEEP } from './terrain.js';

/** Largest side of an area Claude can be asked about, in blocks. */
export const MAX_SIDE = 256;

/** Why a selection can't be surveyed, or null. */
export function surveyProblem(selection) {
  const b = selectionBounds(selection);
  if (!b) return 'Prima seleziona un\'area.';
  const w = b.maxX - b.minX + 1, d = b.maxZ - b.minZ + 1;
  if (w > MAX_SIDE || d > MAX_SIDE) return `L'area è ${w} × ${d}: per chiedere a Claude il lato massimo è ${MAX_SIDE} blocchi.`;
  return null;
}

/**
 * Read the ground of every selected column.
 * Returns { dim, minY, height, x0, z0, w, d, selected, ground, top, water,
 * groundName, topName, biome, names, biomes } — ground/top/water are Int16
 * (KEEP where unknown), the *Name and biome arrays index `names` / `biomes`.
 */
export async function surveyArea({ source, dim, regions, selection, onProgress, signal }) {
  const problem = surveyProblem(selection);
  if (problem) throw new Error(problem);
  const b = selectionBounds(selection);
  const info = dimensionInfo(dim);
  const x0 = b.minX, z0 = b.minZ, w = b.maxX - b.minX + 1, d = b.maxZ - b.minZ + 1;
  const n = w * d;
  const out = {
    dim, minY: info.minY, height: info.height, x0, z0, w, d,
    selected: new Uint8Array(n),
    ground: new Int16Array(n).fill(KEEP),
    top: new Int16Array(n).fill(KEEP),
    water: new Int16Array(n).fill(KEEP),
    groundName: new Uint16Array(n),
    topName: new Uint16Array(n),
    biome: new Uint16Array(n),
    names: ['minecraft:air'],
    biomes: ['?'],
  };
  const nameIx = new Map([['minecraft:air', 0]]);
  const biomeIx = new Map([['?', 0]]);
  const ix = (map, list, v) => { let i = map.get(v); if (i === undefined) { i = list.length; list.push(v); map.set(v, i); } return i; };
  await walkChunks({ source, dim, regions, selection, onProgress, signal }, (ed, cx, cz, mask) => {
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        if (!mask[lz * 16 + lx]) continue;
        const x = cx * 16 + lx, z = cz * 16 + lz;
        if (x < x0 || x >= x0 + w || z < z0 || z >= z0 + d) continue;
        const i = (z - z0) * w + (x - x0);
        out.selected[i] = 1;
        const col = readColumn(ed, x, z);
        if (col.ground === null) continue;
        out.ground[i] = col.ground;
        out.top[i] = col.top;
        if (col.water !== null) out.water[i] = col.water;
        out.groundName[i] = ix(nameIx, out.names, col.groundName);
        out.topName[i] = ix(nameIx, out.names, ed.getState(x, col.top, z).Name);
        out.biome[i] = ix(biomeIx, out.biomes, ed.getBiome(x, col.ground, z) || '?');
      }
    }
  });
  return out;
}

const short = (name) => String(name).replace(/^minecraft:/, '');
const LETTERS = 'ABCDEFGHIJKLMNOPQRSUVWXYZabcdefghijklmnopqrsuvwxyz'; // no T/t: T marks trees

/** Statistics of a survey: used by the prompt and by the dialog. */
export function surveyStats(s) {
  let cols = 0, known = 0, min = Infinity, max = -Infinity, sum = 0, wet = 0, canopy = 0;
  const grounds = new Map(), biomes = new Map(), levels = new Map();
  for (let i = 0; i < s.w * s.d; i++) {
    if (!s.selected[i]) continue;
    cols++;
    if (s.ground[i] === KEEP) continue;
    known++;
    const g = s.ground[i];
    if (g < min) min = g; if (g > max) max = g;
    sum += g;
    if (s.water[i] !== KEEP) { wet++; levels.set(s.water[i], (levels.get(s.water[i]) || 0) + 1); }
    if (/_leaves|_log/.test(s.names[s.topName[i]])) canopy++;
    grounds.set(s.groundName[i], (grounds.get(s.groundName[i]) || 0) + 1);
    biomes.set(s.biome[i], (biomes.get(s.biome[i]) || 0) + 1);
  }
  const sorted = (m, list) => [...m].sort((a, b) => b[1] - a[1]).map(([k, c]) => ({ name: list[k], index: k, count: c }));
  return {
    columns: cols, known, min: known ? min : null, max: known ? max : null, mean: known ? sum / known : null,
    wet, canopy, grounds: sorted(grounds, s.names), biomes: sorted(biomes, s.biomes),
    waterLevels: [...levels].sort((a, b) => b[1] - a[1]).map(([y, count]) => ({ y, count })),
  };
}

/**
 * The survey as text: header, statistics, then grids sampled every `step`
 * blocks (at most ~64 per side) of ground height, surface and biome.
 */
export function describeSurvey(s, { maxCells = 64 } = {}) {
  const st = surveyStats(s);
  const step = Math.max(1, Math.ceil(Math.max(s.w, s.d) / maxCells));
  const lines = [];
  const top = s.minY + s.height - 1;
  lines.push(`AREA: dimension ${s.dim}; x from ${s.x0} to ${s.x0 + s.w - 1}, z from ${s.z0} to ${s.z0 + s.d - 1} (${s.w} × ${s.d} blocks); ${st.columns} selected columns.`);
  lines.push(`WORLD LIMITS: y from ${s.minY} to ${top}${s.dim === 'overworld' ? '; sea level 63' : ''}.`);
  if (!st.known) {
    lines.push('No ground was found in the selected columns (empty or ungenerated chunks).');
    return { text: lines.join('\n'), step, stats: st };
  }
  lines.push(`GROUND HEIGHT: min ${st.min}, max ${st.max}, mean ${st.mean.toFixed(1)}.`);
  lines.push(`WATER above the ground in ${st.wet} columns${st.wet ? ` (water surface at ${st.waterLevels.slice(0, 4).map((l) => `y ${l.y}: ${l.count}`).join(', ')})` : ''}; tree canopy (leaves/logs on top) over ${st.canopy} columns.`);
  lines.push(`SURFACE BLOCKS (columns): ${st.grounds.slice(0, 12).map((g) => `${short(g.name)} ${g.count}`).join(', ')}${st.grounds.length > 12 ? ', …' : ''}.`);
  lines.push(`BIOMES (columns): ${st.biomes.map((g) => `${g.name} ${g.count}`).join(', ')}.`);

  const legend = new Map(st.grounds.slice(0, LETTERS.length).map((g, i) => [g.index, LETTERS[i]]));
  const biomeLegend = new Map(st.biomes.slice(0, LETTERS.length).map((g, i) => [g.index, LETTERS[i]]));
  const xs = [], zs = [];
  for (let x = 0; x < s.w; x += step) xs.push(x);
  for (let z = 0; z < s.d; z += step) zs.push(z);
  lines.push('');
  lines.push(`GRIDS: one cell every ${step} block${step > 1 ? 's' : ''} (the column at the cell's corner). Rows go south (z grows), columns go east (x grows).`);
  lines.push(`Row i is z = ${s.z0} + ${step}·i; column j is x = ${s.x0} + ${step}·j. "." = not selected, "?" = no ground.`);
  lines.push('');
  lines.push('HEIGHT GRID (y of the ground block):');
  for (const z of zs) {
    lines.push(xs.map((x) => {
      const i = z * s.w + x;
      if (!s.selected[i]) return '.';
      return s.ground[i] === KEEP ? '?' : String(s.ground[i]);
    }).join(' '));
  }
  lines.push('');
  lines.push(`SURFACE GRID: ~ water, T tree canopy, otherwise the ground block: ${[...legend].map(([k, l]) => `${l}=${short(s.names[k])}`).join(', ')}${st.grounds.length > legend.size ? ', * other' : ''}.`);
  for (const z of zs) {
    lines.push(xs.map((x) => {
      const i = z * s.w + x;
      if (!s.selected[i]) return '.';
      if (s.ground[i] === KEEP) return '?';
      if (s.water[i] !== KEEP) return '~';
      if (/_leaves|_log/.test(s.names[s.topName[i]])) return 'T';
      return legend.get(s.groundName[i]) || '*';
    }).join(''));
  }
  if (st.biomes.length > 1) {
    lines.push('');
    lines.push(`BIOME GRID: ${[...biomeLegend].map(([k, l]) => `${l}=${s.biomes[k]}`).join(', ')}.`);
    for (const z of zs) {
      lines.push(xs.map((x) => {
        const i = z * s.w + x;
        if (!s.selected[i]) return '.';
        return s.ground[i] === KEEP ? '?' : biomeLegend.get(s.biome[i]) || '*';
      }).join(''));
    }
  }
  return { text: lines.join('\n'), step, stats: st };
}
