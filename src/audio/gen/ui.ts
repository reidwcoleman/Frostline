// UI sounds: clean, short, quiet and pleasant. Felt, wood and soft bells rather than beeps.
import { alloc, bump, envelope, fades, len, lowpass1, midiHz, mix, mixAt, partials, pink, saw, stereo, sweep, type Rendered, type Rng } from '../dsp';
import { knock, scaleModes } from './common';
import { renderCelesta } from '../instruments';

/** Tiny soft high tick. */
export function uiHover(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 0.03);
  partials(out, sr, [
    { f: 3150, amp: 1, tau: 0.0032, phase: 0.2 },
    { f: 4870, amp: 0.3, tau: 0.0018, phase: 1.1 },
  ]);
  mix(out, knock(sr, rng, 0.03, [{ f: 1900, tau: 0.004, amp: 0.4 }], 5000, 0.0015), 0.5);
  // Round the very first millisecond: a hover tick should feel soft, not clicky.
  const a = Math.ceil(sr * 0.0007);
  for (let i = 0; i < a; i++) out[i] *= i / a;
  return out;
}

const CLICK = [
  { f: 1850, tau: 0.006, amp: 1 },
  { f: 2920, tau: 0.004, amp: 0.6 },
  { f: 4300, tau: 0.0025, amp: 0.35 },
  { f: 620, tau: 0.009, amp: 0.35 },
];

/** Soft tactile double-transient click (a switch going down, then settling). */
export function uiClick(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 0.08);
  mixAt(out, knock(sr, rng, 0.06, CLICK, 7000, 0.0012), sr, 0, 1);
  mixAt(out, knock(sr, rng, 0.05, scaleModes(CLICK, 0.9, 0.8), 5000, 0.001), sr, 0.017, 0.55);
  return lowpass1(out, sr, 9000);
}

/** Lower, softer single tick. */
export function uiBack(sr: number, rng: Rng): Float32Array {
  const out = knock(sr, rng, 0.07, [
    { f: 1100, tau: 0.006, amp: 1 },
    { f: 1760, tau: 0.004, amp: 0.55 },
    { f: 2640, tau: 0.003, amp: 0.3 },
    { f: 420, tau: 0.01, amp: 0.5 },
  ], 3200, 0.0018);
  return lowpass1(out, sr, 6000);
}

/** Felt-mallet tone: a warm sine with a quiet octave and marimba-ish overtone, soft attack. */
function mallet(sr: number, f: number, dur: number, tau: number): Float32Array {
  const out = alloc(sr, dur);
  partials(out, sr, [
    { f, amp: 1, tau, phase: 0 },
    { f: f * 2, amp: 0.12, tau: tau * 0.4, phase: 0 },
    { f: f * 3.93, amp: 0.05, tau: tau * 0.15, phase: 0 },
  ]);
  const a = Math.ceil(sr * 0.006);
  for (let i = 0; i < a; i++) out[i] *= Math.sin((0.5 * Math.PI * i) / a);
  return fades(out, sr, 0, dur * 0.3); // decay to true zero: a truncated tone clicks
}

/** Airy swish whose band sweeps between f0 and f1, bell-shaped. */
function swish(sr: number, rng: Rng, dur: number, f0: number, f1: number): Float32Array {
  const out = pink(len(sr, dur), rng);
  sweep(out, sr, 'bandpass', (t) => f0 * Math.pow(f1 / f0, t / dur), 1.1);
  return envelope(out, sr, (t) => Math.pow(bump(t, 0, dur * 0.55, dur), 1.5));
}

export function uiOpen(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 0.6);
  mix(out, swish(sr, rng, 0.3, 700, 3400), 0.5);
  mixAt(out, mallet(sr, midiHz(81), 0.45, 0.14), sr, 0.1, 0.9);
  return out;
}

export function uiClose(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 0.6);
  mix(out, swish(sr, rng, 0.28, 3400, 650), 0.5);
  mixAt(out, mallet(sr, midiHz(74), 0.45, 0.12), sr, 0.03, 0.9);
  return out;
}

const WOOD_LOW = [
  { f: 210, tau: 0.05, amp: 1 },
  { f: 505, tau: 0.03, amp: 0.6 },
  { f: 1020, tau: 0.017, amp: 0.3 },
  { f: 1790, tau: 0.009, amp: 0.12 },
];

