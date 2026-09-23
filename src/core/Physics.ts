// Collision queries against terrain, trees (vertical cylinders), boulders (spheres) and
// dynamic colliders (oriented boxes / spheres / vertical capsules) registered by systems:
//   - Building registers boxes for structure pieces (SOLID | HITTABLE | WALKABLE)
//   - Wildlife registers capsules/spheres for animals (HITTABLE | ENTITY)
// The player controller uses resolveCapsule() + groundProbe(); weapons use raycast()/overlapSphere().
import * as THREE from 'three';
import type { Terrain } from './Terrain';
import type { World } from './World';
import { clamp } from './math';

export const Layer = {
  SOLID: 1, // blocks the player / animals
  HITTABLE: 2, // weapons and projectiles can hit it
  WALKABLE: 4, // can be stood on (floors, roofs)
  ENTITY: 8, // living things
  INTERACT: 16, // doors etc.
} as const;

export type ShapeType = 'box' | 'sphere' | 'capsule';

export interface Collider {
  readonly id: number;
  shape: ShapeType;
  /** box/sphere: centre. capsule: base (feet) position. */
  position: THREE.Vector3;
  /** box orientation. */
  quaternion: THREE.Quaternion;
  /** box half extents. */
  half: THREE.Vector3;
  /** sphere / capsule radius. */
  radius: number;
  /** capsule total height (base to top, including the caps). */
  height: number;
  layers: number;
  enabled: boolean;
  /** The object that owns this collider (Animal, StructurePiece...). */
  owner?: unknown;
  tag?: string;
  /** World AABB (maintained by Physics.updateCollider). */
  min: THREE.Vector3;
  max: THREE.Vector3;
}

export type HitKind = 'terrain' | 'tree' | 'rock' | 'collider';

export interface RayHit {
  kind: HitKind;
  distance: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  /** Tree or rock index for kind 'tree' / 'rock', else -1. */
  index: number;
  collider?: Collider;
}

export interface RaycastOptions {
  /** Collider layer mask (default HITTABLE). */
  mask?: number;
  terrain?: boolean;
  trees?: boolean;
  rocks?: boolean;
  /** Colliders to skip (e.g. the shooter). */
  ignore?: Collider | ((c: Collider) => boolean);
}

export interface GroundHit {
  y: number;
  normal: THREE.Vector3;
  kind: 'terrain' | 'rock' | 'collider';
  collider?: Collider;
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _lo = new THREE.Vector3();
const _ld = new THREE.Vector3();

export class Physics {
  private colliders: Collider[] = [];
  private nextId = 1;

  constructor(private terrain: Terrain, private world: World) {}

  // ---------------------------------------------------------------- registry
  private make(shape: ShapeType, layers: number, owner?: unknown, tag?: string): Collider {
    return {
      id: this.nextId++,
      shape,
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      half: new THREE.Vector3(0.5, 0.5, 0.5),
      radius: 0.5,
      height: 1,
      layers,
      enabled: true,
      owner,
      tag,
      min: new THREE.Vector3(),
      max: new THREE.Vector3(),
    };
  }

  addBox(center: THREE.Vector3, half: THREE.Vector3, quat: THREE.Quaternion, layers: number, owner?: unknown, tag?: string): Collider {
    const c = this.make('box', layers, owner, tag);
    c.position.copy(center);
    c.half.copy(half);
    c.quaternion.copy(quat);
    this.colliders.push(c);
    this.updateCollider(c);
    return c;
  }

  addSphere(center: THREE.Vector3, radius: number, layers: number, owner?: unknown, tag?: string): Collider {
    const c = this.make('sphere', layers, owner, tag);
    c.position.copy(center);
    c.radius = radius;
    this.colliders.push(c);
    this.updateCollider(c);
    return c;
  }

