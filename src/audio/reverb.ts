// Synthetic stereo impulse responses for the two ConvolverNodes.
//  - hall:   long lush music hall (~5 s) for the score and the daybreak chord.
//  - valley: outdoor mountain valley (~3 s): late, sparse slope reflections, heavy air damping and a faint
//            late echo off the far ridge. Used as a send for howls, felling, ice and big impacts.
import { band, Biquad, len, lowpass1, rand, white, type Rng, type Stereo } from './dsp';

/** Scale a stereo IR so each channel has unit energy: predictable wet levels regardless of IR length. */
function unitEnergy(ir: Stereo, gain: number): Stereo {
  for (const ch of [ir.l, ir.r]) {
    let e = 0;
    for (let i = 0; i < ch.length; i++) e += ch[i] * ch[i];
    const g = gain / Math.sqrt(Math.max(e, 1e-12));
    for (let i = 0; i < ch.length; i++) ch[i] *= g;
  }
  return ir;
}

/**
 * Exponentially decaying noise with frequency-dependent decay: the signal is split into three bands that each
 * decay with their own RT60, so highs die first (air and surface absorption) and the tail darkens naturally.
 */
function decayingNoise(sr: number, rng: Rng, dur: number, rt: [number, number, number], xover: [number, number]): Float32Array {
  const n = len(sr, dur);
  const src = white(n, rng);
  const lo = new Biquad(sr, 'lowpass', xover[0], 0.7071).run(src.slice());
  const hi = new Biquad(sr, 'highpass', xover[1], 0.7071).run(src.slice());
  const out = new Float32Array(n);
  // Per-sample decay factors for −60 dB at each band's RT60 (ln 1e-3 = −6.9078), applied by recurrence.
  const k0 = Math.exp(-6.9078 / (rt[0] * sr)),
    k1 = Math.exp(-6.9078 / (rt[1] * sr)),
    k2 = Math.exp(-6.9078 / (rt[2] * sr));
  let e0 = 1,
    e1 = 1,
    e2 = 1;
  for (let i = 0; i < n; i++) {
    const mid = src[i] - lo[i] - hi[i];
    out[i] = lo[i] * e0 + mid * e1 + hi[i] * e2;
    e0 *= k0;
    e1 *= k1;
    e2 *= k2;
  }
  return out;
}

export function hallIR(sr: number, rng: Rng): Stereo {
  const dur = 5;
  const pre = Math.round(0.022 * sr);
  const make = () => {
    const tail = decayingNoise(sr, rng, dur, [4.8, 3.6, 1.8], [450, 3200]);
    const out = new Float32Array(len(sr, dur));
    // Density builds over the first ~60 ms (a real hall's tail isn't instantly dense).
    const kb = Math.exp(-1 / (0.035 * sr));
    let b = 1;
    for (let i = 0; i + pre < out.length; i++) {
      out[i + pre] = tail[i] * (1 - b);
      b *= kb;
    }
    // Early reflections.
    for (let k = 0; k < 14; k++) {
      const t = rand(rng, 0.008, 0.09);
      const i = Math.round(t * sr);
      if (i < out.length) out[i] += (rng() < 0.5 ? -1 : 1) * rand(rng, 0.3, 0.8) * (1 - t / 0.1) * 0.35;
    }
    lowpass1(out, sr, 9000);
    return out;
  };
  return unitEnergy({ l: make(), r: make() }, 1);
}

export function valleyIR(sr: number, rng: Rng): Stereo {
  const dur = 3.2;
  const make = (echoT: number) => {
    const n = len(sr, dur);
    const out = new Float32Array(n);
    const tail = decayingNoise(sr, rng, dur, [2.8, 2.2, 0.9], [350, 2500]);
    // Slow build: the sound has to travel to the slopes and back before the valley "answers".
    const start = Math.round(0.03 * sr);
    const kb = Math.exp(-1 / (0.13 * sr));
    let b = 1;
    for (let i = 0; i + start < n; i++) {
      out[i + start] = tail[i] * (1 - b) * 0.8;
      b *= kb;
    }
    // Sparse, smeared slope reflections.
    for (let k = 0; k < 6; k++) {
      const t = rand(rng, 0.12, 0.45);
      const burst = white(Math.round(0.03 * sr), rng);
      band(burst, sr, 150, 2200);
      const a = rand(rng, 0.3, 0.55) * (1 - t);
      const i0 = Math.round(t * sr);
      for (let j = 0; j < burst.length && i0 + j < n; j++) out[i0 + j] += burst[j] * a * Math.exp(-j / (0.008 * sr));
    }
    // Late echo off the far ridge, and a fainter second one.
    for (const [t, a] of [[echoT, 0.35], [echoT * 2.05, 0.14]] as const) {
      const burst = white(Math.round(0.08 * sr), rng);
      band(burst, sr, 120, 1300);
      const i0 = Math.round(t * sr);
      for (let j = 0; j < burst.length && i0 + j < n; j++) {
        const x = j / burst.length;
        out[i0 + j] += burst[j] * a * Math.sin(Math.PI * x) * Math.exp(-3 * x);
      }
    }
    lowpass1(out, sr, 7000);
    return out;
  };
  return unitEnergy({ l: make(rand(rng, 1.0, 1.1)), r: make(rand(rng, 1.12, 1.24)) }, 1);
}
