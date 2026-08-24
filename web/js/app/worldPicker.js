/*
 * Choosing the world folder.
 *
 * Two ways in, because browsers differ:
 *   - File System Access API (Chrome, Edge): gives a handle we can store in
 *     IndexedDB, so the app reopens the same world next time.
 *   - <input type="file" webkitdirectory> (Safari, Firefox, and anywhere the
 *     first path is unavailable): gives a flat list of files. It works fine
 *     for reading, but the folder has to be picked again each session.
 *
 * Either way the files are read locally. Nothing is uploaded.
 */

import { idbGet, idbPut, idbDelete } from './db.js';

const HANDLE_KEY = 'lastWorld';

export const supportsHandles = typeof window !== 'undefined'
  && typeof window.showDirectoryPicker === 'function'
  && window.isSecureContext;

/** Ask the user for a folder using the File System Access API. */
export async function pickDirectory() {
  const handle = await window.showDirectoryPicker({ id: 'cube-atlas-world', mode: 'read' });
  await rememberHandle(handle);
  return { kind: 'handle', handle, name: handle.name };
}

async function rememberHandle(handle) {
  try {
    await idbPut('handles', handle, HANDLE_KEY);
  } catch { /* private mode: we simply won't remember it */ }
}

export async function forgetWorld() {
  try { await idbDelete('handles', HANDLE_KEY); } catch { /* ignore */ }
}

/**
 * The world opened last time, if the browser still grants access.
 * Returns null when there is none or permission was not granted.
 */
export async function restoreLastWorld({ prompt = false } = {}) {
  if (!supportsHandles) return null;
  let handle;
  try {
    handle = await idbGet('handles', HANDLE_KEY);
  } catch {
    return null;
  }
  if (!handle) return null;
  try {
    const opts = { mode: 'read' };
    let state = await handle.queryPermission(opts);
    if (state !== 'granted' && prompt) state = await handle.requestPermission(opts);
    if (state !== 'granted') return { needsPermission: true, handle, name: handle.name };
    return { kind: 'handle', handle, name: handle.name };
  } catch {
    return null;
  }
}

/**
 * Turn the FileList of a webkitdirectory input into the worker's source
 * description: a map of path-relative-to-the-world-root -> File.
 */
export function sourceFromFileList(fileList) {
  const files = new Map();
  let rootName = 'mondo';
  for (const file of fileList) {
    const rel = file.webkitRelativePath || file.name;
    const parts = rel.split('/');
    if (parts.length > 1) {
      rootName = parts[0];
      files.set(parts.slice(1).join('/'), file);
    } else {
      files.set(rel, file);
    }
  }
  return { kind: 'files', files, name: rootName };
}
