// Tiny offline DSP toolkit. Everything here renders into Float32Arrays at init time (usually inside the
// synth worker), so clarity beats micro-optimisation — but the inner loops still avoid allocation and
// per-sample closures where it is cheap to do so, because the whole bank must synthesise in well under a second.
import { mulberry32, type Rng } from '../core/math';

export type { Rng };

export interface Stereo {
  l: Float32Array;
  r: Float32Array;
}
/** A generator's output: mono, or a stereo pair of equal length. */
export type Rendered = Float32Array | Stereo;
/** Frequency either constant or as a function of time (seconds). */
export type Freq = number | ((t: number) => number);

export const TAU = Math.PI * 2;

export const makeRng = (seed: number): Rng => mulberry32(seed);
export const rand = (rng: Rng, a: number, b: number) => a + (b - a) * rng();
/** Log-uniform: good for frequencies and decay times, where perception is logarithmic. */
export const randLog = (rng: Rng, a: number, b: number) => a * Math.pow(b / a, rng());
/** Roughly N(0,1) (Irwin–Hall with 4 terms). Cheap, bounded, good enough for jitter. */
export const gauss = (rng: Rng) => (rng() + rng() + rng() + rng() - 2) * 1.7320508;
export const pick = <T>(rng: Rng, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length) % arr.length];
export const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
export const dbToGain = (d: number) => Math.pow(10, d / 20);
export const gainToDb = (g: number) => 20 * Math.log10(Math.max(g, 1e-12));
export const len = (sr: number, sec: number) => Math.max(1, Math.ceil(sr * sec));
export const alloc = (sr: number, sec: number) => new Float32Array(len(sr, sec));
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smooth01 = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
export const isStereo = (r: Rendered): r is Stereo => !(r instanceof Float32Array);

// ------------------------------------------------------------------ noise

export function white(n: number, rng: Rng, amp = 1): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (rng() * 2 - 1) * amp;
  return out;
}

/** Pink (−3 dB/oct) noise, Paul Kellet's refined filter. Peak ≈ ±1. */
export function pink(n: number, rng: Rng): Float32Array {
  const out = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = rng() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return out;
}

/** Brown (−6 dB/oct) noise via a leaky integrator, so it never drifts off to DC. */
export function brown(n: number, rng: Rng): Float32Array {
  const out = new Float32Array(n);
  let y = 0;
  for (let i = 0; i < n; i++) {
    y = (y + 0.02 * (rng() * 2 - 1)) / 1.02;
    out[i] = y * 3.5;
  }
  return out;
}

/**
 * Smooth random control signal in [-1, 1]: random points at `rate` Hz joined by cosine interpolation.
 * Used for gusts, amplitude textures, pitch wander. Smoothstep-interpolated (C1, cheaper than cosine).
 */
export function smoothNoise(n: number, sr: number, rng: Rng, rate: number): Float32Array {
  const out = new Float32Array(n);
  const step = Math.max(1, sr / rate);
  let a = rng() * 2 - 1;
  let b = rng() * 2 - 1;
  let pos = 0;
  for (let i = 0; i < n; i++) {
    const f = pos / step;
    out[i] = a + (b - a) * (f * f * (3 - 2 * f));
    pos++;
    if (pos >= step) {
      pos -= step;
      a = b;
      b = rng() * 2 - 1;
    }
  }
  return out;
}

// ------------------------------------------------------------------ filters

export type BiquadType = 'lowpass' | 'highpass' | 'bandpass' | 'peaking' | 'notch' | 'lowshelf' | 'highshelf';

