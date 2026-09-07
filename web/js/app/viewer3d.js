/*
 * The 3D view: scene, camera, controls, and the head-up display.
 *
 * The scene is deliberately unlit. Every face already carries its shade and
 * its ambient occlusion in the vertex colors (see voxel/mesher.js), so the
 * material is the cheapest one there is and a quarter of a million quads
 * still draw in a couple of milliseconds.
 *
 * Coordinates are Minecraft's, unchanged: x east, y up, z south, one unit per
 * block. Reading F3 in game and reading the corner of this window give the
 * same numbers, and looking north puts west on your left, as it should.
 */

import * as THREE from '../../vendor/three.module.js';
import { shapeOf } from '../voxel/blockKinds.js';
import { collectParts, buildGlb } from '../export/glb.js';

/*
 * Colors are taken literally. Every value in blockColors.js is already the
 * color the block should end up on screen, exactly as the 2D atlas paints it,
 * so no conversion must happen on the way to the framebuffer — otherwise the
 * same world comes out lighter in 3D than on the map.
 */
THREE.ColorManagement.enabled = false;

const SKY_TOP = new THREE.Color(0x6d9ee8);
const SKY_HORIZON = new THREE.Color(0xc4d8f0);
const CARDINALS = [
  { name: 'sud', x: 0, z: 1 }, { name: 'ovest', x: -1, z: 0 },
  { name: 'nord', x: 0, z: -1 }, { name: 'est', x: 1, z: 0 },
];

/*
 * The cut-out silhouette for plants, drawn once into a 32x16 texture: blades
 * on the left, a flower on its stem on the right. Sixteen pixels a tile, as
 * the game itself uses, and nearest filtering to keep the edges crisp.
 */
function plantTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 32; canvas.height = 16;
  const g = canvas.getContext('2d');
  g.strokeStyle = '#fff';
  g.fillStyle = '#fff';
  g.lineCap = 'butt';
  g.lineWidth = 2;

  // blades
  for (const [x0, cx, cy, x1, y1] of [
    [3, 1, 9, 2, 3], [7, 8, 9, 11, 2], [11, 12, 10, 14, 5], [5, 6, 12, 6, 7],
    [13, 14, 12, 15, 8],
  ]) {
    g.beginPath();
    g.moveTo(x0, 16);
    g.quadraticCurveTo(cx, cy, x1, y1);
    g.stroke();
  }

  // a flower: stem, two leaves, a squared-off head
  g.beginPath(); g.moveTo(24, 16); g.lineTo(24, 7); g.stroke();
  g.fillRect(21, 10, 2, 2);
  g.fillRect(25, 12, 2, 2);
  g.fillRect(21, 3, 6, 4);
  g.fillRect(22, 2, 4, 6);

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  return texture;
}

/*
 * The material used when a resource pack is loaded.
 *
 * The sprites live in a WebGL2 texture array — one layer each — instead of an
 * atlas, because layers repeat on their own: a greedy-merged rectangle four
 * blocks wide runs its coordinates 0..4 and the texture tiles, with nothing
 * bleeding in from the sprite next door. That is what lets the meshes stay
 * merged with textures on.
 *
 * Everything else is still baked: the vertex colour carries the face shade,
 * the ambient occlusion and — where the game tints — the biome colour, and
 * gets multiplied into the texel. No lights, one draw per chunk.
 */
function voxelMaterial(options) {
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, // sampler2DArray does not exist before it
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      { atlas: { value: null }, opacity: { value: options.opacity ?? 1 },
        cutout: { value: options.cutout ?? 0 } },
    ]),
    vertexShader: `
      #include <common>
      #include <fog_pars_vertex>
      #include <clipping_planes_pars_vertex>
      attribute float layer;
      varying vec2 vTexel;
      varying float vLayer;
      varying vec3 vShade;
      void main() {
        vTexel = uv;
        vLayer = layer;
        vShade = color;
        #include <begin_vertex>
        #include <project_vertex>
        #include <clipping_planes_vertex>
        #include <fog_vertex>
      }`,
    fragmentShader: `
      precision highp sampler2DArray;
      // GLSL 3 has no gl_FragColor: the output has to be declared. three.js
      // does this for its own materials but not for ours, and its fog chunk
      // writes to gl_FragColor, so the name has to keep working.
      layout(location = 0) out highp vec4 pc_fragColor;
      #define gl_FragColor pc_fragColor
      #include <common>
      #include <fog_pars_fragment>
      #include <clipping_planes_pars_fragment>
      uniform sampler2DArray atlas;
      uniform float opacity;
      uniform float cutout;
      varying vec2 vTexel;
      varying float vLayer;
      varying vec3 vShade;
      void main() {
        vec4 texel = texture(atlas, vec3(vTexel, vLayer));
        if (texel.a < cutout) discard;
        #include <clipping_planes_fragment>
        gl_FragColor = vec4(texel.rgb * vShade, texel.a * opacity);
        #include <fog_fragment>
      }`,
    vertexColors: true,
    fog: true,
    transparent: !!options.transparent,
    depthWrite: options.depthWrite !== false,
    side: options.side || THREE.FrontSide,
    clippingPlanes: options.clippingPlanes,
  });
  return material;
}

