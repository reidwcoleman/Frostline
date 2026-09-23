// Static world objects: trees and boulders. Deterministic placement from the seed,
// stored in flat typed arrays with a uniform spatial grid for fast neighbourhood queries.
// Rendering lives in src/render; chopping/harvesting in src/survival.
import type { Terrain } from './Terrain';
import type { EventBus } from './Events';
import { Simplex2 } from './noise';
import { hash2, smoothstep, clamp } from './math';

export const TreeType = { Spruce: 0, Pine: 1, Snag: 2, Fir: 3 } as const;
export type TreeType = (typeof TreeType)[keyof typeof TreeType];

const TREE_HEIGHT = [15, 17, 10, 5.5];
const TREE_TRUNK = [0.26, 0.3, 0.22, 0.12];
export const TREELINE = 700; // meters: few trees above this

export class World {
  // ---- Trees ----
  treeCount = 0;
  treeX = new Float32Array(0);
  treeY = new Float32Array(0);
  treeZ = new Float32Array(0);
  treeScale = new Float32Array(0);
  treeRot = new Float32Array(0);
  treeType = new Uint8Array(0);
  treeAlive = new Uint8Array(0);
  /** Remaining chop health (Survival/harvest owns the semantics). */
  treeHealth = new Float32Array(0);

  // ---- Rocks ----
  rockCount = 0;
  rockX = new Float32Array(0);
  rockY = new Float32Array(0);
  rockZ = new Float32Array(0);
  rockR = new Float32Array(0);
  rockRot = new Float32Array(0);
  rockType = new Uint8Array(0);
  rockAlive = new Uint8Array(0);

  // ---- Spatial grid ----
  readonly gridCell = 16;
  gridDim = 0;
  private treeCellStart = new Int32Array(0);
  private treeCellItems = new Int32Array(0);
  private rockCellStart = new Int32Array(0);
  private rockCellItems = new Int32Array(0);

  constructor(private terrain: Terrain, private events: EventBus) {}

  treeHeight(i: number) {
    return TREE_HEIGHT[this.treeType[i]] * this.treeScale[i];
  }
  treeRadius(i: number) {
    return TREE_TRUNK[this.treeType[i]] * this.treeScale[i];
  }

