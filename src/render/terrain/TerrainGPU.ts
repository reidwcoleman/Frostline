// GPU copies of the terrain data + CPU min/max pyramid for LOD culling.
//   heightTex  R32F    exact heightmap (texelFetch only) — vertex heights match Terrain.heightAt()
//   dataTex    RGBA16F height, dh/dx, dh/dz, cavity (m)  — mip-mapped, mirrored outside the world
//   maskTex    RGBA8   lake, flow, forest canopy, unused  — mip-mapped
//   permTex    R8      simplex permutation for the detail octaves
import * as THREE from 'three';
import type { Terrain } from '../../core/Terrain';
import type { World } from '../../core/World';
import { mulberry32, clamp } from '../../core/math';

/** Quadtree extent: the 4 km world plus a mirrored "far ring" so the horizon never ends. */
export const EXT_HALF = 8192;
/** Min/max grid cell size (m) == smallest quadtree node. */
export const MM_CELL = 32;
export const MM_DIM = (EXT_HALF * 2) / MM_CELL; // 512
export const MM_LEVELS = Math.log2(MM_DIM) + 1; // 10

export class TerrainGPU {
  readonly heightTex: THREE.DataTexture;
  readonly dataTex: THREE.DataTexture;
  readonly maskTex: THREE.DataTexture;
  readonly permTex: THREE.DataTexture;
  /** minMax[level] = Float32Array(dim*dim*2) of (min, max); level 0 = MM_CELL nodes. */
  readonly minMax: Float32Array[] = [];
  readonly res: number;
  /** Uniforms shared by every terrain-aware material (by reference). */
  readonly uniforms: {
    tHeightTex: THREE.IUniform<THREE.Texture>;
    tDataTex: THREE.IUniform<THREE.Texture>;
    tMaskTex: THREE.IUniform<THREE.Texture>;
    tPermTex: THREE.IUniform<THREE.Texture>;
    tDims: THREE.IUniform<THREE.Vector4>;
  };

