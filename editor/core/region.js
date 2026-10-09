/*
 * Anvil region files (.mca), read AND write.
 *
 * The reader in web/js/core/anvil.js is built for drawing maps: it decodes a
 * chunk on demand and never keeps anything but the bytes. The editor needs the
 * opposite — to change a few chunks and put every other chunk back exactly as
 * it was. So a RegionData holds each chunk as its *compressed payload* and only
 * decodes the ones somebody asks for; the ones nobody touches are copied to the
 * new file byte for byte, without being inflated and deflated again.
 *
 * File layout: 4 KiB of locations (3 bytes first sector + 1 byte sector count),
 * 4 KiB of timestamps, then chunks, each in whole 4 KiB sectors as
 * [u32 length][u8 compression][payload]. A chunk that would need 256 sectors or
 * more (>= 1 MiB) is stored apart in `c.<x>.<z>.mcc`, and the region keeps a
 * one-byte stub with the compression id OR-ed with 128.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { parseRaw } from '../../web/js/core/nbt.js';
import { writeNbt } from '../../web/js/core/nbtWrite.js';

export const SECTOR = 4096;
const HEADER = 2 * SECTOR;
const MAX_INLINE_SECTORS = 255;

export const COMPRESSION = { GZIP: 1, ZLIB: 2, NONE: 3, LZ4: 4 };

const chunkIndex = (lx, lz) => (lx & 31) + (lz & 31) * 32;

export class RegionData {
  constructor(rx, rz) {
    this.rx = rx;
    this.rz = rz;
    // index -> { timestamp, compression, data (compressed payload), dirty }
    this.entries = new Map();
  }

  /** Parse a region file's bytes. `dir` is where external .mcc files live (or a Map of them). */
  static fromBuffer(buf, rx, rz, dir = null) {
    const region = new RegionData(rx, rz);
    if (buf.length < HEADER) return region;
    for (let i = 0; i < 1024; i++) {
      const o = i * 4;
      const sector = (buf[o] << 16) | (buf[o + 1] << 8) | buf[o + 2];
      const count = buf[o + 3];
      if (!sector || !count) continue;
      const start = sector * SECTOR;
      if (start + 5 > buf.length) continue;
      const length = buf.readUInt32BE(start);
      if (length < 1 || start + 4 + length > buf.length) continue;
      let compression = buf[start + 4];
      const timestamp = buf.readUInt32BE(SECTOR + i * 4);
      let data;
      if (compression & 128) {
        compression &= 127;
        if (!dir) continue;
        const cx = rx * 32 + (i & 31);
        const cz = rz * 32 + (i >> 5);
        // `dir` is a folder, or a Map of the .mcc files already read (name -> bytes).
        if (dir instanceof Map) { data = dir.get(`c.${cx}.${cz}.mcc`); if (!data) continue; }
        else { try { data = fs.readFileSync(path.join(dir, `c.${cx}.${cz}.mcc`)); } catch { continue; } }
      } else {
        data = Buffer.from(buf.subarray(start + 5, start + 4 + length));
      }
      region.entries.set(i, { timestamp, compression, data, dirty: false });
    }
    return region;
  }

  has(lx, lz) { return this.entries.has(chunkIndex(lx, lz)); }

  /** Local coordinates of every stored chunk. */
  chunks() {
    return [...this.entries.keys()].sort((a, b) => a - b).map((i) => ({ lx: i & 31, lz: i >> 5 }));
  }

  /** Decode one chunk. `typed` keeps tag types so the tree can be written back. */
  getChunk(lx, lz, { typed = true } = {}) {
    const e = this.entries.get(chunkIndex(lx, lz));
    if (!e) return null;
    return parseRaw(inflate(e), { typed });
  }

  setChunk(lx, lz, root, name = '', timestamp = Math.floor(Date.now() / 1000)) {
    const data = zlib.deflateSync(writeNbt(root, name));
    this.entries.set(chunkIndex(lx, lz), { timestamp, compression: COMPRESSION.ZLIB, data, dirty: true });
  }

  deleteChunk(lx, lz) { return this.entries.delete(chunkIndex(lx, lz)); }

  get size() { return this.entries.size; }

  /**
   * Lay the region out again, chunks packed one after the other in index order.
   * Returns the region file and the external files it needs.
   */
  serialize() {
    const parts = [];
    const externals = new Map();
    const locations = Buffer.alloc(SECTOR);
    const timestamps = Buffer.alloc(SECTOR);
    let sector = 2;
    for (const i of [...this.entries.keys()].sort((a, b) => a - b)) {
      const e = this.entries.get(i);
      let body;
      if (5 + e.data.length > MAX_INLINE_SECTORS * SECTOR) {
        const cx = this.rx * 32 + (i & 31);
        const cz = this.rz * 32 + (i >> 5);
        externals.set(`c.${cx}.${cz}.mcc`, e.data);
        body = Buffer.alloc(5);
        body.writeUInt32BE(1, 0);
        body[4] = e.compression | 128;
      } else {
        body = Buffer.alloc(5 + e.data.length);
        body.writeUInt32BE(e.data.length + 1, 0);
        body[4] = e.compression;
        e.data.copy(body, 5);
      }
      const count = Math.ceil(body.length / SECTOR);
      const padded = Buffer.alloc(count * SECTOR);
      body.copy(padded);
      locations[i * 4] = (sector >> 16) & 255;
      locations[i * 4 + 1] = (sector >> 8) & 255;
      locations[i * 4 + 2] = sector & 255;
      locations[i * 4 + 3] = count;
      timestamps.writeUInt32BE(e.timestamp >>> 0, i * 4);
      parts.push(padded);
      sector += count;
    }
    return { file: Buffer.concat([locations, timestamps, ...parts]), externals };
  }
}

