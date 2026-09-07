/*
 * From a block state to a shape.
 *
 * A top-down map only ever needs a block's color; in 3D it also matters what
 * the block *is*: a cube, a pane of water, a flower, half a slab. Drawing
 * everything as a full cube is what makes naive voxel viewers look wrong —
 * a meadow becomes a solid green ceiling and a slab floor becomes a step.
 *
 * So each block state is classified once into one of a few shapes, and the
 * mesher draws it accordingly:
 *
 *   air     nothing, and does not hide the neighbours' faces
 *   skip    same, for blocks that would only be noise (barriers, buttons)
 *   cube    a full opaque cube — the only shape that hides its neighbours,
 *           and the only one that goes through the greedy mesher
 *   glass   a full cube, drawn translucent in the second pass
 *   water   handled apart: surface is 15/16 high, inner faces are dropped
 *   plant   two crossed quads, cut out by an alpha mask (grass, flowers,
 *           crops) — without the mask a meadow becomes a field of billboards
 *   box     one or more axis-aligned boxes in 0..1 (slabs, stairs, carpets,
 *           doors, rails, torches)
 *   post    a centre post plus an arm toward every neighbour it connects to
 *           (fences, walls, glass panes, iron bars)
 *
 * Boxes use the Minecraft convention: x east, y up, z south, 1 unit = 1 block,
 * a 16th = 0.0625.
 */

import { AIR_NAMES } from '../core/anvil.js';

export const S = 1 / 16; // one texture pixel, the unit every vanilla model uses

// Blocks that carry no volume worth drawing: they would show up as specks or,
// worse, as walls (barrier) across an otherwise open build.
const SKIP = new Set([
  'barrier', 'light', 'moving_piston', 'tripwire', 'tripwire_hook',
  'end_gateway', 'end_portal', 'structure_block', 'jigsaw',
]);

const WATER = new Set(['water', 'bubble_column']);

const GLASSY = new Map([
  ['glass', 0.35], ['tinted_glass', 0.55], ['ice', 0.55], ['frosted_ice', 0.55],
  ['packed_ice', 0.75], ['blue_ice', 0.8], ['slime_block', 0.55], ['honey_block', 0.6],
]);

// Post + arms, with the vanilla half-widths.
const POSTS = new Map([
  ['fence', { post: 2 * S, arm: 1.5 * S, armY: [6 * S, 15 * S] }],
  ['wall', { post: 4 * S, arm: 3 * S, armY: [0, 14 * S] }],
  ['pane', { post: 1 * S, arm: 1 * S, armY: [0, 1] }],
]);

const RAILS = new Set(['rail', 'powered_rail', 'detector_rail', 'activator_rail']);

const FLOWERS = new Set([
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'oxeye_daisy',
  'cornflower', 'lily_of_the_valley', 'wither_rose', 'sunflower', 'lilac',
  'rose_bush', 'peony', 'torchflower', 'pitcher_plant', 'pink_petals',
  'spore_blossom', 'closed_eyeblossom', 'open_eyeblossom',
]);

const PLANTS = new Set([
  'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush',
  'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant', 'sugar_cane',
  'sweet_berry_bush', 'nether_wart', 'crimson_roots', 'warped_roots',
  'nether_sprouts', 'twisting_vines', 'twisting_vines_plant', 'weeping_vines',
  'weeping_vines_plant', 'cave_vines', 'cave_vines_plant', 'hanging_roots',
  'vine', 'glow_lichen', 'sculk_vein', 'small_dripleaf', 'big_dripleaf_stem',
  'wheat', 'carrots', 'potatoes', 'beetroots', 'torchflower_crop',
  'pitcher_crop', 'melon_stem', 'pumpkin_stem', 'attached_melon_stem',
  'attached_pumpkin_stem', 'cocoa', 'brown_mushroom', 'red_mushroom',
  'crimson_fungus', 'warped_fungus', 'sea_pickle', 'chorus_flower', 'chorus_plant',
  'bamboo_sapling', 'frogspawn', 'nether_portal',
]);

const PLANT_RE = /(_sapling|_tulip|_coral|_coral_fan|_coral_wall_fan)$/;
const TORCH_RE = /^(torch|wall_torch|soul_torch|soul_wall_torch|redstone_torch|redstone_wall_torch)$/;

/*
 * Plants are drawn as crossed quads with a cut-out silhouette. `tile` picks
 * which silhouette (0 blades, 1 a flower on its stem) and `height` how far up
 * the block it reaches — a poppy is not as tall as a sapling.
 */
