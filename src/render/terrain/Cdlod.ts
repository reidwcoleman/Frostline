// CDLOD quadtree selection (Strugar 2010). Nodes at level L are (MM_CELL << L) meters with 32x32
// quads; each is drawn as four 16x16-quad "patches" so a parent can draw just the quadrants its
// children don't cover. Vertices geomorph toward the parent grid inside each level's morph band,
// so neighbouring levels always meet exactly (no cracks, no popping).
import * as THREE from 'three';
import { EXT_HALF, MM_CELL, MM_DIM, MM_LEVELS, type TerrainGPU } from './TerrainGPU';

export const PATCH_QUADS = 16;
const NODE_QUADS = PATCH_QUADS * 2;

export class CdlodSelector {
  /** LOD sphere radius per level. */
  readonly ranges = new Float64Array(MM_LEVELS);
  /** Per level (morphStart, 1 / (morphEnd - morphStart)) for the shader. */
  readonly morph: THREE.Vector2[] = [];
  minLevel = 0;

  private cx = 0;
  private cy = 0;
  private cz = 0;
  private frustum: THREE.Frustum | null = null;
  private cullSphere = 0;
  private maxDist2 = Infinity;
  private out!: Float32Array;
  private count = 0;
  private cap = 0;

  constructor(private gpu: TerrainGPU) {
    for (let i = 0; i < MM_LEVELS; i++) this.morph.push(new THREE.Vector2());
    this.configure(6, 0);
  }

  /**
   * K = range / node size. K >= 6 keeps the 3D-distance morph bands of adjacent levels disjoint
   * even on steep ground (no cracks). minLevel 1 doubles the finest vertex spacing (low quality).
   */
  configure(K: number, minLevel: number) {
    this.minLevel = minLevel;
    const morphStart = 0.8;
    for (let l = 0; l < MM_LEVELS; l++) {
      const r = K * (MM_CELL << l);
      this.ranges[l] = r;
      const s = r * morphStart;
      this.morph[l].set(s, 1 / (r - s));
    }
  }

  /** Main view: frustum culled. Returns patch count; writes (x, z, spacing, level) quads. */
  selectView(cam: THREE.Vector3, frustum: THREE.Frustum, maxDist: number, out: Float32Array): number {
    this.frustum = frustum;
    this.cullSphere = 0;
    this.maxDist2 = maxDist * maxDist;
    return this.run(cam, out);
  }

  /** Shadow casters: everything within `radius` of the camera, regardless of view direction. */
  selectSphere(cam: THREE.Vector3, radius: number, out: Float32Array): number {
    this.frustum = null;
    this.cullSphere = radius;
    this.maxDist2 = Infinity;
    return this.run(cam, out);
  }

  private run(cam: THREE.Vector3, out: Float32Array) {
    this.cx = cam.x;
    this.cy = cam.y;
    this.cz = cam.z;
    this.out = out;
    this.cap = (out.length / 4) | 0;
    this.count = 0;
    this.node(MM_LEVELS - 1, 0, 0);
    return this.count;
  }

  private dist2(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
    const dx = this.cx < x0 ? x0 - this.cx : this.cx > x1 ? this.cx - x1 : 0;
    const dy = this.cy < y0 ? y0 - this.cy : this.cy > y1 ? this.cy - y1 : 0;
    const dz = this.cz < z0 ? z0 - this.cz : this.cz > z1 ? this.cz - z1 : 0;
    return dx * dx + dy * dy + dz * dz;
  }

  private readonly box = new THREE.Box3();
  private visible(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
    const d2 = this.dist2(x0, y0, z0, x1, y1, z1);
    if (this.frustum) {
      if (d2 > this.maxDist2) return false;
      this.box.min.set(x0, y0, z0);
      this.box.max.set(x1, y1, z1);
      return this.frustum.intersectsBox(this.box);
    }
    return d2 <= this.cullSphere * this.cullSphere;
  }

  private bounds(level: number, ix: number, iz: number): [number, number] {
    const mm = this.gpu.minMax[level];
    const dim = MM_DIM >> level;
    const o = (iz * dim + ix) * 2;
    return [mm[o], mm[o + 1]];
  }

