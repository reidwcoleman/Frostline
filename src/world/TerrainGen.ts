// Procedural alpine heightfield generation. Pure + deterministic for a seed, runs
// inside a web worker (see terrain.worker.ts). Produces:
//   heights   Float32 heightmap (meters), res x res, row-major (z rows, x columns)
//   lakeMask  Uint8 255 = frozen lake ice
//   flow      Uint8 log-normalised drainage (gullies / creek beds) for shading & placement
//   spawn     a good starting location near the lake shore
//
// Pipeline:
//   1. Coarse design surface: a rim of high peaks, spur ridges radiating toward a lake basin.
//   2. Stream-power landscape evolution on that grid (uplift + fluvial incision + threshold hillslopes):
//      this is what gives a real dendritic valley network, sharp aretes between valleys and concave
//      fall lines that all run down to the lake.
//   3. Glacial shaping: valley cross-sections are remapped from V to U (height above the valley floor),
//      strongest high up, which also turns the heads of high valleys into open cirque bowls.
//   4. Bicubic upsample to full res with a gentle domain warp (hides the D8 grid), fine rock detail.
//   5. Droplet hydraulic erosion for gullies + fans -> light thermal -> D8 drainage -> lake -> spawn.
import { Simplex2 } from '../core/noise';
import { mulberry32, smoothstep, clamp, lerp } from '../core/math';

export const TERRAIN_GEN_VERSION = 8;

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

interface Massif {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  sigma: number;
  amp: number;
}

interface Layout {
  half: number;
  basinX: number;
  basinZ: number;
  massifs: Massif[];
}

const BASE_LEVEL = 150;

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
  P = { ...DEFAULTS, ...((globalThis as unknown as { __TGP?: Partial<typeof DEFAULTS> }).__TGP ?? {}) };

  // Planned lake basin, offset from centre so the map isn't radially symmetric.
  const basinX = -260 + (rng() - 0.5) * 300;
  const basinZ = 220 + (rng() - 0.5) * 300;

  // Interior massifs: short ridges (not domes, which erode into radial cones), away from the lake.
  const massifs: Massif[] = [];
  const a0 = rng() * Math.PI * 2;
  for (let k = 0; massifs.length < 4 && k < 64; k++) {
    const a = a0 + (massifs.length / 4) * Math.PI * 2 + (rng() - 0.5) * 0.9;
    const r = P.mr0 + rng() * P.mr1;
    const px = Math.cos(a) * r,
      pz = Math.sin(a) * r;
    if (Math.hypot(px - basinX, pz - basinZ) < P.mrb) continue;
    const axis = rng() * Math.PI;
    const len = 150 + rng() * 300;
    massifs.push({
      ax: px - Math.cos(axis) * len,
      az: pz - Math.sin(axis) * len,
      bx: px + Math.cos(axis) * len,
      bz: pz + Math.sin(axis) * len,
      sigma: 330 + rng() * 120,
      amp: P.mamp + rng() * 0.2,
    });
  }
  const layout: Layout = { half, basinX, basinZ, massifs };

  // ---- 1. Coarse design surface ------------------------------------------------------
  progress(0.02, 'Raising mountains');
  const LR = ((res - 1) >> 2) + 1;
  const dbg = (globalThis as unknown as { __TGDBG?: Record<string, Float64Array> }).__TGDBG;
  let lo: Float64Array;
  if (P.mode === 1) {
    const g = makeGrid(LR, size, n, n2, layout, true);
    lo = g.h;
    if (dbg) dbg.design = Float64Array.from(lo);
    progress(0.1, 'Carving valleys');
    troughs(lo, LR, g.lc, g.outlet);
    if (dbg) dbg.troughs = Float64Array.from(lo);
    if (P.hyb > 0) {
      // Short landscape-evolution pass (no uplift): rivers and landslides texture the trough walls.
      g.uplift.fill(0);
      streamPower(g, P.hyb, (p) => progress(0.12 + 0.15 * p, 'Carving valleys'));
      if (dbg) dbg.sim = Float64Array.from(lo);
    }
  } else {
    // Coarse (32 m) pass builds the big valley network, the 16 m pass refines it.
    const RC = ((res - 1) >> 3) + 1;
    let grid = makeGrid(RC, size, n, n2, layout, true);
    if (dbg) dbg.design = Float64Array.from(grid.h);
    breach(grid.h, RC, grid.outlet);

    // ---- 2. Landscape evolution ------------------------------------------------------
    progress(0.06, 'Carving valleys');
    streamPower(grid, P.it1, (p) => progress(0.06 + 0.12 * p, 'Carving valleys'));
    if (dbg) dbg.coarse = Float64Array.from(grid.h);
    const fine = makeGrid(LR, size, n, n2, layout, false);
    for (let j = 0; j < LR; j++)
      for (let i = 0; i < LR; i++) {
        const k = j * LR + i;
        if (fine.outlet[k]) continue;
        fine.h[k] = bicubic(grid.h, RC, i * 0.5, j * 0.5) + fine.h[k];
      }
    grid = fine;
    const sim = streamPower(grid, P.it2, (p) => progress(0.18 + 0.12 * p, 'Carving valleys'));
    lo = grid.h;
    if (dbg) dbg.fine = Float64Array.from(lo);

    // ---- 3. Glacial U-valleys and cirques -----------------------------------------
    progress(0.3, 'Grinding glaciers');
    glaciate(lo, LR, sim);
  }
  if (P.rp > 0) reliefRemap(lo, LR, Math.round(P.rr / (size / (LR - 1))));
  if (dbg) dbg.remap = Float64Array.from(lo);

  // ---- 4. Upsample + detail ------------------------------------------------------------
  progress(0.34, 'Raising mountains');
  const heights = new Float32Array(res * res);
  const lc = size / (LR - 1);
  for (let j = 0; j < res; j++) {
    const wz = -half + j * cell;
    for (let i = 0; i < res; i++) {
      const wx = -half + i * cell;
      // Gentle warp so D8 channels from the coarse sim meander instead of running at 45 deg.
      const wxx = wx + n2.noise(wx * 0.004 + 1.7, wz * 0.004 - 4.2) * 14;
      const wzz = wz + n2.noise(wx * 0.004 - 6.3, wz * 0.004 + 2.9) * 14;
      let h = bicubic(lo, LR, (wxx + half) / lc, (wzz + half) / lc);
      h += n.ridged(wx * 0.011, wz * 0.011, 3, 2.1, 0.45) * 7 * smoothstep(300, 900, h);
      heights[j * res + i] = h;
    }
  }

  // ---- 5. Hydraulic erosion (normalised units) -------------------------------------
  const hScale = 1500;
  for (let k = 0; k < heights.length; k++) heights[k] /= hScale;
  erode(heights, res, opts.droplets ?? 300_000, rng, (p) => progress(0.4 + 0.38 * p, 'Carving gullies'));
  for (let k = 0; k < heights.length; k++) heights[k] *= hScale;

  progress(0.8, 'Settling snow');
  thermal(heights, res, cell, 2, 0.9);
  // Gentle blur keeps bicubic sampling smooth where erosion left single-cell spikes.
  smoothSelective(heights, res, 1);

  progress(0.84, 'Tracing creeks');
  const flow = drainage(heights, res);

  progress(0.9, 'Freezing the lake');
  const lake = makeLake(heights, res, cell, half, basinX, basinZ, n2, rng);

  progress(0.95, 'Finding shelter');
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

