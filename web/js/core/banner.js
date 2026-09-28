/*
 * Build Minecraft banners: base colour + up to 6 pattern layers, exported as
 * a ready `/give` command. Two flavours, same split as book.js:
 *   - 1.20.5+ : /give @p <color>_banner[banner_patterns=[{pattern:...,color:...},...]]
 *   - <=1.20.4: /give @p <color>_banner{BlockEntityTag:{Patterns:[{Pattern:"xx",Color:n}]}}
 */

export const MAX_PATTERNS = 6;

// Official dye hex values, in their traditional (legacy numeric id) order —
// the order dyes have always shipped in, from white (0) to black (15).
export const DYES = [
  { id: 'white', label: 'Bianco', hex: '#f9fffe', legacy: 0 },
  { id: 'orange', label: 'Arancione', hex: '#f9801d', legacy: 1 },
  { id: 'magenta', label: 'Magenta', hex: '#c74ebd', legacy: 2 },
  { id: 'light_blue', label: 'Azzurro', hex: '#3ab3da', legacy: 3 },
  { id: 'yellow', label: 'Giallo', hex: '#fed83d', legacy: 4 },
  { id: 'lime', label: 'Verde lime', hex: '#80c71f', legacy: 5 },
  { id: 'pink', label: 'Rosa', hex: '#f38baa', legacy: 6 },
  { id: 'gray', label: 'Grigio', hex: '#474f52', legacy: 7 },
  { id: 'light_gray', label: 'Grigio chiaro', hex: '#9d9d97', legacy: 8 },
  { id: 'cyan', label: 'Ciano', hex: '#169c9c', legacy: 9 },
  { id: 'purple', label: 'Viola', hex: '#8932b8', legacy: 10 },
  { id: 'blue', label: 'Blu', hex: '#3c44aa', legacy: 11 },
  { id: 'brown', label: 'Marrone', hex: '#835432', legacy: 12 },
  { id: 'green', label: 'Verde', hex: '#5e7c16', legacy: 13 },
  { id: 'red', label: 'Rosso', hex: '#b02e26', legacy: 14 },
  { id: 'black', label: 'Nero', hex: '#1d1d21', legacy: 15 },
];

export function dyeById(id) {
  return DYES.find((d) => d.id === id) || DYES[0];
}

