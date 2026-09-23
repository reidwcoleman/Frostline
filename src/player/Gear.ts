// Procedural first-person gear: skis (sidecut, rocker, top-sheet graphic), bindings, ski boots,
// poles, mittens and jacket sleeves. All MeshStandardMaterial so sun, shadows and fog match the world.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { clamp, lerp } from '../core/math';

export const SKI_LENGTH = 1.75;
/** Boot centre sits a little behind the ski's midpoint (mount point). */
const TAIL_Z = 0.83;
const TIP_Z = TAIL_Z - SKI_LENGTH;
/** Base of the ski above the snow surface at the feet (avoids z-fighting with the terrain). */
export const SKI_BASE_Y = 0.02;
export const SKI_THICK = 0.017;

export const PALETTE = {
  jacket: 0x1d2a44, // dark navy
  jacketShade: 0x172238,
  pants: 0x1a2130,
  mitten: 0x2b2729,
  cuff: 0x464c57,
  skiBody: 0x1c1f25,
  accent: 0xff6a2b, // signal-flare orange, the one accent
  binding: 0xd6d9dd,
  bindingDark: 0x2a2d33,
  boot: 0x2f3542,
  buckle: 0xb9bfc7,
  poleShaft: 0xa9b1ba,
  poleGrip: 0x151618,
} as const;

export interface GearMaterials {
  jacket: THREE.MeshStandardMaterial;
  jacketShade: THREE.MeshStandardMaterial;
  pants: THREE.MeshStandardMaterial;
  mitten: THREE.MeshStandardMaterial;
  cuff: THREE.MeshStandardMaterial;
  skiTop: THREE.MeshStandardMaterial;
  skiBody: THREE.MeshStandardMaterial;
  binding: THREE.MeshStandardMaterial;
  bindingDark: THREE.MeshStandardMaterial;
  boot: THREE.MeshStandardMaterial;
  buckle: THREE.MeshStandardMaterial;
  poleShaft: THREE.MeshStandardMaterial;
  poleGrip: THREE.MeshStandardMaterial;
  shadowOnly: THREE.MeshBasicMaterial;
}

