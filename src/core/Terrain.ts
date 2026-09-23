// Runtime terrain sampler: THE single source of truth for ground height.
// Physics, rendering (mesh vertices), placement and AI all call heightAt().
import * as THREE from 'three';
import type { TerrainData } from '../world/TerrainGen';
import { Simplex2 } from './noise';
import { clamp } from './math';

export type SurfaceKind = 'snow' | 'ice' | 'rock' | 'wood';

export interface TerrainRayHit {
  distance: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
}

const _n = new THREE.Vector3();

export class Terrain {
  readonly data: TerrainData;
  readonly size: number;
  readonly res: number;
  readonly cell: number;
  readonly half: number;
  readonly heights: Float32Array;
  readonly lakeLevel: number;
  private detailNoise: Simplex2;

  constructor(data: TerrainData) {
    this.data = data;
    this.size = data.size;
    this.res = data.res;
    this.cell = data.cell;
    this.half = data.size / 2;
    this.heights = data.heights;
    this.lakeLevel = data.lakeLevel;
    this.detailNoise = new Simplex2(data.seed * 31 + 11);
  }

  /** Raw heightmap sample at integer grid coords (clamped). */
  sampleGrid(i: number, j: number): number {
    const r = this.res - 1;
    i = i < 0 ? 0 : i > r ? r : i;
    j = j < 0 ? 0 : j > r ? r : j;
    return this.heights[j * this.res + i];
  }

  /** Smooth (Catmull-Rom bicubic) heightmap without micro detail. */
  baseHeight(x: number, z: number): number {
    const gx = (x + this.half) / this.cell;
    const gz = (z + this.half) / this.cell;
    const ix = Math.floor(gx),
      iz = Math.floor(gz);
    const fx = gx - ix,
      fz = gz - iz;
    const r0 = cubic(this.sampleGrid(ix - 1, iz - 1), this.sampleGrid(ix, iz - 1), this.sampleGrid(ix + 1, iz - 1), this.sampleGrid(ix + 2, iz - 1), fx);
    const r1 = cubic(this.sampleGrid(ix - 1, iz), this.sampleGrid(ix, iz), this.sampleGrid(ix + 1, iz), this.sampleGrid(ix + 2, iz), fx);
    const r2 = cubic(this.sampleGrid(ix - 1, iz + 1), this.sampleGrid(ix, iz + 1), this.sampleGrid(ix + 1, iz + 1), this.sampleGrid(ix + 2, iz + 1), fx);
    const r3 = cubic(this.sampleGrid(ix - 1, iz + 2), this.sampleGrid(ix, iz + 2), this.sampleGrid(ix + 1, iz + 2), this.sampleGrid(ix + 2, iz + 2), fx);
    return cubic(r0, r1, r2, r3, fz);
  }

  /** Bilinear sample of a Uint8 mask (0..1). */
  private mask(arr: Uint8Array, x: number, z: number): number {
    const gx = clamp((x + this.half) / this.cell, 0, this.res - 1.001);
    const gz = clamp((z + this.half) / this.cell, 0, this.res - 1.001);
    const ix = gx | 0,
      iz = gz | 0;
    const fx = gx - ix,
      fz = gz - iz;
    const k = iz * this.res + ix;
    const a = arr[k],
      b = arr[k + 1],
      c = arr[k + this.res],
      d = arr[k + this.res + 1];
    return ((a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz) / 255;
  }

  /** 0..1, 1 = on the frozen lake. */
  lakeFactor(x: number, z: number): number {
    return this.mask(this.data.lakeMask, x, z);
  }

  /** 0..1 log drainage; high in gullies and creek beds. */
  flowAt(x: number, z: number): number {
    return this.mask(this.data.flow, x, z);
  }

  /** Small-scale bumps (meters). Zero on the ice. */
  detail(x: number, z: number): number {
    const lake = this.lakeFactor(x, z);
    if (lake >= 0.999) return 0;
    const n = this.detailNoise;
    const d = 0.55 * n.noise(x * 0.045, z * 0.045) + 0.2 * n.noise(x * 0.13 + 7.1, z * 0.13 - 3.3);
    return d * (1 - lake);
  }

  /** Final ground height in meters at world (x, z). */
  heightAt(x: number, z: number): number {
    return this.baseHeight(x, z) + this.detail(x, z);
  }

  /** Unit surface normal at (x, z). */
  normalAt(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    const e = 0.6;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }

  /** Slope angle in radians (0 = flat). */
  slopeAngle(x: number, z: number): number {
    this.normalAt(x, z, _n);
    return Math.acos(clamp(_n.y, -1, 1));
  }

  surfaceAt(x: number, z: number): SurfaceKind {
    if (this.lakeFactor(x, z) > 0.5) return 'ice';
    if (this.slopeAngle(x, z) > 0.78) return 'rock';
    return 'snow';
  }

  /** Is (x, z) inside the playable area (with margin in meters)? */
  inBounds(x: number, z: number, margin = 0): boolean {
    const h = this.half - margin;
    return x > -h && x < h && z > -h && z < h;
  }

  /** March a ray against the heightfield. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): TerrainRayHit | null {
    let t = 0,
      prevT = 0;
    const ox = origin.x,
      oy = origin.y,
      oz = origin.z;
    const dx = dir.x,
      dy = dir.y,
      dz = dir.z;
    let above = oy - this.heightAt(ox, oz);
    if (above < 0) return { distance: 0, point: origin.clone(), normal: this.normalAt(ox, oz) };
    while (t < maxDist) {
      prevT = t;
      t += clamp(above * 0.45, 0.15, 30);
      if (t > maxDist) t = maxDist;
      const x = ox + dx * t,
        y = oy + dy * t,
        z = oz + dz * t;
      above = y - this.heightAt(x, z);
      if (above <= 0) {
        let lo = prevT,
          hi = t;
        for (let i = 0; i < 12; i++) {
          const mid = (lo + hi) * 0.5;
          const my = oy + dy * mid;
          if (my - this.heightAt(ox + dx * mid, oz + dz * mid) > 0) lo = mid;
          else hi = mid;
        }
        const p = new THREE.Vector3(ox + dx * hi, oy + dy * hi, oz + dz * hi);
        return { distance: hi, point: p, normal: this.normalAt(p.x, p.z) };
      }
      if (t >= maxDist) break;
    }
    return null;
  }
}

function cubic(p0: number, p1: number, p2: number, p3: number, t: number) {
  return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
}