// Tuning knobs. Dev previews may override them via globalThis.__TGP (never set in the game).
const DEFAULTS = {
  s0: 0.35, // initial relief as a fraction of the design (the rest is grown by uplift)
  up: 4.5, // uplift at full "mountainness", m per iteration
  K: 0.0011, // stream-power erodibility
  mExp: 0.5,
  Ac: 12_000, // channel-head drainage area (m^2); below it only hillslope processes act
  it1: 110,
  it2: 45,
  talus: 42, // threshold hillslope angle (deg)
  talusVar: 6,
  cliff: 0, // extra degrees inside cliff bands
  glacA: 60_000,
  glacW: 0,
  gH: 170, // U-trough depth scale (m) for a 1 km^2 valley
  uA0: 100_000,
  uA1: 1_000_000,
  strata: 95, // cliff band spacing (m)
  mode: 1, // 0 = stream-power sim, 1 = glacial troughs
  hyb: 0, // stream-power iterations after the troughs
  mamp: 0.85, // massif amplitude
  tD: 380, // trough depth scale (m)
  tA: 1_000_000,
  tA1: 400_000,
  ta1: 0.0013,
  tA2: 60_000,
  ta2: 0.004,
  tc2: 170,
  tA3: 12_000,
  ta3: 0.012,
  tc3: 60,
  tA4: 3_000,
  ta4: 0.04,
  tc4: 22,
  dr: 180, // ridged detail amplitude on the design (m)
  mr0: 1050, // massif distance from the map centre (+ random mr1)
  mr1: 350,
  mrb: 1100, // minimum massif distance from the lake basin
  chanTan: 0, // max channel gradient (0 = same threshold as hillslopes)
  brk: 10, // breach every N iterations (0 = never)
  edge: 0.75, // map-edge base level as a fraction of the rim relief
  rp: 1.5, // local relief remap: slope multiplier at the crest (0 = off)
  rr: 420, // local relief window radius (m)
};
let P = DEFAULTS;

function segDist(x: number, z: number, m: Massif) {
  const vx = m.bx - m.ax,
    vz = m.bz - m.az;
  const t = clamp(((x - m.ax) * vx + (z - m.az) * vz) / (vx * vx + vz * vz), 0, 1);
  return Math.hypot(x - (m.ax + vx * t), z - (m.az + vz * t));
}

