/*
 * "Ask Claude": the prompt Claude gets, and turning its answer into journal
 * operations.
 *
 * Claude never edits the world. It reads a description of the area (survey.js)
 * and answers with a *recipe*: plain JSON naming terrain steps, trees and
 * plants, and a few block edits. Everything in it is checked here and compiled
 * into ONE `group` operation — heights resolved per column, trees given their
 * ground — which goes into the journal like any other change: shown on the
 * map, undone with one ⌘Z, written only by Apply, on a copy.
 *
 *   recipe = {
 *     explanation: string,
 *     terrain: null | { steps: [...], top?, filler?, fillerDepth?, stone?,
 *                       waterLevel?, underwater?, blend? },
 *     edits:    [ fillBox | replace | biome ],
 *     features: [ scatter | at ],
 *   }
 */

import { KEEP, TREES, PLANTS, FEATURE_KINDS, encodeHeights } from './terrain.js';
import { CHUNK_OPS } from './journal.js';
import { hash3 } from './blocks.js';
import { describeSurvey } from './survey.js';

/** Most trees and plants one answer may place. */
export const MAX_FEATURES = 20000;
/** Most blocks one fillBox may cover. */
export const MAX_FILL = 2_000_000;

const TERRAIN_STEPS = ['set', 'raise', 'hill', 'ridge', 'plateau', 'grid', 'noise', 'smooth', 'clamp', 'terrace'];

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `You are the terrain assistant of "Cube-Atlas Cantiere", an editor for Minecraft Java Edition worlds (1.18 up to 26.x).
The user selected an area of a world and asks for a change. You get a description of the area and must answer with a RECIPE: one JSON object, and nothing else — no prose, no Markdown fences.
The editor checks the recipe, previews it on the map and only writes it to a COPY of the world when the user presses Apply. You cannot read or write files and have no tools: everything you need is in the message.

RECIPE FORMAT
{
  "explanation": "2–4 sentences IN ITALIAN telling the user what you are going to do (and anything you could not do)",
  "terrain": null or {
    "steps": [ ... ],            // applied in order to the current ground height of every selected column
    "top": "grass_block",        // optional: surface block of the changed columns (default: keep each column's own)
    "filler": "dirt",            // optional: the blocks right under the surface (default: keep)
    "fillerDepth": 3,            // optional, 0–16
    "stone": "stone",            // optional: what fills a raised column below the filler
    "waterLevel": 62,            // optional: changed columns lower than this get water up to this y (lakes, rivers)
    "underwater": "sand",        // optional: surface block of the columns under water
    "blend": 4                   // optional: blocks over which the change fades into the untouched border (0 = hard edge)
  },
  "edits": [ ... ],              // optional block edits, applied after the terrain
  "features": [ ... ]            // trees and plants, placed last, on the final ground
}

TERRAIN STEPS (heights are absolute y of the ground block; x/z are world coordinates)
  {"op":"set","y":70}                                   flatten to y
  {"op":"raise","dy":3}                                 raise (negative: lower)
  {"op":"hill","x":10,"z":-4,"radius":20,"height":12}   smooth bump (negative height: basin/pit)
  {"op":"ridge","x1":0,"z1":0,"x2":40,"z2":10,"radius":6,"height":-5}   along a segment (negative: valley, riverbed)
  {"op":"plateau","x":0,"z":0,"radius":8,"y":72,"falloff":6}           flat round area at y, blending outwards
  {"op":"grid","step":8,"rows":[[64,65,null],[66,70,68]]}              absolute heights on a coarse grid starting at the area's north-west corner (row = z, column = x, every "step" blocks), interpolated; null = keep
  {"op":"noise","amplitude":2,"scale":12,"seed":1}      natural roughness (± amplitude, features about "scale" blocks wide)
  {"op":"smooth","radius":2,"passes":1}                 soften slopes (radius 1–8, passes 1–5)
  {"op":"clamp","min":60,"max":90}                      keep heights within limits
  {"op":"terrace","step":4}                             steps every "step" blocks
  set, raise, noise, clamp and terrace accept "area": {"minX":..,"minZ":..,"maxX":..,"maxZ":..} to act on part of the selection only.

IMPORTANT ABOUT TERRAIN: a column whose height changes is rebuilt — whatever stood on it (trees, grass, snow, buildings) is removed — so add trees and plants back with "features". Columns whose height does not change are left alone unless you give "top" or "filler". Only selected columns change. Respect the world limits.

EDITS
  {"type":"fillBox","x1":0,"y1":64,"z1":0,"x2":4,"y2":66,"z2":4,"block":"cobblestone"}   fill a box (inside the area)
  {"type":"replace","rules":[{"from":"grass_block","to":"70% podzol, 30% coarse_dirt"}],"exposedOnly":false,"yMin":null,"yMax":null,"area":null}
      from: a block, "block[prop=value]", a tag like "#minecraft:logs" or a pattern like "*_planks"; to: a block or a percentage mix
  {"type":"biome","biome":"minecraft:forest","area":null}   paint the biome (whole columns)

FEATURES
  {"type":"scatter","species":{"oak":0.7,"birch":0.3},"density":0.02,"spacing":4,"maxSlope":2,"area":null}
      density = how many per column (0.02 ≈ one every 50 columns); spacing = minimum distance; skips water and steep slopes
  {"type":"at","kind":"spruce","x":12,"z":-3,"size":9}   one tree or plant at a point (size = trunk height, optional)
  Trees: ${Object.keys(TREES).join(', ')}.
  Plants (density up to ~0.5, spacing 1): ${Object.keys(PLANTS).join(', ')}.

RULES
- Use Minecraft Java block ids (namespace optional): grass_block, dirt, coarse_dirt, podzol, stone, andesite, sand, gravel, moss_block, snow_block, ...
- Prefer few, large, natural-looking steps (hills, ridges, noise, smooth) over huge grids. A grid is fine for precise shapes; keep it under ~40×40 values.
- Keep the change inside the selection. Keep the borders matching the surroundings (use "blend").
- If the request is impossible or unclear, do the closest sensible thing and say so in "explanation". If nothing should change, return empty terrain/edits/features and explain why.
- Output ONLY the JSON object.`;

