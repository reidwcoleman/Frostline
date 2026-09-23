// Synth worker: renders batches of jobs off the main thread and transfers the buffers back.
import { jobKey, runJob, type Job } from './jobs';

export type SynthRequest = { sr: number; jobs: Job[] };
export type SynthReply =
  | { type: 'result'; key: string; sr: number; channels: Float32Array[]; stats: import('./analyze').BufferStats | null; ms: number }
  | { type: 'error'; key: string; message: string }
  | { type: 'idle' };

const post = (self as unknown as { postMessage(msg: SynthReply, transfer?: Transferable[]): void }).postMessage.bind(self);

self.onmessage = (e: MessageEvent<SynthRequest>) => {
  const { sr, jobs } = e.data;
  for (const job of jobs) {
    try {
      const r = runJob(job, sr);
      post({ type: 'result', key: r.key, sr: r.sr, channels: r.channels, stats: r.stats, ms: r.ms }, r.channels.map((c) => c.buffer as ArrayBuffer));
    } catch (err) {
      post({ type: 'error', key: jobKey(job), message: String(err) });
    }
  }
  post({ type: 'idle' });
};