  /** Returns false when the node is beyond its LOD range (the parent must draw its area). */
  private node(level: number, ix: number, iz: number): boolean {
    const S = MM_CELL << level;
    const x0 = -EXT_HALF + ix * S,
      z0 = -EXT_HALF + iz * S;
    const x1 = x0 + S,
      z1 = z0 + S;
    const [y0, y1] = this.bounds(level, ix, iz);
    const r = this.ranges[level];
    const d2 = this.dist2(x0, y0, z0, x1, y1, z1);
    if (d2 > r * r) return false;
    if (!this.visible(x0, y0, z0, x1, y1, z1)) return true;
    if (level === this.minLevel) {
      this.addQuadrants(level, ix, iz, x0, z0, S);
      return true;
    }
    const rc = this.ranges[level - 1];
    if (d2 > rc * rc) {
      this.addQuadrants(level, ix, iz, x0, z0, S);
      return true;
    }
    const h = S / 2;
    for (let q = 0; q < 4; q++) {
      const qx = q & 1,
        qz = q >> 1;
      const cix = ix * 2 + qx,
        ciz = iz * 2 + qz;
      if (!this.node(level - 1, cix, ciz)) {
        const [cy0, cy1] = this.bounds(level - 1, cix, ciz);
        const px = x0 + qx * h,
          pz = z0 + qz * h;
        if (this.visible(px, cy0, pz, px + h, cy1, pz + h)) this.emit(px, pz, S / NODE_QUADS, level);
      }
    }
    return true;
  }

  private addQuadrants(level: number, ix: number, iz: number, x0: number, z0: number, S: number) {
    const h = S / 2;
    const spacing = S / NODE_QUADS;
    for (let q = 0; q < 4; q++) {
      const qx = q & 1,
        qz = q >> 1;
      const px = x0 + qx * h,
        pz = z0 + qz * h;
      if (level > 0) {
        const [cy0, cy1] = this.bounds(level - 1, ix * 2 + qx, iz * 2 + qz);
        if (!this.visible(px, cy0, pz, px + h, cy1, pz + h)) continue;
      }
      this.emit(px, pz, spacing, level);
    }
  }

  private emit(x: number, z: number, spacing: number, level: number) {
    if (this.count >= this.cap) return;
    const o = this.count * 4;
    this.out[o] = x;
    this.out[o + 1] = z;
    this.out[o + 2] = spacing;
    this.out[o + 3] = level;
    this.count++;
  }
}

/** (PATCH_QUADS+1)^2 grid; position.xz = integer grid coords. Diagonals run (i,j)-(i+1,j+1) so a
 * fully morphed patch collapses exactly onto its parent's triangles. */
export function createPatchGeometry(capacity: number): { geometry: THREE.InstancedBufferGeometry; patches: THREE.InstancedBufferAttribute } {
  const n = PATCH_QUADS + 1;
  const pos = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const o = (j * n + i) * 3;
      pos[o] = i;
      pos[o + 1] = 0;
      pos[o + 2] = j;
    }
  const idx: number[] = [];
  for (let j = 0; j < PATCH_QUADS; j++)
    for (let i = 0; i < PATCH_QUADS; i++) {
      const a = j * n + i,
        b = a + 1,
        c = a + n,
        d = c + 1;
      // CCW seen from above (+y): a(i,j) -> d(i+1,j+1) -> b(i+1,j), and a -> c -> d.
      idx.push(a, d, b, a, c, d);
    }
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setIndex(idx);
  const patches = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  patches.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('aPatch', patches);
  geometry.instanceCount = 0;
  // Bounds are irrelevant (frustumCulled = false) but keep three happy.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), EXT_HALF * 2);
  geometry.boundingBox = new THREE.Box3(new THREE.Vector3(-EXT_HALF, -1000, -EXT_HALF), new THREE.Vector3(EXT_HALF, 5000, EXT_HALF));
  return { geometry, patches };
}
