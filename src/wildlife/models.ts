// Procedural stylised animal models. Each species is one merged, vertex-coloured, skinned
// geometry (one draw call per animal) built from lofted tubes and ellipsoids. Colours are
// painted per vertex from position + normal (darker saddle, pale belly, face masks...).
import * as THREE from 'three';
import { MeshBuilder, loft, smoothRings, ellipsoid, mottle, col, v3, type LoftRing, type BoneFn } from '../combat/geom';
import { B, legBone, blend, type QuadJoints } from './skeleton';

type Ring = [number, number, number, number, number]; // [x, y, z, rx, ry]

const ring = (x: number, y: number, z: number, rx: number, ry: number): LoftRing => ({ p: v3(x, y, z), rx, ry });
const rings = (arr: Ring[]) => arr.map(([x, y, z, rx, ry]) => ring(x, y, z, rx, ry));
const mirror = (r: Ring[]): Ring[] => r.map(([x, y, z, a, b]) => [-x, y, z, a, b]);

/** Closest point parameter of p on segment a-b (0..1) and its distance. */
function segParam(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): [number, number] {
  const abx = b.x - a.x,
    aby = b.y - a.y,
    abz = b.z - a.z;
  const l2 = abx * abx + aby * aby + abz * abz || 1e-9;
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / l2;
  const tc = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = p.x - (a.x + abx * tc),
    dy = p.y - (a.y + aby * tc),
    dz = p.z - (a.z + abz * tc);
  return [t, Math.sqrt(dx * dx + dy * dy + dz * dz)];
}

/**
 * Bone assignment along a spine polyline. `pts` are the joints (rump end, pelvis, chest,
 * neck, head, nose tip); weights blend smoothly around each joint.
 */
function spineBones(j: QuadJoints, rumpEnd: THREE.Vector3, noseTip: THREE.Vector3): BoneFn {
  const pts = [rumpEnd, j.pelvis, j.chest, j.neck, j.head, noseTip];
  return (p) => {
    let best = 0,
      bestD = Infinity,
      bestT = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const [t, d] = segParam(p, pts[i], pts[i + 1]);
      if (d < bestD - 1e-6) {
        bestD = d;
        best = i;
        bestT = t;
      }
    }
    const t = Math.min(1, Math.max(0, bestT));
    switch (best) {
      case 0:
        return B.pelvis;
      case 1:
        return blend(B.pelvis, B.chest, (t - 0.25) / 0.5);
      case 2:
        return blend(B.chest, B.neck, (t - 0.45) / 0.5);
      case 3:
        return blend(B.neck, B.head, (t - 0.6) / 0.4);
      default:
        return B.head;
    }
  };
}

/** Bone assignment along a leg chain hip -> knee -> foot, with blends at the joints. */
function legBones(j: QuadJoints, leg: number, br = 0.04): BoneFn {
  const L = j.legs[leg];
  const u = legBone(leg, 0),
    l = legBone(leg, 1),
    f = legBone(leg, 2);
  const L1 = L.hip.distanceTo(L.knee),
    L2 = L.knee.distanceTo(L.foot);
  return (p) => {
    const [ta, da] = segParam(p, L.hip, L.knee);
    const [tb, db] = segParam(p, L.knee, L.foot);
    const s = da <= db ? Math.max(0, ta) * L1 : L1 + tb * L2;
    if (s < L1 - br) return u;
    if (s < L1 + br) return blend(u, l, (s - (L1 - br)) / (2 * br));
    if (s < L1 + L2 - br * 0.6) return l;
    if (s < L1 + L2 + br * 0.6) return blend(l, f, (s - (L1 + L2 - br * 0.6)) / (1.2 * br));
    return f;
  };
}

const _c = new THREE.Color();
const _c2 = new THREE.Color();
const ss = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Albedo calibration: fur must read darker than the (bright, tone-mapped) snow. */
const ALBEDO_WOLF = 0.6;
const ALBEDO_DEER = 0.72;

