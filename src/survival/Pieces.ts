// Procedural meshes for every build piece. Each builder fills a GeoBuilder in piece-local space and
// returns collider boxes (also piece-local) so Building can register physics.
//
// Log cabin anatomy (all numbers in metres):
//   floor top = 0 at the foundation, walls are 9 courses of Ø0.31 m logs (2.7 m). Walls on X-edges
//   and Z-edges are offset by half a course so their ends interleave at the corners like saddle
//   notches; corner logs overhang and show end grain. Lime chinking fills the grooves between logs.
//   Roofs are a whole-building gable (see RoofCtx) with plank decking, log purlins, board gables,
//   a thick snow slab with rounded cornices, and icicles along the eaves.
import * as THREE from 'three';
import { GeoBuilder, woodTint } from './Geo';
import { hash2 } from '../core/math';
import { Layer } from '../core/Physics';

export const GRID = 3;
export const HALF = GRID / 2;
export const LOG_R = 0.155;
export const COURSE = 0.3;
export const WALL_H = 2.7;
export const CORNER_OH = 0.34;
export const DOOR_W = 1.1;
export const DOOR_H = 2.05;
export const WIN_W = 0.9;
export const WIN_Y0 = 1.0;
export const WIN_Y1 = 1.75;
export const EAVE_OH = 0.55;
export const GABLE_OH = 0.45;
export const ROOF_PITCH = Math.tan((36 * Math.PI) / 180);
export const DECK_T = 0.07;
export const SNOW_T = 0.2;

export interface ColliderSpec {
  center: THREE.Vector3;
  half: THREE.Vector3;
  quat: THREE.Quaternion;
  layers: number;
  tag?: string;
}

export interface Built {
  geo: GeoBuilder;
  colliders: ColliderSpec[];
}

const Q0 = new THREE.Quaternion();
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const STRUCT = Layer.SOLID | Layer.HITTABLE;
const FLOOR = Layer.SOLID | Layer.HITTABLE | Layer.WALKABLE;

function boxSpec(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, layers = STRUCT, quat = Q0): ColliderSpec {
  return { center: V(cx, cy, cz), half: V(hx, hy, hz), quat: quat.clone(), layers };
}

const LOG_BASE = new THREE.Color(0.86, 0.8, 0.74);
const PLANK_BASE = new THREE.Color(0.92, 0.88, 0.82);

// ================================================================== foundation
export interface FoundationCtx {
  /** Terrain height relative to the floor top at a piece-local (x, z). */
  groundAt: (x: number, z: number) => number;
  /** Neighbouring foundations: +X, -X, +Z, -Z. */
  nbr: { px: boolean; nx: boolean; pz: boolean; nz: boolean };
  roofed: boolean;
  seed: number;
}

export function buildFoundation(c: FoundationCtx): Built {
  const g = new GeoBuilder();
  const s = c.seed;
  const boardSnow = c.roofed ? 0 : 0.45;
  // Floorboards along X, slightly irregular widths/heights and tints.
  const n = 10;
  for (let i = 0; i < n; i++) {
    const z = -HALF + (i + 0.5) * (GRID / n);
    const jitter = (hash2(s, i) - 0.5) * 0.008;
    const tint = woodTint(s * 31 + i, 0.95, 0.2).multiply(PLANK_BASE);
    g.box(V(0, -0.03 + jitter, z), V(GRID - 0.004, 0.06, GRID / n - 0.012), Q0, 'plank', { tint, snow: boardSnow });
  }
  // Joists along Z under the boards.
  for (const x of [-1.0, 0, 1.0]) g.log(V(x, -0.18, -HALF), V(x, -0.18, HALF), 0.12, { seed: s * 7 + x * 3 + 11, tint: woodTint(s + x, 0.8).multiply(LOG_BASE), radial: 8 });
  // Rim logs (exposed): along X at z=±1.42 (upper), along Z at x=±1.42 (lower, interleaved).
  const rimX = (z: number, open: boolean) => {
    // Rim runs past the ends where there's no neighbour in X.
    const xa = c.nbr.nx ? -HALF : -HALF - 0.2,
      xb = c.nbr.px ? HALF : HALF + 0.2;
    if (open) g.log(V(xa, -0.21, z), V(xb, -0.21, z), 0.15, { seed: s * 13 + z * 5, tint: woodTint(s * 3 + z * 7, 0.85).multiply(LOG_BASE), capA: !c.nbr.nx, capB: !c.nbr.px, snow: 0.8 });
  };
  const rimZ = (x: number, open: boolean) => {
    const za = c.nbr.nz ? -HALF : -HALF - 0.2,
      zb = c.nbr.pz ? HALF : HALF + 0.2;
    if (open) g.log(V(x, -0.36, za), V(x, -0.36, zb), 0.15, { seed: s * 17 + x * 5, tint: woodTint(s * 5 + x * 3, 0.85).multiply(LOG_BASE), capA: !c.nbr.nz, capB: !c.nbr.pz, snow: 0.8 });
  };
  rimX(1.42, !c.nbr.pz);
  rimX(-1.42, !c.nbr.nz);
  rimZ(1.42, !c.nbr.px);
  rimZ(-1.42, !c.nbr.nx);
  // Interior sills under shared edges keep the floor from looking hollow from below.
  if (c.nbr.pz) g.log(V(-HALF, -0.36, 1.45), V(HALF, -0.36, 1.45), 0.13, { seed: s * 19, tint: woodTint(s * 9, 0.8).multiply(LOG_BASE), radial: 8 });
  if (c.nbr.px) g.log(V(1.45, -0.36, -HALF), V(1.45, -0.36, HALF), 0.13, { seed: s * 23, tint: woodTint(s * 11, 0.8).multiply(LOG_BASE), radial: 8 });
  // Stilts: log posts on flat stone footings down to uneven ground.
  let k = 0;
  for (const [x, z] of [
    [-1.3, -1.3],
    [1.3, -1.3],
    [-1.3, 1.3],
    [1.3, 1.3],
  ]) {
    k++;
    const gy = c.groundAt(x, z);
    const top = -0.44;
    if (gy < top - 0.08) {
      g.log(V(x, top + 0.05, z), V(x, gy - 0.25, z), 0.12, { seed: s * 29 + k, tint: woodTint(s * 7 + k, 0.78).multiply(LOG_BASE), radial: 9, capA: false, capB: false, taper: 0.1 });
      g.stone(V(x, gy + 0.02, z), 0.24, s * 37 + k, { squash: 0.45, snow: 1 });
    }
  }
  const colliders = [boxSpec(0, -0.2, 0, HALF, 0.2, HALF, FLOOR)];
  colliders[0].tag = 'floor';
  return { geo: g, colliders };
}

