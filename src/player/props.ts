// Small hand-held props for things that come out of (or go into) the pack: food, bandages,
// sticks, stones, hides... plus how each registered tool sits in the fist. Every prop is built
// with its grip at the origin and its "up" along -Z (the fist's grip axis, see Avatar.hand.item).
import * as THREE from 'three';

/** Tool placement in the fist: [pos, euler]. Models: hatchet/torch/bow along +Y, spear tip at +Z. */
export const HELD_XFORM: Record<string, { pos: [number, number, number]; rot: [number, number, number]; side: -1 | 1 }> = {
  hatchet: { pos: [0, 0, -0.05], rot: [-Math.PI / 2, 0, 0], side: 1 },
  torch: { pos: [0, 0, -0.1], rot: [-Math.PI / 2, 0, 0], side: 1 },
  spear: { pos: [0, 0, -0.75], rot: [0, Math.PI, 0], side: 1 },
  bow: { pos: [0, 0, 0], rot: [-Math.PI / 2, 0, 0], side: -1 },
};

const mats = new Map<string, THREE.Material>();
const mat = (key: string, make: () => THREE.Material) => {
  let m = mats.get(key);
  if (!m) mats.set(key, (m = make()));
  return m;
};
const std = (color: number, roughness: number, metalness = 0) => () => new THREE.MeshStandardMaterial({ color, roughness, metalness });

function lumpy(r: number, seed: number, detail = 2): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(r, detail);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i),
      y = p.getY(i),
      z = p.getZ(i);
    const n = 1 + 0.16 * Math.sin(x * 61 + seed) * Math.cos(y * 47 - seed) + 0.1 * Math.sin(z * 83 + seed * 2);
    p.setXYZ(i, x * n, y * n, z * n);
  }
  g.computeVertexNormals();
  return g;
}

export function buildProp(id: string): THREE.Object3D {
  const g = new THREE.Group();
  g.name = 'prop-' + id;
  const add = (geo: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) => {
    const o = new THREE.Mesh(geo, m);
    o.position.set(x, y, z);
    o.castShadow = true;
    g.add(o);
    return o;
  };
  switch (id) {
    case 'raw_meat': {
      const meat = add(lumpy(0.055, 3), mat('raw', () => new THREE.MeshPhysicalMaterial({ color: 0x8e2626, roughness: 0.35, clearcoat: 0.6, clearcoatRoughness: 0.3 })), 0, 0, -0.02);
      meat.scale.set(1.25, 0.7, 1.1);
      const fat = add(lumpy(0.03, 9, 1), mat('fat', std(0xe8dccb, 0.5)), 0.03, 0.02, -0.04);
      fat.scale.set(1.2, 0.5, 0.8);
      break;
    }
    case 'cooked_meat': {
      const meat = add(lumpy(0.055, 5), mat('cooked', std(0x5e3217, 0.62)), 0, 0, -0.06);
      meat.scale.set(1.1, 0.85, 1.25);
      const bone = add(new THREE.CylinderGeometry(0.011, 0.013, 0.14, 8), mat('bone', std(0xe9e0cc, 0.5)), 0, 0, 0.02);
      bone.rotation.x = Math.PI / 2;
      add(new THREE.SphereGeometry(0.018, 8, 6), mat('bone', std(0xe9e0cc, 0.5)), 0, 0, 0.09);
      break;
    }
    case 'bandage': {
      const roll = add(new THREE.CylinderGeometry(0.032, 0.032, 0.07, 18), mat('gauze', std(0xf2efe6, 0.95)));
      roll.rotation.z = Math.PI / 2;
      const tail = add(new THREE.BoxGeometry(0.068, 0.002, 0.09), mat('gauze', std(0xf2efe6, 0.95)), 0, -0.031, -0.045);
      tail.rotation.x = 0.3;
      break;
    }
    case 'stick': {
      const s = add(new THREE.CylinderGeometry(0.012, 0.016, 0.55, 7), mat('stick', std(0x6b4d33, 0.9)), 0, 0, -0.12);
      s.rotation.x = Math.PI / 2;
      break;
    }
    case 'stone':
      add(lumpy(0.05, 11, 1), mat('stone', () => new THREE.MeshStandardMaterial({ color: 0x77757a, roughness: 0.85, flatShading: true })), 0, 0, -0.02);
      break;
    case 'hide': {
      const h = add(new THREE.BoxGeometry(0.2, 0.035, 0.16), mat('hide', std(0x6b5238, 1)), 0, 0, -0.05);
      h.rotation.y = 0.3;
      break;
    }
    case 'cloth': {
      const c = add(new THREE.BoxGeometry(0.14, 0.03, 0.11), mat('cloth', std(0x9c8f7d, 0.95)), 0, 0, -0.04);
      c.rotation.y = -0.2;
      break;
    }
    case 'arrow': {
      const a = add(new THREE.CylinderGeometry(0.005, 0.005, 0.7, 6), mat('stick', std(0x6b4d33, 0.9)), 0, 0, -0.2);
      a.rotation.x = Math.PI / 2;
      const tip = add(new THREE.ConeGeometry(0.012, 0.05, 5), mat('stone', std(0x55545a, 0.7)), 0, 0, -0.57);
      tip.rotation.x = -Math.PI / 2;
      break;
    }
    case 'ice_axe': {
      const s = add(new THREE.CylinderGeometry(0.014, 0.014, 0.6, 8), mat('stick', std(0x6b4d33, 0.9)), 0, 0, -0.2);
      s.rotation.x = Math.PI / 2;
      add(new THREE.BoxGeometry(0.2, 0.025, 0.03), mat('stone', std(0x55545a, 0.7)), 0.02, 0, -0.5);
      break;
    }
    case 'crampons': {
      for (const x of [-0.04, 0.04]) {
        add(new THREE.BoxGeometry(0.05, 0.015, 0.22), mat('stone', std(0x55545a, 0.7)), x, 0, -0.05);
      }
      break;
    }
    default: {
      // Unknown: a little stuff-sack.
      const b = add(lumpy(0.05, 7, 1), mat('sack', std(0x6c6a55, 0.95)), 0, 0, -0.03);
      b.scale.set(1, 1.3, 1);
    }
  }
  return g;
}
