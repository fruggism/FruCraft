'use strict';
/*
 * Top-down map colors for Minecraft blocks, plus per-biome tinting for the
 * blocks the game itself tints (grass, foliage, water). Coverage of the ~1000
 * block types is necessarily partial; anything unmapped gets a stable
 * hash-derived color so it still reads as a distinct surface on the map.
 */

const COLORS = Object.create(null);

function set(names, rgb) {
  for (const n of [].concat(names)) COLORS[`minecraft:${n}`] = rgb;
}

// --- terrain ---------------------------------------------------------------
set('grass_block', [127, 178, 56]);
set(['dirt', 'farmland'], [134, 96, 67]);
set('coarse_dirt', [119, 85, 59]);
set('rooted_dirt', [144, 103, 76]);
set('podzol', [107, 79, 43]);
set('dirt_path', [148, 121, 65]);
set('mycelium', [111, 97, 100]);
set(['mud', 'packed_mud'], [92, 84, 78]);
set('muddy_mangrove_roots', [84, 67, 51]);
set(['stone', 'stone_slab', 'stone_stairs', 'smooth_stone'], [125, 125, 125]);
set(['cobblestone', 'cobblestone_stairs', 'cobblestone_slab', 'cobblestone_wall'], [122, 122, 122]);
set('mossy_cobblestone', [108, 122, 100]);
set(['stone_bricks', 'stone_brick_stairs', 'stone_brick_slab', 'stone_brick_wall'], [122, 122, 122]);
set('mossy_stone_bricks', [113, 125, 105]);
set('cracked_stone_bricks', [116, 116, 116]);
set('chiseled_stone_bricks', [119, 119, 119]);
set(['andesite', 'polished_andesite'], [136, 136, 137]);
set(['diorite', 'polished_diorite'], [188, 188, 188]);
set(['granite', 'polished_granite'], [149, 103, 86]);
set(['deepslate', 'polished_deepslate', 'deepslate_bricks', 'deepslate_tiles'], [77, 77, 82]);
set('cobbled_deepslate', [76, 76, 79]);
set(['tuff', 'polished_tuff'], [108, 109, 102]);
set('calcite', [223, 224, 219]);
set('dripstone_block', [140, 106, 87]);
set('smooth_basalt', [72, 72, 79]);
set(['basalt', 'polished_basalt'], [80, 79, 84]);
set(['blackstone', 'polished_blackstone', 'polished_blackstone_bricks'], [42, 36, 40]);
set(['sand', 'sandstone', 'smooth_sandstone', 'cut_sandstone', 'chiseled_sandstone'], [219, 207, 163]);
set('suspicious_sand', [214, 202, 158]);
set(['red_sand', 'red_sandstone', 'smooth_red_sandstone', 'cut_red_sandstone'], [190, 102, 33]);
set('gravel', [136, 126, 126]);
set('suspicious_gravel', [131, 122, 122]);
set('clay', [160, 166, 179]);
set(['snow', 'snow_block', 'powder_snow'], [248, 252, 252]);
set('ice', [141, 180, 250]);
set('packed_ice', [141, 172, 245]);
set('blue_ice', [116, 168, 253]);
set(['frosted_ice'], [140, 178, 246]);
set('bedrock', [51, 51, 51]);
set('obsidian', [20, 18, 29]);
set('crying_obsidian', [43, 12, 66]);
set(['netherrack', 'nether_bricks', 'nether_brick_stairs'], [110, 53, 51]);
set('crimson_nylium', [150, 30, 34]);
set('warped_nylium', [34, 128, 121]);
set('soul_sand', [82, 62, 49]);
set('soul_soil', [75, 60, 46]);
set(['glowstone', 'shroomlight'], [172, 133, 84]);
set('magma_block', [104, 51, 31]);
set(['end_stone', 'end_stone_bricks'], [219, 219, 165]);
set('purpur_block', [169, 125, 169]);
set('mud_bricks', [137, 105, 78]);
set('amethyst_block', [133, 97, 191]);
set('budding_amethyst', [128, 92, 186]);
set('moss_block', [89, 121, 46]);
set('moss_carpet', [89, 121, 46]);
set('sculk', [12, 32, 39]);
set('sculk_catalyst', [24, 44, 52]);
set('bone_block', [209, 206, 179]);

// --- liquids ---------------------------------------------------------------
set(['water', 'bubble_column'], [63, 118, 228]);
set('lava', [217, 89, 22]);

