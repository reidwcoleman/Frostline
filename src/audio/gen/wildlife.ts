// Animal voices: glottal-ish sources with pitch contours through morphing vowel formants.
// Wolves carry the game's night, so the howl gets the most care: a nearly pure tone with a few harmonics,
// register breaks, slow vibrato, jitter/shimmer roughness and an oo → ah → oo vowel.
import {
  adEnv, alloc, band, biquad, bump, ctl, envelope, formants, fsin, len, lowpass1, mix, mixAt, pink, rand, saw,
  smoothNoise, smooth01, white, type Rng,
} from '../dsp';
import { breath, knock, rumble } from './common';

/** Piecewise contour through (fraction, Hz) points with cosine easing between them. */
function contour(points: readonly (readonly [number, number])[], p: number): number {
  if (p <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    if (p <= x1) {
      const [x0, y0] = points[i - 1];
      const u = (p - x0) / Math.max(1e-6, x1 - x0);
      return y0 + (y1 - y0) * (0.5 - 0.5 * Math.cos(Math.PI * u));
    }
  }
  return points[points.length - 1][1];
}

/**
 * Harmonic voice source: sum of the first `h.length` harmonics of f0 via the sine recurrence (cheap), with the
 * upper harmonics scaled by `bright` so the vowel can open up. f0/bright are per-sample arrays (see ctl()) or,
 * for brightness, a constant.
 */
function voice(n: number, sr: number, f0: Float32Array, h: readonly number[], bright: Float32Array | number = 1): Float32Array {
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    ph += f0[i] / sr;
    if (ph >= 1) ph -= 1;
    const s1 = fsin(ph);
    const c2 = 2 * fsin(ph + 0.25);
    const b = typeof bright === 'number' ? bright : bright[i];
    let sPrev = 0,
      s = s1,
      acc = h[0] * s1;
    for (let k = 1; k < h.length; k++) {
      const sn = c2 * s - sPrev;
      sPrev = s;
      s = sn;
      acc += h[k] * b * s;
    }
    out[i] = acc;
  }
  return out;
}

const HOWLS: { dur: number; pts: [number, number][] }[] = [
  // Classic: scoop up, long sustain, fall away.
  { dur: 4.4, pts: [[0, 350], [0.08, 470], [0.16, 600], [0.3, 618], [0.55, 606], [0.75, 592], [0.88, 470], [1, 300]] },
  // Higher, with a register break mid-sustain.
  { dur: 4.8, pts: [[0, 400], [0.1, 640], [0.2, 700], [0.4, 688], [0.44, 560], [0.5, 572], [0.58, 676], [0.8, 668], [0.92, 520], [1, 340]] },
  // Low and mournful.
  { dur: 5.0, pts: [[0, 300], [0.12, 420], [0.25, 488], [0.6, 472], [0.8, 440], [0.93, 330], [1, 262]] },
  // Two-part: rise, dip, rise higher, fall.
  { dur: 3.8, pts: [[0, 360], [0.1, 560], [0.2, 628], [0.38, 602], [0.46, 520], [0.56, 540], [0.66, 652], [0.84, 632], [0.95, 420], [1, 310]] },
];