  /** Vertical capsule with its base (feet) at `base`. */
  addCapsule(base: THREE.Vector3, radius: number, height: number, layers: number, owner?: unknown, tag?: string): Collider {
    const c = this.make('capsule', layers, owner, tag);
    c.position.copy(base);
    c.radius = radius;
    c.height = Math.max(height, radius * 2);
    this.colliders.push(c);
    this.updateCollider(c);
    return c;
  }

  remove(c: Collider) {
    const i = this.colliders.indexOf(c);
    if (i >= 0) this.colliders.splice(i, 1);
  }

  /** Call after moving/rotating a collider. */
  updateCollider(c: Collider) {
    if (c.shape === 'sphere') {
      c.min.set(c.position.x - c.radius, c.position.y - c.radius, c.position.z - c.radius);
      c.max.set(c.position.x + c.radius, c.position.y + c.radius, c.position.z + c.radius);
    } else if (c.shape === 'capsule') {
      c.min.set(c.position.x - c.radius, c.position.y, c.position.z - c.radius);
      c.max.set(c.position.x + c.radius, c.position.y + c.height, c.position.z + c.radius);
    } else {
      // AABB of an OBB: |R| * half
      const m = new THREE.Matrix4().makeRotationFromQuaternion(c.quaternion).elements;
      const hx = Math.abs(m[0]) * c.half.x + Math.abs(m[4]) * c.half.y + Math.abs(m[8]) * c.half.z;
      const hy = Math.abs(m[1]) * c.half.x + Math.abs(m[5]) * c.half.y + Math.abs(m[9]) * c.half.z;
      const hz = Math.abs(m[2]) * c.half.x + Math.abs(m[6]) * c.half.y + Math.abs(m[10]) * c.half.z;
      c.min.set(c.position.x - hx, c.position.y - hy, c.position.z - hz);
      c.max.set(c.position.x + hx, c.position.y + hy, c.position.z + hz);
    }
  }

  all(): readonly Collider[] {
    return this.colliders;
  }

  // ---------------------------------------------------------------- raycast
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, opts: RaycastOptions = {}): RayHit | null {
    const mask = opts.mask ?? Layer.HITTABLE;
    let best: RayHit | null = null;
    let bestD = maxDist;

    if (opts.terrain !== false) {
      const th = this.terrain.raycast(origin, dir, bestD);
      if (th && th.distance < bestD) {
        bestD = th.distance;
        best = { kind: 'terrain', distance: th.distance, point: th.point, normal: th.normal, index: -1 };
      }
    }

    if (opts.trees !== false || opts.rocks !== false) {
      // Walk the 2D grid cells the ray passes over (DDA).
      const w = this.world;
      const g = w.gridCell;
      const half = this.terrain.half;
      const visitCell = (cx: number, cz: number) => {
        const x = -half + (cx + 0.5) * g,
          z = -half + (cz + 0.5) * g;
        if (opts.trees !== false) {
          w.forEachTree(x, z, g * 0.75, (i) => {
            const d = rayCylinder(origin, dir, w.treeX[i], w.treeY[i] - 0.5, w.treeZ[i], w.treeRadius(i), w.treeHeight(i) * 0.9);
            if (d >= 0 && d < bestD) {
              bestD = d;
              const p = origin.clone().addScaledVector(dir, d);
              const n = new THREE.Vector3(p.x - w.treeX[i], 0, p.z - w.treeZ[i]).normalize();
              best = { kind: 'tree', distance: d, point: p, normal: n, index: i };
            }
          });
        }
        if (opts.rocks !== false) {
          w.forEachRock(x, z, g * 0.75, (i) => {
            _v.set(w.rockX[i], w.rockY[i], w.rockZ[i]);
            const d = raySphere(origin, dir, _v, w.rockR[i] * 0.95);
            if (d >= 0 && d < bestD) {
              bestD = d;
              const p = origin.clone().addScaledVector(dir, d);
              best = { kind: 'rock', distance: d, point: p, normal: p.clone().sub(_v).normalize(), index: i };
            }
          });
        }
      };
      ddaCells(origin.x + half, origin.z + half, dir.x, dir.z, bestD, g, visitCell);
    }

    for (const c of this.colliders) {
      if (!c.enabled || (c.layers & mask) === 0) continue;
      if (opts.ignore && (typeof opts.ignore === 'function' ? opts.ignore(c) : opts.ignore === c)) continue;
      if (!rayAabb(origin, dir, c.min, c.max, bestD)) continue;
      const h = this.rayCollider(origin, dir, c, bestD);
      if (h && h.distance < bestD) {
        bestD = h.distance;
        best = h;
      }
    }
    return best;
  }

