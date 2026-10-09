/*
 * Reading many chunks at once: block search, and the preview count of a
 * replacement. Both walk the world chunk by chunk through a WorldSource (the
 * overlay, so pending changes count) and never hold more than one region's
 * worth of chunks in memory.
 *
 * Results are capped: searching for "stone" in a whole world would otherwise
 * return billions of hits. The total is always exact; the list of positions
 * stops at `limit`, and per-chunk counts let the map show where the rest are.
 */

import { RegionData } from './region.js';
import { ChunkEditor } from './chunk.js';
import { TList } from '../../web/js/core/nbt.js';
import { dimensionInfo, dimensionDir } from './dimensions.js';
import { selectionBounds, chunkMask, yRange } from './selection.js';
import { blockMatcher, baseName } from './blocks.js';
import { visitReplace } from './journal.js';

const items = (l) => (l instanceof TList ? l.items : Array.isArray(l) ? l : []);
const num = (v) => (v && typeof v === 'object' && 'v' in v ? Number(v.v) : Number(v));

/**
 * Every chunk to visit, grouped by region: [{ rx, rz, chunks: [[cx, cz], ...] }].
 * With a selection, only chunks it covers; without, every region of the dimension.
 */
export function chunksToVisit(regions, selection) {
  const b = selectionBounds(selection);
  const out = [];
  for (const r of regions) {
    const chunks = [];
    for (let lz = 0; lz < 32; lz++) {
      for (let lx = 0; lx < 32; lx++) {
        const cx = r.x * 32 + lx, cz = r.z * 32 + lz;
        if (b && (cx * 16 > b.maxX || cx * 16 + 15 < b.minX || cz * 16 > b.maxZ || cz * 16 + 15 < b.minZ)) continue;
        chunks.push([cx, cz]);
      }
    }
    if (chunks.length) out.push({ rx: r.x, rz: r.z, chunks });
  }
  return out;
}

async function loadRegion(source, rel, rx, rz) {
  const bytes = await source.readFile(rel);
  if (!bytes || bytes.length < 8192) return null;
  return RegionData.fromBuffer(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), rx, rz);
}

/**
 * Walk chunks: fn(editor, cx, cz, mask, root). `mask` is null without a selection.
 * onProgress({ done, total }) after each region; `signal.aborted` stops early.
 */
