// First-person body. Two parts:
//  - world space: skis (aligned to the snow and the ski heading), bindings, boots and legs, plus a
//    shadow-only torso/head so the player casts a whole-body shadow.
//  - camera space (on `viewmodel`): mittens, sleeves and poles on the public rightHand / leftHand anchors.
//    When looking down the arms stay roughly where the body is (pitch compensation) so the poles reach
//    the snow; with a tool equipped the hands stay framed for combat.
import * as THREE from 'three';
import type { GameContext } from '../core/types';
import { clamp, damp, dampAngle, lerp, smoothstep, TAU } from '../core/math';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { buildArm, buildPole, buildSkiAssembly, buildSkiGeometry, makeMaterials, PALETTE, type GearMaterials, type SkiAssembly } from './Gear';
import type { Locomotion } from './Locomotion';
import { SKI } from './tuning';
import { buildAvatar, snowCover, type AvatarArm, type TpPart } from './Avatar';
import { ITEMS } from '../core/Items';
import { buildProp, HELD_XFORM } from './props';

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

type ReachKind = 'take' | 'stow' | 'eat' | 'heal';
interface Reach {
  kind: ReachKind;
  t: number;
  dur: number;
  side: -1 | 1;
  from: string | null; // in hand at the start (goes into the pack)
  to: string | null; // comes out of the pack
}
interface ArmPose {
  sh: number;
  el: number;
  spread: number;
  wrist: number;
}
const ease = (x: number) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};

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
  private pelvis!: THREE.Mesh;
  private packLid!: THREE.Group;
  private lidOpen = 0;
  private gaiters: THREE.Mesh[] = [];
  private gaiterMat!: THREE.Material;
  /** Held things: weapon models registered by combat, plus simple props built on demand. */
  private held = new Map<string, THREE.Object3D>();
  private heldShown: [string | null, string | null] = [null, null]; // [left, right]
  private reach: Reach | null = null;
  private quietT = 2;
  private fpProp = new THREE.Group();
  private fpShown: string | null = null;
  private torsoMesh!: THREE.Mesh;
  private headMesh!: THREE.Mesh;
  private tpParts: TpPart[] = [];
  private pantsMat!: THREE.Material;
  private avArmL!: AvatarArm;
  private avArmR!: AvatarArm;
  private wArmL!: THREE.Group;
  private wArmR!: THREE.Group;
  private armSwing = 0;

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

    // ---- third-person avatar (jacket, hood, arms with poles, insulated pants). In first person
    // every part is shadow-only so the sun still casts a whole skier; setThirdPerson swaps them in.
    const av = buildAvatar(m);
    this.tpParts = av.parts;
    this.pantsMat = av.pantsMat;
    for (let i = 0; i < 2; i++) {
      const thigh = new THREE.Mesh(av.thighGeo, m.shadowOnly);
      const shin = new THREE.Mesh(av.shinGeo, m.shadowOnly);
      const knee = new THREE.Mesh(av.kneeGeo, m.shadowOnly);
      for (const o of [thigh, shin, knee]) {
        o.castShadow = true;
        o.frustumCulled = false;
      }
      this.world.add(thigh, shin, knee);
      this.legs.push({ thigh, shin, knee });
    }
    this.shadowProxy = new THREE.Group();
    const torso = av.torso;
    const head = av.head;
    this.shadowProxy.add(torso, head);
    this.world.add(this.shadowProxy);
    this.torsoMesh = torso;
    this.headMesh = head;
    this.wArmL = av.armL.pivot;
    this.wArmR = av.armR.pivot;
    this.avArmL = av.armL;
    this.avArmR = av.armR;

    this.pelvis = av.pelvis;
    this.shadowProxy.add(av.pelvis);
    this.packLid = av.packLid;
    this.gaiterMat = av.gaiterMat;
    for (const leg of this.legs) {
      const g = new THREE.Mesh(av.gaiterGeo, m.shadowOnly);
      g.castShadow = true;
      g.frustumCulled = false;
      leg.shin.add(g);
      this.gaiters.push(g);
    }
    this.fpProp.name = 'fpProp';
    viewmodel.add(this.fpProp);
    const ev = ctx.events;
    ev.on('equip:changed', ({ item }) => this.onEquip(item));
    ev.on('item:consumed', ({ item }) => this.startReach(ITEMS[item]?.kind === 'medical' ? 'heal' : 'eat', null, item));
    ev.on('item:changed', ({ item, delta }) => {
      if (delta > 0 && item !== 'log' && !ITEMS[item]?.equip) this.startReach('stow', item, null);
    });

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
    for (const t of this.tpParts) t.mesh.material = on ? t.mat : m.shadowOnly;
    for (const { thigh, shin, knee } of this.legs) {
      thigh.material = on ? this.pantsMat : m.shadowOnly;
      shin.material = on ? this.pantsMat : m.shadowOnly;
      knee.material = on ? this.pantsMat : m.shadowOnly;
    }
    for (const g of this.gaiters) g.material = on ? this.gaiterMat : m.shadowOnly;
    this.tp = on;
    this.torso.visible = !on && this.armsVis > 0.02;
  }

  reset() {
    const p = this.ctx.player;
    this.reach = null;
    this.quietT = 2;
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
    const { player: p, inventory, env } = this.ctx;
    this.idleT += dt;
    this.quietT = Math.max(0, this.quietT - dt);
    if (this.reach) {
      this.reach.t += dt;
      const ws = this.weaponState();
      if (this.reach.t >= this.reach.dur || (ws.act && this.reach.side === (HELD_XFORM[ws.shown ?? '']?.side ?? 1))) this.reach = null;
    }
    // Snow settles on the clothes while it falls, and melts off slowly otherwise.
    const want = env.snowfall > 0.05 ? 0.35 + 0.55 * env.snowfall : 0;
    snowCover.value = clamp(snowCover.value + (want - snowCover.value) * dt * (want > snowCover.value ? 1 / 60 : 1 / 240), 0, 1);
    this.updateFpProp();
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

    // Shadow proxy: torso over the hips, head at the eye. Shoulders/arms are children of torso
    // and follow it automatically; only their local swing needs setting here.
    const torso = this.torsoMesh;
    const head = this.headMesh;
    // Hang the jacket from the neck (collar top ~13 cm under the eye), not up from the hips.
    torso.position.set(0, Math.min(eye - 0.47, hipH + 0.34), 0).addScaledVector(_x, leanShift * 0.6).addScaledVector(_f, -back * 0.3 + loco.tuck * 0.2);
    torso.rotation.set(0, this.skiYaw, 0);
    torso.rotateX(-0.25 - loco.tuck * 0.9);
    head.position.set(0, eye - 0.05, 0).addScaledVector(_x, leanShift * 0.3);

    // Head turns with where you look (a little lag), tilts slightly with pitch.
    head.rotation.set(-p.pitch * 0.35, p.yaw, 0, 'YXZ');
    head.position.addScaledVector(_f, 0.02);

    // Pelvis bridges the jacket hem and the thighs.
    this.pelvis.position.set(0, hipH + 0.02, 0).addScaledVector(_x, leanShift).addScaledVector(_f, -back);
    this.pelvis.rotation.set(0, this.skiYaw, 0);

    // Arms: locomotion pose -> what the hand holds / is doing -> reaching into the pack on top.
    let swingTarget = 0;
    if (!onSkis) {
      const ph = (loco.stepIndex + loco.strideDist / Math.max(loco.strideLen, 0.1)) * Math.PI;
      swingTarget = Math.sin(ph) * smoothstep(0.2, 1.8, p.speed) * 0.55;
    }
    this.armSwing = damp(this.armSwing, swingTarget, 8, dt);
    const tuck = loco.tuck;
    const plantK = (t: number) => (t >= 0 && t < 0.45 ? Math.sin(Math.PI * (t / 0.45)) : 0);
    const ws = this.weaponState();
    const r = this.reach;
    let reachW = 0;
    let inPack = 0;
    for (const [arm, side] of [[this.avArmL, -1], [this.avArmR, 1]] as const) {
      const pose: ArmPose = { sh: 0, el: 0, spread: 0, wrist: 0 };
      let poleTilt = 0;
      let poleVis = false;
      if (onSkis) {
        const jab = plantK(side < 0 ? this.plantL.t : this.plantR.t) * 0.35;
        pose.sh = 0.45 + jab + tuck * 0.35;
        pose.el = 0.95 + tuck * 0.55;
        pose.spread = side * (0.2 - tuck * 0.12);
        // Keep the pole pointing down and back regardless of how far the arm reaches forward.
        poleTilt = -(pose.sh + pose.el) - 0.32 + jab * 0.6 - tuck * 0.6;
        poleVis = true;
      } else {
        pose.sh = 0.1 + this.armSwing * -side;
        pose.el = 0.25 + Math.abs(this.armSwing) * 0.35;
        pose.spread = side * 0.08;
      }
      // Tool / weapon in this hand (or the draw hand of the bow).
      const holding = this.holdPose(pose, side, ws);
      if (holding) poleVis = false;
      let steady: string | null = ws.shown && !ws.hidden && (HELD_XFORM[ws.shown]?.side ?? 1) === side ? ws.shown : null;
      // Pack reach.
      if (r && r.side === side) {
        const k = r.t / r.dur;
        const w = this.reachPose(pose, r, k, side);
        reachW = w;
        poleVis = false;
        if (r.kind === 'take') steady = k < 0.42 ? r.from : r.to;
        else if (r.kind === 'stow') steady = k < 0.47 ? r.from : null;
        else steady = k > 0.3 && k < 0.85 ? r.to : null;
        inPack = r.kind === 'stow' ? smoothstep(0.3, 0.45, k) * (1 - smoothstep(0.5, 0.62, k)) : smoothstep(0.2, 0.33, k) * (1 - smoothstep(0.42, 0.55, k));
      }
      arm.pivot.rotation.set(pose.sh, 0, pose.spread);
      arm.elbow.rotation.set(pose.el, 0, 0);
      arm.hand.rotation.set(pose.wrist, 0, 0);
      arm.pole.rotation.set(poleTilt, 0, 0);
      arm.pole.visible = poleVis;
      this.showHeld(side, this.tp ? steady : null);
    }
    // Lid lifts while a hand is in the pack; head glances back over that shoulder.
    this.lidOpen = damp(this.lidOpen, inPack > 0.01 ? 1 : 0, inPack > 0.01 ? 14 : 6, dt);
    this.packLid.rotation.x = this.lidOpen * 1.5;
    if (r) {
      head.rotation.y += r.side * -0.55 * reachW * (r.kind === 'eat' || r.kind === 'heal' ? 0 : 1);
      torso.rotation.y += r.side * 0.22 * reachW;
    }
  }

  // ------------------------------------------------------------------ held items & the pack
  /** Combat registers the third-person model of each tool; Body shows it in the right fist. */
  registerHeld(id: string, obj: THREE.Object3D) {
    const x = HELD_XFORM[id];
    if (x) {
      obj.position.set(...x.pos);
      obj.rotation.set(...x.rot);
    }
    obj.visible = false;
    obj.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.frustumCulled = false;
      }
    });
    const side = x?.side ?? 1;
    (side < 0 ? this.avArmL : this.avArmR).item.add(obj);
    this.held.set(`${side}:${id}`, obj);
  }

  private heldObj(side: -1 | 1, id: string): THREE.Object3D {
    const key = `${side}:${id}`;
    let o = this.held.get(key);
    if (!o) {
      // Tools registered on the other hand, or pack items: build a prop for this fist.
      o = buildProp(id);
      o.visible = false;
      (side < 0 ? this.avArmL : this.avArmR).item.add(o);
      this.held.set(key, o);
    }
    return o;
  }

  private showHeld(side: -1 | 1, id: string | null) {
    const i = side < 0 ? 0 : 1;
    if (this.heldShown[i] === id) return;
    if (this.heldShown[i]) this.heldObj(side, this.heldShown[i]!).visible = false;
    this.heldShown[i] = id;
    if (id) this.heldObj(side, id).visible = true;
  }

  private weaponState(): { shown: string | null; act: string | null; phase: number; aim: number; draw: number; hidden: boolean } {
    const w = (this.ctx.sys as unknown as { weapons?: { tpState?: () => ReturnType<Body['weaponState']> } }).weapons;
    return w?.tpState?.() ?? { shown: null, act: null, phase: 0, aim: 0, draw: 0, hidden: false };
  }

  /** Overrides `pose` for a hand holding a tool. Returns true if this hand is busy with it. */
  private holdPose(pose: ArmPose, side: -1 | 1, ws: ReturnType<Body['weaponState']>): boolean {
    const w = ws.shown;
    if (!w) return false;
    const bow = w === 'bow';
    const toolSide = HELD_XFORM[w]?.side ?? 1;
    if (bow && side > 0) {
      // Draw hand: pulls the string back to the cheek.
      const d = ws.draw;
      if (d < 0.02) return false;
      pose.sh = lerp(pose.sh, 1.45, smoothstep(0, 0.2, d));
      pose.el = lerp(pose.el, 0.3 + d * 1.9, smoothstep(0, 0.2, d));
      pose.spread = side * (0.1 + d * 0.45);
      return true;
    }
    if (side !== toolSide) return false;
    const walkSwing = this.armSwing * -side * 0.25;
    if (w === 'hatchet' || w === 'torch') {
      const torch = w === 'torch';
      pose.sh = (torch ? 0.7 : 0.3) + walkSwing;
      pose.el = torch ? 0.8 : 1.0;
      pose.spread = side * (torch ? 0.22 : 0.12);
      pose.wrist = 0;
      if (ws.act === 'swing' || ws.act === 'tswing') {
        const k = ws.phase;
        // wind up over the shoulder, chop down through the target, recover
        const up = ease(k / 0.3);
        const down = ease((k - 0.3) / 0.15);
        const back = ease((k - 0.45) / 0.55);
        pose.sh = lerp(lerp(lerp(pose.sh, 2.7, up), 0.45, down), pose.sh, back);
        pose.el = lerp(lerp(lerp(pose.el, 1.7, up), 0.25, down), pose.el, back);
        pose.spread = side * lerp(0.12, 0.3, up * (1 - down));
      } else if (ws.act === 'recoil') {
        const k = Math.sin(Math.PI * clamp(ws.phase, 0, 1));
        pose.sh += k * 0.8;
        pose.el += k * 0.5;
      }
      return true;
    }
    if (w === 'spear') {
      // carried upright; aiming lifts it overhand, point forward; jab thrusts at the hip.
      pose.sh = 0.25 + walkSwing;
      pose.el = 1.1;
      pose.spread = side * 0.14;
      pose.wrist = 0;
      const a = ease(ws.aim);
      if (a > 0) {
        pose.sh = lerp(pose.sh, 2.75, a);
        pose.el = lerp(pose.el, 0.7, a);
        pose.spread = side * lerp(0.14, 0.3, a);
        pose.wrist = lerp(0, 0.05 - 3.45, a);
      }
      if (ws.act === 'jab') {
        const k = ws.phase < 0.3 ? ease(ws.phase / 0.3) : 1 - ease((ws.phase - 0.3) / 0.7);
        pose.sh = lerp(pose.sh, 1.25, k);
        pose.el = lerp(pose.el, 0.25, k);
        pose.wrist = lerp(pose.wrist, -1.5, k);
      } else if (ws.act === 'throw') {
        const k = ease(ws.phase / 0.35);
        pose.sh = lerp(2.75, 0.9, k);
        pose.el = lerp(0.7, 0.2, k);
        pose.wrist = 0.05 - pose.sh - pose.el;
      }
      return true;
    }
    if (bow) {
      const d = Math.max(ws.draw, ws.aim);
      pose.sh = lerp(0.35 + walkSwing, 1.5, ease(d * 4));
      pose.el = lerp(0.35, 0.05, ease(d * 4));
      pose.spread = side * lerp(0.1, -0.08, ease(d * 4));
      pose.wrist = 0;
      return true;
    }
    return false;
  }

  /** Blend `pose` toward the pack (over the shoulder) and, for food, the mouth. Returns reach weight. */
  private reachPose(pose: ArmPose, r: Reach, k: number, side: -1 | 1): number {
    const PACK: ArmPose = { sh: 2.55, el: 2.05, spread: side * 0.5, wrist: 0 };
    const MOUTH: ArmPose = { sh: 1.2, el: 2.3, spread: side * -0.32, wrist: 0 };
    const WRAP: ArmPose = { sh: 0.95, el: 1.5, spread: side * -0.4, wrist: 0 };
    const mix = (a: ArmPose, b: ArmPose, t: number) => {
      a.sh = lerp(a.sh, b.sh, t);
      a.el = lerp(a.el, b.el, t);
      a.spread = lerp(a.spread, b.spread, t);
      a.wrist = lerp(a.wrist, b.wrist, t);
    };
    let w = 0;
    if (r.kind === 'take') {
      w = k < 0.35 ? ease(k / 0.35) : k < 0.47 ? 1 : 1 - ease((k - 0.47) / 0.53);
      mix(pose, PACK, w);
    } else if (r.kind === 'stow') {
      // bring it up in front, then over the shoulder into the pack
      const show = ease(k / 0.15) * (1 - ease((k - 0.2) / 0.15));
      mix(pose, { sh: 0.7, el: 1.0, spread: side * 0.1, wrist: 0 }, show);
      w = k < 0.2 ? 0 : k < 0.45 ? ease((k - 0.2) / 0.25) : k < 0.55 ? 1 : 1 - ease((k - 0.55) / 0.45);
      mix(pose, PACK, w);
    } else {
      // eat / bandage: out of the pack, to the mouth (or the other arm), chew/wrap, back
      w = k < 0.2 ? ease(k / 0.2) : k < 0.3 ? 1 : 1 - ease((k - 0.3) / 0.15);
      mix(pose, PACK, w);
      const tgt = r.kind === 'eat' ? MOUTH : WRAP;
      const u = k < 0.3 ? 0 : k < 0.45 ? ease((k - 0.3) / 0.15) : k < 0.85 ? 1 : 1 - ease((k - 0.85) / 0.15);
      mix(pose, tgt, u);
      if (u > 0.9) {
        const tt = this.idleT;
        if (r.kind === 'eat') pose.el += Math.sin(tt * 13) * 0.07;
        else pose.spread += Math.sin(tt * 9) * 0.12 * side;
      }
      w = Math.max(w, u);
    }
    return w;
  }

  private onEquip(item: string | null) {
    const prev = this.heldShown[1] ?? this.heldShown[0];
    const to = item && ITEMS[item as keyof typeof ITEMS]?.equip ? item : null;
    if (to) this.startReach('take', prev, to);
    else if (prev) this.startReach('stow', prev, null);
  }

  private startReach(kind: ReachKind, from: string | null, to: string | null) {
    if (this.quietT > 0 || this.ctx.game.state !== 'playing') return;
    const p = this.ctx.player;
    if (p.mode === 'crashed' || p.mode === 'dead') return;
    if (this.reach && kind === 'stow' && this.reach.kind !== 'stow') return; // don't interrupt eating
    const ws = this.weaponState();
    const tool = ws.shown ? (HELD_XFORM[ws.shown]?.side ?? 1) : 0;
    let side: -1 | 1;
    const id = to ?? from;
    if (kind === 'take' || (kind === 'stow' && from && HELD_XFORM[from])) side = (id && HELD_XFORM[id]?.side) || 1;
    else side = tool > 0 ? -1 : 1; // the free hand
    const dur = kind === 'eat' || kind === 'heal' ? 2.4 : kind === 'take' ? 1.0 : 1.05;
    this.reach = { kind, t: 0, dur, side, from, to };
  }

  /** First person: show what you eat / put away in front of the camera. */
  private updateFpProp() {
    const r = this.reach;
    let id: string | null = null;
    const o = this.fpProp;
    if (r && !this.tp) {
      const k = r.t / r.dur;
      if ((r.kind === 'eat' || r.kind === 'heal') && k > 0.22 && k < 0.9) {
        id = r.to;
        const up = ease((k - 0.22) / 0.2);
        const down = ease((k - 0.8) / 0.1);
        o.position.set(lerp(0.22, 0.05, up), lerp(-0.55, -0.2, up) - down * 0.4, lerp(-0.45, -0.32, up));
        o.rotation.set(-0.9 + up * 0.5, 0.4 - up * 0.3, 0.2);
        const bite = r.kind === 'eat' ? 1 - 0.35 * smoothstep(0.45, 0.8, k) : 1;
        o.scale.setScalar(bite);
        if (r.kind === 'eat' && k > 0.45) o.position.y += Math.sin(this.idleT * 13) * 0.008;
      } else if (r.kind === 'stow' && r.from && k < 0.45) {
        id = r.from;
        const go = ease((k - 0.12) / 0.33);
        const come = ease(k / 0.12);
        o.position.set(lerp(0.14, 0.4, go), lerp(-0.55, -0.24, come) - go * 0.45, lerp(-0.42, -0.25, go));
        o.rotation.set(-1.1, 0.5, 0.2 + go * 0.8);
        o.scale.setScalar(1);
      }
    }
    if (id !== this.fpShown) {
      for (const c of o.children) c.visible = false;
      this.fpShown = id;
      if (id) {
        let c = o.getObjectByName('prop-' + id);
        if (!c) {
          c = buildProp(id);
          c.traverse((m) => {
            if ((m as THREE.Mesh).isMesh) {
              m.castShadow = false;
              m.frustumCulled = false;
            }
          });
          o.add(c);
        }
        c.visible = true;
      }
    }
    o.visible = id !== null;
  }

  /** Two-bone leg from hip to ankle, knee bending toward `fwd`. */
  private solveLeg(leg: { thigh: THREE.Mesh; shin: THREE.Mesh; knee: THREE.Mesh }, hip: THREE.Vector3, ankle: THREE.Vector3, fwd: THREE.Vector3) {
    // Ankle sits at the boot cuff, so the chain from hip to cuff is shorter than a full leg.
    const L1 = 0.43,
      L2 = 0.2;
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