/** Two muted low wooden knocks: "nope". */
export function uiError(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 0.36);
  mixAt(out, knock(sr, rng, 0.2, WOOD_LOW, 1400, 0.005), sr, 0, 1);
  mixAt(out, knock(sr, rng, 0.2, scaleModes(WOOD_LOW, 0.93), 1300, 0.005), sr, 0.11, 0.85);
  return lowpass1(out, sr, 2200);
}

/** Wooden tap + small warm chime: something was made. */
export function uiCraft(sr: number, rng: Rng): Float32Array {
  const out = alloc(sr, 1.2);
  mix(out, knock(sr, rng, 0.12, [
    { f: 620, tau: 0.03, amp: 1 },
    { f: 1450, tau: 0.015, amp: 0.6 },
    { f: 2800, tau: 0.008, amp: 0.3 },
  ], 4000, 0.003), 0.8);
  const f = midiHz(86);
  const chime = alloc(sr, 1.15);
  partials(chime, sr, [
    { f, amp: 1, tau: 0.42, phase: 0 },
    { f: f * 1.0021, amp: 0.45, tau: 0.38, phase: 0.5 },
    { f: f * 2, amp: 0.2, tau: 0.18, phase: 0 },
    { f: f * 3, amp: 0.06, tau: 0.08, phase: 0 },
    { f: f * 5.4, amp: 0.04, tau: 0.03, phase: 0 },
  ]);
  const a = Math.ceil(sr * 0.003);
  for (let i = 0; i < a; i++) chime[i] *= i / a;
  fades(chime, sr, 0, 0.3);
  mixAt(out, chime, sr, 0.045, 0.5);
  return out;
}

/** Single soft celesta ding. */
export function uiToast(sr: number, rng: Rng): Float32Array {
  const d = renderCelesta(sr, 81, rng);
  return d.subarray(0, Math.min(d.length, len(sr, 1.6))).slice();
}

/**
 * Daybreak: a warm swelling D major 9 chord — detuned saw pad through an opening low-pass — with soft bells
 * arpeggiated on top. Stereo (it's 2D UI), slow attack, ~5 s tail.
 */
export function uiDaybreak(sr: number, rng: Rng): Rendered {
  const dur = 6.5;
  const n = len(sr, dur);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const chord = [50, 57, 61, 64, 66, 73]; // D3 A3 C#4 E4 F#4 C#5
  for (let k = 0; k < chord.length; k++) {
    const f = midiHz(chord[k]);
    const a = saw(n, sr, f * Math.pow(2, -5 / 1200), rng());
    const b = saw(n, sr, f * Math.pow(2, 5 / 1200), rng());
    const g = k === chord.length - 1 ? 0.5 : 1;
    const pan = (k % 2 === 0 ? -1 : 1) * 0.25;
    for (let i = 0; i < n; i++) {
      L[i] += g * (a[i] * (0.65 - pan * 0.5) + b[i] * 0.35);
      R[i] += g * (b[i] * (0.65 + pan * 0.5) + a[i] * 0.35);
    }
  }
  // Low D2 sine for warmth.
  const sub = alloc(sr, dur);
  partials(sub, sr, [{ f: midiHz(38), amp: 0.7, tau: 100, phase: 0 }]);
  mix(L, sub);
  mix(R, sub);
  const cut = (t: number) => 350 + 1900 * bump(t, 0, 2.4, 6.5);
  sweep(L, sr, 'lowpass', cut, 0.8);
  sweep(R, sr, 'lowpass', cut, 0.8);
  const env = (t: number) => {
    const rise = t < 1.9 ? Math.pow(t / 1.9, 2) * (3 - 2 * (t / 1.9)) : 1;
    return rise * (t < 2.9 ? 1 : Math.exp(-(t - 2.9) / 0.95));
  };
  envelope(L, sr, env);
  envelope(R, sr, env);
  // Bells.
  const bells: [number, number, number][] = [
    [81, 0.45, -0.5],
    [86, 0.8, 0.4],
    [90, 1.15, -0.2],
    [88, 1.55, 0.5],
    [93, 2.05, -0.4],
  ];
  for (const [m, t, pan] of bells) {
    const b = renderCelesta(sr, m, rng);
    const g = 0.22;
    mixAt(L, b, sr, t, g * (1 - pan) * 0.7);
    mixAt(R, b, sr, t, g * (1 + pan) * 0.7);
  }
  return stereo(L, R);
}