// ================================================================== walls
export type WallKind = 'wall' | 'doorway' | 'window_wall';

export interface WallCtx {
  kind: WallKind;
  /** 0 for walls on X-edges, COURSE/2 for Z-edges (interleaving at corners). */
  offset: number;
  extA: number;
  extB: number;
  capA: boolean;
  capB: boolean;
  /** Which local ±Z side is outdoors (0 = unknown / both). */
  outside: number;
  roofed: boolean;
  seed: number;
  /** Same for every wall of this orientation in a building, so collinear walls share their logs' look. */
  courseSeed: number;
  /** Wall-local x of this wall's centre along the building's wall line (bark/wobble continuity). */
  along: number;
}

interface Opening {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

function openingOf(kind: WallKind): Opening | null {
  if (kind === 'doorway') return { x0: -DOOR_W / 2, x1: DOOR_W / 2, y0: -1, y1: DOOR_H };
  if (kind === 'window_wall') return { x0: -WIN_W / 2, x1: WIN_W / 2, y0: WIN_Y0, y1: WIN_Y1 };
  return null;
}

export function wallCourses(offset: number): number[] {
  const ys: number[] = [];
  const n = offset > 0 ? 10 : 9;
  for (let k = 0; k < n; k++) ys.push(COURSE * (k + 0.5) - offset);
  return ys;
}

export function buildWall(c: WallCtx): Built {
  const g = new GeoBuilder();
  const s = c.seed;
  const open = openingOf(c.kind);
  const ys = wallCourses(c.offset);
  const xa = -HALF - c.extA,
    xb = HALF + c.extB;
  const frame = 0.1;
  const top = ys[ys.length - 1];
  const cs = c.courseSeed;
  ys.forEach((y, k) => {
    const tint = woodTint(cs * 41 + k, 0.92, 0.2).multiply(LOG_BASE);
    const isTop = k === ys.length - 1;
    const snowFn = (px: number, _py: number, _pz: number, _nx: number, _ny: number, nz: number) => {
      if (Math.abs(px) > HALF + 0.05) return 1; // corner ends catch snow
      let sn = c.roofed ? 0 : 0.55;
      if (c.outside !== 0 && nz * c.outside > 0.1) sn = Math.max(sn, 0.6);
      if (isTop && !c.roofed) sn = 1;
      return sn;
    };
    const r = LOG_R * (0.96 + hash2(cs, k * 3) * 0.08);
    const cut = open && y - r * 0.2 < open.y1 + LOG_R * 0.3 && y + r * 0.2 > open.y0;
    // No taper and a shared seed: a wall line reads as long continuous logs across pieces.
    const opts = { seed: cs * 53 + k * 7, tint, snowFn, radial: 12, roll: hash2(cs, k) * 6, taper: 0, wobble: 0.025, bow: 0.012 };
    const u = (x: number) => c.along + x;
    if (!cut) {
      g.log(V(xa, y, 0), V(xb, y, 0), r, { ...opts, capA: c.capA, capB: c.capB, uOffset: u(xa) });
    } else {
      g.log(V(xa, y, 0), V(open!.x0 - frame, y, 0), r, { ...opts, capA: c.capA, capB: true, uOffset: u(xa) });
      g.log(V(open!.x1 + frame, y, 0), V(xb, y, 0), r, { ...opts, capA: true, capB: c.capB, uOffset: u(open!.x1 + frame) });
    }
  });
  // Chinking: a mortar slab inside the log stack, visible in the grooves.
  const chinkY0 = ys[0],
    chinkY1 = top;
  const ct = 0.17;
  const addChink = (x0: number, x1: number, y0: number, y1: number) => {
    if (x1 - x0 < 0.02 || y1 - y0 < 0.02) return;
    g.box(V((x0 + x1) / 2, (y0 + y1) / 2, 0), V(x1 - x0, y1 - y0, ct), Q0, 'chinking');
  };
  if (!open) addChink(-HALF, HALF, chinkY0, chinkY1);
  else {
    addChink(-HALF, open.x0 - frame, chinkY0, chinkY1);
    addChink(open.x1 + frame, HALF, chinkY0, chinkY1);
    addChink(open.x0 - frame, open.x1 + frame, open.y1 + 0.12, chinkY1);
    if (open.y0 > 0) addChink(open.x0 - frame, open.x1 + frame, chinkY0, open.y0 - 0.08);
  }
  const colliders: ColliderSpec[] = [];
  const cy1 = top + LOG_R;
  if (!open) colliders.push(boxSpec(0, cy1 / 2, 0, HALF, cy1 / 2, 0.17));
  else {
    const lw = (open.x0 - frame + HALF) / 2;
    colliders.push(boxSpec(-HALF + lw, cy1 / 2, 0, lw, cy1 / 2, 0.17));
    colliders.push(boxSpec(HALF - lw, cy1 / 2, 0, lw, cy1 / 2, 0.17));
    const ow = (open.x1 - open.x0) / 2 + frame;
    colliders.push(boxSpec(0, (open.y1 + cy1) / 2, 0, ow, (cy1 - open.y1) / 2, 0.17));
    if (open.y0 > 0) colliders.push(boxSpec(0, open.y0 / 2, 0, ow, open.y0 / 2, 0.17));
    // The window hole: SOLID only (you can't climb through, the wind can't either; arrows can).
    if (c.kind === 'window_wall') colliders.push(boxSpec(0, (open.y0 + open.y1) / 2, 0, (open.x1 - open.x0) / 2, (open.y1 - open.y0) / 2, 0.05, Layer.SOLID));
  }
  // Frames.
  if (c.kind === 'doorway') {
    const fT = PLANK_BASE.clone().multiplyScalar(0.8);
    g.box(V(open!.x0 - 0.05, DOOR_H / 2, 0), V(0.1, DOOR_H, 0.34), Q0, 'plank', { tint: fT });
    g.box(V(open!.x1 + 0.05, DOOR_H / 2, 0), V(0.1, DOOR_H, 0.34), Q0, 'plank', { tint: fT });
    const lintel = new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), 0);
    g.box(V(0, DOOR_H + 0.07, 0), V(DOOR_W + 0.36, 0.14, 0.36), lintel, 'plank', { tint: fT.clone().multiplyScalar(0.95), snow: c.roofed ? 0 : 0.8 });
    g.box(V(0, 0.015, 0), V(DOOR_W + 0.1, 0.03, 0.32), Q0, 'plank', { tint: fT.clone().multiplyScalar(0.85) });
  } else if (c.kind === 'window_wall') {
    const fT = PLANK_BASE.clone().multiplyScalar(0.82);
    const o = open!;
    const h = o.y1 - o.y0;
    g.box(V(o.x0 - 0.05, (o.y0 + o.y1) / 2, 0), V(0.1, h + 0.1, 0.34), Q0, 'plank', { tint: fT });
    g.box(V(o.x1 + 0.05, (o.y0 + o.y1) / 2, 0), V(0.1, h + 0.1, 0.34), Q0, 'plank', { tint: fT });
    g.box(V(0, o.y1 + 0.06, 0), V(WIN_W + 0.3, 0.12, 0.36), Q0, 'plank', { tint: fT });
    // Sill protrudes outside and holds a little snow drift.
    const out = c.outside || 1;
    g.box(V(0, o.y0 - 0.04, out * 0.05), V(WIN_W + 0.34, 0.08, 0.46), Q0, 'plank', { tint: fT.clone().multiplyScalar(0.9), snow: 1 });
    g.box(V(0, o.y0 + 0.02, out * 0.18), V(WIN_W - 0.02, 0.05, 0.14), Q0, 'snow', {});
    // Shutters hinged at the jambs, swung open against the outside wall.
    for (const side of [-1, 1]) {
      const hx = side * (WIN_W / 2 + 0.1);
      // Closed, each leaf spans from its hinge toward the window centre; open, it swings ~165°
      // outward to rest against the logs beside the window.
      const ang = side * out * (Math.PI - 0.28);
      const q = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), ang);
      const m = new THREE.Matrix4().compose(V(hx, 0, out * 0.19), q, V(1, 1, 1));
      g.push(m);
      const w = WIN_W / 2;
      for (let b = 0; b < 3; b++) {
        const bw = w / 3;
        g.box(V(-side * (bw * (b + 0.5)), (o.y0 + o.y1) / 2, 0), V(bw - 0.012, h, 0.035), Q0, 'plank', { tint: woodTint(s * 61 + b + side * 5, 0.7).multiply(PLANK_BASE), snow: 0.9 });
      }
      g.box(V(-side * w * 0.5, o.y0 + h * 0.2, -0.03 * out), V(w * 0.95, 0.07, 0.03), Q0, 'plank', { tint: PLANK_BASE.clone().multiplyScalar(0.6) });
      g.box(V(-side * w * 0.5, o.y0 + h * 0.8, -0.03 * out), V(w * 0.95, 0.07, 0.03), Q0, 'plank', { tint: PLANK_BASE.clone().multiplyScalar(0.6) });
      g.pop();
    }
  }
  return { geo: g, colliders };
}

