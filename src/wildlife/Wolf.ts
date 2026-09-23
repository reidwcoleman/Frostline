// Wolves: the main threat. A Pack runs the shared state machine
//   roam -> howl -> track (scent) -> stalk (circle 15-25 m, growl) -> attack (one lunges,
//   the rest flank) -> retreat
// Individual wolves execute charge / lunge / recover / stagger / flee / hesitate on top of it.
// They fear fire: a lit torch or a campfire turns attacks into barking stand-offs.
import * as THREE from 'three';
import { Animal, type HurtInfo } from './Animal';
import { QuadRig } from './QuadRig';
import { WOLF_COLLIDERS, WOLF_GAIT } from './species';
import { B } from './skeleton';
import type { Wildlife } from './Wildlife';
import { Layer } from '../core/Physics';
import { angleDelta, clamp, damp, lerp } from '../core/math';
import type { ItemId } from '../core/Items';

type WolfMode = 'pack' | 'charge' | 'lunge' | 'recover' | 'stagger' | 'flee' | 'hesitate';
export type PackState = 'roam' | 'howl' | 'track' | 'stalk' | 'hold' | 'attack' | 'feed' | 'retreat';

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _chest = new THREE.Vector3();

export class Wolf extends Animal {
  readonly species = 'wolf' as const;
  readonly q: QuadRig;
  pack: Pack | null = null;
  slot = 0;
  mode: WolfMode = 'pack';
  modeT = 0;
  /** Goal written by the pack. */
  readonly goal = new THREE.Vector3();
  goalSpeed = 0;
  goalFace = false;
  private bit = false;
  private lungeHeading = 0;
  private howlT = -100;
  private growlCd = 2 + Math.random() * 6;
  private recoverHeading = 0;
  private recoverTime = 1.4;

  constructor(wl: Wildlife, variant: 0 | 1, scale: number) {
    const model = wl.models.wolf[variant];
    const rig = new QuadRig(model.geometry, wl.mat.material, model.joints, WOLF_GAIT, scale);
    super(wl, rig.mesh);
    this.q = rig;
    this.variant = variant;
    const day = wl.ctx.clock.day;
    this.maxHealth = this.health = 70 + Math.min(40, (day - 1) * 5);
    this.colliderSpecs = WOLF_COLLIDERS;
    this.radius = 0.32;
    this.height = 0.9;
    this.turnRate = 4.2;
    this.accel = 14;
    this.lieHeight = 0.16;
    rig.onFootDown = (_l, x, z) => {
      if (this.distToPlayer < 70) wl.ctx.snow.stamp({ x, z, dirX: Math.sin(this.heading), dirZ: Math.cos(this.heading), width: 0.09, length: 0.11, depth: 0.5, kind: 'paw' });
    };
  }

  override get rig() {
    return this.q;
  }
  override get displayName() {
    return 'wolf';
  }
  protected override harvestYield(): Partial<Record<ItemId, number>> {
    return { raw_meat: 2, hide: 1 };
  }

  setMode(m: WolfMode) {
    this.mode = m;
    this.modeT = 0;
    this.bit = false;
  }

  /** Start howling (pack-coordinated). */
  howl(delay: number) {
    this.howlT = -delay;
  }

