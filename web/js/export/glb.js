/*
 * The loaded portion as a .glb file.
 *
 * The scene on screen cannot be handed to glTF as it stands, for two reasons:
 *
 *   - the sprites live in a WebGL2 texture array, and glTF has no such thing;
 *   - the coordinates repeat. A greedy-merged rectangle four blocks wide runs
 *     its texture coordinates 0..4 and lets the sampler tile them, which is
 *     what keeps the meshes merged (see web/js/pack/textures.js).
 *
 * Baking the layers into one atlas would break the second point: tiled
 * coordinates would drag in the neighbouring sprite. So each layer becomes its
 * own image and its own material instead, with the sampler set to REPEAT — the
 * coordinates then mean exactly what they meant on screen. The triangles are
 * regrouped by layer, which costs nothing in vertices: it is the same geometry,
 * sorted differently, and it comes out as a handful of materials named after
 * the blocks rather than one giant unusable mesh.
 *
 * The shading is already baked into the vertex colours (face shade, ambient
 * occlusion, biome tint), so the materials are declared unlit: a viewer that
 * lit them again would be lighting them twice.
 */

const MAGIC = 0x46546c67;          // "glTF"
const VERSION = 2;
const CHUNK_JSON = 0x4e4f534a;     // "JSON"
const CHUNK_BIN = 0x004e4942;      // "BIN\0"

const UBYTE = 5121, UINT = 5125, FLOAT = 5126;
const ARRAY_BUFFER = 34962, ELEMENT_ARRAY_BUFFER = 34963;
const NEAREST = 9728, REPEAT = 10497;

const align4 = (n) => (n + 3) & ~3;

/** A typed array that grows, so the groups can be filled in one pass. */
class Buf {
  constructor(Type, size = 4096) {
    this.data = new Type(size);
    this.n = 0;
  }

  push(...values) {
    if (this.n + values.length > this.data.length) {
      const bigger = new this.data.constructor(
        Math.max(this.data.length * 2, this.n + values.length));
      bigger.set(this.data.subarray(0, this.n));
      this.data = bigger;
    }
    for (const v of values) this.data[this.n++] = v;
  }

  out() { return this.data.slice(0, this.n); }
}

/** One vertex, pulled out of a source's attributes so it can be interpolated. */
const read = (source, v) => ({
  x: source.positions[v * 3] + (source.offset ? source.offset[0] : 0),
  y: source.positions[v * 3 + 1] + (source.offset ? source.offset[1] : 0),
  z: source.positions[v * 3 + 2] + (source.offset ? source.offset[2] : 0),
  r: source.colors[v * 3], g: source.colors[v * 3 + 1], b: source.colors[v * 3 + 2],
  u: source.uvs ? source.uvs[v * 2] : 0,
  w: source.uvs ? source.uvs[v * 2 + 1] : 0,
});

/** Add a vertex to a group, returning its index there. */
function append(group, p) {
  const index = group.positions.n / 3;
  group.positions.push(p.x, p.y, p.z);
  // glTF wants every vertex element on a 4-byte boundary, so the colours go
  // out as RGBA even though nothing reads the alpha.
  group.colors.push(p.r, p.g, p.b, 255);
  if (group.uvs) group.uvs.push(p.u, p.w);
  return index;
}

const mix = (p, q, t) => ({
  x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, z: p.z + (q.z - p.z) * t,
  r: Math.round(p.r + (q.r - p.r) * t),
  g: Math.round(p.g + (q.g - p.g) * t),
  b: Math.round(p.b + (q.b - p.b) * t),
  u: p.u + (q.u - p.u) * t, w: p.w + (q.w - p.w) * t,
});

/**
 * The part of a triangle below `y`, as a convex polygon (three or four
 * corners, or none). Sutherland–Hodgman against a single horizontal plane.
 */
function clipTriangle(tri, y) {
  const out = [];
  for (let i = 0; i < 3; i++) {
    const p = tri[i], q = tri[(i + 1) % 3];
    const pIn = p.y < y, qIn = q.y < y;
    if (pIn) out.push(p);
    if (pIn !== qIn) out.push(mix(p, q, (y - p.y) / (q.y - p.y)));
  }
  return out;
}