export function wolfHowl(sr: number, rng: Rng, v: number): Float32Array {
  const H = HOWLS[v % HOWLS.length];
  const dur = H.dur * rand(rng, 0.95, 1.05);
  const n = len(sr, dur);
  const jit = smoothNoise(n, sr, rng, 38);
  const shim = smoothNoise(n, sr, rng, 26);
  const vibRate = rand(rng, 4.6, 5.6);
  const vibPh = rng() * 6.28;
  const idx = (t: number) => Math.min(n - 1, Math.floor(t * sr));
  const open = (p: number) => smooth01(0.02, 0.25, p) * (1 - smooth01(0.7, 0.97, p));
  const f0 = ctl(n, sr, (t) => {
    const p = t / dur;
    const depth = 0.013 * smooth01(0.15, 0.35, p) * (1 - smooth01(0.85, 1, p));
    return contour(H.pts, p) * (1 + depth * Math.sin(2 * Math.PI * vibRate * t + vibPh)) * (1 + 0.004 * jit[idx(t)]);
  });
  const src = voice(n, sr, f0, [1, 0.32, 0.15, 0.07, 0.04], ctl(n, sr, (t) => 0.6 + 0.8 * open(t / dur), 64));
  // Breath: faint noise shaped like the tone's spectrum, plus shimmer (cycle-to-cycle amplitude roughness).
  const br = pink(n, rng);
  band(br, sr, 300, 2500);
  for (let i = 0; i < n; i++) src[i] = src[i] * (1 + 0.1 * shim[i]) + br[i] * 0.05;
  const shaped = formants(src, sr, 3, (t, f, b, g) => {
    const o = open(t / dur);
    f[0] = 300 + 400 * o; f[1] = 870 + 230 * o; f[2] = 2400 + 200 * o;
    b[0] = 90 + 60 * o; b[1] = 130; b[2] = 200;
    g[0] = 1; g[1] = 0.7; g[2] = 0.2;
  });
  // Keep the fundamental present even when it sits between formants.
  const out = new Float32Array(n);
  mix(out, src, 0.5);
  mix(out, shaped, 1.4);
  envelope(out, sr, (t) => {
    const p = t / dur;
    return smooth01(0, 0.07, p) * (0.8 + 0.2 * open(p)) * Math.pow(1 - smooth01(0.8, 1, p), 1.2);
  });
  biquad(out, sr, 'highpass', 150, 0.7);
  return lowpass1(out, sr, 4000);
}

/** Low rumbling snarl: ~80 Hz rough source with irregular 20–30 Hz AM (vocal fry) through snarl formants. */
export function wolfGrowl(sr: number, rng: Rng): Float32Array {
  const dur = rand(rng, 1.4, 1.6);
  return snarl(sr, rng, dur, rand(rng, 72, 86), 25, 0.35, (t) => bump(t, 0, 0.35, 0.85) + 0.8 * bump(t, 0.55, 1.0, dur));
}

function snarl(sr: number, rng: Rng, dur: number, fBase: number, amRate: number, noiseAmt: number, envFn: (t: number) => number): Float32Array {
  const n = len(sr, dur);
  const wob = smoothNoise(n, sr, rng, 3);
  const amWob = smoothNoise(n, sr, rng, 7);
  const rough = smoothNoise(n, sr, rng, 60);
  const idx = (t: number) => Math.min(n - 1, Math.floor(t * sr));
  const src = saw(n, sr, (t) => fBase * (1 + 0.1 * wob[idx(t)]), 0);
  // Subharmonic gives the chesty rumble.
  let ph = 0;
  for (let i = 0; i < n; i++) {
    ph += (fBase * 0.5 * (1 + 0.1 * wob[i])) / sr;
    src[i] += 0.5 * fsin(ph);
  }
  const nz = white(n, rng);
  biquad(nz, sr, 'bandpass', 600, 0.6);
  mix(src, nz, noiseAmt * 2);
  let aph = 0;
  for (let i = 0; i < n; i++) {
    aph += (amRate + 5 * amWob[i]) / sr;
    const s = 0.5 + 0.5 * fsin(aph);
    src[i] *= (0.35 + 0.65 * s * s) * (0.8 + 0.2 * rough[i]);
  }
  const out = formants(src, sr, 3, (_t, f, b, g) => {
    f[0] = 450; f[1] = 1000; f[2] = 2300;
    b[0] = 160; b[1] = 220; b[2] = 320;
    g[0] = 1; g[1] = 0.6; g[2] = 0.3;
  });
  mix(out, src, 0.25);
  envelope(out, sr, envFn);
  return lowpass1(out, sr, 3500);
}

