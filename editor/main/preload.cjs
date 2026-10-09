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
  icon: { fromFile: call('icon:fromFile'), fromView: call('icon:fromView') },
  world: {
    open: call('world:open'),
    close: call('world:close'),
    info: call('world:info'),
    tile: call('world:tile'),
    probe: call('world:probe'),
    search: call('world:search'),
    countReplace: call('world:countReplace'),
  },
  journal: { push: call('journal:push'), undo: call('journal:undo'), redo: call('journal:redo'), remove: call('journal:remove'), ops: call('journal:ops') },
  claude: { status: call('claude:status'), ask: call('claude:ask') },
  apply: {
    check: call('apply:check'),
    run: call('apply:run'),
  },
  task: {
    cancel: call('task:cancel'),
    onProgress: (fn) => {
      const handler = (_e, taskId, p) => fn(taskId, p);
      ipcRenderer.on('task:progress', handler);
      return () => ipcRenderer.removeListener('task:progress', handler);
    },
  },
  onTilesReady: (fn) => {
    const handler = (_e, id, box) => fn(id, box);
    ipcRenderer.on('tiles:ready', handler);
    return () => ipcRenderer.removeListener('tiles:ready', handler);
  },
  platform: process.platform,
  reveal: call('shell:reveal'),
  openPath: call('shell:open'),
  saveText: call('file:saveText'),
});
