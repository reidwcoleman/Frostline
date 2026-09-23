// Deer: small herds that graze in glades, lift their heads to check for danger, stare
// and snort when alarmed (white tail flagged), then bolt in zig-zags. Wounded deer bleed
// and leave a trail you can follow.
import * as THREE from 'three';
import { Animal, type HurtInfo } from './Animal';
import { QuadRig } from './QuadRig';
import { DEER_COLLIDERS, DEER_GAIT } from './species';
import type { Wildlife } from './Wildlife';
import { angleDelta, clamp, damp } from '../core/math';
import type { ItemId } from '../core/Items';

type DeerMode = 'graze' | 'look' | 'walk' | 'alert' | 'flee';

const _v = new THREE.Vector3();

export class Deer extends Animal {
  readonly species = 'deer' as const;
  readonly q: QuadRig;
  herd: Herd | null = null;
  mode: DeerMode = 'graze';
  modeT = 0;
  modeDur = 4;
  slot = 0;
  readonly lookAt = new THREE.Vector3();
  private lookAround = 0;
  private zigPhase = Math.random() * 10;
  readonly buck: boolean;

  constructor(wl: Wildlife, buck: boolean, scale: number) {
    const model = wl.models.deer[buck ? 1 : 0];
    const rig = new QuadRig(model.geometry, wl.mat.material, model.joints, DEER_GAIT, scale);
    super(wl, rig.mesh);
    this.q = rig;
    this.buck = buck;
    this.variant = buck ? 1 : 0;
    this.maxHealth = this.health = buck ? 110 : 90;
    this.colliderSpecs = DEER_COLLIDERS;
    this.radius = 0.35;
    this.height = 1.4;
    this.turnRate = 3.2;
    this.accel = 12;
    this.lieHeight = 0.2;
    this.modeDur = 2 + Math.random() * 6;
    rig.onFootDown = (_l, x, z) => {
      if (this.distToPlayer < 70) wl.ctx.snow.stamp({ x, z, dirX: Math.sin(this.heading), dirZ: Math.cos(this.heading), width: 0.07, length: 0.1, depth: 0.6, kind: 'hoof' });
    };
  }

  override get rig() {
    return this.q;
  }
  override get displayName() {
    return 'deer';
  }
  protected override harvestYield(): Partial<Record<ItemId, number>> {
    return { raw_meat: 3, hide: 2 };
  }

  setMode(m: DeerMode, dur: number) {
    this.mode = m;
    this.modeT = 0;
    this.modeDur = dur;
  }

