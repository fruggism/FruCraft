/*
 * From a block state to the six textures of its faces, following the game's
 * own model files.
 *
 * Minecraft describes every block twice: `blockstates/<name>.json` says which
 * model each state uses, and `models/block/<model>.json` says which textures
 * that model puts on which face — through a chain of `parent` models and
 * `#reference` variables. Reading those two is what makes this data-driven
 * instead of a thousand-line table that goes stale every update.
 *
 * The geometry stays ours (voxel/blockKinds.js): we take from the models only
 * the texture names. Their `elements` would give exact shapes — including the
 * corners of stairs — but that is a different, much larger job.
 */

const NS = /^minecraft:/;
const strip = (s) => String(s).replace(NS, '');

/*
 * A model's texture entry is usually the name of a sprite, but from the 2026
 * versions on it can also be an object — `{ sprite, force_translucent }` — so
 * every value goes through here before anything else looks at it.
 */
const spriteOf = (value) => {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.sprite === 'string') return value.sprite;
  return null;
};

/** Column blocks put their `end` texture on the ends of the axis they lie on. */
const AXIS_FACES = {
  y: { end: ['up', 'down'], side: ['north', 'south', 'west', 'east'] },
  x: { end: ['west', 'east'], side: ['up', 'down', 'north', 'south'] },
  z: { end: ['north', 'south'], side: ['up', 'down', 'west', 'east'] },
};

// Fluids have no block model: the game draws them itself.
const FLUIDS = new Map([
  ['water', 'block/water_still'],
  ['bubble_column', 'block/water_still'],
  ['lava', 'block/lava_still'],
]);

export class ResourcePack {
  /**
   * @param {ZipReader[]} zips searched in order, so a resource pack listed
   *   after the vanilla jar overrides it texture by texture.
   */
  constructor(zips) {
    this.zips = zips;
    this.modelCache = new Map();
    this.stateCache = new Map();
    this.faceCache = new Map();
  }

  async readJSON(path) {
    for (let i = this.zips.length - 1; i >= 0; i--) {
      const found = await this.zips[i].readJSON(path);
      if (found) return found;
    }
    return null;
  }

  /** Texture bytes, from the last pack that has them. */
  async readTexture(id) {
    const path = `assets/minecraft/textures/${strip(id)}.png`;
    for (let i = this.zips.length - 1; i >= 0; i--) {
      const bytes = await this.zips[i].read(path);
      if (bytes) return bytes;
    }
    return null;
  }

  hasTexture(id) {
    const path = `assets/minecraft/textures/${strip(id)}.png`;
    return this.zips.some((zip) => zip.has(path));
  }

  /**
   * A model with its parents merged in. Children win, and `#name` values are
   * resolved against the merged map — that is how `cube_all` turns "#all"
   * into a real texture six times over.
   */
  async model(id) {
    const key = strip(id);
    if (this.modelCache.has(key)) return this.modelCache.get(key);
    const chain = [];
    let at = key;
    for (let depth = 0; at && depth < 12; depth++) {
      const json = await this.readJSON(`assets/minecraft/models/${strip(at)}.json`);
      if (!json) break;
      chain.push(json);
      at = json.parent;
    }
    const raw = {};
    for (let i = chain.length - 1; i >= 0; i--) Object.assign(raw, chain[i].textures || {});
    // `#name` points at another entry of the same map: that is how cube_all
    // turns one "#all" into six real sprites.
    const textures = {};
    for (const name of Object.keys(raw)) {
      let value = spriteOf(raw[name]);
      for (let hop = 0; value && value.startsWith('#') && hop < 8; hop++) {
        value = spriteOf(raw[value.slice(1)]);
      }
      textures[name] = value && !value.startsWith('#') ? value : null;
    }
    const model = chain.length ? { textures } : null;
    this.modelCache.set(key, model);
    return model;
  }

