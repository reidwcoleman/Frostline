// Arrows and thrown spears: ballistic flight with gravity + quadratic drag, continuous
// raycasts along each frame's path segment (no tunnelling), impact resolution, sticking
// at the impact angle (trees, ground, animals — riding along on the animal's bones) and
// pickup interactions. Stuck projectiles persist in saves.
import * as THREE from 'three';
import type { GameContext } from '../core/types';
import type { ItemId } from '../core/Items';
import { Layer, type RayHit } from '../core/Physics';
import { Animal } from '../wildlife/Animal';
import type { Weapons } from './Weapons';
import { clamp } from '../core/math';

type Kind = 'arrow' | 'spear';
type PState = 'fly' | 'stuck' | 'lying' | 'dead';

interface Proj {
  kind: Kind;
  obj: THREE.Object3D;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  roll: number;
  state: PState;
  age: number;
  launchSpeed: number;
  animal: Animal | null;
  removeInteract: (() => void) | null;
  trail: THREE.Mesh | null;
  bounced: number;
  /** Hotbar slot the spear came from (put it back there). */
  slot: number;
}

const _dir = new THREE.Vector3();
const _seg = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const FWD = new THREE.Vector3(0, 0, 1);
const MAX_STUCK = 40;
const G = 9.81;

export class Projectiles {
  readonly root = new THREE.Group();
  private list: Proj[] = [];
  private trailGeo: THREE.BufferGeometry;
  private trailMat: THREE.MeshBasicMaterial;

  constructor(private ctx: GameContext, private w: Weapons) {
    this.root.name = 'projectiles';
    // Faint speed streak behind arrows (two crossed quads).
    const g = new THREE.PlaneGeometry(0.012, 1);
    g.rotateX(Math.PI / 2);
    g.translate(0, 0, -0.5);
    const g2 = g.clone().rotateZ(Math.PI / 2);
    const pos = [...(g.getAttribute('position').array as Float32Array), ...(g2.getAttribute('position').array as Float32Array)];
    const uv = [...(g.getAttribute('uv').array as Float32Array), ...(g2.getAttribute('uv').array as Float32Array)];
    const idx = [...(g.index!.array as Uint16Array), ...Array.from(g2.index!.array as Uint16Array).map((i) => i + 4)];
    this.trailGeo = new THREE.BufferGeometry();
    this.trailGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.trailGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    this.trailGeo.setIndex(idx);
    const cv = document.createElement('canvas');
    cv.width = 4;
    cv.height = 64;
    const c2 = cv.getContext('2d')!;
    const gr = c2.createLinearGradient(0, 0, 0, 64);
    gr.addColorStop(0, 'rgba(255,255,255,0)');
    gr.addColorStop(1, 'rgba(255,255,255,1)');
    c2.fillStyle = gr;
    c2.fillRect(0, 0, 4, 64);
    const tex = new THREE.CanvasTexture(cv);
    this.trailMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
  }

  init() {
    this.ctx.scene.add(this.root);
  }

  /** Fire an arrow. Speed in m/s. */
  fireArrow(origin: THREE.Vector3, dir: THREE.Vector3, speed: number) {
    const obj = this.w.makeArrowModel();
    const p = this.spawn('arrow', obj, origin, dir, speed);
    const trail = new THREE.Mesh(this.trailGeo, this.trailMat);
    trail.frustumCulled = false;
    obj.add(trail);
    p.trail = trail;
    trail.position.z = -0.74;
    return p;
  }

  throwSpear(origin: THREE.Vector3, dir: THREE.Vector3, speed: number, slot: number) {
    const obj = this.w.makeSpearModel();
    const p = this.spawn('spear', obj, origin, dir, speed);
    p.slot = slot;
    return p;
  }

