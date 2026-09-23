// Base class for every creature: locomotion (turn/accelerate, obstacle steering, SOLID
// collision), health + bleeding, hit colliders that follow the animated bones, the death
// collapse and the harvestable carcass. Species subclasses implement think().
import * as THREE from 'three';
import type { Species } from '../core/types';
import type { ItemId } from '../core/Items';
import { Layer, type Collider } from '../core/Physics';
import { angleDelta, clamp, damp } from '../core/math';
import type { Wildlife } from './Wildlife';
import type { QuadRig } from './QuadRig';

export interface HurtInfo {
  damage: number;
  /** Direction the blow travelled (unit). */
  dir: THREE.Vector3;
  point: THREE.Vector3;
  by: ItemId | null;
  /** 'melee' | 'arrow' | 'spear' | 'torch' */
  kind: 'melee' | 'arrow' | 'spear' | 'torch';
  /** Collider that was hit (head shots). */
  collider?: Collider;
}

export interface ColliderSpec {
  /** Bone index to follow (or -1 = body centre). */
  bone: number;
  /** Offset from that bone in model space. */
  offset: THREE.Vector3;
  radius: number;
  tag: 'body' | 'head';
}

let NEXT_ID = 1;
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _feet = new THREE.Vector3();

export abstract class Animal {
  readonly id = NEXT_ID++;
  abstract readonly species: Species;
  /** Ground position under the animal's centre. */
  readonly pos = new THREE.Vector3();
  heading = 0;
  speed = 0;
  desiredHeading = 0;
  desiredSpeed = 0;
  /** rad/s */
  turnRate = 3;
  accel = 8;
  /** Extra velocity (knockback, lunge), decays. */
  readonly push = new THREE.Vector3();
  /** Vertical offset (leaps, flight). */
  air = 0;
  radius = 0.3;
  height = 0.8;

  health = 100;
  maxHealth = 100;
  alive = true;
  /** HP lost per second from wounds. */
  bleed = 0;
  lastHurt = -999;
  killedBy: ItemId | null = null;
  state = 'idle';
  stateT = 0;
  /** Seconds since spawn. */
  age = 0;
  /** Distance to the player (updated by Wildlife each tick). */
  distToPlayer = 999;
  /** Update at a reduced rate (far LOD). */
  far = false;
  /** Set when the animal should be removed by Wildlife. */
  remove = false;
  /** Dead and settled: harvestable. */
  carcass = false;
  harvested = false;
  /** Stuck projectiles (arrows / spear) riding on this animal. */
  readonly stuck: THREE.Object3D[] = [];

  readonly object: THREE.Object3D;
  protected colliders: Collider[] = [];
  protected colliderSpecs: ColliderSpec[] = [];
  protected turnVel = 0;
  private deathT = -1;
  private deathSpin = 0;
  private deathSeed = Math.random() * 100;
  private bloodTimer = 0;
  private removeInteract: (() => void) | null = null;
  private prevHeading = 0;
  private stampSide = 0;

  constructor(protected wl: Wildlife, object: THREE.Object3D) {
    this.object = object;
    object.userData.animal = this;
  }

  get rig(): QuadRig | null {
    return null;
  }

  // ---------------------------------------------------------------- lifecycle
  place(x: number, z: number, heading = Math.random() * Math.PI * 2) {
    this.pos.set(x, this.wl.ctx.terrain.heightAt(x, z), z);
    this.heading = this.desiredHeading = this.prevHeading = heading;
  }

  addColliders() {
    const ph = this.wl.ctx.physics;
    for (const s of this.colliderSpecs) {
      this.colliders.push(ph.addSphere(this.pos, s.radius, Layer.HITTABLE | Layer.ENTITY, this, s.tag));
    }
  }

  dispose() {
    const ph = this.wl.ctx.physics;
    for (const c of this.colliders) ph.remove(c);
    this.colliders.length = 0;
    this.removeInteract?.();
    this.removeInteract = null;
    this.object.removeFromParent();
    this.rig?.dispose();
  }

