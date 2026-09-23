// Main-thread side of synthesis: farms the job list out to a small pool of synth workers (self-balancing:
// each idle worker pulls the next batch), turns results into AudioBuffers as they arrive, and falls back to
// time-sliced main-thread synthesis if workers are unavailable. Nothing here ever throws into the game.
import type { SoundId } from '../core/types';
import type { BufferStats } from './analyze';
import { buildJobs, jobKey, runJob, type Job } from './jobs';
import { SOUNDS } from './sounds';
import type { SynthReply, SynthRequest } from './synth.worker';

export interface SynthTiming {
  mode: 'worker' | 'main' | 'mixed';
  workers: number;
  jobs: number;
  failed: number;
  /** Wall time from start to the last buffer (ms). */
  wallMs: number;
  /** Sum of per-job synthesis time (ms) — the actual CPU work, wherever it ran. */
  sumJobMs: number;
  maxJobMs: number;
  maxJobKey: string;
  /** Longest single main-thread slice spent on synthesis or buffer creation (ms). */
  maxMainChunkMs: number;
}

const BATCH = 3;
const MAIN_SLICE_MS = 20;

/** Yield to the browser: next animation frame, or a timeout if rAF is throttled (hidden tab). */
function yieldFrame(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const go = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    requestAnimationFrame(go);
    setTimeout(go, 50);
  });
}

export class SoundBank {
  /** Variants that have arrived, per sound (index = variant). */
  private sounds = new Map<SoundId, (AudioBuffer | undefined)[]>();
  /** Available variant indices per sound (for random choice without scanning holes). */
  private avail = new Map<SoundId, number[]>();
  /** Instruments, impulse responses and noise beds by job key. */
  readonly misc = new Map<string, AudioBuffer>();
  /** Stats of variant 0 of each sound. */
  readonly stats = new Map<SoundId, BufferStats>();
  readonly timing: SynthTiming = { mode: 'worker', workers: 0, jobs: 0, failed: 0, wallMs: 0, sumJobMs: 0, maxJobMs: 0, maxJobKey: '', maxMainChunkMs: 0 };
  readonly ready: Promise<void>;
  isReady = false;
  private listeners: ((key: string, id: SoundId | null) => void)[] = [];
  private queue: Job[] = [];
  private inflight = new Map<Worker, Set<string>>();
  private jobByKey = new Map<string, Job>();
  private remaining = 0;
  private t0 = 0;
  private resolveReady!: () => void;
  private mainRunning = false;
  private workersUsed = false;

  constructor(private ac: BaseAudioContext) {
    this.ready = new Promise((r) => (this.resolveReady = r));
    for (const id of Object.keys(SOUNDS) as SoundId[]) {
      this.sounds.set(id, new Array<AudioBuffer | undefined>(SOUNDS[id].variants));
      this.avail.set(id, []);
    }
  }

  /** Called with every buffer as it lands (sound id for sound variants, null for misc buffers). */
  onBuffer(fn: (key: string, id: SoundId | null) => void) {
    this.listeners.push(fn);
  }

  /** Variant `v` of a sound, if it has arrived. */
  variant(id: SoundId, v: number): AudioBuffer | undefined {
    return this.sounds.get(id)?.[v];
  }

  /** Indices of the variants available right now (may be empty). */
  available(id: SoundId): readonly number[] {
    return this.avail.get(id) ?? [];
  }

  start() {
    this.t0 = performance.now();
    this.queue = buildJobs();
    this.remaining = this.queue.length;
    this.timing.jobs = this.queue.length;
    for (const j of this.queue) this.jobByKey.set(jobKey(j), j);
    const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4;
    const count = Math.max(1, Math.min(3, cores - 2));
    let spawned = 0;
    for (let i = 0; i < count; i++) {
      try {
        const w = new Worker(new URL('./synth.worker.ts', import.meta.url), { type: 'module' });
        this.inflight.set(w, new Set());
        w.onmessage = (e: MessageEvent<SynthReply>) => this.onWorkerMessage(w, e.data);
        w.onerror = (e) => {
          e.preventDefault?.();
          this.onWorkerFailed(w, e.message || 'worker error');
        };
        spawned++;
        // Two batches in flight per worker so it never idles waiting for the main thread.
        this.dispatch(w);
        this.dispatch(w);
      } catch (err) {
        console.warn('[audio] synth worker unavailable, synthesising on the main thread', err);
        break;
      }
    }
    this.timing.workers = spawned;
    this.workersUsed = spawned > 0;
    if (spawned === 0) {
      this.timing.mode = 'main';
      void this.runMain();
    }
  }