  private rayCollider(o: THREE.Vector3, d: THREE.Vector3, c: Collider, maxD: number): RayHit | null {
    if (c.shape === 'sphere') {
      const t = raySphere(o, d, c.position, c.radius);
      if (t < 0 || t > maxD) return null;
      const p = o.clone().addScaledVector(d, t);
      return { kind: 'collider', distance: t, point: p, normal: p.clone().sub(c.position).normalize(), index: -1, collider: c };
    }
    if (c.shape === 'capsule') {
      const a = _v.set(c.position.x, c.position.y + c.radius, c.position.z);
      const b = _v2.set(c.position.x, c.position.y + c.height - c.radius, c.position.z);
      const t = rayCapsule(o, d, a, b, c.radius);
      if (t < 0 || t > maxD) return null;
      const p = o.clone().addScaledVector(d, t);
      const axisY = clamp(p.y, a.y, b.y);
      const n = new THREE.Vector3(p.x - c.position.x, p.y - axisY, p.z - c.position.z).normalize();
      return { kind: 'collider', distance: t, point: p, normal: n, index: -1, collider: c };
    }
    // Oriented box: go to local space.
    _q.copy(c.quaternion).invert();
    _lo.copy(o).sub(c.position).applyQuaternion(_q);
    _ld.copy(d).applyQuaternion(_q);
    const h = c.half;
    let tmin = 0,
      tmax = maxD,
      axis = -1,
      sign = 1;
    for (let k = 0; k < 3; k++) {
      const oo = k === 0 ? _lo.x : k === 1 ? _lo.y : _lo.z;
      const dd = k === 0 ? _ld.x : k === 1 ? _ld.y : _ld.z;
      const hh = k === 0 ? h.x : k === 1 ? h.y : h.z;
      if (Math.abs(dd) < 1e-9) {
        if (oo < -hh || oo > hh) return null;
        continue;
      }
      let t1 = (-hh - oo) / dd,
        t2 = (hh - oo) / dd;
      let s = -1;
      if (t1 > t2) {
        const tt = t1;
        t1 = t2;
        t2 = tt;
        s = 1;
      }
      if (t1 > tmin) {
        tmin = t1;
        axis = k;
        sign = s;
      }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
    if (axis < 0) return null; // origin inside the box
    const n = new THREE.Vector3(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0).applyQuaternion(c.quaternion);
    return { kind: 'collider', distance: tmin, point: o.clone().addScaledVector(d, tmin), normal: n, index: -1, collider: c };
  }

  // ---------------------------------------------------------------- overlap
  /** Colliders (matching mask) overlapping a sphere. */
  overlapSphere(center: THREE.Vector3, r: number, mask: number, out: Collider[] = []): Collider[] {
    for (const c of this.colliders) {
      if (!c.enabled || (c.layers & mask) === 0) continue;
      if (center.x + r < c.min.x || center.x - r > c.max.x || center.y + r < c.min.y || center.y - r > c.max.y || center.z + r < c.min.z || center.z - r > c.max.z) continue;
      if (this.sphereVsCollider(center, r, c, _v3) !== null) out.push(c);
    }
    return out;
  }

  /**
   * If the sphere penetrates the collider, returns penetration depth and writes the push-out
   * direction (unit) into outNormal. Otherwise null.
   */
  sphereVsCollider(center: THREE.Vector3, r: number, c: Collider, outNormal: THREE.Vector3): number | null {
    if (c.shape === 'sphere') {
      outNormal.copy(center).sub(c.position);
      const d = outNormal.length();
      if (d >= r + c.radius) return null;
      if (d < 1e-6) outNormal.set(0, 1, 0);
      else outNormal.divideScalar(d);
      return r + c.radius - d;
    }
    if (c.shape === 'capsule') {
      const ay = c.position.y + c.radius,
        by = c.position.y + c.height - c.radius;
      const cy = clamp(center.y, ay, by);
      outNormal.set(center.x - c.position.x, center.y - cy, center.z - c.position.z);
      const d = outNormal.length();
      if (d >= r + c.radius) return null;
      if (d < 1e-6) outNormal.set(1, 0, 0);
      else outNormal.divideScalar(d);
      return r + c.radius - d;
    }
    _q.copy(c.quaternion).invert();
    _lo.copy(center).sub(c.position).applyQuaternion(_q);
    const h = c.half;
    const px = clamp(_lo.x, -h.x, h.x),
      py = clamp(_lo.y, -h.y, h.y),
      pz = clamp(_lo.z, -h.z, h.z);
    const dx = _lo.x - px,
      dy = _lo.y - py,
      dz = _lo.z - pz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > 1e-10) {
      if (d2 >= r * r) return null;
      const d = Math.sqrt(d2);
      outNormal.set(dx / d, dy / d, dz / d).applyQuaternion(c.quaternion);
      return r - d;
    }
    // Centre inside: push out along the axis of least penetration.
    const ox = h.x - Math.abs(_lo.x),
      oy = h.y - Math.abs(_lo.y),
      oz = h.z - Math.abs(_lo.z);
    if (ox <= oy && ox <= oz) outNormal.set(Math.sign(_lo.x) || 1, 0, 0);
    else if (oy <= oz) outNormal.set(0, Math.sign(_lo.y) || 1, 0);
    else outNormal.set(0, 0, Math.sign(_lo.z) || 1);
    outNormal.applyQuaternion(c.quaternion);
    return Math.min(ox, oy, oz) + r;
  }

