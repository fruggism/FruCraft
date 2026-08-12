/*
 * Cube-Atlas — Archivio document store.
 *
 * Documents are independent of any atlas: you don't need a world or a
 * project open to write one. Each saved entry is one *version* of a book:
 * its code, creation date and author are stamped once and never change
 * again. "Editing" an existing version doesn't overwrite it — it forks a
 * new version (a fresh code/date/author, linked back via `versionOf`), and
 * the old version becomes read-only because it's no longer the tip of its
 * lineage. This mirrors how the app treats the rest of a chronicle: once
 * written down and signed, a page doesn't get rewritten, a new one gets
 * added on top of it.
 */

import { idbGet, idbPut, idbDelete, idbGetAll } from './db.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function newId(prefix) {
  const rand = (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2)).slice(0, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** A short human-readable serial, distinct from the internal storage id. */
function newCode() {
  const rand = (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2))
    .replace(/-/g, '').slice(0, 5).toUpperCase();
  return `CA-${Date.now().toString(36).toUpperCase()}-${rand}`;
}

/**
 * Coerce input into a valid document. `existing` is the record already in
 * storage for this exact version (if any) — its immutable fields (id, code,
 * createdAt, author, versionOf) always win over anything in `raw`, so there
 * is no code path, anywhere, that can change who signed a version or when.
 */
export function normalizeDocument(raw, existing) {
  const now = new Date().toISOString();
  return {
    id: (existing && existing.id) || newId('doc'),
    code: (existing && existing.code) || newCode(),
    createdAt: (existing && existing.createdAt) || now,
    author: (existing && typeof existing.author === 'string' && existing.author)
      || (raw && typeof raw.author === 'string' && raw.author.trim()) || 'Anonimo',
    versionOf: existing
      ? (existing.versionOf || null)
      : (raw && typeof raw.versionOf === 'string' ? raw.versionOf : null),
    title: (raw && typeof raw.title === 'string') ? raw.title : ((existing && existing.title) || 'Senza titolo'),
    body: (raw && typeof raw.body === 'string') ? raw.body : ((existing && existing.body) || ''),
    tags: Array.isArray(raw && raw.tags) ? raw.tags.filter((t) => typeof t === 'string') : ((existing && existing.tags) || []),
    updatedAt: now,
  };
}

export async function listDocuments() {
  const all = await idbGetAll('archiveDocs');
  return all.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function getDocument(id) {
  return (await idbGet('archiveDocs', id)) || null;
}

/** True when nothing has been forked from this version yet — the only
 *  state in which its title/body/tags may still be edited. */
export function isLatest(doc, all) {
  return !all.some((d) => d.versionOf === doc.id);
}

/** A brand-new book: asks for nothing but the author (code and date are
 *  automatic), and starts out editable since it has no fork yet. */
export async function createDocument({ author, title } = {}) {
  const doc = normalizeDocument({ author, title: title || 'Nuovo documento', body: '' }, null);
  await idbPut('archiveDocs', doc);
  return doc;
}

/** Update the mutable fields (title/body/tags) of a version that is still
 *  editable. Refuses to touch one that already has a newer fork. */
export async function saveDocument(id, patch) {
  const existing = await getDocument(id);
  if (!existing) throw new Error('Documento non trovato');
  const all = await listDocuments();
  if (!isLatest(existing, all)) {
    throw new Error('Questa versione è già stata superata da una più recente e non si può modificare');
  }
  const merged = normalizeDocument(patch, existing);
  await idbPut('archiveDocs', merged);
  return merged;
}

/** "Prendo un documento già scritto per modificarlo": copies its current
 *  content into a brand-new, independently-signed version, leaving the
 *  source exactly as it was — forking, never overwriting. */
export async function forkDocument(sourceId, { author } = {}) {
  const source = await getDocument(sourceId);
  if (!source) throw new Error('Documento non trovato');
  const doc = normalizeDocument({
    author, title: source.title, body: source.body, tags: source.tags, versionOf: source.id,
  }, null);
  await idbPut('archiveDocs', doc);
  return doc;
}

export async function deleteDocument(id) {
  await idbDelete('archiveDocs', id);
}

/** The full lineage of a version — every earlier edition, oldest first —
 *  found by walking `versionOf` back to the root. */
export function history(doc, all) {
  const byId = new Map(all.map((d) => [d.id, d]));
  const chain = [];
  let cur = doc;
  const seen = new Set(); // node ids already placed in the chain
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.versionOf ? byId.get(cur.versionOf) || null : null;
  }
  return chain;
}

/**
 * One-time move of documents that used to live inside a project
 * (project.documents, from before the Archivio became independent of any
 * atlas) into their own store. Idempotent: once a project's embedded list
 * is emptied, running this again finds nothing left to do for it.
 */
export async function migrateEmbeddedDocuments() {
  let projects;
  try {
    projects = await idbGetAll('projects');
  } catch {
    return 0;
  }
  let migrated = 0;
  for (const project of projects) {
    if (!Array.isArray(project.documents) || !project.documents.length) continue;
    for (const old of project.documents) {
      if (!old || typeof old !== 'object') continue;
      const author = (typeof old.author === 'string' && old.author.trim()) || project.name || 'Sconosciuto';
      const doc = normalizeDocument({
        title: old.title,
        body: old.body,
        tags: old.tags,
        author,
      }, {
        id: typeof old.id === 'string' ? old.id : undefined,
        code: newCode(),
        createdAt: (isNum(Date.parse(old.updatedAt)) ? old.updatedAt : null) || new Date().toISOString(),
        author,
        versionOf: null,
      });
      await idbPut('archiveDocs', doc);
      migrated++;
    }
    project.documents = [];
    await idbPut('projects', project);
  }
  return migrated;
}
