// Procedural geometry builder for the handcrafted look: irregular round logs with end grain,
// planks, flat-shaded stones, spruce bough fronds. Vertices are accumulated per material kind and
// emitted as one mesh per kind (so a whole cabin wall is ~3 draw calls).
//
// Every vertex carries: position, normal, uv (metres along/around the surface, or 0..1 for fronds),
// colour (per-piece tint variation) and aSnow (how much snow may settle there; see Materials.ts).
import * as THREE from 'three';
import { mat, createGhostMaterial, type MatKind } from './Materials';
import { hash2 } from '../core/math';

class Part {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  snow: number[] = [];
  idx: number[] = [];
}

export interface LogOpts {
  seed?: number;
  /** Colour multiplier (vertex colour). */
  tint?: THREE.Color;
  /** aSnow on this log (0..1). */
  snow?: number;
  capA?: boolean;
  capB?: boolean;
  radial?: number;
  /** Radius difference between the two ends (fraction). */
  taper?: number;
  /** Radius noise amplitude (fraction). */
  wobble?: number;
  /** Mid-span bow (m). */
  bow?: number;
  kind?: MatKind;
  segLen?: number;
  /** Per-vertex aSnow from the ring vertex (local position & normal). Overrides `snow`. */
  snowFn?: (x: number, y: number, z: number, nx: number, ny: number, nz: number) => number;
  /** Rotate the ring frame (radians) so seams hide underneath. */
  roll?: number;
  /**
   * Distance along the log's line where this log starts. Walls pass their position along the
   * wall line so bark pattern and radius wobble continue seamlessly across neighbouring pieces.
   */
  uOffset?: number;
}

export interface BoxOpts {
  tint?: THREE.Color;
  snow?: number;
  /** Per-face aSnow only on the +Y face (true) or everywhere (false). */
  snowTopOnly?: boolean;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _n = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _side = new THREE.Vector3();
const _upv = new THREE.Vector3();
const _p = new THREE.Vector3();
const _vn = new THREE.Vector3();
const _m3 = new THREE.Matrix3();
const WHITE = new THREE.Color(1, 1, 1);

export class GeoBuilder {
  private parts = new Map<MatKind, Part>();
  /** Current transform applied to everything added (local assembly → piece space). */
  xf = new THREE.Matrix4();
  private stack: THREE.Matrix4[] = [];

  push(m: THREE.Matrix4) {
    this.stack.push(this.xf.clone());
    this.xf.multiply(m);
  }
  pop() {
    this.xf.copy(this.stack.pop() ?? new THREE.Matrix4());
  }

  private part(k: MatKind): Part {
    let p = this.parts.get(k);
    if (!p) this.parts.set(k, (p = new Part()));
    return p;
  }

  get empty() {
    return this.parts.size === 0;
  }

  /** Adds a vertex (position/normal in current transform space). Returns its index. */
  vert(p: Part, x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, c: THREE.Color, s: number): number {
    // Own temporaries: callers often pass components of the shared _n/_c vectors.
    _p.set(x, y, z).applyMatrix4(this.xf);
    _m3.getNormalMatrix(this.xf);
    _vn.set(nx, ny, nz).applyMatrix3(_m3).normalize();
    p.pos.push(_p.x, _p.y, _p.z);
    p.nrm.push(_vn.x, _vn.y, _vn.z);
    p.uv.push(u, v);
    p.col.push(c.r, c.g, c.b);
    p.snow.push(s);
    return p.pos.length / 3 - 1;
  }