  // ---------------------------------------------------------------- character
  /**
   * Push a vertical capsule (feet at `feet`) out of trees, boulders and SOLID colliders.
   * Modifies `feet` in place. Returns the contact normals (unit) so the caller can remove
   * velocity into walls and detect standing on boxes/boulders (normal.y > 0.6).
   */
  resolveCapsule(feet: THREE.Vector3, radius: number, height: number, mask: number = Layer.SOLID, contacts: THREE.Vector3[] = []): THREE.Vector3[] {
    const w = this.world;
    // Trees: 2D circle push.
    w.forEachTree(feet.x, feet.z, radius + 1.2, (i) => {
      const tr = w.treeRadius(i);
      const ty = w.treeY[i];
      if (feet.y > ty + w.treeHeight(i) * 0.8 || feet.y + height < ty - 1) return;
      const dx = feet.x - w.treeX[i],
        dz = feet.z - w.treeZ[i];
      const d = Math.hypot(dx, dz);
      const min = radius + tr;
      if (d < min) {
        const nx = d > 1e-5 ? dx / d : 1,
          nz = d > 1e-5 ? dz / d : 0;
        feet.x += nx * (min - d);
        feet.z += nz * (min - d);
        contacts.push(new THREE.Vector3(nx, 0, nz));
      }
    });
    // Sample spheres along the capsule for boulders and colliders.
    const samples = [radius, height * 0.5, height - radius];
    for (let iter = 0; iter < 2; iter++) {
      for (const sy of samples) {
        _v.set(feet.x, feet.y + sy, feet.z);
        w.forEachRock(feet.x, feet.z, radius + 0.5, (i) => {
          _v2.set(w.rockX[i], w.rockY[i], w.rockZ[i]);
          _v3.copy(_v).sub(_v2);
          const d = _v3.length();
          const min = radius + w.rockR[i] * 0.92;
          if (d < min && d > 1e-5) {
            _v3.divideScalar(d);
            feet.addScaledVector(_v3, min - d);
            _v.addScaledVector(_v3, min - d);
            contacts.push(_v3.clone());
          }
        });
        for (const c of this.colliders) {
          if (!c.enabled || (c.layers & mask) === 0) continue;
          if (_v.x + radius < c.min.x || _v.x - radius > c.max.x || _v.y + radius < c.min.y || _v.y - radius > c.max.y || _v.z + radius < c.min.z || _v.z - radius > c.max.z) continue;
          const n = new THREE.Vector3();
          const pen = this.sphereVsCollider(_v, radius, c, n);
          if (pen !== null && pen > 0) {
            // Mostly-horizontal walls push horizontally so the player doesn't climb them.
            if (Math.abs(n.y) < 0.6) {
              n.y = 0;
              n.normalize();
            }
            feet.addScaledVector(n, pen);
            _v.addScaledVector(n, pen);
            contacts.push(n);
          }
        }
      }
    }
    return contacts;
  }