  protected think(dt: number) {
    const wl = this.wl;
    const ctx = wl.ctx;
    const p = wl.player;
    this.modeT += dt;
    const dist = this.distToPlayer;
    const toPlayer = this.headingTo(p.x, p.z);
    const q = this.q;
    // Default posture.
    let crouch = 0,
      earsBack = 0,
      tailUp = 0,
      jaw = 0,
      headUp = 0,
      graze = 0,
      leap = 0;
    q.lookTarget = null;
    this.air = damp(this.air, 0, 10, dt);

    switch (this.mode) {
      case 'pack': {
        const pk = this.pack;
        const st = pk?.state ?? 'roam';
        const gx = this.goal.x - this.pos.x,
          gz = this.goal.z - this.pos.z;
        const gd = Math.hypot(gx, gz);
        if (gd > 0.8) {
          this.desiredHeading = this.steerAvoid(Math.atan2(gx, gz), 2.5 + this.speed * 0.3);
          this.desiredSpeed = this.goalSpeed * clamp(gd / 2.5, 0.25, 1);
        } else {
          this.desiredSpeed = 0;
          if (this.goalFace) this.desiredHeading = toPlayer;
        }
        if (st === 'stalk' || st === 'hold' || st === 'attack') {
          q.lookTarget = wl.playerChest;
          crouch = st === 'hold' ? 0.35 : 0.65;
          earsBack = st === 'hold' ? 0.1 : 0.45;
          tailUp = st === 'hold' ? -0.3 : 0.05;
          jaw = 0.12;
          this.growlCd -= dt;
          if (this.growlCd <= 0 && dist < 40) {
            this.growlCd = st === 'hold' ? 1.5 + Math.random() * 3 : 3 + Math.random() * 6;
            if (st === 'hold') {
              ctx.audio.play('wolf_bark', { position: this.pos, pitchVar: 0.12 });
              this.jawPulse = 0.35;
            } else {
              ctx.audio.play('wolf_growl', { position: this.pos, volume: 0.9, pitchVar: 0.1 });
              this.jawPulse = 0.9;
            }
          }
        } else if (st === 'track') {
          graze = 0.35 + Math.sin(this.age * 2.3 + this.slot) * 0.25; // nose to the ground, following scent
          tailUp = 0.1;
        } else if (st === 'feed') {
          if (this.speed < 0.3) {
            graze = 1;
            jaw = 0.3 + Math.sin(this.age * 9 + this.slot) * 0.3;
          }
          tailUp = 0.2;
          if (dist < 25) {
            q.lookTarget = wl.playerChest;
            graze = 0;
            earsBack = 0.5;
            crouch = 0.3;
            this.growlCd -= dt;
            if (this.growlCd <= 0) {
              this.growlCd = 2.5 + Math.random() * 3;
              ctx.audio.play('wolf_growl', { position: this.pos, pitchVar: 0.1 });
              this.jawPulse = 0.9;
            }
          }
        } else if (st === 'howl') {
          if (this.howlT > -10) {
            this.howlT += dt;
            if (this.howlT >= 0 && this.howlT - dt < 0) ctx.audio.play('wolf_howl', { position: this.pos, volume: 1, pitch: 0.92 + Math.random() * 0.16 });
            const h = this.howlT >= 0 ? clamp(this.howlT / 0.6, 0, 1) * clamp((4.5 - this.howlT) / 0.8, 0, 1) : 0;
            headUp = h * 1.6;
            jaw = h * 0.7;
            this.desiredSpeed = 0;
          }
        } else if (st === 'retreat') {
          tailUp = -0.8;
          earsBack = 0.6;
        } else {
          tailUp = 0.15;
          if (this.speed < 0.2 && Math.sin(this.age * 0.4 + this.slot * 3) > 0.6) graze = 0.8; // sniffing about
        }
        break;
      }

      case 'charge': {
        // Gallop straight in, leading the target a little.
        const pv = ctx.player.velocity;
        const tx = p.x + pv.x * 0.35,
          tz = p.z + pv.z * 0.35;
        this.desiredHeading = this.steerAvoid(this.headingTo(tx, tz), 2);
        this.desiredSpeed = 10.5;
        this.turnRate = 5;
        crouch = 0.2;
        earsBack = 1;
        tailUp = 0.1;
        jaw = 0.25;
        q.lookTarget = wl.playerChest;
        if (wl.fearAt(this.pos) > 0.35 || (wl.torchLit && dist < 7.5)) {
          this.setMode('hesitate');
          ctx.audio.play('wolf_bark', { position: this.pos });
        } else if (dist < 3.3 && Math.abs(angleDelta(this.heading, toPlayer)) < 0.5) {
          this.setMode('lunge');
          this.lungeHeading = toPlayer;
          ctx.audio.play('wolf_attack', { position: this.pos, pitchVar: 0.1 });
        } else if (this.modeT > 5) this.beginRecover();
        break;
      }

      case 'lunge': {
        const T = 0.55;
        const u = this.modeT / T;
        this.desiredHeading = this.lungeHeading;
        this.heading = this.lungeHeading;
        this.speed = this.desiredSpeed = u < 0.7 ? 10 : 4;
        leap = Math.sin(Math.min(1, u) * Math.PI);
        this.air = leap * 0.42;
        jaw = u < 0.55 ? 0.9 : 0.2;
        earsBack = 1;
        if (!this.bit && u > 0.36) this.tryBite();
        if (u >= 1) this.beginRecover();
        break;
      }

      case 'recover': {
        this.desiredHeading = this.steerAvoid(this.recoverHeading, 2.5);
        this.desiredSpeed = 7.5;
        this.turnRate = 4.2;
        earsBack = 0.5;
        tailUp = -0.2;
        if (this.modeT > this.recoverTime) this.setMode('pack');
        break;
      }

      case 'stagger': {
        this.desiredSpeed = 0;
        earsBack = 1;
        tailUp = -0.8;
        crouch = 0.5;
        if (this.modeT > 0.5) {
          if (this.health < this.maxHealth * 0.35) this.beginFlee();
          else this.beginRecover();
        }
        break;
      }

      case 'hesitate': {
        // Afraid of the flame: stop, bark, then back off.
        q.lookTarget = wl.playerChest;
        crouch = 0.55;
        earsBack = 0.9;
        tailUp = -0.5;
        jaw = 0.3;
        if (this.modeT < 1.2) {
          this.desiredSpeed = 0;
          this.desiredHeading = toPlayer;
        } else {
          this.recoverHeading = toPlayer + Math.PI + (Math.random() - 0.5) * 0.8;
          this.recoverTime = 1.2;
          this.setMode('recover');
        }
        break;
      }

      case 'flee': {
        const away = toPlayer + Math.PI;
        this.desiredHeading = this.steerAvoid(away + Math.sin(this.age * 0.9 + this.slot) * 0.3, 3);
        this.desiredSpeed = 11;
        tailUp = -1;
        earsBack = 1;
        if ((dist > 140 && this.modeT > 4) || this.modeT > 40) this.remove = true;
        break;
      }
    }

    this.jawPulse = Math.max(0, this.jawPulse - dt * 1.5);
    q.crouch = damp(q.crouch, crouch, 6, dt);
    q.earsBack = damp(q.earsBack, earsBack, 8, dt);
    q.tailUp = damp(q.tailUp, tailUp, 4, dt);
    q.jawOpen = damp(q.jawOpen, Math.max(jaw, this.jawPulse > 0 ? 0.5 * Math.abs(Math.sin(this.jawPulse * 22)) : 0), 14, dt);
    q.headUp = damp(q.headUp, headUp, 4, dt);
    q.graze = damp(q.graze, graze, 3, dt);
    q.leap = leap;
    q.air = this.air;
    q.tailWag = this.mode === 'pack' && this.pack?.state === 'roam' ? 0.2 : 0;
  }
  private jawPulse = 0;