  // ------------------------------------------------------------ logs
  /** Irregular round log from a to b (piece space, before xf). */
  log(a: THREE.Vector3, b: THREE.Vector3, radius: number, o: LogOpts = {}) {
    const seed = o.seed ?? 1;
    const kind = o.kind ?? 'bark';
    const p = this.part(kind);
    const radial = o.radial ?? 12;
    const taper = o.taper ?? 0.08;
    const wob = o.wobble ?? 0.035;
    const bow = o.bow ?? 0.02;
    const snow = o.snow ?? 0;
    const tint = o.tint ?? WHITE;
    _axis.subVectors(b, a);
    const L = _axis.length();
    if (L < 1e-4) return;
    _axis.divideScalar(L);
    if (Math.abs(_axis.y) < 0.95) _side.crossVectors(_axis, new THREE.Vector3(0, 1, 0)).normalize();
    else _side.crossVectors(_axis, new THREE.Vector3(1, 0, 0)).normalize();
    _upv.crossVectors(_side, _axis).normalize();
    const side = _side.clone(),
      upv = _upv.clone(),
      axis = _axis.clone();
    const roll = o.roll ?? 0;
    const segLen = o.segLen ?? 0.42;
    const rings = Math.max(2, Math.ceil(L / segLen)) + 1;
    const flip = hash2(seed, 3) < 0.5 ? -1 : 1;
    const bowDir = hash2(seed, 4) * Math.PI * 2;
    const col = new THREE.Color();
    const u0 = o.uOffset ?? 0;
    const rAt = (t: number) => {
      const u = u0 + t * L;
      return radius * (1 + taper * flip * (0.5 - t)) * (1 + wob * (Math.sin(u * 1.7 + seed) * 0.6 + Math.sin(u * 4.3 + seed * 1.3) * 0.4));
    };
    const centre = (t: number, out: THREE.Vector3) => {
      const bw = Math.sin(Math.PI * t) * bow;
      return out
        .copy(a)
        .addScaledVector(axis, t * L)
        .addScaledVector(side, Math.cos(bowDir) * bw)
        .addScaledVector(upv, Math.sin(bowDir) * bw);
    };
    const base = p.pos.length / 3;
    for (let i = 0; i < rings; i++) {
      const t = i / (rings - 1);
      const r = rAt(t);
      centre(t, _c);
      for (let j = 0; j <= radial; j++) {
        const phi = (j / radial) * Math.PI * 2 + roll;
        const oor = 1 + 0.025 * Math.sin(3 * phi + seed) + 0.015 * Math.sin(5 * phi + seed * 2.1);
        const cx = Math.cos(phi),
          cy = Math.sin(phi);
        _n.copy(side).multiplyScalar(cx).addScaledVector(upv, cy);
        const rr = r * oor;
        const shade = 0.94 + 0.12 * hash2(seed * 131 + i, j);
        col.copy(tint).multiplyScalar(shade);
        // Snow only on the upper half; the shader further restricts it to up-facing normals.
        const px = _c.x + _n.x * rr,
          py = _c.y + _n.y * rr,
          pz = _c.z + _n.z * rr;
        const sv = o.snowFn ? o.snowFn(px, py, pz, _n.x, _n.y, _n.z) : snow;
        this.vert(p, px, py, pz, _n.x, _n.y, _n.z, u0 + t * L, (j / radial) * Math.PI * 2 * radius, col, sv);
      }
    }
    const row = radial + 1;
    for (let i = 0; i < rings - 1; i++)
      for (let j = 0; j < radial; j++) {
        const k = base + i * row + j;
        p.idx.push(k, k + row, k + 1, k + 1, k + row, k + row + 1);
      }
    // End caps: bark rim annulus + end-grain disc (slightly inset so the bark lip reads).
    const cap = (t: number, dirSign: number) => {
      const r = rAt(t);
      centre(t, _c);
      const inset = 0.012;
      const cc = _c.clone().addScaledVector(axis, -dirSign * inset);
      const nx = axis.x * dirSign,
        ny = axis.y * dirSign,
        nz = axis.z * dirSign;
      const rim = this.part(kind);
      const eg = this.part(kind === 'bark' ? 'endgrain' : kind);
      const capSnow = o.snowFn ? o.snowFn(_c.x, _c.y, _c.z, 0, 1, 0) : snow;
      const rimCol = kind === 'bark' ? tint.clone().multiplyScalar(0.62) : tint;
      const rb = rim.pos.length / 3;
      for (let j = 0; j <= radial; j++) {
        const phi = (j / radial) * Math.PI * 2 + roll;
        const oor = 1 + 0.025 * Math.sin(3 * phi + seed) + 0.015 * Math.sin(5 * phi + seed * 2.1);
        _n.copy(side).multiplyScalar(Math.cos(phi)).addScaledVector(upv, Math.sin(phi));
        const ro = r * oor,
          ri = r * oor * 0.9;
        this.vert(rim, _c.x + _n.x * ro, _c.y + _n.y * ro, _c.z + _n.z * ro, nx, ny, nz, 0, 0, rimCol, capSnow * 0.6);
        this.vert(rim, cc.x + _n.x * ri, cc.y + _n.y * ri, cc.z + _n.z * ri, nx, ny, nz, 0, 0, rimCol, capSnow * 0.6);
      }
      for (let j = 0; j < radial; j++) {
        const k = rb + j * 2;
        if (dirSign > 0) rim.idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
        else rim.idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
      }
      const eb = eg.pos.length / 3;
      const egTint = kind !== 'bark' ? tint : new THREE.Color(1, 1, 1).lerp(tint, 0.25);
      this.vert(eg, cc.x, cc.y, cc.z, nx, ny, nz, 0, 0, egTint, capSnow * 0.5);
      for (let j = 0; j <= radial; j++) {
        const phi = (j / radial) * Math.PI * 2 + roll;
        const oor = 1 + 0.025 * Math.sin(3 * phi + seed) + 0.015 * Math.sin(5 * phi + seed * 2.1);
        _n.copy(side).multiplyScalar(Math.cos(phi)).addScaledVector(upv, Math.sin(phi));
        const ri = r * oor * 0.9;
        this.vert(eg, cc.x + _n.x * ri, cc.y + _n.y * ri, cc.z + _n.z * ri, nx, ny, nz, Math.cos(phi) * ri, Math.sin(phi) * ri, egTint, capSnow * 0.5);
      }
      for (let j = 0; j < radial; j++) {
        if (dirSign > 0) eg.idx.push(eb, eb + 2 + j, eb + 1 + j);
        else eg.idx.push(eb, eb + 1 + j, eb + 2 + j);
      }
    };
    if (o.capA) cap(0, -1);
    if (o.capB) cap(1, 1);
  }