export interface QuadModel {
  geometry: THREE.BufferGeometry;
  joints: QuadJoints;
  /** Height of the body bone above the ground in bind pose. */
  radius: number;
}

// ======================================================================= WOLF
export function wolfJoints(): QuadJoints {
  return {
    body: v3(0, 0.62, -0.05),
    pelvis: v3(0, 0.63, -0.38),
    chest: v3(0, 0.65, 0.24),
    neck: v3(0, 0.75, 0.43),
    head: v3(0, 0.88, 0.6),
    jaw: v3(0, 0.845, 0.66),
    earL: v3(0.052, 0.955, 0.615),
    earR: v3(-0.052, 0.955, 0.615),
    tail: [v3(0, 0.642, -0.53), v3(0, 0.53, -0.65), v3(0, 0.38, -0.73)],
    legs: [
      { hip: v3(0.092, 0.64, 0.29), knee: v3(0.086, 0.175, 0.33), foot: v3(0.086, 0.06, 0.345) },
      { hip: v3(-0.092, 0.64, 0.29), knee: v3(-0.086, 0.175, 0.33), foot: v3(-0.086, 0.06, 0.345) },
      { hip: v3(0.1, 0.63, -0.4), knee: v3(0.102, 0.235, -0.51), foot: v3(0.102, 0.06, -0.47) },
      { hip: v3(-0.1, 0.63, -0.4), knee: v3(-0.102, 0.235, -0.51), foot: v3(-0.102, 0.06, -0.47) },
    ],
  };
}

