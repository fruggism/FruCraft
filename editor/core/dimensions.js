/*
 * Where each dimension lives inside a world folder, and how tall it is.
 *
 * Heights come from the dimension, not from the code that edits it: the
 * vanilla ones are listed here, and a custom dimension (a data pack) defaults
 * to overworld numbers until its real ones are read from the world.
 */

const VANILLA = {
  overworld: { dir: 'region', minY: -64, height: 384, label: 'Overworld' },
  the_nether: { dir: 'DIM-1/region', minY: 0, height: 256, label: 'Nether' },
  the_end: { dir: 'DIM1/region', minY: 0, height: 256, label: 'End' },
};

/*
 * Worlds saved by 26.x keep every dimension under dimensions/<namespace>/<name>/,
 * the overworld too; older worlds use region/, DIM-1/ and DIM1/. A world is
 * "modern" when this folder exists (see NodeSource.modernLayout).
 */
export const MODERN_PROBE = 'dimensions/minecraft/overworld';

/**
 * @param id      'overworld' | 'the_nether' | 'the_end' | '<namespace>:<name>'
 * @param modern  the world uses the 26.x folder layout (only `dir` changes)
 */
export function dimensionInfo(id, modern = false) {
  const v = VANILLA[id] || VANILLA[String(id).replace(/^minecraft:/, '')];
  if (v) {
    const short = String(id).replace(/^minecraft:/, '');
    return { id: short, ...v, ...(modern ? { dir: `dimensions/minecraft/${short}/region` } : {}) };
  }
  const m = /^([a-z0-9_.-]+):([a-z0-9_./-]+)$/.exec(id);
  if (!m) throw new Error(`Dimensione non valida: ${id}`);
  return {
    id, dir: `dimensions/${m[1]}/${m[2]}/region`, minY: -64, height: 384, label: id, custom: true,
  };
}

/** Sub-directory of a dimension that holds `kind` ('region' | 'entities' | 'poi'). */
export function dimensionDir(id, kind = 'region', modern = false) {
  const dir = dimensionInfo(id, modern).dir;
  if (kind === 'region') return dir;
  const base = dir.replace(/\/?region$/, '');
  return base ? `${base}/${kind}` : kind;
}