function inflate(e) {
  switch (e.compression) {
    case COMPRESSION.GZIP: return zlib.gunzipSync(e.data);
    case COMPRESSION.ZLIB: return zlib.inflateSync(e.data);
    case COMPRESSION.NONE: return e.data;
    default: throw new Error(`Compressione del chunk non supportata (${e.compression})`);
  }
}

/** Name of the region file holding chunk (cx, cz). */
export const regionFileName = (cx, cz) => `r.${cx >> 5}.${cz >> 5}.mca`;

export function readRegionFile(file) {
  const m = /r\.(-?\d+)\.(-?\d+)\.mca$/.exec(file);
  if (!m) throw new Error(`Nome di regione non valido: ${file}`);
  const buf = fs.readFileSync(file);
  return RegionData.fromBuffer(buf, Number(m[1]), Number(m[2]), path.dirname(file));
}

/**
 * Write atomically: everything goes to temporary names first and the region is
 * swapped in with a rename, so a crash leaves either the old file or the new
 * one, never half of each. Stale .mcc files of chunks that no longer need one
 * are removed afterwards.
 */
export function writeRegionFile(file, region) {
  const dir = path.dirname(file);
  const { file: bytes, externals } = region.serialize();
  const tmpMcc = [];
  for (const [name, data] of externals) {
    const tmp = path.join(dir, `${name}.cantiere-tmp`);
    fs.writeFileSync(tmp, data);
    tmpMcc.push([tmp, path.join(dir, name)]);
  }
  const tmp = `${file}.cantiere-tmp`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, file);
  for (const [from, to] of tmpMcc) fs.renameSync(from, to);

  const prefix = new RegExp(`^c\\.(-?\\d+)\\.(-?\\d+)\\.mcc$`);
  for (const name of fs.readdirSync(dir)) {
    const m = prefix.exec(name);
    if (!m || externals.has(name)) continue;
    if ((Number(m[1]) >> 5) === region.rx && (Number(m[2]) >> 5) === region.rz) {
      fs.rmSync(path.join(dir, name));
    }
  }
}
