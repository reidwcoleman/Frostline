// Footsteps, skis, falls. Snow is granular: every step is a fresh cloud of micro-fractures, never a sample.
import {
  adEnv, alloc, band, biquad, bump, envelope, fades, fsin, grains, len, lowpass1, mix, mixAt, partials, rand, seamless,
  smoothNoise, stickSlip, white, type Rng,
} from '../dsp';
import { breath, crunch, knock, ping, resonate, rumble, rustle, scaleModes, spray, thump, whoosh } from './common';

// ------------------------------------------------------------------ footsteps

/**
 * Snow step: heel strike then toe roll. Grain density rises as the snow compresses and falls as it locks up;
 * a soft low thump sits under the heel and a lower "squish" of compaction follows the density.
 */
export function footstepSnow(sr: number, rng: Rng): Float32Array {
  const dur = rand(rng, 0.2, 0.3);
  const heel = rand(rng, 0.004, 0.012);
  const heelPk = heel + rand(rng, 0.014, 0.03);
  const heelEnd = heelPk + rand(rng, 0.05, 0.09);
  const toe = rand(rng, 0.065, 0.11);
  const toePk = toe + rand(rng, 0.03, 0.06);
  const toeAmt = rand(rng, 0.45, 0.8);
  const density = (t: number) => bump(t, heel, heelPk, heelEnd) + toeAmt * bump(t, toe, toePk, dur);
  const n = len(sr, dur + 0.04);
  const out = new Float32Array(n);
  mix(out, crunch(sr, rng, dur, density, rand(rng, 2000, 3000), rand(rng, 1400, 1800), rand(rng, 4500, 5500)), 1);
  const squish = white(n, rng);
  band(squish, sr, 280, 1100);
  envelope(squish, sr, (t) => Math.min(1, density(t)));
  mix(out, squish, 0.22);
  mixAt(out, thump(sr, rng, 0.12, rand(rng, 120, 145), 80, 0.028, 0.8, 200), sr, heel, 0.4);
  return out;
}

const ICE_CLICK = [
  { f: 2600, tau: 0.02, amp: 1 },
  { f: 4100, tau: 0.012, amp: 0.7 },
  { f: 6300, tau: 0.007, amp: 0.45 },
  { f: 8800, tau: 0.004, amp: 0.3 },
];

/** Ice: hard click, a short high resonant ring of the sheet, a slight slide, a small low thump. */
export function footstepIce(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 0.3);
  const k = rand(rng, 0.9, 1.1);
  mix(out, knock(sr, rng, 0.1, scaleModes(ICE_CLICK, k), 9000, 0.0012), 0.8);
  const ring = alloc(sr, 0.3);
  const fr = rand(rng, 1300, 1900);
  partials(ring, sr, [
    { f: fr, amp: 1, tau: 0.07 },
    { f: fr * 2.76, amp: 0.4, tau: 0.0155 },
  ]);
  mix(out, ring, 0.18);
  const slide = white(out.length, rng);
  band(slide, sr, 2000, 7000);
  const slidePk = rand(rng, 0.04, 0.06);
  envelope(slide, sr, (t) => bump(t, 0.012, slidePk, 0.15));
  mix(out, slide, 0.12);
  mix(out, thump(sr, rng, 0.1, 115, 60, 0.022, 0.6, 150), 0.45);
  return out;
}

const WOOD_STEP = [
  { f: 180, tau: 0.09, amp: 1 },
  { f: 420, tau: 0.06, amp: 0.7 },
  { f: 870, tau: 0.035, amp: 0.45 },
  { f: 1650, tau: 0.018, amp: 0.22 },
];

/** Hollow wooden floor knock, heel then a lighter toe, plus a little scuff. */
export function footstepWood(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 0.32);
  const k = rand(rng, 0.92, 1.08);
  mix(out, knock(sr, rng, 0.3, scaleModes(WOOD_STEP, k), 1800, 0.006), 1);
  mixAt(out, knock(sr, rng, 0.2, scaleModes(WOOD_STEP, k * 1.06, 0.7), 1500, 0.005), sr, rand(rng, 0.06, 0.09), 0.35);
  const scuff = white(out.length, rng);
  band(scuff, sr, 1500, 5000);
  envelope(scuff, sr, (t) => adEnv(t, 0.002, 0.02));
  mix(out, scuff, 0.12);
  return out;
}