  private dispatch(w: Worker) {
    if (!this.queue.length) return;
    const jobs = this.queue.splice(0, BATCH);
    const set = this.inflight.get(w);
    if (!set) {
      this.queue.unshift(...jobs);
      return;
    }
    for (const j of jobs) set.add(jobKey(j));
    const req: SynthRequest = { sr: this.ac.sampleRate, jobs };
    w.postMessage(req);
  }

  private onWorkerMessage(w: Worker, msg: SynthReply) {
    if (msg.type === 'idle') {
      this.dispatch(w);
      if (!this.queue.length && this.inflight.get(w)?.size === 0) this.retire(w);
      return;
    }
    this.inflight.get(w)?.delete(msg.key);
    if (msg.type === 'error') {
      console.warn(`[audio] synthesis failed for ${msg.key}: ${msg.message}`);
      this.timing.failed++;
      this.complete();
      return;
    }
    const t = performance.now();
    this.accept(msg.key, msg.sr, msg.channels, msg.stats, msg.ms);
    this.timing.maxMainChunkMs = Math.max(this.timing.maxMainChunkMs, performance.now() - t);
  }

  private onWorkerFailed(w: Worker, message: string) {
    console.warn('[audio] synth worker failed, falling back to the main thread:', message);
    const pending = this.inflight.get(w);
    this.retire(w);
    if (pending) for (const key of pending) {
      const j = this.jobByKey.get(key);
      if (j) this.queue.push(j);
    }
    if (this.inflight.size === 0 && this.queue.length) {
      this.timing.mode = this.workersUsed ? 'mixed' : 'main';
      void this.runMain();
    }
  }

  private retire(w: Worker) {
    this.inflight.delete(w);
    w.terminate();
  }

  /** Time-sliced main-thread synthesis: never more than ~20 ms of work per frame. */
  private async runMain() {
    if (this.mainRunning) return;
    this.mainRunning = true;
    while (this.queue.length) {
      const start = performance.now();
      while (this.queue.length && performance.now() - start < MAIN_SLICE_MS) {
        const job = this.queue.shift()!;
        try {
          const r = runJob(job, this.ac.sampleRate);
          this.accept(r.key, r.sr, r.channels, r.stats, r.ms);
        } catch (err) {
          console.warn(`[audio] synthesis failed for ${jobKey(job)}`, err);
          this.timing.failed++;
          this.complete();
        }
      }
      this.timing.maxMainChunkMs = Math.max(this.timing.maxMainChunkMs, performance.now() - start);
      await yieldFrame();
    }
    this.mainRunning = false;
  }

  private accept(key: string, sr: number, channels: Float32Array[], stats: BufferStats | null, ms: number) {
    this.timing.sumJobMs += ms;
    if (ms > this.timing.maxJobMs) {
      this.timing.maxJobMs = ms;
      this.timing.maxJobKey = key;
    }
    let buf: AudioBuffer | null = null;
    try {
      buf = this.ac.createBuffer(channels.length, channels[0].length, sr);
      for (let c = 0; c < channels.length; c++) buf.copyToChannel(channels[c] as Float32Array<ArrayBuffer>, c);
    } catch (err) {
      console.warn(`[audio] could not create buffer ${key}`, err);
      this.timing.failed++;
    }
    let id: SoundId | null = null;
    if (buf) {
      if (key.startsWith('s:')) {
        const parts = key.split(':');
        id = parts[1] as SoundId;
        const v = Number(parts[2]);
        const arr = this.sounds.get(id);
        if (arr) {
          arr[v] = buf;
          this.avail.get(id)!.push(v);
        }
        if (v === 0 && stats) this.stats.set(id, stats);
      } else {
        this.misc.set(key, buf);
      }
      for (const fn of this.listeners) {
        try {
          fn(key, id);
        } catch (err) {
          console.error('[audio] buffer listener threw', err);
        }
      }
    }
    this.complete();
  }

  private complete() {
    this.remaining--;
    if (this.remaining <= 0 && !this.isReady) {
      this.isReady = true;
      this.timing.wallMs = performance.now() - this.t0;
      for (const w of [...this.inflight.keys()]) this.retire(w);
      this.resolveReady();
    }
  }
}