interface Grid {
  R: number;
  lc: number;
  h: Float64Array;
  uplift: Float32Array;
  tanMax: Float32Array;
  cliffTan: Float32Array; // extra tan() inside strata cliff bands
  strataOff: Float32Array; // height offset of the (tilted, warped) strata
  rimW: Float32Array; // 1 on the enclosing rim (keeps rising even where valleys cut in)
  outlet: Uint8Array;
}

/**
 * Sample the design on an R x R grid. `initial` = the starting surface (floor + a fraction of the
 * relief); otherwise h holds only small seed noise to add on top of an upsampled coarse result.
 */
function makeGrid(R: number, size: number, n: Simplex2, n2: Simplex2, L: Layout, initial: boolean): Grid {
  const half = size / 2;
  const lc = size / (R - 1);
  const N = R * R;
  const g: Grid = {
    R,
    lc,
    h: new Float64Array(N),
    uplift: new Float32Array(N),
    tanMax: new Float32Array(N),
    cliffTan: new Float32Array(N),
    strataOff: new Float32Array(N),
    rimW: new Float32Array(N),
    outlet: new Uint8Array(N),
  };
  const D2R = Math.PI / 180;
  for (let j = 0; j < R; j++) {
    const wz = -half + j * lc;
    for (let i = 0; i < R; i++) {
      const wx = -half + i * lc;
      const k = j * R + i;
      const d = design(n, n2, wx, wz, L);
      g.h[k] = initial ? d.floor + (P.mode === 1 ? 1 : P.s0) * d.relief + n2.noise(wx * 0.02, wz * 0.02) * 4 : n2.noise(wx * 0.03 + 9.1, wz * 0.03) * 1.5;
      g.uplift[k] = P.up * d.relief / 1150;
      g.rimW[k] = d.rim;
      // Threshold hillslope angle, varied by noise. Where rock is exposed, tilted strata form cliff
      // bands (a height-periodic steeper threshold) instead of random rock blobs.
      const base = P.talus + P.talusVar * n.fbm(wx * 0.004, wz * 0.004, 2);
      g.tanMax[k] = Math.tan(base * D2R);
      const rock = smoothstep(0.0, 0.35, n2.fbm(wx * 0.0012 + 3.3, wz * 0.0012 - 8.1, 3));
      g.cliffTan[k] = rock * (Math.tan(Math.min(80, base + P.cliff) * D2R) - g.tanMax[k]);
      g.strataOff[k] = wx * 0.07 - wz * 0.04 + n.fbm(wx * 0.003 + 7.7, wz * 0.003, 2) * 45;
      if (Math.hypot(wx - L.basinX, wz - L.basinZ) < 80) {
        g.outlet[k] = 1;
        g.h[k] = BASE_LEVEL;
        g.uplift[k] = 0;
      } else if (i === 0 || j === 0 || i === R - 1 || j === R - 1) {
        // The map edge is a high base level just below the rim crest: the far side of the rim drains
        // outward instead of cutting notches through it toward the lake (the renderer mirrors the edge).
        g.outlet[k] = 1;
        g.h[k] = d.floor + P.edge * d.relief;
        g.uplift[k] = 0;
      }
    }
  }
  return g;
}

/** Design: valley floor level + mountain relief (before erosion) at a world position. */
function design(n: Simplex2, n2: Simplex2, wx: number, wz: number, L: Layout) {
  const half = L.half;
  // Domain warp for organic, non-grid-aligned landforms.
  const qx = n.fbm(wx * 0.0003 + 5.2, wz * 0.0003 + 1.3, 3);
  const qz = n.fbm(wx * 0.0003 - 3.1, wz * 0.0003 + 7.7, 3);
  const x = wx + qx * 380;
  const z = wz + qz * 380;

  // Rounded-square distance -> ring of high peaks enclosing the playable basin.
  const u = (wx + qx * 180) / half;
  const v = (wz + qz * 180) / half;
  const d = Math.pow(Math.pow(Math.abs(u), 4) + Math.pow(Math.abs(v), 4), 0.25);
  const rim = smoothstep(0.58, 0.92, d);

  let mp = 0;
  for (const m of L.massifs) {
    const dd = segDist(x, z, m);
    const e = m.amp * Math.exp(-(dd * dd) / (2 * m.sigma * m.sigma));
    mp = mp + e - mp * e; // soft union
  }
  const bdx = wx - L.basinX,
    bdz = wz - L.basinZ;
  const basin = Math.exp(-(bdx * bdx + bdz * bdz) / (2 * 620 * 620));

  let m = Math.max(rim, mp) + 0.22 * n2.fbm(x * 0.0006, z * 0.0006, 3) - 0.35 * basin;
  m = clamp(m, 0, 1.15);
  // Valley floors climb gently away from the lake.
  const floor = BASE_LEVEL + 10 + Math.min(1, Math.hypot(bdx, bdz) / 2200) * 90;
  let relief = 1150 * smoothstep(0.05, 1.1, m) + 90 * rim;
  // Sub-peaks and cols so the drainage network has something to organise.
  relief += n.fbm(x * 0.0022, z * 0.0022, 3) * 90 * smoothstep(0.1, 0.6, m);
  // Low-energy ridged noise: crests and pyramidal sub-peaks on the high ground.
  relief += (n2.ridged(x * 0.0011 + 4.4, z * 0.0011 - 1.9, 4, 2.0, 0.4) - 0.35) * P.dr * smoothstep(0.15, 0.7, m);
  return { floor, relief: Math.max(0, relief), rim: smoothstep(0.7, 0.9, d) };
}

