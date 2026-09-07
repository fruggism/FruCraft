/*
 * Reading the save and building the geometry, off the UI thread.
 *
 * Opening a few hundred chunks and meshing them is seconds of work: on the
 * main thread the page would simply stop responding. So everything that
 * touches the world lives here, and the meshes come back one chunk column at
 * a time — transferred, not copied — so the scene fills in while the rest is
 * still being built.
 */

import { sourceFromInit } from './core/source.js';
import { scanWorld } from './core/worldScan.js';
import { readSurface, clearRegionCache, NO_DATA } from './core/anvil.js';
import { colorFor } from './core/blockColors.js';
import { parse as parseNBT } from './core/nbt.js';
import { readVolume } from './voxel/volume.js';
import { buildTables, meshColumn } from './voxel/mesher.js';
import { shapeOf } from './voxel/blockKinds.js';
import { ZipReader, blobSource } from './pack/zip.js';
import { ResourcePack } from './pack/resources.js';
import { buildTextureLayers } from './pack/textures.js';

let source = null;
let scan = null;
let pack = null;   // the resource pack, when one has been chosen

function dimensionOf(dimId) {
  const dim = scan && scan.dimensions.find((d) => d.id === dimId);
  if (!dim) throw new Error('Dimensione non trovata');
  return dim;
}