/**
 * Regroup the drawn triangles into one group per (kind, texture layer).
 *
 * @param sources  one entry per mesh on screen:
 *                 `{ kind, offset: [x, y, z], positions, colors, uvs, layers,
 *                    indices }` — the attributes three.js is holding, with
 *                 `uvs`/`layers` absent when no pack is loaded.
 * @param options  `cut` applies what the height slider is hiding. Triangles
 *                 straddling the plane are cut along it rather than kept or
 *                 dropped whole: the mesher merges a flat wall into one tall
 *                 rectangle, so rounding a triangle either way can be wrong by
 *                 tens of blocks.
 */
export function collectParts(sources, { cut = Infinity } = {}) {
  const groups = new Map();

  for (const source of sources) {
    const { kind, positions, colors, uvs, layers, indices } = source;
    const [ox, oy, oz] = source.offset || [0, 0, 0];
    // One remap per source, keyed by group as well: the same vertex can land
    // in several groups, and never keeps its index in any of them.
    const remap = new Map();

    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i], b = indices[i + 1], c = indices[i + 2];
      const above = (positions[a * 3 + 1] + oy >= cut ? 1 : 0)
        + (positions[b * 3 + 1] + oy >= cut ? 1 : 0)
        + (positions[c * 3 + 1] + oy >= cut ? 1 : 0);
      if (above === 3) continue;
      const clipped = above > 0;

      const layer = layers ? layers[a] : -1;
      const key = `${kind}:${layer}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          kind,
          layer,
          positions: new Buf(Float32Array),
          colors: new Buf(Uint8Array),
          uvs: uvs ? new Buf(Float32Array) : null,
          indices: new Buf(Uint32Array),
        };
        groups.set(key, group);
      }

      // The common case: nothing to cut, so the vertices can be shared.
      if (!clipped) {
        for (const v of [a, b, c]) {
          const id = `${key}|${v}`;
          let index = remap.get(id);
          if (index === undefined) {
            index = append(group, read(source, v));
            remap.set(id, index);
          }
          group.indices.push(index);
        }
        continue;
      }

      const kept = clipTriangle(
        [read(source, a), read(source, b), read(source, c)], cut);
      for (let k = 1; k + 1 < kept.length; k++) {
        group.indices.push(
          append(group, kept[0]), append(group, kept[k]), append(group, kept[k + 1]));
      }
    }
  }

  return [...groups.values()]
    .filter((g) => g.indices.n)
    .map((g) => ({
      kind: g.kind,
      layer: g.layer,
      positions: g.positions.out(),
      colors: g.colors.out(),
      uvs: g.uvs ? g.uvs.out() : null,
      indices: g.indices.out(),
    }));
}

/** How each family of blocks is drawn, mirroring the materials on screen. */
const MATERIAL = {
  opaque: { doubleSided: false, alphaMode: 'MASK', alphaCutoff: 0.5, opacity: 1 },
  plants: { doubleSided: true, alphaMode: 'MASK', alphaCutoff: 0.5, opacity: 1 },
  clear: { doubleSided: true, alphaMode: 'BLEND', alphaCutoff: null, opacity: 0.85 },
};

/**
 * Assemble the binary glTF.
 *
 * @param parts   what collectParts() returned.
 * @param images  PNG bytes per texture layer, indexed by `part.layer`. Empty
 *                when no pack is loaded: the parts then carry colour only.
 * @param extras  written into `asset.extras` — where the portion came from.
 */
export function buildGlb(parts, images = [], extras = null) {
  const json = {
    asset: { version: '2.0', generator: 'Cube-Atlas 3D', ...(extras ? { extras } : {}) },
    extensionsUsed: ['KHR_materials_unlit'],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'porzione' }],
    meshes: [{ name: 'porzione', primitives: [] }],
    accessors: [],
    bufferViews: [],
    buffers: [],
    materials: [],
    ...(images.length ? { images: [], textures: [], samplers: [{
      magFilter: NEAREST, minFilter: NEAREST, wrapS: REPEAT, wrapT: REPEAT,
    }] } : {}),
  };

  const blobs = [];
  let offset = 0;

  const addView = (bytes, target) => {
    const padding = align4(offset) - offset;
    if (padding) { blobs.push(new Uint8Array(padding)); offset += padding; }
    json.bufferViews.push({
      buffer: 0, byteOffset: offset, byteLength: bytes.byteLength,
      ...(target ? { target } : {}),
    });
    blobs.push(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    offset += bytes.byteLength;
    return json.bufferViews.length - 1;
  };

  const addAccessor = (bytes, componentType, type, count, target, extra = {}) => {
    json.accessors.push({
      bufferView: addView(bytes, target), componentType, count, type, ...extra,
    });
    return json.accessors.length - 1;
  };

  // --- one image, one texture, one material per layer actually drawn ------
  const materialOf = new Map();
  const textureOf = new Map();

  for (const part of parts) {
    const key = `${part.kind}:${part.layer}`;
    if (materialOf.has(key)) continue;
    const spec = MATERIAL[part.kind] || MATERIAL.opaque;
    const material = {
      name: key,
      extensions: { KHR_materials_unlit: {} },
      doubleSided: spec.doubleSided,
      alphaMode: spec.alphaMode,
      pbrMetallicRoughness: {
        baseColorFactor: [1, 1, 1, spec.opacity],
        metallicFactor: 0,
        roughnessFactor: 1,
      },
    };
    if (spec.alphaCutoff !== null) material.alphaCutoff = spec.alphaCutoff;

    const png = part.layer >= 0 ? images[part.layer] : null;
    if (png) {
      if (!textureOf.has(part.layer)) {
        json.images.push({ bufferView: addView(png), mimeType: 'image/png' });
        json.textures.push({ sampler: 0, source: json.images.length - 1 });
        textureOf.set(part.layer, json.textures.length - 1);
      }
      material.pbrMetallicRoughness.baseColorTexture = { index: textureOf.get(part.layer) };
    } else if (spec.alphaMode === 'MASK') {
      // Without a sprite there is nothing to cut out, and a MASK material with
      // no texture would clip against the vertex colour's alpha instead.
      material.alphaMode = 'OPAQUE';
      delete material.alphaCutoff;
    }

    json.materials.push(material);
    materialOf.set(key, json.materials.length - 1);
  }

  // --- one primitive per group -------------------------------------------
  for (const part of parts) {
    const count = part.positions.length / 3;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < count; i++) {
      const x = part.positions[i * 3], y = part.positions[i * 3 + 1], z = part.positions[i * 3 + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }

    const attributes = {
      POSITION: addAccessor(part.positions, FLOAT, 'VEC3', count, ARRAY_BUFFER,
        { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] }),
      COLOR_0: addAccessor(part.colors, UBYTE, 'VEC4', count, ARRAY_BUFFER,
        { normalized: true }),
    };
    if (part.uvs) {
      attributes.TEXCOORD_0 = addAccessor(part.uvs, FLOAT, 'VEC2', count, ARRAY_BUFFER);
    }
    json.meshes[0].primitives.push({
      attributes,
      indices: addAccessor(part.indices, UINT, 'SCALAR', part.indices.length,
        ELEMENT_ARRAY_BUFFER),
      material: materialOf.get(`${part.kind}:${part.layer}`),
    });
  }

  // --- the container ------------------------------------------------------
  const binLength = align4(offset);
  json.buffers.push({ byteLength: binLength });

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = align4(jsonBytes.length);
  const total = 12 + 8 + jsonLength + 8 + binLength;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, VERSION, true);
  view.setUint32(8, total, true);

  view.setUint32(12, jsonLength, true);
  view.setUint32(16, CHUNK_JSON, true);
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLength);   // JSON pads with spaces

  const binAt = 20 + jsonLength;
  view.setUint32(binAt, binLength, true);
  view.setUint32(binAt + 4, CHUNK_BIN, true);
  let at = binAt + 8;
  for (const blob of blobs) { out.set(blob, at); at += blob.byteLength; }

  return out;
}
