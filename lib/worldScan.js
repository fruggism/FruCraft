'use strict';
/*
 * World discovery.
 *
 * Save layouts differ a lot in the wild, so rather than assume the vanilla
 * folder names we search the save for any directory that actually contains
 * region files (r.X.Z.mca) and derive a dimension from where it sits:
 *
 *   <world>/region                                  -> overworld     (vanilla)
 *   <world>/DIM-1/region                            -> the_nether    (vanilla)
 *   <world>/DIM1/region                             -> the_end       (vanilla)
 *   <world>/dimensions/<ns>/<name>/region           -> <ns>_<name>   (datapack / custom)
 *   <world>/<anything>/region                       -> slug of the path
 *
 * Bounds come from the region file names alone, so scanning is instant even
 * for a huge world — no chunk is parsed here.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nbt = require('./nbt');

const REGION_RE = /^r\.(-?\d+)\.(-?\d+)\.mca$/;
const MAX_SEARCH_DEPTH = 6;   // deep enough for dimensions/<ns>/<name>/region
const EMPTY_REGION_BYTES = 8192; // header-only region file holds no chunks

// Directories that never contain map data — skipping them keeps the scan fast.
const SKIP_DIRS = new Set([
  'playerdata', 'stats', 'advancements', 'data', 'datapacks', 'poi', 'entities',
  'generated', 'serverconfig', 'backups', 'icons', 'crash-reports', 'logs',
  '.git', 'node_modules',
]);

const VANILLA_LABELS = {
  overworld: 'Overworld',
  the_nether: 'Nether',
  the_end: 'End',
};

function isWorldFolder(worldPath) {
  try {
    if (!fs.statSync(worldPath).isDirectory()) return false;
  } catch {
    return false;
  }
  if (fs.existsSync(path.join(worldPath, 'level.dat'))) return true;
  // A folder with region files but no level.dat is still usable.
  return !!findRegionDirs(worldPath, 3).length;
}

function readLevelDat(worldPath) {
  const file = path.join(worldPath, 'level.dat');
  if (!fs.existsSync(file)) return { levelName: path.basename(worldPath) };
  try {
    const root = nbt.parse(fs.readFileSync(file)).value;
    const d = root.Data || {};
    return {
      levelName: d.LevelName || path.basename(worldPath),
      version: (d.Version && d.Version.Name) || null,
      dataVersion: d.DataVersion ? Number(d.DataVersion) : null,
      spawn: {
        x: Number(d.SpawnX || 0),
        y: Number(d.SpawnY || 64),
        z: Number(d.SpawnZ || 0),
      },
    };
  } catch {
    return { levelName: path.basename(worldPath) };
  }
}

/**
 * Every directory under `root` that directly contains region files.
 *
 * The walk stops at any nested folder that has its own level.dat: that is a
 * separate world, and swallowing its regions would silently merge two saves
 * into one map (which is what happens if the user points at their "saves"
 * folder by mistake).
 */
function findRegionDirs(root, maxDepth = MAX_SEARCH_DEPTH) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    if (depth > 0 && fs.existsSync(path.join(dir, 'level.dat'))) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    let hasRegionFile = false;
    const subdirs = [];
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name.toLowerCase())) subdirs.push(e.name);
      } else if (!hasRegionFile && REGION_RE.test(e.name)) {
        hasRegionFile = true;
      }
    }
    if (hasRegionFile) {
      found.push(dir);
      return; // region dirs don't nest inside one another
    }
    for (const name of subdirs) walk(path.join(dir, name), depth + 1);
  };
  walk(root, 0);
  return found;
}

function slugifyId(s) {
  const slug = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return slug || 'dimensione';
}

/** Turn a region directory into a stable dimension id + human label. */
function identifyDimension(worldPath, regionDir) {
  const rel = path.relative(worldPath, regionDir).split(path.sep).filter(Boolean);
  // Drop the trailing "region" segment; what's left identifies the dimension.
  const parts = rel.slice(0, -1).filter((p) => p.toLowerCase() !== 'region');

  if (parts.length === 0) return { id: 'overworld', label: VANILLA_LABELS.overworld };
  if (parts.length === 1) {
    const only = parts[0].toUpperCase();
    if (only === 'DIM-1') return { id: 'the_nether', label: VANILLA_LABELS.the_nether };
    if (only === 'DIM1') return { id: 'the_end', label: VANILLA_LABELS.the_end };
  }

  // dimensions/<namespace>/<name>: the three vanilla dimensions live there too
  // in some setups, and they must not be mistaken for custom ones.
  const meaningful = parts[0].toLowerCase() === 'dimensions' ? parts.slice(1) : parts;
  if (meaningful.length >= 2 && meaningful[0].toLowerCase() === 'minecraft') {
    const name = slugifyId(meaningful.slice(1).join('_'));
    if (VANILLA_LABELS[name]) return { id: name, label: VANILLA_LABELS[name] };
    if (name === 'nether') return { id: 'the_nether', label: VANILLA_LABELS.the_nether };
    if (name === 'end') return { id: 'the_end', label: VANILLA_LABELS.the_end };
  }

  const id = slugifyId(meaningful.join('_'));
  if (VANILLA_LABELS[id]) return { id, label: VANILLA_LABELS[id] };
  return { id, label: meaningful.join(' / ') };
}