/** The user message: the request plus the survey. */
export function buildPrompt(request, survey) {
  const { text } = describeSurvey(survey);
  return `REQUEST FROM THE USER (in their words):\n${String(request).trim()}\n\n${text}\n\nAnswer with the recipe JSON only.`;
}

/** Pull the recipe out of Claude's answer: the JSON object, with or without fences around it. */
export function parseRecipe(answer) {
  if (answer && typeof answer === 'object') return answer;
  const text = String(answer || '').trim();
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('Claude non ha risposto con una ricetta (nessun JSON nella risposta).');
  try {
    return JSON.parse(text.slice(a, b + 1));
  } catch (err) {
    throw new Error(`La risposta di Claude non è JSON valido: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Compiling
// ---------------------------------------------------------------------------

const num = (v, what, { min = -Infinity, max = Infinity, int = false, def } = {}) => {
  if ((v === undefined || v === null) && def !== undefined) return def;
  const n = Number(v);
  if (v === null || v === undefined || v === '' || !Number.isFinite(n)) throw new Error(`${what}: numero mancante o non valido.`);
  if (n < min || n > max) throw new Error(`${what}: ${n} fuori dai limiti (${min}…${max}).`);
  return int ? Math.round(n) : n;
};

const blockId = (v, what) => {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  if (!/^(minecraft:)?[a-z0-9_]+(\[[a-z0-9_]+=[a-z0-9_]+(,[a-z0-9_]+=[a-z0-9_]+)*\])?$/.test(s)) throw new Error(`${what}: blocco non valido “${s}”.`);
  return s.includes(':') ? s : `minecraft:${s}`;
};

function areaOf(a, s, what) {
  if (!a) return null;
  const r = {
    minX: num(a.minX, `${what} (area.minX)`, { int: true }), minZ: num(a.minZ, `${what} (area.minZ)`, { int: true }),
    maxX: num(a.maxX, `${what} (area.maxX)`, { int: true }), maxZ: num(a.maxZ, `${what} (area.maxZ)`, { int: true }),
  };
  if (r.minX > r.maxX) [r.minX, r.maxX] = [r.maxX, r.minX];
  if (r.minZ > r.maxZ) [r.minZ, r.maxZ] = [r.maxZ, r.minZ];
  if (r.maxX < s.x0 || r.minX > s.x0 + s.w - 1 || r.maxZ < s.z0 || r.minZ > s.z0 + s.d - 1) throw new Error(`${what}: l'area indicata è fuori dalla selezione.`);
  return r;
}
const inArea = (r, x, z) => !r || (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ);

const smoothstep = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const bump = (dist, radius) => (dist >= radius ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * dist) / radius));

