// Procedural alpine heightfield generation. Pure + deterministic for a seed, runs
// inside a web worker (see terrain.worker.ts). Produces:
//   heights   Float32 heightmap (meters), res x res, row-major (z rows, x columns)
//   lakeMask  Uint8 255 = frozen lake ice
//   flow      Uint8 log-normalised drainage (gullies / creek beds) for shading & placement
//   spawn     a good starting location near the lake shore
//
// Pipeline: domain-warped ridged multifractal + continental fbm + rim of peaks
//           -> hydraulic droplet erosion -> light thermal smoothing -> D8 drainage
//           -> priority-flood lake -> spawn search.
import { Simplex2 } from '../core/noise';
import { mulberry32, smoothstep, clamp, lerp } from '../core/math';

export const TERRAIN_GEN_VERSION = 6;

export interface TerrainData {
  seed: number;
  size: number; // world size in meters (square, centred on origin)
  res: number; // heightmap samples per side
  cell: number; // meters between samples
  heights: Float32Array;
  lakeMask: Uint8Array;
  flow: Uint8Array;
  lakeLevel: number;
  lakeCenter: [number, number];
  spawn: [number, number];
  minHeight: number;
  maxHeight: number;
}

export interface TerrainGenOptions {
  seed: number;
  size?: number;
  res?: number;
  droplets?: number;
  onProgress?: (p: number, label: string) => void;
}

export function generateTerrain(opts: TerrainGenOptions): TerrainData {
  const seed = opts.seed;
  const size = opts.size ?? 4096;
  const res = opts.res ?? 1025;
  const cell = size / (res - 1);
  const half = size / 2;
  const progress = opts.onProgress ?? (() => {});
  const n = new Simplex2(seed);
  const n2 = new Simplex2(seed * 7 + 3);
  const rng = mulberry32(seed ^ 0x5bd1e995);

  // Planned lake basin, offset from centre so the map isn't radially symmetric.
  const basinX = -260 + (rng() - 0.5) * 300;
  const basinZ = 220 + (rng() - 0.5) * 300;

  // Interior massifs: guaranteed big mountains inside the rim, away from the lake.
  const peaks: Peak[] = [];
  const a0 = rng() * Math.PI * 2;
  for (let k = 0; peaks.length < 4 && k < 64; k++) {
    const a = a0 + (peaks.length / 4) * Math.PI * 2 + (rng() - 0.5) * 0.9;
    const r = 650 + rng() * 650;
    const px = Math.cos(a) * r,
      pz = Math.sin(a) * r;
    if (Math.hypot(px - basinX, pz - basinZ) < 750) continue;
    peaks.push({ x: px, z: pz, amp: 0.7 + rng() * 0.35, sigma: 360 + rng() * 220 });
  }

  const heights = new Float32Array(res * res);
  progress(0.02, 'Raising mountains');
  for (let j = 0; j < res; j++) {
    const wz = -half + j * cell;
    for (let i = 0; i < res; i++) {
      const wx = -half + i * cell;
      heights[j * res + i] = baseHeight(n, n2, wx, wz, half, basinX, basinZ, peaks);
    }
    if ((j & 63) === 0) progress(0.02 + 0.28 * (j / res), 'Raising mountains');
  }

  // ---- Hydraulic erosion (normalised units) -------------------------------------
  const hScale = 1500;
  for (let k = 0; k < heights.length; k++) heights[k] /= hScale;
  erode(heights, res, opts.droplets ?? 420_000, rng, (p) => progress(0.3 + 0.45 * p, 'Carving valleys'));
  for (let k = 0; k < heights.length; k++) heights[k] *= hScale;

  progress(0.76, 'Settling snow');
  thermal(heights, res, cell, 2, 0.9);
  // Gentle blur keeps bicubic sampling smooth where erosion left single-cell spikes.
  smoothSelective(heights, res, 1);

  progress(0.82, 'Tracing creeks');
  const flow = drainage(heights, res);

  progress(0.88, 'Freezing the lake');
  const lake = makeLake(heights, res, cell, half, basinX, basinZ);

  progress(0.94, 'Finding shelter');
  let minH = Infinity,
    maxH = -Infinity;
  for (let k = 0; k < heights.length; k++) {
    const h = heights[k];
    if (h < minH) minH = h;
    if (h > maxH) maxH = h;
  }
  const spawn = findSpawn(heights, res, cell, half, lake, rng);
  progress(1, 'Ready');

  return {
    seed,
    size,
    res,
    cell,
    heights,
    lakeMask: lake.mask,
    flow,
    lakeLevel: lake.level,
    lakeCenter: lake.center,
    spawn,
    minHeight: minH,
    maxHeight: maxH,
  };
}