/** Index the region files of one directory: coordinates, bounds, total size. */
function indexRegionDir(regionDir) {
  let files;
  try {
    files = fs.readdirSync(regionDir);
  } catch {
    return null;
  }
  const regions = [];
  let bytes = 0;
  for (const f of files) {
    const m = REGION_RE.exec(f);
    if (!m) continue;
    let size = 0;
    try {
      size = fs.statSync(path.join(regionDir, f)).size;
    } catch {
      continue;
    }
    if (size <= EMPTY_REGION_BYTES) continue; // header only: no chunks inside
    regions.push({ x: parseInt(m[1], 10), z: parseInt(m[2], 10) });
    bytes += size;
  }
  if (!regions.length) return null;

  let minRX = Infinity, maxRX = -Infinity, minRZ = Infinity, maxRZ = -Infinity;
  for (const r of regions) {
    if (r.x < minRX) minRX = r.x;
    if (r.x > maxRX) maxRX = r.x;
    if (r.z < minRZ) minRZ = r.z;
    if (r.z > maxRZ) maxRZ = r.z;
  }
  return {
    regions,
    bytes,
    bounds: {
      minX: minRX * 512, minZ: minRZ * 512,
      maxX: (maxRX + 1) * 512 - 1, maxZ: (maxRZ + 1) * 512 - 1,
    },
  };
}

function scanWorld(worldPath) {
  let stat;
  try {
    stat = fs.statSync(worldPath);
  } catch {
    return { ok: false, error: `Percorso inesistente: ${worldPath}` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, error: 'Il percorso indicato non è una cartella.' };
  }

  const regionDirs = findRegionDirs(worldPath);
  if (!regionDirs.length) {
    // Maybe the user picked a folder that *contains* worlds (e.g. "saves").
    const nested = listNestedWorlds(worldPath);
    if (nested.length) {
      return {
        ok: false,
        error: 'Questa cartella contiene più mondi: scegline uno.',
        candidates: nested,
      };
    }
    return {
      ok: false,
      error: 'Nessun file di regione (.mca) trovato: assicurati di indicare la cartella del mondo.',
    };
  }

  const info = readLevelDat(worldPath);
  const dimensions = [];
  for (const dir of regionDirs) {
    const index = indexRegionDir(dir);
    if (!index) continue;
    const { id, label } = identifyDimension(worldPath, dir);
    dimensions.push({
      id,
      label,
      regionDir: dir,
      relativeDir: path.relative(worldPath, dir) || 'region',
      regionCount: index.regions.length,
      regions: index.regions,
      bytes: index.bytes,
      bounds: index.bounds,
    });
  }
  if (!dimensions.length) {
    return { ok: false, error: 'Trovate cartelle "region" ma senza chunk salvati.' };
  }

  // Overworld first, then the other vanilla dimensions, then the rest.
  const order = { overworld: 0, the_nether: 1, the_end: 2 };
  dimensions.sort((a, b) => (order[a.id] ?? 9) - (order[b.id] ?? 9) || a.label.localeCompare(b.label));

  return { ok: true, worldPath: path.resolve(worldPath), worldId: worldId(worldPath), ...info, dimensions };
}

/** Immediate subdirectories that look like worlds themselves. */
function listNestedWorlds(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(dir, e.name);
    if (fs.existsSync(path.join(full, 'level.dat')) || findRegionDirs(full, 3).length) {
      out.push({ name: e.name, path: full });
    }
    if (out.length >= 40) break;
  }
  return out;
}

/** Stable per-world id, used to key the tile cache on disk. */
function worldId(worldPath) {
  return crypto.createHash('sha1').update(path.resolve(worldPath)).digest('hex').slice(0, 16);
}

module.exports = {
  isWorldFolder, readLevelDat, scanWorld, worldId,
  findRegionDirs, identifyDimension, indexRegionDir, listNestedWorlds, slugifyId,
};