/** Short bark: 400 → 250 Hz with a noisy onset. */
function bark(sr: number, rng: Rng, fHi: number, fLo: number, dur: number): Float32Array {
  const n = len(sr, dur);
  const f0 = ctl(n, sr, (t) => fLo + (fHi - fLo) * Math.exp(-t / 0.06));
  const src = saw(n, sr, (t) => fLo + (fHi - fLo) * Math.exp(-t / 0.06), 0);
  const s2 = voice(n, sr, f0, [1]);
  mix(src, s2, 0.6);
  const rough = smoothNoise(n, sr, rng, 80);
  for (let i = 0; i < n; i++) src[i] *= 1 + 0.25 * rough[i];
  const nz = white(n, rng);
  band(nz, sr, 800, 4000);
  envelope(nz, sr, (t) => 0.15 + adEnv(t, 0.001, 0.02) * 1.5);
  mix(src, nz, 0.5);
  const out = formants(src, sr, 3, (t, f, b, g) => {
    f[0] = 650 - 150 * Math.min(1, t / dur); f[1] = 1250 - 250 * Math.min(1, t / dur); f[2] = 2500;
    b[0] = 120; b[1] = 180; b[2] = 300;
    g[0] = 1; g[1] = 0.8; g[2] = 0.35;
  });
  mix(out, src, 0.15);
  return envelope(out, sr, (t) => adEnv(t, 0.006, 0.07));
}

export function wolfBark(sr: number, rng: Rng): Float32Array {
  const k = rand(rng, 0.92, 1.1);
  const out = alloc(sr, 0.32);
  mix(out, bark(sr, rng, 420 * k, 250 * k, 0.3), 1);
  return out;
}

/** Attack: aggressive snarl into a bark and a teeth snap. */
export function wolfAttack(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 0.78);
  mix(out, snarl(sr, rng, 0.45, rand(rng, 115, 140), 31, 0.55, (t) => bump(t, 0, 0.1, 0.45)), 0.8);
  mixAt(out, bark(sr, rng, 520, 300, 0.3), sr, 0.3, 1);
  const snap = knock(sr, rng, 0.05, [
    { f: 1800, tau: 0.006, amp: 1 },
    { f: 3200, tau: 0.004, amp: 0.6 },
  ], 8000, 0.001);
  mixAt(out, snap, sr, 0.56, 0.7);
  return out;
}

/** Quick high yelp: 900 → 1400 → 700 Hz. */
export function wolfYelp(sr: number, rng: Rng): Float32Array {
  const dur = 0.32;
  const n = len(sr, dur);
  const k = rand(rng, 0.93, 1.07);
  const fn = (t: number) => k * (t < 0.06 ? 900 + 500 * (t / 0.06) : 700 + 700 * Math.exp(-(t - 0.06) / 0.1));
  const src = voice(n, sr, ctl(n, sr, fn, 8), [1, 0.35, 0.15, 0.06]);
  const sw = saw(n, sr, fn, 0);
  mix(src, sw, 0.3);
  const out = formants(src, sr, 3, (_t, f, b, g) => {
    f[0] = 800; f[1] = 1600; f[2] = 2800;
    b[0] = 150; b[1] = 200; b[2] = 300;
    g[0] = 1; g[1] = 0.7; g[2] = 0.3;
  });
  mix(out, src, 0.5);
  return envelope(out, sr, (t) => adEnv(t, 0.01, 0.1) * (1 - smooth01(0.24, 0.32, t)));
}

/** Dying whimper: two falling cries with tremolo, getting breathier. */
export function wolfDie(sr: number, rng: Rng): Float32Array {
  const dur = 1.3;
  const out = alloc(sr, dur);
  const cry = (d: number, fa: number, fb: number, tremA: number, tremB: number, breathy: number) => {
    const n = len(sr, d);
    const src = voice(n, sr, ctl(n, sr, (t) => fa * Math.pow(fb / fa, t / d)), [1, 0.3, 0.12]);
    let tp = 0;
    const nz = white(n, rng);
    band(nz, sr, 500, 3000);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      tp += (tremA + (tremB - tremA) * (t / d)) / sr;
      const tr = 1 - 0.4 * (0.5 + 0.5 * fsin(tp));
      src[i] = src[i] * tr * (1 - breathy * (t / d)) + nz[i] * breathy * 0.5 * (t / d);
    }
    const o = formants(src, sr, 2, (_t, f, b, g) => {
      f[0] = 700; f[1] = 1400;
      b[0] = 200; b[1] = 250;
      g[0] = 1; g[1] = 0.8;
    });
    mix(o, src, 0.5);
    return envelope(o, sr, (t) => adEnv(t, 0.03, d * 0.45) * (1 - smooth01(d * 0.8, d, t)));
  };
  mix(out, cry(0.55, 950, 620, 8, 7, 0.2), 0.9);
  mixAt(out, cry(0.7, 700, 350, 7, 4.5, 0.6), sr, 0.6, 0.6);
  return out;
}