  // ------------------------------------------------------------ boxes & quads
  /**
   * Oriented box. `center` in current space, axes given by a quaternion; `size` full extents.
   * UVs are metres; u follows the box's local X (the grain direction of planks).
   */
  box(center: THREE.Vector3, size: THREE.Vector3, q: THREE.Quaternion, kind: MatKind, o: BoxOpts = {}) {
    const p = this.part(kind);
    const hx = size.x / 2,
      hy = size.y / 2,
      hz = size.z / 2;
    const tint = o.tint ?? WHITE;
    const snow = o.snow ?? 0;
    const ex = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const ey = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const ez = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    // faces: normal axis, u axis, v axis, half sizes
    const faces: [THREE.Vector3, number, THREE.Vector3, number, THREE.Vector3, number, boolean][] = [
      [ey, hy, ex, hx, ez.clone().negate(), hz, true],
      [ey.clone().negate(), hy, ex, hx, ez, hz, false],
      [ez, hz, ex, hx, ey, hy, false],
      [ez.clone().negate(), hz, ex.clone().negate(), hx, ey, hy, false],
      [ex, hx, ez.clone().negate(), hz, ey, hy, false],
      [ex.clone().negate(), hx, ez, hz, ey, hy, false],
    ];
    for (const [n, hn, u, hu, v, hv, top] of faces) {
      const s = o.snowTopOnly === false ? snow : top ? snow : 0;
      const b = p.pos.length / 3;
      for (const [su, sv] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        _a.copy(center).addScaledVector(n, hn).addScaledVector(u, su * hu).addScaledVector(v, sv * hv);
        // UV in metres along the box's local axes (u follows local X where possible).
        this.vert(p, _a.x, _a.y, _a.z, n.x, n.y, n.z, su * hu + hu, sv * hv + hv, tint, s);
      }
      p.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
  }

  /** Quad from 4 corners (counter-clockwise seen from the front). */
  quad(c0: THREE.Vector3, c1: THREE.Vector3, c2: THREE.Vector3, c3: THREE.Vector3, kind: MatKind, uvs: number[], tint: THREE.Color = WHITE, snow = 0) {
    const p = this.part(kind);
    _a.subVectors(c1, c0);
    _b.subVectors(c3, c0);
    _n.crossVectors(_a, _b).normalize();
    const n = _n.clone();
    const b = p.pos.length / 3;
    const cs = [c0, c1, c2, c3];
    for (let i = 0; i < 4; i++) this.vert(p, cs[i].x, cs[i].y, cs[i].z, n.x, n.y, n.z, uvs[i * 2], uvs[i * 2 + 1], tint, snow);
    p.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }

  /** Irregular, flat-shaded stone. */
  stone(center: THREE.Vector3, radius: number, seed: number, o: { squash?: number; tint?: THREE.Color; snow?: number; detail?: number } = {}) {
    const p = this.part('stone');
    // Polyhedron geometries are already non-indexed (one vertex per face corner).
    const g = new THREE.IcosahedronGeometry(1, o.detail ?? 1);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const squash = o.squash ?? 0.6;
    const rot = new THREE.Euler(hash2(seed, 1) * 6, hash2(seed, 2) * 6, hash2(seed, 3) * 6);
    const rq = new THREE.Quaternion().setFromEuler(rot);
    const vs: THREE.Vector3[] = [];
    for (let i = 0; i < pos.count; i++) {
      _a.fromBufferAttribute(pos, i).applyQuaternion(rq);
      const k = 1 + 0.22 * (Math.sin(_a.x * 3.1 + seed) * Math.sin(_a.y * 2.7 + seed * 0.7) * Math.sin(_a.z * 3.3 + seed * 1.9)) + 0.08 * Math.sin(_a.x * 7 + _a.z * 5 + seed);
      vs.push(new THREE.Vector3(_a.x * k * radius, Math.max(_a.y * k * radius * squash, -radius * squash * 0.55), _a.z * k * radius).add(center));
    }
    const tint = (o.tint ?? new THREE.Color(1, 1, 1)).clone().multiplyScalar(0.9 + hash2(seed, 5) * 0.2);
    tint.r = Math.min(1, tint.r + hash2(seed, 9) * 0.02);
    const snow = o.snow ?? 1;
    for (let i = 0; i < vs.length; i += 3) {
      _a.subVectors(vs[i + 1], vs[i]);
      _b.subVectors(vs[i + 2], vs[i]);
      _n.crossVectors(_a, _b).normalize();
      const b = p.pos.length / 3;
      for (let k = 0; k < 3; k++) this.vert(p, vs[i + k].x, vs[i + k].y, vs[i + k].z, _n.x, _n.y, _n.z, 0, 0, tint, snow);
      p.idx.push(b, b + 1, b + 2);
    }
    g.dispose();
  }

  /**
   * Spruce bough frond: a drooping, slightly cupped strip textured with the needle sprite.
   * base → along `dir` for `length`, `width` across `side`; `up` is the frond's top side.
   */
  frond(base: THREE.Vector3, dir: THREE.Vector3, up: THREE.Vector3, length: number, width: number, droop: number, tint: THREE.Color, snow = 0.8) {
    const p = this.part('bough');
    const side = new THREE.Vector3().crossVectors(dir, up).normalize();
    const segs = 3;
    const b = p.pos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      _c.copy(base).addScaledVector(dir, t * length).addScaledVector(up, -droop * t * t);
      for (let s = -1; s <= 1; s += 2) {
        _d.copy(_c).addScaledVector(side, s * width * 0.5 * (1 - t * 0.35)).addScaledVector(up, -Math.abs(s) * width * 0.08);
        _n.copy(up).addScaledVector(side, s * 0.25).normalize();
        this.vert(p, _d.x, _d.y, _d.z, _n.x, _n.y, _n.z, s < 0 ? 0 : 1, t, tint, snow);
      }
    }
    for (let i = 0; i < segs; i++) {
      const k = b + i * 2;
      p.idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }

  /** Tapered cone (icicles, spikes). */
  cone(tip: THREE.Vector3, base: THREE.Vector3, radius: number, kind: MatKind, tint: THREE.Color = WHITE, radial = 6) {
    const p = this.part(kind);
    _axis.subVectors(tip, base).normalize();
    _side.crossVectors(_axis, Math.abs(_axis.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
    _upv.crossVectors(_side, _axis).normalize();
    const b = p.pos.length / 3;
    for (let j = 0; j <= radial; j++) {
      const phi = (j / radial) * Math.PI * 2;
      _n.copy(_side).multiplyScalar(Math.cos(phi)).addScaledVector(_upv, Math.sin(phi));
      this.vert(p, base.x + _n.x * radius, base.y + _n.y * radius, base.z + _n.z * radius, _n.x, _n.y, _n.z, j / radial, 0, tint, 0);
      this.vert(p, tip.x, tip.y, tip.z, _n.x, _n.y, _n.z, j / radial, 1, tint, 0);
    }
    for (let j = 0; j < radial; j++) {
      const k = b + j * 2;
      p.idx.push(k, k + 1, k + 2);
    }
  }

  /** Raw triangle mesh (positions/normals in current space). Used for snow slabs & ash beds. */
  mesh(kind: MatKind, positions: number[], normals: number[], uvs: number[], indices: number[], tint: THREE.Color = WHITE, snow = 0) {
    const p = this.part(kind);
    const b = p.pos.length / 3;
    for (let i = 0; i < positions.length / 3; i++) {
      this.vert(p, positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2], uvs[i * 2] ?? 0, uvs[i * 2 + 1] ?? 0, tint, snow);
    }
    for (const i of indices) p.idx.push(b + i);
  }

  // ------------------------------------------------------------ output
  private geometryOf(p: Part): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(p.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(p.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(p.col, 3));
    g.setAttribute('aSnow', new THREE.Float32BufferAttribute(p.snow, 1));
    g.setIndex(p.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(p.idx, 1) : new THREE.Uint16BufferAttribute(p.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }

  /** One mesh per material kind. */
  toGroup(opts: { castShadow?: boolean; receiveShadow?: boolean; variant?: Partial<Record<MatKind, string>> } = {}): THREE.Group {
    const g = new THREE.Group();
    for (const [k, p] of this.parts) {
      if (!p.idx.length) continue;
      const m = new THREE.Mesh(this.geometryOf(p), mat(k, opts.variant?.[k]));
      m.castShadow = opts.castShadow ?? true;
      m.receiveShadow = opts.receiveShadow ?? true;
      m.name = k;
      if (k === 'ice') m.castShadow = false;
      g.add(m);
    }
    return g;
  }

  /** Everything merged into one geometry (for the placement ghost). */
  toMergedGeometry(): THREE.BufferGeometry {
    const all = new Part();
    for (const p of this.parts.values()) {
      const b = all.pos.length / 3;
      all.pos.push(...p.pos);
      all.nrm.push(...p.nrm);
      all.uv.push(...p.uv);
      all.col.push(...p.col);
      all.snow.push(...p.snow);
      for (const i of p.idx) all.idx.push(i + b);
    }
    return this.geometryOf(all);
  }

  /** A ghost mesh of everything added. */
  toGhost(material?: THREE.Material): THREE.Mesh {
    const m = new THREE.Mesh(this.toMergedGeometry(), material ?? createGhostMaterial());
    m.renderOrder = 10;
    return m;
  }
}

/** Dispose geometries of an object tree (materials are shared and never disposed). */
export function disposeTree(o: THREE.Object3D) {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.isMesh && m.geometry) m.geometry.dispose();
  });
}

/** Deterministic per-log tint around a base colour. */
export function woodTint(seed: number, base = 1, spread = 0.14): THREE.Color {
  const v = base * (1 - spread / 2 + hash2(seed, 77) * spread);
  const warm = (hash2(seed, 78) - 0.5) * 0.06;
  return new THREE.Color(v * (1 + warm), v, v * (1 - warm));
}
