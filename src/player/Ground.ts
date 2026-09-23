// The movement code talks to the world through this small interface so the exact same physics can
// run against the real mountain (WorldGround) or an analytic test plane (PlaneGround, PhysicsLab).
import * as THREE from 'three';
import type { GameContext } from '../core/types';
import type { SurfaceKind } from '../core/Terrain';
import { Layer } from '../core/Physics';

export type GroundKind = 'terrain' | 'rock' | 'collider';

export interface GroundSample {
  y: number;
  normal: THREE.Vector3;
  surface: SurfaceKind;
  kind: GroundKind;
  /** Packed / firm footing (ice, rock, boulders, structures): no deep-snow drag, no prints. */
  packed: boolean;
}

export function makeSample(): GroundSample {
  return { y: 0, normal: new THREE.Vector3(0, 1, 0), surface: 'snow', kind: 'terrain', packed: false };
}

export interface Ground {
  /**
   * Highest standable surface under (x, z) at or below `fromY`. Writes into `out`.
   * `footprint` (m): structure tops are also searched around the centre within this radius, so a
   * capsule touching a foundation's edge can step onto it (terrain always uses the centre).
   */
  sample(x: number, fromY: number, z: number, out: GroundSample, footprint?: number): GroundSample;
  /** Ground height only (cheap; used for launch prediction and camera clamps). */
  height(x: number, fromY: number, z: number, footprint?: number): number;
  /** Push a vertical capsule out of obstacles. Returns contact normals (reused array). */
  collide(feet: THREE.Vector3, radius: number, height: number): THREE.Vector3[];
  /** Soft world bounds: returns how far (m) the point is outside the playable area (0 = inside). */
  outside(x: number, z: number, out: THREE.Vector2): number;
}

/** Footprint sample offsets (unit disc): centre + 8 around. */
const FOOT = [0, 0, 1, 0, -1, 0, 0, 1, 0, -1, 0.7, 0.7, -0.7, 0.7, 0.7, -0.7, -0.7, -0.7];

// ------------------------------------------------------------------ real world
export class WorldGround implements Ground {
  private contacts: THREE.Vector3[] = [];
  private tmp = makeSample();
  private rockBest = 0;
  private rockNX = 0;
  private rockNY = 1;
  private rockNZ = 0;
  private qx = 0;
  private qz = 0;
  private qTop = 0;
  private readonly rockCb = (i: number) => {
    const w = this.ctx.world;
    const r = w.rockR[i] * 0.92;
    const dx = this.qx - w.rockX[i],
      dz = this.qz - w.rockZ[i];
    const h2 = r * r - dx * dx - dz * dz;
    if (h2 <= 0) return;
    const top = w.rockY[i] + Math.sqrt(h2);
    if (top <= this.qTop + 0.01 && top > this.rockBest) {
      this.rockBest = top;
      this.rockNX = dx;
      this.rockNY = top - w.rockY[i];
      this.rockNZ = dz;
    }
  };

  constructor(private ctx: GameContext) {}

  private walkableNear(x: number, fromY: number, z: number): boolean {
    const all = this.ctx.physics.all();
    for (let i = 0; i < all.length; i++) {
      const c = all[i];
      if (!c.enabled || (c.layers & Layer.WALKABLE) === 0) continue;
      if (x < c.min.x || x > c.max.x || z < c.min.z || z > c.max.z) continue;
      if (c.min.y > fromY + 0.01) continue;
      return true;
    }
    return false;
  }

  sample(x: number, fromY: number, z: number, out: GroundSample, footprint = 0): GroundSample {
    const { terrain, world, physics } = this.ctx;
    if (footprint > 0) {
      // Structure tops anywhere under the capsule footprint count as ground.
      let best = -Infinity,
        bx = x,
        bz = z;
      for (let k = 0; k < FOOT.length; k += 2) {
        const px = x + FOOT[k] * footprint,
          pz = z + FOOT[k + 1] * footprint;
        if (!this.walkableNear(px, fromY, pz)) continue;
        const g = physics.groundProbe(px, fromY, pz);
        if (g.kind === 'collider' && g.y > best) {
          best = g.y;
          bx = px;
          bz = pz;
        }
      }
      if (best > -Infinity) {
        this.sample(x, fromY, z, out, 0);
        if (best > out.y) {
          const g = physics.groundProbe(bx, fromY, bz);
          out.y = g.y;
          out.normal.copy(g.normal);
          out.kind = 'collider';
          out.surface = 'wood';
          out.packed = true;
        }
        return out;
      }
    }
    if (this.walkableNear(x, fromY, z)) {
      // Rare path (near structures): defer to the core probe, which handles oriented boxes.
      const g = physics.groundProbe(x, fromY, z);
      out.y = g.y;
      out.normal.copy(g.normal);
      out.kind = g.kind;
      if (g.kind === 'collider') {
        out.surface = 'wood';
        out.packed = true;
      } else if (g.kind === 'rock') {
        out.surface = 'rock';
        out.packed = true;
      } else {
        out.surface = terrain.surfaceAt(x, z);
        out.packed = out.surface !== 'snow';
      }
      return out;
    }
    const th = terrain.heightAt(x, z);
    this.qx = x;
    this.qz = z;
    this.qTop = fromY;
    this.rockBest = -Infinity;
    world.forEachRock(x, z, 0.1, this.rockCb);
    if (this.rockBest > th) {
      out.y = this.rockBest;
      out.normal.set(this.rockNX, this.rockNY, this.rockNZ).normalize();
      out.kind = 'rock';
      out.surface = 'rock';
      out.packed = true;
      return out;
    }
    out.y = th;
    terrain.normalAt(x, z, out.normal);
    out.kind = 'terrain';
    out.surface = terrain.surfaceAt(x, z);
    out.packed = out.surface !== 'snow';
    return out;
  }

