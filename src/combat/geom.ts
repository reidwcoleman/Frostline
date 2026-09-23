// Procedural geometry helpers shared by the weapon viewmodels (src/combat) and the animal
// models (src/wildlife). Everything is built once at init from primitives and "lofts"
// (tubes with elliptical cross-sections swept along a path) and merged into one buffer
// per model, with vertex colours and optional skinning attributes.
import * as THREE from 'three';

export interface LoftRing {
  /** Centre of the cross-section. */
  p: THREE.Vector3;
  /** Half-width (side axis) and half-height (normal axis). */
  rx: number;
  ry: number;
  /** Optional vertical offset of the section (e.g. a sagging belly) applied along the normal axis. */
  dy?: number;
}

const _t = new THREE.Vector3();
const _s = new THREE.Vector3();
const _n = new THREE.Vector3();
const _up = new THREE.Vector3();

/**
 * Sweep elliptical rings along a path. The ring's "ry" axis is the path normal closest to `up`
 * (world +Y by default), so bodies stay upright. Caps close both ends.
 */
export function loft(rings: LoftRing[], radial = 10, opts: { up?: THREE.Vector3; capStart?: boolean; capEnd?: boolean } = {}): THREE.BufferGeometry {
  const up = opts.up ?? new THREE.Vector3(0, 1, 0);
  const pos: number[] = [];
  const idx: number[] = [];
  const n = rings.length;
  // Rotation-minimising frames: the first ring's frame comes from `up`, later rings
  // parallel-transport it so sections never flip on steep or curving paths.
  const prevT = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const q = new THREE.Quaternion();
  for (let i = 0; i < n; i++) {
    const a = rings[Math.max(0, i - 1)].p;
    const b = rings[Math.min(n - 1, i + 1)].p;
    _t.subVectors(b, a).normalize();
    if (i === 0) {
      _up.copy(up);
      if (Math.abs(_t.dot(_up)) > 0.98) _up.set(0, 0, 1);
      if (Math.abs(_t.dot(_up)) > 0.98) _up.set(1, 0, 0);
      _s.crossVectors(_up, _t).normalize(); // side
    } else {
      axis.crossVectors(prevT, _t);
      const len = axis.length();
      if (len > 1e-6) {
        q.setFromAxisAngle(axis.divideScalar(len), Math.acos(Math.min(1, Math.max(-1, prevT.dot(_t)))));
        _s.applyQuaternion(q);
      }
      _s.addScaledVector(_t, -_s.dot(_t)).normalize();
    }
    prevT.copy(_t);
    _n.crossVectors(_t, _s).normalize(); // "up" of the section
    const r = rings[i];
    for (let k = 0; k < radial; k++) {
      const ang = (k / radial) * Math.PI * 2;
      const c = Math.cos(ang),
        s = Math.sin(ang);
      pos.push(
        r.p.x + _s.x * c * r.rx + _n.x * (s * r.ry + (r.dy ?? 0)),
        r.p.y + _s.y * c * r.rx + _n.y * (s * r.ry + (r.dy ?? 0)),
        r.p.z + _s.z * c * r.rx + _n.z * (s * r.ry + (r.dy ?? 0)),
      );
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let k = 0; k < radial; k++) {
      const k1 = (k + 1) % radial;
      const a = i * radial + k,
        b = i * radial + k1,
        c = (i + 1) * radial + k,
        d = (i + 1) * radial + k1;
      idx.push(a, b, c, b, d, c);
    }
  }
  if (opts.capStart !== false) {
    const ci = pos.length / 3;
    const p = rings[0].p;
    pos.push(p.x, p.y, p.z);
    for (let k = 0; k < radial; k++) idx.push(ci, (k + 1) % radial, k);
  }
  if (opts.capEnd !== false) {
    const ci = pos.length / 3;
    const p = rings[n - 1].p;
    pos.push(p.x, p.y, p.z);
    const base = (n - 1) * radial;
    for (let k = 0; k < radial; k++) idx.push(ci, base + k, base + ((k + 1) % radial));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Catmull-Rom resample of control rings into `count` smooth rings. */
export function smoothRings(ctrl: LoftRing[], count: number): LoftRing[] {
  const pts = ctrl.map((r) => r.p);
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const out: LoftRing[] = [];
  // Distribute radii by curve parameter (approximate: control index <-> t).
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const p = curve.getPoint(t);
    const f = t * (ctrl.length - 1);
    const i0 = Math.min(ctrl.length - 2, Math.floor(f));
    const u = f - i0;
    const s = u * u * (3 - 2 * u);
    const a = ctrl[i0],
      b = ctrl[i0 + 1];
    out.push({ p, rx: a.rx + (b.rx - a.rx) * s, ry: a.ry + (b.ry - a.ry) * s, dy: (a.dy ?? 0) + ((b.dy ?? 0) - (a.dy ?? 0)) * s });
  }
  return out;
}

/** A tapered tube between two points (legs, shafts, antler tines). */
export function tube(a: THREE.Vector3, b: THREE.Vector3, ra: number, rb: number, radial = 7, segs = 1): THREE.BufferGeometry {
  const rings: LoftRing[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    rings.push({ p: a.clone().lerp(b, t), rx: ra + (rb - ra) * t, ry: ra + (rb - ra) * t });
  }
  return loft(rings, radial);
}

/** Ellipsoid (scaled icosphere-ish sphere). */
export function ellipsoid(c: THREE.Vector3, rx: number, ry: number, rz: number, w = 10, h = 7): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, w, h);
  g.scale(rx, ry, rz);
  g.translate(c.x, c.y, c.z);
  return g;
}

