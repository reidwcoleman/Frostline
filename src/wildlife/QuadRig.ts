// Procedural quadruped animation: gait cycles (walk / trot / gallop / bound) driven by phase
// and speed, body bob + pitch following the terrain, spine flex, head look-at, tail and ears,
// and analytic 2-bone leg IK that plants each foot on terrain.heightAt().
import * as THREE from 'three';
import { B, BONE_COUNT, legBone, jointList, makeBones, type QuadJoints } from './skeleton';
import { clamp, damp, TAU } from '../core/math';
import type { Terrain } from '../core/Terrain';

export interface GaitParams {
  /** Speeds (m/s) where walk -> trot and trot -> gallop happen. */
  walkMax: number;
  trotMax: number;
  /** Stride frequency model: f = fMin + (fMax - fMin) * (1 - exp(-speed / fScale)). */
  fMin: number;
  fMax: number;
  fScale: number;
  /** Swing foot lift (m) front / hind. */
  liftF: number;
  liftH: number;
  /** Max stance half-sweep (m). */
  reach: number;
  /** Body bob amplitudes (m). */
  bobWalk: number;
  bobTrot: number;
  bobGallop: number;
  /** Gallop spine flex + body rock (rad). */
  flex: number;
  /** Neck pitch to reach the ground when grazing (rad). */
  neckDown: number;
  headDown: number;
  /** Hare-style bounding: both hind feet push together and the whole body hops. */
  bound?: boolean;
  hop?: number;
}

// Phase offsets per leg (FL, FR, HL, HR).
const WALK = [0.25, 0.75, 0.0, 0.5];
const TROT = [0.0, 0.5, 0.5, 0.0];
const GALLOP = [0.52, 0.62, 0.0, 0.1];
const BOUND = [0.46, 0.52, 0.0, 0.04];

const _v = new THREE.Vector3();

const ang = (dz: number, dy: number) => Math.atan2(dz, -dy); // 0 = straight down, + = toward +Z (forward)
const frac = (x: number) => x - Math.floor(x);
const circLerp = (a: number, b: number, t: number) => {
  let d = b - a;
  d -= Math.round(d);
  return a + d * t;
};

export class QuadRig {
  readonly mesh: THREE.SkinnedMesh;
  readonly bones: THREE.Bone[];
  readonly bindAbs: THREE.Vector3[];
  private beta1: number[] = [];
  private beta2: number[] = [];
  private L1: number[] = [];
  private L2: number[] = [];

  // ------------------------------------------------------------- pose inputs (set by the animal)
  /** Forward speed (m/s) used for the gait. */
  speed = 0;
  /** Turn rate (rad/s), bends the spine. */
  turn = 0;
  /** World-space point to look at (null = straight ahead). */
  lookTarget: THREE.Vector3 | null = null;
  /** 0..1 head down to the ground (grazing / sniffing). */
  graze = 0;
  /** 0..1 head held high (alert / howl). */
  headUp = 0;
  /** -1 tucked .. 1 raised. */
  tailUp = 0;
  tailWag = 0;
  /** 0..1 ears pinned back. */
  earsBack = 0;
  /** Extra ear twitch (added by AI). */
  earTwitch = 0;
  jawOpen = 0;
  /** 0..1 lowered stalking crouch. */
  crouch = 0;
  /** 0..1 hare rearing up on hind legs. */
  rear = 0;
  /** 0..1 lunge / leap pose. */
  leap = 0;
  /** Death blend 0..1 and roll side (+1 / -1). */
  dead = 0;
  deadRoll = 0;
  /** Body-centre height when lying on its side (bind units). */
  lieHeight = 0.15;
  /** Vertical offset of the whole body (leaps), metres. */
  air = 0;
  /** Animation time (for idle breathing etc). */
  t = Math.random() * 100;
  phase = Math.random();
  gait = 0;
  /** Called when a foot touches down (leg index, world x, z, heading). */
  onFootDown: ((leg: number, x: number, z: number) => void) | null = null;

  private lookYaw = 0;
  private lookPitch = 0;
  private bodyPitch = 0;
  private bodyY = 0;
  private stanceLast = [true, true, true, true];
  private footWorld = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

