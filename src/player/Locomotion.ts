// Player movement simulation: walking, skiing, air, crashes. Pure physics + intent; every side effect
// (sound, snow stamps, camera, damage, events) goes out through LocoHooks so the same code runs
// deterministically in PhysicsLab against an analytic plane.
//
// Skiing model (per 1/120 s substep, on the terrain tangent plane):
//   - gravity projected on the plane, normal load N = g·n.y + compression (curvature) accel
//   - along-ski kinetic friction μN (+ snowplow brake), static hold when stopped
//   - quadratic air drag (tuck -40%)
//   - lateral EDGE GRIP: lateral velocity is removed up to a grip limit (g·N·surface·edge·chatter).
//     Rotating the skis faster than the grip can follow leaves lateral velocity -> a skid whose
//     sliding friction brakes you (drifts, hockey stops). Rotating within the limit is a clean carve:
//     speed is preserved and redirected.
//   - skis steer toward the look yaw; the turn rate is capped by what the edges can carve unless you
//     look far away (overdrive), which throws the skis sideways into a skid.
//   - leaving the ground: predictive "can the legs keep the skis on the snow?" test (g + absorb),
//     so lips and rollovers launch you but micro-bumps don't.
import * as THREE from 'three';
import type { PlayerState } from '../core/PlayerState';
import type { SurfaceKind } from '../core/Terrain';
import { angleDelta, clamp, damp, DEG, lerp, smoothstep } from '../core/math';
import type { Controls } from './Controls';
import { makeSample, type Ground, type GroundKind, type GroundSample } from './Ground';
import { GRAVITY, SKI, WALK } from './tuning';

export type CrashReason = 'impact' | 'landing' | 'edge';

export interface LocoHooks {
  footstep(side: number, surface: SurfaceKind, packed: boolean, pos: THREE.Vector3, dirX: number, dirZ: number, speed: number): void;
  jump(onSkis: boolean, charge: number): void;
  /** severity: 0 soft, 1 hard. */
  land(impact: number, severity: 0 | 1, onSkis: boolean, airTime: number): void;
  crash(speed: number, reason: CrashReason, impact: number): void;
  bump(impact: number, normal: THREE.Vector3): void;
  polePlant(side: number): void;
  skiToggle(on: boolean, phase: 'start' | 'click' | 'done'): void;
  gotUp(): void;
}

export const NO_HOOKS: LocoHooks = {
  footstep() {},
  jump() {},
  land() {},
  crash() {},
  bump() {},
  polePlant() {},
  skiToggle() {},
  gotUp() {},
};

const SUB = 1 / 120;
const _fwd = new THREE.Vector3();
const _s = new THREE.Vector3();
const _r = new THREE.Vector3();
const _gt = new THREE.Vector3();
const _t = new THREE.Vector3();
const _v2 = new THREE.Vector2();
const UP = new THREE.Vector3(0, 1, 0);

export class Locomotion {
  hooks: LocoHooks = NO_HOOKS;

  // ---- contact
  readonly gs: GroundSample = makeSample();
  /** Normal of the surface we're on (raw, last contact). */
  readonly groundN = new THREE.Vector3(0, 1, 0);
  groundKind: GroundKind = 'terrain';
  packed = false;
  /** Height of the feet above the ground (0 when grounded). */
  hag = 0;
  /** Physical airtime of the current flight (s). */
  airT = 0;
  lastAirTime = 0;
  private coyote = 1;
  private noSnap = 0;
  /** Extra normal load from terrain curvature (m/s², + = compression). */
  compression = 0;
  private compAcc = 0;

  // ---- skiing readouts
  /** Signed centripetal accel (m/s², + = turning right). */
  latAcc = 0;
  /** Lateral sliding speed left after the edges (m/s). */
  skidSpeed = 0;
  /** 0..1 smoothed skid intensity. */
  skid = 0;
  turnRate = 0;
  plow = 0;
  tuck = 0;
  crouch = 0;
  charge = 0;
  /** Push cycle 0..1 while poling / skating. */
  polePhase = 0;
  poling = 0; // 0..1 smoothed
  private poleIdle = 0;
  climbing = 0; // 0..1 smoothed
  /** Visual edge (lean) angle of the skis, radians, + = right edge. */
  edge = 0;
  /** Forward speed along the skis. */
  vAlong = 0;
  hockey = 0; // 0..1 hockey-stop intent (keyboard back + side)
  private edgeKey = false;
  private edgeOn = false;
  private turnSign = 0;
  private straightT = 0;
  private plantCooldown = 0;
  private wantPlow = false;
  private wantClimb = false;
  private wantPole = false;
  private locked = false;

  // ---- walking
  private wishX = 0;
  private wishZ = 0;
  private wishSpeed = 0;
  strideDist = 0;
  strideLen = 1;
  stepIndex = 0;
  sliding = false;
  private exhausted = false;

  // ---- toggles / crash
  /** Ski on/off clip timer (-1 = idle). */
  toggleT = -1;
  toggleTo = false;
  crashT = 0;
  crashSpin = 1;
  private lastPos = new THREE.Vector3();
  private capsuleH = 1.8;

  /** Climbing gear in the pack (set by PlayerController each frame from the inventory). */
  gear = { crampons: false, iceAxe: false };
  /** 0..1 how hard the player is climbing a steep face with the ice axe (for camera/audio). */
  axeClimb = 0;