interface Peak {
  x: number;
  z: number;
  amp: number;
  sigma: number;
}

function baseHeight(n: Simplex2, n2: Simplex2, wx: number, wz: number, half: number, bx: number, bz: number, peaks: Peak[]) {
  // Domain warp for organic, non-grid-aligned landforms.
  const qx = n.fbm(wx * 0.00035 + 5.2, wz * 0.00035 + 1.3, 3);
  const qz = n.fbm(wx * 0.00035 - 3.1, wz * 0.00035 + 7.7, 3);
  const x = wx + qx * 520;
  const z = wz + qz * 520;

  const u = wx / half;
  const v = wz / half;
  // Rounded-square distance -> ring of high peaks enclosing the playable basin.
  const d = Math.pow(Math.pow(Math.abs(u), 4) + Math.pow(Math.abs(v), 4), 0.25);
  const rim = smoothstep(0.72, 1.0, d);

  // Lake basin.
  const bdx = wx - bx,
    bdz = wz - bz;
  const basin = Math.exp(-(bdx * bdx + bdz * bdz) / (2 * 480 * 480));

  // "Mountainness": a few big massifs separated by broad glacial valleys.
  const massif = n2.fbm(x * 0.00042, z * 0.00042, 4);
  let mp = 0;
  for (const p of peaks) {
    const dx = x - p.x,
      dz = z - p.z;
    mp = Math.max(mp, p.amp * Math.exp(-(dx * dx + dz * dz) / (2 * p.sigma * p.sigma)));
  }
  let m = massif * 0.9 + 0.38 + mp * 0.95 + rim * 0.95 - basin * 0.9;
  m = smoothstep(0.18, 1.12, m);

  // Ridge detail only where there is mountain; valleys stay smooth.
  const ridge = n.ridged(x * 0.0014, z * 0.0014, 7, 2.02, 0.5);
  // Concave profile: steep summits easing into long runouts (great ski lines).
  const summit = Math.pow(m, 1.55) * (560 + 560 * ridge);
  const shoulders = n.ridged(x * 0.0032, z * 0.0032, 4, 2.1, 0.5) * 55 * m;
  const hills = n2.fbm(wx * 0.0028, wz * 0.0028, 3) * 16 * (1 - 0.6 * m);
  return 150 + summit + shoulders + hills + rim * 170;
}

