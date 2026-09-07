/*
 * Reads a rectangular box of the world into a flat array of block states.
 *
 * The 2D map only ever needs the topmost block of each column; here we want
 * every block in the box, so this reader goes one level deeper than
 * anvil.js's analyzeChunk(): it keeps each section's palette *with its
 * properties*, because in 3D the difference between a slab's `type=top` and
 * `type=bottom` is half a block of geometry.
 *
 * Layout: blocks[(y * sizeZ + z) * sizeX + x], with x/y/z local to the box.
 * State 0 is always air, so a freshly allocated volume is already empty and
 * the chunks that were never generated cost nothing.
 *
 * Biomes are stored at the resolution Minecraft actually saves them, one
 * value per 4x4x4 cell, which is 64 times less memory than one per block.
 */

import {
  RegionFile, loadRegionFile, readSpanningPacked, readPaddedPacked,
  blockBits, biomeBits,
} from '../core/anvil.js';
import { joinPath } from '../core/source.js';
import { SHAPE_PROPS } from './blockKinds.js';

const DV_PADDED_PACKING = 2529; // 1.16: values stop spanning two longs
export const AIR_STATE = 0;
export const MAX_BLOCKS = 64 * 1024 * 1024;

/**
 * Identity of a block state for rendering: the name plus only the properties
 * that change its shape. Everything else would split the palette without
 * moving a single vertex.
 */
export function stateKeyOf(entry) {
  if (typeof entry === 'string') return entry;
  const name = (entry && entry.Name) || 'minecraft:air';
  const props = entry && entry.Properties;
  if (!props) return name;
  let key = name;
  for (const p of SHAPE_PROPS) {
    if (props[p] !== undefined) key += `|${p}=${props[p]}`;
  }
  return key;
}

class StatePalette {
  constructor() {
    this.ids = new Map([['minecraft:air', AIR_STATE]]);
    this.keys = ['minecraft:air'];
    this.names = ['minecraft:air'];
    this.props = [null];
  }

  idFor(entry) {
    const key = stateKeyOf(entry);
    let id = this.ids.get(key);
    if (id !== undefined) return id;
    id = this.keys.length;
    this.ids.set(key, id);
    this.keys.push(key);
    this.names.push(typeof entry === 'string' ? entry : (entry.Name || 'minecraft:air'));
    this.props.push(typeof entry === 'string' ? null : (entry.Properties || null));
    return id;
  }
}

/** Decode one section's 4096 palette indices into a reusable scratch array. */
function decodeIndices(data, bits, padded, out) {
  const read = padded ? readPaddedPacked : readSpanningPacked;
  for (let i = 0; i < 4096; i++) out[i] = read(data, bits, i);
  return out;
}

/**
 * Read the box [minX, minX+sizeX) x [minY, …) x [minZ, …) from one region
 * directory. Sizes must be multiples of 16 and the origin snapped to 16 —
 * readVolumeBox() below does that for you.
 *
 * `hiddenBlocks` is a Set of block names to read as air, so barriers and
 * other invisible blocks don't wall in the whole scene.
 */