  constructor(public p: PlayerState, public ground: Ground) {}

  /** Clear transient state (new game, respawn, load, teleport). */
  reset() {
    const p = this.p;
    this.airT = this.lastAirTime = 0;
    this.coyote = 1;
    this.noSnap = 0;
    this.compression = this.compAcc = 0;
    this.latAcc = this.skidSpeed = this.skid = this.turnRate = 0;
    this.plow = this.tuck = this.crouch = this.charge = 0;
    this.polePhase = this.poling = this.climbing = 0;
    this.edge = this.vAlong = this.hockey = 0;
    this.strideDist = 0;
    this.stepIndex = 0;
    this.sliding = false;
    this.exhausted = false;
    this.toggleT = -1;
    this.crashT = 0;
    this.hag = 0;
    p.grounded = true;
    p.airTime = 0;
    p.carve = 0;
    this.groundN.set(0, 1, 0);
    this.lastPos.copy(p.position);
    this.onTeleport();
  }

  /** Advance the simulation by one frame. */
  update(dt: number, c: Controls) {
    const p = this.p;
    if (this.lastPos.distanceToSquared(p.position) > 40 * 40) this.onTeleport();

    if (!p.alive && p.mode !== 'dead') p.mode = 'dead';
    this.updateToggle(dt, c);
    this.locked = this.toggleT >= 0 || !p.alive || p.mode === 'crashed' || p.mode === 'dead';
    this.frameIntent(dt, c);

    const n = Math.min(12, Math.max(1, Math.ceil(dt / SUB - 1e-6)));
    const h = dt / n;
    this.compAcc = 0;
    for (let i = 0; i < n; i++) this.substep(h, c);
    this.compression = damp(this.compression, this.compAcc / n, 12, dt);

    this.postFrame(dt, c);
    this.lastPos.copy(p.position);
  }

  /** Re-acquire the ground after a reset / teleport (normal, surface, grounded). */
  private onTeleport() {
    const p = this.p;
    this.noSnap = 0;
    this.airT = 0;
    p.grounded = false;
    const g = this.ground.sample(p.position.x, p.position.y + 2, p.position.z, this.gs);
    if (p.position.y - g.y < 0.6) {
      p.position.y = Math.max(p.position.y, g.y);
      if (p.position.y - g.y < 0.08) p.position.y = g.y;
      p.grounded = true;
      this.groundN.copy(g.normal);
      p.surface = g.surface;
      this.groundKind = g.kind;
      this.packed = g.packed;
      // Keep any preset speed on the snow's tangent plane.
      p.velocity.addScaledVector(g.normal, -p.velocity.dot(g.normal));
    }
    this.lastPos.copy(p.position);
  }

  // ------------------------------------------------------------------ per-frame intent
  private frameIntent(dt: number, c: Controls) {
    const p = this.p;
    const skiing = p.onSkis && (p.mode === 'ski' || p.mode === 'air');
    const on = !this.locked;

    // Stance
    p.tucking = on && skiing && c.sprint && !c.jump && this.vAlong > 2.5;
    p.crouching = on && c.crouch;
    this.tuck = damp(this.tuck, p.tucking ? 1 : 0, 7, dt);
    this.crouch = damp(this.crouch, p.crouching ? 1 : 0, 9, dt);

    if (skiing) {
      this.wantPlow = on && c.moveY < -0.3;
      this.hockey = damp(this.hockey, on && c.moveY < -0.5 && Math.abs(c.moveX) > 0.5 && this.vAlong > 6 ? 1 : 0, 10, dt);
      this.edgeKey = on && Math.abs(c.moveX) > 0.3;
      this.wantPole = on && c.moveY > 0.3 && p.grounded && !p.tucking;
      this.plow = damp(this.plow, this.wantPlow && this.hockey < 0.5 ? 1 : 0, 8, dt);

      // Ollie: hold to crouch/charge, release to pop. A late release just after a lip still counts.
      if (on && c.jump) this.charge = Math.min(1, this.charge + dt / SKI.chargeTime);
      if (on && c.jumpReleased) {
        if (p.grounded || this.coyote < 0.12) this.pop();
        this.charge = 0;
      } else if (!c.jump) this.charge = Math.max(0, this.charge - dt * 4);
    } else {
      this.wantPlow = this.wantPole = this.edgeKey = false;
      this.plow = damp(this.plow, 0, 8, dt);
      this.hockey = 0;
      this.charge = 0;
      if (on && c.jumpPressed && p.grounded && p.mode === 'walk') {
        const v = p.velocity;
        v.y = Math.max(v.y, 0) + WALK.jumpSpeed;
        p.grounded = false;
        this.noSnap = 0.12;
        this.airT = 0;
        p.stamina = Math.max(0, p.stamina - 2);
        this.hooks.jump(false, 0);
      }
    }

    // Walking wish vector (camera relative)
    let mx = on ? c.moveX : 0,
      my = on ? c.moveY : 0;
    const ml = Math.hypot(mx, my);
    if (ml > 1) {
      mx /= ml;
      my /= ml;
    }
    const fx = -Math.sin(p.yaw),
      fz = -Math.cos(p.yaw);
    this.wishX = fx * my + -fz * mx;
    this.wishZ = fz * my + fx * mx;
    const wl = Math.hypot(this.wishX, this.wishZ);
    if (wl > 1e-4) {
      this.wishX /= wl;
      this.wishZ /= wl;
    }
    if (p.stamina <= 0.01) this.exhausted = true;
    else if (p.stamina > WALK.sprintResume) this.exhausted = false;
    const canSprint = on && c.sprint && my > 0.3 && !p.crouching && !this.exhausted && p.grounded;
    p.sprinting = canSprint && !p.onSkis && wl > 0.1;
    let speed = p.crouching ? WALK.crouchSpeed : p.sprinting ? WALK.sprintSpeed : WALK.speed;
    if (my < -0.1) speed *= 0.72; // backpedal
    if (!this.packed) speed *= WALK.deepSnow;
    this.wishSpeed = speed * Math.min(1, wl);
    if (p.sprinting && p.speed > 1) p.stamina = Math.max(0, p.stamina - WALK.sprintDrain * dt);
  }

