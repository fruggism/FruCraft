/*
 * Generates the tileable 16x16 pixel textures that give Cube-Atlas its
 * Minecraft look, and writes them into web/css/textures.css as data URIs.
 * Keeping them inline means the UI needs no external asset requests and works
 * fully offline. Re-run with: npm run textures
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const OUT_CSS = path.join(__dirname, '..', 'web', 'css', 'textures.css');

/*
 * Minimal PNG encoder, so generating the textures needs no dependency at all.
 * Only what this tool emits is supported: 8-bit RGBA, no interlacing.
 */
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng({ width, height, data }) {
  // Each scanline is prefixed with its filter type (0 = none).
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    data.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Stand-in for the pngjs image object the generators below fill in. */
class Image {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = Buffer.alloc(width * height * 4);
  }
}

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
  const png = new Image(size, size);
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
  const png = new Image(size, size);
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
  const png = new Image(size, size);
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
  return `data:image/png;base64,${encodePng(png).toString('base64')}`;
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

main();

export { noiseTexture, plankTexture, grassTexture, toDataURI, encodePng, TEXTURES };