/**
 * Breach depressions: priority-flood from the outlets and, whenever a cell lower than the flood
 * front is reached, cut its spill path down so everything drains (a gorge instead of a flat fill).
 */
function breach(h: Float64Array, R: number, outlet: Uint8Array) {
  const N = R * R;
  const parent = new Int32Array(N).fill(-1);
  const seen = new Uint8Array(N);
  const heap = new Heap(N);
  for (let k = 0; k < N; k++)
    if (outlet[k]) {
      seen[k] = 1;
      heap.push(k, h[k]);
    }
  while (heap.size > 0) {
    const c = heap.pop();
    const i = c % R,
      j = (c / R) | 0;
    for (let d = 0; d < 8; d++) {
      const ii = i + DI[d],
        jj = j + DJ[d];
      if (ii < 0 || jj < 0 || ii >= R || jj >= R) continue;
      const q = jj * R + ii;
      if (seen[q]) continue;
      seen[q] = 1;
      parent[q] = c;
      let cur = q,
        p = c;
      while (p >= 0 && !outlet[p] && h[p] >= h[cur]) {
        h[p] = h[cur] - 1e-3;
        cur = p;
        p = parent[p];
      }
      heap.push(q, h[q]);
    }
  }
}

const DI = [-1, 1, 0, 0, -1, 1, -1, 1];
const DJ = [0, 0, -1, 1, -1, -1, 1, 1];

/** Binary min-heap of (index, key) in typed arrays. */
class Heap {
  size = 0;
  private k: Int32Array;
  private v: Float64Array;
  constructor(cap: number) {
    this.k = new Int32Array(cap);
    this.v = new Float64Array(cap);
  }
  push(key: number, val: number) {
    const K = this.k,
      V = this.v;
    let c = this.size++;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (V[p] <= val) break;
      K[c] = K[p];
      V[c] = V[p];
      c = p;
    }
    K[c] = key;
    V[c] = val;
  }
  topVal() {
    return this.v[0];
  }
  pop(): number {
    const K = this.k,
      V = this.v;
    const top = K[0];
    const hs = --this.size;
    if (hs > 0) {
      const lk = K[hs],
        lv = V[hs];
      let c = 0;
      for (;;) {
        const l = 2 * c + 1;
        if (l >= hs) break;
        const r = l + 1;
        const m = r < hs && V[r] < V[l] ? r : l;
        if (V[m] >= lv) break;
        K[c] = K[m];
        V[c] = V[m];
        c = m;
      }
      K[c] = lk;
      V[c] = lv;
    }
    return top;
  }
}

interface SimResult {
  rec: Int32Array;
  order: Int32Array;
  area: Float64Array;
}

/**
 * Stream-power landscape evolution (Braun & Willett style implicit solver, n = 1) with a
 * priority-flood depression fill each step and a threshold hillslope limit along the flow path.
 */
