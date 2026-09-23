// Web worker: generates the heightfield off the main thread.
import { generateTerrain } from './TerrainGen';

const post = (self as unknown as { postMessage(msg: unknown, transfer?: Transferable[]): void }).postMessage.bind(self);

self.onmessage = (e: MessageEvent<{ seed: number; droplets?: number }>) => {
  const data = generateTerrain({
    seed: e.data.seed,
    droplets: e.data.droplets,
    onProgress: (p, label) => post({ type: 'progress', p, label }),
  });
  post({ type: 'done', data }, [data.heights.buffer, data.lakeMask.buffer, data.flow.buffer]);
};