export type ColorFn = (p: THREE.Vector3, n: THREE.Vector3) => THREE.Color;
/** Bone assignment: a single bone, or [boneA, boneB, weightB] blend. */
export type BoneFn = (p: THREE.Vector3) => number | [number, number, number];

interface PartOpts {
  color: THREE.Color | ColorFn;
  bone?: number | BoneFn;
  /** Emissive mask (eyes that glow at night). */
  glow?: number;
  matrix?: THREE.Matrix4;
  /** Recompute flat normals (faceted look) for this part. */
  flat?: boolean;
}

const _p = new THREE.Vector3();
const _nn = new THREE.Vector3();
const _nm = new THREE.Matrix3();

/** Accumulates parts into a single (optionally skinned) BufferGeometry with vertex colours. */
export class MeshBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private col: number[] = [];
  private si: number[] = [];
  private sw: number[] = [];
  private glow: number[] = [];
  private idx: number[] = [];
  private hasGlow = false;

  add(geom: THREE.BufferGeometry, o: PartOpts): this {
    let g = geom;
    if (o.flat) {
      g = g.index ? g.toNonIndexed() : g;
      g.computeVertexNormals();
    } else if (!g.getAttribute('normal')) g.computeVertexNormals();
    const P = g.getAttribute('position') as THREE.BufferAttribute;
    const N = g.getAttribute('normal') as THREE.BufferAttribute;
    const base = this.pos.length / 3;
    if (o.matrix) _nm.getNormalMatrix(o.matrix);
    for (let i = 0; i < P.count; i++) {
      _p.fromBufferAttribute(P, i);
      _nn.fromBufferAttribute(N, i);
      if (o.matrix) {
        _p.applyMatrix4(o.matrix);
        _nn.applyMatrix3(_nm).normalize();
      }
      this.pos.push(_p.x, _p.y, _p.z);
      this.nrm.push(_nn.x, _nn.y, _nn.z);
      const c = typeof o.color === 'function' ? o.color(_p, _nn) : o.color;
      this.col.push(c.r, c.g, c.b);
      const b = o.bone === undefined ? 0 : typeof o.bone === 'number' ? o.bone : o.bone(_p);
      if (typeof b === 'number') {
        this.si.push(b, 0, 0, 0);
        this.sw.push(1, 0, 0, 0);
      } else {
        this.si.push(b[0], b[1], 0, 0);
        this.sw.push(1 - b[2], b[2], 0, 0);
      }
      this.glow.push(o.glow ?? 0);
      if (o.glow) this.hasGlow = true;
    }
    if (g.index) {
      const I = g.index;
      for (let i = 0; i < I.count; i++) this.idx.push(base + I.getX(i));
    } else {
      for (let i = 0; i < P.count; i++) this.idx.push(base + i);
    }
    if (g !== geom) g.dispose();
    geom.dispose();
    return this;
  }

  /** `tint` scales every vertex colour (albedo calibration against the snow). */
  build(skinned: boolean, tint = 1): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(tint === 1 ? this.col : this.col.map((c) => c * tint), 3));
    if (skinned) {
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    }
    if (this.hasGlow || skinned) g.setAttribute('aGlow', new THREE.Float32BufferAttribute(this.glow, 1));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/** Deterministic small hash noise in [-1, 1] from a position (for colour mottling). */
export function mottle(p: THREE.Vector3, scale = 12, seed = 0): number {
  const s = Math.sin(p.x * scale * 1.7 + seed * 3.1) * Math.sin(p.y * scale * 2.3 + 1.3) * Math.sin(p.z * scale * 1.9 + seed);
  const s2 = Math.sin(p.x * scale * 4.1 + 2.0) * Math.sin(p.z * scale * 3.7 + p.y * 5.0 + seed * 0.7);
  return s * 0.7 + s2 * 0.3;
}

export const col = (hex: number) => new THREE.Color(hex);
export const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