  private pop() {
    const p = this.p;
    const k = this.charge;
    const pop = lerp(SKI.popMin, SKI.popMax, k) * (p.stamina > 1 ? 1 : 0.6);
    const n = p.grounded ? this.groundN : UP;
    p.velocity.addScaledVector(n, pop);
    // Keep the pop mostly vertical on steep ground so it doesn't throw you sideways.
    p.velocity.y += pop * (1 - n.y) * 0.5;
    p.grounded = false;
    this.noSnap = 0.1;
    p.stamina = Math.max(0, p.stamina - SKI.popCost);
    this.hooks.jump(true, k);
  }

  // ------------------------------------------------------------------ substep
  private substep(h: number, c: Controls) {
    const p = this.p;
    if (this.noSnap > 0) this.noSnap -= h;
    if (p.mode === 'crashed' || p.mode === 'dead') this.bodyStep(h);
    else if (p.onSkis) {
      if (p.grounded) this.skiGround(h, c);
      else this.airStep(h, c, true);
    } else {
      if (p.grounded) this.walkGround(h);
      else this.airStep(h, c, false);
    }
    if (!p.grounded) {
      this.airT += h;
      this.coyote += h;
    } else {
      this.coyote = 0;
    }
  }

  private gripLimit(load: number, speed: number, surface: SurfaceKind): number {
    let g = (SKI.grip[surface] ?? SKI.grip.snow) * load;
    g *= 1 - SKI.chatter * smoothstep(SKI.chatterSpeed[0], SKI.chatterSpeed[1], speed);
    g *= lerp(1, SKI.tuckGrip, this.tuck);
    if (this.edgeOn) g *= SKI.edgeBoost;
    return g;
  }

  /** Rotate the skis toward the steer target. Returns nothing; writes p.heading / turnRate. */
  /** gLat: gravity's component across the skis (m/s², + pushes right), which the edges must also hold. */
  private steer(h: number, c: Controls, grip: number, airborne: boolean, gLat = 0) {
    const p = this.p;
    let desired: number;
    let look: number;
    if (this.hockey > 0.5) {
      // Hockey stop: throw the skis across the direction of travel.
      const vh = Math.atan2(-p.velocity.x, -p.velocity.z);
      look = desired = angleDelta(p.heading, vh - Math.sign(c.moveX) * Math.PI * 0.5);
    } else {
      // Look offset decides carve vs. throw; A/D add lean within the carve envelope.
      look = angleDelta(p.heading, c.steerYaw);
      desired = look - (this.locked ? 0 : c.moveX) * SKI.keySteer;
    }
    desired = clamp(desired, -Math.PI, Math.PI);
    this.edgeOn = this.edgeKey && c.moveX * desired < 0;
    let lim: number;
    if (airborne) lim = SKI.airSpin;
    else {
      const v = Math.abs(this.vAlong);
      const pivot = lerp(SKI.pivotRate[0], SKI.pivotRate[1], smoothstep(4, 25, v)) * (this.plow > 0.5 ? 0.7 : 1);
      // Centripetal the edges can still give after holding gravity; once sliding, only the kinetic share.
      const turnRight = desired < 0 ? 1 : -1;
      const cap = this.skidSpeed > 0.4 ? SKI.skidFactor * 0.95 : 0.95;
      const avail = Math.max(grip * 0.15, grip * cap + turnRight * gLat);
      const carve = avail / Math.max(v, 1.5);
      const od = Math.max(this.hockey, smoothstep(SKI.overdrive[0], SKI.overdrive[1], Math.abs(look)));
      lim = v < 2 ? pivot : lerp(Math.min(carve, pivot), pivot, od);
    }
    if (this.locked) lim *= 0.25;
    const w = clamp(desired * SKI.steerGain, -lim, lim);
    p.heading += w * h;
    this.turnRate = w;
  }