function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2)) : 0;
  return Math.hypot(ax + t * dx - px, az + t * dz - pz);
}

/** Smooth value noise in [-1, 1], two octaves. */
function noise2(x, z, seed) {
  const one = (fx, fz, sd) => {
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = smoothstep(fx - ix), tz = smoothstep(fz - iz);
    const v = (a, b) => hash3(a, 0, b, sd) * 2 - 1;
    const top = v(ix, iz) + (v(ix + 1, iz) - v(ix, iz)) * tx;
    const bot = v(ix, iz + 1) + (v(ix + 1, iz + 1) - v(ix, iz + 1)) * tx;
    return top + (bot - top) * tz;
  };
  return (one(x, z, seed) * 2 + one(x * 2, z * 2, seed + 17)) / 3;
}

/**
 * Run the terrain steps over the surveyed ground. Returns the new height of
 * every column (NaN where unknown or unselected).
 */
export function terrainField(terrain, s) {
  const n = s.w * s.d;
  const F = new Float64Array(n);
  const live = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    live[i] = s.selected[i] && s.ground[i] !== KEEP ? 1 : 0;
    F[i] = live[i] ? s.ground[i] : NaN;
  }
  const top = s.minY + s.height - 1;
  const yOf = (v, what) => num(v, what, { min: s.minY, max: top });
  const each = (fn, area) => {
    for (let z = 0; z < s.d; z++) {
      for (let x = 0; x < s.w; x++) {
        const i = z * s.w + x;
        if (live[i] && inArea(area, s.x0 + x, s.z0 + z)) fn(i, s.x0 + x, s.z0 + z);
      }
    }
  };
  const steps = Array.isArray(terrain.steps) ? terrain.steps : [];
  steps.forEach((st, k) => {
    const what = `Terreno, passo ${k + 1} (${st && st.op})`;
    const area = areaOf(st.area, s, what);
    switch (st && st.op) {
      case 'set': { const y = yOf(st.y, what); each((i) => { F[i] = y; }, area); break; }
      case 'raise': { const dy = num(st.dy, what, { min: -s.height, max: s.height }); each((i) => { F[i] += dy; }, area); break; }
      case 'hill': {
        const cx = num(st.x, what), cz = num(st.z, what), r = num(st.radius, what, { min: 1, max: 1024 }), h = num(st.height, what, { min: -s.height, max: s.height });
        each((i, x, z) => { F[i] += h * bump(Math.hypot(x + 0.5 - cx, z + 0.5 - cz), r); });
        break;
      }
      case 'ridge': {
        const ax = num(st.x1, what), az = num(st.z1, what), bx = num(st.x2, what), bz = num(st.z2, what);
        const r = num(st.radius, what, { min: 1, max: 512 }), h = num(st.height, what, { min: -s.height, max: s.height });
        each((i, x, z) => { F[i] += h * bump(segDist(x + 0.5, z + 0.5, ax, az, bx, bz), r); });
        break;
      }
      case 'plateau': {
        const cx = num(st.x, what), cz = num(st.z, what), r = num(st.radius, what, { min: 0, max: 1024 }), y = yOf(st.y, what);
        const fo = num(st.falloff, what, { min: 0, max: 512, def: Math.max(2, r / 2) });
        each((i, x, z) => {
          const dist = Math.hypot(x + 0.5 - cx, z + 0.5 - cz);
          const t = dist <= r ? 0 : fo > 0 ? smoothstep((dist - r) / fo) : 1;
          F[i] = y * (1 - t) + F[i] * t;
        });
        break;
      }
      case 'grid': {
        const step = num(st.step, what, { min: 1, max: 256, int: true });
        const rows = st.rows;
        if (!Array.isArray(rows) || !rows.length || !rows.every(Array.isArray)) throw new Error(`${what}: "rows" deve essere una lista di righe.`);
        const gx = num(st.x, what, { def: s.x0 }), gz = num(st.z, what, { def: s.z0 });
        const at = (r, c) => {
          const v = rows[r] && rows[r][c];
          return v === null || v === undefined ? null : yOf(v, what);
        };
        each((i, x, z) => {
          const fr = (z - gz) / step, fc = (x - gx) / step;
          const r0 = Math.floor(fr), c0 = Math.floor(fc);
          if (r0 < 0 || c0 < 0 || r0 >= rows.length) return;
          const r1 = Math.min(r0 + 1, rows.length - 1);
          const width = Math.max(rows[r0].length, rows[r1].length);
          if (c0 >= width) return;
          const c1 = Math.min(c0 + 1, width - 1);
          const v00 = at(r0, c0), v01 = at(r0, c1), v10 = at(r1, c0), v11 = at(r1, c1);
          if ([v00, v01, v10, v11].some((v) => v === null)) return;
          const tc = fc - c0, tr = fr - r0;
          const a = v00 + (v01 - v00) * tc, b = v10 + (v11 - v10) * tc;
          F[i] = a + (b - a) * tr;
        });
        break;
      }
      case 'noise': {
        const amp = num(st.amplitude, what, { min: 0, max: 64 }), sc = num(st.scale, what, { min: 1, max: 512, def: 16 }), seed = num(st.seed, what, { def: 1, int: true });
        each((i, x, z) => { F[i] += amp * noise2(x / sc, z / sc, seed); }, area);
        break;
      }
      case 'smooth': {
        const r = num(st.radius, what, { min: 1, max: 8, int: true, def: 2 }), passes = num(st.passes, what, { min: 1, max: 5, int: true, def: 1 });
        for (let p = 0; p < passes; p++) {
          const src = F.slice();
          each((i, x, z) => {
            let sum = 0, cnt = 0;
            const lx = x - s.x0, lz = z - s.z0;
            for (let dz = -r; dz <= r; dz++) {
              for (let dx = -r; dx <= r; dx++) {
                const nx = lx + dx, nz = lz + dz;
                if (nx < 0 || nz < 0 || nx >= s.w || nz >= s.d) continue;
                const v = src[nz * s.w + nx];
                if (Number.isNaN(v)) continue;
                sum += v; cnt++;
              }
            }
            if (cnt) F[i] = sum / cnt;
          });
        }
        break;
      }
      case 'clamp': {
        const mn = st.min === null || st.min === undefined ? -Infinity : yOf(st.min, what);
        const mx = st.max === null || st.max === undefined ? Infinity : yOf(st.max, what);
        each((i) => { F[i] = Math.max(mn, Math.min(mx, F[i])); }, area);
        break;
      }
      case 'terrace': {
        const step = num(st.step, what, { min: 1, max: 64, int: true });
        each((i) => { F[i] = Math.floor(F[i] / step) * step; }, area);
        break;
      }
      default:
        throw new Error(`${what}: passo sconosciuto. Ammessi: ${TERRAIN_STEPS.join(', ')}.`);
    }
  });

  // Fade into the border: columns near an unselected one (or the box edge) move less.
  const blend = num(terrain.blend, 'Terreno (blend)', { min: 0, max: 32, int: true, def: 4 });
  if (blend > 0) {
    const dist = new Int16Array(n).fill(blend + 1);
    const queue = [];
    for (let z = 0; z < s.d; z++) {
      for (let x = 0; x < s.w; x++) {
        const i = z * s.w + x;
        if (!s.selected[i]) { dist[i] = 0; queue.push(i); }
        else if (x === 0 || z === 0 || x === s.w - 1 || z === s.d - 1) { dist[i] = 1; queue.push(i); }
      }
    }
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q], x = i % s.w, z = (i - x) / s.w;
      if (dist[i] >= blend) continue;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, nz = z + dz;
          if (nx < 0 || nz < 0 || nx >= s.w || nz >= s.d) continue;
          const j = nz * s.w + nx;
          if (dist[j] > dist[i] + 1) { dist[j] = dist[i] + 1; queue.push(j); }
        }
      }
    }
    for (let i = 0; i < n; i++) {
      if (!live[i] || dist[i] > blend) continue;
      const t = smoothstep(dist[i] / (blend + 1));
      F[i] = s.ground[i] + (F[i] - s.ground[i]) * t;
    }
  }
  for (let i = 0; i < n; i++) if (live[i]) F[i] = Math.max(s.minY + 1, Math.min(top - 1, Math.round(F[i])));
  return F;
}