/** RBJ-cookbook biquad, direct form I (robust when coefficients change per block). */
export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(private sr: number, type?: BiquadType, freq?: number, q?: number, gainDb?: number) {
    if (type && freq !== undefined) this.set(type, freq, q, gainDb);
  }

  set(type: BiquadType, freq: number, q = 0.7071, gainDb = 0): this {
    const f = Math.min(Math.max(freq, 10), this.sr * 0.49);
    const w = (TAU * f) / this.sr;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const Q = Math.max(q, 0.05);
    const alpha = sw / (2 * Q);
    let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
    switch (type) {
      case 'lowpass':
        b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case 'highpass':
        b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case 'bandpass':
        b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case 'notch':
        b0 = 1; b1 = -2 * cw; b2 = 1; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case 'peaking': {
        const A = Math.pow(10, gainDb / 40);
        b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
        break;
      }
      case 'lowshelf':
      case 'highshelf': {
        const A = Math.pow(10, gainDb / 40);
        const s = 2 * Math.sqrt(A) * alpha;
        if (type === 'lowshelf') {
          b0 = A * (A + 1 - (A - 1) * cw + s); b1 = 2 * A * (A - 1 - (A + 1) * cw); b2 = A * (A + 1 - (A - 1) * cw - s);
          a0 = A + 1 + (A - 1) * cw + s; a1 = -2 * (A - 1 + (A + 1) * cw); a2 = A + 1 + (A - 1) * cw - s;
        } else {
          b0 = A * (A + 1 + (A - 1) * cw + s); b1 = -2 * A * (A - 1 + (A + 1) * cw); b2 = A * (A + 1 + (A - 1) * cw - s);
          a0 = A + 1 - (A - 1) * cw + s; a1 = 2 * (A - 1 - (A + 1) * cw); a2 = A + 1 - (A - 1) * cw - s;
        }
        break;
      }
    }
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
    return this;
  }

  reset(): this {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
    return this;
  }

  tick(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }

  /** Filter in place over [from, to). */
  run(buf: Float32Array, from = 0, to = buf.length): Float32Array {
    for (let i = from; i < to; i++) buf[i] = this.tick(buf[i]);
    return buf;
  }
}

/** Static biquad over a whole buffer, in place. */
export function biquad(buf: Float32Array, sr: number, type: BiquadType, freq: number, q = 0.7071, gainDb = 0): Float32Array {
  return new Biquad(sr, type, freq, q, gainDb).run(buf);
}

/** Two cascaded passes: steeper (24 dB/oct) slopes for band limiting. */
export function biquad2(buf: Float32Array, sr: number, type: BiquadType, freq: number, q = 0.7071): Float32Array {
  new Biquad(sr, type, freq, q).run(buf);
  return new Biquad(sr, type, freq, q).run(buf);
}

/** Band-limit to [lo, hi] with a 12 dB/oct high-pass and low-pass. */
export function band(buf: Float32Array, sr: number, lo: number, hi: number): Float32Array {
  if (lo > 0) new Biquad(sr, 'highpass', lo, 0.7071).run(buf);
  if (hi < sr / 2) new Biquad(sr, 'lowpass', hi, 0.7071).run(buf);
  return buf;
}

/** Time-varying biquad: cutoff (and optionally Q) re-evaluated every `block` samples. In place. */
export function sweep(
  buf: Float32Array,
  sr: number,
  type: BiquadType,
  freqAt: (t: number) => number,
  q: number | ((t: number) => number) = 0.7071,
  block = 32,
  gainDb = 0,
): Float32Array {
  const f = new Biquad(sr);
  const n = buf.length;
  for (let i = 0; i < n; i += block) {
    const t = i / sr;
    f.set(type, freqAt(t), typeof q === 'number' ? q : q(t), gainDb);
    const end = Math.min(n, i + block);
    for (let j = i; j < end; j++) buf[j] = f.tick(buf[j]);
  }
  return buf;
}

/** One-pole low-pass in place (6 dB/oct, very smooth: good for "warming" and envelopes). */
export function lowpass1(buf: Float32Array, sr: number, fc: number): Float32Array {
  const a = 1 - Math.exp((-TAU * fc) / sr);
  let y = 0;
  for (let i = 0; i < buf.length; i++) {
    y += a * (buf[i] - y);
    buf[i] = y;
  }
  return buf;
}

