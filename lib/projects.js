'use strict';
/*
 * Cube-Atlas project storage.
 *
 * A project bundles: which world/dimension it maps, the saved view, the
 * user's vector layers (roads / points of interest / areas) and the archive
 * documents. Everything is stored as one JSON file per project under
 * data/projects, so a project is trivially portable — the same shape is what
 * the "esporta progetto" button downloads and the import accepts.
 *
 * All feature coordinates are Minecraft block coordinates [x, z], never
 * screen or tile coordinates, so a project stays valid at any zoom.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECTS_DIR = path.join(__dirname, '..', 'data', 'projects');
const FORMAT = 'cube-atlas/project';
const FORMAT_VERSION = 1;

const LAYER_TYPES = ['roads', 'pois', 'areas'];

function ensureDir() { fs.mkdirSync(PROJECTS_DIR, { recursive: true }); }

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

function safeId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) {
    throw new Error('Identificativo progetto non valido');
  }
  return id;
}

function projectFile(id) { return path.join(PROJECTS_DIR, `${safeId(id)}.json`); }

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_ROAD_STYLE = {
  color: '#f2c14e', width: 4, dash: 'solid', opacity: 1,
  casingColor: '#2b2b2b', casingWidth: 2, showName: true,
};
const DEFAULT_POI_STYLE = {
  shape: 'circle', color: '#e05a47', size: 10, showName: true,
};
const DEFAULT_AREA_STYLE = {
  fillColor: '#4fa3d1', fillOpacity: 0.25,
  strokeColor: '#4fa3d1', strokeWidth: 2, dash: 'solid', showName: true,
};

function defaultStyleFor(type) {
  if (type === 'roads') return { ...DEFAULT_ROAD_STYLE };
  if (type === 'pois') return { ...DEFAULT_POI_STYLE };
  return { ...DEFAULT_AREA_STYLE };
}

function makeLayer(type, name) {
  if (!LAYER_TYPES.includes(type)) throw new Error(`Tipo di layer sconosciuto: ${type}`);
  return {
    id: newId('lay'),
    type,
    name: name || { roads: 'Strade', pois: 'Punti di interesse', areas: 'Aree' }[type],
    visible: true,
    locked: false,
    defaultStyle: defaultStyleFor(type),
    features: [],
  };
}

function defaultLayers() {
  return [makeLayer('areas', 'Aree'), makeLayer('roads', 'Strade'), makeLayer('pois', 'Punti di interesse')];
}

// ---------------------------------------------------------------------------
// Validation / normalization
// ---------------------------------------------------------------------------

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function normCoord(c) {
  if (!Array.isArray(c) || c.length < 2 || !isNum(c[0]) || !isNum(c[1])) return null;
  return [c[0], c[1]];
}

function normCoords(list) {
  if (!Array.isArray(list)) return [];
  return list.map(normCoord).filter(Boolean);
}

function normalizeFeature(raw, layerType) {
  if (!raw || typeof raw !== 'object') return null;
  const base = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId('f'),
    name: typeof raw.name === 'string' ? raw.name : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    style: raw.style && typeof raw.style === 'object' ? { ...raw.style } : {},
  };
  if (layerType === 'pois') {
    const coord = normCoord(raw.coord);
    if (!coord) return null;
    return { ...base, coord, category: typeof raw.category === 'string' ? raw.category : 'altro' };
  }
  const coords = normCoords(raw.coords);
  // A line needs 2 points; a closed area needs 3.
  if (coords.length < (layerType === 'areas' ? 3 : 2)) return null;
  return { ...base, coords };
}

function normalizeLayer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = LAYER_TYPES.includes(raw.type) ? raw.type : null;
  if (!type) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId('lay'),
    type,
    name: typeof raw.name === 'string' && raw.name ? raw.name : 'Layer',
    visible: raw.visible !== false,
    locked: raw.locked === true,
    defaultStyle: { ...defaultStyleFor(type), ...(raw.defaultStyle || {}) },
    features: Array.isArray(raw.features)
      ? raw.features.map((f) => normalizeFeature(f, type)).filter(Boolean)
      : [],
  };
}

function normalizeDocument(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId('doc'),
    title: typeof raw.title === 'string' ? raw.title : 'Senza titolo',
    author: typeof raw.author === 'string' ? raw.author : '',
    body: typeof raw.body === 'string' ? raw.body : '',
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === 'string') : [],
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
  };
}

/** The saved map view, or null when the project has never been positioned. */
function normalizeView(raw, existing) {
  const fromRaw = raw && raw.view;
  if (fromRaw && normCoord(fromRaw.center)) {
    return { center: normCoord(fromRaw.center), zoom: isNum(fromRaw.zoom) ? fromRaw.zoom : -2 };
  }
  return (existing && existing.view) || null;
}