function streamPower(g: Grid, iters: number, prog: (p: number) => void): SimResult {
  const { R, lc, h, uplift, tanMax, cliffTan, strataOff, rimW, outlet } = g;
  const N = R * R;
  const rec = new Int32Array(N);
  const recL = new Float32Array(N);
  const order = new Int32Array(N);
  const area = new Float64Array(N);
  const seen = new Uint8Array(N);
  const heap = new Heap(N);
  const dl = [lc, lc, lc, lc, lc * Math.SQRT2, lc * Math.SQRT2, lc * Math.SQRT2, lc * Math.SQRT2];
  const K = P.K;
  const mExp = P.mExp;
  const sAc = Math.pow(P.Ac, mExp);
  const eps = 1e-3;

  const sp = P.strata;
  for (let it = 0; it <= iters; it++) {
    // Uplift + barriers can re-close basins; cut them open again now and then (no flat fills).
    if (P.brk > 0 && it % P.brk === 5) breach(h, R, outlet);
    // Priority-flood + epsilon: fill pits so everything drains to the outlet; pop order is ascending.
    seen.fill(0);
    for (let k = 0; k < N; k++)
      if (outlet[k]) {
        seen[k] = 1;
        heap.push(k, h[k]);
      }
    let cnt = 0;
    while (heap.size > 0) {
      const hk = heap.topVal();
      const k = heap.pop();
      order[cnt++] = k;
      const i = k % R,
        j = (k / R) | 0;
      for (let d = 0; d < 8; d++) {
        const ii = i + DI[d],
          jj = j + DJ[d];
        if (ii < 0 || jj < 0 || ii >= R || jj >= R) continue;
        const q = jj * R + ii;
        if (seen[q]) continue;
        seen[q] = 1;
        if (h[q] <= hk + eps) h[q] = hk + eps;
        heap.push(q, h[q]);
      }
    }
    // Steepest-descent receivers.
    for (let k = 0; k < N; k++) {
      rec[k] = k;
      if (outlet[k]) continue;
      const i = k % R,
        j = (k / R) | 0;
      let best = 0;
      for (let d = 0; d < 8; d++) {
        const ii = i + DI[d],
          jj = j + DJ[d];
        if (ii < 0 || jj < 0 || ii >= R || jj >= R) continue;
        const q = jj * R + ii;
        const s = (h[k] - h[q]) / dl[d];
        if (s > best) {
          best = s;
          rec[k] = q;
          recL[k] = dl[d];
        }
      }
    }
    // Drainage area (m^2).
    area.fill(lc * lc);
    for (let o = N - 1; o >= 0; o--) {
      const k = order[o];
      const r = rec[k];
      if (r !== k) area[r] += area[k];
    }
    if (it === iters) break;
    // Implicit incision + uplift, then the threshold-slope limit (landslides).
    for (let o = 0; o < N; o++) {
      const k = order[o];
      const r = rec[k];
      if (r === k) continue;
      const L = recL[k];
      const sa = Math.pow(area[k], mExp) - sAc;
      const f = sa > 0 ? (K * sa) / L : 0;
      // Big valleys stop rising (glaciers and rivers keep them low); ridges keep growing.
      const u = uplift[k] * (1 - smoothstep(P.uA0, P.uA1, area[k]) * (1 - rimW[k]));
      let hk = (h[k] + u + f * h[r]) / (1 + f);
      let t = tanMax[k];
      const ct = cliffTan[k];
      if (ct > 0) {
        const fr = (h[k] + strataOff[k]) / sp;
        const ph = fr - Math.floor(fr);
        t += ct * smoothstep(0, 0.08, ph) * (1 - smoothstep(0.22, 0.32, ph));
      }
      // Threshold slope applies to hillslopes; channels follow stream power (with a loose cap).
      const lim = h[r] + (sa > 0 && P.chanTan > 0 ? P.chanTan : t) * L;
      if (hk > lim) hk = lim;
      h[k] = hk;
    }
    if ((it & 7) === 0) prog(it / iters);
  }
  return { rec, order, area };
}

/** Priority-flood (+epsilon) routing on a copy: steepest-descent receivers, ascending order, area. */
function route(h0: Float64Array, R: number, lc: number, outlet: Uint8Array) {
  const N = R * R;
  const h = Float64Array.from(h0);
  const rec = new Int32Array(N);
  const recL = new Float32Array(N);
  const order = new Int32Array(N);
  const area = new Float64Array(N);
  const seen = new Uint8Array(N);
  const heap = new Heap(N);
  const dl = [lc, lc, lc, lc, lc * Math.SQRT2, lc * Math.SQRT2, lc * Math.SQRT2, lc * Math.SQRT2];
  for (let k = 0; k < N; k++)
    if (outlet[k]) {
      seen[k] = 1;
      heap.push(k, h[k]);
    }
  let cnt = 0;
  while (heap.size > 0) {
    const hk = heap.topVal();
    const k = heap.pop();
    order[cnt++] = k;
    const i = k % R,
      j = (k / R) | 0;
    for (let d = 0; d < 8; d++) {
      const ii = i + DI[d],
        jj = j + DJ[d];
      if (ii < 0 || jj < 0 || ii >= R || jj >= R) continue;
      const q = jj * R + ii;
      if (seen[q]) continue;
      seen[q] = 1;
      if (h[q] <= hk + 1e-3) h[q] = hk + 1e-3;
      heap.push(q, h[q]);
    }
  }
  for (let k = 0; k < N; k++) {
    rec[k] = k;
    if (outlet[k]) continue;
    const i = k % R,
      j = (k / R) | 0;
    let best = 0;
    for (let d = 0; d < 8; d++) {
      const ii = i + DI[d],
        jj = j + DJ[d];
      if (ii < 0 || jj < 0 || ii >= R || jj >= R) continue;
      const q = jj * R + ii;
      const s = (h[k] - h[q]) / dl[d];
      if (s > best) {
        best = s;
        rec[k] = q;
        recL[k] = dl[d];
      }
    }
  }
  area.fill(lc * lc);
  for (let o = N - 1; o >= 0; o--) {
    const k = order[o];
    const r = rec[k];
    if (r !== k) area[r] += area[k];
  }
  return { rec, recL, order, area, filled: h };
}

