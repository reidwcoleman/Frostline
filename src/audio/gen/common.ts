// Reusable sound "gestures" built from the DSP primitives: whooshes, thumps, crunches, knocks, breaths.
// Individual sound generators compose these so the whole set shares one sonic vocabulary.
import {
  adEnv, alloc, fades, fsin, band, biquad, bump, envelope, exciter, fm, formants, grains, len, lowpass1, mix, modal, pink,
  rand, randLog, Resonator, softClip, stickSlip, sweep, white, type Mode, type Rng,
} from '../dsp';

/**
 * Every layer ends at exactly zero: a layer truncated mid-decay leaves a step (a click) when it's mixed into a
 * longer buffer, which shows up as a broadband bar in the spectrogram.
 */
const tail = (buf: Float32Array, sr: number, sec = 0.012) => fades(buf, sr, 0, Math.min(sec, (buf.length / sr) * 0.25));

/**
 * Air whoosh: pink noise through a band-pass that sweeps f0 → fPeak → f1, with a bell envelope peaking at
 * `peakAt` (0..1 of dur). A second, lower and wider band gives the body of displaced air.
 */
export function whoosh(sr: number, rng: Rng, dur: number, f0: number, fPeak: number, f1: number, peakAt = 0.45, q = 1.4, body = 0.4): Float32Array {
  const n = len(sr, dur);
  const src = pink(n, rng);
  const hi = src.slice();
  const fAt = (t: number) => {
    const p = t / dur;
    return p < peakAt ? f0 * Math.pow(fPeak / f0, p / peakAt) : fPeak * Math.pow(f1 / fPeak, (p - peakAt) / (1 - peakAt));
  };
  sweep(hi, sr, 'bandpass', fAt, q);
  const lo = src;
  sweep(lo, sr, 'bandpass', (t) => fAt(t) * 0.45, 0.6);
  const out = new Float32Array(n);
  mix(out, hi, 1);
  mix(out, lo, body);
  const pk = peakAt * dur;
  return envelope(out, sr, (t) => Math.pow(bump(t, 0, pk, dur), 1.4));
}

/** Low body thump: a pitch-dropping sine plus a low-passed noise burst, lightly saturated for small speakers. */
export function thump(sr: number, rng: Rng, dur: number, fStart: number, fEnd: number, tau: number, noiseAmt = 0.6, noiseCut = 180, drive = 1.2): Float32Array {
  const n = len(sr, dur);
  const out = new Float32Array(n);
  let ph = 0;
  // Exponential glide and decay by recurrence (one multiply each per sample).
  const kg = Math.exp(-1 / (tau * 1.5 * sr));
  const kd = Math.exp(-1 / (tau * sr));
  const att = Math.max(1, Math.round(0.003 * sr));
  let g = 1,
    e = 1;
  for (let i = 0; i < n; i++) {
    ph += (fEnd + (fStart - fEnd) * g) / sr;
    g *= kg;
    let a: number;
    if (i < att) a = fsin((0.25 * i) / att);
    else {
      a = e;
      e *= kd;
    }
    out[i] = fsin(ph) * a;
  }
  if (noiseAmt > 0) {
    const nz = white(n, rng);
    biquad(nz, sr, 'lowpass', noiseCut, 0.7);
    biquad(nz, sr, 'lowpass', noiseCut, 0.7);
    envelope(nz, sr, (t) => adEnv(t, 0.0015, tau * 0.7));
    mix(out, nz, noiseAmt * 3);
  }
  return tail(drive > 0 ? softClip(out, drive) : out, sr);
}

/**
 * Granular crunch (snow, gravel, chewing): dense micro-fractures (damped sines + noise ticks) whose density
 * follows `density(t)` 0..1, band-limited to [lo, hi]. `rate` is grains/s at density 1.
 */
export function crunch(sr: number, rng: Rng, dur: number, density: (t: number) => number, rate = 2400, lo = 1400, hi = 6000, noise = 0.35): Float32Array {
  const out = alloc(sr, dur);
  grains(out, sr, rng, 0, dur, (t) => rate * density(t), {
    rateMax: rate, fMin: lo, fMax: hi, decayMin: 0.00012, decayMax: 0.0008, noise, skew: 2.2,
  });
  return tail(band(out, sr, lo * 0.8, hi * 1.3), sr);
}