/** Steepest step from a column to its four neighbours (in the final ground). */
function slopeAt(G, s, x, z) {
  const i = z * s.w + x;
  let m = 0;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx, nz = z + dz;
    if (nx < 0 || nz < 0 || nx >= s.w || nz >= s.d) continue;
    const v = G[nz * s.w + nx];
    if (v !== KEEP) m = Math.max(m, Math.abs(v - G[i]));
  }
  return m;
}

function speciesPicker(spec, what) {
  const entries = typeof spec === 'string' ? [[spec, 1]]
    : Array.isArray(spec) ? spec.map((k) => [k, 1])
      : spec && typeof spec === 'object' ? Object.entries(spec) : [];
  if (!entries.length) throw new Error(`${what}: indica almeno una specie.`);
  for (const [k, wgt] of entries) {
    if (!TREES[k] && !PLANTS[k]) throw new Error(`${what}: specie sconosciuta “${k}”. Ammesse: ${FEATURE_KINDS.join(', ')}.`);
    if (!(Number(wgt) > 0)) throw new Error(`${what}: peso non valido per ${k}.`);
  }
  const total = entries.reduce((a, [, wgt]) => a + Number(wgt), 0);
  return (r) => {
    let acc = 0;
    for (const [k, wgt] of entries) { acc += Number(wgt) / total; if (r < acc) return k; }
    return entries[entries.length - 1][0];
  };
}