/** One-pole high-pass in place. */
export function highpass1(buf: Float32Array, sr: number, fc: number): Float32Array {
  const a = Math.exp((-TAU * fc) / sr);
  let x1 = 0,
    y = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    y = a * (y + x - x1);
    x1 = x;
    buf[i] = y;
  }
  return buf;
}

/** DC blocker (~10–20 Hz high-pass) so asymmetric synthesis never leaves an offset that clicks on stop. */
export function dcBlock(buf: Float32Array, sr: number, fc = 15): Float32Array {
  return highpass1(buf, sr, fc);
}

/**
 * Two-pole resonator ("modal" mode). Impulse response ≈ amp · e^(−t/tau) · sin(2πft), so a bank of these
 * excited by a click is a struck object: wood, metal, ice.
 */
export class Resonator {
  private c1 = 0;
  private c2 = 0;
  private g = 0;
  private y1 = 0;
  private y2 = 0;
  constructor(private sr: number, f: number, tau: number, amp = 1) {
    this.set(f, tau, amp);
  }
  set(f: number, tau: number, amp = 1): this {
    const w = (TAU * Math.min(f, this.sr * 0.49)) / this.sr;
    const r = Math.exp(-1 / (Math.max(tau, 1e-4) * this.sr));
    this.c1 = 2 * r * Math.cos(w);
    this.c2 = -r * r;
    this.g = amp * Math.sin(w);
    return this;
  }
  tick(x: number): number {
    const y = this.g * x + this.c1 * this.y1 + this.c2 * this.y2;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

export interface Mode {
  f: number; // Hz
  tau: number; // amplitude decay time constant (s)
  amp: number;
}

/** Drive a bank of resonators with an exciter; returns a new buffer of n samples. */
export function modal(n: number, sr: number, modes: readonly Mode[], exciter: Float32Array): Float32Array {
  const out = new Float32Array(n);
  const ex = exciter.length;
  for (const m of modes) {
    const r = new Resonator(sr, m.f, m.tau, m.amp);
    // Stop once the mode has decayed below −90 dB: saves most of the work for short modes.
    const end = Math.min(n, ex + Math.ceil(m.tau * 10.4 * sr));
    for (let i = 0; i < end; i++) out[i] += r.tick(i < ex ? exciter[i] : 0);
  }
  return out;
}

/** Short exciter: an impulse followed by a burst of low-passed noise (hardness = cutoff in Hz). */
export function exciter(sr: number, rng: Rng, dur: number, hardness: number): Float32Array {
  const n = len(sr, dur);
  const out = white(n, rng);
  lowpass1(out, sr, hardness);
  lowpass1(out, sr, hardness);
  for (let i = 0; i < n; i++) out[i] *= Math.exp((-5 * i) / n);
  out[0] += 1;
  return out;
}

/**
 * Parallel formant filter bank (vowel resonances). `at` fills per-block centre frequencies, bandwidths and gains
 * so formants can morph (oo → ah → oo) over time.
 */
export function formants(
  src: Float32Array,
  sr: number,
  count: number,
  at: (t: number, f: Float64Array, bw: Float64Array, g: Float64Array) => void,
  block = 64,
): Float32Array {
  const fs = new Float64Array(count);
  const bws = new Float64Array(count);
  const gs = new Float64Array(count);
  const filters: Biquad[] = [];
  for (let k = 0; k < count; k++) filters.push(new Biquad(sr));
  const n = src.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += block) {
    at(i / sr, fs, bws, gs);
    for (let k = 0; k < count; k++) filters[k].set('bandpass', fs[k], fs[k] / Math.max(bws[k], 1));
    const end = Math.min(n, i + block);
    for (let j = i; j < end; j++) {
      const x = src[j];
      let s = 0;
      for (let k = 0; k < count; k++) s += filters[k].tick(x) * gs[k];
      out[j] = s;
    }
  }
  return out;
}

// ------------------------------------------------------------------ oscillators

/**
 * Evaluate fn(t) every `step` samples and linearly interpolate to a per-sample array. Contours, envelopes and
 * frequency glides are smooth, so evaluating closures per sample would just burn synthesis time.
 */
export function ctl(n: number, sr: number, fn: (t: number) => number, step = 16): Float32Array {
  const out = new Float32Array(n);
  let prev = fn(0);
  for (let i = 0; i < n; i += step) {
    const next = fn((i + step) / sr);
    const end = Math.min(n, i + step);
    const d = (next - prev) / step;
    for (let j = i; j < end; j++) out[j] = prev + d * (j - i);
    prev = next;
  }
  return out;
}

/** Per-sample frequency array for any Freq (constant → filled, function → control-rate interpolated). */
export function freqs(n: number, sr: number, freq: Freq): Float32Array {
  return typeof freq === 'number' ? new Float32Array(n).fill(freq) : ctl(n, sr, freq, 8);
}

const SIN_N = 4096;
const SIN_TAB = new Float32Array(SIN_N + 1);
for (let i = 0; i <= SIN_N; i++) SIN_TAB[i] = Math.sin((2 * Math.PI * i) / SIN_N);

/** Table sine of a phase in cycles (any real): ~1e-6 error, several times cheaper than Math.sin. */
export function fsin(phase: number): number {
  const x = (phase - Math.floor(phase)) * SIN_N;
  const xi = x | 0;
  const f = x - xi;
  const i = xi & (SIN_N - 1); // x can round to exactly SIN_N
  return SIN_TAB[i] + (SIN_TAB[i + 1] - SIN_TAB[i]) * f;
}

/** Sine oscillator. */
export function sine(n: number, sr: number, freq: Freq, phase0 = 0): Float32Array {
  const out = new Float32Array(n);
  const fr = freqs(n, sr, freq);
  let ph = phase0;
  for (let i = 0; i < n; i++) {
    out[i] = fsin(ph);
    ph += fr[i] / sr;
    if (ph >= 1) ph -= 1;
  }
  return out;
}

function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/** Band-limited sawtooth (polyBLEP), so bright glottal sources don't alias into fizz. */
export function saw(n: number, sr: number, freq: Freq, phase0 = 0): Float32Array {
  const out = new Float32Array(n);
  const fr = freqs(n, sr, freq);
  let ph = phase0;
  for (let i = 0; i < n; i++) {
    const dt = Math.min(fr[i] / sr, 0.5);
    out[i] = 2 * ph - 1 - polyBlep(ph, dt);
    ph += dt;
    if (ph >= 1) ph -= 1;
  }
  return out;
}

/** Band-limited square (polyBLEP). */
export function square(n: number, sr: number, freq: Freq, duty = 0.5): Float32Array {
  const out = new Float32Array(n);
  const fr = freqs(n, sr, freq);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const dt = Math.min(fr[i] / sr, 0.5);
    let v = ph < duty ? 1 : -1;
    v += polyBlep(ph, dt);
    let p2 = ph - duty;
    if (p2 < 0) p2 += 1;
    v -= polyBlep(p2, dt);
    out[i] = v;
    ph += dt;
    if (ph >= 1) ph -= 1;
  }
  return out;
}

