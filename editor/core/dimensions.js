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

/** @param id 'overworld' | 'the_nether' | 'the_end' | '<namespace>:<name>' */
export function dimensionInfo(id) {
  const v = VANILLA[id] || VANILLA[String(id).replace(/^minecraft:/, '')];
  if (v) return { id: String(id).replace(/^minecraft:/, ''), ...v };
  const m = /^([a-z0-9_.-]+):([a-z0-9_./-]+)$/.exec(id);
  if (!m) throw new Error(`Dimensione non valida: ${id}`);
  return {
    id, dir: `dimensions/${m[1]}/${m[2]}/region`, minY: -64, height: 384, label: id, custom: true,
  };
}

/** Sub-directory of a dimension that holds `kind` ('region' | 'entities' | 'poi'). */
export function dimensionDir(id, kind = 'region') {
  const base = dimensionInfo(id).dir.replace(/\/region$/, '');
  return base ? `${base}/${kind}` : kind;
}
