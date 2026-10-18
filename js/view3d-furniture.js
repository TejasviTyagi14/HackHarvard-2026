// Furniture: simple matte models from soft-cornered boxes, scaled to the measured width, height
// and depth (see slam/objects.js). Local frame: base at y = 0, centred, front toward +z.
// Every model shares a few unit geometries and one material per role, so rebuilding the set
// each map update allocates nothing on the GPU and leaks nothing.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { floorPlane, glowMat, softTexture } from './view3d-parts.js';

const box = new RoundedBoxGeometry(1, 1, 1, 2, 0.1);
const sphere = new THREE.SphereGeometry(1, 20, 14);
const pot = new THREE.CylinderGeometry(1, 0.73, 1, 20); // unit height; scaled per plant
const leaves = new THREE.IcosahedronGeometry(0.5, 2);

const matte = () => new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0 });
const M = { obj: matte(), objTop: matte(), objDeep: matte(), person: matte(), ring: glowMat({ map: softTexture('ring'), opacity: 0.7 }) };

/** Recolours every model at once (the materials are shared). */
export function themeFurniture(t) {
  M.obj.color.set(t.obj);
  M.objTop.color.set(t.objTop);
  M.objDeep.color.set(t.objDeep);
  M.person.color.set(t.person);
  M.ring.color.set(t.accent2);
}

const mesh = (geom, mat) => {
  const m = new THREE.Mesh(geom, mat);
  m.castShadow = m.receiveShadow = true;
  return m;
};

/** bottom: map y of the base (so the floor is at local y = bottom); people get a ring there. */
export function furniture(cls, w, h, d, bottom = 0) {
  const g = new THREE.Group();
  // A box spanning x0..x1, y0..y1, z0..z1 in fractions of the object's size (x, z centred on 0).
  const part = (x0, x1, y0, y1, z0, z1, mat = M.obj) => {
    const m = mesh(box, mat);
    m.scale.set((x1 - x0) * w, (y1 - y0) * h, (z1 - z0) * d);
    m.position.set(((x0 + x1) / 2) * w, ((y0 + y1) / 2) * h, ((z0 + z1) / 2) * d);
    g.add(m);
  };
  const legs = (top, t = 0.08) => {
    for (const x of [-0.5, 0.5 - t]) for (const z of [-0.5, 0.5 - t]) part(x, x + t, 0, top, z, z + t, M.objDeep);
  };
  switch (cls) {
    case 'chair':
      legs(0.47, 0.1);
      part(-0.5, 0.5, 0.47, 0.54, -0.5, 0.5); // seat
      part(-0.5, 0.5, 0.54, 1, -0.5, -0.38); // back
      break;
    case 'dining table': case 'bench':
      legs(0.92, 0.07);
      part(-0.5, 0.5, 0.92, 1, -0.5, 0.5, M.objTop);
      break;
    case 'couch':
      part(-0.5, 0.5, 0, 0.5, -0.5, 0.5);
      part(-0.5, 0.5, 0.5, 1, -0.5, -0.25);
      part(-0.5, -0.38, 0.5, 0.72, -0.25, 0.5);
      part(0.38, 0.5, 0.5, 0.72, -0.25, 0.5);
      break;
    case 'bed':
      part(-0.5, 0.5, 0, 0.6, -0.5, 0.5);
      part(-0.48, 0.48, 0.6, 0.72, -0.44, 0.48, M.objTop); // mattress
      part(-0.5, 0.5, 0, 1, -0.5, -0.44, M.objDeep); // headboard
      break;
    case 'tv': case 'laptop':
      part(-0.5, 0.5, 0.15, 1, -0.5, 0.5, M.objDeep);
      part(-0.15, 0.15, 0, 0.15, -0.5, 0.5, M.objDeep);
      break;
    case 'person': {
      // Standing upright on the floor, facing you.
      part(-0.3, -0.04, 0, 0.47, -0.28, 0.28, M.person); // legs
      part(0.04, 0.3, 0, 0.47, -0.28, 0.28, M.person);
      part(-0.38, 0.38, 0.47, 0.83, -0.4, 0.4, M.person); // body
      part(-0.5, -0.39, 0.5, 0.82, -0.3, 0.3, M.person); // arms
      part(0.39, 0.5, 0.5, 0.82, -0.3, 0.3, M.person);
      const r = 0.075 * h, head = mesh(sphere, M.person);
      head.scale.setScalar(r);
      head.position.y = h - r;
      const ring = new THREE.Mesh(floorPlane, M.ring);
      ring.scale.setScalar(Math.max(w, d) * 1.6 + 0.3);
      ring.position.y = bottom + 0.012;
      ring.renderOrder = 2;
      g.add(head, ring);
      break;
    }
    case 'potted plant': {
      const p = mesh(pot, M.objDeep), l = mesh(leaves, M.obj);
      p.scale.set(0.3 * w, 0.35 * h, 0.3 * d);
      p.position.y = 0.175 * h;
      l.scale.set(w, 0.65 * h, d);
      l.position.y = 0.67 * h;
      g.add(p, l);
      break;
    }
    default:
      part(-0.5, 0.5, 0, 1, -0.5, 0.5);
  }
  return g;
}
