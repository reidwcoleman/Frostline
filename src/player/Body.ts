// First-person body. Two parts:
//  - world space: skis (aligned to the snow and the ski heading), bindings, boots and legs, plus a
//    shadow-only torso/head so the player casts a whole-body shadow.
//  - camera space (on `viewmodel`): mittens, sleeves and poles on the public rightHand / leftHand anchors.
//    When looking down the arms stay roughly where the body is (pitch compensation) so the poles reach
//    the snow; with a tool equipped the hands stay framed for combat.
import * as THREE from 'three';
import type { GameContext } from '../core/types';
import { clamp, damp, dampAngle, lerp, smoothstep, TAU } from '../core/math';
import { buildArm, buildPole, buildSkiAssembly, buildSkiGeometry, makeMaterials, type GearMaterials, type SkiAssembly } from './Gear';
import type { Locomotion } from './Locomotion';
import { SKI } from './tuning';

const _m = new THREE.Matrix4();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _f = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _k = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _seg = new THREE.Vector3();

/** Anchor rest positions (camera space). Combat attaches weapons relative to these. */
const HAND_R = new THREE.Vector3(0.28, -0.3, -0.5);
const HAND_L = new THREE.Vector3(-0.28, -0.3, -0.5);

interface PlantAnim {
  t: number; // seconds since plant (-1 idle)
}

export class Body {
  /** World-space root at the feet. */
  readonly world = new THREE.Group();
  private skiRig = new THREE.Group();
  private skiL: SkiAssembly;
  private skiR: SkiAssembly;
  private legs: { thigh: THREE.Mesh; shin: THREE.Mesh; knee: THREE.Mesh }[] = [];
  private shadowProxy: THREE.Group;
  private mats: GearMaterials;

  // camera space
  private torso = new THREE.Group();
  private armR: THREE.Group;
  private armL: THREE.Group;
  private gripR = new THREE.Group();
  private gripL = new THREE.Group();
  private poleR: THREE.Group;
  private poleL: THREE.Group;

  private normal = new THREE.Vector3(0, 1, 0);
  private skiYaw = 0;
  private airPitch = 0;
  private plantR: PlantAnim = { t: -1 };
  private plantL: PlantAnim = { t: -1 };
  private skiVis = 0; // 0..1 skis clipped on (animated)
  private armsVis = 0;
  private compK = 0.5;
  private lastYaw = 0;
  private yawLag = 0;
  private pitchLag = 0;
  private lastPitch = 0;
  private idleT = 0;
  private handR = new THREE.Vector3();
  private handL = new THREE.Vector3();
  private rightHand: THREE.Group;
  private leftHand: THREE.Group;
  private tp = false;