/** Deer alarm: a forceful nasal snort with a whistle edge. */
export function deerAlert(sr: number, rng: Rng): Float32Array {
  const dur = 0.4;
  const out = alloc(sr, dur);
  const blow = breath(sr, rng, dur, (t) => adEnv(t, 0.004, 0.09), () => [1100, 2500, 3800], [300, 400, 500], [1, 0.8, 0.4]);
  biquad(blow, sr, 'highpass', 400, 0.7);
  mix(out, blow, 1);
  const fw = rand(rng, 1700, 2000);
  const n = out.length;
  const wh = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    ph += (fw * (1 - (0.08 * i) / sr)) / sr;
    wh[i] = fsin(ph);
  }
  envelope(wh, sr, (t) => adEnv(t, 0.01, 0.1));
  mix(out, wh, 0.25);
  return out;
}

/** Bleat descending: nasal, with the fast ~22 Hz pulsing of a distressed bleat. */
export function deerDie(sr: number, rng: Rng): Float32Array {
  const dur = 1.0;
  const n = len(sr, dur);
  const pr = rand(rng, 20, 24);
  const f0 = (t: number) => (520 - 200 * (t / dur) - 60 * smooth01(0.6, 1, t / dur)) * (1 + 0.03 * Math.sin(2 * Math.PI * pr * t));
  const src = saw(n, sr, f0, 0);
  for (let i = 0; i < n; i++) src[i] *= 1 - 0.5 * (0.5 + 0.5 * fsin((pr * i) / sr));
  const out = formants(src, sr, 3, (t, f, b, g) => {
    const p = t / dur;
    f[0] = 650 - 150 * p; f[1] = 1800 - 300 * p; f[2] = 2700;
    b[0] = 100; b[1] = 150; b[2] = 250;
    g[0] = 1; g[1] = 0.8; g[2] = 0.4;
  });
  mix(out, src, 0.1);
  return envelope(out, sr, (t) => adEnv(t, 0.03, 0.5) * (1 - smooth01(0.65, 1, t / dur)));
}

/** High 2–3 kHz squeak with a fast flutter; variant 2 has two syllables. */
export function rabbitSqueak(sr: number, rng: Rng, v: number): Float32Array {
  const out = alloc(sr, 0.34);
  const one = (d: number, fa: number, fb: number, fc: number) => {
    const n = len(sr, d);
    const f0 = ctl(n, sr, (t) => {
      const p = t / d;
      return (p < 0.35 ? fa + (fb - fa) * (p / 0.35) : fb + (fc - fb) * ((p - 0.35) / 0.65)) * (1 + 0.04 * Math.sin(2 * Math.PI * 35 * t));
    }, 8);
    const s = voice(n, sr, f0, [1, 0.25, 0.06]);
    return envelope(s, sr, (t) => adEnv(t, 0.01, d * 0.35) * (1 - smooth01(d * 0.8, d, t)));
  };
  const k = rand(rng, 0.92, 1.08);
  mix(out, one(rand(rng, 0.14, 0.2), 2400 * k, 3000 * k, 2200 * k), 1);
  if (v === 2) mixAt(out, one(0.12, 2600 * k, 3100 * k, 2500 * k), sr, 0.18, 0.6);
  return out;
}

/** 6–10 wing flaps, accelerating then relaxing, fading as the bird leaves. */
export function birdFlap(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 0.95);
  const count = 6 + Math.floor(rng() * 5);
  let t = 0.01;
  let a = 1;
  for (let k = 0; k < count; k++) {
    const flap = rumble(sr, rng, 0.06, rand(rng, 1200, 2000), (x) => adEnv(x, 0.004, 0.018));
    mixAt(out, flap, sr, t, a);
    const whup = alloc(sr, 0.05);
    const f = rand(rng, 150, 230);
    for (let i = 0; i < whup.length; i++) {
      const x = i / sr;
      whup[i] = fsin(f * (1 - 2 * x) * x);
    }
    envelope(whup, sr, (x) => adEnv(x, 0.003, 0.012));
    mixAt(out, whup, sr, t, a * 0.35);
    const feather = white(len(sr, 0.03), rng);
    band(feather, sr, 2000, 6000);
    envelope(feather, sr, (x) => adEnv(x, 0.002, 0.008));
    mixAt(out, feather, sr, t + 0.005, a * 0.2);
    const p = k / (count - 1);
    t += 0.095 - 0.04 * Math.sin(Math.PI * p) + rand(rng, -0.008, 0.008);
    a *= k < 2 ? 0.95 : 0.84;
  }
  return out;
}

