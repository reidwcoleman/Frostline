// Birds: ptarmigan hide in the snow above the treeline and burst out in a flurry of wings
// when you get close; ravens circle high overhead (and gather over carcasses).
import * as THREE from 'three';
import { Animal } from './Animal';
import type { Wildlife } from './Wildlife';
import { MeshBuilder, loft, ellipsoid, col, v3, mottle } from '../combat/geom';
import { makeBones } from './skeleton';
import { clamp, damp, lerp, TAU } from '../core/math';

// Bird skeleton: 0 body, 1 head, 2 wingL1, 3 wingL2, 4 wingR1, 5 wingR2, 6 tail
export const BIRD_PARENT = [-1, 0, 0, 2, 0, 4, 0];
const _c = new THREE.Color();

export type BirdKind = 'ptarmigan' | 'raven';

export interface BirdModel {
  geometry: THREE.BufferGeometry;
  joints: THREE.Vector3[];
}

export function buildPtarmigan(): BirdModel {
  const J = [v3(0, 0.12, 0), v3(0, 0.19, 0.1), v3(0.06, 0.15, 0.02), v3(0.17, 0.15, 0.0), v3(-0.06, 0.15, 0.02), v3(-0.17, 0.15, 0.0), v3(0, 0.13, -0.11)];
  const m = new MeshBuilder();
  const white = col(0xf2f1ec);
  const shade = col(0xdcdad3);
  const black = col(0x151312);
  m.add(ellipsoid(v3(0, 0.12, 0), 0.085, 0.082, 0.14, 12, 9), { color: (p, n) => _c.copy(white).lerp(shade, clamp(n.y, 0, 1) * 0.35).offsetHSL(0, 0, mottle(p, 60) * 0.015), bone: 0 });
  m.add(ellipsoid(v3(0, 0.195, 0.11), 0.045, 0.045, 0.05, 10, 8), { color: white, bone: 1 });
  const beak = new THREE.ConeGeometry(0.012, 0.03, 6);
  beak.rotateX(Math.PI / 2);
  beak.translate(0, 0.19, 0.17);
  m.add(beak, { color: black, bone: 1 });
  for (const sx of [1, -1]) {
    m.add(ellipsoid(v3(sx * 0.034, 0.205, 0.13), 0.008, 0.008, 0.008, 6, 5), { color: black, bone: 1 });
    m.add(ellipsoid(v3(sx * 0.032, 0.218, 0.125), 0.012, 0.005, 0.014, 6, 5), { color: col(0xc23a2a), bone: 1 }); // red comb
    // Wings: inner + outer panel, white with dark shafts on the leading edge.
    const inner = loft(
      [
        { p: v3(sx * 0.05, 0.15, 0.02), rx: 0.004, ry: 0.07 },
        { p: v3(sx * 0.17, 0.15, 0.0), rx: 0.004, ry: 0.075 },
      ],
      6,
      { up: v3(0, 0, 1) },
    );
    m.add(inner, { color: white, bone: sx > 0 ? 2 : 4 });
    const outer = loft(
      [
        { p: v3(sx * 0.17, 0.15, 0.0), rx: 0.004, ry: 0.075 },
        { p: v3(sx * 0.3, 0.15, -0.03), rx: 0.003, ry: 0.035 },
      ],
      6,
      { up: v3(0, 0, 1) },
    );
    m.add(outer, { color: (p) => _c.copy(white).lerp(shade, clamp((Math.abs(p.x) - 0.2) * 8, 0, 1) * 0.4), bone: sx > 0 ? 3 : 5 });
  }
  // Tail: short dark fan (the ptarmigan's black outer tail feathers flash in flight).
  m.add(
    loft(
      [
        { p: v3(0, 0.13, -0.1), rx: 0.03, ry: 0.01 },
        { p: v3(0, 0.125, -0.19), rx: 0.055, ry: 0.006 },
      ],
      8,
    ),
    { color: black, bone: 6 },
  );
  // Feathered feet.
  for (const sx of [1, -1]) m.add(ellipsoid(v3(sx * 0.03, 0.03, 0.02), 0.018, 0.03, 0.02, 6, 5), { color: white, bone: 0 });
  return { geometry: m.build(true), joints: J };
}

