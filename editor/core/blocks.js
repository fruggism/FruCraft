/*
 * Naming blocks the way a person does: a block ("stone"), a block with some
 * properties ("oak_stairs[half=top]"), a tag ("#minecraft:logs") or a
 * pattern ("*_planks"). Used by Replace and Search.
 *
 * The game's tags live in its .jar, not in the save, so the common ones are
 * written here as name patterns. They are deliberately generous: a tag that
 * matches one block too many is visible in the preview count; one that
 * silently matches nothing is not.
 */

import { parseState, stateKey } from './chunk.js';

const base = (name) => name.slice(name.indexOf(':') + 1);
const full = (name) => (name.includes(':') ? name : `minecraft:${name}`);

export const TAGS = {
  logs: ['*_log', '*_wood', 'stripped_*_log', 'stripped_*_wood', '*_stem', '*_hyphae', 'stripped_*_stem', 'stripped_*_hyphae'],
  planks: ['*_planks'],
  leaves: ['*_leaves'],
  saplings: ['*_sapling', 'mangrove_propagule'],
  wool: ['*_wool'],
  wool_carpets: ['*_carpet'],
  stairs: ['*_stairs'],
  slabs: ['*_slab'],
  walls: ['*_wall'],
  fences: ['*_fence'],
  fence_gates: ['*_fence_gate'],
  doors: ['*_door'],
  trapdoors: ['*_trapdoor'],
  buttons: ['*_button'],
  pressure_plates: ['*_pressure_plate'],
  signs: ['*_sign', '*_wall_sign'],
  all_signs: ['*_sign', '*_wall_sign', '*_hanging_sign', '*_wall_hanging_sign'],
  beds: ['*_bed'],
  banners: ['*_banner', '*_wall_banner'],
  candles: ['candle', '*_candle'],
  flowers: ['dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', '*_tulip', 'oxeye_daisy', 'cornflower',
    'lily_of_the_valley', 'wither_rose', 'torchflower', 'sunflower', 'lilac', 'rose_bush', 'peony', 'pink_petals',
    'pitcher_plant', 'spore_blossom', 'flowering_azalea', 'flowering_azalea_leaves', 'mangrove_propagule',
    'cherry_leaves', 'chorus_flower', 'open_eyeblossom', 'closed_eyeblossom', 'wildflowers'],
  small_flowers: ['dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', '*_tulip', 'oxeye_daisy', 'cornflower',
    'lily_of_the_valley', 'wither_rose', 'torchflower', 'open_eyeblossom', 'closed_eyeblossom'],
  dirt: ['dirt', 'grass_block', 'podzol', 'coarse_dirt', 'mycelium', 'rooted_dirt', 'moss_block', 'pale_moss_block', 'mud', 'muddy_mangrove_roots'],
  sand: ['sand', 'red_sand', 'suspicious_sand'],
  terracotta: ['terracotta', '*_terracotta'],
  concrete: ['*_concrete'],
  glass: ['glass', '*_stained_glass', 'tinted_glass'],
  glass_panes: ['glass_pane', '*_stained_glass_pane'],
  ice: ['ice', 'packed_ice', 'blue_ice', 'frosted_ice'],
  snow: ['snow', 'snow_block', 'powder_snow'],
  rails: ['rail', 'powered_rail', 'detector_rail', 'activator_rail'],
  stone_ore_replaceables: ['stone', 'granite', 'diorite', 'andesite', 'tuff'],
  deepslate_ore_replaceables: ['deepslate', 'tuff'],
  base_stone_overworld: ['stone', 'granite', 'diorite', 'andesite', 'tuff', 'deepslate'],
  base_stone_nether: ['netherrack', 'basalt', 'blackstone'],
  ores: ['*_ore', 'ancient_debris'],
  coal_ores: ['coal_ore', 'deepslate_coal_ore'],
  iron_ores: ['iron_ore', 'deepslate_iron_ore'],
  copper_ores: ['copper_ore', 'deepslate_copper_ore'],
  gold_ores: ['gold_ore', 'deepslate_gold_ore', 'nether_gold_ore'],
  redstone_ores: ['redstone_ore', 'deepslate_redstone_ore'],
  lapis_ores: ['lapis_ore', 'deepslate_lapis_ore'],
  diamond_ores: ['diamond_ore', 'deepslate_diamond_ore'],
  emerald_ores: ['emerald_ore', 'deepslate_emerald_ore'],
  shulker_boxes: ['shulker_box', '*_shulker_box'],
  crops: ['wheat', 'carrots', 'potatoes', 'beetroots', 'melon_stem', 'pumpkin_stem', 'torchflower_crop', 'pitcher_crop'],
  coral_blocks: ['*_coral_block'],
  corals: ['*_coral', '*_coral_fan'],
  replaceable_plants: ['short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'vine', 'glow_lichen',
    'hanging_roots', 'bush', 'firefly_bush', 'short_dry_grass', 'tall_dry_grass', 'leaf_litter'],
};

/** The names the built-in tag table knows, for autocompletion. */
export const TAG_NAMES = Object.keys(TAGS).map((t) => `#minecraft:${t}`);