export async function readVolume(source, regionDir, boxSpec, options = {}) {
  const { minX, minY, minZ, sizeX, sizeY, sizeZ } = boxSpec;
  const total = sizeX * sizeY * sizeZ;
  if (total > MAX_BLOCKS) throw new Error(`Porzione troppo grande: ${total} blocchi`);

  const blocks = new Uint16Array(total);
  const bx = sizeX >> 2, by = sizeY >> 2, bz = sizeZ >> 2;
  const biomes = new Uint8Array(bx * by * bz);
  const palette = new StatePalette();
  const biomeIds = new Map([['minecraft:plains', 0]]);
  const biomeNames = ['minecraft:plains'];

  const hidden = options.hiddenBlocks instanceof Set ? options.hiddenBlocks : null;
  const onProgress = options.onProgress || null;

  const maxX = minX + sizeX - 1, maxZ = minZ + sizeZ - 1;
  const maxY = minY + sizeY - 1;
  const cMinX = minX >> 4, cMaxX = maxX >> 4;
  const cMinZ = minZ >> 4, cMaxZ = maxZ >> 4;

  const scratch = new Uint16Array(4096);
  const remap = new Uint16Array(4096);
  const biomeRemap = new Uint8Array(256);

  let chunks = 0, missing = 0, unparsed = 0;
  const totalChunks = (cMaxX - cMinX + 1) * (cMaxZ - cMinZ + 1);
  let done = 0;

  for (let cz = cMinZ; cz <= cMaxZ; cz++) {
    for (let cx = cMinX; cx <= cMaxX; cx++) {
      done++;
      if (onProgress && (done & 7) === 0) onProgress(done / totalChunks);

      const region = await loadRegionFile(
        source, joinPath(regionDir, `r.${cx >> 5}.${cz >> 5}.mca`));
      const lcx = ((cx % 32) + 32) % 32;
      const lcz = ((cz % 32) + 32) % 32;
      if (!region || !region.hasChunk(lcx, lcz)) { missing++; continue; }

      let root = null;
      try {
        const parsed = await region.getChunkRoot(lcx, lcz);
        root = parsed ? parsed.value : null;
      } catch { root = null; }
      if (!root) { unparsed++; continue; }

      const sections = Array.isArray(root.sections) ? root.sections
        : (root.Level && Array.isArray(root.Level.Sections)) ? root.Level.Sections : null;
      if (!sections) { unparsed++; continue; }
      chunks++;

      const padded = Number(root.DataVersion || 0) >= DV_PADDED_PACKING;
      const baseX = cx * 16 - minX;   // where this chunk starts inside the box
      const baseZ = cz * 16 - minZ;
      const xFrom = Math.max(0, -baseX), xTo = Math.min(15, sizeX - 1 - baseX);
      const zFrom = Math.max(0, -baseZ), zTo = Math.min(15, sizeZ - 1 - baseZ);

      for (const sec of sections) {
        const secY = Number(sec.Y) * 16;
        if (secY + 15 < minY || secY > maxY) continue;

        const bs = sec.block_states;
        const paletteTag = bs ? bs.palette : sec.Palette;
        if (!Array.isArray(paletteTag) || paletteTag.length === 0) continue;

        for (let i = 0; i < paletteTag.length; i++) {
          const entry = paletteTag[i];
          const name = typeof entry === 'string' ? entry : (entry && entry.Name) || 'minecraft:air';
          remap[i] = hidden && hidden.has(name) ? AIR_STATE : palette.idFor(entry);
        }

        const dataTag = bs ? bs.data : sec.BlockStates;
        const bits = blockBits(paletteTag.length);
        const data = dataTag instanceof BigInt64Array ? dataTag : null;
        const uniform = bits === 0 || !data || data.length === 0;
        if (!uniform) decodeIndices(data, bits, padded, scratch);
        if (uniform && remap[0] === AIR_STATE) continue; // a whole section of air

        const yFrom = Math.max(0, minY - secY), yTo = Math.min(15, maxY - secY);
        for (let ly = yFrom; ly <= yTo; ly++) {
          const dstY = secY + ly - minY;
          for (let lz = zFrom; lz <= zTo; lz++) {
            const dstRow = (dstY * sizeZ + baseZ + lz) * sizeX + baseX;
            const srcRow = (ly << 8) | (lz << 4);
            if (uniform) {
              blocks.fill(remap[0], dstRow + xFrom, dstRow + xTo + 1);
              continue;
            }
            for (let lx = xFrom; lx <= xTo; lx++) {
              blocks[dstRow + lx] = remap[scratch[srcRow | lx]];
            }
          }
        }

        // Biomes: one value per 4x4x4 cell, named only from 1.18 on.
        const bio = sec.biomes;
        if (!bio || !Array.isArray(bio.palette) || !bio.palette.length) continue;
        for (let i = 0; i < bio.palette.length && i < 256; i++) {
          const bn = String(bio.palette[i]);
          let id = biomeIds.get(bn);
          if (id === undefined) {
            if (biomeNames.length >= 256) { id = 0; } else {
              id = biomeNames.length;
              biomeIds.set(bn, id);
              biomeNames.push(bn);
            }
          }
          biomeRemap[i] = id;
        }
        const bBits = biomeBits(bio.palette.length);
        const bData = bio.data instanceof BigInt64Array ? bio.data : null;
        const bRead = padded ? readPaddedPacked : readSpanningPacked;
        const bUniform = bBits === 0 || !bData || bData.length === 0;
        for (let cy = 0; cy < 4; cy++) {
          const worldY = secY + cy * 4;
          if (worldY + 3 < minY || worldY > maxY) continue;
          const dstY = (worldY - minY) >> 2;
          if (dstY < 0 || dstY >= by) continue;
          for (let cZ = 0; cZ < 4; cZ++) {
            const dstZ = (baseZ >> 2) + cZ;
            if (dstZ < 0 || dstZ >= bz) continue;
            for (let cX = 0; cX < 4; cX++) {
              const dstX = (baseX >> 2) + cX;
              if (dstX < 0 || dstX >= bx) continue;
              const src = (cy << 4) | (cZ << 2) | cX;
              const pi = bUniform ? 0 : bRead(bData, bBits, src);
              biomes[(dstY * bz + dstZ) * bx + dstX] = biomeRemap[pi] || 0;
            }
          }
        }
      }
    }
  }
  if (onProgress) onProgress(1);

  return {
    minX, minY, minZ, sizeX, sizeY, sizeZ,
    blocks, biomes,
    states: palette.keys,
    names: palette.names,
    props: palette.props,
    biomeNames,
    stats: { chunks, missing, unparsed },
  };
}
