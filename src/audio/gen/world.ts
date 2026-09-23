// World sounds: felling trees, snow, building, doors and fire. Fire loops are seamless so the fire never "restarts".
import {
  adEnv, alloc, band, biquad, bump, envelope, fades, grains, len, lowpass1, mix, mixAt, partials, pink, rand, randLog, saw,
  seamless, smoothNoise, sweep, white, type Rng,
} from '../dsp';
import { crack, crackles, creak, crunch, knock, ping, rumble, rustle, scaleModes, spray, thump } from './common';

/** Splintering: accelerating sharp cracks through resonant bands, a final splinter burst, a low wood groan. */
export function treeCrack(sr: number, rng: Rng): Float32Array {
  const dur = 1.7;
  const out = alloc(sr, dur);
  let t = 0.02;
  let iv = rand(rng, 0.2, 0.26);
  const end = rand(rng, 1.15, 1.3);
  while (t < end) {
    const a = 0.3 + 0.7 * Math.pow(t / end, 1.2);
    mixAt(out, crack(sr, rng, 0.08, 400, 3200), sr, t, a * rand(rng, 0.7, 1));
    t += iv * rand(rng, 0.8, 1.2);
    iv = Math.max(0.018, iv * rand(rng, 0.72, 0.86));
  }
  // The final give: a loud crack and a burst of fibres tearing.
  mixAt(out, crack(sr, rng, 0.1, 300, 2500, 7000), sr, end, 1.3);
  const burst = alloc(sr, 0.35);
  grains(burst, sr, rng, 0, 0.3, (x) => 4000 * adEnv(x, 0.005, 0.08), {
    rateMax: 4000, fMin: 500, fMax: 5000, decayMin: 0.0003, decayMax: 0.003, noise: 0.6, skew: 2,
  });
  mixAt(out, burst, sr, end, 0.8);
  // Groan: a slow, rough sawtooth in the trunk's body resonance.
  const n = out.length;
  const wander = smoothNoise(n, sr, rng, 2.5);
  const rough = smoothNoise(n, sr, rng, 40);
  const groan = saw(n, sr, (x) => 58 + 14 * wander[Math.min(n - 1, Math.floor(x * sr))], 0);
  biquad(groan, sr, 'lowpass', 350, 0.7);
  biquad(groan, sr, 'bandpass', 180, 3);
  for (let i = 0; i < n; i++) groan[i] *= (0.6 + 0.4 * rough[i]) * bump(i / sr, 0.05, end, dur);
  mix(out, groan, 0.9);
  return out;
}

/** Falling tree: a building rush of branches through air, needle rustle and a couple of creaks (~2.6 s). */
export function treeFall(sr: number, rng: Rng): Float32Array {
  const dur = 2.6;
  const n = len(sr, dur);
  const out = new Float32Array(n);
  const build = (t: number) => Math.pow(Math.min(1, t / dur), 2.2);
  const rush = pink(n, rng);
  sweep(rush, sr, 'bandpass', (t) => 300 * Math.pow(1400 / 300, t / dur), 0.8);
  envelope(rush, sr, build);
  mix(out, rush, 1.4);
  const leaves = alloc(sr, dur);
  grains(leaves, sr, rng, 0, dur, (t) => 3000 * Math.pow(t / dur, 1.8), {
    rateMax: 3000, fMin: 2000, fMax: 7000, decayMin: 0.0003, decayMax: 0.002, noise: 0.9, skew: 1.8,
  });
  const flutter = smoothNoise(n, sr, rng, 12);
  for (let i = 0; i < n; i++) leaves[i] *= 0.6 + 0.4 * flutter[i];
  band(leaves, sr, 1500, 6500);
  mix(out, leaves, 0.6);
  const air = white(n, rng);
  band(air, sr, 1500, 5000);
  envelope(air, sr, (t) => Math.pow(t / dur, 1.8));
  mix(out, air, 0.1);
  mix(out, rumble(sr, rng, dur, 200, build), 0.8);
  for (const tc of [rand(rng, 0.15, 0.3), rand(rng, 0.8, 1.1), rand(rng, 1.5, 1.8)]) {
    const cd = rand(rng, 0.2, 0.35);
    const c = creak(sr, rng, cd, (x) => 40 + 50 * (x / cd), (x) => bump(x, 0, cd * 0.3, cd), [
      { f: rand(rng, 330, 380), tau: 0.02, amp: 1 },
      { f: rand(rng, 580, 660), tau: 0.015, amp: 0.7 },
      { f: rand(rng, 850, 950), tau: 0.01, amp: 0.4 },
    ]);
    mixAt(out, c, sr, tc, 0.5);
  }
  return fades(out, sr, 0.01, 0.15);
}

