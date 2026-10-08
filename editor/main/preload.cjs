/*
 * The only door between the window and the main process. The window gets a
 * handful of named calls and nothing else: no Node, no filesystem.
 * (CommonJS because a sandboxed preload can't be an ES module.)
 */

const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('cantiere', {
  settings: { get: call('settings:get'), set: call('settings:set'), pickSavesDir: call('settings:pickSavesDir') },
  worlds: { list: call('worlds:list'), pick: call('worlds:pick') },
  world: {
    open: call('world:open'),
    close: call('world:close'),
    info: call('world:info'),
    tile: call('world:tile'),
    probe: call('world:probe'),
  },
  journal: { push: call('journal:push'), undo: call('journal:undo'), redo: call('journal:redo'), ops: call('journal:ops') },
  apply: {
    check: call('apply:check'),
    run: call('apply:run'),
    onProgress: (fn) => {
      const handler = (_e, id, p) => fn(id, p);
      ipcRenderer.on('apply:progress', handler);
      return () => ipcRenderer.removeListener('apply:progress', handler);
    },
  },
  reveal: call('shell:reveal'),
});
