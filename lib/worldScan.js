'use strict';
/*
 * World discovery: validate a save folder, read level.dat metadata, and work
 * out which dimensions exist and what area each one covers (from the region
 * file names, which is instant — no chunk parsing needed).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nbt = require('./nbt');
const { DIMENSIONS, regionFolder } = require('./anvil');

const REGION_RE = /^r\.(-?\d+)\.(-?\d+)\.mca$/;

function isWorldFolder(worldPath) {
  try {
    if (!fs.statSync(worldPath).isDirectory()) return false;
  } catch {
    return false;
  }
  return fs.existsSync(path.join(worldPath, 'level.dat'))
    || fs.existsSync(regionFolder(worldPath, 'overworld'));
}

function readLevelDat(worldPath) {
  const file = path.join(worldPath, 'level.dat');
  if (!fs.existsSync(file)) return {};
  try {
    const root = nbt.parse(fs.readFileSync(file)).value;
    const d = root.Data || {};
    return {
      levelName: d.LevelName || path.basename(worldPath),
      version: (d.Version && d.Version.Name) || null,
      dataVersion: d.DataVersion ? Number(d.DataVersion) : null,
      spawn: { x: Number(d.SpawnX || 0), y: Number(d.SpawnY || 64), z: Number(d.SpawnZ || 0) },
      lastPlayed: d.LastPlayed ? Number(d.LastPlayed) : null,
    };
  } catch {
    return { levelName: path.basename(worldPath) };
  }
}

/** List region coordinates present for a dimension, plus the block bounds they span. */
function scanDimension(worldPath, dimension) {
  const folder = regionFolder(worldPath, dimension);
  let files;
  try {
    files = fs.readdirSync(folder);
  } catch {
    return null;
  }
  const regions = [];
  for (const f of files) {
    const m = REGION_RE.exec(f);
    if (!m) continue;
    let size = 0;
    try { size = fs.statSync(path.join(folder, f)).size; } catch { /* ignore */ }
    if (size <= 8192) continue; // header-only / empty region
    regions.push({ x: parseInt(m[1], 10), z: parseInt(m[2], 10), size });
  }
  if (!regions.length) return null;

  let minRX = Infinity, maxRX = -Infinity, minRZ = Infinity, maxRZ = -Infinity;
  let bytes = 0;
  for (const r of regions) {
    if (r.x < minRX) minRX = r.x;
    if (r.x > maxRX) maxRX = r.x;
    if (r.z < minRZ) minRZ = r.z;
    if (r.z > maxRZ) maxRZ = r.z;
    bytes += r.size;
  }
  return {
    dimension,
    regionCount: regions.length,
    regions: regions.map(({ x, z }) => ({ x, z })),
    bytes,
    bounds: {
      minX: minRX * 512, minZ: minRZ * 512,
      maxX: (maxRX + 1) * 512 - 1, maxZ: (maxRZ + 1) * 512 - 1,
    },
  };
}

function scanWorld(worldPath) {
  if (!isWorldFolder(worldPath)) {
    return { ok: false, error: 'Cartella non riconosciuta come mondo Minecraft Java Edition (manca level.dat e/o region/).' };
  }
  const info = readLevelDat(worldPath);
  const dimensions = [];
  for (const dim of Object.keys(DIMENSIONS)) {
    const scan = scanDimension(worldPath, dim);
    if (scan) dimensions.push(scan);
  }
  if (!dimensions.length) {
    return { ok: false, error: 'Nessun file di regione (.mca) trovato in questo mondo.' };
  }
  return { ok: true, worldPath, ...info, dimensions, worldId: worldId(worldPath) };
}

/** Stable per-world id used to key the tile cache on disk. */
function worldId(worldPath) {
  return crypto.createHash('sha1').update(path.resolve(worldPath)).digest('hex').slice(0, 16);
}

module.exports = { isWorldFolder, readLevelDat, scanDimension, scanWorld, worldId };
