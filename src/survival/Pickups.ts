// Ground pickups and supply caches.
//
// Sticks lie under trees and loose stones around boulders and in open snow, scattered
// deterministically from world positions (stable across sessions; collected keys are saved).
// Only those within ~60 m of the player are instanced. A single proxy interactable follows
// whichever pickup the player is looking at, so hundreds of pickups cost one interactable.
// Sticks knocked off trees while chopping are dynamic drops (fall, land, saved).
//
// Supply caches are hand-authored loot placed deterministically in the world (a hunter's
// stash just outside the spawn clearing, a trapper's cache, a climber's pack high up...).
import * as THREE from 'three';
import type { GameContext } from '../core/types';
import { ITEMS, type ItemId } from '../core/Items';
import type { Survival } from './Survival';
import { GeoBuilder, woodTint } from './Geo';
import { hash2, mulberry32 } from '../core/math';

type PickItem = 'stick' | 'stone';

interface Spot {
  key: string;
  item: PickItem;
  x: number;
  y: number;
  z: number;
  yaw: number;
  s: number;
}

interface Drop extends Spot {
  vy: number;
  landed: boolean;
}

interface CacheDef {
  id: string;
  name: string;
  loot: Partial<Record<ItemId, number>>;
  style: 'crate' | 'woodpile' | 'pack';
}

const CACHES: CacheDef[] = [
  { id: 'hunter', name: "hunter's stash", loot: { cloth: 3, arrow: 6, torch: 1, stone: 2 }, style: 'crate' },
  { id: 'woodcutter', name: "woodcutter's camp", loot: { log: 6, stick: 8, stone: 6 }, style: 'woodpile' },
  { id: 'trapper', name: "trapper's cache", loot: { hide: 2, cloth: 2, bandage: 1 }, style: 'crate' },
  { id: 'fisher', name: "ice fisher's crate", loot: { raw_meat: 3, cloth: 2, stick: 4 }, style: 'crate' },
  { id: 'climber', name: "climber's pack", loot: { bandage: 2, cooked_meat: 2, torch: 1 }, style: 'pack' },
  { id: 'ranger', name: "ranger's lockbox", loot: { arrow: 10, hide: 1, bandage: 1 }, style: 'crate' },
];

// Scattered stashes across the whole valley: something worth skiing to wherever you look.
const STASH_NAMES = ['abandoned sled', "prospector's crate", 'snowed-in tent', "old survey cache", "poacher's stash", 'lost expedition pack', 'supply drop'];
const STASH_LOOT: [ItemId, number, number, number][] = [
  // item, min, max, weight
  ['cooked_meat', 1, 3, 3],
  ['raw_meat', 2, 4, 2],
  ['bandage', 1, 3, 3],
  ['arrow', 4, 12, 3],
  ['cloth', 2, 5, 3],
  ['torch', 1, 2, 2],
  ['hide', 1, 3, 2],
  ['stone', 3, 6, 1],
  ['bow', 1, 1, 0.5],
  ['spear', 1, 1, 0.6],
  ['hatchet', 1, 1, 0.4],
  ['crampons', 1, 1, 0.35],
  ['ice_axe', 1, 1, 0.3],
];
const STASH_COUNT = 34;
function makeStash(i: number, rng: () => number): CacheDef {
  const loot: Partial<Record<ItemId, number>> = {};
  const total = STASH_LOOT.reduce((a, l) => a + l[3], 0);
  const n = 2 + Math.floor(rng() * 3);
  for (let k = 0; k < n; k++) {
    let r = rng() * total;
    for (const [id, lo, hi, w] of STASH_LOOT) {
      if ((r -= w) > 0) continue;
      loot[id] = (loot[id] ?? 0) + lo + Math.floor(rng() * (hi - lo + 1));
      if (ITEMS[id].stack === 1) loot[id] = 1;
      break;
    }
  }
  const styles: CacheDef['style'][] = ['crate', 'crate', 'pack', 'woodpile'];
  return { id: 'stash' + i, name: STASH_NAMES[Math.floor(rng() * STASH_NAMES.length)], loot, style: styles[Math.floor(rng() * styles.length)] };
}

interface Cache {
  def: CacheDef;
  pos: THREE.Vector3;
  yaw: number;
  object: THREE.Group;
  looted: boolean;
  remove: () => void;
}

export interface PickupsSave {
  collected: string[];
  drops: { k: string; i: PickItem; p: [number, number, number]; y: number }[];
  looted: string[];
}