export function makeMaterials(maxAniso: number): GearMaterials {
  const std = (color: number, roughness: number, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
  const top = new THREE.MeshStandardMaterial({ map: makeTopsheetTexture(maxAniso), roughness: 0.38, metalness: 0.05 });
  const shadowOnly = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  return {
    jacket: std(PALETTE.jacket, 0.82),
    jacketShade: std(PALETTE.jacketShade, 0.9),
    pants: std(PALETTE.pants, 0.88),
    mitten: std(PALETTE.mitten, 0.7),
    cuff: std(PALETTE.cuff, 0.95),
    skiTop: top,
    skiBody: std(PALETTE.skiBody, 0.45, 0.25),
    binding: std(PALETTE.binding, 0.35, 0.1),
    bindingDark: std(PALETTE.bindingDark, 0.5, 0.2),
    boot: std(PALETTE.boot, 0.38, 0.05),
    buckle: std(PALETTE.buckle, 0.3, 0.85),
    poleShaft: std(PALETTE.poleShaft, 0.3, 0.8),
    poleGrip: std(PALETTE.poleGrip, 0.75),
    shadowOnly,
  };
}

// ------------------------------------------------------------------ top-sheet graphic
function makeTopsheetTexture(maxAniso: number): THREE.Texture {
  const W = 128,
    H = 1024;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  // v = 0 at the tail (canvas bottom), 1 at the tip (canvas top).
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#2b303a');
  grad.addColorStop(0.5, '#1f232b');
  grad.addColorStop(1, '#23272f');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  // Fine brushed texture so the top catches light.
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(255,255,255,${0.012 + Math.random() * 0.02})`;
    g.fillRect(Math.random() * W, Math.random() * H, 1, 6 + Math.random() * 30);
  }
  // Pinstripes near the edges.
  g.fillStyle = 'rgba(214,219,226,0.55)';
  g.fillRect(W * 0.14, H * 0.1, 2, H * 0.8);
  g.fillRect(W * 0.86 - 2, H * 0.1, 2, H * 0.8);
  // The accent: one signal-orange stripe down the middle, tapering into a chevron at the shovel.
  g.fillStyle = '#ff6a2b';
  const sw = W * 0.16;
  g.fillRect(W / 2 - sw / 2, H * 0.2, sw, H * 0.62);
  g.beginPath();
  g.moveTo(W / 2 - sw / 2, H * 0.2);
  g.lineTo(W / 2, H * 0.14);
  g.lineTo(W / 2 + sw / 2, H * 0.2);
  g.closePath();
  g.fill();
  // Wordmark along the tail, small and quiet.
  g.save();
  g.translate(W * 0.5, H * 0.9);
  g.rotate(-Math.PI / 2);
  g.fillStyle = 'rgba(230,233,238,0.8)';
  g.font = '600 26px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('FROSTLINE', 0, 0);
  g.restore();
  // Darken the extreme tip/tail.
  const edge = g.createLinearGradient(0, 0, 0, H);
  edge.addColorStop(0, 'rgba(0,0,0,0.35)');
  edge.addColorStop(0.05, 'rgba(0,0,0,0)');
  edge.addColorStop(0.97, 'rgba(0,0,0,0)');
  edge.addColorStop(1, 'rgba(0,0,0,0.35)');
  g.fillStyle = edge;
  g.fillRect(0, 0, W, H);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(8, maxAniso);
  tex.flipY = true;
  return tex;
}

// ------------------------------------------------------------------ ski geometry
/** Half width (m) along the ski, t: 0 tail .. 1 tip. Sidecut + rounded ends. */
function skiHalfWidth(t: number): number {
  const tail = 0.106,
    waist = 0.083,
    shovel = 0.117;
  let w: number;
  if (t < 0.5) w = waist + (tail - waist) * Math.pow((0.5 - t) / 0.46, 2);
  else w = waist + (shovel - waist) * Math.pow(clamp((t - 0.5) / 0.36, 0, 1), 2);
  if (t < 0.035) w *= 0.55 + 0.45 * Math.sqrt(t / 0.035);
  if (t > 0.86) w = shovel * Math.sqrt(Math.max(0, 1 - Math.pow((t - 0.86) / 0.14, 2))) * 0.96 + 0.012;
  return w * 0.5;
}

/** Base height above the snow along the ski: flat camber zone, rockered tip, slight tail kick. */
function skiRise(t: number): number {
  if (t > 0.78) return 0.085 * Math.pow((t - 0.78) / 0.22, 2.1);
  if (t < 0.06) return 0.024 * Math.pow((0.06 - t) / 0.06, 2);
  return 0;
}

/**
 * Ski along local -Z (tip) / +Z (tail), base at y = 0, boot centre at the origin.
 * Groups: 0 = top sheet (UV mapped), 1 = sidewalls + base.
 */
export function buildSkiGeometry(): THREE.BufferGeometry {
  const N = 48;
  const pos: number[] = [],
    nor: number[] = [],
    uv: number[] = [],
    idx: number[] = [];
  const sections: { z: number; y: number; hw: number; th: number; ny: number; nz: number }[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const z = lerp(TAIL_Z, TIP_Z, t);
    const y = skiRise(t);
    const th = SKI_THICK * (0.45 + 0.55 * Math.sin(Math.PI * clamp(t * 1.05 - 0.02, 0, 1)));
    // Profile normal in the YZ plane (perpendicular to the curve).
    const dt = 1 / N;
    const y0 = skiRise(Math.max(0, t - dt)),
      y1 = skiRise(Math.min(1, t + dt));
    const dz = (TIP_Z - TAIL_Z) * (Math.min(1, t + dt) - Math.max(0, t - dt));
    const dy = y1 - y0;
    const l = Math.hypot(dz, dy);
    // tangent (dz, dy)/l in (z, y); normal = (-tz..): rotate so it points up.
    let nz = -dy / l,
      ny = dz / l;
    if (ny < 0) {
      ny = -ny;
      nz = -nz;
    }
    sections.push({ z, y, hw: skiHalfWidth(t), th, ny, nz });
  }
  const vert = (x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number) => {
    pos.push(x, y, z);
    nor.push(nx, ny, nz);
    uv.push(u, v);
    return pos.length / 3 - 1;
  };

  // Top sheet: 3 vertices across (slight crown).
  const topStart = idx.length;
  const topBase = pos.length / 3;
  for (let i = 0; i <= N; i++) {
    const s = sections[i];
    const t = i / N;
    const ox = 0,
      oy = s.y + s.th * s.ny,
      oz = s.z + s.th * s.nz;
    vert(-s.hw, oy, oz, 0, s.ny, s.nz, 0, t);
    vert(0, oy + 0.0022, oz, 0, s.ny, s.nz, 0.5, t);
    vert(s.hw, oy, oz, 0, s.ny, s.nz, 1, t);
    void ox;
  }
  for (let i = 0; i < N; i++) {
    const a = topBase + i * 3,
      b = a + 3;
    idx.push(a, a + 1, b, a + 1, b + 1, b);
    idx.push(a + 1, a + 2, b + 1, a + 2, b + 2, b + 1);
  }
  const topCount = idx.length - topStart;

  // Sides + base (group 1).
  const restStart = idx.length;
  const strip = (fn: (s: (typeof sections)[number]) => [number, number, number, number, number, number]) => {
    const base = pos.length / 3;
    for (let i = 0; i <= N; i++) {
      const s = sections[i];
      const [x0, y0, z0, x1, y1, z1] = fn(s);
      vert(x0, y0, z0, 0, 0, 0, 0, i / N);
      vert(x1, y1, z1, 0, 0, 0, 1, i / N);
    }
    for (let i = 0; i < N; i++) {
      const a = base + i * 2,
        b = a + 2;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  };
  // left side (x = -hw), from base to top
  strip((s) => [-s.hw, s.y + s.th * s.ny, s.z + s.th * s.nz, -s.hw, s.y, s.z]);
  // right side
  strip((s) => [s.hw, s.y, s.z, s.hw, s.y + s.th * s.ny, s.z + s.th * s.nz]);
  // base (facing down)
  strip((s) => [-s.hw, s.y, s.z, s.hw, s.y, s.z]);
  // tail cap
  {
    const s = sections[0];
    const a = vert(-s.hw, s.y, s.z, 0, 0, 0, 0, 0);
    const b = vert(s.hw, s.y, s.z, 0, 0, 0, 1, 0);
    const c = vert(s.hw, s.y + s.th, s.z, 0, 0, 0, 1, 1);
    const d = vert(-s.hw, s.y + s.th, s.z, 0, 0, 0, 0, 1);
    idx.push(a, b, c, a, c, d);
  }
  // tip cap (faces -Z)
  {
    const s = sections[N];
    const a = vert(-s.hw, s.y, s.z, 0, 0, 0, 0, 0);
    const b = vert(s.hw, s.y, s.z, 0, 0, 0, 1, 0);
    const c = vert(s.hw, s.y + s.th * s.ny, s.z + s.th * s.nz, 0, 0, 0, 1, 1);
    const d = vert(-s.hw, s.y + s.th * s.ny, s.z + s.th * s.nz, 0, 0, 0, 0, 1);
    idx.push(a, c, b, a, d, c);
  }
  const restCount = idx.length - restStart;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  // Top normals were set analytically; recompute the rest for correct side shading.
  const topNormals = (geo.attributes.normal.array as Float32Array).slice(0, (topBase + (N + 1) * 3) * 3);
  geo.computeVertexNormals();
  (geo.attributes.normal.array as Float32Array).set(topNormals.subarray(topBase * 3), topBase * 3);
  geo.addGroup(topStart, topCount, 0);
  geo.addGroup(restStart, restCount, 1);
  geo.computeBoundingSphere();
  return geo;
}

// ------------------------------------------------------------------ ski assembly (ski + binding + boot)
export interface SkiAssembly {
  root: THREE.Group; // moves / tilts per ski
  ski: THREE.Group; // hidden when skis are off
  boot: THREE.Group;
  /** Local point at the top of the boot cuff (where the shin starts). */
  ankle: THREE.Vector3;
}

export function buildSkiAssembly(m: GearMaterials, skiGeo: THREE.BufferGeometry, side: -1 | 1): SkiAssembly {
  const root = new THREE.Group();
  const ski = new THREE.Group();
  const skiMesh = new THREE.Mesh(skiGeo, [m.skiTop, m.skiBody]);
  skiMesh.position.y = SKI_BASE_Y;
  ski.add(skiMesh);

  const plateH = 0.02;
  const topY = SKI_BASE_Y + SKI_THICK;
  const plate = new THREE.Mesh(new RoundedBoxGeometry(0.066, plateH, 0.44, 2, 0.006), m.bindingDark);
  plate.position.set(0, topY + plateH / 2, 0.01);
  const toe = new THREE.Mesh(new RoundedBoxGeometry(0.078, 0.05, 0.1, 3, 0.018), m.binding);
  toe.position.set(0, topY + plateH + 0.022, -0.2);
  const toeCap = new THREE.Mesh(new RoundedBoxGeometry(0.05, 0.02, 0.05, 2, 0.008), m.bindingDark);
  toeCap.position.set(0, topY + plateH + 0.05, -0.215);
  const heel = new THREE.Mesh(new RoundedBoxGeometry(0.08, 0.07, 0.12, 3, 0.02), m.binding);
  heel.position.set(0, topY + plateH + 0.03, 0.2);
  const heelLever = new THREE.Mesh(new RoundedBoxGeometry(0.03, 0.02, 0.1, 2, 0.008), m.bindingDark);
  heelLever.position.set(0, topY + plateH + 0.07, 0.25);
  heelLever.rotation.x = -0.25;
  ski.add(plate, toe, toeCap, heel, heelLever);
  root.add(ski);

  const boot = buildBoot(m, side);
  boot.position.y = topY + plateH;
  root.add(boot);

  for (const o of [skiMesh, plate, toe, heel]) {
    o.castShadow = true;
    o.receiveShadow = true;
  }
  const ankle = new THREE.Vector3(0, topY + plateH + 0.3, 0.04);
  return { root, ski, boot, ankle };
}

/** Stylised alpine boot, origin at the sole centre, toe toward -Z. */
function buildBoot(m: GearMaterials, side: -1 | 1): THREE.Group {
  const g = new THREE.Group();
  const shell = new THREE.Mesh(new RoundedBoxGeometry(0.108, 0.1, 0.31, 4, 0.035), m.boot);
  shell.position.set(0, 0.05, -0.01);
  const toe = new THREE.Mesh(new RoundedBoxGeometry(0.1, 0.03, 0.06, 2, 0.01), m.bindingDark);
  toe.position.set(0, 0.015, -0.16);
  const cuffGeo = new THREE.CylinderGeometry(0.058, 0.066, 0.24, 18, 1);
  const cuff = new THREE.Mesh(cuffGeo, m.boot);
  cuff.position.set(0, 0.2, 0.04);
  cuff.rotation.x = -0.2; // forward lean
  const tongue = new THREE.Mesh(new RoundedBoxGeometry(0.07, 0.2, 0.04, 2, 0.015), m.bindingDark);
  tongue.position.set(0, 0.19, -0.02);
  tongue.rotation.x = -0.2;
  g.add(shell, toe, cuff, tongue);
  // Buckles on the outside of the boot.
  for (let i = 0; i < 3; i++) {
    const b = new THREE.Mesh(new RoundedBoxGeometry(0.012, 0.018, 0.045, 1, 0.005), m.buckle);
    b.position.set(side * 0.066, 0.08 + i * 0.075, 0.0 - i * 0.012);
    b.rotation.x = -0.2;
    g.add(b);
  }
  const strap = new THREE.Mesh(new THREE.CylinderGeometry(0.069, 0.069, 0.035, 18, 1, true), m.bindingDark);
  strap.position.set(0, 0.305, 0.06);
  strap.rotation.x = -0.2;
  // Pant cuff over the boot top, closed with a soft dome so it reads as the leg going up.
  const pant = new THREE.Mesh(new THREE.CylinderGeometry(0.068, 0.072, 0.07, 18, 1, true), m.pants);
  pant.position.set(0, 0.35, 0.07);
  pant.rotation.x = -0.2;
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.068, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2), m.pants);
  dome.position.set(0, 0.385, 0.075);
  dome.rotation.x = -0.2;
  dome.scale.set(1, 0.35, 1);
  g.add(strap, pant, dome);
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return g;
}

// ------------------------------------------------------------------ poles
/** Pole with its grip at the origin, shaft along local -Y. */
export function buildPole(m: GearMaterials): THREE.Group {
  const g = new THREE.Group();
  const L = 1.2;
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.013, 0.15, 12), m.poleGrip);
  grip.position.y = -0.03;
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.019, 12, 8), m.poleGrip);
  knob.position.y = 0.05;
  knob.scale.set(1, 0.45, 1);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.0085, 0.006, L - 0.1, 10), m.poleShaft);
  shaft.position.y = -0.1 - (L - 0.1) / 2 + 0.05;
  const basket = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.04, 0.012, 16), m.poleGrip);
  basket.position.y = -L + 0.1;
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.006, 0.05, 8), m.buckle);
  tip.position.y = -L + 0.02;
  tip.rotation.x = Math.PI;
  g.add(grip, knob, shaft, basket, tip);
  return g;
}

// ------------------------------------------------------------------ mitten + sleeve
/**
 * Gloved fist gripping a vertical handle through its centre, with cuff and jacket sleeve running
 * back toward the elbow. `side` = +1 right hand, -1 left hand.
 */
export function buildArm(m: GearMaterials, side: -1 | 1): { group: THREE.Group; fist: THREE.Group } {
  const group = new THREE.Group();
  const fist = new THREE.Group();
  // Mitten: one rounded mass for the fingers wrapped around the grip, a thumb lobe along the inside.
  const palm = new THREE.Mesh(new RoundedBoxGeometry(0.084, 0.108, 0.1, 5, 0.04), m.mitten);
  palm.position.set(0, -0.004, 0.004);
  const knuckles = new THREE.Mesh(new RoundedBoxGeometry(0.07, 0.06, 0.05, 4, 0.024), m.mitten);
  knuckles.position.set(side * 0.004, 0.012, -0.038);
  const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.02, 0.045, 4, 10), m.mitten);
  thumb.position.set(-side * 0.036, -0.012, -0.022);
  thumb.rotation.set(0.35, 0, side * 0.35);
  fist.add(palm, knuckles, thumb);
  group.add(fist);

  // Forearm direction: back toward the camera, down and outward.
  const dir = new THREE.Vector3(side * 0.3, -0.62, 0.72).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.041, 0.044, 0.07, 16), m.cuff);
  cuff.quaternion.copy(q);
  cuff.position.copy(dir).multiplyScalar(0.075);
  const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.064, 0.55, 18), m.jacket);
  sleeve.quaternion.copy(q);
  sleeve.position.copy(dir).multiplyScalar(0.1 + 0.275);
  const sleeveCuff = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.009, 8, 20), m.jacketShade);
  sleeveCuff.quaternion.copy(q).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2));
  sleeveCuff.position.copy(dir).multiplyScalar(0.105);
  group.add(cuff, sleeve, sleeveCuff);
  return { group, fist };
}