export async function walkChunks({ source, dim, regions, selection, onProgress, signal, kind = 'region' }, fn) {
  const info = dimensionInfo(dim);
  const modern = !!(source.modern ?? source.modernLayout);
  const dir = dimensionDir(dim, kind, modern);
  const plan = chunksToVisit(regions, selection);
  let done = 0;
  for (const r of plan) {
    if (signal && signal.aborted) break;
    const region = await loadRegion(source, `${dir}/r.${r.rx}.${r.rz}.mca`, r.rx, r.rz);
    if (region) {
      for (const [cx, cz] of r.chunks) {
        if (!region.has(cx & 31, cz & 31)) continue;
        let mask = null;
        if (selection) { mask = chunkMask(selection, cx, cz); if (!mask) continue; }
        let root;
        try { root = region.getChunk(cx & 31, cz & 31).value; } catch { continue; }
        if (kind === 'region') {
          let ed;
          try { ed = new ChunkEditor(root, { minY: info.minY, height: info.height }); } catch { continue; }
          await fn(ed, cx, cz, mask, root);
        } else {
          await fn(null, cx, cz, mask, root);
        }
      }
    }
    done++;
    if (onProgress) onProgress({ done, total: plan.length });
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/*
 * query:
 *   { kind: 'block', block: 'diamond_ore' | '#minecraft:logs' | '*_ore' }
 *   { kind: 'blockEntity', id: 'spawner' | '*chest', item: 'diamond', text: 'casa' }
 *   { kind: 'entity', id: 'villager' | '*', text: 'Frugg' }
 * all with optional yMin / yMax and the selection.
 */
export async function search({ source, dim, regions, selection, query, limit = 2000, onProgress, signal }) {
  const info = dimensionInfo(dim);
  let [lo, hi] = yRange(selection, info.minY, info.height);
  if (query.yMin !== null && query.yMin !== undefined && query.yMin !== '') lo = Math.max(lo, Number(query.yMin));
  if (query.yMax !== null && query.yMax !== undefined && query.yMax !== '') hi = Math.min(hi, Number(query.yMax));
  const out = { total: 0, items: [], chunks: new Map(), truncated: false };
  const hit = (x, y, z, label, cx, cz) => {
    out.total++;
    const k = `${cx},${cz}`;
    out.chunks.set(k, (out.chunks.get(k) || 0) + 1);
    if (out.items.length < limit) out.items.push({ x, y, z, label });
    else out.truncated = true;
  };
  const inMask = (mask, x, z) => !mask || mask[(z & 15) * 16 + (x & 15)] === 1;

  if (query.kind === 'block') {
    const match = blockMatcher(query.block);
    await walkChunks({ source, dim, regions, selection, onProgress, signal }, (ed, cx, cz, mask) => {
      for (let sy = lo >> 4; sy <= hi >> 4; sy++) {
        const sec = ed.section(sy);
        if (!sec) continue;
        const ok = sec.palette.map((s) => match(s));
        if (!ok.some(Boolean)) continue;
        for (let y = Math.max(lo, sy * 16); y <= Math.min(hi, sy * 16 + 15); y++) {
          for (let lz = 0; lz < 16; lz++) {
            for (let lx = 0; lx < 16; lx++) {
              if (mask && !mask[lz * 16 + lx]) continue;
              const idx = sec.blocks[((y & 15) << 8) | (lz << 4) | lx];
              if (ok[idx]) hit(cx * 16 + lx, y, cz * 16 + lz, baseName(sec.palette[idx].Name), cx, cz);
            }
          }
        }
      }
    });
  } else if (query.kind === 'blockEntity') {
    const idMatch = query.id ? blockMatcher(query.id) : () => true;
    const item = query.item ? `minecraft:${baseName(query.item.trim())}` : null;
    const text = query.text ? query.text.toLowerCase() : null;
    await walkChunks({ source, dim, regions, selection, onProgress, signal }, (ed, cx, cz, mask, root) => {
      for (const be of items(root.block_entities)) {
        const x = num(be.x), y = num(be.y), z = num(be.z);
        if (y < lo || y > hi || !inMask(mask, x, z)) continue;
        if (!idMatch({ Name: String(be.id || '') })) continue;
        if (item && !holds(be, item)) continue;
        if (text && !stringify(be).toLowerCase().includes(text)) continue;
        hit(x, y, z, baseName(String(be.id || '?')), cx, cz);
      }
    });
  } else if (query.kind === 'entity') {
    const idMatch = query.id && query.id !== '*' ? blockMatcher(query.id) : () => true;
    const text = query.text ? query.text.toLowerCase() : null;
    await walkChunks({ source, dim, regions, selection, onProgress, signal, kind: 'entities' }, (_ed, cx, cz, mask, root) => {
      for (const e of items(root.Entities)) {
        const pos = items(e.Pos).map(num);
        if (pos.length < 3) continue;
        const [x, y, z] = pos.map(Math.floor);
        if (y < lo || y > hi || !inMask(mask, x, z)) continue;
        if (!idMatch({ Name: String(e.id || '') })) continue;
        if (text && !stringify(e).toLowerCase().includes(text)) continue;
        hit(x, y, z, baseName(String(e.id || '?')), cx, cz);
      }
    });
  } else {
    throw new Error(`Ricerca sconosciuta: ${query.kind}`);
  }
  return { total: out.total, truncated: out.truncated, items: out.items, chunks: [...out.chunks].map(([k, n]) => { const [cx, cz] = k.split(',').map(Number); return { cx, cz, n }; }) };
}

/** Does a container (or anything with Items / item) hold this item, at any depth? */
function holds(node, id) {
  if (!node || typeof node !== 'object') return false;
  if (node.id === id && (node.Count !== undefined || node.count !== undefined)) return true;
  for (const v of Object.values(node instanceof TList ? { items: node.items } : node)) {
    if (Array.isArray(v)) { if (v.some((x) => holds(x, id))) return true; }
    else if (v instanceof TList) { if (v.items.some((x) => holds(x, id))) return true; }
    else if (v && typeof v === 'object' && !ArrayBuffer.isView(v)) { if (holds(v, id)) return true; }
  }
  return false;
}

/** Every string inside a tag, joined: sign text, custom names, book pages. */
function stringify(node) {
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string') out.push(v);
    else if (v instanceof TList) v.items.forEach(walk);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object' && !ArrayBuffer.isView(v)) Object.values(v).forEach(walk);
  };
  walk(node);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Replace preview
// ---------------------------------------------------------------------------

/** How many blocks a replaceBlocks op would change, and how many lose properties. */
export async function countReplace({ source, dim, regions, op, onProgress, signal }) {
  let changed = 0, dropped = 0;
  await walkChunks({ source, dim, regions, selection: op.region, onProgress, signal }, (ed, cx, cz) => {
    visitReplace(op, ed, cx, cz, (_x, _y, _z, _s, d) => { changed++; if (d) dropped++; });
  });
  return { changed, dropped };
}