export function buildWolf(variant: 0 | 1): QuadModel {
  const j = wolfJoints();
  const m = new MeshBuilder();
  // Palette: grey timber wolf (0) or darker brown-grey (1).
  const back = col(variant === 0 ? 0x544d47 : 0x453a31);
  const side = col(variant === 0 ? 0x8a8279 : 0x76665a);
  const belly = col(variant === 0 ? 0xd9d0c0 : 0xc9b8a0);
  const cream = col(0xe2d9c9);
  const dark = col(0x28231f);
  const saddle = col(variant === 0 ? 0x3d3834 : 0x33291f);
  const tan = col(variant === 0 ? 0x9f8a6d : 0x8d7254);

  const bodyColor = (p: THREE.Vector3, n: THREE.Vector3) => {
    const up = n.y;
    _c.copy(side).lerp(back, ss(0.15, 0.85, up) * ss(-0.5, -0.1, p.z) * 0.6 + ss(0.35, 0.95, up) * 0.55);
    // Dark saddle along the spine, shoulders to tail.
    if (p.z > -0.56 && p.z < 0.5) _c.lerp(saddle, ss(0.72, 0.97, up) * ss(0.5, 0.25, p.z) * 0.85);
    // Pale belly and inner surfaces.
    _c.lerp(belly, ss(-0.15, -0.65, up));
    // Face: pale cheeks + muzzle, dark brow ridge and eye line.
    if (p.z > 0.56) {
      const cheek = ss(0.05, -0.5, n.y) * ss(0.6, 0.72, p.z);
      _c.lerp(cream, cheek * 0.9);
      const muzzleTop = ss(0.72, 0.78, p.z) * ss(0.2, 0.8, n.y);
      _c.lerp(tan, muzzleTop * 0.7);
      if (p.z > 0.86) _c.lerp(dark, ss(0.86, 0.885, p.z));
    }
    // Neck ruff + chest bib lighter.
    if (p.z > 0.3 && p.z < 0.6) _c.lerp(cream, ss(-0.1, -0.7, n.y) * 0.5 + ss(0.3, 0.9, n.z) * ss(0.7, 0.8, p.y) * 0.25);
    // Grizzled fur.
    const g = mottle(p, 26, variant) * 0.07;
    return _c.offsetHSL(0, 0, g);
  };

  const rumpEnd = v3(0, 0.64, -0.57);
  const noseTip = v3(0, 0.859, 0.885);
  const torso = smoothRings(
    rings([
      [0, 0.645, -0.575, 0.05, 0.055],
      [0, 0.648, -0.5, 0.118, 0.135],
      [0, 0.642, -0.37, 0.14, 0.162],
      [0, 0.63, -0.2, 0.128, 0.145],
      [0, 0.632, 0.0, 0.152, 0.19],
      [0, 0.645, 0.17, 0.166, 0.226],
      [0, 0.69, 0.32, 0.158, 0.212],
      [0, 0.775, 0.43, 0.146, 0.18],
      [0, 0.855, 0.52, 0.124, 0.138],
      [0, 0.9, 0.6, 0.102, 0.104],
      [0, 0.905, 0.662, 0.1, 0.09],
      [0, 0.885, 0.728, 0.07, 0.07],
      [0, 0.869, 0.79, 0.053, 0.054],
      [0, 0.862, 0.85, 0.039, 0.041],
      [0, 0.859, 0.882, 0.017, 0.021],
    ]),
    34,
  );
  m.add(loft(torso, 14), { color: bodyColor, bone: spineBones(j, rumpEnd, noseTip) });

  // Lower jaw.
  m.add(
    loft(rings([
      [0, 0.846, 0.67, 0.05, 0.02],
      [0, 0.84, 0.765, 0.036, 0.016],
      [0, 0.843, 0.835, 0.022, 0.011],
      [0, 0.846, 0.855, 0.008, 0.006],
    ]), 8),
    { color: (p) => _c.copy(belly).lerp(side, 0.3).lerp(dark, ss(0.83, 0.87, p.z) * 0.5), bone: B.jaw },
  );
  // Nose.
  m.add(ellipsoid(v3(0, 0.868, 0.876), 0.022, 0.018, 0.018, 8, 6), { color: dark, bone: B.head });
  // Eyes (glow at night = eyeshine).
  for (const sx of [1, -1]) m.add(ellipsoid(v3(sx * 0.054, 0.912, 0.712), 0.015, 0.011, 0.012, 8, 6), { color: col(0x2a1d0c), bone: B.head, glow: 1 });
  // Ears: flattened cones, pale inside.
  for (const sx of [1, -1]) {
    const e = new THREE.ConeGeometry(0.05, 0.12, 7, 1);
    e.scale(1, 1, 0.55);
    const mat = new THREE.Matrix4().compose(v3(sx * 0.06, 1.0, 0.605), new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.12, 0, -sx * 0.24)), v3(1, 1, 1));
    m.add(e, {
      matrix: mat,
      color: (_p, n) => _c.copy(back).lerp(dark, 0.45).lerp(cream, ss(0.2, 0.7, n.z) * 0.75),
      bone: sx > 0 ? B.earL : B.earR,
    });
  }
  // Legs.
  const frontLeg: Ring[] = [
    [0.065, 0.7, 0.285, 0.045, 0.065],
    [0.078, 0.54, 0.28, 0.05, 0.066],
    [0.088, 0.4, 0.3, 0.037, 0.046],
    [0.087, 0.28, 0.318, 0.031, 0.036],
    [0.086, 0.175, 0.332, 0.028, 0.032],
    [0.086, 0.1, 0.34, 0.026, 0.03],
    [0.086, 0.045, 0.35, 0.027, 0.03],
  ];
  const hindLeg: Ring[] = [
    [0.06, 0.7, -0.38, 0.04, 0.09],
    [0.07, 0.6, -0.35, 0.05, 0.1],
    [0.09, 0.47, -0.33, 0.052, 0.078],
    [0.1, 0.37, -0.39, 0.04, 0.05],
    [0.102, 0.25, -0.49, 0.03, 0.036],
    [0.102, 0.14, -0.49, 0.026, 0.03],
    [0.102, 0.045, -0.472, 0.027, 0.03],
  ];
  const legColor = (p: THREE.Vector3, n: THREE.Vector3) => {
    // Upper legs share the body paint so the seam disappears.
    const body = _c2.copy(bodyColor(p, n));
    _c.copy(side).lerp(tan, ss(0.45, 0.2, p.y));
    _c.lerp(belly, ss(0.2, 0.9, Math.abs(n.x) < 0.5 ? 0 : -n.x * Math.sign(p.x)) * 0.5); // inner faces
    _c.lerp(cream, ss(0.2, 0.07, p.y) * 0.35);
    _c.offsetHSL(0, 0, mottle(p, 30, 3) * 0.05);
    return _c.lerp(body, ss(0.42, 0.56, p.y));
  };
  const legSets: [Ring[], number][] = [
    [frontLeg, 0],
    [mirror(frontLeg), 1],
    [hindLeg, 2],
    [mirror(hindLeg), 3],
  ];
  for (const [r, leg] of legSets) {
    m.add(loft(smoothRings(rings(r), 12), 12, { up: v3(0, 0, 1), capStart: false }), { color: legColor, bone: legBones(j, leg) });
    const f = j.legs[leg].foot;
    const pawC = col(variant === 0 ? 0xa39480 : 0x8f7b63);
    m.add(ellipsoid(v3(f.x, 0.028, f.z + 0.022), 0.031, 0.023, 0.046, 10, 6), { color: pawC, bone: legBone(leg, 2) });
  }
  // Bushy tail with a dark tip.
  const tail = smoothRings(
    rings([
      [0, 0.645, -0.52, 0.045, 0.045],
      [0, 0.595, -0.6, 0.064, 0.068],
      [0, 0.505, -0.665, 0.08, 0.084],
      [0, 0.405, -0.715, 0.072, 0.076],
      [0, 0.315, -0.745, 0.046, 0.05],
      [0, 0.265, -0.755, 0.014, 0.016],
    ]),
    14,
  );
  const tailBones: BoneFn = (p) => {
    const [t1] = segParam(p, j.tail[0], j.tail[1]);
    const [t2] = segParam(p, j.tail[1], j.tail[2]);
    if (t1 < 0.6) return p.z > -0.55 ? blend(B.pelvis, B.tail1, (-0.5 - p.z) / 0.05) : B.tail1;
    if (t1 < 1.1 && t2 < 0.1) return blend(B.tail1, B.tail2, (t1 - 0.6) / 0.5);
    if (t2 < 0.6) return B.tail2;
    return blend(B.tail2, B.tail3, (t2 - 0.6) / 0.4);
  };
  m.add(loft(tail, 10), {
    color: (p, n) => _c.copy(side).lerp(back, ss(0.2, 0.9, n.y) * 0.6).lerp(belly, ss(-0.2, -0.8, n.y) * 0.4).lerp(dark, ss(0.36, 0.3, p.y)).offsetHSL(0, 0, mottle(p, 30, 5) * 0.06),
    bone: tailBones,
  });
  return { geometry: m.build(true, ALBEDO_WOLF), joints: j, radius: 1.2 };
}

