// Buffer measurements used for loudness normalisation at synthesis time and for debugStats().
// We can't listen to the output, so every buffer is measured: peak, RMS, short-term loudness, spectral centroid.
import { Biquad } from './dsp';

export interface BufferStats {
  /** Absolute sample peak (linear). */
  peak: number;
  /** Whole-buffer RMS in dBFS. */
  rmsDb: number;
  /** Loudest 100 ms window RMS in dBFS, measured through a loudness weighting (what we normalise to). */
  stDb: number;
  durationS: number;
  /** Energy-weighted spectral centroid of the loud part of the buffer (Hz). */
  centroidHz: number;
  channels: number;
  /** True if any sample is NaN/Infinity. */
  bad: boolean;
}

/**
 * Loudness weighting (a rough K-weighting): sub-bass barely counts, presence region counts a bit more.
 * Without it, thumps would be normalised far too quiet relative to how loud they feel.
 */
function weighted(ch: Float32Array, sr: number): Float32Array {
  const w = ch.slice();
  new Biquad(sr, 'highpass', 90, 0.6).run(w);
  new Biquad(sr, 'highshelf', 1600, 0.7071, 4).run(w);
  return w;
}

/** Max RMS over 100 ms windows (50 % hop) across channels, through the loudness weighting. */
export function shortTermLoudness(channels: Float32Array[], sr: number): number {
  const win = Math.max(1, Math.round(sr * 0.1));
  const hop = Math.max(1, win >> 1);
  let best = 0;
  const ws = channels.map((c) => weighted(c, sr));
  const n = channels[0].length;
  // Prefix sums of squares make every window O(1).
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const w of ws) s += w[i] * w[i];
    pre[i + 1] = pre[i] + s / ws.length;
  }
  if (n <= win) return Math.sqrt(pre[n] / win);
  for (let i = 0; i + win <= n; i += hop) {
    const e = (pre[i + win] - pre[i]) / win;
    if (e > best) best = e;
  }
  return Math.sqrt(best);
}

/** Whole-buffer weighted RMS (for loops, whose loudness is their steady state). */
export function longTermLoudness(channels: Float32Array[], sr: number): number {
  let s = 0,
    n = 0;
  for (const c of channels) {
    const w = weighted(c, sr);
    for (let i = 0; i < w.length; i++) s += w[i] * w[i];
    n += w.length;
  }
  return Math.sqrt(s / Math.max(1, n));
}

// ------------------------------------------------------------------ FFT (radix-2, in place)

function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const ang = (-2 * Math.PI) / size;
    const wr = Math.cos(ang),
      wi = Math.sin(ang);
    for (let s = 0; s < n; s += size) {
      let cr = 1,
        ci = 0;
      for (let k = 0; k < size >> 1; k++) {
        const a = s + k,
          b = a + (size >> 1);
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** Energy-weighted spectral centroid over up to 24 frames spread across the buffer (2048-point FFT). */
export function spectralCentroid(ch: Float32Array, sr: number): number {
  const N = 2048;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const frames = Math.min(24, Math.max(1, Math.floor(ch.length / (N / 2))));
  const step = frames > 1 ? (ch.length - N) / (frames - 1) : 0;
  let num = 0,
    den = 0;
  for (let f = 0; f < frames; f++) {
    const start = Math.max(0, Math.floor(f * step));
    for (let i = 0; i < N; i++) {
      const x = start + i < ch.length ? ch[start + i] : 0;
      re[i] = x * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
      im[i] = 0;
    }
    fft(re, im);
    // Weight each frame by its energy so silent tails don't drag the centroid around.
    for (let k = 1; k < N / 2; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      num += p * ((k * sr) / N);
      den += p;
    }
  }
  return den > 0 ? num / den : 0;
}

export function analyze(channels: Float32Array[], sr: number): BufferStats {
  let peak = 0,
    sum = 0,
    bad = false,
    count = 0;
  for (const c of channels) {
    for (let i = 0; i < c.length; i++) {
      const v = c[i];
      if (!Number.isFinite(v)) {
        bad = true;
        continue;
      }
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sum += v * v;
    }
    count += c.length;
  }
  const rms = Math.sqrt(sum / Math.max(1, count));
  return {
    peak,
    rmsDb: 20 * Math.log10(Math.max(rms, 1e-9)),
    stDb: 20 * Math.log10(Math.max(shortTermLoudness(channels, sr), 1e-9)),
    durationS: channels[0].length / sr,
    centroidHz: spectralCentroid(channels[0], sr),
    channels: channels.length,
    bad,
  };
}
