'use strict';
/*
 * Cube-Atlas — Archivio: the empire's document collection. Documents live
 * inside the project file, and each one can be exported as a Minecraft
 * written book (a /give command or a .mcfunction).
 */

const Archive = (function () {
  const { state, el, escapeHtml, toast } = CA;

  let selectedDocId = null;
  let lastExport = null;

  function docs() {
    if (!state.project) return [];
    if (!Array.isArray(state.project.documents)) state.project.documents = [];
    return state.project.documents;
  }

  function selected() {
    return docs().find((d) => d.id === selectedDocId) || null;
  }

  // ------------------------------------------------------------------ list
  function renderList() {
    const host = el('doc-list');
    const query = (el('doc-search').value || '').trim().toLowerCase();
    const all = docs();
    const matches = query
      ? all.filter((d) => `${d.title} ${d.body}`.toLowerCase().includes(query))
      : all;

    el('doc-empty').classList.toggle('hidden', matches.length > 0);
    if (!matches.length) {
      host.innerHTML = '';
      el('doc-empty').textContent = all.length
        ? 'Nessun documento corrisponde alla ricerca.'
        : (state.project ? 'Nessun documento. Creane uno.' : 'Apri un atlante per usare l\'archivio.');
      return;
    }

    host.innerHTML = matches.map((d) => {
      const preview = (d.body || '').replace(/\s+/g, ' ').slice(0, 60);
      const when = d.updatedAt ? new Date(d.updatedAt).toLocaleDateString('it-IT') : '';
      return `<li class="doc-item ${d.id === selectedDocId ? 'selected' : ''}" data-id="${d.id}">
        <b>${escapeHtml(d.title || 'Senza titolo')}</b>
        <small>${escapeHtml(preview)}${preview.length === 60 ? '…' : ''}</small>
        <small>${when}</small>
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
      el('doc-title').value = doc.title || '';
      el('doc-author').value = doc.author || '';
      el('doc-body').value = doc.body || '';
      refreshBook();
    }
    renderList();
  }

  function createDoc() {
    if (!state.project) { toast('Apri prima un atlante', 'err'); return; }
    const doc = {
      id: CA.newId('doc'),
      title: 'Nuovo documento',
      author: state.project.name || '',
      body: '',
      tags: [],
      updatedAt: new Date().toISOString(),
    };
    docs().unshift(doc);
    CA.markDirty();
    select(doc.id);
    el('doc-title').focus();
    el('doc-title').select();
  }

  async function deleteDoc() {
    const doc = selected();
    if (!doc) return;
    const ok = await CA.confirmDialog({
      title: 'Eliminare il documento?',
      message: `"${doc.title || 'Senza titolo'}" verrà rimosso dall'archivio.`,
      confirmLabel: 'Elimina', danger: true,
    });
    if (!ok) return;
    const list = docs();
    const idx = list.findIndex((d) => d.id === doc.id);
    if (idx >= 0) list.splice(idx, 1);
    selectedDocId = null;
    CA.markDirty();
    select(null);
    toast('Documento eliminato');
  }

  const onEdit = CA.debounce(() => {
    const doc = selected();
    if (!doc) return;
    doc.title = el('doc-title').value;
    doc.author = el('doc-author').value;
    doc.body = el('doc-body').value;
    doc.updatedAt = new Date().toISOString();
    CA.markDirty();
    CA.setStatus('doc-status', 'Salvataggio…', 'busy');
    renderList();
    refreshBook();
  }, 350);

  // ----------------------------------------------------------- book export
  const refreshBook = CA.debounce(async () => {
    const doc = selected();
    if (!doc) {
      el('book-pages').innerHTML = '';
      el('book-command').textContent = '—';
      lastExport = null;
      return;
    }
    try {
      const result = await CA.api.exportBook({ title: doc.title, author: doc.author, body: doc.body });
      lastExport = result;
      el('book-title').textContent = result.title;
      el('book-author').textContent = `di ${result.author} · ${result.pageCount} pagin${result.pageCount === 1 ? 'a' : 'e'}`;
      el('book-pages').innerHTML = result.pages.map((p, i) => (
        `<div class="book-page">${escapeHtml(p) || '<i>(pagina vuota)</i>'}<span class="page-no">${i + 1}/${result.pages.length}</span></div>`
      )).join('');
      showCommand();
      CA.setStatus('doc-status', 'Salvato', 'ok');
    } catch (err) {
      CA.setStatus('doc-status', `Anteprima non disponibile: ${err.message}`, 'err');
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
    CA.download(`${CA.slugify(lastExport.title)}.mcfunction`, body, 'text/plain');
    toast('File .mcfunction scaricato', 'ok');
  }

  function downloadTxt() {
    const doc = selected();
    if (!doc) { toast('Nessun documento selezionato', 'err'); return; }
    const text = `${doc.title}\n${doc.author ? `di ${doc.author}\n` : ''}\n${doc.body}`;
    CA.download(`${CA.slugify(doc.title)}.txt`, text, 'text/plain');
  }

  // ------------------------------------------------------------------ init
  function init() {
    el('btn-new-doc').addEventListener('click', createDoc);
    el('btn-delete-doc').addEventListener('click', deleteDoc);
    el('doc-search').addEventListener('input', renderList);
    for (const id of ['doc-title', 'doc-author', 'doc-body']) {
      el(id).addEventListener('input', onEdit);
    }
    el('book-version').addEventListener('change', showCommand);
    el('btn-copy-cmd').addEventListener('click', copyCommand);
    el('btn-download-mcfunction').addEventListener('click', downloadMcfunction);
    el('btn-export-doc-txt').addEventListener('click', downloadTxt);
  }

  /** Called when a project is opened so the archive reflects it. */
  function onProjectLoaded() {
    selectedDocId = null;
    select(null);
  }

  return { init, renderList, onProjectLoaded, select };
})();

window.Archive = Archive;