  // ------------------------------------------------------------------ skiing (grounded)
  private skiGround(h: number, c: Controls) {
    const p = this.p;
    const v = p.velocity;
    const n = this.groundN;
    const surface = p.surface;
    const load = Math.max(0.2 * GRAVITY, GRAVITY * n.y + this.compression);
    const speed = v.length();

    // Ski frame on the tangent plane (before and after steering).
    _gt.set(0, -GRAVITY, 0).addScaledVector(n, GRAVITY * n.y);
    _fwd.set(-Math.sin(p.heading), 0, -Math.cos(p.heading));
    _s.copy(_fwd).addScaledVector(n, -_fwd.dot(n)).normalize();
    _r.crossVectors(_s, n).normalize();
    this.steer(h, c, this.gripLimit(load, speed, surface), false, _gt.dot(_r));
    _fwd.set(-Math.sin(p.heading), 0, -Math.cos(p.heading));
    _s.copy(_fwd).addScaledVector(n, -_fwd.dot(n)).normalize();
    _r.crossVectors(_s, n).normalize();

    // Stay on the plane, then gravity along it.
    v.addScaledVector(n, -v.dot(n));
    _gt.set(0, -GRAVITY, 0).addScaledVector(n, GRAVITY * n.y);
    const grade = _s.y; // sin of the slope along the skis (+ = uphill)
    this.wantClimb = this.wantPole && grade > Math.sin(SKI.climbStartGrade);
    const climbing = this.wantClimb;
    const toggling = this.toggleT >= 0;

    // Along-ski gravity is held by the edges while climbing (herringbone) or clipping in/out.
    if (climbing || toggling) v.addScaledVector(_gt, h).addScaledVector(_s, -_gt.dot(_s) * h);
    else {
      v.addScaledVector(_gt, h);
      // Game feel: extra downhill pull along the skis so runs build speed fast and feel thrilling.
      const down = _gt.dot(_s);
      if (down > 0) v.addScaledVector(_s, down * (SKI.slopeBoost - 1) * h);
    }

    // Air drag
    const sp = v.length();
    const k = SKI.drag * lerp(1, SKI.tuckDrag, this.tuck) * lerp(1, SKI.crouchDrag, this.crouch * (1 - this.tuck));
    v.multiplyScalar(1 / (1 + k * sp * h));

    let vs = v.dot(_s);
    let vl = v.dot(_r);

    // Propulsion: pole push / skating on the flat, herringbone uphill.
    if (climbing) {
      const target = grade < Math.sin(SKI.climbMax) ? SKI.climbSpeed * (1 - 0.6 * (Math.asin(grade) / SKI.climbMax)) : 0;
      vs += clamp(target - vs, -4 * h, 4 * h);
      p.stamina = Math.max(0, p.stamina - SKI.climbDrain * h);
      this.polePhase = (this.polePhase + h / 0.8) % 1;
    } else if (this.wantPole && vs < SKI.poleMaxSpeed && !toggling) {
      const prev = this.polePhase;
      this.polePhase = (this.polePhase + h / SKI.poleCycle) % 1;
      if (prev < 0.06 && this.polePhase >= 0.06) this.hooks.polePlant(0);
      const ph = this.polePhase;
      const push = ph > 0.08 && ph < 0.46 ? Math.sin((Math.PI * (ph - 0.08)) / 0.38) : 0;
      const tired = p.stamina > 0.5 ? 1 : 0.4;
      const a = SKI.poleAccel * push * clamp(1 - Math.max(vs, 0) / SKI.poleMaxSpeed, 0, 1) * tired;
      vs += a * h;
      p.stamina = Math.max(0, p.stamina - SKI.skateDrain * h);
      this.poleIdle = 0;
    } else {
      this.poleIdle += h;
      if (this.poleIdle > 0.4) this.polePhase = 0;
    }

    // Along-ski friction (+ snowplow). Static hold when it would stop us.
    const mu = SKI.mu[surface] ?? SKI.mu.snow;
    let brake = mu * load;
    if (this.plow > 0.05) brake += Math.min(SKI.plowMax, SKI.plowBase + SKI.plowPerSpeed * Math.abs(vs)) * this.plow;
    if (toggling) brake += 6;
    if (Math.abs(vs) <= brake * h) {
      const gAlong = Math.abs(_gt.dot(_s));
      const hold = SKI.muStatic * load + (this.plow > 0.5 ? GRAVITY * Math.sin(SKI.plowHoldSlope) : 0);
      if (gAlong <= hold || climbing || toggling) vs = 0;
    } else vs -= Math.sign(vs) * brake * h;

    // Lateral edge grip: carve (grip holds) or skid (sliding friction).
    const grip = this.gripLimit(load, sp, surface);
    const gl = _gt.dot(_r);
    let latA: number;
    if (Math.abs(vl) <= grip * h) {
      latA = -vl / h;
      vl = 0;
      this.skidSpeed = damp(this.skidSpeed, 0, 20, h);
    } else {
      // Breakaway: just over the limit the edge still bites hard; a full sideways slide is kinetic.
      const over = Math.abs(vl) - grip * h;
      const a = grip * lerp(0.92, SKI.skidFactor, smoothstep(0, 1.2, over));
      latA = -Math.sign(vl) * a;
      vl -= Math.sign(vl) * a * h;
      this.skidSpeed = Math.abs(vl);
      // Skis turned across the travel direction plow snow: the along-ski speed bleeds off too.
      const tot = Math.hypot(vs, vl);
      if (tot > 0.05) {
        const plowing = SKI.skidAlongBrake * a * (Math.abs(vl) / tot) * h;
        vs = Math.abs(vs) <= plowing ? 0 : vs - Math.sign(vs) * plowing;
      }
    }
    // Centripetal part only (holding an edge against gravity on a traverse isn't turning).
    this.latAcc = latA + gl;
    this.vAlong = vs;

    v.copy(_s).multiplyScalar(vs).addScaledVector(_r, vl);
    p.position.addScaledVector(v, h);
    this.stepUp();
    this.collide(h, true);
    this.settle(h, true);
  }