  generate(seed: number) {
    const t = this.terrain;
    const n = new Simplex2(seed * 13 + 5);
    const half = t.half;
    const [sx, sz] = t.data.spawn;

    // ---- Trees: jittered grid, density from forest noise * altitude * slope ----
    const spacing = 6.5;
    const dim = Math.floor(t.size / spacing);
    const tx: number[] = [],
      ty: number[] = [],
      tz: number[] = [],
      ts: number[] = [],
      tr: number[] = [],
      tt: number[] = [];
    for (let j = 0; j < dim; j++) {
      for (let i = 0; i < dim; i++) {
        const r0 = hash2(i, j, seed);
        const r1 = hash2(i, j, seed + 1);
        const r2 = hash2(i, j, seed + 2);
        const x = -half + (i + 0.15 + r0 * 0.7) * spacing;
        const z = -half + (j + 0.15 + r1 * 0.7) * spacing;
        if (!t.inBounds(x, z, 24)) continue;
        if (t.lakeFactor(x, z) > 0.01) continue;
        const h = t.baseHeight(x, z);
        const slope = this.gridSlope(x, z);
        const forest = smoothstep(-0.2, 0.42, n.fbm(x * 0.0022, z * 0.0022, 4) + n.noise(x * 0.012, z * 0.012) * 0.18);
        const treeline = TREELINE + n.noise(x * 0.004, z * 0.004) * 60;
        const alt = 1 - smoothstep(treeline - 120, treeline + 30, h);
        const slopeF = 1 - smoothstep(0.55, 0.85, slope);
        const creek = smoothstep(0.55, 0.8, t.flowAt(x, z)) * 0.25;
        let density = (forest * 0.9 + creek) * alt * slopeF + 0.018 * slopeF;
        // Keep the spawn clearing open.
        const ds = Math.hypot(x - sx, z - sz);
        if (ds < 14) continue;
        density *= smoothstep(14, 40, ds);
        if (r2 > density) continue;
        const r3 = hash2(i, j, seed + 3);
        const r4 = hash2(i, j, seed + 4);
        let type: TreeType = r3 < 0.62 ? TreeType.Spruce : r3 < 0.9 ? TreeType.Pine : TreeType.Fir;
        const nearTreeline = smoothstep(treeline - 160, treeline, h);
        if (r4 < 0.03 + nearTreeline * 0.12) type = TreeType.Snag;
        let scale = 0.72 + hash2(i, j, seed + 5) * 0.62;
        scale *= 1 - nearTreeline * 0.35;
        if (type === TreeType.Fir) scale *= 1.2;
        tx.push(x);
        tz.push(z);
        ty.push(t.heightAt(x, z));
        ts.push(scale);
        tr.push(hash2(i, j, seed + 6) * Math.PI * 2);
        tt.push(type);
      }
    }
    this.treeCount = tx.length;
    this.treeX = Float32Array.from(tx);
    this.treeY = Float32Array.from(ty);
    this.treeZ = Float32Array.from(tz);
    this.treeScale = Float32Array.from(ts);
    this.treeRot = Float32Array.from(tr);
    this.treeType = Uint8Array.from(tt);
    this.treeAlive = new Uint8Array(this.treeCount).fill(1);
    this.treeHealth = new Float32Array(this.treeCount).fill(100);

    // ---- Rocks: sparser grid, more on steep ground and near the treeline ----
    const rs = 22;
    const rdim = Math.floor(t.size / rs);
    const rx: number[] = [],
      ry: number[] = [],
      rz: number[] = [],
      rr: number[] = [],
      rrot: number[] = [],
      rt: number[] = [];
    for (let j = 0; j < rdim; j++) {
      for (let i = 0; i < rdim; i++) {
        const x = -half + (i + hash2(i, j, seed + 11)) * rs;
        const z = -half + (j + hash2(i, j, seed + 12)) * rs;
        if (!t.inBounds(x, z, 24)) continue;
        if (t.lakeFactor(x, z) > 0.01) continue;
        if (Math.hypot(x - sx, z - sz) < 10) continue;
        const slope = this.gridSlope(x, z);
        const h = t.baseHeight(x, z);
        const p = 0.05 + smoothstep(0.3, 0.9, slope) * 0.35 + smoothstep(TREELINE - 100, TREELINE + 200, h) * 0.15;
        if (hash2(i, j, seed + 13) > p) continue;
        const big = hash2(i, j, seed + 14);
        const radius = big > 0.93 ? 2.2 + big * 2.2 : 0.45 + big * 1.3;
        rx.push(x);
        rz.push(z);
        ry.push(t.heightAt(x, z) - radius * 0.35);
        rr.push(radius);
        rrot.push(hash2(i, j, seed + 15) * Math.PI * 2);
        rt.push(Math.floor(hash2(i, j, seed + 16) * 3));
      }
    }
    this.rockCount = rx.length;
    this.rockX = Float32Array.from(rx);
    this.rockY = Float32Array.from(ry);
    this.rockZ = Float32Array.from(rz);
    this.rockR = Float32Array.from(rr);
    this.rockRot = Float32Array.from(rrot);
    this.rockType = Uint8Array.from(rt);
    this.rockAlive = new Uint8Array(this.rockCount).fill(1);

    this.buildGrids();
  }

  /** Slope (rise over run) from the raw heightmap; cheap, used for placement. */
  private gridSlope(x: number, z: number) {
    const t = this.terrain;
    const e = t.cell;
    const dx = (t.baseHeight(x + e, z) - t.baseHeight(x - e, z)) / (2 * e);
    const dz = (t.baseHeight(x, z + e) - t.baseHeight(x, z - e)) / (2 * e);
    return Math.sqrt(dx * dx + dz * dz);
  }

  private cellOf(x: number, z: number) {
    const ci = clamp(Math.floor((x + this.terrain.half) / this.gridCell), 0, this.gridDim - 1);
    const cj = clamp(Math.floor((z + this.terrain.half) / this.gridCell), 0, this.gridDim - 1);
    return cj * this.gridDim + ci;
  }

