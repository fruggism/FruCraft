/*
 * The worlds inside a saves folder.
 *
 * The usual thing to pick is `.minecraft/saves`, not a single world: picked
 * once, it is remembered, and every world in it is one click away. This lists
 * them with what a player recognises them by — name, last played, game mode,
 * version, the world's own icon — and says up front which ones cannot be
 * read, instead of letting the user find out after a scan.
 *
 * Nothing here parses a chunk: level.dat and directory listings only, so the
 * list is quick even for a folder of big worlds.
 */

import { findRegionDirs, readLevelDat } from './worldScan.js';
import { SubSource } from './source.js';

export { SubSource };

/** DataVersion of 1.13, where block states replaced numeric ids. */
export const MIN_DATA_VERSION = 1519;

const REGION_RE = /^r\.(-?\d+)\.(-?\d+)\.mca$/;

export const GAME_TYPES = ['Sopravvivenza', 'Creativa', 'Avventura', 'Spettatore'];

const at = (source, path) => (path ? new SubSource(source, path) : source);

/** True when the folder itself is a world rather than a folder of worlds. */
async function isWorld(source) {
  if (await source.exists('level.dat')) return true;
  const entries = await source.listEntries('region').catch(() => []);
  return entries.some((e) => !e.isDirectory && REGION_RE.test(e.name));
}

/**
 * Everything the world list shows for one world, read from level.dat and the
 * region folders.
 *
 * `readable` is false — with `reason` saying why — for worlds older than
 * 1.13, whose chunks store numeric block ids this app cannot decode, and for
 * worlds with no saved region at all.
 */
export async function describeWorld(source, path = '') {
  const world = at(source, path);
  const hasLevel = await world.exists('level.dat');
  const info = hasLevel ? await readLevelDat(world) : { levelName: world.name };

  let regionCount = 0;
  const dirs = await findRegionDirs(world).catch(() => []);
  for (const dir of dirs) {
    const entries = await world.listEntries(dir).catch(() => []);
    regionCount += entries.filter((e) => !e.isDirectory && REGION_RE.test(e.name)).length;
  }

  let readable = true;
  let reason = null;
  // No DataVersion at all means older than 1.9; anything below 1519 is
  // before the 1.13 rewrite. A bare region folder with no level.dat cannot
  // be dated, so it gets the benefit of the doubt.
  if (hasLevel && (info.dataVersion == null || info.dataVersion < MIN_DATA_VERSION)) {
    readable = false;
    reason = `${info.version || 'versione antica'}: formato precedente alla 1.13, non leggibile`;
  } else if (!regionCount) {
    readable = false;
    reason = 'nessuna regione salvata: il mondo non è mai stato esplorato';
  }

  const icon = await world.readFile('icon.png').catch(() => null);

  return {
    path,
    folder: path ? path.split('/').pop() : source.name,
    levelName: info.levelName || world.name,
    lastPlayed: info.lastPlayed ?? null,
    version: info.version || null,
    dataVersion: info.dataVersion ?? null,
    gameType: info.gameType ?? null,
    gameTypeLabel: GAME_TYPES[info.gameType] || null,
    regionCount,
    icon: icon && icon.length ? icon : null,
    readable,
    reason,
  };
}

/**
 * The worlds in a picked folder, most recently played first.
 *
 * `single` is true when the folder was a world itself: the list then holds
 * just that one, with `path` empty.
 */
export async function listWorlds(source) {
  if (await isWorld(source)) {
    return { single: true, worlds: [await describeWorld(source, '')] };
  }
  let entries;
  try {
    entries = await source.listEntries('');
  } catch {
    entries = [];
  }
  const worlds = [];
  for (const e of entries) {
    if (!e.isDirectory || e.name.startsWith('.')) continue;
    const sub = new SubSource(source, e.name);
    if (!(await isWorld(sub))) continue;
    worlds.push(await describeWorld(source, e.name));
    if (worlds.length >= 200) break;
  }
  worlds.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0)
    || a.levelName.localeCompare(b.levelName));
  return { single: false, worlds };
}
