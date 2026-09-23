// Tools and weapons: whooshes, wood/stone/flesh impacts, bow and spear. Impacts are modal (resonator banks)
// so each hit has a real material pitch; variants shift the modes a few percent.
import {
  adEnv, alloc, band, biquad, bump, envelope, exciter, fades, fsin, grains, len, lowpass1, mix, mixAt, partials, pink, pluck, rand, saw,
  smoothNoise, sweep, white, type Rng,
} from '../dsp';
import { creak, crunch, knock, ping, rumble, rustle, scaleModes, thump, whoosh } from './common';

export function axeSwing(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 0.36);
  const k = rand(rng, 0.9, 1.1);
  mix(out, whoosh(sr, rng, 0.32, 450 * k, 2300 * k, 700 * k, rand(rng, 0.38, 0.48), 2.2, 0.5), 1);
  return out;
}

const WOOD_HIT = [
  { f: 150, tau: 0.12, amp: 1 },
  { f: 330, tau: 0.08, amp: 0.8 },
  { f: 620, tau: 0.05, amp: 0.55 },
  { f: 1150, tau: 0.025, amp: 0.35 },
  { f: 2300, tau: 0.012, amp: 0.2 },
];

/** THUNK: sharp transient, wood body modes, splinter grains, a little low boom. */
export function axeHitWood(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 0.45);
  const k = rand(rng, 0.9, 1.1);
  mix(out, knock(sr, rng, 0.45, scaleModes(WOOD_HIT, k), 3500, 0.004), 1);
  const click = white(len(sr, 0.002), rng);
  band(click, sr, 2500, 12000);
  mix(out, click, 0.6);
  const spl = alloc(sr, 0.25);
  grains(spl, sr, rng, 0, 0.22, (t) => 1800 * adEnv(t, 0.003, 0.05), {
    rateMax: 1800, fMin: 1800, fMax: 6500, decayMin: 0.0002, decayMax: 0.0015, noise: 0.5, skew: 2,
  });
  mix(out, spl, 0.5);
  mix(out, thump(sr, rng, 0.2, 80, 50, 0.05, 0.5, 150), 0.35);
  return out;
}

/** Metallic CHINK on stone: inharmonic high partials, grit, low thud. */
export function axeHitStone(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 0.4);
  const k = rand(rng, 0.92, 1.08);
  const ring = alloc(sr, 0.4);
  const P = [
    [2100, 0.06, 1],
    [3400, 0.045, 0.8],
    [5700, 0.03, 0.6],
    [7900, 0.02, 0.35],
    [11200, 0.012, 0.2],
  ];
  partials(ring, sr, P.map(([f, tau, a]) => ({ f: f * k * rand(rng, 0.98, 1.02), amp: a, tau, phase: rng() * 6.28 })));
  mix(out, ring, 0.7);
  const click = white(len(sr, 0.0015), rng);
  band(click, sr, 2000, 14000);
  mix(out, click, 0.8);
  const grit = alloc(sr, 0.1);
  grains(grit, sr, rng, 0, 0.08, (t) => 3000 * adEnv(t, 0.001, 0.02), {
    rateMax: 3000, fMin: 3000, fMax: 9000, decayMin: 0.0001, decayMax: 0.0006, noise: 0.8, skew: 1.8,
  });
  mix(out, grit, 0.5);
  mix(out, thump(sr, rng, 0.12, 120, 75, 0.028, 0.6, 250), 0.45);
  return out;
}

/** Wet dull thud: low body, a squelch sweeping down, a little gristle. */
export function axeHitFlesh(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 0.35);
  mix(out, thump(sr, rng, 0.25, rand(rng, 100, 120), 60, 0.05, 1, 250, 1.5), 1);
  const sq = white(len(sr, 0.2), rng);
  const f0 = rand(rng, 800, 1000);
  sweep(sq, sr, 'bandpass', (t) => f0 * Math.pow(0.42, t / 0.12), 2.5);
  envelope(sq, sr, (t) => adEnv(t, 0.003, 0.05));
  mix(out, sq, 0.6);
  grains(out, sr, rng, 0, 0.07, (t) => 600 * adEnv(t, 0.002, 0.03), {
    rateMax: 600, fMin: 400, fMax: 1500, decayMin: 0.001, decayMax: 0.003, noise: 0.3, skew: 1.5,
  });
  return lowpass1(out, sr, 5000);
}

/** Soft poof into snow. */
export function axeHitSnow(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 0.3);
  const poof = white(out.length, rng);
  biquad(poof, sr, 'lowpass', 1400, 0.7);
  biquad(poof, sr, 'lowpass', 1400, 0.7);
  envelope(poof, sr, (t) => adEnv(t, 0.004, 0.06));
  mix(out, poof, 1.2);
  mix(out, crunch(sr, rng, 0.12, (t) => bump(t, 0, 0.01, 0.1), 1200, 800, 3500, 0.5), 0.5);
  mix(out, thump(sr, rng, 0.1, 95, 60, 0.03, 0.4, 160), 0.4);
  return out;
}