/** Massive whump: 40–60 Hz boom, branch crunch and cracks, a long snow spray. */
export function treeImpact(sr: number, rng: Rng): Float32Array {
  const dur = 2.2;
  const out = alloc(sr, dur);
  mix(out, thump(sr, rng, 1.4, rand(rng, 54, 62), 36, 0.42, 1.2, 110, 2), 1);
  mix(out, rumble(sr, rng, 0.4, 400, (t) => adEnv(t, 0.002, 0.08)), 0.7);
  const cr = alloc(sr, 0.9);
  grains(cr, sr, rng, 0, 0.8, (t) => 2500 * adEnv(t, 0.01, 0.15), {
    rateMax: 2500, fMin: 500, fMax: 3500, decayMin: 0.0003, decayMax: 0.003, noise: 0.5, skew: 2,
  });
  mix(out, cr, 0.6);
  for (let k = 0; k < 5; k++) mixAt(out, crack(sr, rng, 0.06, 600, 3000), sr, rand(rng, 0.0, 0.4), rand(rng, 0.2, 0.5));
  mixAt(out, spray(sr, rng, 2.0, (t) => adEnv(t, 0.08, 0.5)), sr, 0.03, 0.5);
  return out;
}

/** Sharp crack, a second smaller crack, a few twigs pattering down. */
export function branchSnap(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 0.5);
  mix(out, crack(sr, rng, 0.08, 1500, 4000, 10000), 1);
  mixAt(out, crack(sr, rng, 0.06, 1200, 3500), sr, rand(rng, 0.03, 0.06), 0.45);
  grains(out, sr, rng, 0.05, 0.45, (t) => 110 * Math.exp(-(t - 0.05) / 0.15), {
    rateMax: 110, fMin: 1000, fMax: 5000, decayMin: 0.0005, decayMax: 0.003, noise: 0.7, skew: 2,
  });
  return out;
}

/** Snow sliding off a bough: soft slide hiss, a whump, a scattering crunch and a powder hiss. */
export function snowThump(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 0.9);
  const tw = rand(rng, 0.2, 0.3);
  const slide = pink(len(sr, tw + 0.05), rng);
  band(slide, sr, 900, 3000);
  envelope(slide, sr, (t) => bump(t, 0, tw * 0.75, tw + 0.05));
  mix(out, slide, 0.3);
  mixAt(out, rumble(sr, rng, 0.35, 260, (t) => adEnv(t, 0.006, 0.07)), sr, tw, 1.6);
  mixAt(out, thump(sr, rng, 0.25, 78, 50, 0.05, 0.5, 150), sr, tw, 0.5);
  mixAt(out, crunch(sr, rng, 0.3, (t) => bump(t, 0, 0.02, 0.25), 1500, 800, 3500), sr, tw, 0.35);
  mixAt(out, spray(sr, rng, 0.45, (t) => adEnv(t, 0.02, 0.18), 2000, 6000), sr, tw, 0.15);
  return out;
}

const PICKUP_NOTES = [74, 76, 81]; // D5, E5, A5: pentatonic so repeated pickups make a little tune

/** Soft marimba-ish tock plus a tiny rustle. */
export function pickup(sr: number, rng: Rng, v: number): Float32Array {
  const out = alloc(sr, 0.45);
  const f = 440 * Math.pow(2, (PICKUP_NOTES[v % 3] - 69) / 12);
  const note = alloc(sr, 0.45);
  partials(note, sr, [
    { f, amp: 1, tau: 0.13 },
    { f: f * 3.93, amp: 0.25, tau: 0.035 },
    { f: f * 9.2, amp: 0.06, tau: 0.012 },
  ]);
  const a = Math.ceil(sr * 0.003);
  for (let i = 0; i < a; i++) note[i] *= i / a;
  mix(out, note, 1);
  mix(out, rustle(sr, rng, 0.1, 0.3), 0.25);
  return out;
}

const PLANK = [
  { f: 140, tau: 0.12, amp: 1 },
  { f: 310, tau: 0.08, amp: 0.75 },
  { f: 680, tau: 0.045, amp: 0.45 },
  { f: 1300, tau: 0.02, amp: 0.25 },
];

/** Wood thunk + logs settling. */
export function buildPlace(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 0.7);
  const k = rand(rng, 0.92, 1.08);
  mix(out, knock(sr, rng, 0.5, scaleModes(PLANK, k), 2500, 0.006), 1);
  mix(out, thump(sr, rng, 0.2, 85, 55, 0.05, 0.5, 150), 0.4);
  const settle: [number, number, number][] = [
    [rand(rng, 0.09, 0.12), 0.35, 1.2],
    [rand(rng, 0.19, 0.24), 0.22, 0.9],
    [rand(rng, 0.3, 0.36), 0.12, 1.35],
  ];
  for (const [t, a, s] of settle) mixAt(out, knock(sr, rng, 0.25, scaleModes(PLANK, k * s, 0.6), 2200, 0.004), sr, t, a);
  return out;
}