export function buildRaven(): BirdModel {
  const J = [v3(0, 0, 0), v3(0, 0.02, 0.17), v3(0.05, 0.02, 0.03), v3(0.28, 0.02, 0.0), v3(-0.05, 0.02, 0.03), v3(-0.28, 0.02, 0.0), v3(0, 0, -0.18)];
  const m = new MeshBuilder();
  const black = col(0x121218);
  const sheen = col(0x262a3a);
  const bc = (_p: THREE.Vector3, n: THREE.Vector3) => _c.copy(black).lerp(sheen, clamp(n.y, 0, 1) * 0.6);
  m.add(ellipsoid(v3(0, 0, 0), 0.075, 0.072, 0.21, 12, 9), { color: bc, bone: 0 });
  m.add(ellipsoid(v3(0, 0.025, 0.2), 0.05, 0.05, 0.06, 10, 8), { color: bc, bone: 1 });
  const beak = new THREE.ConeGeometry(0.02, 0.09, 6);
  beak.rotateX(Math.PI / 2);
  beak.translate(0, 0.015, 0.29);
  m.add(beak, { color: col(0x0b0b0e), bone: 1 });
  for (const sx of [1, -1]) {
    m.add(
      loft(
        [
          { p: v3(sx * 0.04, 0.02, 0.03), rx: 0.006, ry: 0.13 },
          { p: v3(sx * 0.28, 0.02, 0.0), rx: 0.005, ry: 0.14 },
        ],
        6,
        { up: v3(0, 0, 1) },
      ),
      { color: bc, bone: sx > 0 ? 2 : 4 },
    );
    m.add(
      loft(
        [
          { p: v3(sx * 0.28, 0.02, 0.0), rx: 0.005, ry: 0.14 },
          { p: v3(sx * 0.46, 0.02, -0.03), rx: 0.004, ry: 0.1 },
        ],
        6,
        { up: v3(0, 0, 1) },
      ),
      { color: bc, bone: sx > 0 ? 3 : 5 },
    );
    // Fingered primaries.
    for (let f = 0; f < 4; f++) {
      const z = 0.035 - f * 0.03;
      m.add(
        loft(
          [
            { p: v3(sx * 0.45, 0.02, z), rx: 0.003, ry: 0.012 },
            { p: v3(sx * (0.56 - f * 0.015), 0.02, z - 0.01 - f * 0.012), rx: 0.002, ry: 0.006 },
          ],
          5,
          { up: v3(0, 0, 1) },
        ),
        { color: black, bone: sx > 0 ? 3 : 5 },
      );
    }
  }
  // Wedge tail.
  m.add(
    loft(
      [
        { p: v3(0, 0, -0.16), rx: 0.04, ry: 0.01 },
        { p: v3(0, -0.005, -0.3), rx: 0.075, ry: 0.006 },
        { p: v3(0, -0.005, -0.34), rx: 0.03, ry: 0.004 },
      ],
      8,
    ),
    { color: bc, bone: 6 },
  );
  return { geometry: m.build(true), joints: J };
}

export class Bird extends Animal {
  readonly species = 'bird' as const;
  readonly kind: BirdKind;
  readonly mesh: THREE.SkinnedMesh;
  readonly bones: THREE.Bone[];
  flock: Bird[] | null = null;
  /** Circle centre for ravens / landing spot for ptarmigan. */
  readonly anchor = new THREE.Vector3();
  private flap = Math.random();
  private flapAmp = 0;
  private fold = 1;
  private pitch = 0;
  private bank = 0;
  private altTarget = 0;
  private vy = 0;
  private burstDelay = 0;
  private callCd = 8 + Math.random() * 20;
  private circleAng = Math.random() * TAU;
  private circleR = 30;
  private circleDir = Math.random() < 0.5 ? 1 : -1;

