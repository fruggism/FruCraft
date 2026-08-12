/*
 * World discovery.
 *
 * Save layouts differ a lot in the wild, so rather than assume the vanilla
 * folder names we search the save for any directory that actually contains
 * region files (r.X.Z.mca) and derive a dimension from where it sits:
 *
 *   region/                                -> overworld     (vanilla)
 *   DIM-1/region/                          -> the_nether
 *   DIM1/region/                           -> the_end
 *   dimensions/<ns>/<name>/region/         -> the vanilla three when the
 *                                             namespace is "minecraft",
 *                                             otherwise a custom dimension
 *
 * Bounds come from the region file names alone, so a scan is instant even for
 * a huge world: no chunk is parsed here.
 */

import { parse } from './nbt.js';
import { joinPath } from './source.js';

const REGION_RE = /^r\.(-?\d+)\.(-?\d+)\.mca$/;
const MAX_SEARCH_DEPTH = 6;
const EMPTY_REGION_BYTES = 8192; // header-only region file holds no chunks

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

export function slugifyId(s) {
  const slug = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return slug || 'dimensione';
}

/**
 * Every directory containing region files.
 *
 * The walk stops at any nested folder with its own level.dat: that is a
 * separate world, and absorbing its regions would silently merge two saves
 * into one map — which is exactly what happens if someone points the app at
 * their "saves" folder.
 */
export async function findRegionDirs(source, maxDepth = MAX_SEARCH_DEPTH) {
  const found = [];

  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    if (depth > 0 && await source.exists(joinPath(dir, 'level.dat'))) return;

    let entries;
    try {
      entries = await source.listEntries(dir);
    } catch {
      return;
    }
    let hasRegionFile = false;
    const subdirs = [];
    for (const e of entries) {
      if (e.isDirectory) {
        if (!SKIP_DIRS.has(e.name.toLowerCase())) subdirs.push(e.name);
      } else if (!hasRegionFile && REGION_RE.test(e.name)) {
        hasRegionFile = true;
      }
    }
    if (hasRegionFile) {
      found.push(dir);
      return; // region dirs never nest inside one another
    }
    for (const name of subdirs) await walk(joinPath(dir, name), depth + 1);
  }

  await walk('', 0);
  return found;
}

/** Turn a region directory into a stable dimension id + human label. */
export function identifyDimension(regionDir) {
  const parts = String(regionDir).split('/').filter(Boolean)
    .filter((p) => p.toLowerCase() !== 'region');

  if (parts.length === 0) return { id: 'overworld', label: VANILLA_LABELS.overworld };
  if (parts.length === 1) {
    const only = parts[0].toUpperCase();
    if (only === 'DIM-1') return { id: 'the_nether', label: VANILLA_LABELS.the_nether };
    if (only === 'DIM1') return { id: 'the_end', label: VANILLA_LABELS.the_end };
  }

  // dimensions/<ns>/<name>: the vanilla three live there in some setups and
  // must not be mistaken for custom dimensions.
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

/** Index one region directory: coordinates, bounds, total size. */
export async function indexRegionDir(source, regionDir) {
  let entries;
  try {
    entries = await source.listEntries(regionDir);
  } catch {
    return null;
  }
  const regions = [];
  let bytes = 0;
  for (const e of entries) {
    if (e.isDirectory) continue;
    const m = REGION_RE.exec(e.name);
    if (!m) continue;
    const size = await source.fileSize(joinPath(regionDir, e.name));
    if (size == null || size <= EMPTY_REGION_BYTES) continue;
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

export async function readLevelDat(source) {
  const bytes = await source.readFile('level.dat');
  if (!bytes) return { levelName: source.name };
  try {
    const { value } = await parse(bytes);
    const d = value.Data || {};
    return {
      levelName: d.LevelName || source.name,
      version: (d.Version && d.Version.Name) || null,
      dataVersion: d.DataVersion ? Number(d.DataVersion) : null,
      spawn: {
        x: Number(d.SpawnX || 0),
        y: Number(d.SpawnY || 64),
        z: Number(d.SpawnZ || 0),
      },
    };
  } catch {
    return { levelName: source.name };
  }
}

/** Sub-folders that look like worlds themselves (for "you picked saves/"). */
export async function listNestedWorlds(source) {
  const out = [];
  let entries;
  try {
    entries = await source.listEntries('');
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory) continue;
    if (await source.exists(joinPath(e.name, 'level.dat'))) {
      out.push({ name: e.name, path: e.name });
      continue;
    }
    const dirs = await findRegionDirsUnder(source, e.name, 3);
    if (dirs.length) out.push({ name: e.name, path: e.name });
    if (out.length >= 40) break;
  }
  return out;
}

async function findRegionDirsUnder(source, prefix, maxDepth) {
  const found = [];
  async function walk(dir, depth) {
    if (depth > maxDepth || found.length) return;
    let entries;
    try { entries = await source.listEntries(dir); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory && REGION_RE.test(e.name)) { found.push(dir); return; }
    }
    for (const e of entries) {
      if (e.isDirectory && !SKIP_DIRS.has(e.name.toLowerCase())) {
        await walk(joinPath(dir, e.name), depth + 1);
      }
    }
  }
  await walk(prefix, 0);
  return found;
}

export async function scanWorld(source) {
  const regionDirs = await findRegionDirs(source);
  if (!regionDirs.length) {
    const nested = await listNestedWorlds(source);
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

  const info = await readLevelDat(source);
  const dimensions = [];
  for (const dir of regionDirs) {
    const index = await indexRegionDir(source, dir);
    if (!index) continue;
    const { id, label } = identifyDimension(dir);
    dimensions.push({
      id, label,
      regionDir: dir,
      relativeDir: dir || 'region',
      regionCount: index.regions.length,
      regions: index.regions,
      bytes: index.bytes,
      bounds: index.bounds,
    });
  }
  if (!dimensions.length) {
    return { ok: false, error: 'Trovate cartelle "region" ma senza chunk salvati.' };
  }

  const order = { overworld: 0, the_nether: 1, the_end: 2 };
  dimensions.sort((a, b) => (order[a.id] ?? 9) - (order[b.id] ?? 9) || a.label.localeCompare(b.label));

  return { ok: true, worldKey: source.key, ...info, dimensions };
}