  /**
   * Highest walkable surface under (x, z) starting at height `fromY` and looking down `maxDown`.
   * Considers terrain, boulders and WALKABLE colliders (floors, foundations, roofs).
   */
  groundProbe(x: number, fromY: number, z: number, maxDown = 50): GroundHit {
    const th = this.terrain.heightAt(x, z);
    let best: GroundHit = { y: th, normal: this.terrain.normalAt(x, z), kind: 'terrain' };
    const origin = _v.set(x, fromY, z);
    const down = _v2.set(0, -1, 0);
    // Boulders
    this.world.forEachRock(x, z, 0.1, (i) => {
      const w = this.world;
      const cx = w.rockX[i],
        cy = w.rockY[i],
        cz = w.rockZ[i],
        r = w.rockR[i] * 0.92;
      const dx = x - cx,
        dz = z - cz;
      const h2 = r * r - dx * dx - dz * dz;
      if (h2 <= 0) return;
      const top = cy + Math.sqrt(h2);
      if (top <= fromY + 0.01 && top > best.y) {
        best = { y: top, normal: new THREE.Vector3(dx, top - cy, dz).normalize(), kind: 'rock' };
      }
    });
    for (const c of this.colliders) {
      if (!c.enabled || (c.layers & Layer.WALKABLE) === 0) continue;
      if (x < c.min.x || x > c.max.x || z < c.min.z || z > c.max.z) continue;
      if (c.min.y > fromY + 0.01 || c.max.y < fromY - maxDown) continue;
      const h = this.rayCollider(origin, down, c, maxDown);
      if (h && h.normal.y > 0.35) {
        const y = fromY - h.distance;
        if (y > best.y) best = { y, normal: h.normal, kind: 'collider', collider: c };
      }
    }
    return best;
  }
}

// ------------------------------------------------------------------ helpers
function raySphere(o: THREE.Vector3, d: THREE.Vector3, c: THREE.Vector3, r: number): number {
  const ox = o.x - c.x,
    oy = o.y - c.y,
    oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const h = b * b - cc;
  if (h < 0) return -1;
  const t = -b - Math.sqrt(h);
  return t >= 0 ? t : cc < 0 ? 0 : -1;
}