  constructor(private terrain: Terrain, world: World, renderer: THREE.WebGLRenderer) {
    const t = terrain;
    const res = t.res;
    this.res = res;
    const H = t.heights;

    // ---- exact heights
    this.heightTex = new THREE.DataTexture(H, res, res, THREE.RedFormat, THREE.FloatType);
    this.heightTex.minFilter = this.heightTex.magFilter = THREE.NearestFilter;
    this.heightTex.generateMipmaps = false;
    this.heightTex.needsUpdate = true;

    // ---- slopes + cavity (half float, filterable)
    const blurA = boxBlur(H, res, 3);
    const blurB = boxBlur(H, res, 12);
    const data = new Uint16Array(res * res * 4);
    const toHalf = THREE.DataUtils.toHalfFloat;
    const inv2c = 1 / (2 * t.cell);
    for (let j = 0; j < res; j++) {
      const jm = j > 0 ? j - 1 : 0,
        jp = j < res - 1 ? j + 1 : res - 1;
      for (let i = 0; i < res; i++) {
        const im = i > 0 ? i - 1 : 0,
          ip = i < res - 1 ? i + 1 : res - 1;
        const k = j * res + i;
        const sx = (H[j * res + ip] - H[j * res + im]) * inv2c * (ip - im === 2 ? 1 : 2);
        const sz = (H[jp * res + i] - H[jm * res + i]) * inv2c * (jp - jm === 2 ? 1 : 2);
        const cav = (blurA[k] - H[k]) * 0.7 + (blurB[k] - H[k]) * 0.3;
        const o = k * 4;
        data[o] = toHalf(H[k]);
        data[o + 1] = toHalf(sx);
        data[o + 2] = toHalf(sz);
        data[o + 3] = toHalf(cav);
      }
    }
    this.dataTex = new THREE.DataTexture(data, res, res, THREE.RGBAFormat, THREE.HalfFloatType);
    this.dataTex.wrapS = this.dataTex.wrapT = THREE.MirroredRepeatWrapping;
    this.dataTex.minFilter = THREE.LinearMipmapLinearFilter;
    this.dataTex.magFilter = THREE.LinearFilter;
    this.dataTex.generateMipmaps = true;
    this.dataTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    this.dataTex.needsUpdate = true;

    // ---- masks
    const mask = new Uint8Array(res * res * 4);
    const forest = forestDensity(t, world);
    for (let k = 0; k < res * res; k++) {
      mask[k * 4] = t.data.lakeMask[k];
      mask[k * 4 + 1] = t.data.flow[k];
      mask[k * 4 + 2] = forest[k];
      mask[k * 4 + 3] = 255;
    }
    this.maskTex = new THREE.DataTexture(mask, res, res, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.maskTex.wrapS = this.maskTex.wrapT = THREE.MirroredRepeatWrapping;
    this.maskTex.minFilter = THREE.LinearMipmapLinearFilter;
    this.maskTex.magFilter = THREE.LinearFilter;
    this.maskTex.generateMipmaps = true;
    this.maskTex.anisotropy = this.dataTex.anisotropy;
    this.maskTex.needsUpdate = true;

    // ---- simplex permutation (same shuffle as core/noise.ts Simplex2 for Terrain.detailNoise)
    const perm = simplexPermutation(t.data.seed * 31 + 11);
    this.permTex = new THREE.DataTexture(perm, 256, 1, THREE.RedFormat, THREE.UnsignedByteType);
    this.permTex.minFilter = this.permTex.magFilter = THREE.NearestFilter;
    this.permTex.generateMipmaps = false;
    this.permTex.needsUpdate = true;

    this.uniforms = {
      tHeightTex: { value: this.heightTex },
      tDataTex: { value: this.dataTex },
      tMaskTex: { value: this.maskTex },
      tPermTex: { value: this.permTex },
      tDims: { value: new THREE.Vector4(t.half, t.cell, res - 1, 1 / t.cell) },
    };

    this.buildMinMax();
  }

  /** Min/max height of every quadtree node (mirrored outside the world), with a safety margin. */
  private buildMinMax() {
    const t = this.terrain;
    const res = this.res;
    const H = t.heights;
    const per = MM_CELL / t.cell; // grid samples per cell (8)
    const wc = t.size / MM_CELL; // world cells per side (128)
    // Per world cell min/max over its samples (+1 neighbour ring for bicubic overshoot).
    const cellMin = new Float32Array(wc * wc),
      cellMax = new Float32Array(wc * wc);
    for (let cj = 0; cj < wc; cj++)
      for (let ci = 0; ci < wc; ci++) {
        let mn = Infinity,
          mx = -Infinity;
        for (let j = cj * per - 1; j <= (cj + 1) * per + 1; j++)
          for (let i = ci * per - 1; i <= (ci + 1) * per + 1; i++) {
            const h = H[clamp(j, 0, res - 1) * res + clamp(i, 0, res - 1)];
            if (h < mn) mn = h;
            if (h > mx) mx = h;
          }
        cellMin[cj * wc + ci] = mn - 2;
        cellMax[cj * wc + ci] = mx + 2;
      }
    const off = (EXT_HALF - t.half) / MM_CELL; // extended cells before the world starts (192)
    const mirror = (c: number) => {
      const p = 2 * wc;
      let m = (((c - off) % p) + p) % p;
      return m >= wc ? p - 1 - m : m;
    };
    let dim = MM_DIM;
    const l0 = new Float32Array(dim * dim * 2);
    for (let j = 0; j < dim; j++) {
      const mj = mirror(j);
      for (let i = 0; i < dim; i++) {
        const k = mj * wc + mirror(i);
        l0[(j * dim + i) * 2] = cellMin[k];
        l0[(j * dim + i) * 2 + 1] = cellMax[k];
      }
    }
    this.minMax.push(l0);
    while (dim > 1) {
      const prev = this.minMax[this.minMax.length - 1];
      const nd = dim >> 1;
      const cur = new Float32Array(nd * nd * 2);
      for (let j = 0; j < nd; j++)
        for (let i = 0; i < nd; i++) {
          let mn = Infinity,
            mx = -Infinity;
          for (let q = 0; q < 4; q++) {
            const pi = i * 2 + (q & 1),
              pj = j * 2 + (q >> 1);
            const o = (pj * dim + pi) * 2;
            if (prev[o] < mn) mn = prev[o];
            if (prev[o + 1] > mx) mx = prev[o + 1];
          }
          cur[(j * nd + i) * 2] = mn;
          cur[(j * nd + i) * 2 + 1] = mx;
        }
      this.minMax.push(cur);
      dim = nd;
    }
  }

  /** Update the forest-canopy mask texel(s) around a removed tree (under-canopy shading). */
  clearForestAt(x: number, z: number) {
    const t = this.terrain;
    const i = Math.round((x + t.half) / t.cell),
      j = Math.round((z + t.half) / t.cell);
    const img = this.maskTex.image.data as Uint8Array;
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        const ii = i + di,
          jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= this.res || jj >= this.res) continue;
        const o = (jj * this.res + ii) * 4 + 2;
        img[o] = Math.max(0, img[o] - (di === 0 && dj === 0 ? 90 : 35));
      }
    this.maskTex.needsUpdate = true;
  }

  dispose() {
    this.heightTex.dispose();
    this.dataTex.dispose();
    this.maskTex.dispose();
    this.permTex.dispose();
  }
}

/** Separable box blur (radius r) with clamped edges, via running sums. */
function boxBlur(src: Float32Array, res: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const w = 2 * r + 1;
  for (let j = 0; j < res; j++) {
    const row = j * res;
    let s = 0;
    for (let i = -r; i <= r; i++) s += src[row + clamp(i, 0, res - 1)];
    for (let i = 0; i < res; i++) {
      tmp[row + i] = s / w;
      s += src[row + Math.min(res - 1, i + r + 1)] - src[row + Math.max(0, i - r)];
    }
  }
  for (let i = 0; i < res; i++) {
    let s = 0;
    for (let j = -r; j <= r; j++) s += tmp[clamp(j, 0, res - 1) * res + i];
    for (let j = 0; j < res; j++) {
      out[j * res + i] = s / w;
      s += tmp[Math.min(res - 1, j + r + 1) * res + i] - tmp[Math.max(0, j - r) * res + i];
    }
  }
  return out;
}

/** Tree canopy density per heightmap texel (blurred splat of every tree's crown). */
function forestDensity(t: Terrain, w: World): Uint8Array {
  const res = t.res;
  const acc = new Float32Array(res * res);
  for (let k = 0; k < w.treeCount; k++) {
    const i = Math.round((w.treeX[k] + t.half) / t.cell),
      j = Math.round((w.treeZ[k] + t.half) / t.cell);
    if (i < 0 || j < 0 || i >= res || j >= res) continue;
    acc[j * res + i] += w.treeType[k] === 2 ? 0.35 : 1;
  }
  const b = boxBlur(acc, res, 1);
  const out = new Uint8Array(res * res);
  for (let k = 0; k < out.length; k++) out[k] = Math.min(255, Math.round(b[k] * 255 * 1.6));
  return out;
}

/** Replica of Simplex2's permutation shuffle (core/noise.ts). */
export function simplexPermutation(seed: number): Uint8Array {
  const rng = mulberry32(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }
  return p;
}
