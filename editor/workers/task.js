/*
 * Heavy work off the main process: Apply, search, the replace preview count.
 *
 * A worker gets everything as plain data — the world folder, the journal as
 * JSON, the query — rebuilds its own sources from it, and reports progress
 * back. Cancelling is terminating the worker: nothing it does touches the
 * original world, and an unfinished copy keeps its "incomplete" marker (the
 * main process removes it).
 */

import { parentPort, workerData } from 'node:worker_threads';
import { NodeSource } from '../core/nodeSource.js';
import { OverlaySource } from '../core/overlay.js';
import { Journal } from '../core/journal.js';
import { applyJournal } from '../core/apply.js';
import { search, countReplace } from '../core/search.js';
import { surveyArea } from '../core/survey.js';

const progress = (p) => parentPort.postMessage({ type: 'progress', p });

const TASKS = {
  async apply({ worldDir, journal, copyName, overwrite, skipLockCheck }) {
    const res = await applyJournal({
      worldDir, journal: Journal.fromJSON(journal), copyName, overwrite, onProgress: progress,
      ...(skipLockCheck ? { lockCheck: () => false } : {}),
    });
    return res;
  },
  async search({ worldDir, journal, dim, regions, selection, query, limit }) {
    const source = new OverlaySource(new NodeSource(worldDir), Journal.fromJSON(journal));
    return search({ source, dim, regions, selection, query, limit, onProgress: progress });
  },
  async survey({ worldDir, journal, dim, regions, selection }) {
    const source = new OverlaySource(new NodeSource(worldDir), Journal.fromJSON(journal));
    return surveyArea({ source, dim, regions, selection, onProgress: progress });
  },
  async countReplace({ worldDir, journal, dim, regions, op }) {
    const source = new OverlaySource(new NodeSource(worldDir), Journal.fromJSON(journal));
    return countReplace({ source, dim, regions, op, onProgress: progress });
  },
};

(async () => {
  try {
    const fn = TASKS[workerData.task];
    if (!fn) throw new Error(`Lavoro sconosciuto: ${workerData.task}`);
    parentPort.postMessage({ type: 'done', result: await fn(workerData.payload) });
  } catch (err) {
    parentPort.postMessage({ type: 'error', message: err.message, problems: err.problems, preflight: err.preflight });
  }
})();
