// The explored floor as one solid surface: a plane over the floor grid's bounds, coloured from
// the grid (free floor, blocked footprints, unseen = see-through), with soft edges, 1 m grid
// lines drawn in the shader (crisp at any zoom), and shadows falling on it.
import * as THREE from 'three';
import { boxBlur } from './view3d-math.js';

export class FloorSurface {
  constructor() {
    this.lines = { uLine: { value: new THREE.Color() }, uLineAlpha: { value: 1 } };
    this.mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, transparent: true, alphaTest: 0.02 });
    this.mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.lines);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vFloorXZ;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFloorXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vFloorXZ;\nuniform vec3 uLine;\nuniform float uLineAlpha;')
        .replace('#include <map_fragment>', `#include <map_fragment>
        {
          // Lines on whole metres (three's z is minus the map's, so they're whole metres there too),
          // about 1.3 px wide, fading out where they'd be closer together than a few pixels.
          vec2 fw = max(fwidth(vFloorXZ), vec2(1e-4));
          vec2 g = abs(fract(vFloorXZ + 0.5) - 0.5) / (fw * 1.3);
          float line = (1.0 - min(min(g.x, g.y), 1.0)) * (1.0 - smoothstep(0.04, 0.2, max(fw.x, fw.y)));
          diffuseColor.rgb = mix(diffuseColor.rgb, uLine, line * uLineAlpha);
        }`);
    };
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.mat);
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = -2; // first of the see-through things, so overlays draw on top
    this.mesh.visible = false;
    this.grid = null;
    this.version = null;
    this.tex = null;
    this.size = '';
    this.hex = { floor: 0, blocked: 0 };
  }

  setTheme(t) {
    this.lines.uLine.value.set(t.grid);
    this.lines.uLineAlpha.value = t.gridAlpha;
    this.hex = { floor: t.floor, blocked: t.blocked };
    if (this.grid) this.paint();
  }

  /** grid: { x0, z0, cell, w, h, data: Int8Array (1 blocked / 0 free / −1 unseen), version } or null. */
  setGrid(g) {
    if (!g) {
      this.grid = null;
      this.version = null;
      this.mesh.visible = false;
      return;
    }
    if (g.version != null && g.version === this.version && g.w === this.grid?.w && g.h === this.grid?.h) return; // unchanged
    this.grid = g;
    this.version = g.version;
    const size = `${g.w}x${g.h}x${g.cell}`;
    if (size !== this.size) {
      // A new size: new texture and plane; the old ones are freed.
      this.size = size;
      this.tex?.dispose();
      this.mesh.geometry.dispose();
      this.tex = new THREE.DataTexture(new Uint8Array(g.w * g.h * 4), g.w, g.h, THREE.RGBAFormat);
      Object.assign(this.tex, { colorSpace: THREE.SRGBColorSpace, magFilter: THREE.LinearFilter, minFilter: THREE.LinearMipmapLinearFilter, generateMipmaps: true, anisotropy: 4 });
      this.mat.map = this.tex;
      this.mat.needsUpdate = true;
      this.blur = new Float32Array(g.w * g.h);
      this.tmp = new Float32Array(g.w * g.h);
      // PlaneGeometry's +y (and v) becomes three's −z = the map's +z, so texture row j is grid row j.
      this.mesh.geometry = new THREE.PlaneGeometry(g.w * g.cell, g.h * g.cell).rotateX(-Math.PI / 2);
    }
    this.mesh.position.set(g.x0 + (g.w * g.cell) / 2, 0, -(g.z0 + (g.h * g.cell) / 2));
    this.mesh.visible = true;
    this.paint();
  }

  paint() {
    const { w, h, data } = this.grid, out = this.tex.image.data, a = this.blur, t = this.tmp;
    // Soft edges: blur the seen/unseen mask (a 5×5 box, twice), then ramp it, which also drops
    // lone specks of seen floor.
    for (let k = 0; k < w * h; k++) a[k] = data[k] >= 0 ? 1 : 0;
    boxBlur(a, t, w, h, 2);
    boxBlur(a, t, w, h, 2);
    const { floor: f, blocked: b } = this.hex;
    for (let k = 0, o = 0; k < w * h; k++, o += 4) {
      const c = data[k] === 1 ? b : f;
      out[o] = c >> 16; out[o + 1] = (c >> 8) & 255; out[o + 2] = c & 255;
      out[o + 3] = Math.round(255 * Math.min(1, Math.max(0, (a[k] - 0.2) / 0.6)));
    }
    this.tex.needsUpdate = true;
  }
}
