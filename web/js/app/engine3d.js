/*
 * Page-side client for the worker: promise-based requests, plus progress and
 * streamed chunk meshes for the long reads.
 */

const WORKER_URL = new URL('../worker3d.js', import.meta.url);

class Engine {
  constructor() {
    this.worker = null;
    this.nextId = 1;
    this.pending = new Map();
    this.progress = new Map();
    this.streams = new Map();
  }

  start() {
    if (this.worker) return;
    this.worker = new Worker(WORKER_URL, { type: 'module' });
    this.worker.onmessage = (event) => {
      const { id, result, error, type, requestId, progress, data } = event.data || {};
      if (type === 'ready') return;
      if (type === 'progress') {
        const cb = this.progress.get(requestId);
        if (cb) cb(progress);
        return;
      }
      if (type === 'stream') {
        const cb = this.streams.get(requestId);
        if (cb) cb(data);
        return;
      }
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      this.progress.delete(id);
      this.streams.delete(id);
      if (error) entry.reject(new Error(error));
      else entry.resolve(result);
    };
    this.worker.onerror = (e) => {
      const message = e.message || 'Errore nel motore';
      for (const [, entry] of this.pending) entry.reject(new Error(message));
      this.pending.clear();
    };
  }

  /** Drop the worker entirely — the surest way to release a big volume. */
  stop() {
    if (!this.worker) return;
    this.worker.terminate();
    this.worker = null;
    this.pending.clear();
    this.progress.clear();
    this.streams.clear();
  }

  request(type, payload, { onProgress, onStream } = {}) {
    this.start();
    const id = this.nextId++;
    if (onProgress) this.progress.set(id, onProgress);
    if (onStream) this.streams.set(id, onStream);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload: payload || {} });
    });
  }

  openWorld(init) { return this.request('openWorld', { init }); }
  openPack(files) { return this.request('openPack', { files }); }
  closePack() { return this.request('closePack', {}); }
  player() { return this.request('player', {}); }
  survey(payload) { return this.request('survey', payload); }
  load(payload, handlers) { return this.request('load', payload, handlers); }
}

export const engine = new Engine();