/**
 * Glacial troughs: every drainage line of the design surface carves a parabolic (U-shaped) trough,
 * wider and deeper for bigger valleys. The terrain is the lower envelope of the design and all the
 * troughs, computed exactly with a separable distance transform. Where troughs meet they leave sharp
 * aretes; trough heads become cirque bowls; ridges and summits keep the designed heights.
 */
function troughs(h: Float64Array, R: number, lc: number, outlet: Uint8Array) {
  const N = R * R;
  const { rec, recL, order, area } = route(h, R, lc, outlet);
  // Valley floor ("bed") height: design minus a depth growing with drainage area, never rising downstream.
  const bed = new Float64Array(N);
  for (let o = 0; o < N; o++) {
    const k = order[o];
    const r = rec[k];
    const A = area[k];
    const D = P.tD * Math.sqrt(A / (A + P.tA));
    let b = h[k] - D;
    if (r !== k && b < bed[r] + 0.004 * recL[k]) b = Math.min(h[k], bed[r] + 0.004 * recL[k]);
    bed[k] = r === k ? h[k] : b;
  }
  // Trough classes: [min drainage area m^2, parabola curvature 1/m, max depth m]
  const classes = [
    [P.tA1, P.ta1, 1e9],
    [P.tA2, P.ta2, P.tc2],
    [P.tA3, P.ta3, P.tc3],
    [P.tA4, P.ta4, P.tc4],
  ];
  const src = new Float64Array(N);
  const env = new Float64Array(N);
  for (const [Amin, a, cap] of classes) {
    if (Amin <= 0) continue;
    for (let k = 0; k < N; k++) src[k] = area[k] >= Amin ? Math.max(bed[k], h[k] - cap) : Infinity;
    parabolicEnvelope(src, env, R, a * lc * lc);
    for (let k = 0; k < N; k++) if (env[k] < h[k]) h[k] = env[k];
  }
}

