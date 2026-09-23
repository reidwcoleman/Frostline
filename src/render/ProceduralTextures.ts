// Small tileable textures generated at boot (no downloads). All are mip-mapped so high-frequency
// detail fades out naturally with distance instead of aliasing.
import * as THREE from 'three';
import { hash2 } from '../core/math';

/** Periodic lattice value noise with quintic fade; tiles every `period` lattice cells. */
class PeriodicNoise {
  constructor(private seed: number) {}
  private h(i: number, j: number) {
    return hash2(i, j, this.seed) * 2 - 1;
  }
  /** x,y in lattice units; px/py period in lattice units. Returns ~[-1,1]. */
  noise(x: number, y: number, px: number, py: number) {
    const xi = Math.floor(x),
      yi = Math.floor(y);
    const fx = x - xi,
      fy = y - yi;
    const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const i0 = ((xi % px) + px) % px,
      j0 = ((yi % py) + py) % py;
    const i1 = (i0 + 1) % px,
      j1 = (j0 + 1) % py;
    const a = this.h(i0, j0),
      b = this.h(i1, j0),
      c = this.h(i0, j1),
      d = this.h(i1, j1);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  }
  /** fbm over [0,1)^2 tiles; base period in cells. */
  fbm(u: number, v: number, period: number, octaves: number, gain = 0.5, periodY = period) {
    let s = 0,
      a = 1,
      n = 0,
      p = period,
      py = periodY;
    for (let o = 0; o < octaves; o++) {
      s += a * this.noise(u * p + o * 7.3, v * py + o * 3.1, p, py);
      n += a;
      a *= gain;
      p *= 2;
      py *= 2;
    }
    return s / n;
  }
}

/** Periodic cellular (Worley) noise: returns [F1, F2] distances in cell units. */
function worley(u: number, v: number, cells: number, seed: number, out: number[]) {
  let id = 0;
  const x = u * cells,
    y = v * cells;
  const xi = Math.floor(x),
    yi = Math.floor(y);
  let f1 = 9,
    f2 = 9;
  for (let j = -1; j <= 1; j++)
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i,
        cy = yi + j;
      const wx = ((cx % cells) + cells) % cells,
        wy = ((cy % cells) + cells) % cells;
      const px = cx + hash2(wx, wy, seed),
        py = cy + hash2(wx, wy, seed + 1);
      const d = Math.hypot(px - x, py - y);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = hash2(wx, wy, seed + 2);
      } else if (d < f2) f2 = d;
    }
  out[0] = f1;
  out[1] = f2;
  out[2] = id;
  return out;
}

function makeTex(data: Uint8Array, size: number, anisotropy: number): THREE.DataTexture {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = anisotropy;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

const enc = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));

export interface WorldTextures {
  /** RGBA: fbm A, fbm B, cellular edges, fine grain. 256px tile. */
  noise: THREE.DataTexture;
  /** RGBA: slope x, slope y (encoded /4 + .5), height, sastrugi mask. Tile = SNOW_TILE meters. */
  snow: THREE.DataTexture;
  /** RGBA: slope x, slope y (encoded /4 + .5), height, albedo variation. */
  rock: THREE.DataTexture;
}

export const SNOW_TILE = 6; // meters per snow micro-relief tile

export function createWorldTextures(renderer: THREE.WebGLRenderer): WorldTextures {
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return { noise: noiseTexture(aniso), snow: snowTexture(aniso), rock: rockTexture(aniso) };
}

function noiseTexture(aniso: number) {
  const S = 256;
  const n1 = new PeriodicNoise(11),
    n2 = new PeriodicNoise(23),
    n3 = new PeriodicNoise(37);
  const d = new Uint8Array(S * S * 4);
  const w = [0, 0, 0];
  for (let j = 0; j < S; j++)
    for (let i = 0; i < S; i++) {
      const u = i / S,
        v = j / S;
      const o = (j * S + i) * 4;
      d[o] = enc(n1.fbm(u, v, 4, 5) * 0.5 + 0.5);
      d[o + 1] = enc(n2.fbm(u, v, 8, 4) * 0.5 + 0.5);
      worley(u, v, 8, 991, w);
      d[o + 2] = enc(Math.min(1, (w[1] - w[0]) * 1.4));
      d[o + 3] = enc(n3.fbm(u, v, 32, 3) * 0.5 + 0.5);
    }
  return makeTex(d, S, aniso);
}