// --- vegetation ------------------------------------------------------------
set(['short_grass', 'grass', 'tall_grass', 'fern', 'large_fern'], [110, 164, 60]);
set(['sugar_cane'], [148, 189, 96]);
set(['vine', 'glow_lichen'], [80, 122, 46]);
set(['lily_pad'], [32, 96, 32]);
set(['cactus'], [80, 130, 42]);
set(['bamboo', 'bamboo_block'], [117, 160, 45]);
set(['wheat', 'carrots', 'potatoes', 'beetroots'], [148, 174, 71]);
set(['pumpkin', 'carved_pumpkin', 'jack_o_lantern'], [198, 118, 24]);
set('melon', [111, 156, 45]);
set(['hay_block'], [180, 148, 30]);
set(['dead_bush'], [123, 92, 46]);
set(['kelp', 'kelp_plant'], [62, 122, 55]);
set(['seagrass', 'tall_seagrass'], [61, 128, 57]);
set(['brown_mushroom_block'], [149, 111, 84]);
set(['red_mushroom_block'], [180, 46, 43]);
set(['mushroom_stem'], [204, 199, 189]);
set(['nether_wart_block'], [123, 15, 15]);
set(['warped_wart_block'], [22, 119, 121]);
set(['sponge', 'wet_sponge'], [195, 192, 78]);

// flowers (small, but they do show up on the surface)
set(['dandelion', 'sunflower'], [221, 200, 60]);
set(['poppy', 'rose_bush', 'red_tulip'], [180, 47, 44]);
set(['blue_orchid', 'cornflower'], [64, 129, 194]);
set(['allium', 'lilac'], [172, 133, 200]);
set(['azure_bluet', 'oxeye_daisy', 'lily_of_the_valley', 'white_tulip'], [220, 220, 210]);
set(['orange_tulip'], [214, 132, 45]);
set(['pink_tulip', 'peony'], [216, 160, 190]);
set(['torchflower'], [222, 143, 60]);
set(['pitcher_plant'], [110, 90, 180]);

// --- wood species ----------------------------------------------------------
const WOOD = {
  oak: { leaves: [60, 105, 39], log: [102, 82, 49], planks: [162, 130, 78] },
  spruce: { leaves: [56, 84, 44], log: [58, 40, 22], planks: [114, 84, 48] },
  birch: { leaves: [82, 115, 63], log: [215, 211, 169], planks: [196, 179, 123] },
  jungle: { leaves: [52, 112, 41], log: [85, 67, 40], planks: [160, 116, 79] },
  acacia: { leaves: [83, 114, 40], log: [103, 80, 56], planks: [168, 90, 50] },
  dark_oak: { leaves: [58, 79, 35], log: [60, 46, 27], planks: [66, 43, 20] },
  mangrove: { leaves: [56, 106, 55], log: [86, 47, 46], planks: [117, 61, 59] },
  cherry: { leaves: [232, 176, 210], log: [95, 63, 60], planks: [227, 176, 172] },
  pale_oak: { leaves: [178, 191, 178], log: [123, 122, 116], planks: [217, 212, 202] },
  bamboo: { leaves: [117, 160, 45], log: [117, 160, 45], planks: [193, 158, 72] },
  crimson: { leaves: [140, 30, 33], log: [92, 25, 29], planks: [101, 48, 71] },
  warped: { leaves: [34, 128, 121], log: [58, 100, 100], planks: [43, 104, 100] },
};
for (const [sp, c] of Object.entries(WOOD)) {
  set([`${sp}_leaves`], c.leaves);
  set([`${sp}_log`, `${sp}_wood`, `${sp}_stem`, `${sp}_hyphae`], c.log);
  set([`stripped_${sp}_log`, `stripped_${sp}_wood`, `stripped_${sp}_stem`], c.log.map((v) => Math.min(255, v + 28)));
  set([`${sp}_planks`, `${sp}_stairs`, `${sp}_slab`, `${sp}_fence`, `${sp}_fence_gate`,
    `${sp}_door`, `${sp}_trapdoor`, `${sp}_pressure_plate`, `${sp}_sign`, `${sp}_button`], c.planks);
}
set(['azalea_leaves', 'azalea'], [90, 116, 48]);
set(['flowering_azalea_leaves', 'flowering_azalea'], [110, 122, 60]);
set('mangrove_roots', [86, 47, 46]);