export function buildInvalid(sr: number, rng: Rng): Float32Array {
  const modes = [
    { f: 170, tau: 0.045, amp: 1 },
    { f: 400, tau: 0.03, amp: 0.5 },
    { f: 820, tau: 0.015, amp: 0.2 },
  ];
  const out = alloc(sr, 0.36);
  mix(out, knock(sr, rng, 0.2, modes, 1200, 0.006), 1);
  mixAt(out, knock(sr, rng, 0.2, scaleModes(modes, 0.95), 1100, 0.006), sr, 0.12, 0.85);
  return lowpass1(out, sr, 1200);
}

/** Wooden clatter: pieces bouncing with shrinking intervals and random pitches. */
export function buildRemove(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 0.95);
  let t = 0;
  let iv = rand(rng, 0.14, 0.18);
  let a = 1;
  const count = 6 + Math.floor(rng() * 3);
  for (let k = 0; k < count && t < 0.8; k++) {
    mixAt(out, knock(sr, rng, 0.2, scaleModes(PLANK, randLog(rng, 0.8, 1.5), 0.5), 3000, 0.003), sr, t, a);
    t += iv * rand(rng, 0.7, 1.2);
    iv *= 0.82;
    a *= rand(rng, 0.65, 0.85);
  }
  return out;
}

const HINGE = [
  { f: 680, tau: 0.015, amp: 1 },
  { f: 1250, tau: 0.01, amp: 0.7 },
  { f: 2300, tau: 0.006, amp: 0.4 },
  { f: 410, tau: 0.02, amp: 0.5 },
];

function latch(sr: number, rng: Rng, f: number): Float32Array {
  const out = alloc(sr, 0.1);
  mix(out, ping(sr, f, 1.47, 2.5, 0.012), 0.5);
  mix(out, knock(sr, rng, 0.1, [
    { f: 900, tau: 0.02, amp: 1 },
    { f: 1900, tau: 0.012, amp: 0.5 },
  ], 5000, 0.002), 0.6);
  return out;
}

/** Latch, then a hinge creak (stick-slip pulse train through resonances). */
export function doorOpen(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 1.0);
  mix(out, latch(sr, rng, rand(rng, 2300, 2700)), 0.7);
  const k = rand(rng, 0.9, 1.1);
  const c = creak(sr, rng, 0.85, (t) => 45 + 70 * bump(t, 0, 0.35, 0.85) + 8 * Math.sin(t * 23), (t) => bump(t, 0, 0.22, 0.85), scaleModes(HINGE, k), 0.2);
  mixAt(out, c, sr, 0.08, 0.9);
  return out;
}

/** Short creak, a solid thunk and the latch catching. */
export function doorClose(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 0.8);
  const k = rand(rng, 0.9, 1.1);
  mix(out, creak(sr, rng, 0.35, (t) => 60 + 50 * (t / 0.35), (t) => bump(t, 0, 0.15, 0.35), scaleModes(HINGE, k * 1.05), 0.2), 0.6);
  const thunk = knock(sr, rng, 0.4, [
    { f: 110, tau: 0.1, amp: 1 },
    { f: 260, tau: 0.06, amp: 0.7 },
    { f: 520, tau: 0.04, amp: 0.4 },
    { f: 1100, tau: 0.02, amp: 0.2 },
  ], 2000, 0.006);
  mixAt(out, thunk, sr, 0.37, 1);
  mixAt(out, thump(sr, rng, 0.2, 90, 60, 0.06, 0.5, 150), sr, 0.37, 0.5);
  mixAt(out, latch(sr, rng, 2700), sr, 0.4, 0.4);
  return out;
}

/** 6 s seamless campfire: low roar bed with flicker, faint hiss, crackle clusters and bigger pops. */
export function fireCrackle(sr: number, rng: Rng): Float32Array {
  const dur = 6.5;
  const n = len(sr, dur);
  const out = new Float32Array(n);
  const roar = rumble(sr, rng, dur, 420, () => 1);
  const flick = smoothNoise(n, sr, rng, 3);
  const slow = smoothNoise(n, sr, rng, 0.7);
  for (let i = 0; i < n; i++) roar[i] *= (0.7 + 0.3 * flick[i]) * (0.85 + 0.15 * slow[i]);
  mix(out, roar, 1.2);
  const hiss = white(n, rng);
  biquad(hiss, sr, 'highpass', 3500, 0.7);
  const hm = smoothNoise(n, sr, rng, 5);
  for (let i = 0; i < n; i++) hiss[i] *= 0.03 * (0.6 + 0.4 * hm[i]);
  mix(out, hiss, 1);
  crackles(out, sr, rng, 0, dur, () => 7, 7, 0.9);
  return seamless(out, sr, 0.5);
}