  // ------------------------------------------------------------------ walking (grounded)
  private walkGround(h: number) {
    const p = this.p;
    const v = p.velocity;
    const n = this.groundN;
    const slope = Math.acos(clamp(n.y, -1, 1));
    const natural = this.groundKind !== 'collider';
    let wx = this.wishX * this.wishSpeed,
      wz = this.wishZ * this.wishSpeed;

    // Grade limits. Gear decides how steep you can go:
    //  - boots: up to WALK.maxClimb
    //  - crampons: steep snow and ice (~64 deg), no slipping on ice
    //  - ice axe: haul yourself up almost anything (~86 deg) at a steady, stamina-hungry pace
    const g = this.gear;
    const axeOk = g.iceAxe && p.stamina > 1;
    const maxClimb = axeOk ? 86 * DEG : g.crampons ? 64 * DEG : WALK.maxClimb;
    const slideAngle = axeOk ? 88 * DEG : g.crampons ? 70 * DEG : WALK.slideAngle;
    let climbingFace = false;
    if (natural && slope > 0.02) {
      const hl = Math.hypot(n.x, n.z);
      const ux = -n.x / hl,
        uz = -n.z / hl; // uphill (horizontal)
      const wl = Math.hypot(wx, wz);
      if (wl > 1e-4) {
        const along = (wx * ux + wz * uz) / wl;
        if (along > 0) {
          const dirGrade = Math.atan(Math.tan(slope) * along);
          // Gentle slowdown uphill (hills shouldn't feel like walls).
          const f = 1 - 0.3 * smoothstep(0, maxClimb, dirGrade);
          wx *= f;
          wz *= f;
          if (dirGrade > (g.crampons ? 64 * DEG : WALK.maxClimb) && axeOk) {
            // Axe climbing: a slow, steady haul; burns stamina.
            climbingFace = true;
            const k = 1.25 / Math.max(1e-4, Math.hypot(wx, wz));
            wx *= Math.min(1, k * (g.crampons ? 1.3 : 1));
            wz *= Math.min(1, k * (g.crampons ? 1.3 : 1));
            p.stamina = Math.max(0, p.stamina - 6 * h);
          }
          if (dirGrade > maxClimb) {
            const up = wx * ux + wz * uz;
            wx -= ux * up;
            wz -= uz * up;
          }
        }
      }
    }
    this.axeClimb = damp(this.axeClimb, climbingFace ? 1 : 0, 6, h);

    this.sliding = natural && slope > slideAngle;
    const ice = p.surface === 'ice' && !g.crampons;
    if (this.sliding) {
      // Too steep to stand: slide down with snow friction, little control.
      _gt.set(0, -GRAVITY, 0).addScaledVector(n, GRAVITY * n.y);
      v.addScaledVector(_gt, h);
      v.addScaledVector(n, -v.dot(n));
      const sp = v.length();
      const fr = WALK.slideFriction * GRAVITY * n.y * h;
      if (sp > fr) v.multiplyScalar((sp - fr) / sp);
      v.x += wx * 0.3 * h;
      v.z += wz * 0.3 * h;
    } else {
      const moving = Math.hypot(wx, wz) > 0.01;
      const acc = (moving ? (ice ? WALK.iceAccel : WALK.accel) : ice ? WALK.iceDecel : WALK.decel) * h;
      const dx = wx - v.x,
        dz = wz - v.z;
      const dl = Math.hypot(dx, dz);
      if (dl <= acc) {
        v.x = wx;
        v.z = wz;
      } else {
        v.x += (dx / dl) * acc;
        v.z += (dz / dl) * acc;
      }
      // Walking is horizontal intent; ride the tangent plane.
      v.y = -(n.x * v.x + n.z * v.z) / Math.max(n.y, 0.2);
    }

    const before = p.position.x,
      beforeZ = p.position.z;
    p.position.addScaledVector(v, h);
    this.stepUp();
    this.collide(h, false);
    this.settle(h, false);

    // Stride timing (footsteps, head bob).
    const d = Math.hypot(p.position.x - before, p.position.z - beforeZ);
    const hs = Math.hypot(v.x, v.z);
    this.strideLen = WALK.strideBase + WALK.strideSpeed * hs;
    if (!this.sliding && p.grounded) {
      this.strideDist += d;
      if (this.strideDist >= this.strideLen) {
        this.strideDist -= this.strideLen;
        this.stepIndex++;
        const side = this.stepIndex & 1 ? 1 : -1;
        const l = Math.max(hs, 1e-4);
        this.hooks.footstep(side, p.surface, this.packed, p.position, v.x / l, v.z / l, hs);
      }
    }
  }