  protected think(dt: number) {
    const wl = this.wl;
    const q = this.q;
    const h = this.herd;
    this.modeT += dt;
    let graze = 0,
      headUp = 0,
      tailUp = -0.1,
      ears = 0,
      twitch = 0;
    q.lookTarget = null;
    // Wounded animals are slower.
    const hurt = clamp(this.health / this.maxHealth, 0.35, 1);

    switch (this.mode) {
      case 'graze': {
        graze = 1;
        this.desiredSpeed = Math.sin(this.age * 0.3 + this.slot) > 0.75 ? 0.35 : 0;
        if (this.modeT > this.modeDur) {
          const r = Math.random();
          if (r < 0.45) this.setMode('look', 1.5 + Math.random() * 2.5);
          else if (r < 0.8) {
            this.pickSpot();
            this.setMode('walk', 6);
          } else this.setMode('graze', 3 + Math.random() * 5);
        }
        twitch = Math.sin(this.age * 7) > 0.97 ? 1 : 0;
        break;
      }
      case 'look': {
        headUp = 0.15;
        this.desiredSpeed = 0;
        // Scan the surroundings.
        this.lookAround += dt * 0.8;
        const a = this.heading + Math.sin(this.lookAround + this.slot) * 1.2;
        this.lookAt.set(this.pos.x + Math.sin(a) * 10, this.pos.y + 1.2, this.pos.z + Math.cos(a) * 10);
        q.lookTarget = this.lookAt;
        twitch = Math.sin(this.age * 5) > 0.9 ? 1 : 0;
        if (this.modeT > this.modeDur) this.setMode('graze', 3 + Math.random() * 6);
        break;
      }
      case 'walk': {
        graze = 0.15;
        const dx = this.lookAt.x - this.pos.x,
          dz = this.lookAt.z - this.pos.z;
        if (Math.hypot(dx, dz) < 1 || this.modeT > this.modeDur) this.setMode('graze', 3 + Math.random() * 6);
        else {
          this.desiredHeading = this.steerAvoid(Math.atan2(dx, dz), 2.5);
          this.desiredSpeed = 1.05;
        }
        break;
      }
      case 'alert': {
        // Stare at the threat, tail up, ears forward.
        headUp = 0.35;
        tailUp = 0.9;
        this.desiredSpeed = 0;
        if (h) {
          q.lookTarget = _v.set(h.threat.x, h.threat.y + 1.2, h.threat.z);
          const toT = this.headingTo(h.threat.x, h.threat.z);
          if (Math.abs(angleDelta(this.heading, toT)) > 1.2) this.desiredHeading = toT;
          this.lookAt.copy(q.lookTarget);
          q.lookTarget = this.lookAt;
        }
        break;
      }
      case 'flee': {
        tailUp = 1;
        ears = 0.3;
        const base = h ? h.fleeHeading : this.heading;
        this.zigPhase += dt * (1.3 + (this.slot % 3) * 0.2);
        const zig = Math.sin(this.zigPhase) * 0.45 + Math.sin(this.zigPhase * 2.7) * 0.15;
        let hd = base + zig;
        // Cohesion: drift toward the herd centre.
        if (h) {
          const c = h.centroid(_v);
          const dc = Math.hypot(c.x - this.pos.x, c.z - this.pos.z);
          if (dc > 6) hd += angleDelta(hd, this.headingTo(c.x, c.z)) * 0.3;
        }
        this.desiredHeading = this.steerAvoid(hd, 4);
        this.desiredSpeed = (11 + (this.slot % 3) * 0.6) * hurt;
        if (this.modeT > this.modeDur) this.setMode('look', 2 + Math.random() * 2);
        break;
      }
    }
    q.graze = damp(q.graze, graze, 2.5, dt);
    q.headUp = damp(q.headUp, headUp, 5, dt);
    q.tailUp = damp(q.tailUp, tailUp, 6, dt);
    q.earsBack = damp(q.earsBack, ears, 6, dt);
    q.earTwitch = damp(q.earTwitch, twitch, 20, dt);
  }

  private pickSpot() {
    const h = this.herd;
    const cx = h ? h.home.x : this.pos.x,
      cz = h ? h.home.z : this.pos.z;
    const a = Math.random() * Math.PI * 2,
      r = 2 + Math.random() * 10;
    this.lookAt.set(cx + Math.sin(a) * r, 0, cz + Math.cos(a) * r);
  }

  protected override onHurt(info: HurtInfo) {
    this.wl.ctx.audio.play('deer_alert', { position: this.pos, pitch: 1.2 });
    // Deeper wounds bleed more: a solid arrow hit often means following a blood trail.
    this.bleed += info.damage * 0.01;
    if (this.herd) this.herd.panic(this.wl.player, true);
    else this.setMode('flee', 12);
  }

  protected override onDeath() {
    this.wl.ctx.audio.play('deer_die', { position: this.pos });
    if (this.herd) this.herd.panic(this.wl.player, true);
  }

  protected animate(dt: number, full: boolean) {
    const q = this.q;
    q.speed = this.speed;
    q.turn = this.turnVel;
    q.update(dt, this.pos, this.heading, this.wl.ctx.terrain, full);
  }
}