/** Rock: gritty scrape grains over a stony thump. */
export function footstepRock(sr: number, rng: Rng): Float32Array {
  const dur = 0.26;
  const out = alloc(sr, dur);
  const scrape = alloc(sr, dur);
  const pk = rand(rng, 0.015, 0.03);
  const end = rand(rng, 0.12, 0.16);
  grains(scrape, sr, rng, 0, dur, (t) => 3200 * bump(t, 0, pk, end), {
    rateMax: 3200, fMin: 900, fMax: 4500, decayMin: 0.0002, decayMax: 0.0012, noise: 0.8, skew: 1.8,
  });
  band(scrape, sr, 800, 5000);
  mix(out, scrape, 1);
  grains(out, sr, rng, 0, 0.2, () => 60, { rateMax: 60, fMin: 3000, fMax: 8000, decayMin: 0.0003, decayMax: 0.001, skew: 1.5 });
  mix(out, thump(sr, rng, 0.14, rand(rng, 140, 170), 85, 0.028, 0.7, 260), 0.8);
  return out;
}

// ------------------------------------------------------------------ skis

/** Seamless carved-snow hiss for gliding: band noise with snow-texture AM and sparse crackle grains. */
export function skiGlide(sr: number, rng: Rng): Float32Array {
  const dur = 3.9;
  const n = len(sr, dur);
  const hiss = white(n, rng);
  biquad(hiss, sr, 'highpass', 900, 0.7);
  biquad(hiss, sr, 'bandpass', 2900, 0.7);
  biquad(hiss, sr, 'lowpass', 7000, 0.7);
  const tex = smoothNoise(n, sr, rng, 32);
  const slow = smoothNoise(n, sr, rng, 0.9);
  for (let i = 0; i < n; i++) hiss[i] *= (0.72 + 0.28 * tex[i]) * (0.86 + 0.14 * slow[i]);
  const out = new Float32Array(n);
  mix(out, hiss, 1);
  const crk = new Float32Array(n);
  grains(crk, sr, rng, 0, dur, () => 26, { rateMax: 26, fMin: 2000, fMax: 6500, decayMin: 0.0002, decayMax: 0.0009, noise: 0.4, skew: 1.6 });
  band(crk, sr, 1500, 8000);
  mix(out, crk, 1);
  const base = rumble(sr, rng, dur, 170, () => 1);
  for (let i = 0; i < n; i++) base[i] *= 0.8 + 0.2 * tex[i];
  mix(out, base, 0.35);
  return seamless(out, sr, 0.4);
}

/** Seamless carving loop: rougher, lower band with irregular 25–40 Hz edge chatter. */
export function skiCarve(sr: number, rng: Rng): Float32Array {
  const dur = 3.9;
  const n = len(sr, dur);
  const src = white(n, rng);
  band(src, sr, 800, 2500);
  biquad(src, sr, 'peaking', 1400, 1.2, 4);
  const wob = smoothNoise(n, sr, rng, 3);
  const jit = smoothNoise(n, sr, rng, 55);
  const chatter = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    ph += (32 + 7 * wob[i]) / sr;
    const s = 0.5 + 0.5 * fsin(ph);
    chatter[i] = (0.45 + 0.55 * s * s) * (0.8 + 0.2 * jit[i]);
  }
  for (let i = 0; i < n; i++) src[i] *= chatter[i];
  const out = new Float32Array(n);
  mix(out, src, 1);
  const grit = alloc(sr, dur);
  grains(grit, sr, rng, 0, dur, () => 420, { rateMax: 420, fMin: 1000, fMax: 4000, decayMin: 0.0003, decayMax: 0.0015, noise: 0.7, skew: 2 });
  band(grit, sr, 900, 5000);
  mix(out, grit, 0.6);
  const base = rumble(sr, rng, dur, 240, () => 1);
  for (let i = 0; i < n; i++) base[i] *= chatter[i];
  mix(out, base, 0.45);
  return seamless(out, sr, 0.4);
}