const handlers = {
  async openWorld({ init }) {
    source = sourceFromInit(init);
    clearRegionCache();
    scan = await scanWorld(source);
    return scan;
  },

  /**
   * Open one or more .jar / .zip archives as the source of textures. Later
   * files win, so a resource pack listed after the game's own jar overrides
   * it sprite by sprite.
   */
  async openPack({ files }) {
    if (!files || !files.length) { pack = null; return { ok: true, packs: 0 }; }
    const zips = [];
    for (const file of files) zips.push(await ZipReader.open(blobSource(file)));
    const opened = new ResourcePack(zips);
    // A pack with no block sprites at all is almost certainly the wrong file.
    const probe = await opened.readTexture('block/stone') || await opened.readTexture('block/dirt');
    if (!probe) throw new Error('Nessuna texture di blocchi qui dentro: è il file giusto?');
    pack = opened;
    return { ok: true, packs: zips.length, names: files.map((f) => f.name || 'archivio') };
  },

  async closePack() { pack = null; return { ok: true }; },

  /** Where the player logged out, when the save records it. */
  async player() {
    const bytes = await source.readFile('level.dat');
    if (!bytes) return null;
    try {
      const { value } = await parseNBT(bytes);
      const pos = value && value.Data && value.Data.Player && value.Data.Player.Pos;
      if (!Array.isArray(pos) || pos.length < 3) return null;
      return { x: Math.round(pos[0]), y: Math.round(pos[1]), z: Math.round(pos[2]) };
    } catch {
      return null;
    }
  },

  /**
   * A top-down look at the area around a point: the same colors the 2D atlas
   * uses, so the portion can be aimed before paying for the 3D read. It also
   * reports how high and how low the ground goes, which is what the automatic
   * height range is derived from.
   */
  async survey({ dimId, minX, minZ, width, depth, hiddenBlocks, focus }) {
    const dim = dimensionOf(dimId);
    const surface = await readSurface(source, dim.regionDir, minX, minZ, width, depth, {
      hiddenBlocks: new Set(hiddenBlocks || []),
    });

    const rgba = new Uint8ClampedArray(width * depth * 4);
    for (let i = 0; i < width * depth; i++) {
      const o = i * 4;
      if (surface.surfaceY[i] === NO_DATA) { rgba[o + 3] = 0; continue; }
      const [r, g, b] = colorFor(surface.surfaceName[i], surface.biome[i]);
      // A touch of relief shading, so hills read as hills.
      const west = i % width ? surface.surfaceY[i - 1] : surface.surfaceY[i];
      const slope = Math.max(-3, Math.min(3, surface.surfaceY[i] - west));
      const f = 1 + slope * 0.06;
      rgba[o] = Math.min(255, r * f);
      rgba[o + 1] = Math.min(255, g * f);
      rgba[o + 2] = Math.min(255, b * f);
      rgba[o + 3] = 255;
    }

    // Ground height, over the sub-rectangle actually being selected.
    let lo = Infinity, hi = -Infinity, known = 0;
    const f = focus || { minX, minZ, width, depth };
    for (let z = 0; z < depth; z++) {
      const wz = minZ + z;
      if (wz < f.minZ || wz >= f.minZ + f.depth) continue;
      for (let x = 0; x < width; x++) {
        const wx = minX + x;
        if (wx < f.minX || wx >= f.minX + f.width) continue;
        const y = surface.surfaceY[z * width + x];
        if (y === NO_DATA) continue;
        known++;
        if (y < lo) lo = y;
        if (y > hi) hi = y;
      }
    }

    return {
      minX, minZ, width, depth, rgba,
      ground: known ? { lo, hi } : null,
      chunks: surface.totalChunks,
    };
  },

  /**
   * Read a box of the world and mesh it. Each chunk column is posted as soon
   * as it is ready; the volume itself comes back at the end, so the page can
   * tell what block the crosshair is on without asking again.
   */
  async load({ dimId, box, hiddenBlocks, textured }, ctx) {
    const dim = dimensionOf(dimId);
    const vol = await readVolume(source, dim.regionDir, box, {
      hiddenBlocks: new Set(hiddenBlocks || []),
      onProgress: (p) => ctx.progress({ phase: 'read', value: p }),
    });

    // Textures are resolved for the palette of *this* portion only: a meadow
    // needs a dozen sprites, not the twelve hundred the game ships.
    let textures = null;
    if (pack && textured !== false) {
      ctx.progress({ phase: 'textures', value: 0 });
      textures = await buildTextureLayers(
        pack, vol,
        (state) => {
          const c = colorFor(vol.names[state], null);
          return (c[0] << 16) | (c[1] << 8) | c[2];
        },
        (state) => shapeOf(vol.states[state], vol.names[state], vol.props[state]).kind === 'cube',
        (value) => ctx.progress({ phase: 'textures', value }),
      );
      ctx.progress({ phase: 'textures', value: 1 });
      // Sent before the first chunk: it decides which materials they use.
      ctx.stream({
        kind: 'textures', tile: textures.tile, layers: textures.layers, data: textures.data,
      }, [textures.data.buffer]);
    }

    const tables = buildTables(vol, textures);
    const columns = (box.sizeX / 16) * (box.sizeZ / 16);
    let done = 0;
    let quads = 0;

    for (let z = 0; z < box.sizeZ; z += 16) {
      for (let x = 0; x < box.sizeX; x += 16) {
        const mesh = meshColumn(vol, tables, x, z);
        done++;
        quads += mesh.quads;
        if (mesh.opaque || mesh.plants || mesh.translucent) {
          const transfer = [];
          for (const part of [mesh.opaque, mesh.plants, mesh.translucent]) {
            if (!part) continue;
            transfer.push(part.positions.buffer, part.colors.buffer, part.indices.buffer);
            if (part.uvs) transfer.push(part.uvs.buffer);
          }
          ctx.stream({
            kind: 'column', x, z,
            opaque: mesh.opaque, plants: mesh.plants, translucent: mesh.translucent,
          }, transfer);
        }
        if ((done & 3) === 0 || done === columns) {
          ctx.progress({ phase: 'mesh', value: done / columns });
        }
        // Let the message queue breathe, so a cancel can get through.
        if ((done & 7) === 0) await Promise.resolve();
      }
    }

    return {
      result: {
        box, quads, stats: vol.stats,
        textured: !!textures,
        textureLayers: textures ? textures.layers : 0,
        blocks: vol.blocks,
        states: vol.states,
        names: vol.names,
        props: vol.props,
      },
      transfer: [vol.blocks.buffer],
    };
  },
};

self.onmessage = async (event) => {
  const { id, type, payload } = event.data || {};
  const ctx = {
    progress: (progress) => self.postMessage({ type: 'progress', requestId: id, progress }),
    stream: (data, transfer) => self.postMessage(
      { type: 'stream', requestId: id, data }, transfer || []),
  };
  try {
    const handler = handlers[type];
    if (!handler) throw new Error(`Richiesta sconosciuta: ${type}`);
    const out = await handler(payload || {}, ctx);
    if (out && out.transfer) self.postMessage({ id, result: out.result }, out.transfer);
    else self.postMessage({ id, result: out });
  } catch (err) {
    self.postMessage({ id, error: err && err.message ? err.message : String(err) });
  }
};

self.postMessage({ type: 'ready' });
