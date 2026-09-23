// Chopping, felling and rock harvesting.
//
// 'tree:hit' → chop health (5–8 hatchet hits for a spruce, by trunk size), snow shaken from the
// crown, wood chips, the odd stick dropping. At 0 → the tree cracks, then topples away from the
// player about its base (rigid-body pivot, gravity torque), crashes into the snow with a burst and
// a snow trench, bounces and settles; a moment later it's bucked into a log pile you can collect.
// A stump is left behind (instanced). Falling trees hurt whoever they land on.
//
// 'rock:hit' → stone, with diminishing returns on boulders; small rocks break apart.
import * as THREE from 'three';
import type { GameContext } from '../core/types';
import type { ItemId } from '../core/Items';
import type { Survival } from './Survival';
import { GeoBuilder, woodTint } from './Geo';
import { clamp, hash2 } from '../core/math';
import { shake } from './util';

interface Faller {
  tree: number;
  pivot: THREE.Group;
  mesh: THREE.Object3D;
  base: THREE.Vector3;
  dir: THREE.Vector3;
  axis: THREE.Vector3;
  L: number;
  r: number;
  theta: number;
  omega: number;
  phase: 'crack' | 'fall' | 'rest';
  t: number;
  bounces: number;
  hitPlayer: boolean;
  impacted: boolean;
}

export interface PileSave {
  p: [number, number, number];
  a: number;
  logs: number;
  sticks: number;
  r: number;
}

interface Pile extends PileSave {
  object: THREE.Group;
  remove: () => void;
}

export interface HarvestSave {
  stumps: number[];
  piles: PileSave[];
  rocks: [number, number][];
}