  constructor(private ctx: GameContext, viewmodel: THREE.Group, rightHand: THREE.Group, leftHand: THREE.Group) {
    this.rightHand = rightHand;
    this.leftHand = leftHand;
    const aniso = ctx.renderer.capabilities.getMaxAnisotropy();
    this.mats = makeMaterials(aniso);
    const m = this.mats;

    // ---- world: skis + boots
    const skiGeo = buildSkiGeometry();
    this.skiL = buildSkiAssembly(m, skiGeo, -1);
    this.skiR = buildSkiAssembly(m, skiGeo, 1);
    this.skiRig.add(this.skiL.root, this.skiR.root);
    this.world.add(this.skiRig);
    this.world.name = 'playerBody';

    // ---- legs (thigh, shin, knee) per side; transforms solved each frame.
    const thighGeo = new THREE.CylinderGeometry(0.078, 0.068, 1, 14, 1);
    thighGeo.translate(0, 0.5, 0);
    const shinGeo = new THREE.CylinderGeometry(0.066, 0.058, 1, 14, 1);
    shinGeo.translate(0, 0.5, 0);
    const kneeGeo = new THREE.SphereGeometry(0.068, 16, 12);
    for (let i = 0; i < 2; i++) {
      // Legs only cast shadows: seen from the eye without a torso they read as floating tubes.
      // The visible body is skis + boots + pant cuffs (like a VR skier looking down).
      const thigh = new THREE.Mesh(thighGeo, m.shadowOnly);
      const shin = new THREE.Mesh(shinGeo, m.shadowOnly);
      const knee = new THREE.Mesh(kneeGeo, m.shadowOnly);
      for (const o of [thigh, shin, knee]) {
        o.castShadow = true;
        o.frustumCulled = false;
      }
      this.world.add(thigh, shin, knee);
      this.legs.push({ thigh, shin, knee });
    }

    // ---- shadow-only torso + head so the sun casts a whole skier.
    this.shadowProxy = new THREE.Group();
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.42, 4, 10), m.shadowOnly);
    torso.name = 'torso';
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 8), m.shadowOnly);
    head.name = 'head';
    const armsProxy = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.5, 3, 6), m.shadowOnly);
    armsProxy.name = 'arms';
    armsProxy.rotation.z = Math.PI / 2;
    for (const o of [torso, head, armsProxy]) {
      o.castShadow = true;
      o.frustumCulled = false;
      this.shadowProxy.add(o);
    }
    this.world.add(this.shadowProxy);

    // ---- camera space: arms, mittens, poles
    viewmodel.add(this.torso);
    this.torso.add(rightHand, leftHand);
    rightHand.position.copy(HAND_R);
    leftHand.position.copy(HAND_L);
    const ar = buildArm(m, 1);
    const al = buildArm(m, -1);
    this.armR = ar.group;
    this.armL = al.group;
    this.poleR = buildPole(m);
    this.poleL = buildPole(m);
    this.gripR.add(this.armR, this.poleR);
    this.gripL.add(this.armL, this.poleL);
    rightHand.add(this.gripR);
    leftHand.add(this.gripL);
    this.handR.copy(HAND_R);
    this.handL.copy(HAND_L);
    viewmodel.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = false;
        o.receiveShadow = false;
        // Hands sit < 1 m from the eye: never let frustum culling pop them.
        o.frustumCulled = false;
      }
    });
  }

  /** Third person: give the world-space shadow-proxy body real materials so it's actually visible,
   *  and hide the camera-space arms/poles (they only make sense seen from inside the head). */
  setThirdPerson(on: boolean) {
    const m = this.mats;
    const [torso, head, arms] = this.shadowProxy.children as THREE.Mesh[];
    torso.material = on ? m.jacket : m.shadowOnly;
    arms.material = on ? m.jacket : m.shadowOnly;
    head.material = on ? m.jacketShade : m.shadowOnly;
    for (const { thigh, shin, knee } of this.legs) {
      thigh.material = on ? m.pants : m.shadowOnly;
      shin.material = on ? m.pants : m.shadowOnly;
      knee.material = on ? m.pants : m.shadowOnly;
    }
    this.tp = on;
    this.torso.visible = !on && this.armsVis > 0.02;
  }

  reset() {
    const p = this.ctx.player;
    this.skiVis = p.onSkis ? 1 : 0;
    this.plantL.t = this.plantR.t = -1;
    this.skiYaw = p.heading;
    this.lastYaw = p.yaw;
    this.lastPitch = p.pitch;
    this.yawLag = this.pitchLag = 0;
    this.normal.set(0, 1, 0);
  }

  /** Pole plant: side +1 right, -1 left, 0 both (double pole). */
  plant(side: number) {
    if (side >= 0) this.plantR.t = 0;
    if (side <= 0) this.plantL.t = 0;
  }

  update(dt: number, loco: Locomotion, eye: number, hidden: boolean) {
    const { player: p, inventory } = this.ctx;
    this.idleT += dt;
    const alive = p.mode !== 'crashed' && p.mode !== 'dead';

    // ---- skis clip on/off animation
    const toggling = loco.toggleT >= 0;
    let clip = p.onSkis ? 1 : 0;
    if (toggling) {
      const k = smoothstep(0.1, 0.7, loco.toggleT / SKI.toggleTime);
      clip = loco.toggleTo ? k : 1 - k;
    }
    this.skiVis = clip;
    this.world.visible = !hidden && alive;
    if (this.world.visible) this.updateWorld(dt, loco, eye, clip, toggling);

    // ---- arms / poles
    const equipped = inventory.equipped;
    const armsOn = !hidden && alive && (p.onSkis || equipped !== null) && !(toggling && !loco.toggleTo && loco.toggleT > SKI.toggleTime * 0.6);
    this.armsVis = damp(this.armsVis, armsOn ? 1 : 0, 10, dt);
    this.updateArms(dt, loco, equipped);
    this.torso.visible = !this.tp && this.armsVis > 0.02;
  }

  // ------------------------------------------------------------------ world-space skis & legs
  private updateWorld(dt: number, loco: Locomotion, eye: number, clip: number, toggling: boolean) {
    const p = this.ctx.player;
    this.world.position.copy(p.position);

    // Smooth the ground normal for the ski plane; in the air relax toward level + trajectory pitch.
    if (p.grounded) this.normal.lerp(loco.groundN, 1 - Math.exp(-18 * dt)).normalize();
    else this.normal.lerp(_up, 1 - Math.exp(-3 * dt)).normalize();
    this.skiYaw = p.onSkis ? p.heading : dampAngle(this.skiYaw, p.heading, 12, dt);

    // Ski frame: forward = heading on the plane.
    _f.set(-Math.sin(this.skiYaw), 0, -Math.cos(this.skiYaw));
    _y.copy(this.normal);
    _f.addScaledVector(_y, -_f.dot(_y)).normalize();
    // In the air the tips follow the trajectory a little.
    const v = p.velocity;
    const hs = Math.hypot(v.x, v.z);
    const targetAirPitch = !p.grounded && hs > 3 ? clamp(Math.atan2(v.y, hs) * 0.35, -0.35, 0.3) : 0;
    this.airPitch = damp(this.airPitch, targetAirPitch, 5, dt);
    if (this.airPitch !== 0) {
      _x.crossVectors(_f, _y).normalize();
      _q.setFromAxisAngle(_x, this.airPitch);
      _f.applyQuaternion(_q);
      _y.applyQuaternion(_q);
    }
    _x.crossVectors(_f, _y).normalize();
    _z.copy(_f).negate();
    _m.makeBasis(_x, _y, _z);
    this.skiRig.quaternion.setFromRotationMatrix(_m);
    this.skiRig.position.set(0, 0, 0);

    // Per-ski pose: stance width, plow wedge, herringbone V, skating splay, edge tilt, inside-ski lead.
    const onSkis = p.onSkis || toggling;
    const plow = loco.plow;
    const climb = loco.climbing;
    const skate = loco.poling * (1 - climb);
    const edge = loco.edge;
    const carve = p.carve;
    const half = 0.1 + 0.07 * plow;
    const wedge = 0.2 * plow - 0.3 * climb; // + tips together
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? -1 : 1;
      const a = side < 0 ? this.skiL : this.skiR;
      const r = a.root;
      a.ski.visible = onSkis && clip > 0.02;
      let x = side * half;
      let yaw = side * wedge; // wedge > 0: left ski tip turns right (−yaw), right ski tip left (+yaw)
      let lift = 0;
      let z = 0;
      if (skate > 0.01) {
        // Skating: each ski in turn splays out and lifts.
        const ph = loco.polePhase * TAU + (side > 0 ? Math.PI : 0);
        yaw -= side * 0.14 * skate * (0.6 + 0.4 * Math.sin(ph));
        lift += Math.max(0, Math.sin(ph)) * 0.05 * skate;
      }
      // Inside ski leads and sits a touch higher in a carve.
      const inside = carve * side > 0 ? 1 : 0;
      z -= inside * Math.abs(carve) * 0.12;
      lift += inside * Math.abs(carve) * 0.02;
      // Walking (skis off): boots stride.
      if (!onSkis) {
        const ph = (loco.stepIndex + loco.strideDist / Math.max(loco.strideLen, 0.1)) * Math.PI;
        const amp = smoothstep(0.2, 1.5, p.speed) * 0.28;
        z += Math.cos(ph) * amp * side;
        lift += Math.max(0, -Math.sin(ph) * side) * 0.07 * smoothstep(0.2, 1.5, p.speed);
        x = side * 0.12;
      }
      // Clip on/off: skis slide in from beside the boots.
      if (toggling || clip < 1) {
        const out = 1 - clip;
        a.ski.position.set(side * out * 0.35, out * 0.05, -out * 0.25);
        a.ski.rotation.set(0, side * out * 0.5, side * out * 0.2);
      } else {
        a.ski.position.set(0, 0, 0);
        a.ski.rotation.set(0, 0, 0);
      }
      r.position.set(x, lift, z);
      r.rotation.set(0, yaw, -edge * (onSkis ? 1 : 0), 'YXZ');
      // Without skis the boot stands on the snow (drop the ski/plate height).
      a.boot.position.y = onSkis ? 0.057 : 0.0;
    }

    // ---- legs: 2-bone IK from each boot cuff to the hips.
    this.world.updateMatrixWorld(true);
    const hipH = Math.max(0.35, eye - 0.72);
    _f.set(-Math.sin(this.skiYaw), 0, -Math.cos(this.skiYaw));
    _x.set(-_f.z, 0, _f.x); // right (horizontal)
    // Hips sit back over the heels and shift into the turn (angulation).
    const leanShift = clamp(Math.sin(loco.edge) * 0.35, -0.3, 0.3);
    const back = 0.06 + 0.1 * loco.tuck + 0.06 * loco.charge;
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? -1 : 1;
      const a = side < 0 ? this.skiL : this.skiR;
      const leg = this.legs[s];
      _a.copy(a.ankle);
      a.boot.localToWorld(_a);
      _a.sub(this.world.position); // ankle in root space
      _b.set(0, hipH, 0)
        .addScaledVector(_x, side * 0.1 + leanShift)
        .addScaledVector(_f, -back); // hip
      this.solveLeg(leg, _b, _a, _f);
    }

    // Shadow proxy: torso over the hips, head at the eye.
    const torso = this.shadowProxy.children[0];
    const head = this.shadowProxy.children[1];
    const arms = this.shadowProxy.children[2];
    torso.position.set(0, hipH + 0.4, 0).addScaledVector(_x, leanShift * 0.6).addScaledVector(_f, -back * 0.3 + loco.tuck * 0.2);
    torso.rotation.set(0, this.skiYaw, 0);
    torso.rotateX(-0.25 - loco.tuck * 0.9);
    head.position.set(0, eye - 0.05, 0).addScaledVector(_x, leanShift * 0.3);
    arms.position.set(0, hipH + 0.45, 0).addScaledVector(_f, 0.25);
    arms.rotation.set(0, this.skiYaw, Math.PI / 2, 'YXZ');
  }

  /** Two-bone leg from hip to ankle, knee bending toward `fwd`. */
  private solveLeg(leg: { thigh: THREE.Mesh; shin: THREE.Mesh; knee: THREE.Mesh }, hip: THREE.Vector3, ankle: THREE.Vector3, fwd: THREE.Vector3) {
    const L1 = 0.44,
      L2 = 0.44;
    _z.subVectors(hip, ankle);
    let d = _z.length();
    const dir = _z.divideScalar(Math.max(d, 1e-4)); // ankle -> hip
    d = clamp(d, 0.12, L1 + L2 - 0.001);
    // Distance along the ankle->hip axis to the knee's foot point, and the bend height.
    const a = (L2 * L2 - L1 * L1 + d * d) / (2 * d);
    const hgt = Math.sqrt(Math.max(0, L2 * L2 - a * a));
    // Bend direction: forward, made perpendicular to the leg axis.
    _y.copy(fwd).addScaledVector(dir, -fwd.dot(dir)).normalize();
    _k.copy(ankle).addScaledVector(dir, a).addScaledVector(_y, hgt);
    leg.knee.position.copy(_k);
    placeSegment(leg.shin, ankle, _k);
    placeSegment(leg.thigh, _k, hip);
  }

  // ------------------------------------------------------------------ camera-space arms
  private updateArms(dt: number, loco: Locomotion, equipped: string | null) {
    const p = this.ctx.player;
    const onSkis = p.onSkis && p.mode !== 'crashed';
    const armed = equipped !== null;

    // Look-sway: the arms lag behind fast mouse moves a little.
    const dYaw = angleDiff(this.lastYaw, p.yaw);
    const dPitch = p.pitch - this.lastPitch;
    this.lastYaw = p.yaw;
    this.lastPitch = p.pitch;
    this.yawLag = damp(this.yawLag + clamp(dYaw, -0.2, 0.2) * 0.35, 0, 10, dt);
    this.pitchLag = damp(this.pitchLag + clamp(dPitch, -0.2, 0.2) * 0.35, 0, 10, dt);

    // Pitch compensation: keep unarmed ski hands near the body so poles reach the snow.
    const kT = armed ? 0.12 : onSkis ? (p.pitch < 0 ? 0.4 : 0.25) : 0.2;
    this.compK = damp(this.compK, kT, 6, dt);
    this.torso.rotation.set(-p.pitch * this.compK + this.pitchLag, this.yawLag, 0, 'YXZ');
    // Slide the arms out of view when hidden.
    const hideY = (1 - this.armsVis) * -0.45;

    // ---- hand targets
    const speed = p.velocity.length();
    const breathe = Math.sin(this.idleT * 1.6) * 0.006;
    const tR = _a.copy(HAND_R);
    const tL = _b.copy(HAND_L);
    let swingR = -0.32,
      swingL = -0.32; // pole swing: + = tip forward
    let splay = 0.12;
    if (onSkis) {
      tR.set(0.3, -0.33, -0.47);
      tL.set(-0.3, -0.33, -0.47);
      // Tuck: hands forward and together, poles tucked back under the arms.
      const tk = loco.tuck;
      tR.lerp(_f.set(0.15, -0.3, -0.4), tk);
      tL.lerp(_f.set(-0.15, -0.3, -0.4), tk);
      swingR = lerp(swingR, -1.35, tk);
      swingL = lerp(swingL, -1.35, tk);
      splay = lerp(splay, 0.02, tk);
      // Ollie charge: sink the hands.
      tR.y -= loco.charge * 0.05;
      tL.y -= loco.charge * 0.05;
      // Airborne: arms out a touch for balance.
      if (p.mode === 'air') {
        const k = smoothstep(0.1, 0.5, p.airTime);
        tR.x += 0.05 * k;
        tL.x -= 0.05 * k;
        tR.y += 0.04 * k;
        tL.y += 0.04 * k;
      }
      // Double-pole / skate push cycle.
      if (loco.poling > 0.01 || loco.climbing > 0.01) {
        const k = Math.max(loco.poling, loco.climbing);
        const ph = loco.polePhase;
        let reach: number, swing: number;
        if (ph < 0.08) {
          const u = ph / 0.08;
          reach = lerp(0.6, 1, u);
          swing = lerp(0.2, 0.55, u);
        } else if (ph < 0.46) {
          const u = (ph - 0.08) / 0.38;
          reach = lerp(1, -0.7, u * u * (3 - 2 * u));
          swing = lerp(0.55, -0.95, u);
        } else {
          const u = (ph - 0.46) / 0.54;
          reach = lerp(-0.7, 0.6, u * u * (3 - 2 * u));
          swing = lerp(-0.95, 0.2, u);
        }
        const dy = reach * 0.07,
          dz = -reach * 0.1;
        tR.y += dy * k;
        tL.y += dy * k;
        tR.z += dz * k;
        tL.z += dz * k;
        swingR = lerp(swingR, swing, k);
        swingL = lerp(swingL, swing, k);
      }
      // Single pole plants at turn initiation.
      swingR += this.plantSwing(this.plantR, dt, speed, tR);
      swingL += this.plantSwing(this.plantL, dt, speed, tL);
      // Carve: outside hand a touch higher, inside lower (upper body stays level-ish).
      tR.y += p.carve * 0.025;
      tL.y -= p.carve * 0.025;
    } else {
      // On foot with a tool: gentle walk bob on the arm.
      const ph = (loco.stepIndex + loco.strideDist / Math.max(loco.strideLen, 0.1)) * Math.PI;
      const amp = smoothstep(0.3, 4, p.speed) * (this.ctx.settings.data.headBob ? 1 : 0.4);
      tR.y += Math.abs(Math.sin(ph)) * -0.012 * amp;
      tR.x += Math.cos(ph) * 0.01 * amp;
      tL.y += Math.abs(Math.sin(ph + Math.PI / 2)) * -0.012 * amp;
    }
    if (armed) {
      // Keep the weapon anchor where combat expects it (with a little life).
      tR.lerp(HAND_R, 0.85);
      if (equipped === 'bow') tL.lerp(HAND_L, 0.85);
    }
    tR.y += breathe + hideY;
    tL.y += breathe * 0.8 + hideY;
    this.handR.lerp(tR, 1 - Math.exp(-14 * dt));
    this.handL.lerp(tL, 1 - Math.exp(-14 * dt));
    this.rightHand.position.copy(this.handR);
    this.leftHand.position.copy(this.handL);

    // Grip orientation: the fist holds the pole shaft; the pole swings about the hand.
    this.poleR.rotation.set(swingR, 0, splay, 'ZXY');
    this.poleL.rotation.set(swingL, 0, -splay, 'ZXY');
    this.poleR.visible = onSkis && !armed;
    this.poleL.visible = onSkis && equipped !== 'bow';
    this.gripR.visible = onSkis || armed;
    this.gripL.visible = onSkis || equipped === 'bow' || equipped === 'spear';
    // Mitten tilts slightly with the pole so the grip reads as holding it.
    this.armR.rotation.set(swingR * 0.25, 0, 0);
    this.armL.rotation.set(swingL * 0.25, 0, 0);
  }

  /** Pole plant: tip swings forward, sticks while we pass, returns. Returns extra swing (rad). */
  private plantSwing(a: PlantAnim, dt: number, speed: number, hand: THREE.Vector3): number {
    if (a.t < 0) return 0;
    a.t += dt * (1 + speed * 0.02);
    const t = a.t;
    if (t > 0.6) {
      a.t = -1;
      return 0;
    }
    let s: number;
    if (t < 0.13) s = lerp(0, 0.95, t / 0.13);
    else if (t < 0.42) s = lerp(0.95, -0.35, (t - 0.13) / 0.29);
    else s = lerp(-0.35, 0, (t - 0.42) / 0.18);
    const reach = Math.max(0, Math.sin((Math.PI * t) / 0.42));
    hand.z -= reach * 0.07;
    hand.y -= reach * 0.03;
    return s;
  }
}

function placeSegment(mesh: THREE.Mesh, from: THREE.Vector3, to: THREE.Vector3) {
  _q.setFromUnitVectors(_up, _seg.subVectors(to, from).normalize());
  mesh.quaternion.copy(_q);
  mesh.position.copy(from);
  mesh.scale.set(1, from.distanceTo(to), 1);
}

function angleDiff(a: number, b: number) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}