// ======================================================================= DEER
export function deerJoints(): QuadJoints {
  return {
    body: v3(0, 0.98, -0.05),
    pelvis: v3(0, 0.99, -0.46),
    chest: v3(0, 1.0, 0.3),
    neck: v3(0, 1.12, 0.48),
    head: v3(0, 1.5, 0.66),
    jaw: v3(0, 1.46, 0.74),
    earL: v3(0.06, 1.575, 0.665),
    earR: v3(-0.06, 1.575, 0.665),
    tail: [v3(0, 1.0, -0.665), v3(0, 0.95, -0.73), v3(0, 0.9, -0.775)],
    legs: [
      { hip: v3(0.1, 0.98, 0.37), knee: v3(0.095, 0.42, 0.4), foot: v3(0.095, 0.1, 0.42) },
      { hip: v3(-0.1, 0.98, 0.37), knee: v3(-0.095, 0.42, 0.4), foot: v3(-0.095, 0.1, 0.42) },
      { hip: v3(0.11, 1.0, -0.5), knee: v3(0.11, 0.48, -0.665), foot: v3(0.11, 0.1, -0.61) },
      { hip: v3(-0.11, 1.0, -0.5), knee: v3(-0.11, 0.48, -0.665), foot: v3(-0.11, 0.1, -0.61) },
    ],
  };
}