// ================================================================== door
/** Door leaf built around its hinge (hinge at x=0, leaf extends to +x). */
export function buildDoor(seed: number): Built {
  const g = new GeoBuilder();
  const w = DOOR_W - 0.05,
    h = DOOR_H - 0.03;
  const nb = 5;
  for (let i = 0; i < nb; i++) {
    const bw = w / nb;
    const tint = woodTint(seed * 71 + i, 0.88, 0.22).multiply(PLANK_BASE);
    // Boards are vertical: rotate so grain (box local X) runs up.
    const q = new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), Math.PI / 2);
    g.box(V(bw * (i + 0.5), h / 2 + 0.02, 0), V(h, bw - 0.01, 0.05), q, 'plank', { tint });
  }
  const bt = PLANK_BASE.clone().multiplyScalar(0.72);
  // Z-brace on both faces.
  for (const zf of [-0.04, 0.04]) {
    g.box(V(w / 2, 0.35, zf), V(w - 0.08, 0.13, 0.035), Q0, 'plank', { tint: bt });
    g.box(V(w / 2, h - 0.35, zf), V(w - 0.08, 0.13, 0.035), Q0, 'plank', { tint: bt });
    const diag = Math.atan2(h - 0.7, w - 0.16);
    const len = Math.hypot(h - 0.7, w - 0.16);
    const q = new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), diag);
    g.box(V(w / 2, h / 2, zf), V(len, 0.11, 0.03), q, 'plank', { tint: bt });
  }
  // Pull handle: a short peeled stick on both sides.
  for (const zf of [-0.1, 0.1]) g.log(V(w - 0.14, 0.95, zf), V(w - 0.14, 1.2, zf), 0.022, { seed: seed + 3, tint: new THREE.Color(0.9, 0.8, 0.7), radial: 6, capA: true, capB: true, kind: 'plank' });
  return { geo: g, colliders: [boxSpec(w / 2, h / 2, 0, w / 2, h / 2, 0.06, STRUCT | Layer.INTERACT)] };
}