/** Snow spray / powder hiss: dense high grains plus shaped noise. */
export function spray(sr: number, rng: Rng, dur: number, envFn: (t: number) => number, lo = 2500, hi = 9500): Float32Array {
  const out = alloc(sr, dur);
  grains(out, sr, rng, 0, dur, (t) => 3000 * envFn(t), {
    rateMax: 3000, fMin: lo, fMax: hi, decayMin: 0.0001, decayMax: 0.0005, noise: 0.6, skew: 2.5,
  });
  const hiss = white(out.length, rng);
  envelope(hiss, sr, envFn);
  mix(out, hiss, 0.25);
  // Noise grains are broadband clicks: band-limit the whole spray so it stays "powder", not fizz.
  return tail(band(out, sr, lo * 0.8, hi), sr);
}

/** Struck object: resonator bank excited by a short click. `hardness` is the exciter's cutoff (Hz). */
export function knock(sr: number, rng: Rng, dur: number, modes: readonly Mode[], hardness = 3000, exDur = 0.004): Float32Array {
  return tail(modal(len(sr, dur), sr, modes, exciter(sr, rng, exDur, hardness)), sr);
}

/** Scale mode frequencies (variants, pitched knocks). */
export const scaleModes = (modes: readonly Mode[], k: number, tauK = 1): Mode[] => modes.map((m) => ({ f: m.f * k, tau: m.tau * tauK, amp: m.amp }));

/**
 * Breathy formant noise (exhales, snorts): pink+white noise through a 3-formant bank. `fmt` gives formant
 * frequencies at time t; `env` the amplitude. No pitched voice — breath only, so it never sounds cartoonish.
 */
export function breath(
  sr: number,
  rng: Rng,
  dur: number,
  env: (t: number) => number,
  fmt: (t: number) => [number, number, number],
  bw: [number, number, number] = [200, 260, 380],
  gains: [number, number, number] = [1, 0.7, 0.35],
): Float32Array {
  const n = len(sr, dur);
  const src = pink(n, rng);
  const w = white(n, rng);
  mix(src, w, 0.35);
  const out = formants(src, sr, 3, (t, f, b, g) => {
    const F = fmt(t);
    for (let k = 0; k < 3; k++) {
      f[k] = F[k];
      b[k] = bw[k];
      g[k] = gains[k];
    }
  });
  // A little unfiltered high air ("hhh") keeps it from sounding like a filtered tone.
  band(w, sr, 2000, 7000);
  mix(out, w, 0.08);
  return tail(envelope(out, sr, env), sr);
}

/** Cloth / fur / needle rustle: crackly noise grains plus a band-passed noise bed, shaped by a bump. */
export function rustle(sr: number, rng: Rng, dur: number, peakAt = 0.35): Float32Array {
  const out = alloc(sr, dur);
  const envFn = (t: number) => bump(t, 0, dur * peakAt, dur);
  grains(out, sr, rng, 0, dur, (t) => 260 * envFn(t), {
    rateMax: 260, fMin: 1500, fMax: 6500, decayMin: 0.001, decayMax: 0.006, noise: 1, skew: 1.6,
  });
  const bed = white(out.length, rng);
  envelope(bed, sr, (t) => envFn(t) * (0.5 + 0.5 * Math.abs(Math.sin(t * 37 + Math.sin(t * 13) * 3))));
  mix(out, bed, 0.12);
  return band(out, sr, 1000, 6500);
}

/** Metallic ping (binding clacks, latches, tool ticks): two-operator FM with a decaying index. */
export function ping(sr: number, f: number, ratio: number, index: number, decay: number, dur = decay * 8): Float32Array {
  const n = len(sr, dur);
  const out = fm(n, sr, f, ratio, (t) => index * Math.exp(-t / (decay * 0.6)));
  return tail(envelope(out, sr, (t) => adEnv(t, 0.0005, decay)), sr);
}

export interface Res {
  f: number;
  tau: number;
  amp: number;
}

/** Run an excitation through a parallel resonator bank (the "material" of a creak or crack). */
export function resonate(src: Float32Array, sr: number, res: readonly Res[]): Float32Array {
  const out = new Float32Array(src.length);
  for (const r of res) {
    const rz = new Resonator(sr, r.f, r.tau, r.amp);
    for (let i = 0; i < src.length; i++) out[i] += rz.tick(src[i]);
  }
  return out;
}