// --- dyed block families ---------------------------------------------------
const DYE = {
  white: [233, 236, 236], orange: [240, 118, 19], magenta: [189, 68, 179],
  light_blue: [58, 175, 217], yellow: [248, 198, 39], lime: [112, 185, 25],
  pink: [237, 141, 172], gray: [62, 68, 71], light_gray: [142, 142, 134],
  cyan: [21, 137, 145], purple: [121, 42, 172], blue: [53, 57, 157],
  brown: [114, 71, 40], green: [84, 109, 27], red: [161, 39, 34], black: [20, 21, 25],
};
const TERRA = {
  white: [209, 178, 161], orange: [161, 83, 37], magenta: [149, 88, 108],
  light_blue: [113, 108, 137], yellow: [186, 133, 35], lime: [103, 117, 52],
  pink: [161, 78, 78], gray: [57, 42, 35], light_gray: [135, 106, 97],
  cyan: [87, 91, 91], purple: [118, 70, 86], blue: [74, 59, 91],
  brown: [77, 51, 35], green: [76, 83, 42], red: [143, 61, 46], black: [37, 22, 16],
};
for (const [name, c] of Object.entries(DYE)) {
  set([`${name}_wool`, `${name}_carpet`, `${name}_concrete`, `${name}_bed`,
    `${name}_stained_glass`, `${name}_stained_glass_pane`, `${name}_glazed_terracotta`,
    `${name}_shulker_box`, `${name}_banner`, `${name}_candle`], c);
  set([`${name}_concrete_powder`], c.map((v) => Math.min(255, v + 16)));
}
for (const [name, c] of Object.entries(TERRA)) set([`${name}_terracotta`], c);
set('terracotta', [152, 94, 67]);

// --- ores & metal / utility blocks -----------------------------------------
set(['coal_ore', 'deepslate_coal_ore'], [105, 105, 105]);
set(['iron_ore', 'deepslate_iron_ore'], [136, 130, 127]);
set(['copper_ore', 'deepslate_copper_ore'], [140, 122, 106]);
set(['gold_ore', 'deepslate_gold_ore', 'nether_gold_ore'], [143, 140, 125]);
set(['redstone_ore', 'deepslate_redstone_ore'], [133, 107, 107]);
set(['lapis_ore', 'deepslate_lapis_ore'], [107, 117, 141]);
set(['diamond_ore', 'deepslate_diamond_ore'], [129, 140, 143]);
set(['emerald_ore', 'deepslate_emerald_ore'], [110, 138, 116]);
set('ancient_debris', [92, 65, 58]);
set(['iron_block', 'iron_bars', 'iron_door', 'iron_trapdoor'], [220, 220, 220]);
set('gold_block', [246, 208, 61]);
set('diamond_block', [98, 219, 214]);
set('emerald_block', [42, 203, 87]);
set('lapis_block', [30, 68, 141]);
set('redstone_block', [175, 24, 5]);
set('netherite_block', [67, 61, 63]);
set(['copper_block', 'cut_copper', 'waxed_copper_block'], [192, 107, 79]);
set(['exposed_copper', 'exposed_cut_copper'], [161, 125, 103]);
set(['weathered_copper', 'weathered_cut_copper'], [108, 153, 117]);
set(['oxidized_copper', 'oxidized_cut_copper'], [82, 162, 132]);
set(['coal_block'], [16, 15, 15]);
set(['quartz_block', 'smooth_quartz', 'chiseled_quartz_block', 'quartz_bricks', 'quartz_pillar'], [235, 229, 222]);
set(['bricks', 'brick_stairs', 'brick_slab'], [151, 96, 82]);
set(['prismarine', 'prismarine_bricks'], [99, 156, 151]);
set('dark_prismarine', [51, 92, 74]);
set('sea_lantern', [197, 219, 213]);
set(['glass', 'glass_pane', 'tinted_glass'], [200, 218, 226]);
set(['crafting_table', 'chest', 'trapped_chest', 'barrel', 'lectern', 'bookshelf', 'loom', 'composter'], [143, 111, 62]);
set(['furnace', 'blast_furnace', 'smoker', 'dispenser', 'dropper', 'observer'], [110, 110, 110]);
set(['anvil', 'grindstone', 'hopper', 'cauldron'], [70, 70, 74]);
set(['torch', 'wall_torch', 'lantern', 'soul_lantern', 'campfire', 'soul_campfire'], [190, 150, 70]);
set(['rail', 'powered_rail', 'detector_rail', 'activator_rail'], [140, 128, 110]);
set(['note_block', 'jukebox'], [104, 74, 52]);
set(['beacon', 'conduit'], [140, 220, 215]);
set(['end_portal_frame', 'end_portal', 'end_gateway'], [30, 40, 40]);
set(['nether_portal'], [104, 44, 168]);
set(['spawner'], [26, 39, 49]);
set(['slime_block'], [111, 192, 91]);
set(['honey_block', 'honeycomb_block'], [217, 156, 47]);
set(['scaffolding'], [190, 156, 92]);
set(['cobweb'], [220, 220, 220]);
set(['ladder'], [143, 111, 62]);
set(['tnt'], [180, 60, 45]);
set(['target'], [214, 187, 165]);
set(['reinforced_deepslate'], [86, 90, 84]);
set(['chiseled_bookshelf'], [154, 118, 71]);
set(['decorated_pot'], [170, 100, 78]);