// ================================================================== roof
export interface RoofCtx {
  /** Ridge along group-local X (else along Z). */
  ridgeX: boolean;
  /** Cell bounds in the roof frame (a along the ridge, s across). */
  a0: number;
  a1: number;
  s0: number;
  s1: number;
  /** Ridge line (s) and half span to the eave walls. */
  sc: number;
  halfSpan: number;
  /** Height of the decking top at the eave wall line (relative to floor). */
  eaveY: number;
  extA0: number;
  extA1: number;
  extS0: number;
  extS1: number;
  gableA0: boolean;
  gableA1: boolean;
  /** Top of the gable walls (boards start here). */
  gableBase: number;
  seed: number;
}

/**
 * Roof for one cell, built directly in the group frame (piece object sits at the group origin).
 * Returns colliders in the same frame.
 */
export function buildRoof(c: RoofCtx): Built {
  const g = new GeoBuilder();
  const colliders: ColliderSpec[] = [];
  const rot = c.ridgeX ? new THREE.Matrix4() : new THREE.Matrix4().makeRotationY(-Math.PI / 2);
  const rotQ = new THREE.Quaternion().setFromRotationMatrix(rot);
  g.push(rot);
  const tanP = ROOF_PITCH;
  const yTop = (s: number) => c.eaveY + (c.halfSpan - Math.abs(s - c.sc)) * tanP;
  const a0e = c.a0 - c.extA0,
    a1e = c.a1 + c.extA1;
  const aLen = a1e - a0e,
    aMid = (a0e + a1e) / 2;
  const s0e = c.s0 - c.extS0,
    s1e = c.s1 + c.extS1;
  // Split the cell's s-range at the ridge.
  const ranges: [number, number, number][] = []; // [sNear(ridge side), sFar, side sign]
  if (c.sc > s0e + 0.01 && c.sc < s1e - 0.01) {
    ranges.push([c.sc, s0e, -1], [c.sc, s1e, 1]);
  } else if (c.sc >= s1e - 0.01) ranges.push([s1e, s0e, -1]);
  else ranges.push([s0e, s1e, 1]);

  const plankT = PLANK_BASE.clone().multiplyScalar(0.78);
  for (const [sn, sf, sign] of ranges) {
    const len = Math.abs(sf - sn);
    if (len < 0.01) continue;
    const slopeLen = len * Math.sqrt(1 + tanP * tanP);
    const dir = V(0, -tanP, Math.sign(sf - sn)).normalize(); // down-slope (a, y, s)
    const nrm = V(0, 1, 0).sub(dir.clone().multiplyScalar(dir.y)).normalize(); // up-ish normal ⟂ dir
    const xAxis = dir; // grain runs down the slope
    const yAxis = nrm;
    const zAxis = new THREE.Vector3().crossVectors(xAxis, yAxis).normalize();
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis));
    const sMid = (sn + sf) / 2;
    // Decking boards.
    const nBoards = Math.max(1, Math.round(aLen / 0.25));
    const bw = aLen / nBoards;
    for (let i = 0; i < nBoards; i++) {
      const a = a0e + (i + 0.5) * bw;
      const ctr = V(a, yTop(sMid), sMid).addScaledVector(nrm, -DECK_T / 2);
      const tint = woodTint(c.seed * 97 + i * 3 + sign, 0.9, 0.24).multiply(plankT);
      g.box(ctr, V(slopeLen + 0.004, DECK_T, bw - 0.005), q, 'plank', { tint });
    }
    // Snow slab (set back a touch from the eave so the fascia shows).
    const farInset = 0.04;
    const sFarS = sf - Math.sign(sf - sn) * farInset;
    const sLen2 = Math.abs(sFarS - sn);
    const slopeLen2 = sLen2 * Math.sqrt(1 + tanP * tanP);
    const sMid2 = (sn + sFarS) / 2;
    const sc = V(aMid, yTop(sMid2), sMid2).addScaledVector(nrm, SNOW_T / 2 - 0.005);
    g.box(sc, V(slopeLen2, SNOW_T, aLen + 0.02), q, 'snow', {});
    // Rounded cornice at the eave (only at real eaves).
    const isEave = (sign > 0 && c.extS1 > 0) || (sign < 0 && c.extS0 > 0);
    if (isEave) {
      const ey = yTop(sFarS);
      const pe = V(0, ey, sFarS).addScaledVector(nrm, SNOW_T * 0.5).addScaledVector(dir, 0.02);
      g.log(V(a0e - 0.01, pe.y, pe.z), V(a1e + 0.01, pe.y, pe.z), SNOW_T * 0.62, { kind: 'snow', seed: c.seed + 5, radial: 10, wobble: 0.12, bow: 0, taper: 0.05 });
      // Icicles hanging from the lip.
      const nI = 3 + Math.floor(hash2(c.seed, sign * 7) * 5);
      for (let i = 0; i < nI; i++) {
        const a = a0e + 0.15 + hash2(c.seed * 3 + i, sign) * (aLen - 0.3);
        const L = 0.08 + Math.pow(hash2(c.seed * 5 + i, sign), 2.2) * 0.55;
        const base = V(a, pe.y - SNOW_T * 0.35, pe.z + Math.sign(sf - sn) * 0.02);
        g.cone(V(a + 0.01, base.y - L, base.z), base, 0.02 + L * 0.06, 'ice');
      }
    }
    // Rounded gable edges of the snow.
    for (const [ae, ext] of [
      [a0e, c.extA0],
      [a1e, c.extA1],
    ] as const) {
      if (ext <= 0) continue;
      const p0 = V(ae, yTop(sn), sn).addScaledVector(nrm, SNOW_T * 0.45);
      const p1 = V(ae, yTop(sFarS), sFarS).addScaledVector(nrm, SNOW_T * 0.45);
      g.log(p0, p1, SNOW_T * 0.5, { kind: 'snow', seed: c.seed + 9, radial: 8, wobble: 0.1, bow: 0, taper: 0 });
    }
    // Collider slab.
    const cc = V(aMid, yTop(sMid), sMid).addScaledVector(nrm, 0.06);
    // Box local X runs down the slope, Z along the ridge (same basis as the decking boards).
    const spec = boxSpec(0, 0, 0, slopeLen / 2, 0.17, aLen / 2, FLOOR, q);
    spec.center.copy(cc).applyMatrix4(rot);
    spec.quat.premultiply(rotQ);
    spec.tag = 'roof';
    colliders.push(spec);
  }
  // Ridge snow roll (owned by the cell whose half-open s-range contains the ridge).
  if (c.sc >= c.s0 - 1e-3 && c.sc < c.s1 - 1e-3) {
    const ry = yTop(c.sc) + SNOW_T * 0.75;
    g.log(V(a0e, ry, c.sc), V(a1e, ry, c.sc), SNOW_T * 0.72, { kind: 'snow', seed: c.seed + 13, radial: 10, wobble: 0.1, bow: 0, taper: 0 });
  }
  // Purlins & ridge beam (logs along the ridge), with end grain showing under gable overhangs.
  const purlins = [c.sc, c.sc - c.halfSpan * 0.5, c.sc + c.halfSpan * 0.5];
  purlins.forEach((ps, i) => {
    if (!(ps >= c.s0 - 1e-3 && ps < c.s1 - 1e-3)) return;
    const r = i === 0 ? 0.17 : 0.14;
    const y = yTop(ps) - DECK_T - r + 0.02;
    const tint = woodTint(c.seed * 13 + i, 0.85).multiply(LOG_BASE);
    g.log(V(c.a0 - (c.extA0 > 0 ? c.extA0 + 0.12 : 0), y, ps), V(c.a1 + (c.extA1 > 0 ? c.extA1 + 0.12 : 0), y, ps), r, {
      seed: c.seed * 17 + i,
      tint,
      capA: c.extA0 > 0,
      capB: c.extA1 > 0,
      snow: 0,
    });
  });
  // Board-and-batten gable ends above the log walls.
  const gableEnd = (aw: number, outward: number) => {
    const sw0 = Math.max(c.s0, c.sc - c.halfSpan),
      sw1 = Math.min(c.s1, c.sc + c.halfSpan);
    const bwid = 0.22;
    const n = Math.max(1, Math.round((sw1 - sw0) / bwid));
    const w = (sw1 - sw0) / n;
    for (let i = 0; i < n; i++) {
      const sa = sw0 + i * w + 0.006,
        sb = sw0 + (i + 1) * w - 0.006;
      const ya = yTop(sa) - DECK_T - 0.01,
        yb = yTop(sb) - DECK_T - 0.01;
      const y0 = c.gableBase;
      if (Math.max(ya, yb) <= y0 + 0.02) continue;
      const tint = woodTint(c.seed * 131 + i + (outward > 0 ? 50 : 0), 0.78, 0.26).multiply(PLANK_BASE);
      const ao = aw + outward * 0.03;
      const ai = aw - outward * 0.03;
      // Outer face, inner face, and the two top/side edges (cheap prism).
      const p = [V(ao, y0, sa), V(ao, y0, sb), V(ao, Math.max(y0, yb), sb), V(ao, Math.max(y0, ya), sa)];
      const pi = [V(ai, y0, sa), V(ai, y0, sb), V(ai, Math.max(y0, yb), sb), V(ai, Math.max(y0, ya), sa)];
      const uv = [0, 0, 0.2, 0, 0.2, 1.5, 0, 1.5];
      if (outward > 0) {
        g.quad(p[0], p[3], p[2], p[1], 'plank', uv, tint);
        g.quad(pi[0], pi[1], pi[2], pi[3], 'plank', uv, tint);
      } else {
        g.quad(p[0], p[1], p[2], p[3], 'plank', uv, tint);
        g.quad(pi[0], pi[3], pi[2], pi[1], 'plank', uv, tint);
      }
    }
    // Batten along the base.
    g.box(V(aw + outward * 0.05, c.gableBase + 0.05, (sw0 + sw1) / 2), V(0.05, 0.1, sw1 - sw0), Q0, 'plank', { tint: PLANK_BASE.clone().multiplyScalar(0.6), snow: 1 });
    // Colliders: the gable triangle as a few stepped boxes (keeps wind and shelter rays out).
    const steps = 4;
    for (let k = 0; k < steps; k++) {
      const sa = sw0 + ((sw1 - sw0) * k) / steps,
        sb = sw0 + ((sw1 - sw0) * (k + 1)) / steps;
      // Lower of the two ends so nothing pokes through the roof you can walk on.
      const top = Math.min(yTop(sa), yTop(sb)) - DECK_T;
      if (top <= c.gableBase + 0.05) continue;
      const spec = boxSpec(aw, (c.gableBase + top) / 2, (sa + sb) / 2, 0.06, (top - c.gableBase) / 2, (sb - sa) / 2, STRUCT);
      spec.center.applyMatrix4(rot);
      spec.quat.premultiply(rotQ);
      spec.tag = 'gable';
      colliders.push(spec);
    }
  };
  if (c.gableA0) gableEnd(c.a0, -1);
  if (c.gableA1) gableEnd(c.a1, 1);
  g.pop();
  return { geo: g, colliders };
}