export function spearSwing(sr: number, rng: Rng): Float32Array {
  const k = rand(rng, 0.92, 1.08);
  return whoosh(sr, rng, 0.46, 350 * k, 1500 * k, 500 * k, 0.45, 2, 0.6);
}

/** Throw: effortful whoosh whose band rises (release + departure), with a narrow whistling component. */
export function spearThrow(sr: number, rng: Rng): Float32Array {
  const dur = 0.7;
  const n = len(sr, dur);
  const out = new Float32Array(n);
  const src = pink(n, rng);
  const body = src.slice();
  sweep(body, sr, 'bandpass', (t) => 380 * Math.pow(2400 / 380, Math.min(1, t / 0.55)), 1.1);
  envelope(body, sr, (t) => adEnv(t, 0.11, 0.18));
  mix(out, body, 1);
  sweep(src, sr, 'bandpass', (t) => 650 + 500 * Math.min(1, t / 0.5), 9);
  envelope(src, sr, (t) => adEnv(t, 0.14, 0.2));
  mix(out, src, 1.2);
  return out;
}

const SHAFT_HIT = [
  { f: 120, tau: 0.1, amp: 1 },
  { f: 280, tau: 0.07, amp: 0.7 },
  { f: 560, tau: 0.04, amp: 0.45 },
  { f: 1100, tau: 0.02, amp: 0.25 },
];

/** Shaft vibration after impact: a decaying bending-mode tone with tremolo and a slight pitch wobble. */
function shaftQuiver(sr: number, dur: number, f: number, tau: number, trem: number, buzz: number): Float32Array {
  const n = len(sr, dur);
  const out = new Float32Array(n);
  let ph = 0;
  let e = 1;
  const k = Math.exp(-1 / (tau * sr));
  for (let i = 0; i < n; i++) {
    const tp = (trem * i) / sr;
    const m = fsin(tp);
    ph += (f * (1 + 0.012 * e * m)) / sr;
    const tr = 1 - 0.55 * (0.5 + 0.5 * m);
    const s = fsin(ph);
    // A second harmonic and a cubic fold give the "buzzing" edge of a vibrating shaft.
    out[i] = e * tr * (s + buzz * fsin(2 * ph + 0.05) + buzz * 0.5 * s * s * s);
    e *= k;
  }
  return fades(out, sr, 0, 0.02);
}

export function spearHit(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 0.6);
  const k = rand(rng, 0.9, 1.1);
  mix(out, knock(sr, rng, 0.35, scaleModes(SHAFT_HIT, k), 3000, 0.004), 1);
  mixAt(out, shaftQuiver(sr, 0.55, rand(rng, 160, 190), 0.17, rand(rng, 20, 24), 0.35), sr, 0.006, 0.4);
  return out;
}

/** Bow draw: accelerating stick-slip micro-clicks through wood/string resonances + a low groan of the limbs. */
export function bowDraw(sr: number, rng: Rng): Float32Array {
  const dur = 0.85;
  const n = len(sr, dur);
  const out = creak(sr, rng, dur, (t) => 30 * (1 + 4.3 * Math.pow(t / dur, 1.5)), (t) => (0.5 + 0.5 * (t / dur)) * bump(t, 0, 0.1, dur + 0.05), [
    { f: rand(rng, 330, 370), tau: 0.012, amp: 1 },
    { f: rand(rng, 760, 840), tau: 0.008, amp: 0.8 },
    { f: 1600, tau: 0.005, amp: 0.5 },
    { f: 2900, tau: 0.003, amp: 0.3 },
  ], 0.35);
  const groan = saw(n, sr, (t) => 70 + 22 * (t / dur), 0);
  biquad(groan, sr, 'lowpass', 400, 0.7);
  biquad(groan, sr, 'bandpass', 220, 2);
  envelope(groan, sr, (t) => bump(t, 0, 0.6, dur));
  mix(out, groan, 0.35);
  const str = white(n, rng);
  band(str, sr, 3000, 8000);
  envelope(str, sr, (t) => 0.05 * (t / dur));
  mix(out, str, 1);
  return out;
}

/** Bow release: Karplus–Strong twang at ~110 Hz with fast decay, limb thump, string slap, short whoosh. */
export function bowRelease(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 0.6);
  const tw = pluck(len(sr, 0.6), sr, rand(rng, 100, 120), rng, 0.38, 0.85);
  band(tw, sr, 70, 4500);
  mix(out, tw, 1);
  mix(out, thump(sr, rng, 0.12, 140, 75, 0.025, 0.6, 250), 0.6);
  const slap = exciter(sr, rng, 0.002, 9000);
  band(slap, sr, 1500, 12000);
  mix(out, slap, 0.4);
  mixAt(out, whoosh(sr, rng, 0.16, 1000, 3000, 2000, 0.3, 1.2, 0.2), sr, 0.01, 0.35);
  return out;
}