// ============================================================================ HERD
export class Herd {
  readonly members: Deer[] = [];
  readonly home = new THREE.Vector3();
  readonly threat = new THREE.Vector3();
  state: 'calm' | 'alert' | 'flee' = 'calm';
  stateT = 0;
  fleeHeading = 0;
  private tick = Math.random() * 0.3;
  private snorted = false;

  constructor(private wl: Wildlife) {}

  add(d: Deer) {
    d.herd = this;
    d.slot = this.members.length;
    this.members.push(d);
  }

  get alive() {
    return this.members.some((m) => !m.remove);
  }

  centroid(out: THREE.Vector3) {
    out.set(0, 0, 0);
    let n = 0;
    for (const m of this.members) {
      if (!m.alive) continue;
      out.add(m.pos);
      n++;
    }
    return n ? out.divideScalar(n) : out.copy(this.home);
  }

  /** Something scary happened (hit, loud noise, wolf): bolt away from `from`. */
  panic(from: THREE.Vector3, immediate = false) {
    const c = this.centroid(_v);
    this.threat.copy(from);
    const away = Math.atan2(c.x - from.x, c.z - from.z);
    this.fleeHeading = away + (Math.random() - 0.5) * 0.9;
    if (this.state !== 'flee' && !immediate) {
      this.alert(from);
      return;
    }
    this.state = 'flee';
    this.stateT = 0;
    for (const m of this.members) if (m.alive) m.setMode('flee', 10 + Math.random() * 6);
  }

  alert(from: THREE.Vector3) {
    this.threat.copy(from);
    if (this.state !== 'calm') return;
    this.state = 'alert';
    this.stateT = 0;
    this.snorted = false;
    for (const m of this.members) if (m.alive) m.setMode('alert', 99);
  }

  update(dt: number) {
    const wl = this.wl;
    this.stateT += dt;
    this.tick -= dt;
    if (this.tick > 0) return;
    this.tick = 0.25;
    const c = this.centroid(_v);
    const p = wl.player;
    const dist = Math.hypot(c.x - p.x, c.z - p.z);
    const detect = wl.detectRange(48, c);
    // Wolves nearby are threats too.
    const wolf = wl.nearest('wolf', c, 45);

    switch (this.state) {
      case 'calm':
        if (wolf) this.panic(wolf.pos, true);
        else if (wl.ctx.player.alive && dist < detect) this.alert(p);
        break;
      case 'alert': {
        if (!this.snorted && this.stateT > 0.4) {
          this.snorted = true;
          const m = this.members.find((d) => d.alive);
          if (m) wl.ctx.audio.play('deer_alert', { position: m.pos });
        }
        this.threat.copy(p);
        if (wolf) this.panic(wolf.pos, true);
        else if (dist < detect * 0.62 || (wl.playerApproachSpeed(c) > 2.5 && dist < detect * 0.9)) this.panic(p, true);
        else if (this.stateT > 5 && dist > detect * 0.8) {
          this.state = 'calm';
          this.stateT = 0;
          for (const m of this.members) if (m.alive) m.setMode('look', 1 + Math.random() * 2);
        }
        break;
      }
      case 'flee': {
        // Keep running away from the threat while it is close; then settle down.
        const tdist = Math.hypot(c.x - this.threat.x, c.z - this.threat.z);
        if (tdist < 60 && this.stateT > 3) {
          this.fleeHeading = Math.atan2(c.x - this.threat.x, c.z - this.threat.z) + Math.sin(this.stateT * 0.4) * 0.5;
          if (dist < 60) this.threat.copy(p);
        }
        if (this.stateT > 14 && tdist > 90) {
          this.state = 'calm';
          this.stateT = 0;
          this.home.copy(c);
          for (const m of this.members) if (m.alive && m.mode === 'flee') m.setMode('look', 1 + Math.random() * 2);
        } else {
          for (const m of this.members) if (m.alive && m.mode !== 'flee' && this.stateT < 14) m.setMode('flee', 8 + Math.random() * 6);
        }
        break;
      }
    }
  }
}