// Droplet-based hydraulic erosion (after Hans Theobald Beyer / Sebastian Lague).
function erode(H: Float32Array, res: number, droplets: number, rng: () => number, prog: (p: number) => void) {
  const inertia = 0.05,
    capacityFactor = 4,
    minCapacity = 0.01,
    erodeSpeed = 0.3,
    depositSpeed = 0.3,
    evaporate = 0.015,
    gravity = 4,
    maxLife = 40,
    radius = 3;

  // Precomputed erosion brush.
  const bx: number[] = [],
    by: number[] = [],
    bw: number[] = [];
  let wsum = 0;
  for (let y = -radius; y <= radius; y++)
    for (let x = -radius; x <= radius; x++) {
      const d = Math.sqrt(x * x + y * y);
      if (d < radius) {
        const w = 1 - d / radius;
        bx.push(x);
        by.push(y);
        bw.push(w);
        wsum += w;
      }
    }
  for (let k = 0; k < bw.length; k++) bw[k] /= wsum;
  const brushN = bw.length;

  const hg = { h: 0, gx: 0, gy: 0 };
  const sample = (px: number, py: number) => {
    const cx = px | 0,
      cy = py | 0;
    const fx = px - cx,
      fy = py - cy;
    const idx = cy * res + cx;
    const nw = H[idx],
      ne = H[idx + 1],
      sw = H[idx + res],
      se = H[idx + res + 1];
    hg.gx = (ne - nw) * (1 - fy) + (se - sw) * fy;
    hg.gy = (sw - nw) * (1 - fx) + (se - ne) * fx;
    hg.h = nw * (1 - fx) * (1 - fy) + ne * fx * (1 - fy) + sw * (1 - fx) * fy + se * fx * fy;
  };

  const lim = res - 2 - radius;
  for (let d = 0; d < droplets; d++) {
    let px = radius + 1 + rng() * (lim - radius - 1);
    let py = radius + 1 + rng() * (lim - radius - 1);
    let dx = 0,
      dy = 0,
      speed = 1,
      water = 1,
      sediment = 0;
    for (let life = 0; life < maxLife; life++) {
      const nx = px | 0,
        ny = py | 0;
      const ofx = px - nx,
        ofy = py - ny;
      sample(px, py);
      const h0 = hg.h;
      dx = dx * inertia - hg.gx * (1 - inertia);
      dy = dy * inertia - hg.gy * (1 - inertia);
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1e-9) break;
      dx /= len;
      dy /= len;
      px += dx;
      py += dy;
      if (px < radius + 1 || py < radius + 1 || px > lim || py > lim) break;
      sample(px, py);
      const dh = hg.h - h0;
      const capacity = Math.max(-dh * speed * water * capacityFactor, minCapacity);
      const i0 = ny * res + nx;
      if (sediment > capacity || dh > 0) {
        const dep = dh > 0 ? Math.min(dh, sediment) : (sediment - capacity) * depositSpeed;
        sediment -= dep;
        H[i0] += dep * (1 - ofx) * (1 - ofy);
        H[i0 + 1] += dep * ofx * (1 - ofy);
        H[i0 + res] += dep * (1 - ofx) * ofy;
        H[i0 + res + 1] += dep * ofx * ofy;
      } else {
        const amount = Math.min((capacity - sediment) * erodeSpeed, -dh);
        for (let b = 0; b < brushN; b++) {
          const k = i0 + by[b] * res + bx[b];
          const want = amount * bw[b];
          const e = H[k] < want ? H[k] : want;
          H[k] -= e;
          sediment += e;
        }
      }
      speed = Math.sqrt(Math.max(0, speed * speed + dh * gravity));
      water *= 1 - evaporate;
    }
    if ((d & 16383) === 0) prog(d / droplets);
  }
}

// Thermal relaxation: move material downhill where the slope exceeds a talus angle.
function thermal(H: Float32Array, res: number, cell: number, iterations: number, talus: number) {
  const maxDiff = talus * cell;
  for (let it = 0; it < iterations; it++) {
    for (let j = 1; j < res - 1; j++)
      for (let i = 1; i < res - 1; i++) {
        const k = j * res + i;
        const h = H[k];
        let maxD = 0,
          target = -1;
        const nbs = [k - 1, k + 1, k - res, k + res];
        for (const nb of nbs) {
          const dd = h - H[nb];
          if (dd > maxD) {
            maxD = dd;
            target = nb;
          }
        }
        if (target >= 0 && maxD > maxDiff) {
          const move = (maxD - maxDiff) * 0.25;
          H[k] -= move;
          H[target] += move;
        }
      }
  }
}

// Blur only where a sample sticks out from its neighbours (removes erosion speckle).
function smoothSelective(H: Float32Array, res: number, iterations: number) {
  const tmp = new Float32Array(H.length);
  for (let it = 0; it < iterations; it++) {
    tmp.set(H);
    for (let j = 1; j < res - 1; j++)
      for (let i = 1; i < res - 1; i++) {
        const k = j * res + i;
        const avg = (tmp[k - 1] + tmp[k + 1] + tmp[k - res] + tmp[k + res]) * 0.25;
        const diff = tmp[k] - avg;
        const w = clamp(Math.abs(diff) / 3, 0, 1) * 0.5 + 0.15;
        H[k] = tmp[k] - diff * w;
      }
  }
}