/** Vertical cylinder [y0, y0+h] of radius r at (cx, cz). */
function rayCylinder(o: THREE.Vector3, d: THREE.Vector3, cx: number, y0: number, cz: number, r: number, h: number): number {
  const ox = o.x - cx,
    oz = o.z - cz;
  const a = d.x * d.x + d.z * d.z;
  if (a < 1e-10) return -1;
  const b = ox * d.x + oz * d.z;
  const c = ox * ox + oz * oz - r * r;
  const disc = b * b - a * c;
  if (disc < 0) return -1;
  let t = (-b - Math.sqrt(disc)) / a;
  if (t < 0) {
    if (c < 0) t = 0;
    else return -1;
  }
  const y = o.y + d.y * t;
  if (y < y0 || y > y0 + h) return -1;
  return t;
}

function rayCapsule(o: THREE.Vector3, d: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, r: number): number {
  // Inigo Quilez, capsule intersection.
  const ba = new THREE.Vector3().subVectors(b, a);
  const oa = new THREE.Vector3().subVectors(o, a);
  const baba = ba.dot(ba),
    bard = ba.dot(d),
    baoa = ba.dot(oa),
    rdoa = d.dot(oa),
    oaoa = oa.dot(oa);
  const aa = baba - bard * bard;
  let bb = baba * rdoa - baoa * bard;
  let cc = baba * oaoa - baoa * baoa - r * r * baba;
  let h = bb * bb - aa * cc;
  if (h >= 0) {
    const t = (-bb - Math.sqrt(h)) / aa;
    const y = baoa + t * bard;
    if (y > 0 && y < baba && t >= 0) return t;
    const oc = y <= 0 ? oa : new THREE.Vector3().subVectors(o, b);
    bb = d.dot(oc);
    cc = oc.dot(oc) - r * r;
    h = bb * bb - cc;
    if (h > 0) {
      const t2 = -bb - Math.sqrt(h);
      if (t2 >= 0) return t2;
    }
  }
  return -1;
}

function rayAabb(o: THREE.Vector3, d: THREE.Vector3, min: THREE.Vector3, max: THREE.Vector3, maxD: number): boolean {
  let tmin = 0,
    tmax = maxD;
  for (let k = 0; k < 3; k++) {
    const oo = k === 0 ? o.x : k === 1 ? o.y : o.z;
    const dd = k === 0 ? d.x : k === 1 ? d.y : d.z;
    const lo = k === 0 ? min.x : k === 1 ? min.y : min.z;
    const hi = k === 0 ? max.x : k === 1 ? max.y : max.z;
    if (Math.abs(dd) < 1e-9) {
      if (oo < lo || oo > hi) return false;
      continue;
    }
    let t1 = (lo - oo) / dd,
      t2 = (hi - oo) / dd;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
    }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  return true;
}

/** Visit grid cells (in grid-local coords, origin at world min corner) along a 2D ray. */
function ddaCells(x: number, z: number, dx: number, dz: number, maxD: number, cell: number, visit: (cx: number, cz: number) => void) {
  const len = Math.hypot(dx, dz);
  let cx = Math.floor(x / cell),
    cz = Math.floor(z / cell);
  visit(cx, cz);
  if (len < 1e-6) return; // vertical ray: one cell is enough
  const ux = dx / len,
    uz = dz / len;
  const maxH = maxD * len; // horizontal distance travelled
  const stepX = ux > 0 ? 1 : -1,
    stepZ = uz > 0 ? 1 : -1;
  let tMaxX = ux !== 0 ? ((ux > 0 ? (cx + 1) * cell : cx * cell) - x) / ux : Infinity;
  let tMaxZ = uz !== 0 ? ((uz > 0 ? (cz + 1) * cell : cz * cell) - z) / uz : Infinity;
  const tDX = ux !== 0 ? cell / Math.abs(ux) : Infinity;
  const tDZ = uz !== 0 ? cell / Math.abs(uz) : Infinity;
  let guard = 0;
  while (Math.min(tMaxX, tMaxZ) <= maxH && guard++ < 4096) {
    if (tMaxX < tMaxZ) {
      cx += stepX;
      tMaxX += tDX;
    } else {
      cz += stepZ;
      tMaxZ += tDZ;
    }
    visit(cx, cz);
  }
}
