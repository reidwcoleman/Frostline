// The player's body: hurt, breath, death, eating, healing, heartbeat. Breath is formant-shaped noise only —
// no pitched "voice", which is what keeps these from sounding cheesy.
import {
  adEnv, alloc, band, bump, envelope, fades, formants, len, lowpass1, midiHz, mix, mixAt, partials, rand, saw,
  smoothNoise, sweep, white, type Rng,
} from '../dsp';
import { breath, crunch, rumble, rustle, thump } from './common';

/** Body thump with a gentle pitch drop (thin wrapper so the body sounds share one character). */
const softThump = (sr: number, rng: Rng, dur: number, fs: number, fe: number, tau: number) =>
  thump(sr, rng, dur, fs, fe, tau, 0.5, 160, 1.4);

/** Impact thud + a sharp exhale ("hh-uh"), with just a whisper of voicing for body. */
export function playerHurt(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 0.55);
  mix(out, softThump(sr, rng, 0.2, rand(rng, 100, 115), 65, 0.045), 0.45);
  const f1 = rand(rng, 680, 780);
  const ex = breath(sr, rng, 0.45, (t) => adEnv(t, 0.012, 0.11), (t) => [f1 - 180 * t, 1250 - 200 * t, 2600], [160, 200, 320]);
  mixAt(out, ex, sr, 0.015, 3.2);
  // Faint voiced grunt under the breath, heavily formant-filtered so it reads as effort, not a voice.
  const n = len(sr, 0.3);
  const v = saw(n, sr, (t) => 135 - 40 * t, 0);
  const vf = formants(v, sr, 3, (t, f, b, g) => {
    f[0] = f1 - 150 * t; f[1] = 1200; f[2] = 2500;
    b[0] = 120; b[1] = 160; b[2] = 250;
    g[0] = 1; g[1] = 0.5; g[2] = 0.2;
  });
  envelope(vf, sr, (t) => adEnv(t, 0.02, 0.07));
  mixAt(out, vf, sr, 0.02, 0.3);
  return out;
}

/** Soft visible-breath exhale in the cold: breathy "hhhoo", rise-fall ~0.9 s. */
export function playerBreathCold(sr: number, rng: Rng): Float32Array {
  const dur = rand(rng, 0.85, 1.0);
  const f1 = rand(rng, 420, 520);
  const f2 = rand(rng, 1250, 1550);
  const out = breath(sr, rng, dur, (t) => Math.pow(bump(t, 0, dur * 0.3, dur), 1.3), (t) => [f1 - 40 * t, f2 - 150 * t, 2600], [260, 320, 420], [1, 0.7, 0.4]);
  band(out, sr, 250, 5500);
  const n = out.length;
  const turb = smoothNoise(n, sr, rng, 25);
  for (let i = 0; i < n; i++) out[i] *= 0.9 + 0.1 * turb[i];
  return out;
}

/** Death: low boom, a long fading exhale with a tremor, and a low tonal swell underneath. */
export function playerDeath(sr: number, rng: Rng): Float32Array {
  const dur = 5;
  const out = alloc(sr, dur);
  mix(out, softThump(sr, rng, 1.6, 52, 28, 0.7), 1);
  mix(out, rumble(sr, rng, 1.2, 90, (t) => adEnv(t, 0.003, 0.4)), 0.8);
  const ex = breath(sr, rng, 4.2, (t) => adEnv(t, 0.12, 0.85) * (1 - 0.25 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 6 * t))), (t) => [
    700 - 110 * t, 1200 - 110 * t, 2500 - 100 * t,
  ], [200, 260, 380]);
  mixAt(out, ex, sr, 0.25, 2.2);
  const n = len(sr, dur);
  const swell = new Float32Array(n);
  for (const m of [38, 45, 50]) mix(swell, saw(n, sr, midiHz(m) * (1 + 0.002 * (rng() - 0.5)), rng()), m === 38 ? 1 : 0.6);
  lowpass1(swell, sr, 320);
  lowpass1(swell, sr, 320);
  envelope(swell, sr, (t) => bump(t, 0.5, 2.6, 5));
  mix(out, swell, 0.6);
  return out;
}

/** 3–4 wet crunchy chews. */
export function playerEat(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 1.35);
  const chews = 3 + (rng() < 0.5 ? 1 : 0);
  let t = 0.03;
  for (let k = 0; k < chews; k++) {
    const a = k === 0 ? 1 : rand(rng, 0.55, 0.85);
    const end = rand(rng, 0.09, 0.14);
    mixAt(out, crunch(sr, rng, 0.16, (x) => bump(x, 0, 0.02, end), 2200, 700, 3500, 0.5), sr, t, a * (k === 0 ? 1 : 0.7));
    const wet = white(len(sr, 0.14), rng);
    sweep(wet, sr, 'bandpass', (x) => 950 * Math.pow(0.4, x / 0.12), 3);
    envelope(wet, sr, (x) => adEnv(x, 0.006, 0.035));
    mixAt(out, wet, sr, t + 0.01, a * 0.6);
    const smack = alloc(sr, 0.05);
    partials(smack, sr, [{ f: rand(rng, 380, 520), amp: 1, tau: 0.008, phase: 0 }]);
    mixAt(out, smack, sr, t + rand(rng, 0.05, 0.08), a * 0.15);
    t += rand(rng, 0.24, 0.32);
  }
  return out;
}

/** Cloth rustle + a soft warm two-note chime. */
export function playerHeal(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 1.6);
  mix(out, rustle(sr, rng, 0.35, 0.3), 0.6);
  for (const [m, t, g] of [[74, 0.18, 0.5], [81, 0.36, 0.42]] as const) {
    const f = midiHz(m);
    const c = alloc(sr, 1.2);
    partials(c, sr, [
      { f, amp: 1, tau: 0.35, phase: 0 },
      { f: f * 1.002, amp: 0.4, tau: 0.3, phase: 0.4 },
      { f: f * 2, amp: 0.2, tau: 0.15, phase: 0 },
      { f: f * 3, amp: 0.05, tau: 0.06, phase: 0 },
    ]);
    const a = Math.ceil(sr * 0.008);
    for (let i = 0; i < a; i++) c[i] *= Math.sin((0.5 * Math.PI * i) / a);
    fades(c, sr, 0, 0.35);
    mixAt(out, c, sr, t, g);
  }
  return out;
}

/** Lub-dub at exactly 1 s so it loops at 60 bpm; the Ambience also schedules single beats for faster rates. */
export function heartbeat(sr: number, rng: Rng): Float32Array {
  const n = Math.round(sr * 1.0);
  const out = new Float32Array(n);
  const beat = (t0: number, fs: number, fe: number, tau: number, a: number) => {
    mixAt(out, thump(sr, rng, 0.3, fs, fe, tau, 0.3, 200, 2.5), sr, t0, a);
    // The valve "knock": what makes a heartbeat readable on laptop speakers.
    const k = alloc(sr, 0.12);
    partials(k, sr, [
      { f: fs * 2.1, amp: 0.5, tau: 0.018 },
      { f: fs * 3.3, amp: 0.2, tau: 0.01 },
    ]);
    mixAt(out, k, sr, t0 + 0.004, a);
  };
  beat(0.03, 78, 46, 0.05, 1);
  beat(0.31, 90, 52, 0.04, 0.7);
  lowpass1(out, sr, 900);
  // The last sample must be ~0 for a clean loop: the tail is silent by construction; enforce it.
  const f = Math.ceil(sr * 0.02);
  for (let i = 0; i < f; i++) out[n - 1 - i] *= i / f;
  return out;
}