// D8 flow accumulation using a counting sort on quantised height (O(n)).
function drainage(H: Float32Array, res: number): Uint8Array {
  const N = H.length;
  let minH = Infinity,
    maxH = -Infinity;
  for (let k = 0; k < N; k++) {
    if (H[k] < minH) minH = H[k];
    if (H[k] > maxH) maxH = H[k];
  }
  const B = 65536;
  const scale = (B - 1) / Math.max(1e-6, maxH - minH);
  const counts = new Uint32Array(B + 1);
  const keys = new Uint16Array(N);
  for (let k = 0; k < N; k++) {
    const q = ((H[k] - minH) * scale) | 0;
    keys[k] = q;
    counts[q + 1]++;
  }
  for (let b = 0; b < B; b++) counts[b + 1] += counts[b];
  const order = new Uint32Array(N);
  for (let k = 0; k < N; k++) order[counts[keys[k]]++] = k;

  const acc = new Float32Array(N).fill(1);
  const offs = [-1, 1, -res, res, -res - 1, -res + 1, res - 1, res + 1];
  const dist = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];
  for (let o = N - 1; o >= 0; o--) {
    const k = order[o];
    const i = k % res,
      j = (k / res) | 0;
    if (i === 0 || j === 0 || i === res - 1 || j === res - 1) continue;
    let best = -1,
      bestS = 0;
    for (let d = 0; d < 8; d++) {
      const s = (H[k] - H[k + offs[d]]) / dist[d];
      if (s > bestS) {
        bestS = s;
        best = k + offs[d];
      }
    }
    if (best >= 0) acc[best] += acc[k];
  }
  const out = new Uint8Array(N);
  let maxA = 1;
  for (let k = 0; k < N; k++) if (acc[k] > maxA) maxA = acc[k];
  const lm = Math.log(maxA);
  for (let k = 0; k < N; k++) out[k] = Math.round(clamp(Math.log(acc[k]) / lm, 0, 1) * 255);
  return out;
}

// Priority-flood a natural lake shape from the lowest point of the basin.
function makeLake(H: Float32Array, res: number, cell: number, half: number, bx: number, bz: number) {
  const ci = Math.round((bx + half) / cell),
    cj = Math.round((bz + half) / cell);
  const searchR = Math.round(650 / cell);
  let seed = cj * res + ci,
    seedH = Infinity;
  for (let j = cj - searchR; j <= cj + searchR; j++)
    for (let i = ci - searchR; i <= ci + searchR; i++) {
      if (i < 2 || j < 2 || i >= res - 2 || j >= res - 2) continue;
      const dx = i - ci,
        dy = j - cj;
      if (dx * dx + dy * dy > searchR * searchR) continue;
      const k = j * res + i;
      if (H[k] < seedH) {
        seedH = H[k];
        seed = k;
      }
    }

  const targetCells = Math.round((Math.PI * 210 * 210) / (cell * cell));
  const mask = new Uint8Array(H.length);
  const inHeap = new Uint8Array(H.length);
  // Binary min-heap of (height, index).
  const heapK: number[] = [];
  const heapH: number[] = [];
  const push = (k: number) => {
    let i = heapK.length;
    heapK.push(k);
    heapH.push(H[k]);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapH[p] <= heapH[i]) break;
      [heapK[p], heapK[i]] = [heapK[i], heapK[p]];
      [heapH[p], heapH[i]] = [heapH[i], heapH[p]];
      i = p;
    }
  };
  const pop = () => {
    const k = heapK[0];
    const lastK = heapK.pop()!,
      lastH = heapH.pop()!;
    if (heapK.length > 0) {
      heapK[0] = lastK;
      heapH[0] = lastH;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1,
          r = l + 1;
        let m = i;
        if (l < heapK.length && heapH[l] < heapH[m]) m = l;
        if (r < heapK.length && heapH[r] < heapH[m]) m = r;
        if (m === i) break;
        [heapK[m], heapK[i]] = [heapK[i], heapK[m]];
        [heapH[m], heapH[i]] = [heapH[i], heapH[m]];
        i = m;
      }
    }
    return k;
  };
  push(seed);
  inHeap[seed] = 1;
  let level = H[seed];
  let count = 0;
  const region: number[] = [];
  while (heapK.length && count < targetCells) {
    const k = pop();
    const h = H[k];
    if (h > level) {
      // Don't let the lake climb more than ~28m above its floor (keeps it a lake, not a flood).
      if (h - H[seed] > 28) break;
      level = h;
    }
    region.push(k);
    count++;
    const i = k % res,
      j = (k / res) | 0;
    if (i < 2 || j < 2 || i >= res - 2 || j >= res - 2) continue;
    for (const nb of [k - 1, k + 1, k - res, k + res]) {
      if (!inHeap[nb]) {
        inHeap[nb] = 1;
        push(nb);
      }
    }
  }
  let sx = 0,
    sz = 0;
  for (const k of region) {
    mask[k] = 255;
    H[k] = level;
    sx += k % res;
    sz += (k / res) | 0;
  }
  // Ease the immediate shoreline down toward the ice so banks aren't cliffs.
  for (let pass = 0; pass < 2; pass++) {
    for (const k of region) {
      for (const nb of [k - 1, k + 1, k - res, k + res, k - res - 1, k - res + 1, k + res - 1, k + res + 1]) {
        if (mask[nb]) continue;
        if (H[nb] > level) H[nb] = lerp(H[nb], level + 0.6, 0.35);
        else H[nb] = level + 0.3;
      }
    }
  }
  const center: [number, number] = region.length
    ? [(sx / region.length) * cell - half, (sz / region.length) * cell - half]
    : [bx, bz];
  return { mask, level, center };
}