  // ---------------------------------------------------------------- per-frame
  /** Behaviour: set desiredHeading / desiredSpeed / pose inputs. */
  protected abstract think(dt: number): void;
  /** Pose the model (rig) after moving. */
  protected abstract animate(dt: number, full: boolean): void;

  update(dt: number, full: boolean) {
    this.age += dt;
    this.stateT += dt;
    if (!this.alive) {
      this.updateDeath(dt);
      return;
    }
    if (this.bleed > 0) {
      this.health -= this.bleed * dt;
      this.bleed = Math.max(0, this.bleed - dt * 0.02);
      this.bloodTimer -= dt;
      if (this.bloodTimer <= 0 && full) {
        this.bloodTimer = 0.35 + Math.random() * 0.5 / Math.max(0.3, this.bleed);
        this.wl.ctx.sys.weapons?.effects?.bloodDrip(this.pos.x, this.pos.z, 0.5 + Math.min(1, this.bleed * 0.5));
      }
      if (this.health <= 0) {
        this.die(null, _v.set(Math.sin(this.heading), 0, Math.cos(this.heading)));
        return;
      }
    }
    this.think(dt);
    this.locomote(dt, full);
    this.animate(dt, full);
    this.syncColliders();
  }

  protected locomote(dt: number, full: boolean) {
    const ctx = this.wl.ctx;
    // Steering: turn toward the desired heading with a rate limit.
    const d = angleDelta(this.heading, this.desiredHeading);
    const want = clamp(d * 4, -this.turnRate, this.turnRate);
    this.turnVel = damp(this.turnVel, want, 10, dt);
    this.heading += this.turnVel * dt;
    // Sharp turns bleed speed.
    const turnPenalty = 1 - Math.min(0.6, Math.abs(d) / Math.PI);
    const target = this.desiredSpeed * turnPenalty;
    const a = target > this.speed ? this.accel : this.accel * 1.6;
    this.speed += clamp(target - this.speed, -a * dt, a * dt);

    const fx = Math.sin(this.heading),
      fz = Math.cos(this.heading);
    _feet.set(this.pos.x + (fx * this.speed + this.push.x) * dt, this.pos.y, this.pos.z + (fz * this.speed + this.push.z) * dt);
    this.push.multiplyScalar(Math.exp(-4 * dt));
    if (this.speed > 0.05 || this.push.lengthSq() > 0.01) {
      if (full || this.distToPlayer < 160) {
        _feet.y = ctx.terrain.heightAt(_feet.x, _feet.z);
        ctx.physics.resolveCapsule(_feet, this.radius, this.height, Layer.SOLID);
      }
      const t = ctx.terrain;
      const m = t.half - 30;
      _feet.x = clamp(_feet.x, -m, m);
      _feet.z = clamp(_feet.z, -m, m);
      this.pos.set(_feet.x, t.heightAt(_feet.x, _feet.z), _feet.z);
    }
    this.prevHeading = this.heading;
  }

  /** Steering helper: heading toward a world point. */
  headingTo(x: number, z: number) {
    return Math.atan2(x - this.pos.x, z - this.pos.z);
  }

  /** Heading away from a point, with obstacle + slope avoidance and optional jitter. */
  steerAvoid(heading: number, lookAhead = 3): number {
    const ctx = this.wl.ctx;
    const w = ctx.world;
    const ax = this.pos.x + Math.sin(heading) * lookAhead,
      az = this.pos.z + Math.cos(heading) * lookAhead;
    let rx = 0,
      rz = 0;
    w.forEachTree(ax, az, 2.2, (i) => {
      const dx = ax - w.treeX[i],
        dz = az - w.treeZ[i];
      const dd = Math.max(0.3, Math.hypot(dx, dz));
      rx += (dx / dd) * (2.2 - dd);
      rz += (dz / dd) * (2.2 - dd);
    });
    w.forEachRock(ax, az, 0.5, (i) => {
      const dx = ax - w.rockX[i],
        dz = az - w.rockZ[i];
      const dd = Math.max(0.3, Math.hypot(dx, dz));
      rx += (dx / dd) * 1.5;
      rz += (dz / dd) * 1.5;
    });
    // Too steep ahead: slide along the contour.
    const slope = ctx.terrain.slopeAngle(ax, az);
    if (slope > 0.62) {
      const n = ctx.terrain.normalAt(ax, az, _w);
      rx += n.x * 3 * (slope - 0.62) * 4;
      rz += n.z * 3 * (slope - 0.62) * 4;
    }
    if (rx === 0 && rz === 0) return heading;
    const hx = Math.sin(heading) + rx * 0.6,
      hz = Math.cos(heading) + rz * 0.6;
    return Math.atan2(hx, hz);
  }