const plant = (height = 0.9, tile = 0) => ({ kind: 'plant', alpha: 1, height, tile });

const PLANT_HEIGHT = new Map([
  ['short_grass', 0.85], ['grass', 0.85], ['fern', 0.85], ['dead_bush', 0.8],
  ['wheat', 0.7], ['carrots', 0.6], ['potatoes', 0.6], ['beetroots', 0.55],
  ['nether_wart', 0.6], ['seagrass', 0.8], ['sea_pickle', 0.4],
  ['glow_lichen', 1], ['sculk_vein', 1], ['vine', 1], ['tall_grass', 1],
  ['large_fern', 1], ['kelp', 1], ['kelp_plant', 1], ['tall_seagrass', 1],
  ['sugar_cane', 1], ['cave_vines', 1], ['cave_vines_plant', 1],
  ['twisting_vines', 1], ['weeping_vines', 1], ['chorus_plant', 1],
]);

const cache = new Map();

const strip = (name) => (name.startsWith('minecraft:') ? name.slice(10) : name);

const AIR_SHAPE = { kind: 'air', alpha: 1 };
const SKIP_SHAPE = { kind: 'skip', alpha: 1 };
const CUBE_SHAPE = { kind: 'cube', alpha: 1 };

const box = (boxes, extra) => ({ kind: 'box', boxes, alpha: 1, ...extra });

/** A slab of thickness `h` lying on the floor (or on the ceiling). */
const layer = (h, top = false) => box([[0, top ? 1 - h : 0, 0, 1, top ? 1 : h, 1]]);

// north -z, south +z, west -x, east +x
const AXIS = {
  north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0],
};

/**
 * The 3/16-thick panel a door occupies, on the side opposite to `facing`.
 * An open door is the same panel rotated a quarter turn about the block
 * centre; which way it swings depends on the hinge.
 */
function doorPanel(props) {
  const t = 3 * S;
  const facing = props.facing || 'north';
  const open = props.open === 'true';
  const hinge = props.hinge === 'right' ? 1 : -1;
  const order = ['north', 'east', 'south', 'west'];
  let side = order[(order.indexOf(facing) + 2) % 4] || 'south';
  if (open) side = order[(order.indexOf(side) + 4 + hinge) % 4];
  const [dx, dz] = AXIS[side];
  if (dx) return box([[dx < 0 ? 0 : 1 - t, 0, 0, dx < 0 ? t : 1, 1, 1]]);
  return box([[0, 0, dz < 0 ? 0 : 1 - t, 1, 1, dz < 0 ? t : 1]]);
}

/**
 * Stairs: the lower half is a full slab, the upper half a half-depth step on
 * the `facing` side. Corner shapes (inner/outer) are drawn straight — the
 * silhouette of a staircase is right, the corner notch is not.
 */
function stairShape(props) {
  const top = props.half === 'top';
  const facing = props.facing || 'north';
  const [dx, dz] = AXIS[facing] || AXIS.north;
  const slab = top ? [0, 0.5, 0, 1, 1, 1] : [0, 0, 0, 1, 0.5, 1];
  const y0 = top ? 0 : 0.5;
  const y1 = top ? 0.5 : 1;
  let step;
  if (dx) step = [dx > 0 ? 0.5 : 0, y0, 0, dx > 0 ? 1 : 0.5, y1, 1];
  else step = [0, y0, dz > 0 ? 0.5 : 0, 1, y1, dz > 0 ? 1 : 0.5];
  return box([slab, step]);
}

function trapdoorShape(props) {
  const t = 3 * S;
  if (props.open === 'true') {
    const facing = props.facing || 'north';
    const [dx, dz] = AXIS[facing] || AXIS.north;
    // An open trapdoor stands against the wall it faces away from.
    if (dx) return box([[dx > 0 ? 1 - t : 0, 0, 0, dx > 0 ? 1 : t, 1, 1]]);
    return box([[0, 0, dz > 0 ? 1 - t : 0, 1, 1, dz > 0 ? 1 : t]]);
  }
  return layer(t, props.half === 'top');
}

