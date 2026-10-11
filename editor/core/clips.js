/*
 * Clips: pieces copied out of a world, ready to be pasted into another one
 * (or into the same one, somewhere else).
 *
 * A clip is a folder in the app's data directory holding a snapshot of the
 * source, so a pending paste never depends on the source world again — it
 * may change or be gone by the time Apply runs:
 *
 *   clip.json        what was copied: world, dimension, selection, boxes
 *   region/          the source's region files under the selection
 *   entities/        and its entity files (whole-chunk pastes copy entities)
 *   preview.png      the piece seen from above, shown while placing a paste
 *                    (it covers `previewBox`, the clip's whole chunks)
 *
 * The files are cloned (copy-on-write on APFS: instant, no space used until
 * one side changes). A paste operation names its clip by folder; replay reads
 * chunks from there, synchronously, through a small cache.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readRegionFile } from './region.js';
import { dimensionDir } from './dimensions.js';
import zlib from 'node:zlib';
import { selectionBounds, isEmptySelection } from './selection.js';

export const CLIP_FILE = 'clip.json';

/**
 * Copy the selection of a world into a new clip folder under clipsDir.
 * @returns the clip's description (also written to clip.json), with `dir`
 */
export function createClip({ worldDir, modern = false, dim, selection, clipsDir, name = null, worldName = null, dataVersion = null, preview = null }) {
  if (isEmptySelection(selection)) throw new Error('Prima seleziona l\'area da copiare.');
  const b = selectionBounds(selection);
  const chunks = { minX: b.minX >> 4, minZ: b.minZ >> 4, maxX: b.maxX >> 4, maxZ: b.maxZ >> 4 };
  const id = `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
  const dir = path.join(clipsDir, id);
  let regions = 0;
  for (const kind of ['region', 'entities']) {
    const from = path.join(worldDir, dimensionDir(dim, kind, modern));
    for (let rz = chunks.minZ >> 5; rz <= chunks.maxZ >> 5; rz++) {
      for (let rx = chunks.minX >> 5; rx <= chunks.maxX >> 5; rx++) {
        const file = `r.${rx}.${rz}.mca`;
        if (!fs.existsSync(path.join(from, file))) continue;
        fs.mkdirSync(path.join(dir, kind), { recursive: true });
        fs.copyFileSync(path.join(from, file), path.join(dir, kind, file), fs.constants.COPYFILE_FICLONE);
        if (kind === 'region') regions++;
      }
    }
  }
  if (!regions) { fs.rmSync(dir, { recursive: true, force: true }); throw new Error('Nella selezione non ci sono chunk generati da copiare.'); }
  const meta = {
    version: 1, id, name: name || `${worldName || path.basename(worldDir)} · ${b.maxX - b.minX + 1}×${b.maxZ - b.minZ + 1}`,
    world: worldDir, worldName, dim, dataVersion, selection, bounds: b, chunks, created: Date.now(),
  };
  if (preview) {
    fs.writeFileSync(path.join(dir, 'preview.png'), encodePng(preview.width, preview.height, preview.rgba));
    meta.previewBox = preview.box;
  }
  fs.writeFileSync(path.join(dir, CLIP_FILE), JSON.stringify(meta, null, 2));
  return clipMeta(dir);
}

/** Every clip in clipsDir, newest first. Broken folders are skipped. */
export function listClips(clipsDir) {
  if (!fs.existsSync(clipsDir)) return [];
  const out = [];
  for (const e of fs.readdirSync(clipsDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const meta = clipMeta(path.join(clipsDir, e.name));
    if (meta) out.push(meta);
  }
  return out.sort((a, b) => b.created - a.created);
}

export function removeClip(dir) {
  if (!fs.existsSync(path.join(dir, CLIP_FILE))) throw new Error('Questo non è un appunto del Cantiere.');
  fs.rmSync(dir, { recursive: true, force: true });
  forgetClip(dir);
}

// ---------------------------------------------------------------------------
// Reading (synchronous: replay runs inside a synchronous loop)
// ---------------------------------------------------------------------------

const metas = new Map();
const regions = new Map();     // file -> RegionData | null, least recently used first
const MAX_REGIONS = 8;

export function clipMeta(dir) {
  if (metas.has(dir)) return metas.get(dir);
  let meta = null;
  try { meta = { ...JSON.parse(fs.readFileSync(path.join(dir, CLIP_FILE), 'utf8')), dir }; } catch { meta = null; }
  if (meta && meta.previewBox) {
    try { meta.preview = `data:image/png;base64,${fs.readFileSync(path.join(dir, 'preview.png')).toString('base64')}`; } catch { delete meta.previewBox; }
  }
  if (meta) metas.set(dir, meta);
  return meta;
}

/** A plain RGBA image as PNG bytes (no dependencies: zlib and a CRC table). */
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = ~0; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return ~c >>> 0; }
export function encodePng(width, height, rgba) {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head[8] = 8; head[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export const clipExists = (dir) => fs.existsSync(path.join(dir, CLIP_FILE));

function regionOf(dir, kind, rx, rz) {
  const file = path.join(dir, kind, `r.${rx}.${rz}.mca`);
  if (regions.has(file)) {
    const r = regions.get(file);
    regions.delete(file); regions.set(file, r);
    return r;
  }
  const r = fs.existsSync(file) ? readRegionFile(file) : null;
  regions.set(file, r);
  while (regions.size > MAX_REGIONS) regions.delete(regions.keys().next().value);
  return r;
}

/** A fresh, typed copy of one of the clip's chunks ({ name, value }), or null. */
export function clipChunk(dir, cx, cz, kind = 'region') {
  const r = regionOf(dir, kind, cx >> 5, cz >> 5);
  if (!r || !r.has(cx & 31, cz & 31)) return null;
  return r.getChunk(cx & 31, cz & 31);
}

function forgetClip(dir) {
  metas.delete(dir);
  for (const file of [...regions.keys()]) if (file.startsWith(dir + path.sep)) regions.delete(file);
}
