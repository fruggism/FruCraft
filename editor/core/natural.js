/*
 * Which blocks the world generator puts down by itself ("natural") and which
 * only a player does ("built"). Used by Free space to tell a chunk nobody
 * touched from one with a house in it.
 *
 * The list errs on the side of "built": anything not listed counts as a
 * player's work and keeps its chunk. So villages, mineshafts, temples and
 * other generated structures (planks, rails, chests...) count as built too —
 * a chunk with a village stays, which is what one wants anyway. Logs are
 * natural (trees); planks are not.
 */

const NATURAL_NAMES = [
  // Air and fluids
  'air', 'cave_air', 'void_air', 'water', 'lava', 'bubble_column',
  // Stone and underground
  'stone', 'granite', 'diorite', 'andesite', 'deepslate', 'tuff', 'calcite', 'dripstone_block', 'pointed_dripstone',
  'bedrock', 'gravel', 'clay', 'obsidian', 'crying_obsidian', 'magma_block', 'infested_*', 'amethyst_block',
  'budding_amethyst', '*_amethyst_bud', 'amethyst_cluster', 'smooth_basalt', 'raw_iron_block', 'raw_copper_block',
  'sculk', 'sculk_vein', 'sculk_sensor', 'sculk_shrieker', 'sculk_catalyst', 'cobweb', 'mossy_cobblestone',
  // Ores
  '*_ore', 'ancient_debris',
  // Soil and surface
  'dirt', 'grass_block', 'podzol', 'coarse_dirt', 'mycelium', 'rooted_dirt', 'mud', 'muddy_mangrove_roots',
  'mangrove_roots', 'moss_block', 'moss_carpet', 'pale_moss_block', 'pale_moss_carpet', 'pale_hanging_moss',
  'sand', 'red_sand', 'sandstone', 'red_sandstone', 'suspicious_sand', 'suspicious_gravel',
  'terracotta', 'white_terracotta', 'orange_terracotta', 'yellow_terracotta', 'brown_terracotta', 'red_terracotta',
  'light_gray_terracotta',
  // Snow and ice
  'snow', 'snow_block', 'powder_snow', 'ice', 'packed_ice', 'blue_ice',
  // Trees and plants
  '*_log', '*_wood', '*_leaves', '*_sapling', 'mangrove_propagule', 'azalea', 'flowering_azalea', 'bee_nest',
  'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'bush', 'firefly_bush', 'short_dry_grass',
  'tall_dry_grass', 'leaf_litter', 'wildflowers', 'pink_petals', 'vine', 'glow_lichen', 'hanging_roots', 'spore_blossom',
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', '*_tulip', 'oxeye_daisy', 'cornflower',
  'lily_of_the_valley', 'sunflower', 'lilac', 'rose_bush', 'peony', 'torchflower', 'pitcher_plant',
  'open_eyeblossom', 'closed_eyeblossom', 'creaking_heart', 'cactus', 'cactus_flower', 'sugar_cane', 'bamboo',
  'bamboo_sapling', 'pumpkin', 'melon', 'sweet_berry_bush', 'cocoa', 'lily_pad', 'big_dripleaf', 'big_dripleaf_stem',
  'small_dripleaf', 'cave_vines', 'cave_vines_plant', 'brown_mushroom', 'red_mushroom', 'brown_mushroom_block',
  'red_mushroom_block', 'mushroom_stem',
  // Water life
  'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant', 'sea_pickle', '*_coral', '*_coral_fan', '*_coral_wall_fan',
  '*_coral_block', 'sponge', 'wet_sponge', 'frogspawn', 'sniffer_egg', 'turtle_egg',
  // Nether
  'netherrack', 'soul_sand', 'soul_soil', 'basalt', 'blackstone', 'glowstone', 'nether_quartz_ore', 'nether_gold_ore',
  'crimson_nylium', 'warped_nylium', 'nether_wart_block', 'warped_wart_block', 'shroomlight', 'crimson_fungus',
  'warped_fungus', 'crimson_roots', 'warped_roots', 'nether_sprouts', 'weeping_vines', 'weeping_vines_plant',
  'twisting_vines', 'twisting_vines_plant', '*_stem', '*_hyphae', 'fire', 'soul_fire', 'gilded_blackstone',
  // End
  'end_stone', 'chorus_plant', 'chorus_flower', 'dragon_egg', 'end_gateway', 'end_portal', 'end_portal_frame',
];

const exact = new Set();
const patterns = [];
for (const n of NATURAL_NAMES) {
  if (n.includes('*')) patterns.push(new RegExp(`^${n.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`));
  else exact.add(n);
}
// Built things that a pattern above would catch by accident.
const NOT_NATURAL = /^stripped_|_planks$|_slab$|_stairs$|_wall$|_fence|_door$|_trapdoor$|_sign$|_button$|_pressure_plate$/;

const cache = new Map();

/** Is this block (namespaced or not) one the world generator places by itself? */
export function isNatural(name) {
  const n = String(name);
  let v = cache.get(n);
  if (v !== undefined) return v;
  const base = n.startsWith('minecraft:') ? n.slice(10) : n.includes(':') ? null : n;
  v = !!base && !NOT_NATURAL.test(base) && (exact.has(base) || patterns.some((re) => re.test(base)));
  cache.set(n, v);
  return v;
}

/*
 * Entities that say "a player was here": things hung on walls, stands, boats,
 * and any mob with a name or an owner. Minecarts are left out, because
 * mineshafts generate them with chests.
 */
const BUILT_ENTITIES = new Set([
  'item_frame', 'glow_item_frame', 'painting', 'armor_stand', 'leash_knot', 'item_display',
  'block_display', 'text_display', 'interaction', 'boat', 'chest_boat',
]);

export function isBuiltEntity(e) {
  const id = String(e && e.id || '').replace(/^minecraft:/, '');
  if (BUILT_ENTITIES.has(id) || id.endsWith('_boat') || id.endsWith('_raft')) return true;
  return e.CustomName !== undefined || e.Owner !== undefined || e.owner !== undefined;
}