const ARROW_WOOD = [
  { f: 400, tau: 0.03, amp: 1 },
  { f: 900, tau: 0.02, amp: 0.7 },
  { f: 1900, tau: 0.012, amp: 0.4 },
  { f: 3500, tau: 0.006, amp: 0.2 },
];

/** Crisp thock and a buzzing shaft quiver. */
export function arrowHitWood(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 0.55);
  mix(out, knock(sr, rng, 0.2, scaleModes(ARROW_WOOD, rand(rng, 0.9, 1.1)), 6000, 0.002), 1);
  const q = shaftQuiver(sr, 0.5, rand(rng, 95, 140), 0.12, rand(rng, 28, 34), 0.5);
  lowpass1(q, sr, 1500);
  mixAt(out, q, sr, 0.004, 0.45);
  return out;
}

export function arrowHitFlesh(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 0.3);
  const body = white(out.length, rng);
  biquad(body, sr, 'lowpass', 900, 0.7);
  envelope(body, sr, (t) => adEnv(t, 0.001, 0.03));
  mix(out, body, 1);
  mix(out, thump(sr, rng, 0.15, 140, 80, 0.03, 0.4, 220), 0.7);
  const wet = white(out.length, rng);
  biquad(wet, sr, 'bandpass', rand(rng, 450, 560), 2);
  envelope(wet, sr, (t) => adEnv(t, 0.003, 0.04));
  mix(out, wet, 0.6);
  const thwip = white(len(sr, 0.03), rng);
  band(thwip, sr, 2000, 5000);
  envelope(thwip, sr, (t) => adEnv(t, 0.0005, 0.006));
  mix(out, thwip, 0.3);
  return out;
}

export function arrowHitSnow(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 0.25);
  const thup = white(out.length, rng);
  biquad(thup, sr, 'lowpass', 700, 0.7);
  biquad(thup, sr, 'lowpass', 700, 0.7);
  envelope(thup, sr, (t) => adEnv(t, 0.002, 0.025));
  mix(out, thup, 1.5);
  mix(out, thump(sr, rng, 0.1, 120, 80, 0.02, 0.3, 200), 0.4);
  mix(out, crunch(sr, rng, 0.06, (t) => bump(t, 0, 0.006, 0.05), 1000, 1000, 4000), 0.3);
  return out;
}

/** Short whistling fly-by: narrow band sweeping down (doppler), fletching flutter. */
export function arrowWhoosh(sr: number, rng: Rng): Float32Array {
  const dur = 0.4;
  const n = len(sr, dur);
  const src = pink(n, rng);
  const hi = src.slice();
  const f0 = rand(rng, 1800, 2200);
  sweep(hi, sr, 'bandpass', (t) => f0 * Math.pow(0.65, t / dur), 4.5);
  const hiss = src;
  band(hiss, sr, 1000, 6000);
  const out = new Float32Array(n);
  mix(out, hi, 1.4);
  mix(out, hiss, 0.3);
  const fr = rand(rng, 85, 105);
  return envelope(out, sr, (t) => Math.pow(bump(t, 0, 0.18, dur), 1.6) * (1 - 0.35 * (0.5 + 0.5 * fsin(fr * t))));
}

/** Equip: cloth rustle and a small wooden (or metal) clack. */
export function equip(sr: number, rng: Rng, v: number): Float32Array {
  const out = alloc(sr, 0.4);
  mix(out, rustle(sr, rng, 0.22, 0.4), 0.7);
  const metal = v === 2;
  const clack = metal
    ? ping(sr, 2300, 1.7, 1.8, 0.02)
    : knock(sr, rng, 0.15, [
        { f: rand(rng, 1100, 1300), tau: 0.02, amp: 1 },
        { f: 2700, tau: 0.012, amp: 0.6 },
        { f: 4400, tau: 0.006, amp: 0.3 },
      ], 5000, 0.002);
  mixAt(out, clack, sr, rand(rng, 0.09, 0.13), metal ? 0.35 : 0.6);
  return out;
}

/** Torch swing: whoosh plus the flame roaring up with turbulence. */
export function torchSwing(sr: number, rng: Rng): Float32Array {
  const dur = 0.7;
  const out = alloc(sr, dur);
  mix(out, whoosh(sr, rng, 0.5, 300, 900, 400, 0.4, 1.0, 0.6), 0.7);
  const roar = rumble(sr, rng, dur, 500, (t) => bump(t, 0.05, 0.22, 0.68));
  const turb = smoothNoise(roar.length, sr, rng, 18);
  for (let i = 0; i < roar.length; i++) roar[i] *= 0.6 + 0.4 * turb[i];
  mix(out, roar, 1.4);
  grains(out, sr, rng, 0.1, 0.6, () => 30, { rateMax: 30, fMin: 1000, fMax: 5000, decayMin: 0.0003, decayMax: 0.0015, noise: 0.6, skew: 1.5 });
  return lowpass1(out, sr, 6000);
}