  private spawn(kind: Kind, obj: THREE.Object3D, origin: THREE.Vector3, dir: THREE.Vector3, speed: number): Proj {
    const p: Proj = {
      kind,
      obj,
      pos: origin.clone(),
      vel: dir.clone().multiplyScalar(speed),
      roll: Math.random() * 6,
      state: 'fly',
      age: 0,
      launchSpeed: speed,
      animal: null,
      removeInteract: null,
      trail: null,
      bounced: 0,
      slot: -1,
    };
    // Inherit some of the shooter's motion (skiing + throwing works).
    p.vel.addScaledVector(this.ctx.player.velocity, 0.8);
    this.orient(p);
    this.root.add(obj);
    this.list.push(p);
    return p;
  }

  private orient(p: Proj) {
    _dir.copy(p.vel).normalize();
    _q.setFromUnitVectors(FWD, _dir);
    p.obj.quaternion.copy(_q);
    if (p.kind === 'spear') p.obj.rotateZ(p.roll);
    p.obj.position.copy(p.pos);
  }

  update(dt: number) {
    const ctx = this.ctx;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.age += dt;
      if (p.state === 'fly') this.fly(p, dt);
      else if (p.state === 'stuck' && p.animal) {
        // Animal was removed (despawned / harvested) with the arrow still in it.
        if (p.animal.remove || !p.obj.parent) {
          this.kill(p);
        }
      }
      if (p.state === 'dead') {
        this.list.splice(i, 1);
        continue;
      }
    }
    // Cap the number of lying/stuck projectiles (oldest arrows go first).
    let stuck = 0;
    for (const p of this.list) if (p.state !== 'fly') stuck++;
    if (stuck > MAX_STUCK) {
      const victim = this.list.find((p) => p.state !== 'fly' && p.kind === 'arrow' && !p.animal);
      if (victim) this.kill(victim);
    }
    void ctx;
  }

  private fly(p: Proj, dt: number) {
    const ctx = this.ctx;
    // Integrate in two substeps for a smooth arc.
    const steps = 2;
    const h = dt / steps;
    const drag = p.kind === 'arrow' ? 0.0028 : 0.0045;
    for (let s = 0; s < steps; s++) {
      const sp = p.vel.length();
      p.vel.multiplyScalar(Math.exp(-drag * sp * h));
      p.vel.y -= G * h;
      _seg.copy(p.vel).multiplyScalar(h);
      const len = _seg.length();
      if (len < 1e-6) continue;
      _dir.copy(_seg).divideScalar(len);
      const hit = ctx.physics.raycast(p.pos, _dir, len + (p.kind === 'spear' ? 0.05 : 0), { mask: Layer.HITTABLE });
      if (hit) {
        this.impact(p, hit, _dir.clone());
        return;
      }
      p.pos.add(_seg);
    }
    if (p.kind === 'spear') p.roll += dt * 2.2;
    this.orient(p);
    if (p.trail) {
      const sp = p.vel.length();
      p.trail.scale.set(1, 1, clamp(sp * 0.03, 0.1, 1.8));
      p.trail.visible = sp > 15 && p.age > 0.03;
    }
    const t = ctx.terrain;
    if (p.age > 12 || !t.inBounds(p.pos.x, p.pos.z, 5) || p.pos.y < t.heightAt(p.pos.x, p.pos.z) - 3) this.kill(p);
    else if (p.kind === 'arrow' && p.age > 0.05 && p.age < 0.4 && Math.random() < dt * 4) {
      /* whoosh handled at launch */
    }
  }

  private impact(p: Proj, hit: RayHit, dir: THREE.Vector3) {
    const ctx = this.ctx;
    const speed = p.vel.length();
    const tool: ItemId = p.kind;
    const k = clamp(speed / (p.kind === 'arrow' ? 60 : 30), 0.2, 1.2);
    const dmg = p.kind === 'arrow' ? 18 + 42 * k * k : 40 + 42 * k;
    const res = this.w.resolveHit(hit, dir, tool, dmg, p.kind);
    if (p.trail) p.trail.visible = false;

    if (res.material === 'stone') {
      // Glance off rock.
      const n = hit.normal;
      p.vel.reflect(n).multiplyScalar(0.28);
      p.pos.copy(hit.point).addScaledVector(n, 0.05);
      p.bounced++;
      if (p.kind === 'arrow' && (Math.random() < 0.5 || p.bounced > 1)) {
        this.w.effects.woodChips(hit.point, n, dir, 0.4);
        ctx.audio.play('branch_snap', { position: hit.point, volume: 0.5, pitch: 1.6 });
        this.kill(p);
        return;
      }
      if (p.vel.length() < 2.5 || p.bounced > 3) this.lieDown(p);
      return;
    }
    if (res.material === 'ice' && p.kind === 'arrow' && speed * Math.abs(dir.dot(hit.normal)) < 20) {
      p.vel.reflect(hit.normal).multiplyScalar(0.3);
      p.pos.copy(hit.point).addScaledVector(hit.normal, 0.03);
      if (p.vel.length() < 3 || ++p.bounced > 2) this.lieDown(p);
      return;
    }

    // Stick in at the impact angle.
    const depth = res.material === 'snow' ? (p.kind === 'arrow' ? 0.24 : 0.32) : res.material === 'flesh' ? (p.kind === 'arrow' ? 0.16 : 0.28) : p.kind === 'arrow' ? 0.05 : 0.1;
    p.pos.copy(hit.point).addScaledVector(dir, depth);
    p.vel.copy(dir).multiplyScalar(1e-3);
    this.orient(p);
    p.state = 'stuck';
    if (res.animal && res.animal.object) {
      // Ride along on the nearest bone of the animal.
      const a = res.animal;
      const bone = this.nearestBone(a, hit.point);
      (bone ?? a.object).attach(p.obj);
      p.animal = a;
      a.stuck.push(p.obj);
      return;
    }
    // Quiver on impact (visual): brief wobble.
    this.wobble(p);
    this.addPickup(p);
  }

  private nearestBone(a: Animal, point: THREE.Vector3): THREE.Object3D | null {
    const rig = a.rig;
    if (!rig) return null;
    let best: THREE.Object3D | null = null,
      bd = Infinity;
    for (const i of [1, 2, 3, 4]) {
      const b = rig.bones[i];
      b.getWorldPosition(_v);
      const d = _v.distanceToSquared(point);
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    return best;
  }

  private wobble(p: Proj) {
    const obj = p.obj;
    const base = obj.quaternion.clone();
    const t0 = this.ctx.time;
    const axis = new THREE.Vector3(1, 0, 0);
    const tick = () => {
      const t = this.ctx.time - t0;
      if (t > 0.5 || p.state !== 'stuck' || !obj.parent) {
        obj.quaternion.copy(base);
        return;
      }
      const a = Math.sin(t * 60) * 0.06 * Math.exp(-t * 9);
      obj.quaternion.copy(base).multiply(_q.setFromAxisAngle(axis, a));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  private lieDown(p: Proj) {
    const t = this.ctx.terrain;
    const y = t.heightAt(p.pos.x, p.pos.z);
    p.pos.y = y + (p.kind === 'spear' ? 0.02 : 0.01);
    const yaw = Math.atan2(p.vel.x, p.vel.z) || Math.random() * 6;
    p.obj.position.copy(p.pos);
    p.obj.quaternion.setFromEuler(new THREE.Euler(0.05, yaw, 0, 'YXZ'));
    // Lift so the shaft lies on the snow rather than through it.
    p.obj.position.y += 0.015;
    p.state = 'lying';
    if (p.trail) p.trail.visible = false;
    this.addPickup(p);
  }

  private addPickup(p: Proj) {
    const ctx = this.ctx;
    // The grab point is the middle of the visible shaft.
    const back = p.kind === 'arrow' ? 0.45 : 0.9;
    const pos = new THREE.Vector3(0, 0, -back).applyQuaternion(p.obj.quaternion).add(p.obj.position);
    p.removeInteract = ctx.interact.add({
      position: pos,
      radius: p.kind === 'arrow' ? 0.35 : 0.7,
      label: () => (p.kind === 'arrow' ? 'Pick up arrow' : 'Pick up spear'),
      onInteract: () => this.pickup(p),
    });
  }

  pickup(p: Proj) {
    const ctx = this.ctx;
    if (p.state === 'dead') return;
    if (p.kind === 'spear') {
      this.returnSpear(p.slot);
    } else if (Math.random() < 0.7) {
      ctx.inventory.add('arrow', 1);
      ctx.audio.play('pickup', { volume: 0.7 });
    } else {
      ctx.ui.toast('The arrow snapped', 'warn');
      ctx.audio.play('branch_snap', { volume: 0.6, pitch: 1.5 });
    }
    this.kill(p);
  }

  private returnSpear(slot: number) {
    const inv = this.ctx.inventory;
    if (inv.has('spear')) {
      this.ctx.ui.toast('You can only carry one spear', 'warn');
      return;
    }
    inv.add('spear', 1);
    // Put it back in the slot it was thrown from, if that slot is still free.
    const now = inv.hotbar.indexOf('spear');
    if (slot >= 0 && now >= 0 && now !== slot && inv.hotbar[slot] === null) {
      inv.hotbar[now] = null;
      inv.hotbar[slot] = 'spear';
    }
    this.ctx.audio.play('pickup');
    if (inv.equipped === null) inv.select(inv.hotbar.indexOf('spear'));
  }

  /** Harvesting a carcass recovers the projectiles stuck in it. */
  recoverFrom(a: Animal) {
    let arrows = 0,
      broken = 0;
    for (const p of this.list) {
      if (p.animal !== a || p.state === 'dead') continue;
      if (p.kind === 'spear') this.returnSpear(p.slot);
      else if (Math.random() < 0.7) arrows++;
      else broken++;
      this.kill(p);
    }
    if (arrows) this.ctx.inventory.add('arrow', arrows);
    if (arrows || broken) this.ctx.ui.toast(`Recovered ${arrows} arrow${arrows === 1 ? '' : 's'}` + (broken ? ` (${broken} broke)` : ''), arrows ? 'good' : 'warn');
  }

  private kill(p: Proj) {
    p.state = 'dead';
    p.removeInteract?.();
    p.removeInteract = null;
    p.obj.removeFromParent();
    if (p.animal) {
      const i = p.animal.stuck.indexOf(p.obj);
      if (i >= 0) p.animal.stuck.splice(i, 1);
      if (p.kind === 'spear' && p.animal.remove && !p.animal.harvested) {
        // The spear went off with a fleeing animal that despawned: drop it where it was last seen.
        const q = this.list.find((x) => x === p);
        void q;
      }
    }
  }

  /** Is any thrown spear still out in the world? */
  spearOut(): boolean {
    return this.list.some((p) => p.kind === 'spear' && p.state !== 'dead');
  }

  reset() {
    for (const p of this.list) {
      p.removeInteract?.();
      p.obj.removeFromParent();
    }
    this.list.length = 0;
  }

  serialize() {
    return this.list
      .filter((p) => (p.state === 'stuck' || p.state === 'lying') && !p.animal)
      .map((p) => ({ k: p.kind, p: p.obj.position.toArray().map((v) => +v.toFixed(3)), q: p.obj.quaternion.toArray().map((v) => +v.toFixed(4)), s: p.slot, l: p.state === 'lying' ? 1 : 0 }));
  }

  deserialize(d: { k: Kind; p: number[]; q: number[]; s: number; l: number }[]) {
    this.reset();
    for (const e of d ?? []) {
      const obj = e.k === 'arrow' ? this.w.makeArrowModel() : this.w.makeSpearModel();
      obj.position.fromArray(e.p);
      obj.quaternion.fromArray(e.q);
      const p: Proj = { kind: e.k, obj, pos: obj.position.clone(), vel: new THREE.Vector3(), roll: 0, state: e.l ? 'lying' : 'stuck', age: 99, launchSpeed: 0, animal: null, removeInteract: null, trail: null, bounced: 0, slot: e.s };
      this.root.add(obj);
      this.list.push(p);
      this.addPickup(p);
    }
  }

  /** Dev: how many are flying / stuck. */
  stats() {
    const out: Record<string, number> = {};
    for (const p of this.list) out[p.kind + ':' + p.state] = (out[p.kind + ':' + p.state] ?? 0) + 1;
    return out;
  }
}

void _m;