/**
 * Coerce arbitrary input (a PUT body, or an imported file) into a valid
 * project. Unknown fields are dropped rather than trusted.
 */
function normalizeProject(raw, existing) {
  const now = new Date().toISOString();
  const world = (raw && raw.world) || (existing && existing.world) || {};
  const layers = Array.isArray(raw && raw.layers)
    ? raw.layers.map(normalizeLayer).filter(Boolean)
    : (existing ? existing.layers : defaultLayers());

  return {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    id: (existing && existing.id) || (raw && typeof raw.id === 'string' && raw.id) || newId('p'),
    name: (raw && typeof raw.name === 'string' && raw.name.trim()) || (existing && existing.name) || 'Nuovo atlante',
    world: {
      path: world.path || '',
      id: world.id || '',
      dimension: world.dimension || 'overworld',
      levelName: world.levelName || '',
    },
    // A brand-new project has no saved view, which is what tells the map to
    // frame the whole generated world instead of jumping to an arbitrary spot.
    view: normalizeView(raw, existing),
    settings: {
      showTerrain: raw && raw.settings ? raw.settings.showTerrain !== false : true,
    },
    layers: layers.length ? layers : defaultLayers(),
    documents: Array.isArray(raw && raw.documents)
      ? raw.documents.map(normalizeDocument).filter(Boolean)
      : (existing ? existing.documents : []),
    createdAt: (existing && existing.createdAt) || now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

function listProjects() {
  ensureDir();
  return fs.readdirSync(PROJECTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, f), 'utf8'));
        return {
          id: p.id,
          name: p.name,
          updatedAt: p.updatedAt,
          world: p.world,
          layerCount: (p.layers || []).length,
          featureCount: (p.layers || []).reduce((n, l) => n + (l.features || []).length, 0),
          documentCount: (p.documents || []).length,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function getProject(id) {
  ensureDir();
  const file = projectFile(id);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeProject(project) {
  ensureDir();
  fs.writeFileSync(projectFile(project.id), JSON.stringify(project, null, 2));
  return project;
}

function createProject(raw) {
  const project = normalizeProject({ ...raw, id: undefined }, null);
  if (!project.layers.length) project.layers = defaultLayers();
  return writeProject(project);
}

function saveProject(id, raw) {
  const existing = getProject(id);
  if (!existing) throw new Error('Progetto non trovato');
  return writeProject(normalizeProject(raw, existing));
}

function deleteProject(id) {
  const file = projectFile(id);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

/** Import a project file: always creates a new project rather than
 *  overwriting whatever happens to share its id. */
function importProject(raw, nameSuffix) {
  const project = normalizeProject({ ...raw, id: undefined }, null);
  if (nameSuffix) project.name = `${project.name}${nameSuffix}`;
  return writeProject(project);
}

module.exports = {
  PROJECTS_DIR, FORMAT, FORMAT_VERSION, LAYER_TYPES,
  DEFAULT_ROAD_STYLE, DEFAULT_POI_STYLE, DEFAULT_AREA_STYLE,
  defaultStyleFor, makeLayer, defaultLayers, normalizeProject, normalizeFeature, normalizeLayer,
  listProjects, getProject, createProject, saveProject, deleteProject, importProject, newId,
};