// ================================================================== campfire
export function buildCampfire(seed: number): Built {
  const g = new GeoBuilder();
  // Ash bed: a shallow noisy disc.
  const pos: number[] = [],
    nrm: number[] = [],
    uv: number[] = [],
    idx: number[] = [];
  const rings = 5,
    seg = 18,
    R = 0.62;
  pos.push(0, 0.05, 0);
  nrm.push(0, 1, 0);
  uv.push(0, 0);
  for (let r = 1; r <= rings; r++) {
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      const rr = (r / rings) * R * (1 + 0.08 * Math.sin(a * 3 + seed));
      const y = 0.05 * (1 - r / rings) + 0.01 + (hash2(seed + r, j) - 0.5) * 0.02;
      pos.push(Math.cos(a) * rr, y, Math.sin(a) * rr);
      nrm.push(0, 1, 0);
      uv.push(Math.cos(a) * rr, Math.sin(a) * rr);
    }
  }
  for (let j = 0; j < seg; j++) idx.push(0, 1 + ((j + 1) % seg), 1 + j);
  for (let r = 1; r < rings; r++)
    for (let j = 0; j < seg; j++) {
      const a = 1 + (r - 1) * seg + j,
        b = 1 + (r - 1) * seg + ((j + 1) % seg);
      const c2 = a + seg,
        d = b + seg;
      idx.push(a, b, d, a, d, c2);
    }
  g.mesh('ash', pos, nrm, uv, idx);
  // Stone ring.
  const nStones = 10;
  for (let i = 0; i < nStones; i++) {
    const a = (i / nStones) * Math.PI * 2 + hash2(seed, i) * 0.25;
    const r = 0.66 + hash2(seed, i + 20) * 0.06;
    const sr = 0.14 + hash2(seed, i + 40) * 0.07;
    // Hearth stones are warm: no snow on them.
    g.stone(V(Math.cos(a) * r, sr * 0.3, Math.sin(a) * r), sr, seed * 101 + i, { squash: 0.62, snow: 0 });
  }
  // Firewood: a teepee of split logs over two crossed base logs; char & glow toward the middle.
  const wood = new THREE.Color(0.55, 0.5, 0.47);
  for (let i = 0; i < 2; i++) {
    const a = i * Math.PI * 0.5 + 0.4;
    const d = V(Math.cos(a), 0, Math.sin(a));
    g.log(d.clone().multiplyScalar(-0.42).setY(0.09), d.clone().multiplyScalar(0.42).setY(0.09 + i * 0.07), 0.055, { kind: 'charred', seed: seed + i, tint: wood, snow: 0.9, capA: true, capB: true, radial: 8 });
  }
  const nT = 5;
  for (let i = 0; i < nT; i++) {
    const a = (i / nT) * Math.PI * 2 + 0.3;
    const foot = V(Math.cos(a) * 0.36, 0.04, Math.sin(a) * 0.36);
    const topP = V(Math.cos(a) * 0.05, 0.55 + hash2(seed, i + 60) * 0.1, Math.sin(a) * 0.05);
    g.log(foot, topP, 0.045, { kind: 'charred', seed: seed * 3 + i, tint: wood, snow: 1, capA: true, capB: true, radial: 7 });
  }
  // Cooking spit: forked uprights and a crossbar (always there — cooking happens here).
  const spitTint = new THREE.Color(0.75, 0.66, 0.56);
  for (const sx of [-0.82, 0.82]) {
    g.log(V(sx, -0.1, 0), V(sx, 0.86, 0), 0.028, { seed: seed + sx * 10, tint: spitTint, radial: 6, capB: true });
    g.log(V(sx, 0.8, 0), V(sx - 0.07, 0.98, 0.02), 0.018, { seed: seed + sx * 20, tint: spitTint, radial: 5, capB: true });
    g.log(V(sx, 0.8, 0), V(sx + 0.07, 0.97, -0.02), 0.018, { seed: seed + sx * 30, tint: spitTint, radial: 5, capB: true });
  }
  g.log(V(-0.98, 0.9, 0), V(0.98, 0.89, 0), 0.02, { seed: seed + 77, tint: spitTint.clone().multiplyScalar(0.8), radial: 6, capA: true, capB: true });
  return { geo: g, colliders: [] };
}