  // ------------------------------------------------------------------ air
  private airStep(h: number, c: Controls, skis: boolean) {
    const p = this.p;
    const v = p.velocity;
    v.y -= GRAVITY * h;
    const sp = v.length();
    const k = (skis ? SKI.drag * lerp(1, SKI.tuckDrag, this.tuck) : SKI.drag) * 1.1;
    v.multiplyScalar(1 / (1 + k * sp * h));
    if (skis) {
      this.steer(h, c, 0, true);
      if (!this.locked && c.moveX !== 0) {
        v.x += Math.cos(p.heading) * c.moveX * SKI.airControl * h;
        v.z += -Math.sin(p.heading) * c.moveX * SKI.airControl * h;
      }
      this.latAcc = damp(this.latAcc, 0, 4, h);
      this.skidSpeed = 0;
    } else if (!this.locked) {
      // Slight air control toward the wish direction.
      const wx = this.wishX * this.wishSpeed,
        wz = this.wishZ * this.wishSpeed;
      const dx = wx - v.x,
        dz = wz - v.z;
      const dl = Math.hypot(dx, dz);
      const a = WALK.airAccel * h;
      if (dl > 1e-4 && Math.hypot(wx, wz) > 0.01) {
        v.x += (dx / dl) * Math.min(a, dl);
        v.z += (dz / dl) * Math.min(a, dl);
      }
    }
    p.position.addScaledVector(v, h);
    this.collide(h, skis);
    this.settle(h, false);
  }

  // ------------------------------------------------------------------ crashed / dead body
  private bodyStep(h: number) {
    const p = this.p;
    const v = p.velocity;
    if (p.grounded) {
      const n = this.groundN;
      v.addScaledVector(n, -v.dot(n));
      _gt.set(0, -GRAVITY, 0).addScaledVector(n, GRAVITY * n.y);
      v.addScaledVector(_gt, h);
      const sp = v.length();
      const load = Math.max(0.2 * GRAVITY, GRAVITY * n.y + this.compression);
      const mu = p.surface === 'ice' ? 0.2 : p.mode === 'dead' ? 0.95 : SKI.bodyMu;
      const fr = mu * load * h;
      if (sp <= fr) v.set(0, 0, 0);
      else v.multiplyScalar((sp - fr) / sp);
    } else {
      v.y -= GRAVITY * h;
    }
    const sp = v.length();
    v.multiplyScalar(1 / (1 + SKI.bodyDrag * sp * h));
    p.position.addScaledVector(v, h);
    this.collide(h, false);
    this.settle(h, false);
    this.latAcc = 0;
    this.skidSpeed = 0;
  }

  // ------------------------------------------------------------------ contacts
  /** Obstacles (trees, boulders, walls): slide along, crash on hard hits while skiing. */
  private collide(_h: number, crashable: boolean) {
    const p = this.p;
    const v = p.velocity;
    const contacts = this.ground.collide(p.position, p.radius, this.capsuleH);
    for (let i = 0; i < contacts.length; i++) {
      const cn = contacts[i];
      if (cn.y > 0.6) {
        // Standing on something round/solid: kill downward motion into it.
        const vn = v.dot(cn);
        if (vn < 0) v.addScaledVector(cn, -vn);
        continue;
      }
      _t.set(cn.x, 0, cn.z);
      const l = _t.length();
      if (l < 1e-5) continue;
      _t.divideScalar(l);
      const vn = v.x * _t.x + v.z * _t.z;
      if (vn >= 0) continue;
      const impact = -vn;
      const speed = v.length();
      v.x -= _t.x * vn;
      v.z -= _t.z * vn;
      if (crashable && p.onSkis && impact > SKI.crashImpact && p.alive) {
        this.crash(speed, 'impact', impact);
        v.multiplyScalar(0.25);
      } else if (impact > SKI.bumpImpact) {
        v.multiplyScalar(1 - Math.min(0.45, impact * 0.05));
        this.hooks.bump(impact, _t);
      }
    }
  }

  /**
   * Ledges (foundations, floors, low rocks) within step height: climb onto them before the obstacle
   * push-out runs, otherwise the capsule would be shoved back off the edge.
   */
  private stepUp() {
    const p = this.p;
    if (!p.grounded) return;
    const pos = p.position;
    const up = p.onSkis ? 0.35 : WALK.stepUp;
    const y = this.ground.height(pos.x, pos.y + up, pos.z, this.footprint());
    if (y > pos.y + 0.02 && y <= pos.y + up) pos.y = y;
  }

  /** Capsule footprint radius used to find structure floors under the edge of the feet. */
  private footprint() {
    return this.p.mode === 'crashed' || this.p.mode === 'dead' ? 0.2 : this.p.radius * 1.08;
  }

  /** After moving: stay glued to the ground, step up onto ledges, or leave it (launch / fall). */
  private settle(h: number, allowLaunch: boolean) {
    const p = this.p;
    const pos = p.position;
    const v = p.velocity;
    const stepUp = p.onSkis ? 0.35 : WALK.stepUp;
    const s = this.ground.sample(pos.x, pos.y + stepUp, pos.z, this.gs, this.footprint());
    const gap = pos.y - s.y;
    if (p.grounded) {
      const speed = v.length();
      const snap = p.onSkis || p.mode === 'crashed' || p.mode === 'dead' ? 0.08 + speed * h * 1.6 : WALK.snapDown;
      if (gap <= 0 || (this.noSnap <= 0 && gap <= snap && !(allowLaunch && this.shouldLaunch(gap)))) {
        pos.y = s.y;
        this.contact(s, h, false);
        return;
      }
      // Leave the ground: we keep the tangent velocity we had at the lip.
      p.grounded = false;
      this.airT = 0;
      this.coyote = 0;
      return;
    }
    if (gap <= 0 && (this.noSnap <= 0.05 || gap < -0.25)) {
      pos.y = s.y;
      this.contact(s, h, true);
    }
  }

