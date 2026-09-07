/*
 * Choosing where the textures come from.
 *
 * The sprites are not ours to ship: they live inside the game's own
 * `versions/<versione>/<versione>.jar`, which the user already has. So the
 * app asks for that file (or for a resource pack), reads it locally like it
 * reads the world, and remembers the choice for next time.
 *
 * Same two ways in as the world folder: a file handle where the browser
 * offers one, an <input type="file"> everywhere else.
 */

import { idbGet, idbPut, idbDelete } from './db.js';

const PACK_KEY = 'lastPack';

export const supportsFileHandles = typeof window !== 'undefined'
  && typeof window.showOpenFilePicker === 'function'
  && window.isSecureContext;

const PICKER_TYPES = [{
  description: 'Minecraft (.jar) o resource pack (.zip)',
  accept: { 'application/java-archive': ['.jar'], 'application/zip': ['.zip'] },
}];

/** Ask for the jar (and optionally a resource pack to layer over it). */
export async function pickPack() {
  const handles = await window.showOpenFilePicker({
    id: 'cube-atlas-pack', multiple: true, types: PICKER_TYPES,
  });
  try {
    await idbPut('handles', handles, PACK_KEY);
  } catch { /* private mode: we simply won't remember it */ }
  return Promise.all(handles.map((handle) => handle.getFile()));
}

export async function forgetPack() {
  try { await idbDelete('handles', PACK_KEY); } catch { /* ignore */ }
}

/**
 * The pack chosen last time, if the browser still grants access.
 * `{ needsPermission: true }` when it does not, null when there is none.
 */
export async function restoreLastPack({ prompt = false } = {}) {
  if (!supportsFileHandles) return null;
  let handles;
  try {
    handles = await idbGet('handles', PACK_KEY);
  } catch {
    return null;
  }
  if (!handles || !handles.length) return null;
  try {
    const files = [];
    for (const handle of handles) {
      let state = await handle.queryPermission({ mode: 'read' });
      if (state !== 'granted' && prompt) state = await handle.requestPermission({ mode: 'read' });
      if (state !== 'granted') return { needsPermission: true, names: handles.map((h) => h.name) };
      files.push(await handle.getFile());
    }
    return { files, names: files.map((f) => f.name) };
  } catch {
    return null;
  }
}

/** The FileList of the fallback input, in the order the user picked them. */
export const packFromFileList = (fileList) => Array.from(fileList);