/** Triangle (naive; its harmonics fall at 12 dB/oct so aliasing is inaudible at our pitches). */
export function tri(n: number, sr: number, freq: Freq, phase0 = 0): Float32Array {
  const out = new Float32Array(n);
  const fr = freqs(n, sr, freq);
  let ph = phase0;
  for (let i = 0; i < n; i++) {
    out[i] = 1 - 4 * Math.abs(ph - 0.5);
    ph += fr[i] / sr;
    if (ph >= 1) ph -= Math.floor(ph);
  }
  return out;
}

/** Two-operator FM: carrier fc, modulator fc·ratio, time-varying index. Metallic pings and bells. */
export function fm(n: number, sr: number, fc: number, ratio: number, index: (t: number) => number, phase0 = 0): Float32Array {
  const out = new Float32Array(n);
  const idx = ctl(n, sr, index, 8);
  let pc = phase0,
    pm = 0;
  const dc = fc / sr,
    dm = (fc * ratio) / sr;
  for (let i = 0; i < n; i++) {
    out[i] = fsin(pc + (idx[i] * fsin(pm)) / TAU);
    pc += dc;
    pm += dm;
    if (pc >= 1) pc -= 1;
    if (pm >= 1) pm -= 1;
  }
  return out;
}

/**
 * Karplus–Strong plucked string. `t60` is the time for the tone to fall 60 dB; `bright` (0..1) shapes the
 * excitation noise. Used for the bow string twang and the shaft "quiver".
 */