// ---------------------------------------------------------------------------
// Biome tinting
// ---------------------------------------------------------------------------
// Blocks the game tints by biome. Values are multiplied against the biome's
// grass/foliage/water color rather than used literally.
const GRASS_TINTED = new Set([
  'minecraft:grass_block', 'minecraft:short_grass', 'minecraft:grass',
  'minecraft:tall_grass', 'minecraft:fern', 'minecraft:large_fern',
  'minecraft:sugar_cane', 'minecraft:potted_fern',
]);
const FOLIAGE_TINTED = new Set([
  'minecraft:oak_leaves', 'minecraft:jungle_leaves', 'minecraft:acacia_leaves',
  'minecraft:dark_oak_leaves', 'minecraft:mangrove_leaves', 'minecraft:vine',
]);
const WATER_TINTED = new Set(['minecraft:water', 'minecraft:bubble_column']);

// grass / foliage / water per biome. Unlisted biomes use the default.
const DEFAULT_TINT = { grass: [145, 189, 89], foliage: [119, 171, 47], water: [63, 118, 228] };
const BIOME_TINTS = {
  'minecraft:plains': { grass: [145, 189, 89], foliage: [119, 171, 47] },
  'minecraft:sunflower_plains': { grass: [145, 189, 89], foliage: [119, 171, 47] },
  'minecraft:meadow': { grass: [131, 187, 87], foliage: [110, 166, 42] },
  'minecraft:cherry_grove': { grass: [180, 203, 141], foliage: [176, 203, 136] },
  'minecraft:forest': { grass: [121, 192, 90], foliage: [89, 174, 48] },
  'minecraft:flower_forest': { grass: [121, 192, 90], foliage: [89, 174, 48] },
  'minecraft:birch_forest': { grass: [136, 187, 103], foliage: [110, 169, 65] },
  'minecraft:old_growth_birch_forest': { grass: [136, 187, 103], foliage: [110, 169, 65] },
  'minecraft:dark_forest': { grass: [80, 122, 50], foliage: [59, 132, 25] },
  'minecraft:pale_garden': { grass: [119, 129, 116], foliage: [135, 141, 132] },
  'minecraft:taiga': { grass: [134, 183, 133], foliage: [104, 163, 101] },
  'minecraft:snowy_taiga': { grass: [128, 180, 151], foliage: [96, 161, 123], water: [61, 87, 214] },
  'minecraft:old_growth_pine_taiga': { grass: [134, 183, 133], foliage: [104, 163, 101] },
  'minecraft:old_growth_spruce_taiga': { grass: [134, 183, 133], foliage: [104, 163, 101] },
  'minecraft:jungle': { grass: [89, 201, 60], foliage: [48, 187, 11] },
  'minecraft:sparse_jungle': { grass: [100, 199, 63], foliage: [62, 186, 18] },
  'minecraft:bamboo_jungle': { grass: [89, 201, 60], foliage: [48, 187, 11] },
  'minecraft:savanna': { grass: [191, 183, 85], foliage: [174, 164, 42] },
  'minecraft:savanna_plateau': { grass: [191, 183, 85], foliage: [174, 164, 42] },
  'minecraft:windswept_savanna': { grass: [191, 183, 85], foliage: [174, 164, 42] },
  'minecraft:desert': { grass: [191, 183, 85], foliage: [174, 164, 42], water: [50, 162, 168] },
  'minecraft:badlands': { grass: [144, 129, 77], foliage: [158, 129, 77], water: [79, 145, 191] },
  'minecraft:eroded_badlands': { grass: [144, 129, 77], foliage: [158, 129, 77], water: [79, 145, 191] },
  'minecraft:wooded_badlands': { grass: [144, 129, 77], foliage: [158, 129, 77], water: [79, 145, 191] },
  'minecraft:swamp': { grass: [106, 112, 57], foliage: [106, 112, 57], water: [97, 123, 100] },
  'minecraft:mangrove_swamp': { grass: [106, 112, 57], foliage: [141, 177, 100], water: [58, 122, 106] },
  'minecraft:snowy_plains': { grass: [128, 180, 151], foliage: [96, 161, 123], water: [61, 87, 214] },
  'minecraft:ice_spikes': { grass: [128, 180, 151], foliage: [96, 161, 123], water: [61, 87, 214] },
  'minecraft:snowy_slopes': { grass: [128, 180, 151], foliage: [96, 161, 123], water: [61, 87, 214] },
  'minecraft:frozen_peaks': { grass: [128, 180, 151], foliage: [96, 161, 123], water: [61, 87, 214] },
  'minecraft:jagged_peaks': { grass: [128, 180, 151], foliage: [96, 161, 123], water: [61, 87, 214] },
  'minecraft:stony_peaks': { grass: [151, 187, 100], foliage: [125, 170, 60] },
  'minecraft:grove': { grass: [128, 180, 151], foliage: [96, 161, 123] },
  'minecraft:windswept_hills': { grass: [138, 184, 122], foliage: [106, 166, 88] },
  'minecraft:windswept_forest': { grass: [138, 184, 122], foliage: [106, 166, 88] },
  'minecraft:windswept_gravelly_hills': { grass: [138, 184, 122], foliage: [106, 166, 88] },
  'minecraft:beach': { grass: [145, 189, 89], foliage: [119, 171, 47] },
  'minecraft:snowy_beach': { grass: [128, 180, 151], foliage: [96, 161, 123], water: [61, 87, 214] },
  'minecraft:stony_shore': { grass: [138, 184, 122], foliage: [106, 166, 88] },
  'minecraft:river': { water: [63, 118, 228] },
  'minecraft:frozen_river': { grass: [128, 180, 151], foliage: [96, 161, 123], water: [57, 56, 201] },
  'minecraft:ocean': { water: [63, 118, 228] },
  'minecraft:deep_ocean': { water: [63, 118, 228] },
  'minecraft:cold_ocean': { water: [61, 87, 214] },
  'minecraft:deep_cold_ocean': { water: [61, 87, 214] },
  'minecraft:frozen_ocean': { grass: [128, 180, 151], foliage: [96, 161, 123], water: [57, 56, 201] },
  'minecraft:deep_frozen_ocean': { water: [57, 56, 201] },
  'minecraft:lukewarm_ocean': { water: [69, 173, 242] },
  'minecraft:deep_lukewarm_ocean': { water: [69, 173, 242] },
  'minecraft:warm_ocean': { water: [67, 213, 238] },
  'minecraft:mushroom_fields': { grass: [85, 201, 63], foliage: [43, 187, 15] },
  'minecraft:lush_caves': { grass: [112, 195, 55], foliage: [89, 174, 48] },
  'minecraft:dripstone_caves': { grass: [145, 189, 89], foliage: [119, 171, 47] },
  'minecraft:deep_dark': { grass: [122, 172, 92], foliage: [96, 161, 123] },
  'minecraft:nether_wastes': { water: [144, 61, 30] },
  'minecraft:the_end': { water: [98, 82, 158] },
};