// ================================================================== bedroll
export function buildBedroll(seed: number): Built {
  const g = new GeoBuilder();
  // Spruce bough mattress.
  const bough = new THREE.Color(0.85, 0.95, 0.85);
  for (let i = 0; i < 12; i++) {
    const row = i % 6,
      col = Math.floor(i / 6);
    const z = -0.95 + row * 0.38;
    const x = col === 0 ? -0.22 : 0.22;
    const a = (col === 0 ? Math.PI : 0) + (hash2(seed, i) - 0.5) * 0.6;
    const d = V(Math.cos(a), 0, Math.sin(a) * 0.4).normalize();
    g.frond(V(x - d.x * 0.1, 0.06 + hash2(seed, i + 9) * 0.03, z), d, V(0, 1, 0), 0.62, 0.42, 0.02, bough, 0);
  }
  // Hide blanket: rumpled sheet draped over the boughs.
  const nx = 9,
    nz = 16,
    W = 0.95,
    L = 2.0;
  const pos: number[] = [],
    nrm: number[] = [],
    uv: number[] = [],
    idx: number[] = [];
  const hgt = (u: number, v: number) => {
    const edge = Math.min(u, 1 - u, v * 1.5, 1 - v) * 2;
    const drape = Math.min(1, edge * 3);
    const body = Math.sin(Math.PI * u) * 0.06 * (v < 0.85 ? 1 : 0.4);
    const fold = 0.025 * Math.sin(v * 17 + seed) * Math.sin(u * 5 + seed * 0.3);
    return 0.1 + drape * (0.08 + body + fold) - (1 - drape) * 0.02;
  };
  for (let j = 0; j <= nz; j++)
    for (let i = 0; i <= nx; i++) {
      const u = i / nx,
        v = j / nz;
      const x = (u - 0.5) * W,
        z = (v - 0.5) * L - 0.05;
      pos.push(x, hgt(u, v), z);
      uv.push(v * 2, u);
      // Normal by finite differences.
      const e = 0.02;
      const hx = (hgt(Math.min(1, u + e), v) - hgt(Math.max(0, u - e), v)) / (2 * e * W);
      const hz = (hgt(u, Math.min(1, v + e)) - hgt(u, Math.max(0, v - e))) / (2 * e * L);
      const n = V(-hx, 1, -hz).normalize();
      nrm.push(n.x, n.y, n.z);
    }
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      idx.push(a, a + nx + 1, a + 1, a + 1, a + nx + 1, a + nx + 2);
    }
  g.mesh('hide', pos, nrm, uv, idx, new THREE.Color(1, 1, 1), 0);
  // Rolled hide pillow at the head end.
  g.log(V(-0.36, 0.17, -0.92), V(0.36, 0.17, -0.92), 0.1, { kind: 'hide', seed: seed + 5, radial: 10, wobble: 0.1, capA: true, capB: true, tint: new THREE.Color(0.8, 0.72, 0.66), snow: 0 });
  return { geo: g, colliders: [] };
}