export function pluck(n: number, sr: number, freq: number, rng: Rng, t60: number, bright = 0.6): Float32Array {
  const out = new Float32Array(n);
  const N = Math.max(2, Math.round(sr / freq - 0.5));
  const line = new Float32Array(N);
  let lp = 0,
    mean = 0;
  for (let i = 0; i < N; i++) {
    lp += (rng() * 2 - 1 - lp) * (0.1 + 0.9 * bright);
    line[i] = lp;
    mean += lp;
  }
  mean /= N;
  for (let i = 0; i < N; i++) line[i] -= mean;
  const loss = Math.pow(10, -3 / (Math.max(t60, 0.01) * freq));
  let idx = 0;
  for (let i = 0; i < n; i++) {
    const a = line[idx];
    const nx = idx + 1 === N ? 0 : idx + 1;
    out[i] = a;
    line[idx] = loss * 0.5 * (a + line[nx]);
    idx = nx;
  }
  return out;
}

/**
 * Sum of exponentially decaying sine partials (recursive oscillators: two multiplies per sample per
 * partial). Each partial stops once it is inaudible. Bells, chimes, felt piano.
 */
export function partials(
  out: Float32Array,
  sr: number,
  list: readonly { f: number; amp: number; tau: number; phase?: number }[],
  offset = 0,
): Float32Array {
  const n = out.length;
  for (const p of list) {
    if (p.f >= sr * 0.45 || p.amp === 0) continue;
    const w = (TAU * p.f) / sr;
    const r = Math.exp(-1 / (p.tau * sr));
    const c = 2 * Math.cos(w);
    const ph = p.phase ?? 0;
    // y[k] = A r^k sin(wk + ph) computed recursively.
    let y1 = p.amp * Math.sin(ph - w) / r;
    let y2 = (p.amp * Math.sin(ph - 2 * w)) / (r * r);
    // Run until the partial is ~−90 dB below unity (quiet partials stop sooner).
    const end = Math.min(n, offset + Math.ceil(p.tau * Math.max(0, Math.log(Math.abs(p.amp) / 3e-5)) * sr));
    const rc = r * c,
      r2 = r * r;
    for (let i = offset; i < end; i++) {
      const y = rc * y1 - r2 * y2;
      out[i] += y;
      y2 = y1;
      y1 = y;
    }
  }
  return out;
}

// ------------------------------------------------------------------ envelopes

/** Linear-attack, exponential-decay envelope value at time t. */
export const adEnv = (t: number, attack: number, tau: number) =>
  t < 0 ? 0 : t < attack ? Math.sin((0.5 * Math.PI * t) / attack) : Math.exp(-(t - attack) / tau);

/** Classic ADSR value; `dur` is gate length (release starts there). */
export function adsr(t: number, a: number, d: number, s: number, r: number, dur: number): number {
  if (t < 0) return 0;
  let v: number;
  if (t < a) v = t / a;
  else if (t < a + d) v = 1 - (1 - s) * ((t - a) / d);
  else v = s;
  if (t > dur) {
    const lvl = dur < a ? dur / a : dur < a + d ? 1 - (1 - s) * ((dur - a) / d) : s;
    v = Math.min(v, lvl) * Math.exp(-(t - dur) / Math.max(r / 4.6, 1e-4));
  }
  return v;
}