  constructor(wl: Wildlife, kind: BirdKind) {
    const model = kind === 'raven' ? wl.models.raven : wl.models.ptarmigan;
    const bones = makeBones(model.joints, BIRD_PARENT);
    const mesh = new THREE.SkinnedMesh(model.geometry, wl.mat.material);
    mesh.add(bones[0]);
    mesh.updateMatrixWorld(true);
    mesh.bind(new THREE.Skeleton(bones));
    mesh.castShadow = true;
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.2);
    super(wl, mesh);
    this.mesh = mesh;
    this.bones = bones;
    this.kind = kind;
    this.maxHealth = this.health = kind === 'raven' ? 15 : 8;
    this.colliderSpecs = [{ bone: -1, offset: v3(0, kind === 'raven' ? 0 : 0.12, 0), radius: kind === 'raven' ? 0.28 : 0.16, tag: 'body' }];
    this.radius = 0.15;
    this.height = 0.3;
    this.lieHeight = 0.05;
    if (kind === 'raven') {
      this.state = 'circle';
      this.fold = 0;
      this.circleR = 22 + Math.random() * 20;
    } else {
      this.state = 'hidden';
      this.air = -0.07;
    }
  }

  override get displayName() {
    return this.kind;
  }

  /** Ptarmigan flush: burst out of the snow after a small random delay. */
  flush(delay: number) {
    if (this.state !== 'hidden' && this.state !== 'landed') return;
    this.state = 'burst';
    this.stateT = 0;
    this.burstDelay = delay;
  }

  protected think(dt: number) {
    const wl = this.wl;
    const ctx = wl.ctx;
    const p = wl.player;
    if (this.kind === 'raven') {
      // Lazy circles high above the anchor, drifting.
      const v = 8.5;
      this.circleAng += (this.circleDir * v * dt) / this.circleR;
      const tx = this.anchor.x + Math.sin(this.circleAng) * this.circleR,
        tz = this.anchor.z + Math.cos(this.circleAng) * this.circleR;
      this.desiredHeading = this.headingTo(tx, tz) + this.circleDir * 0.5;
      this.desiredSpeed = v;
      this.turnRate = 1.2;
      const gy = ctx.terrain.heightAt(this.anchor.x, this.anchor.z) + 45 + Math.sin(this.age * 0.05 + this.id) * 12;
      this.altTarget = gy - this.pos.y;
      this.air = damp(this.air, this.altTarget, 0.3, dt);
      this.bank = damp(this.bank, -this.circleDir * 0.35, 2, dt);
      // Flap now and then, glide the rest of the time.
      const flapping = Math.sin(this.age * 0.35 + this.id) > 0.55;
      this.flapAmp = damp(this.flapAmp, flapping ? 0.7 : 0.05, 3, dt);
      this.flap += dt * (flapping ? 2.6 : 0.4);
      this.fold = 0;
      this.callCd -= dt;
      if (this.callCd <= 0) {
        this.callCd = 12 + Math.random() * 30;
        if (this.distToPlayer < 160) ctx.audio.play('bird_call', { position: _pos(this), volume: 0.8 });
      }
      return;
    }

    // ---- ptarmigan
    const dist = this.distToPlayer;
    switch (this.state) {
      case 'hidden':
      case 'landed': {
        this.desiredSpeed = 0;
        this.flapAmp = damp(this.flapAmp, 0, 6, dt);
        this.fold = damp(this.fold, 1, 6, dt);
        this.air = damp(this.air, this.state === 'hidden' ? -0.07 : 0, 1, dt);
        if (this.state === 'landed' && this.stateT > 6) this.state = 'hidden';
        const flushR = ctx.player.speed > 5 ? 14 : ctx.player.crouching ? 5 : 8;
        if (dist < flushR && ctx.player.alive) {
          for (const b of this.flock ?? [this]) b.flush(Math.random() * 0.45);
        }
        this.pitch = damp(this.pitch, 0, 5, dt);
        break;
      }
      case 'burst': {
        if (this.stateT < this.burstDelay) break;
        if (this.stateT - dt < this.burstDelay) {
          ctx.audio.play('bird_flap', { position: this.pos, volume: 1, pitchVar: 0.2 });
          const away = this.headingTo(p.x, p.z) + Math.PI + (Math.random() - 0.5) * 1.4;
          this.heading = this.desiredHeading = away;
          const d = 45 + Math.random() * 45;
          this.anchor.set(this.pos.x + Math.sin(away) * d, 0, this.pos.z + Math.cos(away) * d);
          this.vy = 5.5;
        }
        this.fold = damp(this.fold, 0, 20, dt);
        this.flapAmp = 1;
        this.flap += dt * 9;
        this.desiredSpeed = 9;
        this.accel = 14;
        this.vy = damp(this.vy, 0, 2.5, dt);
        this.air += this.vy * dt;
        this.pitch = damp(this.pitch, -0.5, 8, dt);
        if (this.stateT - this.burstDelay > 0.8) {
          this.state = 'fly';
          this.stateT = 0;
        }
        break;
      }
      case 'fly': {
        this.desiredHeading = this.headingTo(this.anchor.x, this.anchor.z);
        const dx = this.anchor.x - this.pos.x,
          dz = this.anchor.z - this.pos.z;
        const d = Math.hypot(dx, dz);
        // Rapid wingbeats then glide, low over the snow.
        const beating = Math.sin(this.stateT * 2.2) > -0.2;
        this.flapAmp = damp(this.flapAmp, beating ? 1 : 0.1, 6, dt);
        this.flap += dt * (beating ? 8.5 : 0.8);
        const alt = d < 8 ? d * 0.25 : 3;
        this.air = damp(this.air, alt, 2, dt);
        this.desiredSpeed = d < 6 ? 3 : 10;
        this.pitch = damp(this.pitch, d < 6 ? 0.4 : 0, 3, dt);
        if (d < 1.2 || this.stateT > 20) {
          this.state = 'landed';
          this.stateT = 0;
          this.desiredSpeed = 0;
          this.speed = 0;
        }
        break;
      }
    }
    this.bank = damp(this.bank, clamp(-this.turnVel * 0.3, -0.6, 0.6), 4, dt);
  }

  protected override locomote(dt: number, full: boolean) {
    if (this.kind === 'raven' || this.state === 'burst' || this.state === 'fly') {
      // Flying: no ground collision, but stay in bounds.
      const d = this.desiredHeading - this.heading;
      const dd = Math.atan2(Math.sin(d), Math.cos(d));
      this.turnVel = damp(this.turnVel, clamp(dd * 3, -this.turnRate * 2, this.turnRate * 2), 6, dt);
      this.heading += this.turnVel * dt;
      this.speed = damp(this.speed, this.desiredSpeed, 2, dt);
      const oldGround = this.pos.y;
      this.pos.x += Math.sin(this.heading) * this.speed * dt;
      this.pos.z += Math.cos(this.heading) * this.speed * dt;
      const t = this.wl.ctx.terrain;
      const m = t.half - 30;
      this.pos.x = clamp(this.pos.x, -m, m);
      this.pos.z = clamp(this.pos.z, -m, m);
      this.pos.y = t.heightAt(this.pos.x, this.pos.z);
      // Keep altitude continuous over changing ground.
      this.air += oldGround - this.pos.y;
      if (this.air < 0.2 && this.state === 'fly') this.air = 0.2;
      return;
    }
    super.locomote(dt, full);
  }

  protected animate(dt: number) {
    const b = this.bones;
    const mesh = this.mesh;
    mesh.position.set(this.pos.x, this.pos.y + this.air, this.pos.z);
    mesh.rotation.set(this.pitch, this.heading, this.bank, 'YXZ');
    const s = Math.sin(this.flap * TAU);
    const a = this.flapAmp;
    const fold = this.fold;
    const glideUp = this.kind === 'raven' ? 0.08 : 0.05;
    const w1 = s * a * 0.95 + glideUp;
    const w2 = Math.sin(this.flap * TAU - 0.7) * a * 0.6 + glideUp * 0.5;
    b[2].rotation.set(0, fold * 1.45, w1 * (1 - fold) - fold * 0.25);
    b[3].rotation.set(0, fold * 1.4, w2 * (1 - fold));
    b[4].rotation.set(0, -fold * 1.45, -w1 * (1 - fold) + fold * 0.25);
    b[5].rotation.set(0, -fold * 1.4, -w2 * (1 - fold));
    b[6].rotation.set(0.1 * this.pitch, 0, -this.bank * 0.4);
    b[1].rotation.set(-this.pitch * 0.6 + (fold > 0.5 ? Math.sin(this.age * 1.3 + this.id) * 0.15 : 0), fold > 0.5 ? Math.sin(this.age * 0.7 + this.id) * 0.6 : 0, 0);
    // Body bob with the wingbeat.
    b[0].position.y = this.kind === 'raven' ? -s * a * 0.03 : 0.12 - s * a * 0.02;
    void dt;
  }

  protected override syncColliders() {
    const c = this.colliders[0];
    if (!c) return;
    c.position.set(this.pos.x, this.pos.y + this.air + (this.kind === 'raven' ? 0 : 0.12), this.pos.z);
    this.wl.ctx.physics.updateCollider(c);
  }

  protected override onDeath() {
    // Fall out of the sky.
    this.state = 'dead';
    this.fold = 0.5;
  }

  override update(dt: number, full: boolean) {
    if (!this.alive && !this.carcass && this.air > 0.05) {
      // Tumble to the ground before becoming a carcass.
      this.vy -= 9.8 * dt;
      this.air = Math.max(0, this.air + this.vy * dt);
      this.pitch += dt * 4;
      this.flapAmp = 0;
      this.pos.x += Math.sin(this.heading) * this.speed * dt;
      this.pos.z += Math.cos(this.heading) * this.speed * dt;
      this.pos.y = this.wl.ctx.terrain.heightAt(this.pos.x, this.pos.z);
      this.animate(dt);
      this.syncColliders();
      return;
    }
    if (!this.alive && !this.carcass) {
      this.pitch = 0;
      this.bank = 1.3;
      this.air = 0.02;
      this.animate(dt);
    }
    super.update(dt, full);
  }

  protected override harvestYield() {
    return { raw_meat: 1 };
  }

  setCircle(x: number, z: number, r = lerp(22, 42, Math.random())) {
    this.anchor.set(x, 0, z);
    this.circleR = r;
  }
}

const _pp = new THREE.Vector3();
function _pos(b: Bird) {
  return _pp.set(b.pos.x, b.pos.y + b.air, b.pos.z);
}