  private tryBite() {
    const wl = this.wl;
    const ctx = wl.ctx;
    const pl = ctx.player;
    if (!pl.alive) return;
    this.q.boneWorld(B.head, _v);
    _chest.set(pl.position.x, pl.position.y + 1.0, pl.position.z);
    const dh = Math.hypot(_v.x - _chest.x, _v.z - _chest.z);
    if (dh > 1.55 || Math.abs(_v.y - _chest.y) > 1.3) return;
    // Walls / closed doors block the bite.
    _dir.copy(_chest).sub(_v);
    const len = _dir.length();
    _dir.divideScalar(Math.max(len, 1e-4));
    const hit = ctx.physics.raycast(_v, _dir, len, { mask: Layer.SOLID, terrain: false, trees: false, rocks: false });
    if (hit) return;
    this.bit = true;
    const day = ctx.clock.day;
    const dmg = Math.round(lerp(10, 18, Math.random()) * (ctx.clock.isNight ? 1 : 0.85) * (1 + Math.min(0.3, (day - 1) * 0.03)));
    const from = _w.copy(this.pos);
    pl.damage(dmg, 'wolf', from.clone());
    ctx.audio.play('player_hurt', { volume: 0.9 });
    // Knock the player back a little and shake the view.
    _dir.set(Math.sin(this.heading), 0.25, Math.cos(this.heading)).multiplyScalar(2.6);
    pl.applyImpulse(_dir);
    const sp = ctx.sys.player as unknown as { shake?: (a: number) => void };
    sp.shake?.(0.7);
    ctx.sys.weapons?.effects?.blood(_chest, _dir.normalize(), 0.8);
    wl.onPlayerBitten();
  }

  beginRecover() {
    const wl = this.wl;
    const away = this.headingTo(wl.player.x, wl.player.z) + Math.PI;
    this.recoverHeading = away + (this.slot % 2 === 0 ? 0.7 : -0.7) * (0.6 + Math.random() * 0.6);
    this.recoverTime = 1.1 + Math.random() * 0.8;
    this.setMode('recover');
  }

  beginFlee() {
    if (this.mode === 'flee') return;
    this.setMode('flee');
    if (this.pack) this.pack.onMemberFled(this);
  }