  protected syncColliders() {
    const rig = this.rig;
    for (let i = 0; i < this.colliders.length; i++) {
      const s = this.colliderSpecs[i];
      const c = this.colliders[i];
      if (rig && s.bone >= 0) {
        rig.boneWorld(s.bone, c.position);
        _v.copy(s.offset).applyQuaternion(this.object.quaternion);
        c.position.add(_v);
      } else {
        c.position.copy(this.pos).add(s.offset);
        c.position.y += this.air;
      }
      this.wl.ctx.physics.updateCollider(c);
    }
  }

  // ---------------------------------------------------------------- damage
  /** Apply a hit. Returns true if it killed the animal. */
  hurt(info: HurtInfo): boolean {
    if (!this.alive) return false;
    let dmg = info.damage;
    if (info.collider?.tag === 'head') dmg *= 1.8;
    this.health -= dmg;
    this.lastHurt = this.wl.ctx.time;
    this.bleed += dmg * 0.012;
    this.push.addScaledVector(_v.set(info.dir.x, 0, info.dir.z).normalize(), Math.min(4, dmg * 0.06));
    this.wl.ctx.sys.weapons?.effects?.blood(info.point, info.dir, Math.min(1.5, 0.4 + dmg / 40));
    if (this.health <= 0) {
      this.die(info.by, info.dir);
      return true;
    }
    this.onHurt(info);
    return false;
  }

  protected onHurt(_info: HurtInfo) {}

  die(by: ItemId | null, dir: THREE.Vector3) {
    if (!this.alive) return;
    this.alive = false;
    this.health = 0;
    this.killedBy = by;
    this.deathT = 0;
    this.state = 'dead';
    // Fall away from the blow, keep some momentum.
    const side = Math.sign(-dir.x * Math.cos(this.heading) + dir.z * Math.sin(this.heading)) || (Math.random() < 0.5 ? -1 : 1);
    this.deathSpin = side;
    const rig = this.rig;
    if (rig) rig.lookTarget = null;
    for (const c of this.colliders) c.layers = Layer.HITTABLE; // still hittable (arrows stick), no longer an entity
    this.onDeath();
    this.wl.onKilled(this);
  }

  protected onDeath() {}

  /** Lying-on-side body height (m, bind scale). */
  protected lieHeight = 0.15;

  private updateDeath(dt: number) {
    if (this.carcass) return;
    const rig = this.rig;
    this.deathT += dt;
    const t = this.deathT;
    // Slide to a stop.
    this.speed = damp(this.speed, 0, 3.5, dt);
    this.desiredSpeed = 0;
    this.turnVel = damp(this.turnVel, 0, 5, dt);
    const fx = Math.sin(this.heading),
      fz = Math.cos(this.heading);
    this.pos.x += (fx * this.speed + this.push.x) * dt;
    this.pos.z += (fz * this.speed + this.push.z) * dt;
    this.push.multiplyScalar(Math.exp(-5 * dt));
    this.pos.y = this.wl.ctx.terrain.heightAt(this.pos.x, this.pos.z);
    this.air = damp(this.air, 0, 12, dt);
    if (rig) {
      // Legs buckle first (0-0.3s), then the body tips over with a little bounce.
      const buckle = clamp(t / 0.3, 0, 1);
      const tip = clamp((t - 0.18) / 0.5, 0, 1);
      const roll = tip < 1 ? tip * tip * 1.62 : 1.62 - Math.sin(Math.min(1, (t - 0.68) / 0.35) * Math.PI) * 0.1;
      rig.speed = 0;
      rig.dead = Math.min(0.999, buckle * 0.6 + tip * 0.4);
      rig.deadRoll = Math.min(1.5, roll) * this.deathSpin;
      rig.crouch = buckle;
      rig.lieHeight = this.lieHeight;
      rig.update(dt, this.pos, this.heading, this.wl.ctx.terrain, true);
      rig.relaxLegs(clamp((t - 0.15) * 3, 0, 1), this.deathSeed);
      rig.mesh.updateMatrixWorld(true);
      if (t > 1.2) {
        rig.dead = 1;
        rig.poseDead(this.deathSeed);
        rig.mesh.updateMatrixWorld(true);
        this.becomeCarcass();
      }
    } else if (t > 1.2) this.becomeCarcass();
    this.syncColliders();
  }