/** Chickadee "fee-bee": two pure whistles (~3.9 then ~3.3 kHz); variant 2 is "fee-bee-ee". */
export function birdCall(sr: number, rng: Rng, v: number): Float32Array {
  const out = alloc(sr, 0.95);
  const k = v === 1 ? 0.96 : rand(rng, 0.98, 1.03);
  const note = (d: number, f: (p: number) => number, gapAt = -1) => {
    const n = len(sr, d);
    const o = new Float32Array(n);
    let ph = 0;
    const fr = ctl(n, sr, (t) => f(t / d), 8);
    for (let i = 0; i < n; i++) {
      ph += fr[i] / sr;
      o[i] = fsin(ph) + 0.04 * fsin(2 * ph);
    }
    return envelope(o, sr, (t) => {
      const p = t / d;
      const e = smooth01(0, 0.1, p) * (1 - smooth01(0.82, 1, p));
      return gapAt > 0 ? e * (1 - 0.85 * bump(p, gapAt - 0.08, gapAt, gapAt + 0.08)) : e;
    });
  };
  mixAt(out, note(0.3, (p) => k * (3950 - 80 * p)), sr, 0.02, 1);
  const bee = v === 2
    ? note(0.38, (p) => k * (p < 0.5 ? 3320 : 3250 + 60 * (p - 0.5)), 0.5)
    : note(0.34, (p) => k * (3300 + 70 * Math.sin(Math.PI * p)));
  mixAt(out, bee, sr, 0.4, 0.8);
  const air = pink(out.length, rng);
  biquad(air, sr, 'bandpass', 3600, 6);
  envelope(air, sr, (t) => bump(t, 0.02, 0.2, 0.8));
  mix(out, air, 0.03);
  return out;
}

/** Owl: soft "hoo-hoo hooooo" around 380 Hz with breath. */
export function owl(sr: number, rng: Rng, v: number): Float32Array {
  const pattern: [number, number][] = v === 1
    ? [[0, 0.2], [0.35, 0.15], [0.55, 0.15], [0.85, 0.72]]
    : [[0, 0.17], [0.3, 0.16], [0.66, 0.78]];
  const f = rand(rng, 360, 395);
  const dur = pattern[pattern.length - 1][0] + pattern[pattern.length - 1][1] + 0.2;
  const out = alloc(sr, dur);
  for (const [t0, d] of pattern) {
    const n = len(sr, d);
    const o = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const rise = Math.min(1, t / 0.04);
      const fall = Math.max(0, (t - (d - 0.08)) / 0.08);
      ph += (f * (0.94 + 0.06 * rise) * (1 - 0.1 * fall)) / sr;
      o[i] = fsin(ph) + 0.08 * fsin(2 * ph) + 0.02 * fsin(3 * ph);
    }
    envelope(o, sr, (t) => Math.sin((Math.PI / 2) * Math.min(1, t / 0.035)) * (1 - smooth01(d - 0.07, d, t)));
    const br = pink(n, rng);
    lowpass1(br, sr, 600);
    lowpass1(br, sr, 600);
    envelope(br, sr, (t) => Math.min(1, t / 0.03) * (1 - smooth01(d - 0.07, d, t)));
    mix(o, br, 0.12);
    mixAt(out, o, sr, t0, 1);
  }
  return out;
}

// ------------------------------------------------------------------ ambience one-shots

