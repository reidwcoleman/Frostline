// Snowshoe hare: sits, nibbles, twitches its ears, hops about. When it notices you it
// freezes (trusting its camouflage), sometimes rears up to look, then bolts in bounding
// zig-zags when you get within ~12 m.
import * as THREE from 'three';
import { Animal, type HurtInfo } from './Animal';
import { QuadRig } from './QuadRig';
import { HARE_COLLIDERS, HARE_GAIT } from './species';
import type { Wildlife } from './Wildlife';
import { damp } from '../core/math';

type HareMode = 'idle' | 'hop' | 'freeze' | 'bolt';

const _t = new THREE.Vector3();

export class Hare extends Animal {
  readonly species = 'rabbit' as const;
  readonly q: QuadRig;
  mode: HareMode = 'idle';
  modeT = 0;
  modeDur = 2;
  private zig = 0;
  private zigT = 0;
  private rearT = 0;

  constructor(wl: Wildlife, scale: number) {
    const model = wl.models.hare;
    const rig = new QuadRig(model.geometry, wl.mat.material, model.joints, HARE_GAIT, scale);
    super(wl, rig.mesh);
    this.q = rig;
    this.maxHealth = this.health = 12;
    this.colliderSpecs = HARE_COLLIDERS;
    this.radius = 0.12;
    this.height = 0.3;
    this.turnRate = 7;
    this.accel = 30;
    this.lieHeight = 0.07;
    rig.onFootDown = (l, x, z) => {
      if (l >= 2 && this.distToPlayer < 50) wl.ctx.snow.stamp({ x, z, dirX: Math.sin(this.heading), dirZ: Math.cos(this.heading), width: 0.07, length: 0.12, depth: 0.35, kind: 'paw' });
    };
  }

  override get rig() {
    return this.q;
  }
  override get displayName() {
    return 'hare';
  }

  setMode(m: HareMode, dur: number) {
    this.mode = m;
    this.modeT = 0;
    this.modeDur = dur;
  }

  protected think(dt: number) {
    const wl = this.wl;
    const q = this.q;
    const p = wl.player;
    this.modeT += dt;
    const dist = this.distToPlayer;
    const detect = wl.detectRange(24, this.pos);
    let graze = 0,
      ears = 0,
      rear = 0,
      twitch = 0;
    q.lookTarget = null;

    switch (this.mode) {
      case 'idle':
        this.desiredSpeed = 0;
        graze = Math.sin(this.age * 0.7) > 0 ? 0.8 : 0;
        twitch = Math.sin(this.age * 6.3) > 0.93 ? 1 : 0;
        ears = Math.sin(this.age * 0.5) > 0.6 ? 0.6 : 0; // ears laid back while resting
        if (dist < detect && wl.ctx.player.alive) this.setMode('freeze', 3 + Math.random() * 4);
        else if (this.modeT > this.modeDur) {
          this.setMode('hop', 0.5 + Math.random() * 1.2);
          this.desiredHeading = this.steerAvoid(this.heading + (Math.random() - 0.5) * 2.5, 1.5);
        }
        break;
      case 'hop':
        this.desiredSpeed = 1.8;
        if (this.modeT > this.modeDur) this.setMode('idle', 2 + Math.random() * 5);
        break;
      case 'freeze': {
        this.desiredSpeed = 0;
        _t.set(p.x, p.y + 1.2, p.z);
        q.lookTarget = _t;
        this.rearT += dt;
        rear = Math.sin(this.rearT * 0.5) > 0.4 && dist > 14 ? 1 : 0;
        const bolt = dist < Math.min(12, detect * 0.5) || wl.playerApproachSpeed(this.pos) > 4.5;
        if (bolt) this.startBolt();
        else if (dist > detect * 1.3 && this.modeT > this.modeDur) this.setMode('idle', 2 + Math.random() * 4);
        break;
      }
      case 'bolt': {
        this.zigT -= dt;
        if (this.zigT <= 0) {
          this.zigT = 0.35 + Math.random() * 0.5;
          this.zig = (Math.random() - 0.5) * 1.4;
        }
        const away = this.headingTo(p.x, p.z) + Math.PI;
        this.desiredHeading = this.steerAvoid(away + this.zig, 2);
        this.desiredSpeed = 10.5;
        ears = 0.8;
        if (this.modeT > this.modeDur && dist > 35) this.setMode('freeze', 4 + Math.random() * 4);
        if (dist > 260) this.remove = true;
        break;
      }
    }
    q.graze = damp(q.graze, graze, 4, dt);
    q.earsBack = damp(q.earsBack, ears, 8, dt);
    q.rear = damp(q.rear, rear, 5, dt);
    q.earTwitch = damp(q.earTwitch, twitch, 25, dt);
    q.tailUp = this.mode === 'bolt' ? 0.6 : 0;
  }

  startBolt() {
    if (this.mode === 'bolt') return;
    this.setMode('bolt', 2.5 + Math.random() * 2);
    this.zigT = 0;
  }

  protected override onHurt(_info: HurtInfo) {
    this.wl.ctx.audio.play('rabbit_squeak', { position: this.pos });
    this.startBolt();
  }
  protected override onDeath() {
    this.wl.ctx.audio.play('rabbit_squeak', { position: this.pos, pitch: 0.8 });
  }

  protected animate(dt: number, full: boolean) {
    const q = this.q;
    q.speed = this.speed;
    q.turn = this.turnVel;
    q.update(dt, this.pos, this.heading, this.wl.ctx.terrain, full);
  }
}
