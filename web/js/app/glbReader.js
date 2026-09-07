/*
 * Atlante 3D · Lettura — a .glb opened straight from disk.
 *
 * The counterpart of what the Editor exports. The other two sections read
 * back their own files (an atlas, a document); this one does the same for the
 * model, and like them it needs no Minecraft world: everything the picture is
 * made of — geometry, textures, baked colours — is inside the file.
 *
 * The scene is deliberately bare. Our own exports are unlit by declaration
 * (§ web/js/export/glb.js), so lighting them would be lighting them twice;
 * but a file from elsewhere may well expect lights, so a couple of soft ones
 * are added for those. Unlit materials ignore them, which is exactly right.
 */

import * as THREE from '../../vendor/three.module.js';
import { GLTFLoader } from '../../vendor/GLTFLoader.js';

/*
 * Same rule as viewer3d.js, and for the same reason: the colours baked into
 * the vertices are already the colours the blocks should end up, so nothing
 * must convert them again on the way to the framebuffer. Left on, three.js
 * treats them as linear and brightens them — the model would come out visibly
 * paler here than in the Editor that exported it.
 */
THREE.ColorManagement.enabled = false;

const SKY = 0xa8c8e8;

export class GlbViewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(SKY);
    // For models that are not unlit. Ours ignore these entirely.
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(0.6, 1, 0.4);
    this.scene.add(sun);

    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 20000);
    this.root = null;

    this.yaw = -Math.PI * 0.75;
    this.pitch = -0.5;
    this.distance = 100;
    this.target = new THREE.Vector3();
    this.running = false;

    this._bind();
  }

  /** Replace whatever is on screen with this file's contents. */
  async load(arrayBuffer) {
    const loader = new GLTFLoader();
    const gltf = await loader.parseAsync(arrayBuffer, '');
    this.clear();
    this.root = gltf.scene;
    this.scene.add(this.root);

    // Frame it: the file says where it is, which for our own exports is a box
    // starting at the origin but for anything else could be anywhere.
    const box = new THREE.Box3().setFromObject(this.root);
    const size = new THREE.Vector3();
    const centre = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(centre);
    this.target.copy(centre);
    this.distance = Math.max(size.x, size.y, size.z) * 1.4 || 100;
    this.camera.near = Math.max(0.05, this.distance / 4000);
    this.camera.far = this.distance * 40;
    this._apply();

    let triangles = 0, meshes = 0, textures = new Set();
    this.root.traverse((node) => {
      if (!node.isMesh) return;
      meshes++;
      // These are 16-pixel sprites: smoothing them turns Minecraft to mush.
      for (const m of Array.isArray(node.material) ? node.material : [node.material]) {
        if (!m || !m.map) continue;
        m.map.magFilter = THREE.NearestFilter;
        m.map.minFilter = THREE.NearestFilter;
        m.map.generateMipmaps = false;
        m.map.colorSpace = THREE.NoColorSpace;
        m.map.needsUpdate = true;
      }
      const index = node.geometry.getIndex();
      triangles += (index ? index.count : node.geometry.getAttribute('position').count) / 3;
      const material = node.material;
      for (const m of Array.isArray(material) ? material : [material]) {
        if (m && m.map) textures.add(m.map);
      }
    });
    return {
      triangles: Math.round(triangles), meshes, textures: textures.size,
      size: { x: Math.round(size.x), y: Math.round(size.y), z: Math.round(size.z) },
      extras: (gltf.parser && gltf.parser.json.asset && gltf.parser.json.asset.extras) || null,
    };
  }

  clear() {
    if (!this.root) return;
    this.root.traverse((node) => {
      if (!node.isMesh) return;
      node.geometry.dispose();
      for (const m of Array.isArray(node.material) ? node.material : [node.material]) {
        if (!m) continue;
        if (m.map) m.map.dispose();
        m.dispose();
      }
    });
    this.scene.remove(this.root);
    this.root = null;
  }

  _apply() {
    const cp = Math.cos(this.pitch);
    this.camera.position.set(
      this.target.x - Math.sin(this.yaw) * cp * this.distance,
      this.target.y - Math.sin(this.pitch) * this.distance,
      this.target.z - Math.cos(this.yaw) * cp * this.distance,
    );
    this.camera.lookAt(this.target);
    this.camera.updateProjectionMatrix();
  }

  _bind() {
    const canvas = this.canvas;
    let dragging = 0, lastX = 0, lastY = 0;
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
        const k = this.distance * 0.0016;
        const right = new THREE.Vector3(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
        this.target.addScaledVector(right, -dx * k).addScaledVector(new THREE.Vector3(0, 1, 0), dy * k);
      }
      this._apply();
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.distance = clamp(this.distance * (e.deltaY > 0 ? 1.12 : 0.89), 0.2, 60000);
      this._apply();
    }, { passive: false });
  }

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
    const frame = () => {
      if (!this.running) return;
      requestAnimationFrame(frame);
      this.renderer.render(this.scene, this.camera);
    };
    requestAnimationFrame(frame);
  }

  stop() { this.running = false; }

  snapshot() {
    this.renderer.render(this.scene, this.camera);
    return new Promise((resolve) => this.canvas.toBlob(resolve, 'image/png'));
  }
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