/** Pole plant: crunchy stab and a tiny metal tick from the basket/tip. */
export function skiPolePlant(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 0.2);
  const end = rand(rng, 0.06, 0.09);
  mix(out, crunch(sr, rng, 0.14, (t) => bump(t, 0, 0.008, end), 3200, 1300, 6000), 1);
  mix(out, thump(sr, rng, 0.08, 190, 110, 0.018, 0.5, 300), 0.35);
  mixAt(out, ping(sr, rand(rng, 3600, 4400), 1.41, 2, 0.012), sr, 0.003, 0.12);
  return out;
}

export function skiJump(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 0.65);
  mix(out, whoosh(sr, rng, 0.45, 400, 1500, 900, 0.35, 1.2, 0.5), 0.7);
  mix(out, spray(sr, rng, 0.55, (t) => adEnv(t, 0.02, 0.12)), 0.6);
  mix(out, crunch(sr, rng, 0.06, (t) => bump(t, 0, 0.006, 0.05), 2800, 1200, 5000), 0.7);
  return out;
}

export function skiLand(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 0.55);
  mix(out, thump(sr, rng, 0.25, rand(rng, 85, 100), 55, 0.065, 0.7, 220, 2), 1);
  mix(out, crunch(sr, rng, 0.25, (t) => bump(t, 0.004, 0.03, 0.22), 2600, 1000, 6000), 0.7);
  mix(out, spray(sr, rng, 0.5, (t) => adEnv(t - 0.01, 0.02, 0.14)), 0.35);
  return out;
}

export function skiLandHard(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 0.95);
  mix(out, thump(sr, rng, 0.5, rand(rng, 72, 82), 45, 0.13, 0.9, 180, 2.4), 1);
  mix(out, crunch(sr, rng, 0.35, (t) => bump(t, 0.003, 0.03, 0.32), 3000, 900, 6000), 0.8);
  mix(out, spray(sr, rng, 0.8, (t) => adEnv(t - 0.01, 0.03, 0.26)), 0.45);
  const huh = breath(sr, rng, 0.4, (t) => adEnv(t, 0.02, 0.1), (t) => [650 - 120 * t, 1150 - 150 * t, 2500], [180, 220, 360]);
  mixAt(out, huh, sr, 0.14, 0.35);
  return out;
}

const PLASTIC = [
  { f: 1100, tau: 0.012, amp: 1 },
  { f: 2300, tau: 0.008, amp: 0.7 },
  { f: 3700, tau: 0.005, amp: 0.4 },
];

function clack(sr: number, rng: Rng, f: number): Float32Array {
  const out = alloc(sr, 0.08);
  mix(out, ping(sr, f, 1.414, 3, 0.012), 0.5);
  mix(out, knock(sr, rng, 0.08, scaleModes(PLASTIC, f / 2300), 6000, 0.001), 0.8);
  return out;
}

function snap(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 0.08);
  const burst = white(len(sr, 0.004), rng);
  band(burst, sr, 1500, 5000);
  mix(out, burst, 0.8);
  mix(out, knock(sr, rng, 0.08, [
    { f: 900, tau: 0.012, amp: 1 },
    { f: 1900, tau: 0.008, amp: 0.6 },
    { f: 3100, tau: 0.005, amp: 0.3 },
  ], 7000, 0.0015), 1);
  return out;
}

/** Binding closes: two metallic clacks and a firm plastic snap. */
export function skiOn(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 0.36);
  mixAt(out, clack(sr, rng, 2400), sr, 0, 0.6);
  mixAt(out, clack(sr, rng, 2150), sr, 0.075, 0.45);
  mixAt(out, snap(sr, rng), sr, 0.19, 1);
  return out;
}

/** Binding releases: snap first, then the boot clacks free. */
export function skiOff(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 0.36);
  mixAt(out, snap(sr, rng), sr, 0, 0.9);
  mixAt(out, clack(sr, rng, 2250), sr, 0.12, 0.55);
  mixAt(out, clack(sr, rng, 1950), sr, 0.21, 0.35);
  return out;
}