  // ---------------------------------------------------------------- carcass
  protected harvestLabel(): string {
    return 'Harvest ' + this.displayName;
  }
  get displayName(): string {
    return this.species;
  }
  protected harvestYield(): Partial<Record<ItemId, number>> {
    return { raw_meat: 1 };
  }

  private becomeCarcass() {
    this.carcass = true;
    this.state = 'carcass';
    this.stateT = 0;
    const ctx = this.wl.ctx;
    const center = new THREE.Vector3();
    if (this.rig) this.rig.boneWorld(1, center).lerp(this.rig.boneWorld(2, _w), 0.5);
    else center.copy(this.pos).setY(this.pos.y + 0.1);
    this.removeInteract = ctx.interact.add({
      position: center,
      radius: this.species === 'deer' ? 0.9 : this.species === 'wolf' ? 0.7 : 0.4,
      holdTime: this.species === 'deer' ? 2.2 : this.species === 'wolf' ? 2 : 1.2,
      label: () => this.harvestLabel(),
      enabled: () => !this.harvested,
      onInteract: () => this.harvest(),
    });
  }

  harvest() {
    if (this.harvested) return;
    const ctx = this.wl.ctx;
    this.harvested = true;
    const got: string[] = [];
    const y = this.harvestYield();
    for (const k in y) {
      const n = y[k as ItemId]!;
      const added = ctx.inventory.add(k as ItemId, n);
      if (added > 0) got.push(`${added} ${k.replace('_', ' ')}`);
    }
    // Recover arrows / spears that were stuck in the body.
    ctx.sys.weapons?.projectiles?.recoverFrom(this);
    ctx.audio.play('pickup', { position: this.pos });
    ctx.audio.play('axe_hit_flesh', { position: this.pos, volume: 0.5, pitch: 0.8 });
    if (got.length) ctx.ui.toast('+ ' + got.join(', '), 'good');
    ctx.sys.weapons?.effects?.bloodPatch(this.pos.x, this.pos.z, this.species === 'deer' ? 1.3 : this.species === 'wolf' ? 1.0 : 0.45);
    ctx.events.emit('animal:harvested', { species: this.species, id: this.id });
    this.removeInteract?.();
    this.removeInteract = null;
    this.remove = true;
  }

  /** Save data for a carcass. */
  serializeCarcass() {
    return { s: this.species, x: +this.pos.x.toFixed(2), z: +this.pos.z.toFixed(2), h: +this.heading.toFixed(3), r: this.deathSpin, v: this.variant };
  }
  variant = 0;

  /** Instantly lay this animal down as a carcass (loading saves). */
  forceCarcass(roll: number) {
    this.alive = false;
    this.health = 0;
    this.state = 'dead';
    this.deathSpin = roll || 1;
    this.deathT = 5;
    for (const c of this.colliders) c.layers = Layer.HITTABLE;
    const rig = this.rig;
    if (rig) {
      rig.dead = 0.999;
      rig.deadRoll = 1.5 * this.deathSpin;
      rig.lieHeight = this.lieHeight;
      rig.update(0.016, this.pos, this.heading, this.wl.ctx.terrain, true);
      rig.dead = 1;
      rig.poseDead(this.deathSeed);
      rig.mesh.updateMatrixWorld(true);
    }
    this.syncColliders();
    this.becomeCarcass();
  }
}