/** Wind-sculpted snow: asymmetric ripples across the wind, sastrugi along it, soft pits. */
function snowTexture(aniso: number) {
  const S = 512;
  const nA = new PeriodicNoise(101),
    nB = new PeriodicNoise(202),
    nC = new PeriodicNoise(303);
  const H = new Float32Array(S * S);
  const M = new Float32Array(S * S);
  const texel = SNOW_TILE / S; // meters
  for (let j = 0; j < S; j++)
    for (let i = 0; i < S; i++) {
      const u = i / S,
        v = j / S;
      // Ripples: crests perpendicular to the wind (wind along +u). ~0.3 m wavelength.
      const warp = nA.fbm(u, v, 3, 3) * 1.6 + nB.fbm(u, v, 6, 2) * 0.35;
      const s = (u * 20 + warp) % 1;
      const sf = s < 0 ? s + 1 : s;
      const ripple = sf < 0.78 ? smooth(sf / 0.78) : 1 - smooth((sf - 0.78) / 0.22);
      const rippleAmp = Math.max(0, nC.fbm(u, v, 2, 2) * 0.9 + 0.35);
      // Sastrugi: elongated along the wind, sharp-crested.
      const sast = 1 - Math.abs(nB.fbm(u, v, 2, 3, 0.5, 7));
      const sastH = Math.pow(Math.max(0, sast - 0.35) / 0.65, 2.2);
      // Pits and lumps.
      const lumps = nA.fbm(u + 0.37, v + 0.71, 12, 3);
      const h = ripple * 0.009 * rippleAmp + sastH * 0.05 + lumps * 0.006;
      H[j * S + i] = h;
      M[j * S + i] = sastH;
    }
  const d = new Uint8Array(S * S * 4);
  let maxH = 0;
  for (let k = 0; k < H.length; k++) maxH = Math.max(maxH, H[k]);
  for (let j = 0; j < S; j++)
    for (let i = 0; i < S; i++) {
      const ip = (i + 1) % S,
        im = (i + S - 1) % S,
        jp = (j + 1) % S,
        jm = (j + S - 1) % S;
      const sx = (H[j * S + ip] - H[j * S + im]) / (2 * texel);
      const sy = (H[jp * S + i] - H[jm * S + i]) / (2 * texel);
      const o = (j * S + i) * 4;
      d[o] = enc(sx / 4 + 0.5);
      d[o + 1] = enc(sy / 4 + 0.5);
      d[o + 2] = enc(H[j * S + i] / maxH);
      d[o + 3] = enc(M[j * S + i]);
    }
  return makeTex(d, S, aniso);
}

/** Fractured alpine rock: angular plates at different depths split by dark joints, plus grain. */
function rockTexture(aniso: number) {
  const S = 512;
  const nA = new PeriodicNoise(501),
    nB = new PeriodicNoise(602);
  const H = new Float32Array(S * S);
  const A = new Float32Array(S * S);
  const w = [0, 0, 0],
    w2 = [0, 0, 0];
  const texel = 8 / S;
  for (let j = 0; j < S; j++)
    for (let i = 0; i < S; i++) {
      const u = i / S,
        v = j / S;
      // Joints are stretched vertically (v) like columnar/bedded rock.
      worley(u, v, 5, 7771, w);
      worley(u + nA.fbm(u, v, 4, 2) * 0.02, v, 13, 9127, w2);
      const e1 = Math.min(1, (w[1] - w[0]) * 7); // 0 in joints
      const e2 = Math.min(1, (w2[1] - w2[0]) * 9);
      const plate = w[2] * 0.6 + w2[2] * 0.25; // each plate sits at its own depth
      const tilt = (u * 5 - Math.floor(u * 5)) * 0.08 * (w[2] - 0.5);
      const ridged = 1 - Math.abs(nA.fbm(u, v, 6, 4));
      const grain = nB.fbm(u, v, 40, 2);
      const h = plate + tilt + 0.08 * ridged + 0.02 * grain - 0.35 * (1 - smooth(e1)) - 0.12 * (1 - smooth(e2));
      H[j * S + i] = h;
      A[j * S + i] = 0.45 + 0.35 * w[2] + 0.12 * nB.fbm(u, v, 3, 3) + grain * 0.1 - 0.25 * (1 - smooth(e1));
    }
  let minH = Infinity,
    maxH = -Infinity;
  for (let k = 0; k < H.length; k++) {
    minH = Math.min(minH, H[k]);
    maxH = Math.max(maxH, H[k]);
  }
  const d = new Uint8Array(S * S * 4);
  const amp = 0.35; // metres of relief across the plates
  for (let j = 0; j < S; j++)
    for (let i = 0; i < S; i++) {
      const ip = (i + 1) % S,
        im = (i + S - 1) % S,
        jp = (j + 1) % S,
        jm = (j + S - 1) % S;
      const k = (h: number) => ((h - minH) / (maxH - minH)) * amp;
      const sx = (k(H[j * S + ip]) - k(H[j * S + im])) / (2 * texel);
      const sy = (k(H[jp * S + i]) - k(H[jm * S + i])) / (2 * texel);
      const o = (j * S + i) * 4;
      d[o] = enc(sx / 4 + 0.5);
      d[o + 1] = enc(sy / 4 + 0.5);
      d[o + 2] = enc((H[j * S + i] - minH) / (maxH - minH));
      d[o + 3] = enc(A[j * S + i]);
    }
  return makeTex(d, S, aniso);
}

function smooth(t: number) {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}