/** The sprites, as one texture array. Nearest everywhere: these are pixels. */
function arrayTexture({ data, tile, layers }) {
  const texture = new THREE.DataArrayTexture(data, tile, tile, layers);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Each layer of the array texture as its own PNG.
 *
 * The layers are stored bottom-up, the way texture coordinates want them; a
 * PNG's rows run the other way, so they are flipped back on the way out.
 */
async function encodeLayers({ data, tile, layers }, onProgress) {
  const stride = tile * tile * 4;
  const canvas = new OffscreenCanvas(tile, tile);
  const g = canvas.getContext('2d');
  const out = [];
  for (let layer = 0; layer < layers; layer++) {
    const pixels = new Uint8ClampedArray(stride);
    for (let y = 0; y < tile; y++) {
      const from = layer * stride + (tile - 1 - y) * tile * 4;
      pixels.set(data.subarray(from, from + tile * 4), y * tile * 4);
    }
    g.putImageData(new ImageData(pixels, tile, tile), 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    out.push(new Uint8Array(await blob.arrayBuffer()));
    if (onProgress) onProgress(0.5 + 0.45 * ((layer + 1) / layers));
  }
  return out;
}

const skyMaterial = () => new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  uniforms: {
    top: { value: SKY_TOP }, horizon: { value: SKY_HORIZON },
  },
  vertexShader: `
    varying float vH;
    void main() {
      vH = normalize(position).y;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform vec3 top; uniform vec3 horizon;
    varying float vH;
    void main() {
      gl_FragColor = vec4(mix(horizon, top, clamp(vH * 1.6, 0.0, 1.0)), 1.0);
    }`,
});