/** Smooth bump: rises from 0 at `start`, peaks at `peak`, falls to 0 at `end` (raised-cosine halves). */
export function bump(t: number, start: number, peak: number, end: number): number {
  if (t <= start || t >= end) return 0;
  if (t < peak) return 0.5 - 0.5 * Math.cos((Math.PI * (t - start)) / (peak - start));
  return 0.5 + 0.5 * Math.cos((Math.PI * (t - peak)) / (end - peak));
}

/** Multiply a buffer by fn(t), in place. fn is evaluated every 8 samples (6 kHz control rate) and interpolated. */
export function envelope(buf: Float32Array, sr: number, fn: (t: number) => number, offset = 0): Float32Array {
  const step = 8;
  let prev = fn(0);
  for (let i = offset; i < buf.length; i += step) {
    const next = fn((i - offset + step) / sr);
    const end = Math.min(buf.length, i + step);
    const d = (next - prev) / step;
    for (let j = i; j < end; j++) buf[j] *= prev + d * (j - i);
    prev = next;
  }
  return buf;
}

/** Short raised-cosine fades at both ends: every one-shot must start and end at zero (no clicks). */
export function fades(buf: Float32Array, sr: number, fadeIn = 0.002, fadeOut = 0.01): Float32Array {
  const n = buf.length;
  const fi = Math.min(n, Math.ceil(fadeIn * sr));
  const fo = Math.min(n, Math.ceil(fadeOut * sr));
  for (let i = 0; i < fi; i++) buf[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fi);
  for (let i = 0; i < fo; i++) buf[n - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fo);
  return buf;
}

// ------------------------------------------------------------------ granular textures

export interface GrainOpts {
  /** Max rate used for thinning; rateAt must never exceed it. */
  rateMax: number;
  fMin: number;
  fMax: number;
  decayMin: number; // s
  decayMax: number;
  /** Amplitude envelope over time (default 1). */
  amp?: (t: number) => number;
  /** 0 = pure damped sines (pitched ticks), 1 = pure noise grains (dry grit). */
  noise?: number;
  /** Exponent on the random amplitude: higher = more small grains and a few big ones. */
  skew?: number;
}

/**
 * Poisson-scattered micro grains (damped sinusoids and/or noise ticks) between `from` and `to` seconds, added to
 * `out`. This is the core of every crunch, crackle, spray and grit texture: density envelopes shape the gesture.
 */
export function grains(out: Float32Array, sr: number, rng: Rng, from: number, to: number, rateAt: (t: number) => number, o: GrainOpts): Float32Array {
  const n = out.length;
  const skew = o.skew ?? 2;
  const noiseMix = o.noise ?? 0;
  let t = from;
  for (;;) {
    t += -Math.log(1 - rng() * 0.999999) / o.rateMax;
    if (t >= to) break;
    if (rng() * o.rateMax > rateAt(t)) continue; // thinning → inhomogeneous Poisson process
    const i0 = Math.floor(t * sr);
    if (i0 >= n) break;
    const f = randLog(rng, o.fMin, o.fMax);
    const tau = randLog(rng, o.decayMin, o.decayMax);
    const a = (o.amp ? o.amp(t) : 1) * Math.pow(rng(), skew) * (rng() < 0.5 ? -1 : 1);
    const gl = Math.min(n - i0, Math.ceil(tau * 7 * sr));
    const w = (TAU * f) / sr;
    const ph = rng() * TAU;
    const k = Math.exp(-1 / (tau * sr));
    if (rng() < noiseMix) {
      let e = a;
      for (let j = 0; j < gl; j++) {
        out[i0 + j] += e * (rng() * 2 - 1);
        e *= k;
      }
    } else {
      // Damped sinusoid by recurrence: y[j] = 2k·cos(w)·y[j−1] − k²·y[j−2].
      const c = 2 * k * Math.cos(w),
        k2 = k * k;
      let y2 = (a * Math.sin(ph - w)) / k;
      let y1 = a * Math.sin(ph);
      out[i0] += y1;
      for (let j = 1; j < gl; j++) {
        const y = c * y1 - k2 * y2;
        out[i0 + j] += y;
        y2 = y1;
        y1 = y;
      }
    }
  }
  return out;
}

