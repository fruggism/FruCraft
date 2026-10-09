/*
 * Cube-Atlas Cantiere — main process.
 *
 * Owns the disk. The window never touches the filesystem: it asks through a
 * small set of IPC calls (see preload.js), each of which lands on a
 * WorldSession. Nothing here knows how to edit a world; that is editor/core.
 */

import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { WorldSession, listWorlds, defaultSavesDir } from './session.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));

// For development and automated runs: a separate data folder and saves folder.
if (process.env.CANTIERE_DATA_DIR) app.setPath('userData', path.resolve(process.env.CANTIERE_DATA_DIR));
const sessions = new Map();
const tasks = new Map();   // taskId (chosen by the window) -> cancel()
let nextId = 1;
let win = null;

// ---------------------------------------------------------------------------
// Settings (a tiny JSON file in the app's data folder)
// ---------------------------------------------------------------------------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}

const savesDir = () => readSettings().savesDir || process.env.CANTIERE_SAVES_DIR || defaultSavesDir();

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

const session = (id) => {
  const s = sessions.get(id);
  if (!s) throw new Error('Mondo non aperto');
  return s;
};

function registerIpc() {
  const publicSettings = () => {
    const s = readSettings();
    return { savesDir: savesDir(), defaultSavesDir: defaultSavesDir(), theme: s.theme || 'dark', dev: !!s.dev, hideInvisible: s.hideInvisible !== false };
  };
  ipcMain.handle('settings:get', () => publicSettings());
  ipcMain.handle('settings:set', (_e, patch) => {
    const p = patch || {};
    const out = {};
    if (typeof p.savesDir === 'string') out.savesDir = p.savesDir;
    if (['dark', 'light', 'system'].includes(p.theme)) out.theme = p.theme;
    if (typeof p.dev === 'boolean') out.dev = p.dev;
    if (typeof p.hideInvisible === 'boolean') {
      out.hideInvisible = p.hideInvisible;
      for (const s of sessions.values()) s.setHideInvisible(p.hideInvisible);
    }
    writeSettings(out);
    return publicSettings();
  });
  ipcMain.handle('file:saveText', async (_e, name, text) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: name });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, text);
    return r.filePath;
  });
  ipcMain.handle('journal:remove', async (_e, id, index) => { const s = session(id); const r = s.removeAt(index); return { ...(await s.info()), dirty: r.dirty }; });
  ipcMain.handle('settings:pickSavesDir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: savesDir() });
    if (r.canceled || !r.filePaths[0]) return null;
    writeSettings({ savesDir: r.filePaths[0] });
    return r.filePaths[0];
  });

  ipcMain.handle('worlds:list', async () => ({ dir: savesDir(), worlds: await listWorlds(savesDir()) }));
  ipcMain.handle('worlds:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'], defaultPath: savesDir(), title: 'Apri un mondo',
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('world:open', async (_e, dir) => {
    const s = await WorldSession.open(dir, { dataDir: app.getPath('userData') });
    const id = nextId++;
    s.setHideInvisible(readSettings().hideInvisible !== false);
    s.onTilesReady = (box) => { if (win && !win.isDestroyed()) win.webContents.send('tiles:ready', id, box); };
    sessions.set(id, s);
    return { id, info: await s.info() };
  });
  ipcMain.handle('world:close', (_e, id) => { sessions.delete(id); });
  ipcMain.handle('world:info', (_e, id) => session(id).info());
  ipcMain.handle('world:tile', async (_e, id, dim, z, x, y, maxY, view) => {
    const rgba = await session(id).tile(dim, z, x, y, maxY, view || 'blocks');
    return rgba ? new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength) : null;
  });
  ipcMain.handle('world:probe', (_e, id, dim, x, z, maxY) => session(id).probe(dim, x, z, maxY));
  // Each returns the tab's info plus `dirty`: the block boxes the window must redraw.
  ipcMain.handle('journal:push', async (_e, id, op) => { const s = session(id); const r = s.push(op); return { ...(await s.info()), dirty: r.dirty }; });
  ipcMain.handle('journal:undo', async (_e, id) => { const s = session(id); const r = s.undo(); return { ...(await s.info()), dirty: r.dirty }; });
  ipcMain.handle('journal:redo', async (_e, id) => { const s = session(id); const r = s.redo(); return { ...(await s.info()), dirty: r.dirty }; });
  ipcMain.handle('journal:ops', (_e, id) => ({ done: session(id).journal.ops, undone: session(id).journal.undone }));
  ipcMain.handle('apply:check', (_e, id) => session(id).check());
  ipcMain.handle('apply:run', async (_e, id, opts, taskId) => {
    const s = session(id);
    const t = s.applyInWorker({
      copyName: opts && opts.copyName,
      overwrite: !!(opts && opts.overwrite),
      onProgress: progressTo(taskId),
    });
    const res = await track(taskId, t);
    return { ...res, info: await s.info() };
  });
  ipcMain.handle('world:search', (_e, id, dim, selection, query, taskId) => track(taskId, session(id).search(dim, selection, query, progressTo(taskId))));
  ipcMain.handle('world:countReplace', (_e, id, op, taskId) => track(taskId, session(id).countReplace(op, progressTo(taskId))));
  ipcMain.handle('task:cancel', async (_e, taskId) => { const c = tasks.get(taskId); if (c) await c(); });
  ipcMain.handle('shell:reveal', (_e, p) => { shell.showItemInFolder(p); });
  ipcMain.handle('shell:open', (_e, p) => { shell.openPath(p); });
}

const progressTo = (taskId) => (p) => {
  if (win && !win.isDestroyed()) win.webContents.send('task:progress', taskId, p);
};

/** Keep a task cancellable by its id until it ends. */
async function track(taskId, t) {
  if (taskId) tasks.set(taskId, t.cancel);
  try { return await t.promise; } finally { if (taskId) tasks.delete(taskId); }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'Cube-Atlas Cantiere',
    backgroundColor: '#14161a',
    // The traffic lights sit inside the first row of the window, as in the design.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 13 },
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(here, '..', 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  registerIpc();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