  height(x: number, fromY: number, z: number, footprint = 0): number {
    if (footprint > 0) return this.sample(x, fromY, z, this.tmp, footprint).y;
    if (this.walkableNear(x, fromY, z)) return this.ctx.physics.groundProbe(x, fromY, z).y;
    const th = this.ctx.terrain.heightAt(x, z);
    this.qx = x;
    this.qz = z;
    this.qTop = fromY;
    this.rockBest = -Infinity;
    this.ctx.world.forEachRock(x, z, 0.1, this.rockCb);
    return Math.max(th, this.rockBest);
  }

  collide(feet: THREE.Vector3, radius: number, height: number): THREE.Vector3[] {
    this.contacts.length = 0;
    return this.ctx.physics.resolveCapsule(feet, radius, height, Layer.SOLID, this.contacts);
  }

  outside(x: number, z: number, out: THREE.Vector2): number {
    const lim = this.ctx.terrain.half - 40;
    const ox = Math.abs(x) > lim ? (Math.abs(x) - lim) * Math.sign(x) : 0;
    const oz = Math.abs(z) > lim ? (Math.abs(z) - lim) * Math.sign(z) : 0;
    out.set(ox, oz);
    return Math.hypot(ox, oz);
  }
}

// ------------------------------------------------------------------ analytic test plane
/** Infinite plane that descends toward -Z at `slope` radians (yaw 0 faces straight down the fall line). */
export class PlaneGround implements Ground {
  private tan: number;
  private n = new THREE.Vector3();
  private contacts: THREE.Vector3[] = [];
  /** Optional vertical wall (a "tree") at z = wallZ facing +Z, for impact tests. */
  wallZ: number | null = null;
  /** Optional box ledge (a cabin foundation): footprint + top height (absolute y). */
  ledge: { x0: number; x1: number; z0: number; z1: number; top: number } | null = null;

  constructor(public slope: number, public surface: SurfaceKind = 'snow') {
    this.tan = Math.tan(slope);
    this.n.set(0, 1, -this.tan).normalize();
  }

  private onLedge(x: number, fromY: number, z: number, fp = 0): boolean {
    const l = this.ledge;
    return !!l && x >= l.x0 - fp && x <= l.x1 + fp && z >= l.z0 - fp && z <= l.z1 + fp && l.top <= fromY + 0.01;
  }

  height(x: number, fromY: number, z: number, footprint = 0): number {
    const t = z * this.tan;
    return this.onLedge(x, fromY, z, footprint) ? Math.max(t, this.ledge!.top) : t;
  }

  sample(x: number, fromY: number, z: number, out: GroundSample, footprint = 0): GroundSample {
    out.y = z * this.tan;
    out.normal.copy(this.n);
    out.kind = 'terrain';
    out.surface = this.surface;
    out.packed = this.surface !== 'snow';
    if (this.onLedge(x, fromY, z, footprint) && this.ledge!.top > out.y) {
      out.y = this.ledge!.top;
      out.normal.set(0, 1, 0);
      out.kind = 'collider';
      out.surface = 'wood';
      out.packed = true;
    }
    return out;
  }

  collide(feet: THREE.Vector3, radius: number): THREE.Vector3[] {
    this.contacts.length = 0;
    if (this.wallZ !== null && feet.z < this.wallZ + radius) {
      feet.z = this.wallZ + radius;
      this.contacts.push(new THREE.Vector3(0, 0, 1));
    }
    const l = this.ledge;
    if (l && feet.y < l.top - 0.05 && feet.x > l.x0 - radius && feet.x < l.x1 + radius && feet.z > l.z0 - radius && feet.z < l.z1 + radius) {
      // Push out through the nearest side.
      const dx0 = feet.x - (l.x0 - radius),
        dx1 = l.x1 + radius - feet.x,
        dz0 = feet.z - (l.z0 - radius),
        dz1 = l.z1 + radius - feet.z;
      const m = Math.min(dx0, dx1, dz0, dz1);
      if (m === dx0) (feet.x -= dx0), this.contacts.push(new THREE.Vector3(-1, 0, 0));
      else if (m === dx1) (feet.x += dx1), this.contacts.push(new THREE.Vector3(1, 0, 0));
      else if (m === dz0) (feet.z -= dz0), this.contacts.push(new THREE.Vector3(0, 0, -1));
      else (feet.z += dz1), this.contacts.push(new THREE.Vector3(0, 0, 1));
    }
    return this.contacts;
  }

  outside(_x: number, _z: number, out: THREE.Vector2): number {
    out.set(0, 0);
    return 0;
  }
}