// ================================================================== lean-to
export function buildLeanTo(seed: number): Built {
  const g = new GeoBuilder();
  const tint = woodTint(seed, 0.85).multiply(LOG_BASE);
  const frontZ = 0.95,
    backZ = -1.35,
    ridgeY = 1.9,
    halfW = 1.45;
  // Forked front posts.
  for (const x of [-halfW + 0.1, halfW - 0.1]) {
    g.log(V(x, -0.2, frontZ), V(x, ridgeY + 0.1, frontZ), 0.07, { seed: seed + x * 10, tint, radial: 8, capB: true });
    g.log(V(x, ridgeY - 0.05, frontZ), V(x + 0.12, ridgeY + 0.22, frontZ + 0.05), 0.04, { seed: seed + x * 20, tint, radial: 6, capB: true });
  }
  // Ridge pole.
  g.log(V(-halfW - 0.3, ridgeY + 0.06, frontZ), V(halfW + 0.3, ridgeY + 0.06, frontZ), 0.075, { seed: seed + 3, tint, radial: 9, capA: true, capB: true, snow: 1 });
  // Slanted poles from ridge to ground.
  const nP = 6;
  for (let i = 0; i < nP; i++) {
    const x = -halfW + (i / (nP - 1)) * halfW * 2;
    g.log(V(x, ridgeY + 0.2, frontZ + 0.18), V(x, -0.15, backZ - 0.1), 0.05, { seed: seed * 7 + i, tint, radial: 7, capA: true, snow: 0.8 });
  }
  // Boughs shingled from the bottom up; each frond points down-slope.
  const slope = V(0, ridgeY - 0.0, frontZ - backZ).normalize();
  const down = slope.clone().negate();
  const up = V(0, frontZ - backZ, -ridgeY).normalize(); // roof normal: up & toward the back
  const bt = new THREE.Color(0.95, 1.0, 0.95);
  const rows = 6;
  for (let r = 0; r < rows; r++) {
    const t = (r + 0.6) / rows;
    const base = V(0, t * ridgeY, backZ + t * (frontZ - backZ)).addScaledVector(up, 0.09);
    for (let k = 0; k < 6; k++) {
      const x = -halfW + (k + 0.5 + (hash2(seed, r * 9 + k) - 0.5) * 0.5) * ((halfW * 2) / 6);
      const d = down.clone().add(V((hash2(seed + 1, r * 9 + k) - 0.5) * 0.5, 0, 0)).normalize();
      g.frond(V(x, base.y, base.z), d, up, 0.95, 0.6, 0.08, bt, 1);
    }
  }
  // A few boughs on the ground inside (a dry floor).
  for (let k = 0; k < 5; k++) {
    const x = -1.0 + k * 0.5;
    g.frond(V(x, 0.05, 0.3), V(0.2 * (hash2(seed, k) - 0.5), 0, -1).normalize(), V(0, 1, 0), 0.9, 0.5, 0.0, bt, 0.2);
  }
  const len = Math.hypot(ridgeY, frontZ - backZ);
  const ang = Math.atan2(ridgeY, frontZ - backZ);
  const q = new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), -ang);
  const colliders = [boxSpec(0, ridgeY / 2 + 0.05, (frontZ + backZ) / 2 - 0.05, halfW, 0.1, len / 2, STRUCT, q)];
  colliders[0].tag = 'lean_to';
  return { geo: g, colliders };
}