const globToRegExp = (glob) => new RegExp(`^${glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);

/**
 * A predicate on block states for one textual "from".
 *   'stone'                 any state of minecraft:stone
 *   'oak_stairs[half=top]'  those properties must match, the others are free
 *   '#minecraft:logs'       a tag of the table above
 *   '*_planks'              a pattern on the name (namespace optional)
 * The returned function takes a state { Name, Properties } and returns a boolean.
 */
export function blockMatcher(text) {
  const t = String(text || '').trim();
  if (!t) throw new Error('Blocco vuoto');
  if (t.startsWith('#')) {
    const tag = base(t.slice(1));
    const globs = TAGS[tag];
    if (!globs) throw new Error(`Tag sconosciuto: ${t}`);
    const res = globs.map(globToRegExp);
    return (s) => s.Name.startsWith('minecraft:') && res.some((r) => r.test(base(s.Name)));
  }
  if (t.includes('*')) {
    const hasNs = t.includes(':');
    const re = globToRegExp(hasNs ? t : t);
    return (s) => re.test(hasNs ? s.Name : base(s.Name)) && (hasNs || s.Name.startsWith('minecraft:'));
  }
  const want = parseState(t);
  const props = want.Properties ? Object.entries(want.Properties) : [];
  return (s) => s.Name === want.Name && props.every(([k, v]) => s.Properties && String(s.Properties[k]) === v);
}

/** What kind of "from" a text is, for the label next to it. */
export function matcherKind(text) {
  const t = String(text || '').trim();
  if (t.startsWith('#')) return 'tag';
  if (t.includes('*')) return 'pattern';
  return 'blocco';
}

// ---------------------------------------------------------------------------
// Keeping properties across a replacement
// ---------------------------------------------------------------------------

/*
 * Blocks of the same family share their properties: every *_stairs has
 * facing/half/shape/waterlogged, every log has axis. So oak_stairs[facing=east]
 * -> spruce_stairs keeps facing=east. Across families nothing carries over
 * (a stair's "half" means nothing to a slab), and the caller is told.
 */
const FAMILIES = [
  'wall_hanging_sign', 'hanging_sign', 'wall_sign', 'wall_banner', 'fence_gate', 'pressure_plate',
  'glazed_terracotta', 'shulker_box', 'stained_glass_pane', 'wall_head', 'wall_skull',
  'stairs', 'slab', 'wall', 'fence', 'door', 'trapdoor', 'button', 'sign', 'banner', 'bed', 'candle',
  'log', 'wood', 'stem', 'hyphae', 'leaves', 'sapling', 'pane', 'head', 'skull', 'carpet', 'torch',
];

export function familyOf(name) {
  const b = base(name);
  if (b === 'glass_pane' || b === 'iron_bars') return 'pane';
  if (/^(basalt|polished_basalt|quartz_pillar|purpur_pillar|bone_block|hay_block|muddy_mangrove_roots|deepslate|bamboo_block|stripped_bamboo_block|ochre_froglight|verdant_froglight|pearlescent_froglight)$/.test(b)) return 'log';
  for (const f of FAMILIES) if (b === f || b.endsWith(`_${f}`)) return f;
  return null;
}

/**
 * The state that replaces `from` when the rule says `to`.
 * Returns { state, dropped } — dropped is true when `from` had properties that
 * could not be carried over.
 */
export function carryProperties(from, to, keep) {
  if (!keep || to.Properties || !from.Properties || !Object.keys(from.Properties).length) {
    return { state: to, dropped: false };
  }
  const ff = familyOf(from.Name);
  if (!ff || ff !== familyOf(to.Name)) return { state: to, dropped: true };
  return { state: { Name: to.Name, Properties: { ...from.Properties } }, dropped: false };
}

// ---------------------------------------------------------------------------
// Mixes
// ---------------------------------------------------------------------------

/** Deterministic hash of a block position: the preview and Apply pick the same block. */
export function hash3(x, y, z, seed = 0) {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(z | 0, 0x9e3779b1) ^ Math.imul(seed | 0, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** Parse "70% stone, 30% andesite" or "stone" into [{ state, weight }]. */
export function parseMix(text) {
  const parts = String(text || '').split(/,(?![^[]*\])/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error('Destinazione vuota');
  return parts.map((p) => {
    const m = /^(\d+(?:[.,]\d+)?)\s*%\s*(.+)$/.exec(p);
    return m
      ? { state: parseState(m[2]), weight: Number(m[1].replace(',', '.')) }
      : { state: parseState(p), weight: 1 };
  });
}

/** Normalised mix: weights summing to 1, cumulative for picking. */
export function compileMix(to) {
  const list = Array.isArray(to) ? to : parseMix(to);
  const total = list.reduce((s, p) => s + Math.max(0, Number(p.weight) || 0), 0) || 1;
  let acc = 0;
  return list.map((p) => {
    acc += Math.max(0, Number(p.weight) || 0) / total;
    return { state: typeof p.state === 'string' ? parseState(p.state) : p.state, upto: acc };
  });
}

export function pickFromMix(mix, r) {
  for (const p of mix) if (r < p.upto) return p.state;
  return mix[mix.length - 1].state;
}

export { stateKey, parseState, full as fullName, base as baseName };