  protected override onHurt(info: HurtInfo) {
    const ctx = this.wl.ctx;
    ctx.audio.play('wolf_yelp', { position: this.pos, pitchVar: 0.1 });
    // A torch blow always scares them off.
    if (info.kind === 'torch') {
      this.beginFlee();
      return;
    }
    if (this.mode === 'flee') return;
    this.setMode('stagger');
    this.pack?.onMemberHurt(this);
  }

  protected override onDeath() {
    this.wl.ctx.audio.play('wolf_die', { position: this.pos });
    this.pack?.onMemberDied(this);
  }

  protected animate(dt: number, full: boolean) {
    const q = this.q;
    q.speed = this.speed;
    q.turn = this.turnVel;
    q.update(dt, this.pos, this.heading, this.wl.ctx.terrain, full);
  }
}

// ============================================================================ PACK
let PACK_ID = 1;

export class Pack {
  readonly id = PACK_ID++;
  readonly members: Wolf[] = [];
  state: PackState = 'roam';
  stateT = 0;
  readonly waypoint = new THREE.Vector3();
  readonly lastKnown = new THREE.Vector3();
  aggression = 0.5;
  private ring = 24;
  private circleAng = 0;
  private circleDir = Math.random() < 0.5 ? 1 : -1;
  private stalkTime = 10;
  private attacker: Wolf | null = null;
  private howlCd = 15 + Math.random() * 40;
  private lostT = 0;
  private holdT = 0;
  private trackUpdate = 0;
  private initialSize = 0;
  private feedTarget: Animal | null = null;
  private attacks = 0;

  constructor(private wl: Wildlife) {}

  add(w: Wolf) {
    w.pack = this;
    w.slot = this.members.length;
    this.members.push(w);
    this.initialSize = this.members.length;
  }

  get alive() {
    return this.members.some((m) => m.alive && !m.remove);
  }

  centroid(out: THREE.Vector3) {
    out.set(0, 0, 0);
    let n = 0;
    for (const m of this.members) {
      if (!m.alive || m.mode === 'flee') continue;
      out.add(m.pos);
      n++;
    }
    return n ? out.divideScalar(n) : out.copy(this.members[0]?.pos ?? out);
  }

  setState(s: PackState) {
    if (this.state === s) return;
    const engaged = this.state === 'stalk' || this.state === 'hold' || this.state === 'attack';
    if (s === 'stalk' && !engaged) {
      const c = this.centroid(_dir);
      this.circleAng = Math.atan2(c.x - this.wl.player.x, c.z - this.wl.player.z);
    }
    this.state = s;
    this.stateT = 0;
    this.holdT = s === 'hold' ? this.holdT : 0;
    if (s === 'stalk') {
      this.ring = Math.max(this.ring, 18 + Math.random() * 6);
      this.stalkTime = lerp(14, 5, this.aggression) * (this.attacks > 0 ? 0.55 : 1);
    }
    if (s === 'howl') {
      let i = 0;
      for (const m of this.members) if (m.alive && m.mode === 'pack') m.howl(0.3 + i++ * (0.6 + Math.random() * 0.9));
    }
  }

  onMemberHurt(_w: Wolf) {
    // Being hit makes the pack commit: skip straight to stalking range if tracking.
    if (this.state === 'roam' || this.state === 'track' || this.state === 'howl' || this.state === 'feed') this.setState('stalk');
  }
  onMemberFled(_w: Wolf) {
    this.checkMorale();
  }
  onMemberDied(_w: Wolf) {
    this.checkMorale();
  }
  private checkMorale() {
    const standing = this.members.filter((m) => m.alive && m.mode !== 'flee').length;
    if (standing === 0) return;
    if (standing <= this.initialSize / 2 || (standing === 1 && this.initialSize > 1)) {
      this.setState('retreat');
      for (const m of this.members) if (m.alive) m.beginFlee();
    }
  }