/** Ignition: whoosh, a flare-up roar and the first crackles. */
export function fireIgnite(sr: number, rng: Rng): Float32Array {
  const dur = 2.1;
  const n = len(sr, dur);
  const out = new Float32Array(n);
  const wh = pink(n, rng);
  sweep(wh, sr, 'bandpass', (t) => 200 * Math.pow(1500 / 200, Math.min(1, t / 0.4)), 0.9);
  envelope(wh, sr, (t) => bump(t, 0, 0.18, 0.55));
  mix(out, wh, 1);
  const roar = white(n, rng);
  sweep(roar, sr, 'lowpass', (t) => 300 + 600 * bump(t, 0, 0.45, 2.1), 0.7);
  lowpass1(roar, sr, 900);
  const turb = smoothNoise(n, sr, rng, 9);
  for (let i = 0; i < n; i++) roar[i] *= bump(i / sr, 0.1, 0.5, dur) * (0.65 + 0.35 * turb[i]);
  mix(out, roar, 1.6);
  crackles(out, sr, rng, 0.45, dur - 0.1, (t) => 2 + 8 * Math.min(1, (t - 0.45) / 1.2), 10, 0.5);
  return out;
}

/** Fire going out: a steam puff, then hiss with sizzle fading. */
export function fireOut(sr: number, rng: Rng): Float32Array {
  const dur = 2.3;
  const out = alloc(sr, dur);
  const puff = white(out.length, rng);
  band(puff, sr, 400, 2000);
  envelope(puff, sr, (t) => adEnv(t, 0.01, 0.12));
  mix(out, puff, 0.6);
  const hiss = white(out.length, rng);
  band(hiss, sr, 2500, 10000);
  envelope(hiss, sr, (t) => adEnv(t, 0.03, 0.7));
  mix(out, hiss, 0.5);
  const siz = alloc(sr, dur);
  grains(siz, sr, rng, 0, dur, (t) => 1500 * adEnv(t, 0.05, 0.6), {
    rateMax: 1500, fMin: 3000, fMax: 9000, decayMin: 0.0001, decayMax: 0.0006, noise: 0.5, skew: 2,
  });
  band(siz, sr, 2500, 9000);
  mix(out, siz, 1);
  return fades(out, sr, 0.002, 0.3);
}

/** 4 s seamless torch: flame flutter roar with AM and a light crackle. */
export function torchLoop(sr: number, rng: Rng): Float32Array {
  const dur = 4.4;
  const n = len(sr, dur);
  const out = new Float32Array(n);
  const roar = rumble(sr, rng, dur, 650, () => 1);
  const flut = smoothNoise(n, sr, rng, 11);
  const slow = smoothNoise(n, sr, rng, 1.1);
  for (let i = 0; i < n; i++) roar[i] *= (0.65 + 0.35 * flut[i]) * (0.85 + 0.15 * slow[i]);
  mix(out, roar, 1.2);
  const hiss = white(n, rng);
  band(hiss, sr, 2000, 7000);
  for (let i = 0; i < n; i++) hiss[i] *= 0.025 * (0.6 + 0.4 * flut[i]);
  mix(out, hiss, 1);
  crackles(out, sr, rng, 0, dur, () => 3, 3, 0.2);
  return seamless(out, sr, 0.4);
}

/** Cooking: dense high crackle and hiss, seamless so it can loop. */
export function cookSizzle(sr: number, rng: Rng): Float32Array {
  const dur = 2.9;
  const n = len(sr, dur);
  const out = new Float32Array(n);
  const am = smoothNoise(n, sr, rng, 4);
  const cr = new Float32Array(n);
  grains(cr, sr, rng, 0, dur, () => 900, { rateMax: 900, fMin: 2000, fMax: 9000, decayMin: 0.0001, decayMax: 0.0008, noise: 0.7, skew: 2.2 });
  band(cr, sr, 1800, 9000);
  for (let i = 0; i < n; i++) cr[i] *= 0.75 + 0.25 * am[i];
  mix(out, cr, 1);
  const hiss = white(n, rng);
  band(hiss, sr, 3000, 8000);
  for (let i = 0; i < n; i++) hiss[i] *= 0.12 * (0.7 + 0.3 * am[i]);
  mix(out, hiss, 1);
  crackles(out, sr, rng, 0, dur, () => 4, 4, 0);
  return seamless(out, sr, 0.4);
}
