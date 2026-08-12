/*
 * Cube-Atlas — Archivio: the empire's documents.
 *
 * Independent of any atlas — no world or project needs to be open to write
 * or read one. Each entry is one signed, immutable version of a book: code,
 * creation date and author are stamped once (app/documents.js) and never
 * change again. Editing an old version isn't possible; a new version is
 * forked from it instead, and the book still exports as a Minecraft written
 * book, built locally so the preview updates as you type with no round trip.
 */

import {
  el, escapeHtml, toast, debounce, confirmDialog, promptDialog, download,
  slugify, setStatus,
} from './ui-core.js';
import * as book from '../core/book.js';
import * as Documents from './documents.js';

let allDocs = [];
let selectedDocId = null;
let lastExport = null;

function selected() {
  return allDocs.find((d) => d.id === selectedDocId) || null;
}

async function refreshList() {
  try {
    allDocs = await Documents.listDocuments();
  } catch (err) {
    setStatus('doc-status', `Archivio non disponibile: ${err.message}`, 'err');
    allDocs = [];
  }
  renderList();
}

// ------------------------------------------------------------------ list
function renderList() {
  const host = el('doc-list');
  const query = (el('doc-search').value || '').trim().toLowerCase();
  const matches = query
    ? allDocs.filter((d) => `${d.title} ${d.body}`.toLowerCase().includes(query))
    : allDocs;

  el('doc-empty').classList.toggle('hidden', matches.length > 0);
  if (!matches.length) {
    host.innerHTML = '';
    el('doc-empty').textContent = allDocs.length
      ? 'Nessun documento corrisponde alla ricerca.'
      : 'Nessun documento. Creane uno.';
    return;
  }

  host.innerHTML = matches.map((d) => {
    const preview = (d.body || '').replace(/\s+/g, ' ').slice(0, 60);
    const when = d.updatedAt ? new Date(d.updatedAt).toLocaleDateString('it-IT') : '';
    const locked = !Documents.isLatest(d, allDocs);
    return `<li class="doc-item ${d.id === selectedDocId ? 'selected' : ''}" data-id="${d.id}">
      <b class="${locked ? 'locked' : ''}">${escapeHtml(d.title || 'Senza titolo')}</b>
      <small>${escapeHtml(preview)}${preview.length === 60 ? '…' : ''}</small>
      <small>${escapeHtml(d.code || '')} · ${when}</small>
    </li>`;
  }).join('');

  host.querySelectorAll('.doc-item').forEach((node) => {
    node.addEventListener('click', () => select(node.dataset.id));
  });
}

// ---------------------------------------------------------------- editor
function select(id) {
  selectedDocId = id;
  const doc = selected();
  el('editor-empty').classList.toggle('hidden', !!doc);
  el('editor-fields').classList.toggle('hidden', !doc);
  if (doc) {
    const latest = Documents.isLatest(doc, allDocs);
    const versionNumber = Documents.history(doc, allDocs).length; // 1 = original, 2 = its first fork, ...
    const when = doc.createdAt ? new Date(doc.createdAt).toLocaleString('it-IT') : '';
    el('doc-meta').textContent = `Codice ${doc.code} · versione ${versionNumber}`
      + `${latest ? '' : ' (precedente)'} · ${when} · firmato da ${doc.author}`;
    el('doc-locked-banner').classList.toggle('hidden', latest);
    el('doc-title').value = doc.title || '';
    el('doc-title').disabled = !latest;
    el('doc-body').value = doc.body || '';
    el('doc-body').disabled = !latest;
    refreshBook();
  }
  renderList();
}

async function createDoc() {
  const author = await promptDialog({
    title: 'Nuovo documento', message: 'Chi lo scrive? (la data si registra da sola)', confirmLabel: 'Crea',
  });
  if (author === null) return;
  try {
    const doc = await Documents.createDocument({ author: author.trim() || 'Anonimo', title: 'Nuovo documento' });
    await refreshList();
    select(doc.id);
    el('doc-title').focus();
    el('doc-title').select();
  } catch (err) {
    toast(`Creazione fallita: ${err.message}`, 'err');
  }
}

async function forkDoc() {
  const doc = selected();
  if (!doc) return;
  const author = await promptDialog({
    title: 'Nuova versione', message: 'Chi firma questa nuova versione?', confirmLabel: 'Crea',
  });
  if (author === null) return;
  try {
    const fork = await Documents.forkDocument(doc.id, { author: author.trim() || 'Anonimo' });
    await refreshList();
    select(fork.id);
    toast(`Nuova versione creata (${fork.code})`, 'ok');
  } catch (err) {
    toast(`Impossibile creare una nuova versione: ${err.message}`, 'err');
  }
}

async function deleteDoc() {
  const doc = selected();
  if (!doc) return;
  const ok = await confirmDialog({
    title: 'Eliminare questa versione?',
    message: `"${doc.title || 'Senza titolo'}" (${doc.code}) verrà rimossa dall'archivio. Le altre versioni non sono toccate.`,
    confirmLabel: 'Elimina', danger: true,
  });
  if (!ok) return;
  try {
    await Documents.deleteDocument(doc.id);
    selectedDocId = null;
    await refreshList();
    select(null);
    toast('Versione eliminata');
  } catch (err) {
    toast(`Eliminazione fallita: ${err.message}`, 'err');
  }
}