const STUMP_CAP = 1024;
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** Reference hatchet damage per swing (combat's 'tree:hit' damage is scaled against this). */
const REF_DAMAGE = 25;

export class Harvest {
  private stumpMeshes: THREE.InstancedMesh[] = [];
  private stumps: number[] = [];
  private fallers: Faller[] = [];
  private piles: Pile[] = [];
  private rockHits = new Map<number, number>();

  constructor(private ctx: GameContext, private survival: Survival) {}

  init() {
    const { events } = this.ctx;
    events.on('tree:hit', (e) => this.onTreeHit(e.id, e.point, e.damage, e.tool));
    events.on('rock:hit', (e) => this.onRockHit(e.id, e.point, e.damage, e.tool));
    // Stump geometry: a short flared trunk with a fresh cut face; one InstancedMesh per material.
    const g = new GeoBuilder();
    const tint = new THREE.Color(0.8, 0.72, 0.66);
    g.log(new THREE.Vector3(0, -0.25, 0), new THREE.Vector3(0, 0.42, 0), 1, { seed: 5, tint, taper: 0.35, wobble: 0.08, bow: 0.02, capB: true, radial: 12, snow: 0.6 });
    // Root flares.
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2 + 0.4;
      g.log(new THREE.Vector3(Math.cos(a) * 0.55, 0.12, Math.sin(a) * 0.55), new THREE.Vector3(Math.cos(a) * 1.7, -0.12, Math.sin(a) * 1.7), 0.42, { seed: 9 + k, tint, taper: 0.6, radial: 7, snow: 0.8 });
    }
    const grp = g.toGroup();
    for (const child of grp.children) {
      const src = child as THREE.Mesh;
      const im = new THREE.InstancedMesh(src.geometry, src.material, STUMP_CAP);
      im.count = 0;
      im.castShadow = true;
      im.receiveShadow = true;
      im.frustumCulled = false;
      this.stumpMeshes.push(im);
      this.ctx.scene.add(im);
    }
  }

  reset() {
    for (const f of this.fallers) this.disposeFaller(f);
    this.fallers.length = 0;
    for (const p of this.piles) p.remove();
    this.piles.length = 0;
    this.stumps.length = 0;
    this.rockHits.clear();
    this.refreshStumps();
  }

  // ---------------------------------------------------------------- trees
  /** Number of hatchet hits a tree takes (by trunk radius). */
  hitsFor(i: number): number {
    return clamp(Math.round(3 + this.ctx.world.treeRadius(i) * 14), 3, 10);
  }

  private onTreeHit(i: number, point: THREE.Vector3, damage: number, tool: ItemId | null) {
    const { world, audio } = this.ctx;
    if (i < 0 || i >= world.treeCount || !world.treeAlive[i]) return;
    const fx = this.survival.fx;
    const x = world.treeX[i],
      y = world.treeY[i],
      z = world.treeZ[i];
    const h = world.treeHeight(i);
    const toolMul = tool === 'hatchet' ? 1 : tool === null ? 0.1 : 0.25;
    const dmg = (Math.max(0, damage) / REF_DAMAGE) * toolMul * (100 / this.hitsFor(i));
    world.treeHealth[i] -= dmg;
    // Snow shaken off the crown + chips at the cut.
    fx.snowShake(x, y + h * 0.28, y + h * 0.85, z, Math.max(1.2, h * 0.17), Math.round(50 + h * 4));
    _v.set(point.x - x, 0, point.z - z).normalize();
    fx.chips(point.x, point.y, point.z, _v.x, 0.2, _v.z, tool === 'hatchet' ? 9 : 3, true);
    audio.play('snow_thump', { position: { x, y: y + h * 0.5, z }, volume: 0.7 });
    if (tool === 'hatchet' && Math.random() < 0.22) {
      audio.play('branch_snap', { position: { x, y: y + 3, z }, volume: 0.6 });
      const a = Math.random() * Math.PI * 2;
      const d = world.treeRadius(i) + 0.6 + Math.random() * 1.2;
      this.survival.pickups.drop('stick', x + Math.cos(a) * d, y + 2.5 + Math.random() * 2, z + Math.sin(a) * d);
    }
    if (world.treeHealth[i] <= 0) this.fell(i);
  }

  private fell(i: number) {
    const { world, audio, player, events } = this.ctx;
    const x = world.treeX[i],
      y = world.treeY[i],
      z = world.treeZ[i];
    const L = world.treeHeight(i);
    const r = world.treeRadius(i);
    audio.play('tree_crack', { position: { x, y: y + 1.5, z } });
    world.removeTree(i);
    // Away from the player, with a little randomness.
    const dir = new THREE.Vector3(x - player.position.x, 0, z - player.position.z);
    if (dir.lengthSq() < 1e-4) dir.set(1, 0, 0);
    dir.normalize().applyAxisAngle(UP, (Math.random() - 0.5) * 0.5);
    const axis = new THREE.Vector3().crossVectors(UP, dir).normalize();
    let mesh: THREE.Object3D;
    try {
      mesh = this.ctx.sys.vegetation.createTreeMesh(world.treeType[i], world.treeScale[i]);
    } catch {
      mesh = this.fallbackTree(L, r);
    }
    mesh.rotation.y = world.treeRot[i];
    mesh.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    });
    const pivot = new THREE.Group();
    pivot.position.set(x, y, z);
    pivot.add(mesh);
    this.ctx.scene.add(pivot);
    this.fallers.push({ tree: i, pivot, mesh, base: new THREE.Vector3(x, y, z), dir, axis, L, r, theta: 0, omega: 0, phase: 'crack', t: 0, bounces: 0, hitPlayer: false, impacted: false });
    this.addStump(i);
    player.stats.treesFelled++;
    events.emit('tree:felled', { id: i });
  }

  private fallbackTree(L: number, r: number): THREE.Object3D {
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.4, r, L, 7), new THREE.MeshStandardMaterial({ color: 0x4a3526 }));
    trunk.position.y = L / 2;
    const crown = new THREE.Mesh(new THREE.ConeGeometry(L * 0.18, L * 0.75, 8), new THREE.MeshStandardMaterial({ color: 0x1f3a33 }));
    crown.position.y = L * 0.55;
    g.add(trunk, crown);
    return g;
  }

  /** Clearance of the crown below the trunk line at fraction f of the height (branches hit first). */
  private clearance(f: number, L: number) {
    return Math.max(0.12, (1 - f) * L * 0.13) * (f > 0.15 ? 1 : 0.3);
  }

  private updateFallers(dt: number) {
    const { terrain, player, snow, audio } = this.ctx;
    const fx = this.survival.fx;
    for (let k = this.fallers.length - 1; k >= 0; k--) {
      const f = this.fallers[k];
      f.t += dt;
      if (f.phase === 'crack') {
        // The hinge gives: a slow creaking lean.
        f.theta = 0.07 * Math.pow(Math.min(1, f.t / 0.8), 2);
        if (f.t > 0.8) {
          f.phase = 'fall';
          f.omega = 0.08;
          audio.play('tree_fall', { position: f.base.clone().addScaledVector(UP, f.L * 0.5) });
        }
      } else if (f.phase === 'fall') {
        const k2 = ((3 * 9.81) / (2 * f.L)) * 1.25;
        // Integrate in small steps: ground contact needs precision near the end.
        const steps = 4;
        const h = dt / steps;
        for (let s = 0; s < steps; s++) {
          f.omega += k2 * Math.sin(f.theta) * h;
          f.omega *= 1 - 0.05 * h;
          f.theta += f.omega * h;
          const contact = this.contactAngle(f);
          if (contact !== null && f.theta >= contact && f.omega > 0) {
            f.theta = contact;
            if (!f.impacted) {
              f.impacted = true;
              this.impact(f);
            }
            if (f.omega > 0.35 && f.bounces < 2) {
              f.omega = -f.omega * 0.18;
              f.bounces++;
            } else {
              f.omega = 0;
              f.phase = 'rest';
              f.t = 0;
              break;
            }
          }
        }
        // Crush check while it's coming down fast.
        if (!f.hitPlayer && f.omega > 0.6 && player.alive) this.checkCrush(f);
        if (f.theta > 2.6) {
          f.phase = 'rest';
          f.t = 0;
        }
      } else if (f.phase === 'rest' && f.t > 1.1) {
        // Buck it into a log pile under a cloud of snow.
        const mid = this.trunkPoint(f, 0.4);
        for (let s = 0.15; s <= 1; s += 0.17) {
          const p = this.trunkPoint(f, s);
          fx.snowBurst(p.x, terrain.heightAt(p.x, p.z) + 0.3, p.z, 14, 2.2, 1.2);
        }
        audio.play('snow_thump', { position: mid, volume: 0.8 });
        const logs = clamp(Math.round(2 + f.L / 5), 3, 5) + (this.ctx.world.treeType[f.tree] === 2 ? -1 : 0);
        const sticks = 2 + Math.floor(Math.random() * 3) + (this.ctx.world.treeType[f.tree] === 2 ? 2 : 0);
        this.addPile({ p: [mid.x, terrain.heightAt(mid.x, mid.z), mid.z], a: Math.atan2(f.dir.x, f.dir.z), logs, sticks, r: clamp(f.r * 0.95, 0.11, 0.3) });
        this.disposeFaller(f);
        this.fallers.splice(k, 1);
        continue;
      }
      f.pivot.quaternion.setFromAxisAngle(f.axis, f.theta);
      // Snow sifting off the crown while it swings.
      if (f.phase === 'fall' && Math.random() < dt * 30 * Math.min(1, f.omega)) {
        const p = this.trunkPoint(f, 0.4 + Math.random() * 0.5);
        fx.snowShake(p.x, p.y - 0.5, p.y + 0.5, p.z, 1.2, 3);
      }
    }
    void snow;
  }

  private trunkPoint(f: Faller, frac: number, out = new THREE.Vector3()) {
    const c = Math.cos(f.theta),
      s = Math.sin(f.theta);
    return out.copy(f.base).addScaledVector(UP, c * frac * f.L).addScaledVector(f.dir, s * frac * f.L);
  }

  /** Smallest angle at which any sample of the crown/trunk touches the ground. */
  private contactAngle(f: Faller): number | null {
    const t = this.ctx.terrain;
    const c = Math.cos(f.theta),
      s = Math.sin(f.theta);
    for (const frac of [0.3, 0.5, 0.7, 0.88, 1]) {
      const d = frac * f.L;
      const px = f.base.x + f.dir.x * s * d,
        pz = f.base.z + f.dir.z * s * d;
      const py = f.base.y + c * d;
      if (py - this.clearance(frac, f.L) <= t.heightAt(px, pz)) return f.theta;
    }
    return null;
  }

  private impact(f: Faller) {
    const { audio, snow, player } = this.ctx;
    const fx = this.survival.fx;
    const t = this.ctx.terrain;
    const mid = this.trunkPoint(f, 0.55);
    audio.play('tree_impact', { position: mid });
    for (let s = 0.25; s <= 1.0; s += 0.12) {
      const p = this.trunkPoint(f, s);
      fx.snowBurst(p.x, t.heightAt(p.x, p.z) + 0.2, p.z, 30, 3.2, 2.4, true);
    }
    const tip = this.trunkPoint(f, 1);
    const cx = (f.base.x + tip.x) / 2 + f.dir.x * 0.5,
      cz = (f.base.z + tip.z) / 2 + f.dir.z * 0.5;
    snow.stamp({ x: cx, z: cz, dirX: f.dir.x, dirZ: f.dir.z, width: Math.max(1.5, f.L * 0.2), length: f.L * 0.9, depth: 0.7, kind: 'tree' });
    const d = player.position.distanceTo(mid);
    if (d < 45) shake(this.ctx, 0.7 * (1 - d / 45) * clamp(f.L / 15, 0.4, 1.2));
  }

  private checkCrush(f: Faller) {
    const p = this.ctx.player;
    _v.set(p.position.x, p.position.y + 0.9, p.position.z);
    // Closest point on the trunk segment.
    const a = f.base;
    const b = this.trunkPoint(f, 1, _w);
    const ab = b.clone().sub(a);
    const t = clamp(_v.clone().sub(a).dot(ab) / ab.lengthSq(), 0, 1);
    const closest = a.clone().addScaledVector(ab, t);
    const reach = this.clearance(t, f.L) + 0.45;
    if (closest.distanceTo(_v) < reach && t > 0.15) {
      f.hitPlayer = true;
      const speed = f.omega * t * f.L;
      p.damage(clamp(speed * 4, 20, 70), 'crash', closest);
      p.applyImpulse(f.dir.clone().multiplyScalar(5).setY(1.5));
      shake(this.ctx, 1);
      this.ctx.audio.play('body_fall', { position: p.position });
    }
  }

  private disposeFaller(f: Faller) {
    this.ctx.scene.remove(f.pivot);
    // The vegetation contract says the caller owns the copy; only dispose geometry nobody else uses.
    const used = new Set<THREE.BufferGeometry>();
    this.ctx.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry) used.add(m.geometry);
    });
    f.mesh.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry && !used.has(m.geometry)) m.geometry.dispose();
    });
  }

  // ---------------------------------------------------------------- stumps
  private addStump(i: number) {
    if (this.stumps.includes(i)) return;
    this.stumps.push(i);
    this.refreshStumps();
  }

  private refreshStumps() {
    const w = this.ctx.world;
    const n = Math.min(this.stumps.length, STUMP_CAP);
    for (let k = 0; k < n; k++) {
      const i = this.stumps[k];
      const r = w.treeRadius(i) * 1.15;
      _q.setFromAxisAngle(UP, w.treeRot[i] + hash2(i, 3) * 2);
      _s.set(r, 0.9 + hash2(i, 4) * 0.3, r);
      _m.compose(_v.set(w.treeX[i], w.treeY[i] - 0.05, w.treeZ[i]), _q, _s);
      for (const im of this.stumpMeshes) im.setMatrixAt(k, _m);
    }
    for (const im of this.stumpMeshes) {
      im.count = n;
      im.instanceMatrix.needsUpdate = true;
    }
  }

  // ---------------------------------------------------------------- log piles
  private addPile(s: PileSave) {
    const g = new GeoBuilder();
    const n = s.logs;
    const len = 1.9;
    const r = s.r;
    const tint = new THREE.Color(0.86, 0.8, 0.74);
    // Bottom row of up to 3, the rest on top in the grooves.
    const bottom = Math.min(3, n);
    const top = n - bottom;
    let k = 0;
    for (let i = 0; i < bottom; i++, k++) {
      const x = (i - (bottom - 1) / 2) * r * 2.05;
      const zo = (hash2(k, 7) - 0.5) * 0.25;
      g.log(new THREE.Vector3(x, r, -len / 2 + zo), new THREE.Vector3(x, r, len / 2 + zo), r * (0.92 + hash2(k, 8) * 0.16), { seed: 300 + k, tint: woodTint(k * 7, 0.9).multiply(tint), capA: true, capB: true, snow: 0.5 });
    }
    for (let i = 0; i < top; i++, k++) {
      const x = (i - (top - 1) / 2) * r * 2.05;
      const zo = (hash2(k, 7) - 0.5) * 0.3;
      g.log(new THREE.Vector3(x, r * 2.7, -len / 2 + zo), new THREE.Vector3(x, r * 2.7, len / 2 + zo), r * (0.9 + hash2(k, 8) * 0.14), { seed: 300 + k, tint: woodTint(k * 7, 0.9).multiply(tint), capA: true, capB: true, snow: 0.8 });
    }
    // Slash: a few spruce boughs and sticks around the pile.
    const bt = new THREE.Color(0.9, 1, 0.9);
    for (let b = 0; b < 3; b++) {
      const a = hash2(b, 11) * Math.PI * 2;
      const d = new THREE.Vector3(Math.cos(a), -0.1, Math.sin(a)).normalize();
      g.frond(new THREE.Vector3(Math.cos(a) * 0.5, 0.1, Math.sin(a) * 0.9), d, UP, 0.9, 0.55, 0.1, bt, 0.9);
    }
    const object = g.toGroup();
    object.position.set(s.p[0], s.p[1] - 0.04, s.p[2]);
    object.rotation.y = s.a;
    // Sit on the slope.
    const nrm = this.ctx.terrain.normalAt(s.p[0], s.p[2]);
    object.quaternion.premultiply(_q.setFromUnitVectors(UP, nrm.lerp(UP, 0.4).normalize()));
    this.ctx.scene.add(object);
    const pile = { ...s, object } as Pile;
    const pos = new THREE.Vector3(s.p[0], s.p[1] + 0.45, s.p[2]);
    const off = this.ctx.interact.add({
      position: pos,
      radius: 1.0,
      holdTime: 0.9,
      label: () => `Collect logs (${pile.logs} logs, ${pile.sticks} sticks)`,
      onInteract: () => this.collectPile(pile),
    });
    pile.remove = () => {
      off();
      this.ctx.scene.remove(object);
      object.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
    };
    this.piles.push(pile);
  }

  private collectPile(pile: Pile) {
    const { inventory, audio } = this.ctx;
    inventory.add('log', pile.logs);
    inventory.add('stick', pile.sticks);
    audio.play('pickup', { position: { x: pile.p[0], y: pile.p[1], z: pile.p[2] } });
    this.survival.fx.snowBurst(pile.p[0], pile.p[1] + 0.3, pile.p[2], 16, 1.4, 1);
    pile.remove();
    this.piles.splice(this.piles.indexOf(pile), 1);
  }

  // ---------------------------------------------------------------- rocks
  private onRockHit(i: number, point: THREE.Vector3, _damage: number, tool: ItemId | null) {
    const { world, inventory, audio } = this.ctx;
    if (i < 0 || i >= world.rockCount || !world.rockAlive[i]) return;
    const fx = this.survival.fx;
    _v.set(point.x - world.rockX[i], point.y - world.rockY[i], point.z - world.rockZ[i]).normalize();
    fx.chips(point.x, point.y, point.z, _v.x, _v.y, _v.z, 10, false);
    fx.snowBurst(point.x, point.y, point.z, 4, 0.4, 0.6);
    const n = this.rockHits.get(i) ?? 0;
    this.rockHits.set(i, n + 1);
    const r = world.rockR[i];
    const toolMul = tool === 'hatchet' ? 1 : 0.4;
    let gain = 0;
    if (r < 0.9) {
      if (Math.random() < 0.75 * toolMul) gain++;
      if (n + 1 >= 3) {
        gain += 1;
        fx.chips(world.rockX[i], world.rockY[i] + r * 0.5, world.rockZ[i], 0, 1, 0, 24, false);
        fx.snowBurst(world.rockX[i], world.rockY[i] + r * 0.3, world.rockZ[i], 12, 1, 1);
        world.removeRock(i);
        this.rockHits.delete(i);
      }
    } else if (Math.random() < Math.max(0.12, 0.85 * Math.pow(0.8, n)) * toolMul) gain++;
    if (gain > 0) {
      inventory.add('stone', gain);
      audio.play('pickup', { position: point, volume: 0.5 });
    }
  }

  update(dt: number) {
    this.updateFallers(dt);
  }

  // ---------------------------------------------------------------- saves
  serialize(): HarvestSave {
    const piles: PileSave[] = this.piles.map((p) => ({ p: p.p, a: p.a, logs: p.logs, sticks: p.sticks, r: p.r }));
    // Trees still falling are saved as the log pile they'd become.
    for (const f of this.fallers) {
      const mid = this.trunkPoint(f, 0.4);
      piles.push({ p: [mid.x, this.ctx.terrain.heightAt(mid.x, mid.z), mid.z], a: Math.atan2(f.dir.x, f.dir.z), logs: clamp(Math.round(2 + f.L / 5), 3, 5), sticks: 3, r: clamp(f.r, 0.11, 0.3) });
    }
    return { stumps: [...this.stumps], piles, rocks: [...this.rockHits.entries()] };
  }

  deserialize(d: HarvestSave) {
    this.reset();
    if (!d) return;
    this.stumps = [...(d.stumps ?? [])];
    this.refreshStumps();
    for (const p of d.piles ?? []) this.addPile(p);
    for (const [k, v] of d.rocks ?? []) this.rockHits.set(k, v);
  }
}