  /** Would the skier still be clear of the snow a moment from now even pulling down with the legs? */
  private shouldLaunch(gap: number): boolean {
    if (gap < 0.004) return false;
    const p = this.p;
    const v = p.velocity;
    if (v.lengthSq() < 36) return false; // < 6 m/s: legs absorb everything
    const T = SKI.launchLookahead;
    const x = p.position.x + v.x * T,
      z = p.position.z + v.z * T;
    const yb = p.position.y + v.y * T - 0.5 * (GRAVITY + SKI.absorb) * T * T;
    const gy = this.ground.height(x, yb + 2, z);
    return yb - gy > SKI.launchGap;
  }

  /** Touching a surface: redirect velocity along it, or resolve a landing. */
  private contact(s: GroundSample, h: number, landing: boolean) {
    const p = this.p;
    const v = p.velocity;
    const n = s.normal;
    const vn = v.dot(n);
    p.surface = s.surface;
    this.groundKind = s.kind;
    this.packed = s.packed;

    if (landing) {
      this.groundN.copy(n);
      this.land(Math.max(0, -vn), n);
      return;
    }
    const speed = v.length();
    if (vn < 0) {
      const into = -vn;
      if (into < 1.2 + 0.06 * speed || !p.onSkis || p.mode === 'crashed' || p.mode === 'dead') {
        // Smooth transition (compression): the snow turns us without scrubbing speed.
        v.addScaledVector(n, -vn);
        if (p.onSkis || p.mode === 'crashed') {
          const l = v.length();
          if (l > 1e-6) v.multiplyScalar(speed / l);
        }
        this.compAcc += Math.min(into / h, 4 * GRAVITY);
      } else {
        // Slammed into a steep bank/ramp face while grounded: that's an impact like a landing.
        this.groundN.copy(n);
        this.land(into, n);
        return;
      }
    } else if (vn > 0) {
      // Surface falls away but the legs keep us on it: redirect, preserving speed.
      v.addScaledVector(n, -vn);
      const l = v.length();
      if (l > 1e-6 && p.onSkis) v.multiplyScalar(speed / l);
      this.compAcc -= Math.min(vn / h, GRAVITY);
    }
    this.groundN.copy(n);
    p.grounded = true;
  }

  private land(impact: number, n: THREE.Vector3) {
    const p = this.p;
    const v = p.velocity;
    const air = this.airT;
    v.addScaledVector(n, -v.dot(n));
    p.grounded = true;
    if (air > 0) this.lastAirTime = air;
    this.airT = 0;
    this.noSnap = 0;

    if (p.mode === 'crashed' || p.mode === 'dead') {
      if (impact > WALK.fallDamageSpeed) this.hooks.land(impact, 1, false, air);
      return;
    }
    if (p.onSkis) {
      const absorb = 1 + 0.2 * Math.max(this.crouch, this.tuck, this.charge);
      // Skis vs. the direction we're sliding on the landing plane (switch landings are fine).
      _fwd.set(-Math.sin(p.heading), 0, -Math.cos(p.heading));
      _s.copy(_fwd).addScaledVector(n, -_fwd.dot(n)).normalize();
      const vt = v.length();
      const misalign = vt > 0.5 ? Math.acos(clamp(Math.abs(_s.dot(v) / vt), 0, 1)) : 0;
      if (impact > SKI.landCrash * absorb) {
        this.crash(vt, 'landing', impact);
      } else if (vt > SKI.catchEdgeSpeed && misalign > SKI.catchEdgeAngle && air > 0.2) {
        this.crash(vt, 'edge', impact);
      } else {
        const hard = impact > SKI.landHard * absorb;
        v.multiplyScalar(1 - clamp(impact * 0.018, 0, 0.22));
        if (air > 0.18 || impact > 2.5) this.hooks.land(impact, hard ? 1 : 0, true, air);
      }
    } else {
      // On foot: landing kills most horizontal momentum.
      if (air > 0.25) {
        v.x *= 0.55;
        v.z *= 0.55;
      }
      if (air > 0.18 || impact > 2.5) this.hooks.land(impact, impact > WALK.fallDamageSpeed ? 1 : 0, false, air);
    }
  }

  crash(speed: number, reason: CrashReason, impact: number) {
    const p = this.p;
    if (p.mode === 'crashed' || p.mode === 'dead' || !p.alive) return;
    p.mode = 'crashed';
    p.tucking = false;
    this.crashT = 0;
    this.charge = 0;
    this.crashSpin = reason === 'impact' ? -1 : 1;
    this.hooks.crash(speed, reason, impact);
  }