  update(dt: number) {
    const wl = this.wl;
    const ctx = wl.ctx;
    this.stateT += dt;
    this.howlCd -= dt;
    const active = this.members.filter((m) => m.alive && !m.remove && m.mode !== 'flee');
    if (!active.length) return;
    const leader = active[0];
    const c = this.centroid(_v);
    const p = wl.player;
    const dist = Math.hypot(c.x - p.x, c.z - p.z);
    const night = ctx.clock.isNight;
    const day = ctx.clock.day;
    this.aggression = clamp(0.3 + (day - 1) * 0.07 + (night ? 0.35 : -0.15) + (wl.playerBleeding ? 0.15 : 0), 0.1, 1);
    const scent = wl.scentRange(c);
    const playerOk = ctx.player.alive;
    const fireFear = wl.fearAt(p);
    const torch = wl.torchLit;
    const n = active.length;

    switch (this.state) {
      case 'roam': {
        if (this.stateT > 45 || Math.hypot(leader.pos.x - this.waypoint.x, leader.pos.z - this.waypoint.z) < 6 || this.waypoint.lengthSq() === 0) this.pickWaypoint(leader);
        if (playerOk && dist < scent) this.setState('track');
        else if (night && this.howlCd <= 0) {
          this.howlCd = 70 + Math.random() * 110;
          this.setState('howl');
        } else {
          const carcass = wl.nearestCarcass(c, 160);
          if (carcass) {
            this.feedTarget = carcass;
            this.setState('feed');
          }
        }
        this.formation(active, this.waypoint, night ? 3.6 : 2.2, leader);
        break;
      }
      case 'howl': {
        for (const m of active) {
          m.goal.copy(m.pos);
          m.goalSpeed = 0;
          m.goalFace = false;
        }
        if (this.stateT > 7) this.setState(playerOk && dist < scent * 1.2 ? 'track' : 'roam');
        break;
      }
      case 'track': {
        this.trackUpdate -= dt;
        if (this.trackUpdate <= 0) {
          this.trackUpdate = 1.5;
          const err = clamp(dist * 0.08, 0, 10);
          this.lastKnown.set(p.x + (Math.random() - 0.5) * err, p.y, p.z + (Math.random() - 0.5) * err);
        }
        if (!playerOk) this.setState('roam');
        else if (dist < 34) this.setState('stalk');
        else if (dist > scent * 1.4) {
          this.lostT += dt;
          if (this.lostT > 25) {
            this.lostT = 0;
            this.setState('roam');
          }
        } else this.lostT = 0;
        this.formation(active, this.lastKnown, night ? 5.2 : 4.2, leader);
        break;
      }
      case 'stalk':
      case 'hold':
      case 'attack': {
        if (!playerOk) {
          this.setState('roam');
          break;
        }
        const afraid = fireFear > 0.2 || torch;
        if (this.state === 'stalk') {
          this.ring = Math.max(13, this.ring - dt * 0.55);
          if (afraid) this.setState('hold');
          else if (this.stateT > this.stalkTime) this.beginAttack(active);
          else if (!night && this.stateT > 28 && ctx.player.health > 45 && !wl.playerBleeding) this.setState('retreat');
          if (dist > 70) this.setState('track');
        } else if (this.state === 'hold') {
          this.holdT += dt;
          this.ring = damp(this.ring, torch ? 10.5 : Math.max(11, wl.fireRadiusNear(p) + 6), 1.5, dt);
          if (!afraid) {
            this.setState('stalk');
            this.stalkTime = 2.5 + Math.random() * 3;
          } else if (this.holdT > 55 || (!night && this.holdT > 20)) this.setState('retreat');
        } else {
          // attack: wait for the attacker to finish its run.
          const a = this.attacker;
          if (!a || !a.alive || a.mode === 'pack' || a.mode === 'flee') {
            this.attacker = null;
            this.setState(afraid ? 'hold' : 'stalk');
          }
        }
        this.circleAng += this.circleDir * dt * (this.state === 'hold' ? 0.09 : 0.05);
        // Base angle starts on the pack's side of the player and drifts; members fan out to flank.
        const base = this.circleAng;
        const spread = n > 1 ? Math.min(1.1, 3.4 / n) : 0;
        let i = 0;
        for (const m of active) {
          const k = i++ - (n - 1) / 2;
          if (m.mode !== 'pack') continue;
          const a = base + k * spread + Math.sin(this.stateT * 0.3 + m.slot) * 0.12;
          const r = this.ring + Math.sin(this.stateT * 0.5 + m.slot * 2) * 1.5;
          m.goal.set(p.x + Math.sin(a) * r, 0, p.z + Math.cos(a) * r);
          const gd = Math.hypot(m.goal.x - m.pos.x, m.goal.z - m.pos.z);
          m.goalSpeed = gd > 6 ? 4.2 : 1.3;
          m.goalFace = true;
        }
        break;
      }
      case 'feed': {
        const t = this.feedTarget;
        if (!t || t.harvested || t.remove) {
          this.feedTarget = null;
          this.setState('roam');
          break;
        }
        let i = 0;
        for (const m of active) {
          const a = (i++ / n) * Math.PI * 2 + m.slot;
          m.goal.set(t.pos.x + Math.sin(a) * 1.3, 0, t.pos.z + Math.cos(a) * 1.3);
          m.goalSpeed = 3.5;
          m.goalFace = false;
        }
        if (playerOk && dist < 13) this.setState('stalk');
        if (this.stateT > 100) {
          this.feedTarget = null;
          this.setState('roam');
        }
        break;
      }
      case 'retreat': {
        for (const m of active) {
          if (m.mode === 'pack') m.beginFlee();
        }
        break;
      }
    }

    // Separation so they don't stack.
    for (let a = 0; a < active.length; a++)
      for (let b = a + 1; b < active.length; b++) {
        const A = active[a],
          Bw = active[b];
        const dx = A.pos.x - Bw.pos.x,
          dz = A.pos.z - Bw.pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < 1.6 && d2 > 1e-4) {
          const d = Math.sqrt(d2);
          const push = (1.26 - d) * 1.5 * dt;
          A.pos.x += (dx / d) * push;
          A.pos.z += (dz / d) * push;
          Bw.pos.x -= (dx / d) * push;
          Bw.pos.z -= (dz / d) * push;
        }
      }
  }

  private beginAttack(active: Wolf[]) {
    const wl = this.wl;
    const ctx = wl.ctx;
    const look = ctx.player.lookDir(_w);
    // Prefer a wolf the player isn't looking at: the flanker gets the bite.
    let best: Wolf | null = null,
      bestScore = -Infinity;
    for (const m of active) {
      if (m.mode !== 'pack') continue;
      const dx = m.pos.x - wl.player.x,
        dz = m.pos.z - wl.player.z;
      const d = Math.hypot(dx, dz) || 1;
      const facing = (dx * look.x + dz * look.z) / (d * Math.hypot(look.x, look.z) || 1);
      const score = -facing * 1.5 - d * 0.05 + Math.random() * 0.6;
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }
    if (!best) return;
    this.attacker = best;
    this.attacks++;
    best.setMode('charge');
    this.setState('attack');
    // Late nights: a second wolf joins in.
    if (ctx.clock.isNight && ctx.clock.day >= 4 && active.length >= 3 && Math.random() < 0.35) {
      const other = active.find((m) => m !== best && m.mode === 'pack');
      if (other) setTimeout(() => other.alive && other.mode === 'pack' && other.setMode('charge'), 700);
    }
  }

  private formation(active: Wolf[], target: THREE.Vector3, speed: number, leader: Wolf) {
    const lh = leader.heading;
    let i = 0;
    for (const m of active) {
      if (m.mode !== 'pack') continue;
      m.goalFace = false;
      m.goalSpeed = speed;
      if (m === leader) {
        m.goal.copy(target);
      } else {
        i++;
        const side = i % 2 === 0 ? 1 : -1;
        const back = 2.2 + Math.ceil(i / 2) * 2.2;
        const sx = Math.cos(lh) * side * 1.6 * Math.ceil(i / 2),
          sz = -Math.sin(lh) * side * 1.6 * Math.ceil(i / 2);
        m.goal.set(leader.pos.x - Math.sin(lh) * back + sx, 0, leader.pos.z - Math.cos(lh) * back + sz);
        const gd = Math.hypot(m.goal.x - m.pos.x, m.goal.z - m.pos.z);
        m.goalSpeed = speed * clamp(0.7 + gd * 0.1, 0.7, 1.6);
      }
    }
  }

  private pickWaypoint(leader: Wolf) {
    const ctx = this.wl.ctx;
    const t = ctx.terrain;
    for (let k = 0; k < 8; k++) {
      // Drift loosely toward the player at night so packs find the action.
      const toward = ctx.clock.isNight ? this.wl.headingFrom(leader.pos) : Math.random() * Math.PI * 2;
      const a = toward + (Math.random() - 0.5) * (ctx.clock.isNight ? 2.2 : 6.28);
      const d = 60 + Math.random() * 90;
      const x = leader.pos.x + Math.sin(a) * d,
        z = leader.pos.z + Math.cos(a) * d;
      if (!t.inBounds(x, z, 60)) continue;
      if (t.slopeAngle(x, z) > 0.55) continue;
      this.waypoint.set(x, t.heightAt(x, z), z);
      this.stateT = 0;
      return;
    }
    this.waypoint.copy(leader.pos);
  }
}