const onEdit = debounce(async () => {
  const doc = selected();
  if (!doc) return;
  setStatus('doc-status', 'Salvataggio…', 'busy');
  try {
    const saved = await Documents.saveDocument(doc.id, {
      title: el('doc-title').value,
      body: el('doc-body').value,
    });
    const idx = allDocs.findIndex((d) => d.id === saved.id);
    if (idx >= 0) allDocs[idx] = saved;
    renderList();
    refreshBook();
    setStatus('doc-status', 'Salvato', 'ok');
  } catch (err) {
    // Most likely: this version got superseded by a fork from another tab
    // while it was being edited here. Resync so the UI stops lying about
    // what's actually editable.
    setStatus('doc-status', `Salvataggio fallito: ${err.message}`, 'err');
    await refreshList();
    select(doc.id);
  }
}, 350);

// ----------------------------------------------------------- book export
const refreshBook = debounce(() => {
  const doc = selected();
  if (!doc) {
    el('book-pages').innerHTML = '';
    el('book-command').textContent = '—';
    lastExport = null;
    return;
  }
  try {
    const result = book.exportDocument({ title: doc.title, author: doc.author, body: doc.body });
    lastExport = result;
    el('book-title').textContent = result.title;
    el('book-author').textContent = `di ${result.author} · ${result.pageCount} pagin${result.pageCount === 1 ? 'a' : 'e'}`;
    el('book-pages').innerHTML = result.pages.map((p, i) => (
      `<div class="book-page">${escapeHtml(p) || '<i>(pagina vuota)</i>'}<span class="page-no">${i + 1}/${result.pages.length}</span></div>`
    )).join('');
    showCommand();
  } catch (err) {
    setStatus('doc-status', `Anteprima non disponibile: ${err.message}`, 'err');
  }
}, 400);

function showCommand() {
  if (!lastExport) return;
  const modern = el('book-version').value === 'modern';
  el('book-command').textContent = modern ? lastExport.commandModern : lastExport.command;
}

async function copyCommand() {
  if (!lastExport) { toast('Nessun documento selezionato', 'err'); return; }
  const text = el('book-command').textContent;
  try {
    await navigator.clipboard.writeText(text);
    toast('Comando copiato negli appunti', 'ok');
  } catch {
    // Clipboard API needs a secure context; fall back to a manual select.
    const range = document.createRange();
    range.selectNodeContents(el('book-command'));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    toast('Premi Ctrl+C per copiare il comando selezionato');
  }
}

function downloadMcfunction() {
  if (!lastExport) { toast('Nessun documento selezionato', 'err'); return; }
  const modern = el('book-version').value === 'modern';
  const body = modern ? lastExport.mcfunction : lastExport.mcfunctionLegacy;
  download(`${slugify(lastExport.title)}.mcfunction`, body, 'text/plain');
  toast('File .mcfunction scaricato', 'ok');
}

function downloadTxt() {
  const doc = selected();
  if (!doc) { toast('Nessun documento selezionato', 'err'); return; }
  const text = `${doc.title}\n${doc.author ? `di ${doc.author}\n` : ''}\n${doc.body}`;
  download(`${slugify(doc.title)}.txt`, text, 'text/plain');
}

/* The format the Lettore (Cube-Atlas reader) opens: paragraphs rather than
 * 255-char in-game book pages, since this is read on a screen, not in a
 * Minecraft book. */
export const READER_DOC_FORMAT = 'cube-atlas/document';

function exportForReader() {
  const doc = selected();
  if (!doc) { toast('Nessun documento selezionato', 'err'); return; }
  const pages = String(doc.body || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const bundle = {
    format: READER_DOC_FORMAT,
    version: 1,
    title: doc.title || 'Senza titolo',
    author: doc.author || '',
    code: doc.code,
    createdAt: doc.createdAt,
    pages: pages.length ? pages : [''],
    exportedAt: new Date().toISOString(),
  };
  download(`${slugify(doc.title)}.cadoc.json`, JSON.stringify(bundle, null, 2), 'application/json');
  toast('Documento esportato per il Lettore', 'ok');
}

// ------------------------------------------------------------------ init
async function init() {
  el('btn-new-doc').addEventListener('click', createDoc);
  el('btn-doc-fork').addEventListener('click', forkDoc);
  el('btn-delete-doc').addEventListener('click', deleteDoc);
  el('doc-search').addEventListener('input', renderList);
  el('doc-title').addEventListener('input', onEdit);
  el('doc-body').addEventListener('input', onEdit);
  el('book-version').addEventListener('change', showCommand);
  el('btn-copy-cmd').addEventListener('click', copyCommand);
  el('btn-download-mcfunction').addEventListener('click', downloadMcfunction);
  el('btn-export-doc-txt').addEventListener('click', downloadTxt);
  el('btn-export-doc-reader').addEventListener('click', exportForReader);

  // One-time move of documents that used to live inside a project, from
  // before the Archivio became independent of any atlas.
  try {
    const migrated = await Documents.migrateEmbeddedDocuments();
    if (migrated) toast(`${migrated} documenti spostati nell'archivio indipendente`, 'ok');
  } catch { /* nothing to migrate, or storage unavailable — refreshList will report that */ }
  await refreshList();
}

/** Kept only so main.js's existing project-lifecycle calls stay valid; the
 *  Archivio no longer depends on which (if any) atlas is open. */
function onProjectLoaded() {}

export { init, renderList, onProjectLoaded, select };