export function buildDeer(buck: boolean): QuadModel {
  const j = deerJoints();
  const m = new MeshBuilder();
  const back = col(0x6b5646);
  const side = col(0x8c725c);
  const white = col(0xe9e4da);
  const dark = col(0x2e2621);
  const muzzle = col(0x4a3c33);

  const bodyColor = (p: THREE.Vector3, n: THREE.Vector3) => {
    _c.copy(side).lerp(back, ss(0.3, 0.95, n.y) * 0.75);
    _c.lerp(white, ss(-0.25, -0.7, n.y) * ss(0.6, 0.35, 0.5 + 0 * p.y)); // belly
    // Rump patch.
    if (p.z < -0.52) _c.lerp(white, ss(-0.52, -0.66, p.z) * ss(0.2, -0.3, n.y + 0.2) * 0.9);
    // Throat patch.
    if (p.z > 0.5 && p.z < 0.7) _c.lerp(white, ss(0.1, 0.8, n.z) * ss(-0.2, -0.7, n.y) * 0.8);
    // Face: darker muzzle, pale eye ring and chin band.
    if (p.z > 0.8) {
      _c.lerp(muzzle, ss(0.82, 0.92, p.z) * 0.8);
      _c.lerp(white, ss(-0.3, -0.8, n.y) * ss(0.84, 0.9, p.z) * 0.7);
      if (p.z > 0.95) _c.copy(dark);
    }
    return _c.offsetHSL(0, 0, mottle(p, 18, 7) * 0.04);
  };
  const rumpEnd = v3(0, 1.0, -0.7);
  const noseTip = v3(0, 1.43, 0.985);
  const torso = smoothRings(
    rings([
      [0, 1.0, -0.705, 0.05, 0.06],
      [0, 1.0, -0.63, 0.115, 0.135],
      [0, 0.995, -0.5, 0.15, 0.18],
      [0, 0.965, -0.3, 0.152, 0.198],
      [0, 0.955, -0.05, 0.168, 0.222],
      [0, 0.975, 0.17, 0.162, 0.222],
      [0, 1.03, 0.35, 0.13, 0.2],
      [0, 1.13, 0.47, 0.1, 0.15],
      [0, 1.26, 0.55, 0.08, 0.108],
      [0, 1.385, 0.61, 0.069, 0.086],
      [0, 1.49, 0.665, 0.066, 0.07],
      [0, 1.54, 0.725, 0.07, 0.068],
      [0, 1.52, 0.8, 0.058, 0.056],
      [0, 1.48, 0.88, 0.046, 0.046],
      [0, 1.45, 0.95, 0.033, 0.036],
      [0, 1.435, 0.985, 0.014, 0.018],
    ]),
    36,
  );
  m.add(loft(torso, 14), { color: bodyColor, bone: spineBones(j, rumpEnd, noseTip) });
  m.add(
    loft(rings([
      [0, 1.477, 0.77, 0.038, 0.02],
      [0, 1.447, 0.86, 0.028, 0.016],
      [0, 1.428, 0.935, 0.017, 0.01],
    ]), 8),
    { color: (p) => _c.copy(muzzle).lerp(white, ss(0.84, 0.9, p.z) * 0.8), bone: B.jaw },
  );
  m.add(ellipsoid(v3(0, 1.445, 0.975), 0.024, 0.02, 0.018, 8, 6), { color: dark, bone: B.head });
  for (const sx of [1, -1]) {
    m.add(ellipsoid(v3(sx * 0.053, 1.541, 0.776), 0.013, 0.011, 0.013, 8, 6), { color: col(0x140f0c), bone: B.head, glow: 0.45 });
    m.add(ellipsoid(v3(sx * 0.046, 1.541, 0.773), 0.016, 0.014, 0.016, 8, 6), { color: col(0xbfb3a2), bone: B.head });
    // Big leaf-shaped ears, angled out.
    const e = new THREE.SphereGeometry(1, 8, 6);
    e.scale(0.036, 0.098, 0.016);
    e.translate(0, 0.085, 0);
    const mat = new THREE.Matrix4().compose(v3(sx * 0.06, 1.575, 0.665), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.25, sx * 0.55, -sx * 0.85)), v3(1, 1, 1));
    m.add(e, { matrix: mat, color: (p, n) => _c.copy(side).lerp(back, 0.4).lerp(white, ss(0.1, 0.7, n.z) * 0.35).lerp(col(0x2e2621), ss(1.72, 1.76, p.y) * 0.6), bone: sx > 0 ? B.earL : B.earR });
  }
  if (buck) {
    const bone = col(0xd8cbb0);
    const tip = col(0xf0e8d6);
    for (const sx of [1, -1]) {
      const beam = smoothRings(
        rings([
          [sx * 0.035, 1.6, 0.705, 0.016, 0.016],
          [sx * 0.075, 1.67, 0.69, 0.014, 0.014],
          [sx * 0.14, 1.735, 0.64, 0.012, 0.012],
          [sx * 0.18, 1.79, 0.68, 0.011, 0.011],
          [sx * 0.17, 1.83, 0.77, 0.009, 0.009],
          [sx * 0.125, 1.85, 0.85, 0.004, 0.004],
        ]),
        12,
      );
      const acol = (p: THREE.Vector3) => _c.copy(bone).lerp(tip, ss(1.72, 1.9, p.y));
      m.add(loft(beam, 6), { color: acol, bone: B.head });
      const tines: [number, number, number, number, number, number][] = [
        [0.08, 1.675, 0.69, 0.1, 1.76, 0.75],
        [0.14, 1.735, 0.645, 0.15, 1.88, 0.63],
        [0.178, 1.795, 0.69, 0.2, 1.92, 0.72],
      ];
      for (const [x0, y0, z0, x1, y1, z1] of tines) {
        m.add(loft([ring(sx * x0, y0, z0, 0.01, 0.01), ring(sx * x1, y1, z1, 0.003, 0.003)], 5), { color: acol, bone: B.head });
      }
    }
  }
  const frontLeg: Ring[] = [
    [0.058, 1.06, 0.355, 0.05, 0.08],
    [0.085, 0.8, 0.365, 0.052, 0.07],
    [0.097, 0.62, 0.38, 0.034, 0.042],
    [0.095, 0.44, 0.398, 0.026, 0.03],
    [0.095, 0.28, 0.41, 0.019, 0.022],
    [0.095, 0.14, 0.418, 0.018, 0.021],
    [0.095, 0.1, 0.422, 0.022, 0.024],
    [0.095, 0.06, 0.425, 0.021, 0.024],
  ];
  const hindLeg: Ring[] = [
    [0.062, 1.06, -0.47, 0.06, 0.11],
    [0.085, 0.9, -0.42, 0.066, 0.118],
    [0.108, 0.72, -0.4, 0.054, 0.068],
    [0.112, 0.59, -0.53, 0.036, 0.042],
    [0.11, 0.48, -0.66, 0.027, 0.032],
    [0.11, 0.3, -0.64, 0.019, 0.022],
    [0.11, 0.14, -0.615, 0.018, 0.021],
    [0.11, 0.1, -0.61, 0.022, 0.024],
    [0.11, 0.06, -0.608, 0.021, 0.024],
  ];
  const legLow = col(0x9c8570);
  const legColor = (p: THREE.Vector3, n: THREE.Vector3) => {
    const body = _c2.copy(bodyColor(p, n));
    _c.copy(side).lerp(white, ss(0.3, 0.9, -n.x * Math.sign(p.x)) * ss(0.9, 0.5, p.y) * 0.6);
    _c.lerp(legLow, ss(0.5, 0.2, p.y) * 0.5);
    return _c.lerp(body, ss(0.8, 0.95, p.y));
  };
  const legSets: [Ring[], number][] = [
    [frontLeg, 0],
    [mirror(frontLeg), 1],
    [hindLeg, 2],
    [mirror(hindLeg), 3],
  ];
  for (const [r, leg] of legSets) {
    m.add(loft(smoothRings(rings(r), 13), 8, { up: v3(0, 0, 1) }), { color: legColor, bone: legBones(j, leg, 0.05) });
    const f = j.legs[leg].foot;
    // Cloven hoof: a small dark tapered block.
    const h = new THREE.CylinderGeometry(0.019, 0.027, 0.065, 8);
    h.scale(1, 1, 1.25);
    h.translate(f.x, 0.033, f.z + 0.01);
    m.add(h, { color: col(0x3a3029), bone: legBone(leg, 2) });
  }
  // Tail: brown top, white underside (flagged when alarmed).
  m.add(
    loft(rings([
      [0, 1.005, -0.66, 0.045, 0.022],
      [0, 0.965, -0.72, 0.058, 0.024],
      [0, 0.915, -0.77, 0.042, 0.02],
      [0, 0.885, -0.795, 0.012, 0.008],
    ]), 10),
    {
      color: (_p, n) => _c.copy(back).lerp(white, ss(0.0, -0.4, n.y + n.z * 0.2)),
      bone: (p) => (p.z > -0.68 ? blend(B.pelvis, B.tail1, (-0.66 - p.z) / 0.02) : p.z > -0.74 ? blend(B.tail1, B.tail2, (-0.7 - p.z) / 0.04) : B.tail3),
    },
  );
  return { geometry: m.build(true, ALBEDO_DEER), joints: j, radius: 1.6 };
}

