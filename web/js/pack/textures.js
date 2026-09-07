/*
 * Building the texture array the scene samples from.
 *
 * Only the blocks actually present in the loaded portion get a texture, so a
 * meadow costs a handful of layers and not the twelve hundred the game ships.
 * Each one becomes a layer of a WebGL2 texture array rather than a tile in an
 * atlas: layers wrap independently, which is what lets a greedy-merged
 * rectangle four blocks wide simply run its coordinates 0..4 and repeat, with
 * no bleeding in from the tile next door.
 *
 * Three details of the game's own files matter here:
 *   - animated textures (water, lava, fire) are a vertical strip of frames;
 *     we take the first one;
 *   - rows are written bottom-up, so texture coordinate 0 is the bottom of
 *     the image and `v = y` puts a block's texture the right way up;
 *   - the sprites of full cubes get their transparent pixels filled in. Leaves
 *     are cut-out textures, and a canopy is drawn as a shell: left as they
 *     are, you would see the sky through the holes. Filling them is what the
 *     game's own fast graphics do.
 */

const MIN_TILE = 16;
const MAX_TILE = 128;

const FACE = { east: 0, west: 1, up: 2, down: 3, south: 4, north: 5 };
export const FACE_COUNT = 6;
export const NO_LAYER = -1;

/** Face index from the mesher's axis/direction pair. */
export const faceIndex = (d, dir) => d * 2 + (dir > 0 ? 0 : 1);

const pow2 = (n) => 2 ** Math.round(Math.log2(n));

const decode = (bytes) => createImageBitmap(new Blob([bytes], { type: 'image/png' }));

/**
 * One sprite as `tile x tile` RGBA, scaled with no smoothing so a 16-pixel
 * texture stays 16 pixels' worth of edges.
 */
function rasterise(bitmap, tile) {
  const frame = Math.min(bitmap.width, bitmap.height); // first frame of a strip
  const canvas = new OffscreenCanvas(tile, tile);
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, tile, tile);
  g.drawImage(bitmap, 0, 0, frame, frame, 0, 0, tile, tile);
  return g.getImageData(0, 0, tile, tile).data;
}

/**
 * Fill the see-through pixels with the average of the solid ones, so a cut-out
 * sprite can be used on a solid face. The transparent pixels' own colour is
 * gone by this point — a canvas stores premultiplied alpha — so it has to be
 * reconstructed rather than kept.
 */
function fillHoles(rgba) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] <= 128) continue;
    r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; n++;
  }
  if (!n || n === rgba.length / 4) return rgba;
  r = (r / n) | 0; g = (g / n) | 0; b = (b / n) | 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] > 128) continue;
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
  }
  return rgba;
}

class LayerSet {
  constructor(tile) {
    this.tile = tile;
    this.rows = [];          // Uint8ClampedArray per layer
    this.index = new Map();  // texture id, or "#rrggbb" for a flat colour
  }

  add(key, rgba) {
    const layer = this.rows.length;
    this.rows.push(rgba);
    this.index.set(key, layer);
    return layer;
  }

  /** A flat colour as a layer, for the blocks a pack has no texture for. */
  solid(rgb) {
    const key = `#${rgb.toString(16).padStart(6, '0')}`;
    if (this.index.has(key)) return this.index.get(key);
    const size = this.tile * this.tile;
    const rgba = new Uint8ClampedArray(size * 4);
    for (let i = 0; i < size; i++) {
      rgba[i * 4] = (rgb >> 16) & 255;
      rgba[i * 4 + 1] = (rgb >> 8) & 255;
      rgba[i * 4 + 2] = rgb & 255;
      rgba[i * 4 + 3] = 255;
    }
    return this.add(key, rgba);
  }

  /** Pack every layer into the single buffer a DataArrayTexture wants. */
  build() {
    const { tile } = this;
    const stride = tile * tile * 4;
    const data = new Uint8Array(stride * Math.max(1, this.rows.length));
    for (let layer = 0; layer < this.rows.length; layer++) {
      const src = this.rows[layer];
      const base = layer * stride;
      for (let y = 0; y < tile; y++) {
        const from = (tile - 1 - y) * tile * 4;   // flip: v = 0 is the bottom
        data.set(src.subarray(from, from + tile * 4), base + y * tile * 4);
      }
    }
    return { data, tile, layers: Math.max(1, this.rows.length) };
  }
}

/**
 * Resolve every state of a volume to texture layers.
 *
 * @param pack     ResourcePack
 * @param states   `{names, props}` of the volume's palette
 * @param fallback `(state) => packed rgb`, for what the pack cannot supply
 * @param solid    `(state) => boolean`, true for the states drawn as full
 *                 cubes, whose sprites get their holes filled
 * @returns `{ data, tile, layers, faces, cross }` — `faces` holds six layers
 *          per state (see faceIndex), `cross` one for the plants.
 */
export async function buildTextureLayers(pack, states, fallback, solid, onProgress) {
  const count = states.names.length;
  const faces = new Int32Array(count * FACE_COUNT).fill(NO_LAYER);
  const cross = new Int32Array(count).fill(NO_LAYER);

  const resolved = new Array(count).fill(null);
  const wanted = new Set();
  for (let state = 0; state < count; state++) {
    const found = await pack.facesFor(states.names[state], states.props[state]);
    resolved[state] = found;
    if (!found) continue;
    for (const key of Object.keys(found)) {
      if (found[key]) wanted.add(found[key]);
    }
  }

  // The pack's own resolution, taken from the first sprite that decodes.
  let tile = MIN_TILE;
  const bitmaps = new Map();
  let done = 0;
  for (const id of wanted) {
    const bytes = await pack.readTexture(id);
    if (bytes) {
      try {
        const bitmap = await decode(bytes);
        if (!bitmaps.size) {
          tile = Math.min(MAX_TILE,
            Math.max(MIN_TILE, pow2(Math.min(bitmap.width, bitmap.height))));
        }
        bitmaps.set(id, bitmap);
      } catch { /* a sprite we cannot read falls back to a flat colour */ }
    }
    done++;
    if (onProgress && (done & 15) === 0) onProgress(done / wanted.size);
  }

  const set = new LayerSet(tile);
  // The same sprite can serve a solid cube and a cut-out shape (glass, and
  // the pane made of it), so the two versions are separate layers.
  const layerOf = (id, fill) => {
    if (!id) return NO_LAYER;
    const key = fill ? `${id}!` : id;
    if (set.index.has(key)) return set.index.get(key);
    const bitmap = bitmaps.get(id);
    if (!bitmap) return NO_LAYER;
    const pixels = rasterise(bitmap, tile);
    return set.add(key, fill ? fillHoles(pixels) : pixels);
  };

  for (let state = 0; state < count; state++) {
    const found = resolved[state];
    let flatLayer = NO_LAYER;
    const flat = () => (flatLayer === NO_LAYER ? (flatLayer = set.solid(fallback(state))) : flatLayer);
    if (!found) {
      const layer = flat();
      for (let f = 0; f < FACE_COUNT; f++) faces[state * FACE_COUNT + f] = layer;
      cross[state] = layer;
      continue;
    }
    const fill = solid(state);
    for (const [name, f] of Object.entries(FACE)) {
      const layer = layerOf(found[name], fill);
      faces[state * FACE_COUNT + f] = layer === NO_LAYER ? flat() : layer;
    }
    const crossLayer = layerOf(found.cross, false);
    cross[state] = crossLayer === NO_LAYER ? faces[state * FACE_COUNT + FACE.up] : crossLayer;
  }

  for (const bitmap of bitmaps.values()) bitmap.close();
  return { ...set.build(), faces, cross };
}