/** Stick–slip creak (wood under load, hinges, bow limbs). */
export function creak(sr: number, rng: Rng, dur: number, rateAt: (t: number) => number, ampAt: (t: number) => number, res: readonly Res[], jitter = 0.25): Float32Array {
  const pulses = stickSlip(len(sr, dur), sr, rng, rateAt, ampAt, jitter);
  return tail(resonate(pulses, sr, res), sr);
}

/** A single sharp crack: broadband click through a few random resonances (wood fibre snapping). */
export function crack(sr: number, rng: Rng, dur: number, fLo: number, fHi: number, hardness = 9000): Float32Array {
  const ex = exciter(sr, rng, rand(rng, 0.001, 0.003), hardness);
  const src = new Float32Array(len(sr, dur));
  mix(src, ex);
  const res: Res[] = [];
  for (let k = 0; k < 3; k++) res.push({ f: randLog(rng, fLo, fHi), tau: rand(rng, 0.004, 0.018), amp: rand(rng, 0.5, 1) });
  const out = resonate(src, sr, res);
  mix(out, src, 0.5); // the raw click keeps the attack sharp
  return tail(out, sr);
}

/** Fire crackle events: clusters of short broadband clicks plus occasional deeper pops. Adds into `out`. */
export function crackles(out: Float32Array, sr: number, rng: Rng, from: number, to: number, eventRate: (t: number) => number, rateMax: number, popRate = 0): void {
  // Clusters: each event spawns 1–5 clicks within ~30 ms (that's what makes wood crackle sound "wet" and alive).
  let t = from;
  for (;;) {
    t += -Math.log(1 - rng() * 0.999999) / rateMax;
    if (t >= to) break;
    if (rng() * rateMax > eventRate(t)) continue;
    const clicks = 1 + Math.floor(rng() * rng() * 5);
    const a0 = Math.pow(rng(), 1.8);
    for (let c = 0; c < clicks; c++) {
      const tc = t + c * rand(rng, 0.002, 0.012);
      const i0 = Math.floor(tc * sr);
      const f = randLog(rng, 1000, 6000);
      const tau = randLog(rng, 0.0002, 0.0018);
      const gl = Math.min(out.length - i0, Math.ceil(tau * 7 * sr));
      const a = a0 * (c === 0 ? 1 : rand(rng, 0.2, 0.7));
      const k = Math.exp(-1 / (tau * sr));
      const fw = f / sr;
      let e = a;
      const useNoise = rng() < 0.6;
      for (let j = 0; j < gl; j++) {
        out[i0 + j] += e * (useNoise ? rng() * 2 - 1 : fsin(fw * j));
        e *= k;
      }
    }
  }
  if (popRate <= 0) return;
  // Bigger pops: a crack plus a short low resonance (sap bursting).
  t = from;
  for (;;) {
    t += -Math.log(1 - rng() * 0.999999) / popRate;
    if (t >= to) break;
    const i0 = Math.floor(t * sr);
    if (i0 >= out.length) break;
    const a = rand(rng, 0.5, 1.2);
    const f = rand(rng, 180, 650);
    const tau = rand(rng, 0.006, 0.02);
    const hf = randLog(rng, 1500, 5000);
    const gl = Math.min(out.length - i0, Math.ceil(tau * 7 * sr));
    const k1 = Math.exp(-1 / (tau * sr)),
      k2 = Math.exp(-1 / (0.0015 * sr));
    let e1 = a,
      e2 = 1;
    for (let j = 0; j < gl; j++) {
      out[i0 + j] += e1 * (0.6 * fsin((f * j) / sr) + 0.8 * e2 * fsin((hf * j) / sr));
      e1 *= k1;
      e2 *= k2;
    }
  }
}

/** Low-passed noise with an envelope: flame roar, wind body, snow whump. */
export function rumble(sr: number, rng: Rng, dur: number, cut: number, envFn: (t: number) => number): Float32Array {
  const out = white(len(sr, dur), rng);
  lowpass1(out, sr, cut);
  lowpass1(out, sr, cut);
  biquad(out, sr, 'lowpass', cut * 1.2, 0.7);
  return tail(envelope(out, sr, envFn), sr);
}