const fallbackCache = new Map();

function hashColor(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return [
    100 + ((h >>> 0) % 120),
    100 + ((h >>> 8) % 120),
    100 + ((h >>> 16) % 120),
  ];
}

function baseColor(blockName) {
  const c = COLORS[blockName];
  if (c) return c;
  let f = fallbackCache.get(blockName);
  if (!f) { f = hashColor(blockName); fallbackCache.set(blockName, f); }
  return f;
}

function tintFor(biomeName, channel) {
  const t = (biomeName && BIOME_TINTS[biomeName]) || null;
  if (t && t[channel]) return t[channel];
  return DEFAULT_TINT[channel];
}

/**
 * Final map color for a surface block, applying biome tint where the game
 * would. `biomeName` may be null (older worlds) — the default tint is used.
 */
function colorFor(blockName, biomeName) {
  const base = baseColor(blockName);
  if (GRASS_TINTED.has(blockName)) return mix(base, tintFor(biomeName, 'grass'));
  if (FOLIAGE_TINTED.has(blockName)) return mix(base, tintFor(biomeName, 'foliage'));
  if (WATER_TINTED.has(blockName)) return tintFor(biomeName, 'water');
  return base;
}

/** Multiply-blend a block's base color by a biome tint (as the game does). */
function mix(base, tint) {
  return [
    Math.round((base[0] * tint[0]) / 255),
    Math.round((base[1] * tint[1]) / 255),
    Math.round((base[2] * tint[2]) / 255),
  ];
}

module.exports = { colorFor, baseColor, COLORS, BIOME_TINTS, GRASS_TINTED, FOLIAGE_TINTED, WATER_TINTED };