/**
 * Compile a recipe against a survey into one `group` operation.
 * ctx: { selection, request, seed }.
 * Returns { op (null when nothing changes), stats, warnings }.
 */
export function compileRecipe(recipe, s, { selection, request = '', seed = 1 } = {}) {
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) throw new Error('La ricetta di Claude non è un oggetto JSON.');
  const n = s.w * s.d;
  const ops = [];
  const warnings = [];
  const stats = { columns: 0, raised: 0, lowered: 0, trees: 0, plants: 0, edits: 0 };
  const G = s.ground.slice();          // final ground, for features
  const wet = new Uint8Array(n);       // water over the final ground
  for (let i = 0; i < n; i++) if (s.water[i] !== KEEP) wet[i] = 1;
  const top = s.minY + s.height - 1;

  // Terrain
  const t = recipe.terrain;
  if (t && typeof t === 'object' && (Array.isArray(t.steps) && t.steps.length || t.top || t.filler || t.waterLevel !== undefined && t.waterLevel !== null)) {
    const F = terrainField(t, s);
    const mat = {
      top: blockId(t.top, 'Terreno (top)'), filler: blockId(t.filler, 'Terreno (filler)'),
      stone: blockId(t.stone, 'Terreno (stone)'), underwater: blockId(t.underwater, 'Terreno (underwater)'),
    };
    const fillerDepth = num(t.fillerDepth, 'Terreno (fillerDepth)', { min: 0, max: 16, int: true, def: 3 });
    const level = t.waterLevel === null || t.waterLevel === undefined ? null : num(t.waterLevel, 'Terreno (waterLevel)', { min: s.minY, max: top, int: true });
    const H = new Int16Array(n).fill(KEEP);
    for (let i = 0; i < n; i++) {
      if (Number.isNaN(F[i])) continue;
      const h = F[i];
      const flooded = level !== null && h < level;
      if (h === s.ground[i] && !mat.top && !mat.filler && !(flooded && s.water[i] !== level)) continue;
      H[i] = h;
      G[i] = h;
      wet[i] = flooded ? 1 : 0;
      stats.columns++;
      if (h > s.ground[i]) stats.raised++;
      else if (h < s.ground[i]) stats.lowered++;
    }
    if (stats.columns) {
      ops.push({
        type: 'setTerrain', dim: s.dim, x0: s.x0, z0: s.z0, w: s.w, d: s.d, heights: encodeHeights(H),
        ...(mat.top ? { top: mat.top } : {}), ...(mat.filler ? { filler: mat.filler } : {}),
        ...(mat.stone ? { stone: mat.stone } : {}), ...(mat.underwater ? { underwater: mat.underwater } : {}),
        fillerDepth, waterLevel: level,
      });
    }
  }

  // Edits
  const edits = Array.isArray(recipe.edits) ? recipe.edits : [];
  const clipRegion = (area) => (area
    ? { items: [...selection.items, { mode: 'and', shape: { type: 'rect', ...area } }], yMin: selection.yMin ?? null, yMax: selection.yMax ?? null }
    : selection);
  edits.forEach((e, k) => {
    const what = `Modifica ${k + 1} (${e && e.type})`;
    switch (e && e.type) {
      case 'fillBox': {
        const st = blockId(e.block ?? e.state, what);
        if (!st) throw new Error(`${what}: manca il blocco.`);
        const c = (key) => num(e[key], `${what} (${key})`, { int: true });
        let x1 = c('x1'), x2 = c('x2'), z1 = c('z1'), z2 = c('z2');
        const y1 = Math.max(s.minY, Math.min(c('y1'), c('y2'))), y2 = Math.min(top, Math.max(c('y1'), c('y2')));
        [x1, x2] = [Math.max(s.x0, Math.min(x1, x2)), Math.min(s.x0 + s.w - 1, Math.max(x1, x2))];
        [z1, z2] = [Math.max(s.z0, Math.min(z1, z2)), Math.min(s.z0 + s.d - 1, Math.max(z1, z2))];
        if (x1 > x2 || z1 > z2 || y1 > y2) throw new Error(`${what}: la scatola è fuori dall'area selezionata.`);
        if ((x2 - x1 + 1) * (z2 - z1 + 1) * (y2 - y1 + 1) > MAX_FILL) throw new Error(`${what}: scatola troppo grande (max ${MAX_FILL.toLocaleString('it-IT')} blocchi).`);
        ops.push({ type: 'fillBox', dim: s.dim, x1, y1, z1, x2, y2, z2, state: st });
        break;
      }
      case 'replace':
      case 'replaceBlocks': {
        const rules = (Array.isArray(e.rules) ? e.rules : []).map((r) => ({ from: String(r.from || '').trim(), to: String(r.to || '').trim() })).filter((r) => r.from && r.to);
        if (!rules.length) throw new Error(`${what}: nessuna regola.`);
        const opt = (v) => (v === null || v === undefined || v === '' ? null : num(v, what, { int: true }));
        ops.push({
          type: 'replaceBlocks', dim: s.dim, region: clipRegion(areaOf(e.area, s, what)), rules,
          yMin: opt(e.yMin), yMax: opt(e.yMax), exposedOnly: !!e.exposedOnly, keepProps: e.keepProps !== false, biomes: [],
          seed: (seed + k * 7919) | 0,
        });
        break;
      }
      case 'biome':
      case 'paintBiome': {
        const b = String(e.biome || '').trim();
        ops.push({ type: 'paintBiome', dim: s.dim, biome: b.includes(':') ? b : `minecraft:${b}`, region: clipRegion(areaOf(e.area, s, what)) });
        break;
      }
      default:
        throw new Error(`${what}: tipo sconosciuto. Ammessi: fillBox, replace, biome.`);
    }
    stats.edits++;
  });

  // Features, on the final ground
  const items = [];
  const features = Array.isArray(recipe.features) ? recipe.features : [];
  const usable = (i) => s.selected[i] && G[i] !== KEEP && !wet[i];
  features.forEach((f, k) => {
    const what = `Alberi e piante ${k + 1} (${f && f.type})`;
    if (f && f.type === 'at') {
      const kind = String(f.kind || '');
      speciesPicker(kind, what);
      const x = num(f.x, `${what} (x)`, { int: true }), z = num(f.z, `${what} (z)`, { int: true });
      const i = (z - s.z0) * s.w + (x - s.x0);
      if (x < s.x0 || z < s.z0 || x >= s.x0 + s.w || z >= s.z0 + s.d || !usable(i)) { warnings.push(`${what}: ${x}, ${z} è fuori dalla selezione o sott'acqua, saltato.`); return; }
      items.push([x, G[i], z, kind, ...(f.size ? [num(f.size, `${what} (size)`, { min: 1, max: 24, int: true })] : [])]);
    } else if (f && f.type === 'scatter') {
      const pick = speciesPicker(f.species ?? f.kind, what);
      const density = num(f.density, `${what} (density)`, { min: 0, max: 1, def: 0.02 });
      const spacing = num(f.spacing, `${what} (spacing)`, { min: 1, max: 64, int: true, def: 4 });
      const maxSlope = num(f.maxSlope, `${what} (maxSlope)`, { min: 0, max: 64, def: 2 });
      const area = areaOf(f.area, s, what);
      const p = Math.min(1, density * spacing * spacing);
      const fs = (seed * 31 + k * 101) | 0;
      for (let gz = 0; gz * spacing < s.d; gz++) {
        for (let gx = 0; gx * spacing < s.w; gx++) {
          if (hash3(gx, 1, gz, fs) >= p) continue;
          const x = Math.min(s.w - 1, gx * spacing + Math.floor(hash3(gx, 2, gz, fs) * spacing));
          const z = Math.min(s.d - 1, gz * spacing + Math.floor(hash3(gx, 3, gz, fs) * spacing));
          const i = z * s.w + x;
          if (!usable(i) || !inArea(area, s.x0 + x, s.z0 + z) || slopeAt(G, s, x, z) > maxSlope) continue;
          items.push([s.x0 + x, G[i], s.z0 + z, pick(hash3(gx, 4, gz, fs))]);
        }
      }
    } else {
      throw new Error(`${what}: tipo sconosciuto. Ammessi: scatter, at.`);
    }
  });
  if (items.length > MAX_FEATURES) {
    warnings.push(`Troppi alberi e piante (${items.length}): tenuti i primi ${MAX_FEATURES}.`);
    items.length = MAX_FEATURES;
  }
  for (const it of items) { if (TREES[it[3]]) stats.trees++; else stats.plants++; }
  if (items.length) ops.push({ type: 'placeFeatures', dim: s.dim, items, seed });

  if (!ops.length) return { op: null, stats, warnings };
  const req = String(request).trim().replace(/\s+/g, ' ');
  const op = {
    type: 'group', dim: s.dim, source: 'claude',
    label: req.length > 60 ? `${req.slice(0, 57)}…` : req,
    request: req, explanation: String(recipe.explanation || ''), ops,
  };
  CHUNK_OPS.group.validate(op);
  return { op, stats, warnings };
}