function findSpawn(
  H: Float32Array,
  res: number,
  cell: number,
  half: number,
  lake: { mask: Uint8Array; level: number; center: [number, number] },
  rng: () => number,
): [number, number] {
  const hAt = (x: number, z: number) => {
    const i = clamp(Math.round((x + half) / cell), 1, res - 2);
    const j = clamp(Math.round((z + half) / cell), 1, res - 2);
    return H[j * res + i];
  };
  const slopeAt = (x: number, z: number) => {
    const e = cell * 2;
    const dx = (hAt(x + e, z) - hAt(x - e, z)) / (2 * e);
    const dz = (hAt(x, z + e) - hAt(x, z - e)) / (2 * e);
    return Math.sqrt(dx * dx + dz * dz);
  };
  const inLake = (x: number, z: number) => {
    const i = clamp(Math.round((x + half) / cell), 0, res - 1);
    const j = clamp(Math.round((z + half) / cell), 0, res - 1);
    return lake.mask[j * res + i] > 0;
  };
  let best: [number, number] = [lake.center[0] + 200, lake.center[1]];
  let bestScore = -Infinity;
  for (let t = 0; t < 1500; t++) {
    const a = rng() * Math.PI * 2;
    const r = 150 + rng() * 380;
    const x = lake.center[0] + Math.cos(a) * r;
    const z = lake.center[1] + Math.sin(a) * r;
    if (inLake(x, z)) continue;
    // must be a few cells away from the ice
    let nearIce = false;
    for (let k = 0; k < 8 && !nearIce; k++) {
      const aa = (k / 8) * Math.PI * 2;
      if (inLake(x + Math.cos(aa) * 40, z + Math.sin(aa) * 40)) nearIce = true;
    }
    if (nearIce) continue;
    const s = slopeAt(x, z);
    const h = hAt(x, z);
    // Prefer flat ground a little above the lake with a big slope uphill nearby (ski run).
    let upslope = 0;
    for (let k = 0; k < 8; k++) {
      const aa = (k / 8) * Math.PI * 2;
      upslope = Math.max(upslope, hAt(x + Math.cos(aa) * 350, z + Math.sin(aa) * 350) - h);
    }
    const score = -s * 40 - Math.abs(h - lake.level - 12) * 0.3 + Math.min(upslope, 260) * 0.05 - r * 0.01;
    if (s < 0.18 && score > bestScore) {
      bestScore = score;
      best = [x, z];
    }
  }
  return best;
}