/** Slow, irregular stick-slip creak of a trunk under wind load, with a few swells. */
export function woodCreak(sr: number, rng: Rng): Float32Array {
  const dur = rand(rng, 1.1, 2.0);
  const n = len(sr, dur);
  const rate = smoothNoise(n, sr, rng, 1.5);
  const amp = smoothNoise(n, sr, rng, 2);
  const idx = (t: number) => Math.min(n - 1, Math.floor(t * sr));
  const k = rand(rng, 0.85, 1.15);
  const swell2 = rand(rng, 0.5, 0.8);
  const src = new Float32Array(n);
  let t = 0;
  while (t < dur) {
    const r = 25 + 35 * (0.5 + 0.5 * rate[idx(t)]);
    t += (1 / r) * (1 + 0.3 * (rng() * 2 - 1));
    const i = Math.floor(t * sr);
    if (i >= n) break;
    const e = Math.max(bump(t, 0, dur * 0.25, dur * 0.6), swell2 * bump(t, dur * 0.4, dur * 0.7, dur));
    src[i] += e * (0.55 + 0.45 * amp[i]) * (0.6 + 0.4 * rng());
  }
  const res = [
    { f: 430 * k, tau: 0.025, amp: 1 },
    { f: 610 * k, tau: 0.02, amp: 0.8 },
    { f: 870 * k, tau: 0.015, amp: 0.55 },
    { f: 200 * k, tau: 0.03, amp: 0.5 },
    { f: 1500 * k, tau: 0.008, amp: 0.2 },
  ];
  const out = new Float32Array(n);
  for (const r of res) {
    const w = (2 * Math.PI * r.f) / sr;
    const rr = Math.exp(-1 / (r.tau * sr));
    const c1 = 2 * rr * Math.cos(w),
      c2 = -rr * rr,
      g = r.amp * Math.sin(w);
    let y1 = 0,
      y2 = 0;
    for (let i = 0; i < n; i++) {
      const y = g * src[i] + c1 * y1 + c2 * y2;
      y2 = y1;
      y1 = y;
      out[i] += y;
    }
  }
  return out;
}

/**
 * Lake ice: the eerie dispersive "pew". Flexural waves in ice are dispersive — high frequencies arrive first —
 * so a crack far away is heard as a fast descending chirp (f ∝ 1/t²) from ~4 kHz to ~200 Hz, repeated by
 * multiple arrivals, over a low boom.
 */
export function iceCrack(sr: number, rng: Rng): Float32Array {
  const dur = rand(rng, 1.7, 2.6);
  const n = len(sr, dur);
  const out = new Float32Array(n);
  mix(out, knock(sr, rng, 0.1, [
    { f: rand(rng, 900, 1400), tau: 0.01, amp: 1 },
    { f: rand(rng, 2000, 3000), tau: 0.006, amp: 0.6 },
  ], 9000, 0.0015), 0.35);
  const boomLen = Math.min(n, len(sr, 2.2));
  const boom = new Float32Array(boomLen);
  // f(t) = 38 + 22·e^(−t/0.12) integrated analytically for the phase.
  for (let i = 0; i < boomLen; i++) {
    const t = i / sr;
    boom[i] = fsin(38 * t + 22 * 0.12 * (1 - Math.exp(-t / 0.12)));
  }
  envelope(boom, sr, (t) => adEnv(t, 0.004, 0.28));
  mix(out, boom, 0.6);
  mix(out, rumble(sr, rng, 0.8, 110, (t) => adEnv(t, 0.003, 0.2)), 0.5);
  const arrivals: [number, number][] = [
    [0.004, 1],
    [rand(rng, 0.04, 0.1), rand(rng, 0.5, 0.7)],
    [rand(rng, 0.15, 0.3), rand(rng, 0.25, 0.4)],
  ];
  const fHi = rand(rng, 3500, 4500);
  const fLo = rand(rng, 170, 230);
  const Tc = rand(rng, 0.45, 0.8);
  for (const [t0, a] of arrivals) {
    for (const spread of [1, 1.06]) {
      const tau0 = 0.316 * Tc * spread;
      const i0 = Math.floor(t0 * sr);
      let ph = rng();
      const kd = Math.exp(-1 / (0.45 * Tc * sr));
      const att = 0.003 * sr;
      let e = a * (spread === 1 ? 1 : 0.6);
      for (let i = i0; i < n; i++) {
        const j = i - i0;
        const q = tau0 / (tau0 + j / sr);
        ph += (fLo + (fHi - fLo) * q * q) / sr;
        out[i] += (j < att ? j / att : 1) * e * (fsin(ph) + 0.2 * fsin(2 * ph));
        e *= kd;
        if (e < 1e-4) break;
      }
    }
  }
  return out;
}
