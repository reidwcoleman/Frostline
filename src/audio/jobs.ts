// The synthesis job list and the (pure) job runner shared by the synth workers and the main-thread fallback.
// Each job renders one buffer: a sound variant, an instrument note, an impulse response or an ambience noise loop.
import type { SoundId } from '../core/types';
import { SOUNDS, SOUND_IDS, type Category } from './sounds';
import { analyze, longTermLoudness, shortTermLoudness, type BufferStats } from './analyze';
import { dbToGain, dcBlock, fades, isStereo, makeRng, pink, brown, seamless, peakOf, scale } from './dsp';
import { CELESTA_ROOTS, PIANO_ROOTS, renderCelesta, renderPiano } from './instruments';
import { hallIR, valleyIR } from './reverb';

export type NoiseKind = 'pinkA' | 'pinkB' | 'brownA' | 'brownB';

export type Job =
  | { kind: 'sound'; id: SoundId; variant: number }
  | { kind: 'piano'; midi: number }
  | { kind: 'celesta'; midi: number }
  | { kind: 'ir'; which: 'hall' | 'valley' }
  | { kind: 'noise'; which: NoiseKind };

export interface JobResult {
  key: string;
  /** Sample rate the buffer was rendered at (instruments use half rate: they're warm and long). */
  sr: number;
  channels: Float32Array[];
  stats: BufferStats | null;
  ms: number;
}

export function jobKey(j: Job): string {
  switch (j.kind) {
    case 'sound':
      return `s:${j.id}:${j.variant}`;
    case 'piano':
      return `piano:${j.midi}`;
    case 'celesta':
      return `celesta:${j.midi}`;
    case 'ir':
      return `ir:${j.which}`;
    case 'noise':
      return `noise:${j.which}`;
  }
}

/** Everything the engine needs, in priority order (ambience beds and UI first, the score last). */
export function buildJobs(): Job[] {
  const jobs: Job[] = [];
  for (const which of ['pinkA', 'pinkB', 'brownA', 'brownB'] as const) jobs.push({ kind: 'noise', which });
  const byCat = (c: Category) => SOUND_IDS.filter((id) => SOUNDS[id].category === c);
  for (const id of [...byCat('ui'), ...byCat('sfx'), ...byCat('ambience')]) {
    for (let v = 0; v < SOUNDS[id].variants; v++) jobs.push({ kind: 'sound', id, variant: v });
  }
  jobs.push({ kind: 'ir', which: 'valley' }, { kind: 'ir', which: 'hall' });
  for (const midi of PIANO_ROOTS) jobs.push({ kind: 'piano', midi });
  for (const midi of CELESTA_ROOTS) jobs.push({ kind: 'celesta', midi });
  return jobs;
}

/** Stable 32-bit seed per string (FNV-1a) so every build renders identical sounds. */
function seedOf(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Short-term loudness target per category (dBFS, weighted, loudest 100 ms). UI sits well below gameplay;
 * the −3 dBFS peak ceiling wins for very transient sounds so nothing ever clips.
 */
const TARGET_DB: Record<Category, number> = { sfx: -15, ui: -19, ambience: -16 };
const PEAK_CEILING = 0.708; // −3 dBFS

function finishSound(channels: Float32Array[], id: SoundId, sr: number): void {
  const def = SOUNDS[id];
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) if (!Number.isFinite(ch[i])) ch[i] = 0;
    if (!def.loop) {
      // Loops can't be DC-filtered or faded: both would break the seam. Their generators are zero-mean.
      dcBlock(ch, sr);
      fades(ch, sr, 0.0005, 0.012);
    }
  }
  const loud = def.loop ? longTermLoudness(channels, sr) : shortTermLoudness(channels, sr);
  let peak = 0;
  for (const ch of channels) peak = Math.max(peak, peakOf(ch));
  if (peak < 1e-9) return;
  const g = Math.min(dbToGain(TARGET_DB[def.category]) / Math.max(loud, 1e-9), PEAK_CEILING / peak) * def.gain;
  for (const ch of channels) scale(ch, g);
}

export function runJob(job: Job, sr: number): JobResult {
  const t0 = performance.now();
  const key = jobKey(job);
  const rng = makeRng(seedOf(key));
  let channels: Float32Array[];
  let rate = sr;
  let stats: BufferStats | null = null;
  switch (job.kind) {
    case 'sound': {
      const out = SOUNDS[job.id].gen(sr, rng, job.variant);
      channels = isStereo(out) ? [out.l, out.r] : [out];
      finishSound(channels, job.id, sr);
      // Measurements are only reported for variant 0 (debugStats); skip the FFT work for the rest.
      if (job.variant === 0) stats = analyze(channels, sr);
      break;
    }
    case 'piano': {
      rate = sr >= 44100 ? Math.round(sr / 2) : sr;
      const b = renderPiano(rate, job.midi, rng);
      scale(b, 0.5 / Math.max(peakOf(b), 1e-9));
      channels = [b];
      break;
    }
    case 'celesta': {
      const b = renderCelesta(sr, job.midi, rng);
      scale(b, 0.5 / Math.max(peakOf(b), 1e-9));
      channels = [b];
      break;
    }
    case 'ir': {
      const ir = job.which === 'hall' ? hallIR(sr, rng) : valleyIR(sr, rng);
      channels = [ir.l, ir.r];
      break;
    }
    case 'noise': {
      // 8 s seamless beds; two independent pinks and browns so L/R layers are decorrelated.
      const n = Math.ceil(sr * 8.5);
      let b = job.which.startsWith('pink') ? pink(n, rng) : brown(n, rng);
      b = seamless(b, sr, 0.5);
      let s = 0;
      for (let i = 0; i < b.length; i++) s += b[i] * b[i];
      scale(b, 0.25 / Math.sqrt(s / b.length)); // unit-ish RMS (−12 dBFS) so layer gains mean the same thing
      channels = [b];
      break;
    }
  }
  // Views into larger buffers would transfer (or copy) the whole backing store: compact them.
  channels = channels.map((c) => (c.byteOffset === 0 && c.byteLength === c.buffer.byteLength ? c : c.slice()));
  return { key, sr: rate, channels, stats, ms: performance.now() - t0 };
}