// ======================================================================= HARE
export function hareJoints(): QuadJoints {
  return {
    body: v3(0, 0.17, -0.03),
    pelvis: v3(0, 0.155, -0.1),
    chest: v3(0, 0.17, 0.05),
    neck: v3(0, 0.205, 0.11),
    head: v3(0, 0.245, 0.145),
    jaw: v3(0, 0.222, 0.18),
    earL: v3(0.022, 0.285, 0.14),
    earR: v3(-0.022, 0.285, 0.14),
    tail: [v3(0, 0.16, -0.18), v3(0, 0.165, -0.2), v3(0, 0.17, -0.21)],
    legs: [
      { hip: v3(0.042, 0.15, 0.07), knee: v3(0.044, 0.06, 0.085), foot: v3(0.044, 0.024, 0.095) },
      { hip: v3(-0.042, 0.15, 0.07), knee: v3(-0.044, 0.06, 0.085), foot: v3(-0.044, 0.024, 0.095) },
      { hip: v3(0.062, 0.15, -0.1), knee: v3(0.066, 0.032, -0.185), foot: v3(0.066, 0.02, -0.07) },
      { hip: v3(-0.062, 0.15, -0.1), knee: v3(-0.066, 0.032, -0.185), foot: v3(-0.066, 0.02, -0.07) },
    ],
  };
}

