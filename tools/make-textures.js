'use strict';
/*
 * Generates the tileable 16x16 pixel textures that give Cube-Atlas its
 * Minecraft look, and writes them into public/css/textures.css as data URIs.
 * Keeping them inline means the UI needs no external asset requests and works
 * fully offline. Re-run with: npm run textures
 */

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const OUT_CSS = path.join(__dirname, '..', 'public', 'css', 'textures.css');

/** Deterministic PRNG so regenerating the textures never churns the CSS file. */
function makeRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** Noise texture: a base color with per-pixel brightness jitter, as in
 *  Minecraft's dirt/stone/sand blocks. */
function noiseTexture({ size = 16, base, jitter = 22, seed = 1, coarse = 1 }) {
  const rnd = makeRandom(seed);
  const png = new PNG({ width: size, height: size });
  const cells = size / coarse;
  const values = new Float32Array(cells * cells);
  for (let i = 0; i < values.length; i++) values[i] = (rnd() - 0.5) * 2 * jitter;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = values[Math.floor(y / coarse) * cells + Math.floor(x / coarse)];
      const i = (y * size + x) * 4;
      png.data[i] = clamp(base[0] + d);
      png.data[i + 1] = clamp(base[1] + d);
      png.data[i + 2] = clamp(base[2] + d);
      png.data[i + 3] = 255;
    }
  }
  return png;
}

/** Plank texture: horizontal boards with darker seams and grain. */
function plankTexture({ size = 16, base, seed = 7 }) {
  const rnd = makeRandom(seed);
  const png = new PNG({ width: size, height: size });
  const boardHeight = size / 4;
  for (let y = 0; y < size; y++) {
    const inBoard = y % boardHeight;
    const isSeam = inBoard === 0;
    for (let x = 0; x < size; x++) {
      let d = (rnd() - 0.5) * 14;
      if (isSeam) d -= 42;
      // occasional vertical grain line
      if (!isSeam && (x * 7 + y * 3) % 13 === 0) d -= 12;
      const i = (y * size + x) * 4;
      png.data[i] = clamp(base[0] + d);
      png.data[i + 1] = clamp(base[1] + d);
      png.data[i + 2] = clamp(base[2] + d);
      png.data[i + 3] = 255;
    }
  }
  return png;
}

/** Grass-block top: noisy green with a couple of darker speckles. */
function grassTexture({ size = 16, seed = 3 }) {
  const rnd = makeRandom(seed);
  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = (rnd() - 0.5) * 34;
      const i = (y * size + x) * 4;
      png.data[i] = clamp(106 + d);
      png.data[i + 1] = clamp(150 + d);
      png.data[i + 2] = clamp(58 + d * 0.6);
      png.data[i + 3] = 255;
    }
  }
  return png;
}

const TEXTURES = {
  dirt: () => noiseTexture({ base: [134, 96, 67], jitter: 26, seed: 11, coarse: 2 }),
  stone: () => noiseTexture({ base: [125, 125, 125], jitter: 18, seed: 23, coarse: 2 }),
  deepslate: () => noiseTexture({ base: [62, 62, 68], jitter: 14, seed: 31, coarse: 2 }),
  sand: () => noiseTexture({ base: [214, 203, 160], jitter: 16, seed: 41, coarse: 2 }),
  planks: () => plankTexture({ base: [162, 130, 78], seed: 53 }),
  darkPlanks: () => plankTexture({ base: [78, 56, 32], seed: 59 }),
  grass: () => grassTexture({ seed: 67 }),
};

function toDataURI(png) {
  return `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`;
}

function main() {
  const lines = [
    '/* Texture pixel generate da tools/make-textures.js — non modificare a mano.',
    ' * Rigenerale con: npm run textures',
    ' */',
    ':root {',
  ];
  for (const [name, build] of Object.entries(TEXTURES)) {
    const varName = `--tex-${name.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
    lines.push(`  ${varName}: url("${toDataURI(build())}");`);
  }
  lines.push('}');
  lines.push('');
  fs.mkdirSync(path.dirname(OUT_CSS), { recursive: true });
  fs.writeFileSync(OUT_CSS, lines.join('\n'));
  const kb = (fs.statSync(OUT_CSS).size / 1024).toFixed(1);
  console.log(`Texture scritte in ${OUT_CSS} (${kb} KB)`);
}

if (require.main === module) main();

module.exports = { noiseTexture, plankTexture, grassTexture, toDataURI, TEXTURES };