const RADIUS = 60;
const CAP = 400;
const REACH = 2.9;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class Pickups {
  private collected = new Set<string>();
  private drops: Drop[] = [];
  private active: Spot[] = [];
  private meshes: Record<PickItem, THREE.InstancedMesh[]> = { stick: [], stone: [] };
  private center = new THREE.Vector3(1e9, 0, 1e9);
  private dirty = true;
  private target: Spot | null = null;
  private proxyPos = new THREE.Vector3();
  private dropSeq = 0;
  private caches: Cache[] = [];

  constructor(private ctx: GameContext, private survival: Survival) {}

  init() {
    this.meshes.stick = this.instanced(this.stickGeometry());
    this.meshes.stone = this.instanced(this.stoneGeometry());
    this.registerProxy();
    this.placeCaches();
    this.ctx.events.on('tree:removed', () => (this.dirty = true));
    this.ctx.events.on('rock:removed', () => (this.dirty = true));
    this.ctx.events.on('structure:placed', () => (this.dirty = true));
  }

  reset() {
    this.collected.clear();
    this.drops.length = 0;
    this.dirty = true;
    this.target = null;
    // Interactions were cleared by the game; re-register.
    this.registerProxy();
    for (const c of this.caches) c.remove();
    this.caches.length = 0;
    this.placeCaches();
  }

  // ---------------------------------------------------------------- meshes
  private stickGeometry(): GeoBuilder {
    const g = new GeoBuilder();
    const t = woodTint(3, 0.7).multiply(new THREE.Color(0.8, 0.7, 0.6));
    g.log(new THREE.Vector3(-0.42, 0.03, 0), new THREE.Vector3(0.42, 0.03, 0.02), 0.028, { seed: 11, tint: t, radial: 6, bow: 0.04, taper: 0.4, capA: true, capB: true, snow: 0.5 });
    g.log(new THREE.Vector3(0.05, 0.03, 0.01), new THREE.Vector3(0.28, 0.035, 0.16), 0.013, { seed: 12, tint: t, radial: 5, taper: 0.5, capB: true, snow: 0.4 });
    g.log(new THREE.Vector3(-0.2, 0.03, 0), new THREE.Vector3(-0.36, 0.03, -0.1), 0.011, { seed: 13, tint: t, radial: 5, taper: 0.5, capB: true, snow: 0.4 });
    return g;
  }

  private stoneGeometry(): GeoBuilder {
    const g = new GeoBuilder();
    g.stone(new THREE.Vector3(0, 0.03, 0), 0.12, 21, { squash: 0.55, snow: 0.8, tint: new THREE.Color(0.95, 0.95, 0.97) });
    return g;
  }

  private instanced(g: GeoBuilder): THREE.InstancedMesh[] {
    const out: THREE.InstancedMesh[] = [];
    for (const ch of g.toGroup().children) {
      const src = ch as THREE.Mesh;
      const im = new THREE.InstancedMesh(src.geometry, src.material, CAP);
      im.count = 0;
      im.castShadow = true;
      im.receiveShadow = true;
      im.frustumCulled = false;
      this.ctx.scene.add(im);
      out.push(im);
    }
    return out;
  }

  // ---------------------------------------------------------------- scatter
  /** Deterministic pickups around (px, pz). */
  private scatter(px: number, pz: number): Spot[] {
    const { world: w, terrain: t } = this.ctx;
    const out: Spot[] = [];
    const phys = this.ctx.physics;
    const push = (key: string, item: PickItem, x: number, z: number, seed: number) => {
      if (this.collected.has(key)) return;
      if (!t.inBounds(x, z, 30) || t.lakeFactor(x, z) > 0.6) return;
      const y = t.heightAt(x, z);
      // Nothing to pick up under a cabin floor.
      if (phys.groundProbe(x, y + 4, z, 5).kind === 'collider') return;
      out.push({ key, item, x, y, z, yaw: hash2(seed, 91) * Math.PI * 2, s: 0.8 + hash2(seed, 92) * 0.5 });
    };
    w.forEachTree(px, pz, RADIUS, (i) => {
      const h = hash2(i, 17, 5);
      if (h < 0.34) {
        const a = hash2(i, 18) * Math.PI * 2;
        const d = w.treeRadius(i) + 0.8 + hash2(i, 19) * 2.4;
        push(`t${i}`, 'stick', w.treeX[i] + Math.cos(a) * d, w.treeZ[i] + Math.sin(a) * d, i);
      }
      if (h < 0.07) {
        const a = hash2(i, 28) * Math.PI * 2;
        const d = w.treeRadius(i) + 1.2 + hash2(i, 29) * 2.4;
        push(`t${i}b`, 'stick', w.treeX[i] + Math.cos(a) * d, w.treeZ[i] + Math.sin(a) * d, i + 7);
      }
    });
    w.forEachRock(px, pz, RADIUS, (i) => {
      const r = w.rockR[i];
      const n = r > 1.5 ? 3 : 2;
      for (let k = 0; k < n; k++) {
        if (hash2(i, k, 23) > 0.5) continue;
        const a = hash2(i, k, 24) * Math.PI * 2;
        const d = r * 0.85 + 0.35 + hash2(i, k, 25) * 1.4;
        push(`r${i}_${k}`, 'stone', w.rockX[i] + Math.cos(a) * d, w.rockZ[i] + Math.sin(a) * d, i * 3 + k);
      }
    });
    // Loose stones in open snow.
    const cell = 14;
    const g0x = Math.floor((px - RADIUS) / cell),
      g1x = Math.floor((px + RADIUS) / cell);
    const g0z = Math.floor((pz - RADIUS) / cell),
      g1z = Math.floor((pz + RADIUS) / cell);
    for (let gz = g0z; gz <= g1z; gz++)
      for (let gx = g0x; gx <= g1x; gx++) {
        if (hash2(gx, gz, 31) > 0.12) continue;
        const x = (gx + hash2(gx, gz, 32)) * cell,
          z = (gz + hash2(gx, gz, 33)) * cell;
        if ((x - px) ** 2 + (z - pz) ** 2 > RADIUS * RADIUS) continue;
        if (t.slopeAngle(x, z) > 0.6) continue;
        push(`g${gx}_${gz}`, 'stone', x, z, gx * 7 + gz * 13);
      }
    // A starter scatter in the spawn clearing (enough for a first campfire).
    const [sx, sz] = t.data.spawn;
    if ((sx - px) ** 2 + (sz - pz) ** 2 < (RADIUS + 20) ** 2) {
      for (let k = 0; k < 9; k++) {
        const a = hash2(k, 41) * Math.PI * 2;
        const d = 3.5 + hash2(k, 42) * 9;
        push(`s${k}`, k < 5 ? 'stone' : 'stick', sx + Math.cos(a) * d, sz + Math.sin(a) * d, 500 + k);
      }
    }
    return out;
  }

  private rebuild() {
    const p = this.ctx.player.position;
    this.center.copy(p);
    this.dirty = false;
    this.active = this.scatter(p.x, p.z);
    this.refreshInstances();
  }

  private refreshInstances() {
    const counts: Record<PickItem, number> = { stick: 0, stone: 0 };
    const t = this.ctx.terrain;
    const place = (s: Spot) => {
      const k = counts[s.item];
      if (k >= CAP) return;
      counts[s.item]++;
      const n = t.normalAt(s.x, s.z);
      _q.setFromUnitVectors(UP, n).multiply(new THREE.Quaternion().setFromAxisAngle(UP, s.yaw));
      _s.setScalar(s.s);
      _m.compose(_v.set(s.x, s.y - 0.015, s.z), _q, _s);
      for (const im of this.meshes[s.item]) im.setMatrixAt(k, _m);
    };
    for (const s of this.active) place(s);
    for (const d of this.drops) place(d);
    for (const item of ['stick', 'stone'] as PickItem[]) {
      for (const im of this.meshes[item]) {
        im.count = counts[item];
        im.instanceMatrix.needsUpdate = true;
      }
    }
  }

  /** A stick/stone knocked loose (e.g. while chopping): falls to the ground and can be picked up. */
  drop(item: PickItem, x: number, y: number, z: number) {
    this.drops.push({ key: `d${this.dropSeq++}_${Math.floor(x)}_${Math.floor(z)}`, item, x, y, z, yaw: Math.random() * Math.PI * 2, s: 0.9 + Math.random() * 0.3, vy: 0, landed: false });
    if (this.drops.length > 60) this.drops.shift();
    this.refreshInstances();
  }

  // ---------------------------------------------------------------- interaction
  private registerProxy() {
    this.ctx.interact.add({
      position: this.proxyPos,
      radius: 0.25,
      enabled: () => this.target !== null,
      label: () => (this.target ? `Pick up ${ITEMS[this.target.item].name.toLowerCase()}` : ''),
      onInteract: () => {
        if (this.target) this.collect(this.target);
      },
    });
  }

  private collect(s: Spot) {
    const { inventory, audio } = this.ctx;
    inventory.add(s.item, 1);
    audio.play('pickup', { position: s });
    this.survival.fx.snowBurst(s.x, s.y + 0.05, s.z, 4, 0.3, 0.5);
    const di = this.drops.indexOf(s as Drop);
    if (di >= 0) this.drops.splice(di, 1);
    else {
      this.collected.add(s.key);
      const ai = this.active.indexOf(s);
      if (ai >= 0) this.active.splice(ai, 1);
    }
    this.target = null;
    this.refreshInstances();
  }

  /** Pick the pickup under the crosshair (same scoring as core Interactions). */
  private chooseTarget() {
    const cam = this.ctx.camera;
    const eye = cam.position;
    cam.getWorldDirection(_dir);
    let best: Spot | null = null;
    let bestScore = -Infinity;
    const test = (s: Spot) => {
      _v.set(s.x - eye.x, s.y + 0.04 - eye.y, s.z - eye.z);
      const d = _v.length();
      if (d > REACH + 0.25) return;
      _v.divideScalar(Math.max(d, 1e-4));
      const dot = _v.dot(_dir);
      const minDot = Math.cos(Math.min(1.2, Math.atan2(0.45, Math.max(d, 0.3))));
      if (dot < minDot) return;
      const score = dot * 2 - d * 0.3;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    };
    const p = this.ctx.player.position;
    for (const s of this.active) if (Math.abs(s.x - p.x) < 5 && Math.abs(s.z - p.z) < 5) test(s);
    for (const d of this.drops) if (d.landed) test(d);
    this.target = best;
    if (best) this.proxyPos.set((best as Spot).x, (best as Spot).y + 0.04, (best as Spot).z);
  }

  private spotted = new Set<string>();
  private spotT = 0;

  update(dt: number) {
    const p = this.ctx.player.position;
    // Discovery: call out an unsearched stash as you come within sight of it.
    if ((this.spotT -= dt) <= 0) {
      this.spotT = 0.5;
      for (const c of this.caches) {
        if (c.looted || this.spotted.has(c.def.id)) continue;
        const d = Math.hypot(c.pos.x - p.x, c.pos.z - p.z);
        if (d < 70) {
          this.spotted.add(c.def.id);
          this.ctx.ui.toast(`You spot something: ${c.def.name}, ${Math.round(d)} m away`, 'info');
          break;
        }
      }
    }
    if (this.dirty || Math.hypot(p.x - this.center.x, p.z - this.center.z) > 8) this.rebuild();
    // Falling drops.
    let moved = false;
    for (const d of this.drops) {
      if (d.landed) continue;
      d.vy -= 9.81 * dt;
      d.y += d.vy * dt;
      d.yaw += dt * 4;
      const gy = this.ctx.terrain.heightAt(d.x, d.z);
      if (d.y <= gy) {
        d.y = gy;
        d.landed = true;
        this.survival.fx.snowBurst(d.x, gy, d.z, 3, 0.2, 0.4);
      }
      moved = true;
    }
    if (moved) this.refreshInstances();
    this.chooseTarget();
  }

  // ---------------------------------------------------------------- caches
  private placeCaches() {
    const { terrain: t, world: w } = this.ctx;
    const seed = this.ctx.game.seed;
    const [sx, sz] = t.data.spawn;
    const [lx, lz] = t.data.lakeCenter;
    const ok = (x: number, z: number, maxSlope = 0.3) => t.inBounds(x, z, 60) && t.lakeFactor(x, z) < 0.02 && t.slopeAngle(x, z) < maxSlope;
    const clearOfTrees = (x: number, z: number, r: number) => {
      let hit = false;
      w.forEachTree(x, z, r, () => {
        hit = true;
        return true;
      });
      let rock = false;
      w.forEachRock(x, z, 0.5, () => {
        rock = true;
        return true;
      });
      return !hit && !rock;
    };
    const nearTree = (x: number, z: number, r: number) => w.nearestTree(x, z, r) >= 0;
    CACHES.forEach((def, idx) => {
      const rng = mulberry32(seed * 1000 + idx * 97 + 13);
      let found: [number, number] | null = null;
      for (let tries = 0; tries < 600 && !found; tries++) {
        const a = rng() * Math.PI * 2;
        let x = 0,
          z = 0;
        if (def.id === 'hunter') {
          const d = 20 + rng() * 14;
          x = sx + Math.cos(a) * d;
          z = sz + Math.sin(a) * d;
          if (!ok(x, z) || !clearOfTrees(x, z, 1.8) || !nearTree(x, z, 6)) continue;
        } else if (def.id === 'fisher') {
          // On the shore: dry here, ice a few metres toward the lake.
          const d = 60 + rng() * 400;
          x = lx + Math.cos(a) * d;
          z = lz + Math.sin(a) * d;
          const dx = lx - x,
            dz = lz - z;
          const l = Math.hypot(dx, dz);
          if (!ok(x, z) || t.lakeFactor(x + (dx / l) * 8, z + (dz / l) * 8) < 0.5 || !clearOfTrees(x, z, 1.5)) continue;
        } else if (def.id === 'climber') {
          const d = 250 + rng() * 900;
          x = sx + Math.cos(a) * d;
          z = sz + Math.sin(a) * d;
          const h = t.heightAt(x, z);
          if (!ok(x, z, 0.45) || h < 480 || h > 900 || !clearOfTrees(x, z, 1.5)) continue;
        } else {
          const range: Record<string, [number, number]> = { woodcutter: [80, 170], trapper: [160, 300], ranger: [320, 560] };
          const [d0, d1] = range[def.id] ?? [100, 300];
          const d = d0 + rng() * (d1 - d0);
          x = sx + Math.cos(a) * d;
          z = sz + Math.sin(a) * d;
          if (!ok(x, z) || !clearOfTrees(x, z, 2)) continue;
          if (def.id !== 'ranger' && !nearTree(x, z, 12)) continue;
        }
        found = [x, z];
      }
      if (!found) return;
      const [x, z] = found;
      const pos = new THREE.Vector3(x, t.heightAt(x, z), z);
      this.addCache(def, pos, rng() * Math.PI * 2);
    });
    this.placeStashes();
  }

  private placeStashes() {
    const t = this.ctx.terrain;
    const [sx, sz] = t.data.spawn;
    const rng = mulberry32(this.ctx.game.seed * 7919 + 101);
    const placed: [number, number][] = this.caches.map((c) => [c.pos.x, c.pos.z]);
    for (let i = 0; i < STASH_COUNT; i++) {
      const def = makeStash(i, rng);
      for (let tries = 0; tries < 200; tries++) {
        const a = rng() * Math.PI * 2;
        const d = 180 + Math.sqrt(rng()) * 1700;
        const x = sx + Math.cos(a) * d,
          z = sz + Math.sin(a) * d;
        if (!t.inBounds(x, z, 80) || t.lakeFactor(x, z) > 0.02 || t.slopeAngle(x, z) > 0.4) continue;
        if (placed.some(([px, pz]) => Math.hypot(px - x, pz - z) < 160)) continue;
        let blocked = false;
        this.ctx.world.forEachTree(x, z, 1.8, () => ((blocked = true), true));
        this.ctx.world.forEachRock(x, z, 1, () => ((blocked = true), true));
        if (blocked) continue;
        placed.push([x, z]);
        this.addCache(def, new THREE.Vector3(x, t.heightAt(x, z), z), rng() * Math.PI * 2);
        break;
      }
    }
  }

  private addCache(def: CacheDef, pos: THREE.Vector3, yaw: number) {
    const g = new GeoBuilder();
    const plank = new THREE.Color(0.8, 0.74, 0.66);
    const V3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const Q0 = new THREE.Quaternion();
    if (def.style === 'crate') {
      // Plank crate with a hide thrown over it and a faded red rag on a pole as a marker.
      for (let i = 0; i < 4; i++) g.box(V3(0, 0.07 + i * 0.13, 0.26), V3(0.9, 0.12, 0.03), Q0, 'plank', { tint: woodTint(i + 3, 0.8).multiply(plank), snow: 0.4 });
      for (let i = 0; i < 4; i++) g.box(V3(0, 0.07 + i * 0.13, -0.26), V3(0.9, 0.12, 0.03), Q0, 'plank', { tint: woodTint(i + 9, 0.8).multiply(plank), snow: 0.4 });
      for (const sx of [-0.44, 0.44]) g.box(V3(sx, 0.27, 0), V3(0.03, 0.52, 0.52), Q0, 'plank', { tint: woodTint(sx * 10 + 20, 0.75).multiply(plank) });
      g.box(V3(0, 0.55, 0), V3(0.94, 0.05, 0.58), Q0, 'plank', { tint: plank.clone().multiplyScalar(0.7), snow: 1 });
      g.box(V3(0, 0.6, 0), V3(0.8, 0.1, 0.5), Q0, 'snow', {});
      g.log(V3(0.62, -0.2, 0.3), V3(0.64, 1.45, 0.32), 0.022, { seed: 5, tint: plank, radial: 6, capB: true });
      // Rag: a small quad of 'hide' tinted red (cloth).
      g.quad(V3(0.64, 1.42, 0.32), V3(0.64, 1.18, 0.32), V3(0.95, 1.16, 0.45), V3(0.93, 1.38, 0.44), 'hide', [0, 0, 1, 0, 1, 1, 0, 1], new THREE.Color(1.6, 0.35, 0.2), 0.2);
    } else if (def.style === 'woodpile') {
      const t = new THREE.Color(0.86, 0.8, 0.74);
      let k = 0;
      for (let row = 0; row < 3; row++)
        for (let i = 0; i < 4 - row; i++, k++) {
          const x = (i - (3 - row) / 2) * 0.3;
          g.log(V3(x, 0.15 + row * 0.26, -0.6), V3(x, 0.15 + row * 0.26, 0.6), 0.14, { seed: 40 + k, tint: woodTint(k, 0.9).multiply(t), capA: true, capB: true, snow: 1 });
        }
      g.log(V3(1.1, -0.1, 0.2), V3(1.1, 0.45, 0.2), 0.26, { seed: 77, tint: t, capB: true, snow: 0.6 });
    } else {
      g.log(V3(0, 0.25, -0.05), V3(0, 0.62, 0.02), 0.22, { kind: 'hide', seed: 3, tint: new THREE.Color(0.55, 0.62, 0.7), capA: true, capB: true, wobble: 0.1, snow: 0.8 });
      g.log(V3(-0.28, 0.72, 0), V3(0.28, 0.72, 0), 0.09, { kind: 'hide', seed: 4, tint: new THREE.Color(1.3, 0.5, 0.3), capA: true, capB: true, snow: 0.8 });
      g.log(V3(0.35, -0.1, 0.1), V3(0.42, 1.25, 0.18), 0.015, { seed: 6, tint: new THREE.Color(0.35, 0.35, 0.38), radial: 6, capB: true });
    }
    const object = g.toGroup();
    object.position.copy(pos);
    object.rotation.y = yaw;
    this.ctx.scene.add(object);
    const cache: Cache = { def, pos, yaw, object, looted: false, remove: () => {} };
    const off = this.ctx.interact.add({
      position: pos.clone().add(new THREE.Vector3(0, 0.5, 0)),
      radius: 0.7,
      holdTime: 1.2,
      enabled: () => !cache.looted,
      label: () => `Search the ${def.name}`,
      onInteract: () => this.loot(cache),
    });
    cache.remove = () => {
      off();
      this.ctx.scene.remove(object);
      object.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
    };
    this.caches.push(cache);
  }

  private loot(c: Cache) {
    if (c.looted) return;
    c.looted = true;
    const parts: string[] = [];
    for (const [k, n] of Object.entries(c.def.loot)) {
      this.ctx.inventory.add(k as ItemId, n!);
      parts.push(`${n} ${ITEMS[k as ItemId].name.toLowerCase()}`);
    }
    this.ctx.audio.play('pickup', { position: c.pos });
    this.ctx.ui.toast(`Found in the ${c.def.name}: ${parts.join(', ')}`, 'good');
    // The crate's lid snow gets knocked off.
    this.survival.fx.snowBurst(c.pos.x, c.pos.y + 0.6, c.pos.z, 10, 0.8, 1);
  }

  /** Cache positions (for the map / debugging). */
  cacheList() {
    return this.caches.map((c) => ({ id: c.def.id, name: c.def.name, x: c.pos.x, y: c.pos.y, z: c.pos.z, looted: c.looted }));
  }

  // ---------------------------------------------------------------- saves
  serialize(): PickupsSave {
    return {
      collected: [...this.collected],
      drops: this.drops.map((d) => ({ k: d.key, i: d.item, p: [d.x, d.y, d.z], y: d.yaw })),
      looted: this.caches.filter((c) => c.looted).map((c) => c.def.id),
    };
  }

  deserialize(d: PickupsSave) {
    this.collected = new Set(d?.collected ?? []);
    this.drops = (d?.drops ?? []).map((x) => ({ key: x.k, item: x.i, x: x.p[0], y: x.p[1], z: x.p[2], yaw: x.y, s: 1, vy: 0, landed: true }));
    const looted = new Set(d?.looted ?? []);
    for (const c of this.caches) c.looted = looted.has(c.def.id);
    this.dirty = true;
  }
}
