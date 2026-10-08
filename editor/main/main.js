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
const sessions = new Map();
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

const savesDir = () => readSettings().savesDir || defaultSavesDir();

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

const session = (id) => {
  const s = sessions.get(id);
  if (!s) throw new Error('Mondo non aperto');
  return s;
};

function registerIpc() {
  ipcMain.handle('settings:get', () => ({ savesDir: savesDir(), defaultSavesDir: defaultSavesDir() }));
  ipcMain.handle('settings:set', (_e, patch) => {
    if (patch && typeof patch.savesDir === 'string') writeSettings({ savesDir: patch.savesDir });
    return { savesDir: savesDir() };
  });
  ipcMain.handle('settings:pickSavesDir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: savesDir() });
    if (r.canceled || !r.filePaths[0]) return null;
    writeSettings({ savesDir: r.filePaths[0] });
    return r.filePaths[0];
  });

  ipcMain.handle('worlds:list', () => ({ dir: savesDir(), worlds: listWorlds(savesDir()) }));
  ipcMain.handle('worlds:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'], defaultPath: savesDir(), title: 'Apri un mondo',
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('world:open', async (_e, dir) => {
    const s = await WorldSession.open(dir, { dataDir: app.getPath('userData') });
    const id = nextId++;
    sessions.set(id, s);
    return { id, info: await s.info() };
  });
  ipcMain.handle('world:close', (_e, id) => { sessions.delete(id); });
  ipcMain.handle('world:info', (_e, id) => session(id).info());
  ipcMain.handle('world:tile', async (_e, id, dim, z, x, y, maxY) => {
    const rgba = await session(id).tile(dim, z, x, y, maxY);
    return rgba ? new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength) : null;
  });
  ipcMain.handle('world:probe', (_e, id, dim, x, z, maxY) => session(id).probe(dim, x, z, maxY));
  ipcMain.handle('journal:push', async (_e, id, op) => { const s = session(id); s.push(op); return s.info(); });
  ipcMain.handle('journal:undo', async (_e, id) => { const s = session(id); s.undo(); return s.info(); });
  ipcMain.handle('journal:redo', async (_e, id) => { const s = session(id); s.redo(); return s.info(); });
  ipcMain.handle('journal:ops', (_e, id) => ({ done: session(id).journal.ops, undone: session(id).journal.undone }));
  ipcMain.handle('apply:check', (_e, id) => session(id).check());
  ipcMain.handle('apply:run', async (_e, id, opts) => {
    const s = session(id);
    const res = await s.apply({
      copyName: opts && opts.copyName,
      overwrite: !!(opts && opts.overwrite),
      onProgress: (p) => { if (win && !win.isDestroyed()) win.webContents.send('apply:progress', id, p); },
    });
    return { ...res, info: await s.info() };
  });
  ipcMain.handle('shell:reveal', (_e, p) => { shell.showItemInFolder(p); });
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'Cube-Atlas Cantiere',
    backgroundColor: '#1b1d1f',
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
