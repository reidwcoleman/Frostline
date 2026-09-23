// Small math helpers shared across every system. Keep this file dependency-free
// (no three.js) so it can be imported from web workers.

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number) => (v - a) / (b - a);
export const remap = (v: number, a0: number, a1: number, b0: number, b1: number) =>
  b0 + ((v - a0) / (a1 - a0)) * (b1 - b0);
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

/** Frame-rate independent exponential smoothing. `lambda` ~ 1/time-constant. */
export const damp = (a: number, b: number, lambda: number, dt: number) =>
  lerp(a, b, 1 - Math.exp(-lambda * dt));

/** Shortest signed angle difference b - a in radians, in (-PI, PI]. */
export const angleDelta = (a: number, b: number) => {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
};
export const dampAngle = (a: number, b: number, lambda: number, dt: number) =>
  a + angleDelta(a, b) * (1 - Math.exp(-lambda * dt));

/** Deterministic PRNG (mulberry32). Returns a function producing [0,1). */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export type Rng = () => number;

/** Stateless integer hash -> [0,1). Useful for per-instance variation. */
export function hash2(x: number, y: number, seed = 0) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export function hash1(x: number, seed = 0) {
  return hash2(x, 0x9e3779b9, seed);
}

export const randRange = (rng: Rng, a: number, b: number) => a + (b - a) * rng();