/** out[p] = min_q src[q] + A * |p - q|^2 (grid units), exact (Felzenszwalb & Huttenlocher). */
function parabolicEnvelope(src: Float64Array, out: Float64Array, R: number, A: number) {
  const f = new Float64Array(R);
  const d = new Float64Array(R);
  const v = new Int32Array(R);
  const z = new Float64Array(R + 1);
  const tmp = new Float64Array(R * R);
  const dt1 = () => {
    let k = -1;
    for (let q = 0; q < R; q++) {
      const fq = f[q];
      if (fq === Infinity) continue;
      if (k < 0) {
        k = 0;
        v[0] = q;
        z[0] = -Infinity;
        z[1] = Infinity;
        continue;
      }
      let s = 0;
      for (;;) {
        const p = v[k];
        s = (fq + A * q * q - (f[p] + A * p * p)) / (2 * A * (q - p));
        if (s <= z[k] && k > 0) k--;
        else break;
      }
      if (s <= z[k]) {
        // Replaces the only parabola left.
        v[0] = q;
        z[0] = -Infinity;
        z[1] = Infinity;
        continue;
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = Infinity;
    }
    if (k < 0) {
      d.fill(Infinity);
      return;
    }
    let j = 0;
    for (let p = 0; p < R; p++) {
      while (z[j + 1] < p) j++;
      const q = v[j];
      d[p] = f[q] + A * (p - q) * (p - q);
    }
  };
  for (let j = 0; j < R; j++) {
    for (let i = 0; i < R; i++) f[i] = src[j * R + i];
    dt1();
    for (let i = 0; i < R; i++) tmp[j * R + i] = d[i];
  }
  for (let i = 0; i < R; i++) {
    for (let j = 0; j < R; j++) f[j] = tmp[j * R + i];
    dt1();
    for (let j = 0; j < R; j++) out[j * R + i] = d[j];
  }
}

/**
 * Glacial trough shaping: remap height-above-valley-floor so V cross-sections become U-shaped
 * (flat floor, steep walls, unchanged above the trim line). Wider/deeper for big valleys and
 * high up (where glaciers were), which also scoops open cirque bowls at the heads of high valleys.
 */
function glaciate(h: Float64Array, R: number, sim: SimResult) {
  const { rec, order, area } = sim;
  if (P.glacW <= 0) return;
  const N = R * R;
  const chH = new Float64Array(N);
  const chA = new Float64Array(N);
  const A_CH = P.glacA; // m^2 drainage area where a valley floor starts
  for (let o = 0; o < N; o++) {
    const k = order[o];
    const r = rec[k];
    if (r === k || area[k] >= A_CH) {
      chH[k] = h[k];
      chA[k] = area[k];
    } else {
      chH[k] = chH[r];
      chA[k] = chA[r];
    }
  }
  for (let k = 0; k < N; k++) {
    const x = h[k] - chH[k];
    if (x <= 0) continue;
    const glacial = smoothstep(450, 950, chH[k]);
    const H0 = Math.min(380, P.gH * Math.sqrt(chA[k] / 1e6) * (0.45 + 0.55 * glacial) * P.glacW);
    if (x < H0) h[k] = chH[k] + x * (x / H0) * (2 - x / H0);
  }
}

/**
 * Local relief remap: normalise height between a smooth local floor and a smooth local top, and
 * push it through a convex curve. Valley floors flatten, upper slopes and crests steepen, so every
 * fall line becomes concave (steep up top, easing into long runouts). F and T are smooth fields,
 * so the result stays continuous across drainage divides.
 */
function reliefRemap(h: Float64Array, R: number, rad: number) {
  const N = R * R;
  const F = new Float64Array(N);
  const T = new Float64Array(N);
  minMaxFilter(h, F, R, rad, true);
  minMaxFilter(h, T, R, rad, false);
  boxBlur(F, R, rad);
  boxBlur(F, R, rad);
  boxBlur(T, R, rad);
  boxBlur(T, R, rad);
  const p = P.rp;
  for (let k = 0; k < N; k++) {
    // Peaks and valley bottoms stay put (the blurred envelopes would otherwise clip them).
    if (T[k] < h[k]) T[k] = h[k];
    if (F[k] > h[k]) F[k] = h[k];
    const span = T[k] - F[k];
    if (span < 1) continue;
    const t = clamp((h[k] - F[k]) / span, 0, 1);
    // Blend toward the remap only where there is real relief.
    const w = smoothstep(40, 160, span);
    // Cubic with g(0)=0, g'(0)=0, g(1)=1, g'(1)=p: flat floors, crest steepening capped at p.
    const g = (3 - p) * t * t + (p - 2) * t * t * t;
    h[k] = lerp(h[k], F[k] + span * g, w);
  }
}

function minMaxFilter(src: Float64Array, dst: Float64Array, R: number, rad: number, isMin: boolean) {
  const tmp = new Float64Array(R * R);
  for (let j = 0; j < R; j++)
    for (let i = 0; i < R; i++) {
      let v = isMin ? Infinity : -Infinity;
      const i0 = Math.max(0, i - rad),
        i1 = Math.min(R - 1, i + rad);
      for (let q = i0; q <= i1; q++) {
        const x = src[j * R + q];
        if (isMin ? x < v : x > v) v = x;
      }
      tmp[j * R + i] = v;
    }
  for (let j = 0; j < R; j++)
    for (let i = 0; i < R; i++) {
      let v = isMin ? Infinity : -Infinity;
      const j0 = Math.max(0, j - rad),
        j1 = Math.min(R - 1, j + rad);
      for (let q = j0; q <= j1; q++) {
        const x = tmp[q * R + i];
        if (isMin ? x < v : x > v) v = x;
      }
      dst[j * R + i] = v;
    }
}

/** Separable box blur with clamped edges (running sums). */
function boxBlur(a: Float64Array, R: number, rad: number) {
  const tmp = new Float64Array(R * R);
  const w = 2 * rad + 1;
  for (let j = 0; j < R; j++) {
    const row = j * R;
    let s = 0;
    for (let q = -rad; q <= rad; q++) s += a[row + clamp(q, 0, R - 1)];
    for (let i = 0; i < R; i++) {
      tmp[row + i] = s / w;
      s += a[row + Math.min(R - 1, i + rad + 1)] - a[row + Math.max(0, i - rad)];
    }
  }
  for (let i = 0; i < R; i++) {
    let s = 0;
    for (let q = -rad; q <= rad; q++) s += tmp[clamp(q, 0, R - 1) * R + i];
    for (let j = 0; j < R; j++) {
      a[j * R + i] = s / w;
      s += tmp[Math.min(R - 1, j + rad + 1) * R + i] - tmp[Math.max(0, j - rad) * R + i];
    }
  }
}

/** Catmull-Rom bicubic sample of a square grid at fractional grid coords (clamped). */
function bicubic(g: Float64Array, R: number, gx: number, gz: number) {
  gx = clamp(gx, 0, R - 1.0001);
  gz = clamp(gz, 0, R - 1.0001);
  const ix = gx | 0,
    iz = gz | 0;
  const fx = gx - ix,
    fz = gz - iz;
  const at = (i: number, j: number) => g[(j < 0 ? 0 : j >= R ? R - 1 : j) * R + (i < 0 ? 0 : i >= R ? R - 1 : i)];
  let out = 0;
  const wz = cubicW(fz);
  const wx = cubicW(fx);
  for (let b = 0; b < 4; b++) {
    const j = iz - 1 + b;
    const row = at(ix - 1, j) * wx[0] + at(ix, j) * wx[1] + at(ix + 1, j) * wx[2] + at(ix + 2, j) * wx[3];
    out += row * wz[b];
  }
  return out;
}
const _w = [0, 0, 0, 0];
const _w2 = [0, 0, 0, 0];
let _flip = false;
function cubicW(t: number) {
  // Two alternating buffers so bicubic() can hold x and z weights at once without allocating.
  const w = (_flip = !_flip) ? _w : _w2;
  const t2 = t * t,
    t3 = t2 * t;
  w[0] = -0.5 * t3 + t2 - 0.5 * t;
  w[1] = 1.5 * t3 - 2.5 * t2 + 1;
  w[2] = -1.5 * t3 + 2 * t2 + 0.5 * t;
  w[3] = 0.5 * t3 - 0.5 * t2;
  return w;
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

/**
 * Carve a glacial lake into the valley floor at the outlet: an irregular, valley-aligned bowl with a
 * gently rising beach apron (flat build sites) around it, then flood it.
 */
function makeLake(H: Float32Array, res: number, cell: number, half: number, bx: number, bz: number, n: Simplex2, rng: () => number) {
  const hAt = (x: number, z: number) => {
    const i = clamp(Math.round((x + half) / cell), 0, res - 1);
    const j = clamp(Math.round((z + half) / cell), 0, res - 1);
    return H[j * res + i];
  };
  // Main valley axis: the direction in which the ground stays lowest (the lake stretches along it).
  let bestA = 0,
    bestH = Infinity;
  for (let a = 0; a < Math.PI; a += Math.PI / 36) {
    let s = 0;
    for (let r = 150; r <= 750; r += 50) s += hAt(bx + Math.cos(a) * r, bz + Math.sin(a) * r) + hAt(bx - Math.cos(a) * r, bz - Math.sin(a) * r);
    if (s < bestH) {
      bestH = s;
      bestA = a;
    }
  }
  const level = hAt(bx, bz) + 0.5;
  const R0 = 205 + rng() * 40;
  const p2 = rng() * 6.28,
    p3 = rng() * 6.28,
    p5 = rng() * 6.28;
  const radius = (th: number) => {
    const t = th - bestA;
    // Elongated along the valley, with a couple of bays and points.
    return R0 * (1 + 0.32 * Math.cos(2 * t) + 0.1 * Math.cos(3 * t + p3) + 0.07 * Math.cos(5 * t + p5) + 0.05 * Math.cos(7 * t + p2)) *
      (1 + 0.08 * n.noise(Math.cos(th) * 2.1 + 11, Math.sin(th) * 2.1 - 3));
  };
  const APRON = 90;
  const ci = Math.round((bx + half) / cell),
    cj = Math.round((bz + half) / cell);
  const reach = Math.ceil((R0 * 1.7 + APRON) / cell);
  const mask = new Uint8Array(H.length);
  for (let j = Math.max(1, cj - reach); j <= Math.min(res - 2, cj + reach); j++)
    for (let i = Math.max(1, ci - reach); i <= Math.min(res - 2, ci + reach); i++) {
      const x = -half + i * cell - bx,
        z = -half + j * cell - bz;
      const r = Math.hypot(x, z);
      const Rt = radius(Math.atan2(z, x));
      const k = j * res + i;
      if (r < Rt && H[k] < level + 25) {
        // Bowl: shelving shore, ~14 m deep in the middle.
        const t = r / Rt;
        H[k] = Math.min(H[k], level - 0.4 - 14 * (1 - t * t) * smoothstep(0, 0.35, 1 - t));
        mask[k] = 255;
      } else if (r >= Rt && r < Rt + APRON) {
        // Beach apron: never below the ice, rising gently away from the shore.
        const floor = level + 0.35 + (r - Rt) * 0.035;
        if (H[k] < floor) H[k] = floor;
      }
    }
  let sx = 0,
    sz = 0,
    c = 0;
  for (let k = 0; k < H.length; k++)
    if (mask[k]) {
      H[k] = level;
      sx += k % res;
      sz += (k / res) | 0;
      c++;
    }
  // Ease the immediate shoreline down toward the ice so banks aren't cliffs.
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < H.length; k++) {
      if (!mask[k]) continue;
      for (const nb of [k - 1, k + 1, k - res, k + res, k - res - 1, k - res + 1, k + res - 1, k + res + 1]) {
        if (mask[nb]) continue;
        if (H[nb] > level) H[nb] = lerp(H[nb], level + 0.6, 0.35);
        else H[nb] = level + 0.3;
      }
    }
  }
  const center: [number, number] = c ? [(sx / c) * cell - half, (sz / c) * cell - half] : [bx, bz];
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
