// Tiling noise texture shared by the sky clouds, cloud shadows, aurora, moon and frost.
// R: billowy fbm (period 4)   G: fbm (period 8, other seed)   B: inverted cellular (puffs)   A: fine fbm
import * as THREE from 'three';
import { mulberry32 } from '../core/math';

const SIZE = 256;

class PeriodicPerlin {
  private gx: Float32Array;
  private gy: Float32Array;
  constructor(private period: number, seed: number) {
    const rng = mulberry32(seed);
    const n = period * period;
    this.gx = new Float32Array(n);
    this.gy = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2;
      this.gx[i] = Math.cos(a);
      this.gy[i] = Math.sin(a);
    }
  }
  /** x,y in lattice units; result ~[-0.7, 0.7]. */
  noise(x: number, y: number): number {
    const p = this.period;
    const x0 = Math.floor(x),
      y0 = Math.floor(y);
    const fx = x - x0,
      fy = y - y0;
    const ix0 = ((x0 % p) + p) % p,
      iy0 = ((y0 % p) + p) % p;
    const ix1 = (ix0 + 1) % p,
      iy1 = (iy0 + 1) % p;
    const dot = (ix: number, iy: number, dx: number, dy: number) => {
      const k = iy * p + ix;
      return this.gx[k] * dx + this.gy[k] * dy;
    };
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const a = dot(ix0, iy0, fx, fy);
    const b = dot(ix1, iy0, fx - 1, fy);
    const c = dot(ix0, iy1, fx, fy - 1);
    const d = dot(ix1, iy1, fx - 1, fy - 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
}

function fbm(noises: PeriodicPerlin[], u: number, v: number, base: number, octaves: number, gain = 0.5): number {
  let sum = 0,
    amp = 0.5,
    norm = 0,
    f = base;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noises[o].noise(u * f, v * f);
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

/** Tiling Worley F1 with `cells` cells per side. */
function worley(u: number, v: number, cells: number, pts: Float32Array): number {
  const x = u * cells,
    y = v * cells;
  const cx = Math.floor(x),
    cy = Math.floor(y);
  let best = 9;
  for (let j = -1; j <= 1; j++)
    for (let i = -1; i <= 1; i++) {
      const gx = cx + i,
        gy = cy + j;
      const wx = ((gx % cells) + cells) % cells,
        wy = ((gy % cells) + cells) % cells;
      const k = (wy * cells + wx) * 2;
      const dx = gx + pts[k] - x,
        dy = gy + pts[k + 1] - y;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
  return Math.sqrt(best);
}

export function createCloudNoise(seed = 7): THREE.DataTexture {
  const data = new Uint8Array(SIZE * SIZE * 4);
  const mk = (s: number, base: number, oct: number) => {
    const arr: PeriodicPerlin[] = [];
    for (let o = 0; o < oct; o++) arr.push(new PeriodicPerlin(base << o, seed * 97 + s * 13 + o));
    return arr;
  };
  const nR = mk(1, 4, 6),
    nG = mk(2, 8, 5),
    nA = mk(3, 16, 4);
  const cells = 12;
  const rng = mulberry32(seed + 1234);
  const pts = new Float32Array(cells * cells * 2);
  for (let i = 0; i < pts.length; i++) pts[i] = rng();
  const cells2 = 24;
  const pts2 = new Float32Array(cells2 * cells2 * 2);
  for (let i = 0; i < pts2.length; i++) pts2[i] = rng();

  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE,
        v = y / SIZE;
      const r = fbm(nR, u, v, 4, 6, 0.52); // frequency == lattice period so it tiles
      const g = fbm(nG, u, v, 8, 5, 0.5);
      const w = 1 - Math.min(1, worley(u, v, cells, pts) * 1.35);
      const w2 = 1 - Math.min(1, worley(u, v, cells2, pts2) * 1.35);
      const a = fbm(nA, u, v, 16, 4, 0.55);
      const k = (y * SIZE + x) * 4;
      data[k] = clampByte((r * 0.5 + 0.5) * 255 * 1.0 + (r > 0 ? 0 : 0));
      data[k + 1] = clampByte((g * 0.5 + 0.5) * 255);
      data[k + 2] = clampByte((w * 0.65 + w2 * 0.35) * 255);
      data[k + 3] = clampByte((a * 0.5 + 0.5) * 255);
    }
  // Stretch contrast per channel so every channel spans ~0..1.
  for (let c = 0; c < 4; c++) {
    let mn = 255,
      mx = 0;
    for (let i = c; i < data.length; i += 4) {
      if (data[i] < mn) mn = data[i];
      if (data[i] > mx) mx = data[i];
    }
    const s = 255 / Math.max(1, mx - mn);
    for (let i = c; i < data.length; i += 4) data[i] = clampByte((data[i] - mn) * s);
  }
  const tex = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function clampByte(v: number) {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}
