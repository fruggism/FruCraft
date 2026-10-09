/*
 * Running a worker task with progress and cancel. No Electron here, so the
 * session (and the tests) can use it directly.
 */

import { Worker } from 'node:worker_threads';

const WORKER = new URL('../workers/task.js', import.meta.url);

/**
 * @returns {{ promise: Promise<any>, cancel: () => Promise<void> }}
 * The promise rejects with err.cancelled = true when cancelled.
 */
export function runTask(task, payload, onProgress = () => {}) {
  const worker = new Worker(WORKER, { workerData: { task, payload } });
  let cancelled = false;
  let settled = false;
  const promise = new Promise((resolve, reject) => {
    worker.on('message', (m) => {
      if (m.type === 'progress') onProgress(m.p);
      else if (m.type === 'done') { settled = true; resolve(m.result); worker.terminate(); }
      else if (m.type === 'error') {
        settled = true;
        reject(Object.assign(new Error(m.message), { problems: m.problems, preflight: m.preflight }));
        worker.terminate();
      }
    });
    worker.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
    worker.on('exit', () => {
      if (settled) return;
      settled = true;
      reject(Object.assign(new Error(cancelled ? 'Annullato.' : 'Il lavoro si è interrotto.'), { cancelled }));
    });
  });
  return {
    promise,
    cancel: async () => { if (settled) return; cancelled = true; await worker.terminate(); },
  };
}