/** Grating scrape over ice/rock: stick-slip pulses through hard resonances + grinding noise. */
export function skiScrape(sr: number, rng: Rng): Float32Array {
  const dur = rand(rng, 0.5, 0.7);
  const n = len(sr, dur);
  const envFn = (t: number) => bump(t, 0, dur * 0.12, dur);
  const pulses = stickSlip(n, sr, rng, (t) => 140 + 70 * Math.sin(t * 9), envFn, 0.45);
  const out = resonate(pulses, sr, [
    { f: rand(rng, 1600, 2000), tau: 0.006, amp: 1 },
    { f: rand(rng, 3000, 3500), tau: 0.004, amp: 0.7 },
    { f: rand(rng, 4800, 5600), tau: 0.003, amp: 0.4 },
  ]);
  const grind = white(n, rng);
  band(grind, sr, 1500, 6500);
  const am = smoothNoise(n, sr, rng, 150);
  for (let i = 0; i < n; i++) grind[i] *= (0.5 + 0.5 * am[i]) * envFn(i / sr);
  mix(out, grind, 0.5);
  mix(out, rumble(sr, rng, dur, 300, envFn), 0.35);
  return out;
}

/** Soft heavy body thud into snow, with compaction crunch and a bit of clothing. */
export function bodyFall(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 0.55);
  mix(out, thump(sr, rng, 0.35, rand(rng, 82, 95), 52, 0.08, 1, 260, 2.2), 1);
  mix(out, crunch(sr, rng, 0.3, (t) => bump(t, 0.004, 0.04, 0.26), 1600, 600, 2600, 0.5), 0.6);
  const squish = white(len(sr, 0.3), rng);
  band(squish, sr, 250, 900);
  envelope(squish, sr, (t) => bump(t, 0, 0.03, 0.25));
  mix(out, squish, 0.6);
  mixAt(out, rustle(sr, rng, 0.25, 0.3), sr, 0.02, 0.18);
  return out;
}

/** Tumbling crash: several diminishing impacts with sprays, a sliding scrape and ski clatter (~1.3 s). */
export function crash(sr: number, rng: Rng): Float32Array {
  const dur = 1.45;
  const out = alloc(sr, dur);
  let t = 0;
  let a = 1;
  for (let k = 0; k < 4; k++) {
    mixAt(out, thump(sr, rng, 0.3, rand(rng, 75, 95), 50, 0.07, 1, 240, 2.2), sr, t, a);
    mixAt(out, crunch(sr, rng, 0.25, (x) => bump(x, 0, 0.025, 0.22), 2600, 900, 5500), sr, t, a * 0.7);
    mixAt(out, spray(sr, rng, 0.4, (x) => adEnv(x, 0.015, 0.1)), sr, t + 0.01, a * 0.4);
    t += rand(rng, 0.22, 0.3);
    a *= rand(rng, 0.62, 0.78);
  }
  const slide = white(out.length, rng);
  band(slide, sr, 1500, 6000);
  const am = smoothNoise(slide.length, sr, rng, 40);
  for (let i = 0; i < slide.length; i++) {
    const tt = i / sr;
    slide[i] *= bump(tt, 0.05, 0.3, 1.4) * (0.6 + 0.4 * am[i]);
  }
  mix(out, slide, 0.22);
  const clk = [
    { f: 700, tau: 0.03, amp: 1 },
    { f: 1600, tau: 0.018, amp: 0.6 },
    { f: 3100, tau: 0.008, amp: 0.3 },
  ];
  mixAt(out, knock(sr, rng, 0.15, clk, 4000), sr, rand(rng, 0.3, 0.5), 0.35);
  mixAt(out, knock(sr, rng, 0.15, scaleModes(clk, 1.2), 4000), sr, rand(rng, 0.6, 0.9), 0.25);
  lowpass1(out, sr, 12000);
  return fades(out, sr, 0, 0.1);
}
