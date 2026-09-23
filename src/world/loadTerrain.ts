// Loads terrain data for a seed: IndexedDB cache first, otherwise generate in a worker.
import { TERRAIN_GEN_VERSION, type TerrainData } from './TerrainGen';

const DB = 'frostline-cache';
const STORE = 'terrain';

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function cacheGet(key: string): Promise<TerrainData | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      r.onsuccess = () => resolve((r.result as TerrainData) ?? null);
      r.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function cachePut(key: string, data: TerrainData) {
  const db = await openDb();
  if (!db) return;
  try {
    db.transaction(STORE, 'readwrite').objectStore(STORE).put(data, key);
  } catch {
    /* cache is best-effort */
  }
}

export async function loadTerrain(
  seed: number,
  onProgress: (p: number, label: string) => void,
  opts: { noCache?: boolean } = {},
): Promise<TerrainData> {
  const key = `v${TERRAIN_GEN_VERSION}-${seed}`;
  if (!opts.noCache) {
    const cached = await cacheGet(key);
    if (cached && cached.heights?.length) {
      onProgress(1, 'Ready');
      return cached;
    }
  }
  const worker = new Worker(new URL('./terrain.worker.ts', import.meta.url), { type: 'module' });
  const data = await new Promise<TerrainData>((resolve, reject) => {
    worker.onmessage = (e) => {
      if (e.data.type === 'progress') onProgress(e.data.p, e.data.label);
      else if (e.data.type === 'done') resolve(e.data.data as TerrainData);
    };
    worker.onerror = (e) => reject(e);
    worker.postMessage({ seed });
  });
  worker.terminate();
  void cachePut(key, data);
  return data;
}
