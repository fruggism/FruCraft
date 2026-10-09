/*
 * The vanilla biomes, per dimension, with an Italian label and a flat colour
 * for the biome picker and the "biome view" of the map. Colours follow the
 * conventions of the usual biome maps (deserts sand-yellow, oceans blue by
 * depth and temperature, forests green by density) so a map reads at a glance.
 *
 * A world can carry biomes of data packs: they are not listed here, the
 * picker adds the ones it finds, and they get a colour from their name.
 */

const B = (id, label, color, dim = 'overworld') => ({ id: `minecraft:${id}`, label, color, dim });

export const BIOMES = [
  B('plains', 'Pianura', [141, 179, 96]),
  B('sunflower_plains', 'Pianura di girasoli', [181, 219, 136]),
  B('snowy_plains', 'Pianura innevata', [240, 245, 248]),
  B('ice_spikes', 'Punte di ghiaccio', [180, 220, 220]),
  B('desert', 'Deserto', [250, 210, 120]),
  B('swamp', 'Palude', [7, 249, 178]),
  B('mangrove_swamp', 'Palude di mangrovie', [44, 204, 142]),
  B('forest', 'Foresta', [5, 102, 33]),
  B('flower_forest', 'Foresta fiorita', [45, 142, 73]),
  B('birch_forest', 'Foresta di betulle', [48, 116, 68]),
  B('dark_forest', 'Foresta oscura', [64, 81, 26]),
  B('pale_garden', 'Giardino pallido', [140, 150, 138]),
  B('old_growth_birch_forest', 'Betulleto secolare', [88, 156, 108]),
  B('old_growth_pine_taiga', 'Taiga di pini secolare', [89, 102, 81]),
  B('old_growth_spruce_taiga', 'Taiga di abeti secolare', [129, 142, 121]),
  B('taiga', 'Taiga', [11, 102, 89]),
  B('snowy_taiga', 'Taiga innevata', [49, 85, 74]),
  B('savanna', 'Savana', [189, 178, 95]),
  B('savanna_plateau', 'Altopiano della savana', [167, 157, 100]),
  B('windswept_hills', 'Colline ventose', [96, 96, 96]),
  B('windswept_gravelly_hills', 'Colline ghiaiose ventose', [136, 136, 136]),
  B('windswept_forest', 'Foresta ventosa', [80, 112, 80]),
  B('windswept_savanna', 'Savana ventosa', [229, 218, 135]),
  B('jungle', 'Giungla', [83, 123, 9]),
  B('sparse_jungle', 'Giungla rada', [98, 139, 23]),
  B('bamboo_jungle', 'Giungla di bambù', [118, 142, 20]),
  B('badlands', 'Calanchi', [217, 69, 21]),
  B('eroded_badlands', 'Calanchi erosi', [255, 109, 61]),
  B('wooded_badlands', 'Calanchi boscosi', [176, 151, 101]),
  B('meadow', 'Prato', [131, 187, 87]),
  B('cherry_grove', 'Boschetto di ciliegi', [255, 183, 215]),
  B('grove', 'Boschetto', [140, 170, 160]),
  B('snowy_slopes', 'Pendii innevati', [200, 220, 230]),
  B('frozen_peaks', 'Vette ghiacciate', [160, 190, 220]),
  B('jagged_peaks', 'Vette frastagliate', [220, 220, 235]),
  B('stony_peaks', 'Vette rocciose', [150, 150, 140]),
  B('river', 'Fiume', [0, 0, 255]),
  B('frozen_river', 'Fiume ghiacciato', [160, 160, 255]),
  B('beach', 'Spiaggia', [250, 222, 85]),
  B('snowy_beach', 'Spiaggia innevata', [250, 240, 192]),
  B('stony_shore', 'Costa rocciosa', [162, 162, 132]),
  B('warm_ocean', 'Oceano caldo', [0, 0, 172]),
  B('lukewarm_ocean', 'Oceano tiepido', [0, 0, 144]),
  B('deep_lukewarm_ocean', 'Oceano tiepido profondo', [0, 0, 64]),
  B('ocean', 'Oceano', [0, 0, 112]),
  B('deep_ocean', 'Oceano profondo', [0, 0, 48]),
  B('cold_ocean', 'Oceano freddo', [32, 32, 112]),
  B('deep_cold_ocean', 'Oceano freddo profondo', [32, 32, 56]),
  B('frozen_ocean', 'Oceano ghiacciato', [112, 112, 214]),
  B('deep_frozen_ocean', 'Oceano ghiacciato profondo', [64, 64, 144]),
  B('mushroom_fields', 'Campi di funghi', [255, 0, 255]),
  B('dripstone_caves', 'Grotte di speleotemi', [134, 96, 67]),
  B('lush_caves', 'Grotte lussureggianti', [40, 140, 60]),
  B('deep_dark', 'Oscurità profonda', [20, 40, 50]),
  B('nether_wastes', 'Lande del Nether', [191, 59, 59], 'the_nether'),
  B('warped_forest', 'Foresta distorta', [73, 144, 123], 'the_nether'),
  B('crimson_forest', 'Foresta cremisi', [221, 8, 8], 'the_nether'),
  B('soul_sand_valley', 'Valle delle anime', [94, 56, 48], 'the_nether'),
  B('basalt_deltas', 'Delta di basalto', [64, 54, 54], 'the_nether'),
  B('the_end', 'End', [128, 128, 255], 'the_end'),
  B('end_highlands', 'Altopiani dell\'End', [181, 181, 54], 'the_end'),
  B('end_midlands', 'Terre medie dell\'End', [255, 255, 128], 'the_end'),
  B('small_end_islands', 'Isolette dell\'End', [128, 128, 255], 'the_end'),
  B('end_barrens', 'Lande dell\'End', [128, 128, 255], 'the_end'),
  B('the_void', 'Vuoto', [0, 0, 0], 'the_end'),
];

const byId = new Map(BIOMES.map((b) => [b.id, b]));

/** Biomes for the picker of one dimension (custom dimensions get the overworld ones). */
export function biomesFor(dim) {
  const d = ['the_nether', 'the_end'].includes(dim) ? dim : 'overworld';
  return BIOMES.filter((b) => b.dim === d);
}

/** Stable colour for any biome id, listed or not. */
export function biomeColor(id) {
  const b = byId.get(id);
  if (b) return b.color;
  let h = 2166136261;
  for (let i = 0; i < String(id).length; i++) h = Math.imul(h ^ String(id).charCodeAt(i), 16777619);
  return [64 + ((h >>> 0) & 127), 64 + ((h >>> 8) & 127), 64 + ((h >>> 16) & 127)];
}

export function biomeLabel(id) {
  const b = byId.get(id);
  return b ? b.label : String(id).replace(/^minecraft:/, '');
}
