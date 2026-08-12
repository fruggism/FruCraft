/*
 * Cube-Atlas Lettore: opens files already exported by the Editor — a map
 * image, or a document exported from the Archivio. It needs no world and no
 * project open: everything shown here comes from a file the user picks on
 * their own computer, read locally like everything else in the app.
 */

import { el, escapeHtml, toast, setStatus } from './ui-core.js';
import { READER_DOC_FORMAT } from './archive.js';

function showEmpty() {
  el('reader-empty').classList.remove('hidden');
  el('reader-image-view').classList.add('hidden');
  el('reader-doc-view').classList.add('hidden');
}

function showImage() {
  el('reader-empty').classList.add('hidden');
  el('reader-image-view').classList.remove('hidden');
  el('reader-doc-view').classList.add('hidden');
}

function showDoc() {
  el('reader-empty').classList.add('hidden');
  el('reader-image-view').classList.add('hidden');
  el('reader-doc-view').classList.remove('hidden');
}

function openMapFile(file) {
  if (!file) return;
  const img = el('reader-image');
  img.src = URL.createObjectURL(file);
  img.className = 'fit';
  el('reader-image-name').textContent = file.name;
  showImage();
  setStatus('reader-map-status', `"${file.name}" aperta`, 'ok');
}

function renderDocument(doc) {
  const pages = doc.pages && doc.pages.length ? doc.pages : [''];
  el('reader-doc-title').textContent = doc.title || 'Senza titolo';
  el('reader-doc-author').textContent = doc.author ? `di ${doc.author}` : '';
  el('reader-doc-pages').innerHTML = pages.map((p, i) => (
    `<div class="book-page">${escapeHtml(p) || '<i>(pagina vuota)</i>'}<span class="page-no">${i + 1}/${pages.length}</span></div>`
  )).join('');
  showDoc();
}

/** The plain .txt fallback mirrors what "Scarica testo .txt" writes:
 *  title, then an optional "di AUTORE" line, a blank line, then the body. */
function parsePlainTxt(text, filename) {
  const lines = text.split(/\r\n?|\n/);
  let i = 0;
  const title = lines[i] || filename;
  i++;
  let author = '';
  if (lines[i] && lines[i].startsWith('di ')) { author = lines[i].slice(3); i++; }
  while (lines[i] === '') i++;
  return { title, author, pages: [lines.slice(i).join('\n')] };
}

async function openDocFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const looksJson = file.name.toLowerCase().endsWith('.json') || file.type === 'application/json';
    if (looksJson) {
      const raw = JSON.parse(text);
      if (raw && raw.format && raw.format !== READER_DOC_FORMAT) {
        throw new Error('Questo file non è un documento Cube-Atlas');
      }
      renderDocument({
        title: typeof raw.title === 'string' ? raw.title : file.name,
        author: typeof raw.author === 'string' ? raw.author : '',
        pages: Array.isArray(raw.pages) ? raw.pages : null,
      });
    } else {
      renderDocument(parsePlainTxt(text, file.name));
    }
    setStatus('reader-doc-status', `"${file.name}" aperto`, 'ok');
  } catch (err) {
    setStatus('reader-doc-status', `Apertura fallita: ${err.message}`, 'err');
    toast(`Apertura fallita: ${err.message}`, 'err');
  }
}

function init() {
  el('btn-reader-open-map').addEventListener('click', () => el('reader-map-input').click());
  el('reader-map-input').addEventListener('change', (e) => {
    openMapFile(e.target.files && e.target.files[0]);
    e.target.value = '';
  });

  el('btn-reader-open-doc').addEventListener('click', () => el('reader-doc-input').click());
  el('reader-doc-input').addEventListener('change', (e) => {
    openDocFile(e.target.files && e.target.files[0]);
    e.target.value = '';
  });

  el('btn-reader-image-fit').addEventListener('click', () => { el('reader-image').className = 'fit'; });
  el('btn-reader-image-full').addEventListener('click', () => { el('reader-image').className = 'full'; });

  showEmpty();
}

export { init };