/**
 * Stick–slip pulse train (creaks, hinges, bow limbs): impulses whose rate follows rateAt(t) with jitter,
 * scaled by ampAt(t). Feed the result through resonators for the "material".
 */
export function stickSlip(n: number, sr: number, rng: Rng, rateAt: (t: number) => number, ampAt: (t: number) => number, jitter = 0.25): Float32Array {
  const out = new Float32Array(n);
  let t = 0;
  while (t < n / sr) {
    const r = Math.max(rateAt(t), 0.5);
    t += (1 / r) * (1 + jitter * (rng() * 2 - 1));
    const i = Math.floor(t * sr);
    if (i >= n) break;
    const a = ampAt(t) * (0.6 + 0.4 * rng());
    out[i] += a;
    if (i + 1 < n) out[i + 1] -= a * 0.6; // slight doublet gives a sharper, less "clicky-DC" pulse
  }
  return out;
}

// ------------------------------------------------------------------ mixing helpers

/** dst += src·gain starting at sample `at` (clipped to dst). */
export function mix(dst: Float32Array, src: Float32Array, gain = 1, at = 0): Float32Array {
  const start = Math.max(0, at);
  const end = Math.min(dst.length, at + src.length);
  for (let i = start; i < end; i++) dst[i] += src[i - at] * gain;
  return dst;
}

/** dst += src·gain starting at time `sec`. */
export const mixAt = (dst: Float32Array, src: Float32Array, sr: number, sec: number, gain = 1) =>
  mix(dst, src, gain, Math.round(sec * sr));

export function scale(buf: Float32Array, g: number): Float32Array {
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
  return buf;
}

export function mul(a: Float32Array, b: Float32Array): Float32Array {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) a[i] *= b[i];
  return a;
}

export function peakOf(buf: Float32Array): number {
  let p = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i]);
    if (v > p) p = v;
  }
  return p;
}

export function rmsOf(buf: Float32Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / Math.max(1, buf.length));
}

/** Scale so the peak is `target` (no-op for silence). */
export function normalize(buf: Float32Array, target = 1): Float32Array {
  const p = peakOf(buf);
  return p > 1e-9 ? scale(buf, target / p) : buf;
}

/** tanh soft clipper with unity small-signal gain at drive → 0. Adds grit/saturation to thumps. */
export function softClip(buf: Float32Array, drive = 1): Float32Array {
  const norm = 1 / Math.tanh(drive);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i] * drive) * norm;
  return buf;
}

/**
 * Make a buffer loop seamlessly: the last `xfade` seconds are equal-power crossfaded into the start, and the
 * result is `xfade` shorter. Wrapping from the final sample back to index 0 is then continuous.
 */
export function seamless(buf: Float32Array, sr: number, xfade: number): Float32Array {
  const x = Math.min(Math.floor(xfade * sr), Math.floor(buf.length / 2));
  const n = buf.length - x;
  const out = buf.slice(0, n);
  for (let i = 0; i < x; i++) {
    const p = i / x;
    const gin = Math.sin(0.5 * Math.PI * p);
    const gout = Math.cos(0.5 * Math.PI * p);
    out[i] = buf[i] * gin + buf[n + i] * gout;
  }
  return out;
}

/** Stereo helper. */
export const stereo = (l: Float32Array, r: Float32Array): Stereo => ({ l, r });

/** Time-reverse in place. */
export function reverse(buf: Float32Array): Float32Array {
  buf.reverse();
  return buf;
}