  /**
   * The model a state uses, from `blockstates/<name>.json`. Variants are
   * scored against the block's properties so `axis=x` picks the sideways log
   * and `snowy=true` the snowy grass — and the first entry wins when nothing
   * matches, which is right for the many blocks whose variants differ only by
   * a rotation.
   */
  async modelIdFor(name, props) {
    const plain = strip(name);
    const cacheKey = `${plain}|${props ? JSON.stringify(props) : ''}`;
    if (this.stateCache.has(cacheKey)) return this.stateCache.get(cacheKey);

    let id = null;
    const state = await this.readJSON(`assets/minecraft/blockstates/${plain}.json`);
    const pick = (apply) => (Array.isArray(apply) ? apply[0] : apply);

    if (state && state.variants) {
      // Starts below every possible score, so the first variant is always a
      // baseline: many blocks (doors, crops) have no variant that matches an
      // empty property set, and would otherwise resolve to nothing.
      let best = -Infinity;
      for (const [condition, apply] of Object.entries(state.variants)) {
        let score = 0;
        if (condition) {
          const terms = condition.split(',');
          for (const term of terms) {
            const [key, value] = term.split('=');
            if (props && props[key] === value) score++;
            else score--;
          }
        }
        if (score > best) { best = score; id = (pick(apply) || {}).model; }
      }
    } else if (state && Array.isArray(state.multipart)) {
      for (const part of state.multipart) {
        const model = (pick(part.apply) || {}).model;
        if (model) { id = model; break; }
      }
    }
    if (!id) id = `block/${plain}`;
    this.stateCache.set(cacheKey, id);
    return id;
  }

  /**
   * The texture of each face, plus `cross` for the plants that are drawn as
   * crossed planes. Returns null when nothing could be resolved, and the
   * caller falls back to the block's flat colour.
   */
  async facesFor(name, props) {
    const plain = strip(name);
    const cacheKey = `${plain}|${props ? JSON.stringify(props) : ''}`;
    if (this.faceCache.has(cacheKey)) return this.faceCache.get(cacheKey);

    let faces = null;
    const fluid = FLUIDS.get(plain);
    if (fluid) {
      faces = { up: fluid, down: fluid, north: fluid, south: fluid, west: fluid, east: fluid };
    } else {
      const model = await this.model(await this.modelIdFor(plain, props));
      const t = (model && model.textures) || null;
      if (t) {
        // Models name their textures freely — `pane`, `bars`, `wool`, `fire`.
        // Rather than chase every key, fall back to whatever the model does
        // carry, leaving `particle` (a colour hint, not a face) for last.
        const anyNamed = () => {
          let particle = null;
          for (const [key, value] of Object.entries(t)) {
            if (!value) continue;
            if (key === 'particle') { particle = value; continue; }
            return value;
          }
          return particle;
        };
        const any = t.all || t.texture || t.pane || t.bars || anyNamed();
        const side = t.side || any;
        const cross = t.cross || t.plant || t.crop || t.rail || t.texture || null;
        const up = t.up || t.top || t.end || any || side;
        const down = t.down || t.bottom || t.end || any || side;
        faces = {
          up, down,
          north: t.north || side, south: t.south || side,
          west: t.west || side, east: t.east || side,
          cross,
        };
        const axis = props && props.axis;
        if (axis && AXIS_FACES[axis] && (t.end || t.up !== t.side)) {
          const map = AXIS_FACES[axis];
          const endTexture = t.end || up;
          const sideTexture = side || up;
          for (const face of map.end) faces[face] = endTexture;
          for (const face of map.side) faces[face] = sideTexture;
        }
      }
    }

    // A model can name a texture the pack does not actually carry.
    if (faces) {
      let usable = false;
      for (const key of Object.keys(faces)) {
        if (faces[key] && this.hasTexture(faces[key])) usable = true;
        else faces[key] = null;
      }
      if (!usable) faces = null;
    }
    this.faceCache.set(cacheKey, faces);
    return faces;
  }
}
