// Pre-rendered instrument notes for the score: a soft felt piano and a celesta / music box.
// Notes are rendered at a handful of root pitches and transposed by playbackRate (±2 semitones max),
// the classic sampler trade-off between memory and timbre fidelity.
import { alloc, fades, gauss, lowpass1, midiHz, mix, partials, white, type Rng } from './dsp';

/** Piano roots every major third from D2 to D6: any note is ≤ 2 semitones from a root. */
export const PIANO_ROOTS = [38, 42, 46, 50, 54, 58, 62, 66, 70, 74, 78, 82, 86] as const;
/** Celesta roots (it sounds an octave up in the score), F#4..D7. */
export const CELESTA_ROOTS = [66, 70, 74, 78, 82, 86, 90, 94, 98] as const;

/** Nearest root and the playback rate that transposes it to `midi`. */
export function nearestRoot(roots: readonly number[], midi: number): { root: number; rate: number } {
  let best = roots[0];
  for (const r of roots) if (Math.abs(r - midi) < Math.abs(best - midi)) best = r;
  return { root: best, rate: Math.pow(2, (midi - best) / 12) };
}

/**
 * Felt piano: inharmonic partials with a two-stage ("double") decay and slightly detuned string pairs that
 * beat, a soft felt attack and a little hammer thump, all through a gentle low-pass. Rendered mono.
 */
export function renderPiano(sr: number, midi: number, rng: Rng): Float32Array {
  const f0 = midiHz(midi);
  const dur = midi < 50 ? 6 : midi < 70 ? 5 : 4;
  const out = alloc(sr, dur);
  const B = 0.00035 * Math.pow(2, (midi - 60) / 24); // inharmonicity grows up the keyboard
  const tauSlow = Math.min(7, 5.2 * Math.pow(130 / f0, 0.5));
  const list: { f: number; amp: number; tau: number; phase: number }[] = [];
  const maxF = Math.min(sr * 0.45, 7500);
  for (let k = 1; k <= 18; k++) {
    const fk = k * f0 * Math.sqrt(1 + B * k * k);
    if (fk > maxF) break;
    // Felt hammer: steep spectral tilt; striking at ~1/8 of the string suppresses partials near 8, 16.
    let a = Math.pow(k, -1.35) * Math.exp(-(k - 1) * 0.22) * (Math.abs(Math.sin(Math.PI * k * 0.125)) + 0.15);
    a *= 1 + 0.12 * gauss(rng);
    const slow = tauSlow / (1 + 0.28 * (k - 1));
    const fast = slow * 0.22;
    const det = 1 + (0.25 + 0.2 * rng()) * 0.0006 * (rng() < 0.5 ? -1 : 1);
    list.push({ f: fk, amp: a * 0.55, tau: fast, phase: rng() * 6.283 });
    list.push({ f: fk * det, amp: a * 0.45, tau: slow, phase: rng() * 6.283 });
  }
  partials(out, sr, list);
  // Hammer thump: a short low-passed noise burst under the attack.
  const hn = white(Math.ceil(sr * 0.04), rng);
  lowpass1(hn, sr, Math.min(3 * f0 + 300, 4000));
  lowpass1(hn, sr, Math.min(3 * f0 + 300, 4000));
  for (let i = 0; i < hn.length; i++) hn[i] *= Math.exp(-i / (sr * 0.008));
  mix(out, hn, 0.9);
  // Felt softness: a few-ms attack instead of a hard edge, then a warm top end.
  const att = Math.ceil(sr * 0.004);
  for (let i = 0; i < att && i < out.length; i++) out[i] *= Math.sin((0.5 * Math.PI * i) / att);
  lowpass1(out, sr, 4200);
  return fades(out, sr, 0, 0.4);
}

/** Celesta / music box: bright, mostly-fundamental bell tone with fast inharmonic sparkle and a mallet tick. */
export function renderCelesta(sr: number, midi: number, rng: Rng): Float32Array {
  const f0 = midiHz(midi);
  const dur = midi > 90 ? 2.2 : 3;
  const out = alloc(sr, dur);
  const tau = 0.95 * Math.pow(880 / f0, 0.3);
  partials(out, sr, [
    { f: f0, amp: 1, tau, phase: 0 },
    { f: f0 * 1.0015, amp: 0.25, tau: tau * 0.8, phase: 1 }, // resonator box beating: keeps it alive
    { f: f0 * 2, amp: 0.08, tau: tau * 0.5, phase: 0.3 },
    { f: f0 * 3.01, amp: 0.16, tau: tau * 0.2, phase: 0.7 },
    { f: f0 * 5.42, amp: 0.1, tau: tau * 0.09, phase: 0.2 },
    { f: f0 * 8.93, amp: 0.05, tau: tau * 0.035, phase: 0.9 },
  ]);
  const tick = white(Math.ceil(sr * 0.006), rng);
  for (let i = 0; i < tick.length; i++) tick[i] *= Math.exp(-i / (sr * 0.0012)) * 0.08;
  mix(out, tick);
  const att = Math.ceil(sr * 0.0015);
  for (let i = 0; i < att; i++) out[i] *= i / att;
  return fades(out, sr, 0, 0.2);
}