// Pattern id (modern component + block entity NBT), legacy two/three-letter
// code and an Italian label. `craftable: false` marks patterns that can't be
// dyed onto a banner in survival (Mojang logo, Piglin snout, Flow, Guster —
// these come from special items or creative only) so the UI can flag them.
export const PATTERNS = [
  { id: 'stripe_bottom', legacy: 'bs', label: 'Striscia (basso)' },
  { id: 'stripe_top', legacy: 'ts', label: 'Striscia (alto)' },
  { id: 'stripe_left', legacy: 'ls', label: 'Striscia (sinistra)' },
  { id: 'stripe_right', legacy: 'rs', label: 'Striscia (destra)' },
  { id: 'stripe_center', legacy: 'cs', label: 'Striscia (centro verticale)' },
  { id: 'stripe_middle', legacy: 'ms', label: 'Striscia (centro orizzontale)' },
  { id: 'stripe_downright', legacy: 'drs', label: 'Striscia diagonale ↘' },
  { id: 'stripe_downleft', legacy: 'dls', label: 'Striscia diagonale ↙' },
  { id: 'small_stripes', legacy: 'ss', label: 'Strisce sottili' },
  { id: 'cross', legacy: 'cr', label: 'Croce (X)' },
  { id: 'straight_cross', legacy: 'sc', label: 'Croce dritta (+)' },
  { id: 'triangle_bottom', legacy: 'bt', label: 'Triangolo (basso)' },
  { id: 'triangle_top', legacy: 'tt', label: 'Triangolo (alto)' },
  { id: 'triangles_bottom', legacy: 'bts', label: 'Triangoli (basso)' },
  { id: 'triangles_top', legacy: 'tts', label: 'Triangoli (alto)' },
  { id: 'diagonal_left', legacy: 'ld', label: 'Diagonale ↖' },
  { id: 'diagonal_right', legacy: 'rd', label: 'Diagonale ↗' },
  { id: 'diagonal_up_left', legacy: 'lud', label: 'Diagonale ↙ (inv.)' },
  { id: 'diagonal_up_right', legacy: 'rud', label: 'Diagonale ↘ (inv.)' },
  { id: 'circle', legacy: 'mc', label: 'Cerchio' },
  { id: 'rhombus', legacy: 'mr', label: 'Rombo' },
  { id: 'half_vertical', legacy: 'vh', label: 'Metà verticale' },
  { id: 'half_vertical_right', legacy: 'vhr', label: 'Metà verticale (dx)' },
  { id: 'half_horizontal', legacy: 'hh', label: 'Metà orizzontale' },
  { id: 'half_horizontal_bottom', legacy: 'hhb', label: 'Metà orizzontale (basso)' },
  { id: 'border', legacy: 'bo', label: 'Bordo' },
  { id: 'curly_border', legacy: 'cbo', label: 'Bordo ricciolo' },
  { id: 'gradient', legacy: 'gra', label: 'Sfumatura' },
  { id: 'gradient_up', legacy: 'gru', label: 'Sfumatura (dal basso)' },
  { id: 'bricks', legacy: 'bri', label: 'Mattoni' },
  { id: 'globe', legacy: 'glb', label: 'Globo' },
  { id: 'creeper', legacy: 'cre', label: 'Creeper' },
  { id: 'skull', legacy: 'sku', label: 'Teschio' },
  { id: 'flower', legacy: 'flo', label: 'Fiore' },
  { id: 'mojang', legacy: 'moj', label: 'Logo Mojang', craftable: false },
  { id: 'piglin', legacy: 'pig', label: 'Muso di Piglin' },
  { id: 'flow', legacy: 'flw', label: 'Flow', craftable: false },
  { id: 'guster', legacy: 'gus', label: 'Guster', craftable: false },
];

export function patternById(id) {
  return PATTERNS.find((p) => p.id === id) || PATTERNS[0];
}

/** Escape a string for use inside an SNBT double-quoted string. */
function snbtString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Full export for a banner: base colour item id plus both command flavours.
 * `patterns` is an ordered array of { pattern, color } (both dye/pattern ids),
 * bottom-most layer first — the same order the game applies them in.
 */
export function exportBanner({ baseColor, patterns, count }) {
  const base = dyeById(baseColor).id;
  const layers = (patterns || []).slice(0, MAX_PATTERNS);
  const n = Math.max(1, Math.min(64, Number(count) || 1));

  const modernList = layers.map((l) => `{pattern:${snbtString(patternById(l.pattern).id)},color:${snbtString(dyeById(l.color).id)}}`);
  const commandModern = layers.length
    ? `/give @p ${base}_banner[banner_patterns=[${modernList.join(',')}]] ${n}`
    : `/give @p ${base}_banner ${n}`;

  const legacyList = layers.map((l) => `{Pattern:${snbtString(patternById(l.pattern).legacy)},Color:${dyeById(l.color).legacy}}`);
  const command = layers.length
    ? `/give @p ${base}_banner{BlockEntityTag:{Patterns:[${legacyList.join(',')}]}} ${n}`
    : `/give @p ${base}_banner ${n}`;

  return {
    baseColor: base,
    patterns: layers,
    command,
    commandModern,
    mcfunction: [
      `# Banner — generato da Cube-Atlas`,
      commandModern.replace(/^\//, ''),
    ].join('\n'),
    mcfunctionLegacy: [
      `# Banner — generato da Cube-Atlas (<=1.20.4)`,
      command.replace(/^\//, ''),
    ].join('\n'),
  };
}