  constructor(geometry: THREE.BufferGeometry, material: THREE.Material, readonly joints: QuadJoints, readonly gp: GaitParams, readonly scale = 1) {
    this.bindAbs = jointList(joints);
    this.bones = makeBones(this.bindAbs);
    const mesh = new THREE.SkinnedMesh(geometry, material);
    mesh.add(this.bones[B.body]);
    mesh.updateMatrixWorld(true);
    mesh.bind(new THREE.Skeleton(this.bones));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, joints.body.y, 0), (geometry.boundingSphere?.radius ?? 1) * 1.6);
    mesh.scale.setScalar(scale);
    this.mesh = mesh;
    for (let l = 0; l < 4; l++) {
      const L = joints.legs[l];
      this.beta1[l] = ang(L.knee.z - L.hip.z, L.knee.y - L.hip.y);
      this.beta2[l] = ang(L.foot.z - L.knee.z, L.foot.y - L.knee.y);
      this.L1[l] = L.hip.distanceTo(L.knee);
      this.L2[l] = L.knee.distanceTo(L.foot);
    }
    this.bodyY = joints.body.y;
    if (BONE_COUNT !== this.bones.length) throw new Error('bone count mismatch');
  }

  /** World position of a bone (after the last update). */
  boneWorld(i: number, out: THREE.Vector3) {
    return out.setFromMatrixPosition(this.bones[i].matrixWorld);
  }

  /**
   * Pose the skeleton. `pos` = ground point under the animal, `heading` = yaw (model +Z forward).
   * `full` = sample the terrain per foot (near LOD); otherwise feet use the body's ground plane.
   */
  update(dt: number, pos: THREE.Vector3, heading: number, terrain: Terrain, full: boolean) {
    const gp = this.gp;
    const bones = this.bones;
    const j = this.joints;
    const s = this.scale;
    this.t += dt;
    const mesh = this.mesh;
    mesh.position.copy(pos);
    mesh.rotation.set(0, heading, 0);

    // ------------------------------------------------ gait
    const spd = this.dead > 0 ? 0 : Math.max(0, this.speed) / s;
    const gTarget = gp.bound ? 2 : smooth(gp.walkMax * 0.85, gp.walkMax * 1.15, spd) + smooth(gp.trotMax * 0.85, gp.trotMax * 1.15, spd);
    this.gait = damp(this.gait, gTarget, 4, dt);
    const g = this.gait;
    const freq = gp.fMin + (gp.fMax - gp.fMin) * (1 - Math.exp(-spd / gp.fScale));
    const moving = smooth(0.05, 0.5, spd);
    this.phase = frac(this.phase + freq * dt * (0.25 + 0.75 * moving));
    const duty = gp.bound ? 0.3 : g < 1 ? 0.64 + (0.46 - 0.64) * g : 0.46 + (0.3 - 0.46) * (g - 1);
    const half = Math.min(gp.reach, (0.5 * spd * duty) / Math.max(freq, 0.1)) * moving;
    const bob = (g < 1 ? gp.bobWalk + (gp.bobTrot - gp.bobWalk) * g : gp.bobTrot + (gp.bobGallop - gp.bobTrot) * (g - 1)) * moving;

    // ------------------------------------------------ body height + pitch from terrain
    const cosH = Math.cos(heading),
      sinH = Math.sin(heading);
    const fz = j.chest.z * s,
      hz = j.pelvis.z * s;
    let hF = pos.y,
      hH = pos.y;
    if (full || this.dead > 0) {
      hF = terrain.heightAt(pos.x + sinH * fz, pos.z + cosH * fz);
      hH = terrain.heightAt(pos.x + sinH * hz, pos.z + cosH * hz);
    }
    const slopePitch = Math.atan2(hF - hH, fz - hz); // + = front higher
    this.bodyPitch = damp(this.bodyPitch, slopePitch, 10, dt);
    const groundMid = (hF + hH) * 0.5 - pos.y;

    const ph = this.phase * TAU;
    let yBob: number;
    if (gp.bound) {
      // Hop arc: airborne between the hind push-off and the front landing.
      const hopT = frac(this.phase - 0.08);
      yBob = (gp.hop ?? 0.1) * Math.max(0, Math.sin(Math.min(1, hopT / 0.62) * Math.PI)) * moving;
    } else if (g < 1.5) yBob = -Math.abs(Math.sin(ph * 2 * 0.5 + 0.4)) * bob + bob * 0.5;
    else yBob = Math.sin(ph + 1.2) * bob;
    const breathe = Math.sin(this.t * (1.6 + moving * 2)) * 0.004;
    const crouchY = -this.crouch * 0.16 * j.body.y;
    const standY = j.body.y + yBob + crouchY;
    this.bodyY = groundMid / s + standY + (this.lieHeight - standY) * this.dead + this.air / s;

    const body = bones[B.body];
    body.position.set(j.body.x, this.bodyY, j.body.z);
    const gallopRock = g > 1 ? Math.sin(ph + 0.4) * gp.flex * (g - 1) * moving : 0;
    const boundRock = gp.bound ? Math.sin(ph - 0.6) * 0.22 * moving : 0;
    const leapPitch = -this.leap * 0.28;
    body.rotation.set(-this.bodyPitch + gallopRock + boundRock + leapPitch - this.rear * 0.95, 0, -clamp(this.turn * spd * 0.02, -0.25, 0.25) + this.deadRoll);

    // Spine flex (gallop) and bend into turns.
    const flex = g > 1 ? Math.sin(ph) * gp.flex * 0.8 * (g - 1) * moving : 0;
    bones[B.chest].rotation.set(flex + this.crouch * 0.05, clamp(this.turn * 0.12, -0.3, 0.3), 0);
    bones[B.pelvis].rotation.set(-flex, clamp(-this.turn * 0.08, -0.2, 0.2), 0);
    bones[B.chest].scale.set(1 + breathe, 1 + breathe * 1.4, 1);

    // ------------------------------------------------ head / neck
    let yaw = 0,
      pitch = 0;
    if (this.lookTarget && this.dead === 0) {
      mesh.updateMatrixWorld(true);
      _v.copy(this.lookTarget);
      bones[B.chest].worldToLocal(_v);
      _v.sub(bones[B.neck].position);
      yaw = clamp(Math.atan2(_v.x, _v.z), -1.2, 1.2);
      pitch = clamp(Math.atan2(_v.y - (j.head.y - j.neck.y), Math.hypot(_v.x, _v.z)), -0.6, 0.7);
      if (Math.abs(Math.atan2(_v.x, _v.z)) > 2.2) yaw *= 0.5; // behind: don't break the neck
    }
    this.lookYaw = damp(this.lookYaw, yaw, 6, dt);
    this.lookPitch = damp(this.lookPitch, pitch, 6, dt);
    const neckDown = this.graze * gp.neckDown;
    const nod = this.graze * Math.sin(this.t * 5.3) * 0.05;
    bones[B.neck].rotation.set(neckDown - this.lookPitch * 0.4 - this.headUp * 0.45 + this.crouch * 0.35 - this.leap * 0.1 + this.dead * 0.3, this.lookYaw * 0.55, 0);
    bones[B.head].rotation.set(this.graze * gp.headDown + nod - this.lookPitch * 0.6 - this.headUp * 0.55 - this.crouch * 0.25, this.lookYaw * 0.45, 0);
    bones[B.jaw].rotation.set(this.jawOpen * 0.55, 0, 0);
    const twitch = this.earTwitch;
    bones[B.earL].rotation.set(-this.earsBack * 0.9 + twitch * 0.3, 0, -this.earsBack * 0.3);
    bones[B.earR].rotation.set(-this.earsBack * 0.9 - twitch * 0.2, 0, this.earsBack * 0.3);

    // ------------------------------------------------ tail
    const wag = Math.sin(this.t * (7 + this.tailWag * 5)) * (0.08 + this.tailWag * 0.4) + Math.sin(ph) * 0.1 * moving;
    const tailLift = this.tailUp * 0.7;
    bones[B.tail1].rotation.set(tailLift + (1 - this.dead) * Math.sin(ph * 2) * 0.05 * moving, wag * 0.5, 0);
    bones[B.tail2].rotation.set(tailLift * 0.4 + g * 0.12 * moving, wag * 0.7, 0);
    bones[B.tail3].rotation.set(tailLift * 0.2 + g * 0.1 * moving, wag, 0);

    mesh.updateMatrixWorld(true);

    // ------------------------------------------------ legs
    const offs = gp.bound ? BOUND : null;
    for (let l = 0; l < 4; l++) {
      const L = j.legs[l];
      const front = l < 2;
      const upper = bones[legBone(l, 0)],
        lower = bones[legBone(l, 1)],
        foot = bones[legBone(l, 2)];
      if (this.dead >= 1) {
        continue; // posed once by settleDead()
      }
      let off: number;
      if (offs) off = offs[l];
      else if (g < 1) off = circLerp(WALK[l], TROT[l], g);
      else off = circLerp(TROT[l], GALLOP[l], g - 1);
      const lp = frac(this.phase + off);
      let dz: number, lift: number, flexFoot: number;
      const stance = lp < duty;
      if (stance) {
        const u = lp / duty;
        dz = half * (1 - 2 * u);
        lift = 0;
        flexFoot = 0;
      } else {
        const u = (lp - duty) / (1 - duty);
        const e = u * u * (3 - 2 * u);
        dz = half * (-1 + 2 * e);
        const sw = Math.sin(u * Math.PI);
        lift = (front ? gp.liftF : gp.liftH) * sw * Math.min(1, moving * 1.5) * (1 + g * 0.35);
        flexFoot = sw * (front ? 0.9 : 0.5) * moving;
      }
      if (stance && !this.stanceLast[l] && this.onFootDown && moving > 0.3) {
        this.onFootDown(l, this.footWorld[l].x, this.footWorld[l].z);
      }
      this.stanceLast[l] = stance;

      // Leap / lunge: front legs reach forward, hind legs extend back.
      if (this.leap > 0) {
        dz += this.leap * (front ? 0.3 : -0.25) * j.body.y;
        lift += this.leap * (front ? 0.25 : 0.05) * j.body.y;
        flexFoot += this.leap * (front ? 0.6 : 0);
      }
      // Hare rearing: front paws tucked up against the chest.
      if (this.rear > 0 && front) {
        lift += this.rear * 0.12;
        dz -= this.rear * 0.03;
        flexFoot += this.rear * 1.2;
      }

      // Target in model space -> world.
      _v.set(L.foot.x, L.foot.y, L.foot.z + dz);
      _v.applyMatrix4(mesh.matrixWorld);
      const gy = full ? terrain.heightAt(_v.x, _v.z) : pos.y + (front ? hF - pos.y : hH - pos.y);
      _v.y = gy + (L.foot.y + lift) * s;
      this.footWorld[l].copy(_v);
      // World -> parent bone (chest / pelvis) space.
      const parent = upper.parent as THREE.Bone;
      parent.worldToLocal(_v);
      const hx = upper.position.y,
        hzp = upper.position.z;
      let vy = _v.y - hx,
        vz = _v.z - hzp;
      const L1 = this.L1[l],
        L2 = this.L2[l];
      let d = Math.hypot(vy, vz);
      const maxD = (L1 + L2) * 0.995,
        minD = Math.abs(L1 - L2) + 0.02 * (L1 + L2);
      if (d > maxD) {
        vy *= maxD / d;
        vz *= maxD / d;
        d = maxD;
      } else if (d < minD) {
        const k = minD / Math.max(d, 1e-5);
        vy *= k;
        vz *= k;
        d = minD;
      }
      const cosA = clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1);
      const A = Math.acos(cosA);
      const theta = ang(vz, vy);
      const phi1 = front ? theta + A : theta - A;
      const kz = hzp + Math.sin(phi1) * L1,
        ky = hx - Math.cos(phi1) * L1;
      const phi2 = ang(hzp + vz - kz, hx + vy - ky);
      const a1 = this.beta1[l] - phi1;
      const a2 = this.beta2[l] - phi2 - a1;
      upper.rotation.set(a1, 0, 0);
      lower.rotation.set(a2, 0, 0);
      // Keep the paw roughly level with the body, curl it during the swing.
      foot.rotation.set(-(a1 + a2) + flexFoot, 0, 0);
    }
  }

  /** Relaxed, splayed legs for a carcass (call when dead reaches 1). */
  poseDead(seed: number) {
    const b = this.bones;
    for (let l = 0; l < 4; l++) {
      const front = l < 2;
      const r = Math.sin(seed * 12.9898 + l * 78.233) * 0.5;
      b[legBone(l, 0)].rotation.set(front ? -0.55 + r * 0.3 : 0.7 + r * 0.3, 0, 0);
      b[legBone(l, 1)].rotation.set(front ? 0.4 + r * 0.2 : -0.35 + r * 0.2, 0, 0);
      b[legBone(l, 2)].rotation.set(0.3, 0, 0);
    }
    b[B.neck].rotation.set(0.25, 0.3 * Math.sign(this.deadRoll), 0);
    b[B.head].rotation.set(0.2, 0, 0);
    b[B.jaw].rotation.set(0.15, 0, 0);
    b[B.tail1].rotation.set(-0.2, 0, 0);
    b[B.tail2].rotation.set(0, 0, 0);
    b[B.tail3].rotation.set(0, 0, 0);
    b[B.chest].scale.set(1, 1, 1);
  }

  /** Blend all leg rotations toward limp (used during the death collapse). */
  relaxLegs(k: number, seed: number) {
    const b = this.bones;
    for (let l = 0; l < 4; l++) {
      const front = l < 2;
      const r = Math.sin(seed * 12.9898 + l * 78.233) * 0.5;
      const u = b[legBone(l, 0)],
        lo = b[legBone(l, 1)];
      u.rotation.x += ((front ? -0.55 + r * 0.3 : 0.7 + r * 0.3) - u.rotation.x) * k;
      lo.rotation.x += ((front ? 0.4 + r * 0.2 : -0.35 + r * 0.2) - lo.rotation.x) * k;
    }
  }

  dispose() {
    this.mesh.skeleton.dispose();
  }
}

function smooth(a: number, b: number, x: number) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