export function buildHare(): QuadModel {
  const j = hareJoints();
  const m = new MeshBuilder();
  const white = col(0xf1efe9);
  const shade = col(0xd9d6ce);
  const dark = col(0x1e1a18);
  const nose = col(0x9c8580);
  const bodyColor = (p: THREE.Vector3, n: THREE.Vector3) => {
    _c.copy(white).lerp(shade, ss(0.4, 1, n.y) * 0.5);
    return _c.offsetHSL(0, 0, mottle(p, 60, 2) * 0.02);
  };
  const rumpEnd = v3(0, 0.15, -0.2);
  const noseTip = v3(0, 0.222, 0.255);
  const torso = smoothRings(
    rings([
      [0, 0.15, -0.2, 0.04, 0.045],
      [0, 0.158, -0.16, 0.078, 0.085],
      [0, 0.172, -0.09, 0.095, 0.105],
      [0, 0.172, -0.01, 0.086, 0.097],
      [0, 0.17, 0.055, 0.07, 0.082],
      [0, 0.198, 0.11, 0.055, 0.06],
      [0, 0.238, 0.145, 0.05, 0.054],
      [0, 0.245, 0.18, 0.044, 0.046],
      [0, 0.232, 0.218, 0.031, 0.032],
      [0, 0.223, 0.245, 0.016, 0.018],
    ]),
    24,
  );
  m.add(loft(torso, 12), { color: bodyColor, bone: spineBones(j, rumpEnd, noseTip) });
  m.add(ellipsoid(v3(0, 0.224, 0.249), 0.01, 0.008, 0.008, 6, 5), { color: nose, bone: B.head });
  for (const sx of [1, -1]) {
    m.add(ellipsoid(v3(sx * 0.034, 0.253, 0.183), 0.011, 0.011, 0.01, 8, 6), { color: dark, bone: B.head, glow: 0.3 });
    // Long ears with black tips.
    const ear = loft(
      rings([
        [sx * 0.02, 0.28, 0.14, 0.012, 0.008],
        [sx * 0.03, 0.33, 0.13, 0.021, 0.008],
        [sx * 0.038, 0.375, 0.12, 0.019, 0.007],
        [sx * 0.044, 0.405, 0.112, 0.01, 0.005],
        [sx * 0.046, 0.415, 0.11, 0.003, 0.003],
      ]),
      8,
      { up: v3(0, 0, 1) },
    );
    m.add(ear, { color: (p, n) => _c.copy(white).lerp(col(0xe8d8d0), ss(0.2, 0.8, n.z) * 0.5).lerp(dark, ss(0.378, 0.392, p.y)), bone: sx > 0 ? B.earL : B.earR });
  }
  // Tail puff.
  m.add(ellipsoid(v3(0, 0.165, -0.2), 0.028, 0.028, 0.024, 8, 6), { color: white, bone: B.tail1 });
  const frontLeg: Ring[] = [
    [0.044, 0.17, 0.065, 0.026, 0.03],
    [0.044, 0.11, 0.075, 0.017, 0.019],
    [0.044, 0.06, 0.085, 0.013, 0.014],
    [0.044, 0.024, 0.095, 0.013, 0.014],
  ];
  const hindLeg: Ring[] = [
    [0.06, 0.18, -0.09, 0.045, 0.06],
    [0.066, 0.11, -0.12, 0.045, 0.058],
    [0.068, 0.06, -0.165, 0.03, 0.032],
    [0.066, 0.034, -0.188, 0.016, 0.018],
  ];
  const legSets: [Ring[], number][] = [
    [frontLeg, 0],
    [mirror(frontLeg), 1],
    [hindLeg, 2],
    [mirror(hindLeg), 3],
  ];
  for (const [r, leg] of legSets) {
    m.add(loft(smoothRings(rings(r), 8), 8, { up: v3(0, 0, 1) }), { color: bodyColor, bone: legBones(j, leg, 0.02) });
    const f = j.legs[leg].foot;
    if (leg < 2) m.add(ellipsoid(v3(f.x, 0.014, f.z + 0.012), 0.014, 0.012, 0.022, 6, 5), { color: white, bone: legBone(leg, 2) });
  }
  // Snowshoe hind feet: long flat pads from heel to toes (lower bone + foot bone).
  for (const [leg, sx] of [
    [2, 1],
    [3, -1],
  ] as const) {
    const foot = loft(
      rings([
        [sx * 0.066, 0.026, -0.195, 0.014, 0.014],
        [sx * 0.066, 0.02, -0.13, 0.024, 0.013],
        [sx * 0.066, 0.018, -0.07, 0.027, 0.012],
        [sx * 0.066, 0.017, -0.03, 0.022, 0.01],
        [sx * 0.066, 0.016, -0.015, 0.008, 0.006],
      ]),
      8,
    );
    m.add(foot, { color: shade, bone: (p) => (p.z < -0.08 ? legBone(leg, 1) : blend(legBone(leg, 1), legBone(leg, 2), (p.z + 0.08) / 0.03)) });
  }
  return { geometry: m.build(true), joints: j, radius: 0.35 };
}