  private buildGrids() {
    this.gridDim = Math.ceil(this.terrain.size / this.gridCell);
    const cells = this.gridDim * this.gridDim;
    const build = (count: number, xs: Float32Array, zs: Float32Array) => {
      const start = new Int32Array(cells + 1);
      const cellIdx = new Int32Array(count);
      for (let i = 0; i < count; i++) {
        const c = this.cellOf(xs[i], zs[i]);
        cellIdx[i] = c;
        start[c + 1]++;
      }
      for (let c = 0; c < cells; c++) start[c + 1] += start[c];
      const fill = start.slice(0, cells);
      const items = new Int32Array(count);
      for (let i = 0; i < count; i++) items[fill[cellIdx[i]]++] = i;
      return { start, items };
    };
    const t = build(this.treeCount, this.treeX, this.treeZ);
    this.treeCellStart = t.start;
    this.treeCellItems = t.items;
    const r = build(this.rockCount, this.rockX, this.rockZ);
    this.rockCellStart = r.start;
    this.rockCellItems = r.items;
  }

  /** Calls fn(index) for every live tree whose trunk centre is within r of (x, z). Return true from fn to stop. */
  forEachTree(x: number, z: number, r: number, fn: (i: number) => boolean | void) {
    this.query(x, z, r, this.treeCellStart, this.treeCellItems, this.treeX, this.treeZ, this.treeAlive, fn);
  }

  forEachRock(x: number, z: number, r: number, fn: (i: number) => boolean | void) {
    // Rocks can be big: widen the search by the max rock radius.
    this.query(x, z, r + 4.5, this.rockCellStart, this.rockCellItems, this.rockX, this.rockZ, this.rockAlive, (i) => {
      const dx = this.rockX[i] - x,
        dz = this.rockZ[i] - z;
      const rr = r + this.rockR[i];
      if (dx * dx + dz * dz > rr * rr) return;
      return fn(i);
    }, true);
  }

  private query(
    x: number,
    z: number,
    r: number,
    start: Int32Array,
    items: Int32Array,
    xs: Float32Array,
    zs: Float32Array,
    alive: Uint8Array,
    fn: (i: number) => boolean | void,
    skipDistance = false,
  ) {
    const g = this.gridCell,
      half = this.terrain.half,
      dim = this.gridDim;
    const i0 = clamp(Math.floor((x - r + half) / g), 0, dim - 1);
    const i1 = clamp(Math.floor((x + r + half) / g), 0, dim - 1);
    const j0 = clamp(Math.floor((z - r + half) / g), 0, dim - 1);
    const j1 = clamp(Math.floor((z + r + half) / g), 0, dim - 1);
    const r2 = r * r;
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const c = j * dim + i;
        for (let k = start[c]; k < start[c + 1]; k++) {
          const idx = items[k];
          if (!alive[idx]) continue;
          if (!skipDistance) {
            const dx = xs[idx] - x,
              dz = zs[idx] - z;
            if (dx * dx + dz * dz > r2) continue;
          }
          if (fn(idx) === true) return;
        }
      }
  }

  /** Nearest live tree to (x, z) within maxR, or -1. */
  nearestTree(x: number, z: number, maxR: number): number {
    let best = -1,
      bestD = maxR * maxR;
    this.forEachTree(x, z, maxR, (i) => {
      const dx = this.treeX[i] - x,
        dz = this.treeZ[i] - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  removeTree(i: number) {
    if (!this.treeAlive[i]) return;
    this.treeAlive[i] = 0;
    this.events.emit('tree:removed', { id: i });
  }

  removeRock(i: number) {
    if (!this.rockAlive[i]) return;
    this.rockAlive[i] = 0;
    this.events.emit('rock:removed', { id: i });
  }

  /** Restore every tree/rock (new game). Renderers should rebuild on 'newGame'. */
  resetAlive() {
    this.treeAlive.fill(1);
    this.treeHealth.fill(100);
    this.rockAlive.fill(1);
  }

  serialize() {
    const deadTrees: number[] = [];
    for (let i = 0; i < this.treeCount; i++) if (!this.treeAlive[i]) deadTrees.push(i);
    const deadRocks: number[] = [];
    for (let i = 0; i < this.rockCount; i++) if (!this.rockAlive[i]) deadRocks.push(i);
    return { deadTrees, deadRocks };
  }

  deserialize(d: { deadTrees: number[]; deadRocks: number[] }) {
    this.resetAlive();
    for (const i of d.deadTrees) this.removeTree(i);
    for (const i of d.deadRocks) this.removeRock(i);
  }
}