function classifyName(name, props) {
  if (AIR_NAMES.has(`minecraft:${name}`)) return AIR_SHAPE;
  if (SKIP.has(name)) return SKIP_SHAPE;
  if (name.endsWith('_button') || name === 'lever') return SKIP_SHAPE;
  if (WATER.has(name)) return { kind: 'water', alpha: 0.72 };
  if (name === 'lava') return CUBE_SHAPE;

  const glass = GLASSY.get(name);
  if (glass !== undefined) return { kind: 'glass', alpha: glass };
  if (name.endsWith('_stained_glass')) return { kind: 'glass', alpha: 0.45 };

  if (name.endsWith('_pane') || name === 'iron_bars') {
    return { kind: 'post', alpha: name.endsWith('glass_pane') ? 0.45 : 1, ...POSTS.get('pane') };
  }
  if (name.endsWith('_wall')) return { kind: 'post', alpha: 1, ...POSTS.get('wall') };
  if (name.endsWith('_fence') || name.endsWith('_fence_gate')) {
    return { kind: 'post', alpha: 1, ...POSTS.get('fence') };
  }

  if (name.endsWith('_slab')) {
    const type = props.type || 'bottom';
    if (type === 'double') return CUBE_SHAPE;
    return layer(0.5, type === 'top');
  }
  if (name.endsWith('_stairs')) return stairShape(props);
  if (name.endsWith('_trapdoor')) return trapdoorShape(props);
  if (name.endsWith('_door')) return doorPanel(props);

  if (name === 'snow') return layer(Math.max(1, Number(props.layers) || 1) * 2 * S);
  if (name.endsWith('_carpet') || name === 'moss_carpet') return layer(S);
  if (name.endsWith('_pressure_plate') || name === 'lily_pad') return layer(S);
  if (RAILS.has(name)) return layer(S);
  if (name === 'redstone_wire') return layer(S);
  if (name === 'repeater' || name === 'comparator') return layer(2 * S);
  if (name.endsWith('_sign') || name.endsWith('_hanging_sign')) return layer(2 * S);
  if (name === 'end_rod' || name === 'lightning_rod') {
    return box([[6 * S, 0, 6 * S, 10 * S, 1, 10 * S]]);
  }
  if (TORCH_RE.test(name)) return box([[7 * S, 0, 7 * S, 9 * S, 10 * S, 9 * S]]);
  if (name === 'lantern' || name === 'soul_lantern') {
    return box([[5 * S, 0, 5 * S, 11 * S, 8 * S, 11 * S]]);
  }
  if (name === 'chain') return box([[6.5 * S, 0, 6.5 * S, 9.5 * S, 1, 9.5 * S]]);
  if (name === 'flower_pot' || name.startsWith('potted_')) {
    return box([[5 * S, 0, 5 * S, 11 * S, 6 * S, 11 * S]]);
  }
  if (name === 'bamboo') return box([[6 * S, 0, 6 * S, 10 * S, 1, 10 * S]]);
  if (name === 'ladder') {
    const facing = props.facing || 'north';
    const [dx, dz] = AXIS[facing] || AXIS.north;
    const t = 2 * S;
    if (dx) return box([[dx > 0 ? 1 - t : 0, 0, 0, dx > 0 ? 1 : t, 1, 1]]);
    return box([[0, 0, dz > 0 ? 1 - t : 0, 1, 1, dz > 0 ? 1 : t]]);
  }

  if (FLOWERS.has(name)) return plant(PLANT_HEIGHT.get(name) || 0.75, 1);
  if (name.endsWith('_tulip')) return plant(0.75, 1);
  if (name.endsWith('_mushroom') && !name.endsWith('_mushroom_block')) return plant(0.5, 1);
  if (PLANTS.has(name) || PLANT_RE.test(name)) {
    return plant(PLANT_HEIGHT.get(name) || 0.9, 0);
  }

  return CUBE_SHAPE;
}

/**
 * Shape for a block state. `props` is the Properties compound of the palette
 * entry (all values are strings), or null.
 *
 * The result is shared and must not be mutated: the same state is asked for
 * once per palette entry, but the cache spans the whole session.
 */
export function shapeOf(stateKey, name, props) {
  let s = cache.get(stateKey);
  if (s) return s;
  s = classifyName(strip(name), props || {});
  cache.set(stateKey, s);
  return s;
}

/**
 * Blocks whose color is jittered per position. Flat color makes a canopy read
 * as a solid green box; a few percent of variation, keyed to the block's
 * coordinates, brings back the texture of a tree without a single texel.
 */
export const isVaried = (name) => name.endsWith('_leaves') || name === 'azalea'
  || name === 'flowering_azalea' || name === 'moss_block' || name === 'sculk';

/**
 * Properties worth keeping in the state key. Everything else (redstone power,
 * distance, persistence…) would only multiply the palette without changing
 * a single triangle.
 */
export const SHAPE_PROPS = [
  'type', 'half', 'facing', 'open', 'hinge', 'layers', 'shape', 'axis',
];