  // ------------------------------------------------------------------ toggling skis
  private updateToggle(dt: number, c: Controls) {
    const p = this.p;
    if (this.toggleT < 0) {
      if (c.toggleSkis && p.alive && p.grounded && (p.mode === 'walk' || p.mode === 'ski') && p.velocity.length() < SKI.toggleMaxSpeed) {
        this.toggleT = 0;
        this.toggleTo = !p.onSkis;
        this.hooks.skiToggle(this.toggleTo, 'start');
      }
      return;
    }
    if (!p.alive || p.mode === 'crashed') {
      this.toggleT = -1;
      return;
    }
    const prev = this.toggleT;
    this.toggleT += dt;
    const click = SKI.toggleTime * 0.7;
    if (prev < click && this.toggleT >= click) this.hooks.skiToggle(this.toggleTo, 'click');
    if (this.toggleT >= SKI.toggleTime) {
      this.toggleT = -1;
      p.onSkis = this.toggleTo;
      p.mode = p.onSkis ? 'ski' : 'walk';
      p.heading = p.yaw;
      p.velocity.multiplyScalar(0.3);
      this.hooks.skiToggle(p.onSkis, 'done');
    }
  }

  // ------------------------------------------------------------------ bookkeeping
  private postFrame(dt: number, c: Controls) {
    const p = this.p;
    this.capsuleH = p.mode === 'crashed' || p.mode === 'dead' ? 0.8 : p.crouching || p.tucking ? 1.3 : 1.8;

    // Crash tumble -> get up.
    if (p.mode === 'crashed') {
      this.crashT += dt;
      if ((this.crashT > SKI.crashTime && p.grounded && p.velocity.length() < SKI.getUpSpeed) || this.crashT > SKI.crashMaxTime) {
        this.getUp();
      }
    }

    // Mode from contact state.
    if (p.mode !== 'crashed' && p.mode !== 'dead') {
      if (!p.grounded) {
        this.hag = p.position.y - this.ground.height(p.position.x, p.position.y, p.position.z);
        if (this.airT > 0.15 || this.hag > 0.4) p.mode = 'air';
      } else {
        this.hag = 0;
        p.mode = p.onSkis ? 'ski' : 'walk';
      }
    }
    p.airTime = p.grounded ? 0 : this.airT;
    // Keep the heading in (-PI, PI] (everything compares headings with angleDelta).
    if (p.heading > Math.PI || p.heading <= -Math.PI) p.heading = Math.atan2(Math.sin(p.heading), Math.cos(p.heading));

    if (!p.onSkis && p.mode !== 'crashed' && p.mode !== 'dead') p.heading = p.yaw;

    // Smoothed readouts for camera, body and audio.
    const skiingGrounded = p.onSkis && p.grounded && p.mode === 'ski';
    this.skid = damp(this.skid, skiingGrounded ? smoothstep(0.35, 4, this.skidSpeed) : 0, 14, dt);
    this.poling = damp(this.poling, skiingGrounded && this.polePhase > 0 && this.wantPole && !this.wantClimb ? 1 : 0, 6, dt);
    this.climbing = damp(this.climbing, skiingGrounded && this.wantClimb ? 1 : 0, 6, dt);
    const carveTarget = p.onSkis && p.mode !== 'crashed' ? clamp(this.latAcc / (GRAVITY * 1.5), -1, 1) : 0;
    p.carve = damp(p.carve, carveTarget, 9, dt);
    this.edge = damp(this.edge, p.onSkis && p.grounded ? Math.atan2(this.latAcc, GRAVITY) * 0.8 : 0, 10, dt);

    // Pole plant on the inside of each new turn (rhythm of linked turns).
    this.plantCooldown -= dt;
    if (skiingGrounded && Math.abs(this.vAlong) > 4) {
      const sgn = this.latAcc > 3 ? 1 : this.latAcc < -3 ? -1 : 0;
      if (sgn === 0) {
        this.straightT += dt;
        if (this.straightT > 0.8) this.turnSign = 0;
      } else {
        this.straightT = 0;
        if (sgn !== this.turnSign && this.plantCooldown <= 0) {
          this.hooks.polePlant(sgn);
          this.plantCooldown = 0.45;
        }
        this.turnSign = sgn;
      }
    }

    // World bounds: a soft invisible wall.
    const out = this.ground.outside(p.position.x, p.position.z, _v2);
    if (out > 0) {
      const ux = _v2.x / out,
        uz = _v2.y / out;
      const vo = p.velocity.x * ux + p.velocity.z * uz;
      const push = Math.min(1, dt * (2 + out * 0.5));
      if (vo > 0) {
        p.velocity.x -= ux * vo * push;
        p.velocity.z -= uz * vo * push;
      }
      p.velocity.x -= ux * out * 3 * dt;
      p.velocity.z -= uz * out * 3 * dt;
      if (out > 30) {
        p.position.x -= ux * (out - 30);
        p.position.z -= uz * (out - 30);
      }
    }
    void c;
  }

  private getUp() {
    const p = this.p;
    if (!p.alive) return;
    p.mode = p.onSkis ? 'ski' : 'walk';
    p.velocity.multiplyScalar(0.2);
    // Stand up across the fall line (the stable way a skier recovers), on the side nearest the look.
    const n = this.groundN;
    if (p.onSkis && n.y < 0.985) {
      const fall = Math.atan2(-n.x, -n.z); // heading pointing downhill
      const a = fall + Math.PI / 2,
        b = fall - Math.PI / 2;
      p.heading = Math.abs(angleDelta(p.yaw, a)) < Math.abs(angleDelta(p.yaw, b)) ? a : b;
    } else p.heading = p.yaw;
    this.crashT = 0;
    this.hooks.gotUp();
  }
}