export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.localClippingEnabled = true;
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(SKY_HORIZON, 200, 900);

    this.sky = new THREE.Mesh(new THREE.SphereGeometry(2000, 16, 12), skyMaterial());
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    this.world = new THREE.Group();
    this.scene.add(this.world);

    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 4000);

    this.clip = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6);
    this.opaqueMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true, clippingPlanes: [this.clip],
    });
    this.clearMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.72, depthWrite: false,
      side: THREE.DoubleSide, clippingPlanes: [this.clip],
    });
    // Plants are opaque where the mask says so and gone where it does not, so
    // they need no sorting: alphaTest keeps them in the first pass.
    this.plantMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true, map: plantTexture(), alphaTest: 0.5,
      side: THREE.DoubleSide, clippingPlanes: [this.clip],
    });

    this.meshes = [];
    this.volume = null;
    this.solidState = null;
    this.atlas = null;
    this.layers = null;     // the sprites as raw pixels, for the .glb export
    this.textured = null;   // the three materials, once a pack is loaded

    // camera state
    this.yaw = -Math.PI / 4;
    this.pitch = -0.5;
    this.eye = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.distance = 80;

    this.running = false;
    this.fps = 0;
    this.onHud = null;
    this.box = null;

    this._bind();
  }

  // ------------------------------------------------------------- scene ---

  /**
   * The sprites for the portion about to be drawn. Called before the first
   * chunk arrives, because it decides which materials the meshes use.
   */
  setTextures(layers) {
    this.clearTextures();
    if (!layers) return;
    this.layers = layers;
    this.atlas = arrayTexture(layers);
    const clippingPlanes = [this.clip];
    this.textured = {
      opaque: voxelMaterial({ clippingPlanes, cutout: 0.5 }),
      // Plants are two crossed planes: without both sides they vanish edge-on.
      plants: voxelMaterial({ clippingPlanes, cutout: 0.5, side: THREE.DoubleSide }),
      clear: voxelMaterial({
        clippingPlanes, transparent: true, depthWrite: false,
        side: THREE.DoubleSide, opacity: 0.85,
      }),
    };
    for (const material of Object.values(this.textured)) {
      material.uniforms.atlas.value = this.atlas;
    }
  }

  clearTextures() {
    if (this.textured) {
      for (const material of Object.values(this.textured)) material.dispose();
      this.textured = null;
    }
    if (this.atlas) { this.atlas.dispose(); this.atlas = null; }
    this.layers = null;
  }

  /** Start over on a new portion: drop the old geometry and frame the box. */
  reset(box) {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      this.world.remove(mesh);
    }
    this.meshes = [];
    this.volume = null;
    this.box = box;

    const cx = box.minX + box.sizeX / 2;
    const cz = box.minZ + box.sizeZ / 2;
    const cy = box.minY + box.sizeY * 0.55;
    this.target.set(cx, cy, cz);
    this.distance = Math.max(box.sizeX, box.sizeZ) * 1.15;
    this.yaw = -Math.PI * 0.75;
    this.pitch = -0.55;
    this.clip.constant = 1e6;

    const span = Math.hypot(box.sizeX, box.sizeZ);
    this.scene.fog.near = span * 0.9;
    this.scene.fog.far = span * 2.6;
    this._applyOrbit();
  }

  /** Add one chunk column's geometry, as it arrives from the worker. */
  addColumn(data) {
    const set = this.textured || {
      opaque: this.opaqueMaterial, plants: this.plantMaterial, clear: this.clearMaterial,
    };
    for (const [part, material, kind] of [
      [data.opaque, set.opaque, 'opaque'],
      [data.plants, set.plants, 'plants'],
      [data.translucent, set.clear, 'clear'],
    ]) {
      if (!part) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(part.colors, 3, true));
      if (part.uvs) geometry.setAttribute('uv', new THREE.BufferAttribute(part.uvs, 2));
      if (part.layers) geometry.setAttribute('layer', new THREE.BufferAttribute(part.layers, 1));
      geometry.setIndex(new THREE.BufferAttribute(part.indices, 1));
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData.kind = kind;
      mesh.position.set(this.box.minX, this.box.minY, this.box.minZ);
      mesh.renderOrder = material === set.clear ? 1 : 0;
      this.world.add(mesh);
      this.meshes.push(mesh);
    }
  }

  /** Keep the blocks around so the crosshair can name what it is pointing at. */
  setVolume(volume) {
    this.volume = volume;
    const solid = new Uint8Array(volume.states.length);
    for (let i = 0; i < volume.states.length; i++) {
      const kind = shapeOf(volume.states[i], volume.names[i], volume.props[i]).kind;
      solid[i] = kind === 'air' || kind === 'skip' ? 0 : 1;
    }
    this.solidState = solid;
  }

  get triangles() {
    let n = 0;
    for (const m of this.meshes) n += m.geometry.index.count / 3;
    return n;
  }

  // ------------------------------------------------------------ camera ---

  _applyOrbit() {
    const cp = Math.cos(this.pitch);
    this.eye.set(
      this.target.x - Math.sin(this.yaw) * cp * this.distance,
      this.target.y - Math.sin(this.pitch) * this.distance,
      this.target.z - Math.cos(this.yaw) * cp * this.distance,
    );
    this.camera.position.copy(this.eye);
    this.camera.lookAt(this.target);
  }

  goTo(x, y, z) {
    this.target.set(x, y, z);
    this._applyOrbit();
  }

  setCut(y) {
    this.clip.constant = y;
  }

  // ------------------------------------------------------------- input ---

  _bind() {
    const canvas = this.canvas;
    let dragging = 0;
    let lastX = 0, lastY = 0;

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('pointerdown', (e) => {
      dragging = e.button === 0 ? 1 : 2;
      lastX = e.clientX; lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointerup', (e) => {
      dragging = 0;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      if (dragging === 1) {
        this.yaw -= dx * 0.006;
        this.pitch = clamp(this.pitch + dy * 0.006, -1.5, 1.5);
      } else {
        // Pan along the ground plane, scaled so the drag follows the cursor.
        const k = this.distance * 0.0016;
        // right = forward x up, with forward = (sin yaw, _, cos yaw)
        const right = new THREE.Vector3(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
        const up = new THREE.Vector3(0, 1, 0);
        this.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
      }
      this._applyOrbit();
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.distance = clamp(this.distance * (e.deltaY > 0 ? 1.12 : 0.89), 2, 3000);
      this._applyOrbit();
    }, { passive: false });

  }

  // ------------------------------------------------------------ picking ---

  /**
   * The first solid block along the view direction, by stepping the voxel
   * grid one cell boundary at a time (Amanatides & Woo). No triangles are
   * tested: the grid we already have answers it exactly.
   */
  pick(maxDistance = 400) {
    const vol = this.volume;
    if (!vol) return null;
    const { box } = this;
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    const p = this.camera.position;

    let x = Math.floor(p.x - box.minX), y = Math.floor(p.y - box.minY), z = Math.floor(p.z - box.minZ);
    const stepX = Math.sign(dir.x), stepY = Math.sign(dir.y), stepZ = Math.sign(dir.z);
    const tDelta = [
      dir.x ? Math.abs(1 / dir.x) : Infinity,
      dir.y ? Math.abs(1 / dir.y) : Infinity,
      dir.z ? Math.abs(1 / dir.z) : Infinity,
    ];
    const frac = (v, step) => (step > 0 ? 1 - (v - Math.floor(v)) : v - Math.floor(v));
    const tMax = [
      dir.x ? frac(p.x - box.minX, stepX) * tDelta[0] : Infinity,
      dir.y ? frac(p.y - box.minY, stepY) * tDelta[1] : Infinity,
      dir.z ? frac(p.z - box.minZ, stepZ) * tDelta[2] : Infinity,
    ];

    const inside = (a, b, c) => a >= 0 && b >= 0 && c >= 0
      && a < box.sizeX && b < box.sizeY && c < box.sizeZ;
    const cut = this.clip.constant;

    for (let i = 0; i < maxDistance * 3; i++) {
      if (inside(x, y, z) && y + box.minY < cut) {
        const state = vol.blocks[(y * box.sizeZ + z) * box.sizeX + x];
        if (this.solidState[state]) {
          return { x: x + box.minX, y: y + box.minY, z: z + box.minZ, name: vol.names[state] };
        }
      }
      const axis = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
      if (tMax[axis] > maxDistance) break;
      if (axis === 0) { x += stepX; } else if (axis === 1) { y += stepY; } else { z += stepZ; }
      tMax[axis] += tDelta[axis];
    }
    return null;
  }

  hudState() {
    const p = this.camera.position;
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    let best = CARDINALS[0], bestDot = -Infinity;
    for (const c of CARDINALS) {
      const d = dir.x * c.x + dir.z * c.z;
      if (d > bestDot) { bestDot = d; best = c; }
    }
    return {
      x: p.x, y: p.y, z: p.z,
      facing: best.name,
      fps: this.fps,
      target: this.pick(),
    };
  }

  // ------------------------------------------------------------- render ---

  resize() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  start() {
    if (this.running) return;
    this.running = true;
    let hudAt = 0;
    let frames = 0, fpsAt = performance.now();

    const frame = (now) => {
      if (!this.running) return;
      requestAnimationFrame(frame);
      this.sky.position.copy(this.camera.position);
      this.renderer.render(this.scene, this.camera);

      frames++;
      if (now - fpsAt > 500) {
        this.fps = Math.round((frames * 1000) / (now - fpsAt));
        frames = 0; fpsAt = now;
      }
      if (this.onHud && now - hudAt > 120) { hudAt = now; this.onHud(this.hudState()); }
    };
    requestAnimationFrame(frame);
  }

  stop() { this.running = false; }

  /**
   * The portion as a binary glTF, ready to be saved.
   *
   * The geometry is taken relative to the box, so the model arrives near the
   * origin instead of thousands of blocks away; where it came from is written
   * into the file's `extras`. What the height slider is hiding stays out.
   */
  async exportGlb(onProgress) {
    if (!this.meshes.length) return null;

    const sources = this.meshes.map((mesh) => {
      const g = mesh.geometry;
      return {
        kind: mesh.userData.kind || 'opaque',
        offset: [0, 0, 0],   // the box origin is the model origin
        positions: g.getAttribute('position').array,
        colors: g.getAttribute('color').array,
        uvs: g.getAttribute('uv') ? g.getAttribute('uv').array : null,
        layers: g.getAttribute('layer') ? g.getAttribute('layer').array : null,
        indices: g.getIndex().array,
      };
    });

    if (onProgress) onProgress(0.1);
    // The clipping plane is in world Y; the geometry is relative to the box.
    const cut = this.clip.constant >= 1e6 ? Infinity : this.clip.constant - this.box.minY;
    const parts = collectParts(sources, { cut });

    if (onProgress) onProgress(0.5);
    const images = this.layers ? await encodeLayers(this.layers, onProgress) : [];

    if (onProgress) onProgress(0.95);
    return buildGlb(parts, images, {
      world: { minX: this.box.minX, minY: this.box.minY, minZ: this.box.minZ },
      size: { x: this.box.sizeX, y: this.box.sizeY, z: this.box.sizeZ },
    });
  }

  /** The current frame as a PNG blob, rendered fresh so the buffer is valid. */
  snapshot() {
    this.renderer.render(this.scene, this.camera);
    return new Promise((resolve) => this.canvas.toBlob(resolve, 'image/png'));
  }
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
