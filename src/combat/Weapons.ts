// Weapons: hatchet, spear, bow and torch. Viewmodels ride on the player's hand anchors
// (ctx.sys.player.rightHand / leftHand): swings translate the whole arm (hand offset added after
// the player module poses it) while the weapon rotates in the fist. Hits are resolved with camera
// raycasts at the hit frame (with sweep tolerance), with hit-stop, view kick, particles and sound.
import * as THREE from 'three';
import type { GameContext, GameState, LoopHandle, System } from '../core/types';
import type { ItemId } from '../core/Items';
import { Layer, type RayHit } from '../core/Physics';
import { clamp, damp, lerp, smoothstep } from '../core/math';
import type { LightHandle } from '../atmosphere/Sky';
import { Effects } from './Effects';
import { Projectiles } from './Projectiles';
import { TorchFlame } from './TorchFlame';
import { buildArrow, buildBow, buildHatchet, buildSpear, buildTorch, createWeaponMaterials, type BowRig, type TorchModel, type WeaponMaterials } from './models';
import { Animal } from '../wildlife/Animal';

type WKind = 'hatchet' | 'spear' | 'bow' | 'torch';
const WEAPONS: WKind[] = ['hatchet', 'spear', 'bow', 'torch'];
const isWeapon = (i: ItemId | null): i is WKind => i !== null && (WEAPONS as string[]).includes(i);

export const TORCH_HOURS = 6;

/** A pose key: time, hand offset (x,y,z), weapon rotation offset (x,y,z), hand roll, ease of the segment leading here. */
type Key = [number, number, number, number, number, number, number, number, Ease?];
type Ease = 'in' | 'out' | 'inout' | 'lin';

// Hatchet chop: anticipation (raise back) -> fast arc -> follow-through -> recover.
// Authored from target haft/blade directions in camera space: windup over the right shoulder,
// contact with the head just below the crosshair (edge leading down), follow-through low left.
const K_SWING: Key[] = [
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0.17, 0.08, 0.18, 0.08, 0.83, -0.15, -0.14, -0.1, 'out'],
  [0.25, -0.16, 0.04, -0.12, -0.61, -0.58, -0.12, 0.15, 'in'],
  [0.36, -0.23, -0.08, -0.05, -1.29, -0.75, 0.1, 0.25, 'out'],
  [0.66, 0, 0, 0, 0, 0, 0, 0, 'inout'],
];
// Blade bites and is yanked back out.
const K_RECOIL: Key[] = [
  [0, -0.16, 0.04, -0.12, -0.61, -0.58, -0.12, 0.15],
  [0.07, -0.14, 0.05, -0.1, -0.52, -0.55, -0.11, 0.13, 'out'],
  [0.18, -0.08, 0.06, -0.06, -0.3, -0.35, -0.07, 0.06, 'inout'],
  [0.44, 0, 0, 0, 0, 0, 0, 0, 'inout'],
];
const K_TSWING: Key[] = [
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0.14, 0.07, 0.12, 0.06, 0.6, -0.1, -0.1, -0.08, 'out'],
  [0.22, -0.15, 0.03, -0.11, -0.55, -0.4, -0.1, 0.12, 'in'],
  [0.32, -0.21, -0.07, -0.05, -1.1, -0.5, 0.08, 0.2, 'out'],
  [0.56, 0, 0, 0, 0, 0, 0, 0, 'inout'],
];
const K_JAB: Key[] = [
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0.09, 0.01, 0.015, 0.11, 0.03, 0, 0, 0, 'out'],
  [0.16, -0.05, 0.03, -0.4, -0.03, 0.05, 0, 0, 'in'],
  [0.25, -0.05, 0.03, -0.38, -0.03, 0.05, 0, 0, 'lin'],
  [0.5, 0, 0, 0, 0, 0, 0, 0, 'inout'],
];
const K_THROW: Key[] = [
  [0, -0.02, 0.26, 0.28, 0, 0, 0, 0],
  [0.08, -0.06, 0.2, -0.3, 0, 0, 0, 0, 'in'],
  [0.36, -0.02, -0.25, 0, 0, 0, 0, 0, 'out'],
];

interface Act {
  kind: 'swing' | 'recoil' | 'tswing' | 'jab' | 'throw';
  keys: Key[];
  t: number;
  dur: number;
  hitAt: number;
  hitDone: boolean;
  sound: number;
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _pose = new Float32Array(7);
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _qc = new THREE.Quaternion();
const _eu = new THREE.Euler();
const _fwd = new THREE.Vector3(0, 0, -1);
const _fwdN = new THREE.Vector3(0, 0, -1);

function ease(e: Ease | undefined, t: number) {
  switch (e) {
    case 'in':
      return t * t * t;
    case 'out':
      return 1 - (1 - t) * (1 - t);
    case 'lin':
      return t;
    default:
      return t * t * (3 - 2 * t);
  }
}

function samplePose(keys: Key[], t: number, out: Float32Array) {
  let i = 1;
  while (i < keys.length - 1 && t > keys[i][0]) i++;
  const a = keys[i - 1],
    b = keys[i];
  const u = clamp((t - a[0]) / Math.max(1e-4, b[0] - a[0]), 0, 1);
  const k = ease(b[8], u);
  for (let j = 0; j < 7; j++) {
    const va = a[j + 1] as number,
      vb = b[j + 1] as number;
    out[j] = va + (vb - va) * k;
  }
  return out;
}

export interface HitResult {
  material: 'wood' | 'stone' | 'flesh' | 'snow' | 'ice' | 'none';
  animal: Animal | null;
  killed: boolean;
}

export class Weapons implements System {
  readonly name = 'weapons';
  readonly updateWhen: GameState[] = ['playing', 'dead'];
  readonly effects: Effects;
  readonly projectiles: Projectiles;

  /** Wolves read these. */
  torchLit = false;
  readonly torchPosition = new THREE.Vector3();
  torchLight: THREE.PointLight | null = null;
  /** In-game hours left on the current torch. */
  torchHours = TORCH_HOURS;

  private M!: WeaponMaterials;
  private hatchet!: THREE.Group;
  private spear!: THREE.Group;
  private bow!: BowRig;
  private torch!: TorchModel;
  private flame!: TorchFlame;
  private arrowProto!: THREE.Group;
  private spearProto!: THREE.Group;
  /** Per-weapon holder (child of a hand anchor): rest pose + in-fist rotation. */
  private holders = {} as Record<WKind, THREE.Group>;
  private handR: THREE.Object3D | null = null;
  private handL: THREE.Object3D | null = null;

  // ---- state
  private shown: WKind | null = null;
  private equipK = 0;
  private act: Act | null = null;
  private queued = false;
  private hitStop = 0;
  private draw = 0;
  private drawing = false;
  private fullT = 0;
  private nockT = 1;
  private stringVib = 0;
  private stringVibV = 0;
  private aimK = 0;
  private charge = 0;
  private charging = false;
  private thrownHide = false;
  private lastNoArrows = -9;
  private recoilZ = 0;
  private recoilV = 0;
  private swayT = 0;
  private inertia = new THREE.Vector2();
  private prevYaw = 0;
  private prevPitch = 0;
  private handOffR = new THREE.Vector3();
  private handOffL = new THREE.Vector3();
  private handRotR = new THREE.Euler(0, 0, 0, 'YXZ');
  private handRotL = new THREE.Euler(0, 0, 0, 'YXZ');
  private lightHandle: LightHandle | null = null;
  private torchLoop: LoopHandle | null = null;
  private torchOn = 0;
  // FOV zoom (cooperates with the player's camera rig, which also writes camera.fov).
  private fovScale = 1;
  private fovBase = 0;
  private fovWritten = -1;
  /** Dev: freeze the current action at a given time (for screenshots). */
  private debugT: number | null = null;
  /** Dev: live-tunable pose tables (mutate from the console, no reload needed). */
  readonly dev = { K_SWING, K_RECOIL, K_TSWING, K_JAB, K_THROW, REST: null as unknown as typeof REST };

  constructor(private ctx: GameContext) {
    this.dev.REST = REST;
    this.effects = new Effects(ctx);
    this.projectiles = new Projectiles(ctx, this);
  }

  // ------------------------------------------------------------------ setup
  init() {
    const ctx = this.ctx;
    this.M = createWeaponMaterials();
    this.effects.init();
    this.projectiles.init();
    this.hatchet = buildHatchet(this.M);
    this.spear = buildSpear(this.M);
    this.bow = buildBow(this.M);
    this.torch = buildTorch(this.M);
    this.flame = new TorchFlame();
    this.torch.flameAnchor.add(this.flame.group);
    this.arrowProto = buildArrow(this.M);
    this.spearProto = buildSpear(this.M);

    const pl = ctx.sys.player as unknown as { rightHand?: THREE.Object3D; leftHand?: THREE.Object3D; viewmodel?: THREE.Object3D };
    this.handR = pl?.rightHand ?? null;
    this.handL = pl?.leftHand ?? null;
    if (!this.handR || !this.handL) {
      // Fallback: our own anchors on the camera.
      const r = new THREE.Group(),
        l = new THREE.Group();
      r.position.set(0.28, -0.3, -0.5);
      l.position.set(-0.28, -0.3, -0.5);
      ctx.camera.add(r, l);
      this.handR = this.handR ?? r;
      this.handL = this.handL ?? l;
    }
    const mk = (k: WKind, model: THREE.Object3D, hand: THREE.Object3D) => {
      const h = new THREE.Group();
      h.name = 'vm-' + k;
      h.add(model);
      h.visible = false;
      hand.add(h);
      this.holders[k] = h;
    };
    // Spear: grip ~0.75 m behind the tip; model points +Z, turn it to face forward (-Z).
    this.spear.position.set(0, 0, 0.75);
    mk('hatchet', this.hatchet, this.handR);
    mk('spear', this.spear, this.handR);
    mk('torch', this.torch.root, this.handR);
    this.bow.root.scale.setScalar(0.86);
    mk('bow', this.bow.root, this.handL);
    for (const k of WEAPONS) {
      this.holders[k].traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.castShadow = false;
          m.receiveShadow = false;
          m.frustumCulled = false;
        }
      });
    }

    ctx.events.on('equip:changed', () => {
      // A new selection cancels whatever the old weapon was doing.
      this.cancelActions();
    });
    ctx.events.on('newGame', () => this.reset());
    ctx.events.on('player:died', () => this.cancelActions());
    this.prevYaw = ctx.player.yaw;
    this.prevPitch = ctx.player.pitch;
  }

  reset() {
    this.cancelActions();
    this.effects.reset();
    this.projectiles.reset();
    this.torchHours = TORCH_HOURS;
    this.shown = null;
    this.equipK = 0;
    for (const k of WEAPONS) if (this.holders[k]) this.holders[k].visible = false;
    this.setTorch(false);
  }

  private cancelActions() {
    this.act = null;
    this.queued = false;
    this.drawing = false;
    this.charging = false;
    this.charge = 0;
    this.hitStop = 0;
  }

  // ------------------------------------------------------------------ models for projectiles
  makeArrowModel(): THREE.Object3D {
    return this.arrowProto.clone();
  }
  makeSpearModel(): THREE.Object3D {
    const s = this.spearProto.clone();
    s.traverse((o) => ((o as THREE.Mesh).isMesh ? ((o as THREE.Mesh).castShadow = true) : null));
    return s;
  }

  // ------------------------------------------------------------------ update
  update(dt: number) {
    const ctx = this.ctx;
    const p = ctx.player;
    this.effects.update(dt);
    this.projectiles.update(dt);
    if (!this.handR || !this.handL) return;

    const inv = ctx.inventory;
    const want: WKind | null = p.alive && isWeapon(inv.equipped) ? inv.equipped : null;
    const busy = (this.shown === 'spear' && (this.charging || (this.act?.kind === 'throw' && this.act.t < 0.1))) || false;

    // ---- equip / unequip: lower the old tool, swap, raise the new one.
    if (this.shown !== want && !busy) {
      if (this.thrownHide || this.shown === null) this.equipK = 0;
      this.equipK = Math.max(0, this.equipK - dt / 0.17);
      if (this.equipK <= 0) {
        if (this.shown) this.holders[this.shown].visible = false;
        this.shown = want;
        this.thrownHide = false;
        this.cancelActions();
        this.draw = 0;
        this.aimK = 0;
        if (want) {
          this.holders[want].visible = true;
          ctx.audio.play('equip', { volume: 0.6 });
          if (want === 'bow') this.nockT = 1;
        }
      }
    } else if (this.shown) {
      this.equipK = Math.min(1, this.equipK + dt / 0.32);
    }
    this.setTorch(this.shown === 'torch' && this.equipK > 0.3 && p.alive);

    // ---- input
    const canAct = this.shown !== null && this.equipK > 0.85 && p.alive && !ctx.ui.blocking && p.mode !== 'crashed' && p.mode !== 'dead' && !(ctx.sys.building as unknown as { placing?: unknown })?.placing;
    this.handleInput(dt, canAct);

    // ---- run actions
    this.stepAction(dt);

    // ---- string vibration + recoil springs
    this.stringVibV += (-900 * this.stringVib - 18 * this.stringVibV) * dt;
    this.stringVib += this.stringVibV * dt;
    this.recoilV += (-260 * this.recoilZ - 22 * this.recoilV) * dt;
    this.recoilZ += this.recoilV * dt;

    this.pose(dt);
    this.updateTorch(dt);
  }

  lateUpdate() {
    // FOV zoom while aiming. The camera rig writes camera.fov when it wants a new base;
    // we detect that and re-apply our scale on top.
    const cam = this.ctx.camera;
    if (Math.abs(cam.fov - this.fovWritten) > 1e-3) this.fovBase = cam.fov;
    const want = this.fovBase * this.fovScale;
    if (Math.abs(cam.fov - want) > 1e-3) {
      cam.fov = want;
      cam.updateProjectionMatrix();
    }
    this.fovWritten = cam.fov;
  }

  // ------------------------------------------------------------------ input
  private handleInput(dt: number, canAct: boolean) {
    const ctx = this.ctx;
    const inp = ctx.input;
    const w = this.shown;
    const attackP = canAct && inp.pressed('attack');
    const attackD = canAct && inp.down('attack');
    const attackR = inp.released('attack');
    const aimD = canAct && inp.down('aim');
    let fov = 1;
    if (this.freezeDebug) {
      // Frozen dev pose: keep the aim zoom, ignore input.
      if (w === 'bow') fov = 1 - 0.15 * smoothstep(0, 1, this.draw);
      if (w === 'spear') fov = 1 - 0.06 * this.charge;
      this.fovScale = fov;
      return;
    }

    switch (w) {
      case 'hatchet':
      case 'torch': {
        if (attackP || (attackD && !this.act)) {
          if (!this.act) this.startSwing(w);
          else if (this.act.t > this.act.dur * 0.55) this.queued = true;
        }
        break;
      }
      case 'spear': {
        this.aimK = damp(this.aimK, aimD || this.charging ? 1 : 0, 10, dt);
        if (this.aimK > 0.6 && attackP && !this.act) {
          this.charging = true;
          this.charge = 0;
          ctx.audio.play('spear_swing', { volume: 0.35, pitch: 0.7 });
        }
        if (this.charging) {
          this.charge = Math.min(1, this.charge + dt / 0.55);
          fov = 1 - 0.06 * this.charge;
          if (attackR || !canAct) this.throwSpear();
        } else if (attackP && this.aimK < 0.3 && !this.act) {
          this.act = { kind: 'jab', keys: K_JAB, t: 0, dur: 0.5, hitAt: 0.15, hitDone: false, sound: 0.07 };
        }
        if (this.aimK > 0.5 && !this.charging) fov = 1 - 0.03 * this.aimK;
        break;
      }
      case 'bow': {
        const arrows = ctx.inventory.count('arrow');
        if (attackP && !this.drawing) {
          if (arrows <= 0) {
            if (ctx.time - this.lastNoArrows > 1.2) {
              ctx.audio.play('ui_error');
              ctx.ui.toast('No arrows', 'warn');
              this.lastNoArrows = ctx.time;
            }
          } else if (this.nockT >= 1) {
            this.drawing = true;
            this.fullT = 0;
            ctx.audio.play('bow_draw', { volume: 0.8 });
          }
        }
        if (this.drawing) {
          this.draw = Math.min(1, this.draw + dt / 0.7);
          if (this.draw >= 1) this.fullT += dt;
          if (aimD && inp.pressed('aim')) {
            // Let down without shooting.
            this.drawing = false;
          } else if (attackR || !attackD) {
            this.drawing = false;
            if (this.draw > 0.15 && canAct) this.fireArrow();
          }
        }
        if (!this.drawing) this.draw = Math.max(0, this.draw - dt / (this.stringVib !== 0 ? 0.04 : 0.25));
        fov = 1 - 0.15 * smoothstep(0, 1, this.draw);
        if (this.nockT < 1) this.nockT = Math.min(1, this.nockT + dt / 0.45);
        break;
      }
      default:
        break;
    }
    this.fovScale = damp(this.fovScale, fov, 12, dt);
    if (Math.abs(this.fovScale - 1) < 1e-4) this.fovScale = 1;
  }

  private startSwing(w: 'hatchet' | 'torch') {
    this.act =
      w === 'hatchet'
        ? { kind: 'swing', keys: K_SWING, t: 0, dur: 0.66, hitAt: 0.235, hitDone: false, sound: 0.15 }
        : { kind: 'tswing', keys: K_TSWING, t: 0, dur: 0.56, hitAt: 0.21, hitDone: false, sound: 0.12 };
    this.queued = false;
  }

  private stepAction(dt: number) {
    const a = this.act;
    if (!a) return;
    if (this.hitStop > 0) {
      this.hitStop -= dt;
      return;
    }
    if (this.debugT !== null) {
      a.t = this.debugT;
    } else {
      const prev = a.t;
      a.t += dt;
      if (a.sound >= 0 && prev < a.sound && a.t >= a.sound) {
        const id = a.kind === 'swing' ? 'axe_swing' : a.kind === 'tswing' ? 'torch_swing' : 'spear_swing';
        this.ctx.audio.play(id, { volume: 0.8, pitchVar: 0.08 });
      }
    }
    if (!a.hitDone && a.t >= a.hitAt && (a.kind === 'swing' || a.kind === 'tswing' || a.kind === 'jab')) {
      a.hitDone = true;
      this.meleeHit(a);
    }
    if (a.t >= a.dur && this.debugT === null) {
      this.act = null;
      if (this.queued && (this.shown === 'hatchet' || this.shown === 'torch')) this.startSwing(this.shown);
    }
  }

  // ------------------------------------------------------------------ melee
  private meleeHit(a: Act) {
    const ctx = this.ctx;
    const tool: ItemId = this.shown ?? 'hatchet';
    const reach = a.kind === 'jab' ? 2.9 : a.kind === 'tswing' ? 2.2 : 2.4;
    const hit = this.meleeTrace(reach);
    if (!hit) return;
    ctx.camera.getWorldDirection(_d);
    const damage = a.kind === 'jab' ? 30 : a.kind === 'tswing' ? 8 : 34;
    const res = this.resolveHit(hit, _d, tool, damage, a.kind === 'tswing' ? 'torch' : 'melee');
    const pl = ctx.sys.player as unknown as { shake?: (x: number) => void; kick?: (p: number, r?: number) => void };
    if (res.material === 'none') return;
    const hard = res.material === 'wood' || res.material === 'stone' || res.material === 'ice';
    this.hitStop = res.material === 'flesh' ? 0.06 : hard ? 0.055 : 0.03;
    pl.kick?.(res.material === 'snow' ? -0.006 : -0.014, (Math.random() - 0.5) * 0.02);
    pl.shake?.(res.material === 'stone' ? 0.14 : 0.08);
    this.recoilV += hard ? 1.6 : 0.8;
    // A chop that bites wood / glances off stone bounces back instead of following through.
    if (hard && a.kind === 'swing') this.act = { kind: 'recoil', keys: K_RECOIL, t: 0, dur: 0.44, hitAt: 99, hitDone: true, sound: -1 };
  }

  /** Camera ray with a little aim assist for creatures and a sweep for near misses. */
  private meleeTrace(reach: number): RayHit | null {
    const ctx = this.ctx;
    const cam = ctx.camera;
    cam.getWorldPosition(_o);
    cam.getWorldDirection(_d);
    const ray = ctx.physics.raycast(_o, _d, reach, { mask: Layer.HITTABLE });
    // Creatures: forgiving cone.
    let best: RayHit | null = null;
    _v.copy(_o).addScaledVector(_d, reach * 0.55);
    const ents = ctx.physics.overlapSphere(_v, reach * 0.6 + 0.3, Layer.ENTITY);
    for (const c of ents) {
      if (!(c.owner instanceof Animal) || !c.owner.alive) continue;
      _w.copy(c.position).sub(_o);
      const t = _w.dot(_d);
      if (t < 0.2 || t > reach + c.radius) continue;
      const perp = Math.sqrt(Math.max(0, _w.lengthSq() - t * t));
      if (perp > c.radius + 0.4) continue;
      const dist = Math.max(0.2, t - c.radius * 0.6);
      if (best && dist >= best.distance) continue;
      const point = _o.clone().addScaledVector(_d, dist);
      point.lerp(c.position, 0.35);
      best = { kind: 'collider', distance: dist, point, normal: _w.clone().negate().normalize(), index: -1, collider: c };
    }
    if (best) {
      // Something solid in between wins.
      if (ray && ray.kind !== 'collider' && ray.distance < best.distance - 0.15) return ray;
      return best;
    }
    if (ray) return ray;
    // Sweep: a few rays around the crosshair.
    const offs: [number, number][] = [
      [0.07, 0],
      [-0.07, 0],
      [0, -0.06],
      [0.05, -0.05],
      [-0.05, -0.05],
    ];
    for (const [yaw, pitch] of offs) {
      _w.copy(_d);
      _w.applyAxisAngle(_v.set(0, 1, 0), yaw);
      const right = _v.crossVectors(_w, cam.up).normalize();
      _w.applyAxisAngle(right, pitch);
      const h = ctx.physics.raycast(_o, _w, reach * 0.95, { mask: Layer.HITTABLE });
      if (h) return h;
    }
    return null;
  }

  /** Shared impact handling for melee and projectiles. */
  resolveHit(hit: RayHit, dir: THREE.Vector3, tool: ItemId, damage: number, source: 'melee' | 'torch' | 'arrow' | 'spear'): HitResult {
    const ctx = this.ctx;
    const fx = this.effects;
    const point = hit.point;
    const n = hit.normal;
    const res: HitResult = { material: 'none', animal: null, killed: false };
    const wl = ctx.sys.wildlife as unknown as { hear?: (p: THREE.Vector3, l: number) => void };
    const melee = source === 'melee' || source === 'torch';
    switch (hit.kind) {
      case 'tree': {
        res.material = 'wood';
        if (melee || source === 'spear') {
          ctx.events.emit('tree:hit', { id: hit.index, point: point.clone(), damage: source === 'melee' ? damage * (25 / 34) : source === 'spear' ? 4 : 2, tool });
        }
        fx.woodChips(point, n, dir, source === 'melee' ? 0.5 : source === 'arrow' ? 0.35 : 0.6);
        ctx.audio.play(source === 'arrow' ? 'arrow_hit_wood' : source === 'spear' ? 'spear_hit' : 'axe_hit_wood', { position: point, pitchVar: 0.1 });
        break;
      }
      case 'rock': {
        res.material = 'stone';
        if (melee) ctx.events.emit('rock:hit', { id: hit.index, point: point.clone(), damage, tool });
        fx.sparksAt(point, n, source === 'torch' ? 0.3 : 1);
        fx.stoneChips(point, n, melee ? 1 : 0.4);
        ctx.audio.play('axe_hit_stone', { position: point, pitchVar: 0.1, volume: source === 'arrow' ? 0.6 : 1 });
        break;
      }
      case 'collider': {
        const owner = hit.collider?.owner;
        if (owner instanceof Animal) {
          res.material = 'flesh';
          res.animal = owner;
          const wasAlive = owner.alive;
          const kind = source === 'melee' ? 'melee' : source;
          res.killed = owner.hurt({ damage, dir: dir.clone(), point: point.clone(), by: tool, kind, collider: hit.collider });
          if (!wasAlive) fx.blood(point, dir, 0.4);
          ctx.audio.play(source === 'arrow' ? 'arrow_hit_flesh' : source === 'spear' ? 'spear_hit' : 'axe_hit_flesh', { position: point, pitchVar: 0.1 });
          if (wasAlive) ctx.ui.hitMarker(res.killed);
        } else {
          // Structures (log walls): wood thunk.
          res.material = 'wood';
          fx.woodChips(point, n, dir, 0.4);
          ctx.audio.play(source === 'arrow' ? 'arrow_hit_wood' : 'axe_hit_wood', { position: point, volume: 0.7 });
        }
        break;
      }
      case 'terrain': {
        const surf = ctx.terrain.surfaceAt(point.x, point.z);
        ctx.events.emit('terrain:hit', { point: point.clone(), normal: n.clone(), tool });
        if (surf === 'ice') {
          res.material = 'ice';
          fx.sparksAt(point, n, 0.25);
          fx.snowPuff(point, n, 0.4);
          ctx.audio.play('ice_crack', { position: point, volume: 0.5, pitch: 1.4 });
        } else if (surf === 'rock') {
          res.material = 'stone';
          fx.sparksAt(point, n, 0.6);
          fx.stoneChips(point, n, 0.6);
          ctx.audio.play('axe_hit_stone', { position: point, volume: 0.8 });
        } else {
          res.material = 'snow';
          fx.snowPuff(point, n, source === 'arrow' ? 0.6 : 1);
          ctx.audio.play(source === 'arrow' ? 'arrow_hit_snow' : 'axe_hit_snow', { position: point, pitchVar: 0.1 });
        }
        break;
      }
    }
    wl?.hear?.(point, source === 'arrow' ? 0.25 : source === 'spear' ? 0.4 : 0.6);
    return res;
  }

  // ------------------------------------------------------------------ ranged
  /** World position + aim direction from a viewmodel point toward what the crosshair is on. */
  private aimFrom(local: THREE.Vector3, obj: THREE.Object3D, out: THREE.Vector3, dir: THREE.Vector3, lift = 0) {
    const ctx = this.ctx;
    const cam = ctx.camera;
    cam.updateMatrixWorld(true);
    obj.updateWorldMatrix(true, false);
    out.copy(local).applyMatrix4(obj.matrixWorld);
    cam.getWorldPosition(_o);
    cam.getWorldDirection(_d);
    const h = ctx.physics.raycast(_o, _d, 150, { mask: Layer.HITTABLE });
    const aimDist = h ? Math.max(4, h.distance) : 150;
    _w.copy(_o).addScaledVector(_d, aimDist);
    // Start the projectile on the camera ray if the hand point is inside something.
    dir.copy(_w).sub(out).normalize();
    dir.y += lift;
    dir.normalize();
  }

  private fireArrow() {
    const ctx = this.ctx;
    if (!ctx.inventory.remove('arrow', 1)) return;
    const d = this.draw;
    const speed = 22 + 38 * Math.pow(d, 1.4);
    // Arrow nock point on the string -> launch from just in front of the bow.
    const bowObj = this.bow.root;
    const start = new THREE.Vector3();
    const dir = new THREE.Vector3();
    this.aimFrom(_v.set(-0.012, 0.004, -0.1), bowObj, start, dir, 0.004);
    // Keep the launch point on the camera side of walls: if blocked, start at the eye.
    ctx.camera.getWorldPosition(_o);
    if (ctx.physics.raycast(_o, _w.copy(start).sub(_o).normalize(), _o.distanceTo(start), { mask: Layer.HITTABLE | Layer.SOLID })) start.copy(_o);
    this.projectiles.fireArrow(start, dir, speed);
    ctx.audio.play('bow_release', { pitchVar: 0.06 });
    ctx.audio.play('arrow_whoosh', { volume: 0.5 + 0.5 * d, pitchVar: 0.1 });
    this.stringVib = 0.9;
    this.stringVibV = 0;
    this.recoilV -= 1.2;
    this.nockT = 0;
    this.draw = 0.001;
    const pl = ctx.sys.player as unknown as { kick?: (p: number, r?: number) => void };
    pl.kick?.(0.006 * d, 0);
    ctx.sys.wildlife?.hear?.(start, 0.12);
  }

  private throwSpear() {
    const ctx = this.ctx;
    this.charging = false;
    const inv = ctx.inventory;
    const slot = inv.hotbar.indexOf('spear');
    const start = new THREE.Vector3();
    const dir = new THREE.Vector3();
    // Tip of the spear in model space is the origin of the spear model.
    this.aimFrom(_v.set(0, 0, -0.9), this.spear, start, dir, 0.03);
    ctx.camera.getWorldPosition(_o);
    if (ctx.physics.raycast(_o, _w.copy(start).sub(_o).normalize(), _o.distanceTo(start), { mask: Layer.HITTABLE | Layer.SOLID })) start.copy(_o);
    const speed = 15 + 17 * this.charge;
    this.projectiles.throwSpear(start, dir, speed, slot);
    ctx.audio.play('spear_throw', { pitchVar: 0.06 });
    const pl = ctx.sys.player as unknown as { kick?: (p: number, r?: number) => void };
    pl.kick?.(-0.01, 0.01);
    this.act = { kind: 'throw', keys: K_THROW, t: 0, dur: 0.36, hitAt: 99, hitDone: true, sound: -1 };
    this.thrownHide = true;
    this.holders.spear.visible = false;
    this.charge = 0;
    this.aimK = 0;
    inv.remove('spear', 1);
  }

  // ------------------------------------------------------------------ torch
  private setTorch(on: boolean) {
    if (on === this.torchLit) return;
    const ctx = this.ctx;
    this.torchLit = on;
    if (on) {
      const sky = ctx.sys.sky as unknown as { acquireLight?: () => LightHandle | null };
      this.lightHandle = sky?.acquireLight?.() ?? null;
      this.torchLight = this.lightHandle?.light ?? null;
      if (this.torchLight) {
        this.torchLight.color.setHex(0xff8a3c);
        this.torchLight.distance = 24;
        this.torchLight.decay = 1.7;
        this.torchLight.castShadow = false;
      }
      this.torchLoop = ctx.audio.loop('torch_loop', { volume: 0.55 });
      ctx.audio.play('fire_ignite', { volume: 0.6 });
      if (this.torchHours <= 0) this.torchHours = TORCH_HOURS;
    } else {
      this.lightHandle?.release();
      this.lightHandle = null;
      this.torchLight = null;
      this.torchLoop?.stop(0.3);
      this.torchLoop = null;
      this.torchOn = 0;
    }
  }

  private updateTorch(dt: number) {
    const ctx = this.ctx;
    const visible = this.shown === 'torch';
    if (!visible) return;
    const t = ctx.time;
    this.torch.flameAnchor.getWorldPosition(this.torchPosition);
    this.torchOn = damp(this.torchOn, this.torchLit ? 1 : 0, 6, dt);
    const fx = this.effects;
    this.flame.group.visible = this.torchOn > 0.05;
    if (this.torchLit) {
      const wind = ctx.env.wind;
      this.flame.update(dt, t, this.torchPosition, wind.x, wind.z, (x, y, z, vx, vy, vz) => fx.ember(x, y, z, vx, vy, vz), (x, y, z) => fx.smoke(x, y, z, 0.06));
      this.flame.group.scale.multiplyScalar(this.torchOn);
      if (this.torchLight) {
        // Sit the light a little ahead of and above the flame so the near arm isn't blown out.
        ctx.camera.getWorldDirection(_d);
        this.torchLight.position.copy(this.torchPosition).addScaledVector(_d, 0.45);
        this.torchLight.position.y += 0.3;
        this.torchLight.intensity = 7 * this.flame.flicker * this.torchOn;
      }
      this.torch.emberMat.emissiveIntensity = (1.2 + 1.4 * (this.flame.flicker - 0.82)) * this.torchOn;
      this.torchLoop?.setPosition(this.torchPosition);
      // Burn down (in-game hours); snow and wind eat fuel faster.
      if (ctx.game.state === 'playing' && !ctx.clock.frozen) {
        this.torchHours -= ctx.clock.hoursPerSecond * dt * (1 + ctx.env.snowfall * 0.6 + ctx.env.windStrength * 0.3);
        if (this.torchHours <= 0) this.burnOut();
      }
    }
  }

  private burnOut() {
    const ctx = this.ctx;
    ctx.audio.play('fire_out', { position: this.torchPosition, volume: 0.7 });
    for (let i = 0; i < 8; i++) this.effects.smoke(this.torchPosition.x, this.torchPosition.y, this.torchPosition.z, 0.08);
    this.torchHours = TORCH_HOURS;
    ctx.inventory.remove('torch', 1);
    ctx.ui.toast(ctx.inventory.has('torch') ? 'Your torch burned out. You light another.' : 'Your torch burned out', 'warn');
  }

  // ------------------------------------------------------------------ viewmodel pose
  private pose(dt: number) {
    const ctx = this.ctx;
    const p = ctx.player;
    const w = this.shown;
    const hr = this.handR!,
      hl = this.handL!;
    this.swayT += dt;
    // Weapon inertia: the tool lags a touch behind fast mouse moves (in the fist).
    const dYaw = angDiff(this.prevYaw, p.yaw),
      dPitch = p.pitch - this.prevPitch;
    this.prevYaw = p.yaw;
    this.prevPitch = p.pitch;
    this.inertia.x = damp(this.inertia.x + clamp(dYaw, -0.1, 0.1) * 0.8, 0, 9, dt);
    this.inertia.y = damp(this.inertia.y + clamp(dPitch, -0.1, 0.1) * 0.8, 0, 9, dt);

    this.handOffR.set(0, 0, 0);
    this.handOffL.set(0, 0, 0);
    this.handRotR.set(0, 0, 0);
    this.handRotL.set(0, 0, 0);
    if (!w) {
      hr.rotation.set(0, 0, 0);
      hl.rotation.set(0, 0, 0);
      return;
    }
    const e = this.equipK;
    const raise = e < 1 ? 1 - Math.pow(1 - e, 3) * (1 + 1.4 * e) : 1; // ease-out with a hint of overshoot
    const low = 1 - raise;
    const holder = this.holders[w];
    const isBow = w === 'bow';
    const off = isBow ? this.handOffL : this.handOffR;
    const rot = isBow ? this.handRotL : this.handRotR;
    off.set(0.02 * low, -0.32 * low, 0.05 * low);
    rot.set(-0.6 * low, 0, 0.25 * low);
    // Rest pose of the tool in the fist.
    const R = REST[w];
    let rx = R[0],
      ry = R[1],
      rz = R[2];
    if (this.act && this.act.kind !== 'throw') {
      const pz = samplePose(this.act.keys, this.act.t, _pose);
      off.x += pz[0];
      off.y += pz[1];
      off.z += pz[2];
      rx += pz[3];
      ry += pz[4];
      rz += pz[5];
      rot.z += pz[6];
    }
    // Idle breath on the weapon itself (the arm already breathes) + look inertia.
    const br = Math.sin(this.swayT * 1.7);
    rx += br * 0.012 - this.inertia.y * 0.6;
    ry += -this.inertia.x * 0.7;
    rz += this.inertia.x * 0.4;
    off.z += this.recoilZ * 0.05;
    this.spearAimTilt = 0;
    this.spearAimYaw = 0;
    if (w === 'spear') this.poseSpearAim(off, rot);
    rx += this.spearAimTilt;
    ry += this.spearAimYaw;
    if (isBow) this.poseBowHand(off, rot, raise);
    holder.rotation.set(rx, ry, rz, 'YXZ');
    holder.position.set(R[3], R[4], R[5]);

    if (isBow) {
      // Bow hand first, then the draw hand follows the string.
      this.poseBowOrient(hl);
      this.poseBowString(hr, raise);
      hr.position.add(this.handOffR);
      hr.rotation.copy(this.handRotR);
    } else {
      hr.position.add(this.handOffR);
      hr.rotation.copy(this.handRotR);
      if (w === 'spear') this.poseSpearSupport(hl, raise);
      hl.position.add(this.handOffL);
      hl.rotation.copy(this.handRotL);
    }
  }

  private spearAimTilt = 0;
  private spearAimYaw = 0;
  /** Spear raised overhand for the throw, pulled back while charging. */
  private poseSpearAim(off: THREE.Vector3, rot: THREE.Euler) {
    const a = this.aimK;
    if (a < 0.001) return;
    const c = this.charge;
    const tremble = c >= 1 ? Math.sin(this.swayT * 31) * 0.0025 : 0;
    off.x += 0.05 * a;
    off.y += (0.27 + 0.02 * c) * a + tremble;
    off.z += (-0.04 + 0.09 * c) * a;
    rot.x += -0.05 * a;
    this.spearAimTilt = 0.12 * a;
    this.spearAimYaw = -0.12 * a;
  }

  /** Front hand wraps the shaft ahead of the rear hand (two-handed guard); lets go to throw. */
  private poseSpearSupport(hl: THREE.Object3D, raise: number) {
    if (!hl.parent || this.thrownHide) return;
    const k = (1 - this.aimK) * raise;
    if (k < 0.01) return;
    this.holders.spear.updateWorldMatrix(true, true);
    // Model space: tip at the origin pointing +Z, the rear grip sits at z = -0.75.
    _v.set(0, -0.01, -0.36).applyMatrix4(this.spear.matrixWorld);
    hl.parent.worldToLocal(_v);
    _v.sub(hl.position);
    this.handOffL.lerp(_v, k);
  }

  /** Bow hand: a low canted carry that rises to a steady aim with the arrow on the crosshair. */
  private poseBowHand(off: THREE.Vector3, rot: THREE.Euler, raise: number) {
    const d = smoothstep(0, 1, this.draw);
    const aimK = Math.max(d, this.drawing ? 0.7 : 0) * raise;
    this.bowAimK = aimK;
    // Grip targets in camera space; converted to the hand's parent space in poseBowOrient().
    const shake = 0.0022 + 0.018 * smoothstep(2.0, 6.0, this.fullT) * d;
    const t = this.swayT;
    this.bowGrip.set(lerp(-0.2, -0.11, aimK), lerp(-0.25, -0.115, aimK), lerp(-0.6, -0.74, aimK));
    this.bowGrip.x += Math.sin(t * 1.3) * shake + Math.sin(t * 7.1) * shake * 0.25 * d;
    this.bowGrip.y += Math.sin(t * 2.1 + 0.7) * shake * 0.8 + Math.sin(t * 8.3) * shake * 0.2 * d;
    this.bowGrip.y += off.y; // equip lower / recoil
    this.bowGrip.z += off.z;
    off.set(0, 0, 0);
    rot.set(0, 0, 0);
    const arrows = this.ctx.inventory.count('arrow');
    this.bow.setDraw(this.draw, this.stringVib, arrows > 0 && this.nockT > 0.35);
    if (this.nockT < 1 && arrows > 0) {
      // A fresh arrow slides onto the string from below.
      const k = smoothstep(0.35, 1, this.nockT);
      this.bow.arrow.position.y -= (1 - k) * 0.1;
      this.bow.arrow.position.z += (1 - k) * 0.08;
    }
  }
  private bowAimK = 0;
  private readonly bowGrip = new THREE.Vector3();

  /** Place + orient the bow hand in world space so the arrow points at the crosshair when drawn. */
  private poseBowOrient(hl: THREE.Object3D) {
    const cam = this.ctx.camera;
    const parent = hl.parent;
    if (!parent) return;
    cam.updateMatrixWorld();
    parent.updateWorldMatrix(true, false);
    const k = this.bowAimK;
    // Position.
    _v.copy(this.bowGrip).applyMatrix4(cam.matrixWorld);
    parent.worldToLocal(_v);
    hl.position.copy(_v);
    // Orientation in camera space: carry = canted 35 deg, drawn = arrow toward a far point on the crosshair.
    _qa.setFromEuler(_eu.set(-0.04, -0.12, -0.62, 'YXZ'));
    _w.set(0, 0, -40).sub(this.bowGrip).normalize(); // desired arrow direction (camera space)
    _qb.setFromUnitVectors(_fwd, _w).multiply(_qc.setFromAxisAngle(_fwdN, 0.2));
    _qa.slerp(_qb, k);
    // camera space -> parent space
    cam.getWorldQuaternion(_qc);
    _qa.premultiply(_qc);
    parent.getWorldQuaternion(_qc);
    hl.quaternion.copy(_qc.invert().multiply(_qa));
  }

  /** Draw hand pinches the nock (after the bow hand has been placed). */
  private poseBowString(hr: THREE.Object3D, raise: number) {
    const pull = smoothstep(0, 0.2, this.draw) * raise * (this.drawing || this.draw > 0.02 ? 1 : 0);
    if (pull <= 0 || !hr.parent) return;
    this.holders.bow.updateWorldMatrix(true, true);
    const nz = this.bow.nockZ();
    _v.set(0.01, -0.035, nz + 0.035).applyMatrix4(this.bow.root.matrixWorld);
    hr.parent.worldToLocal(_v);
    _v.sub(hr.position);
    this.handOffR.lerp(_v, pull);
    this.handRotR.set(0.1 * pull, -0.3 * pull, -0.9 * pull);
  }

  // ------------------------------------------------------------------ dev helpers
  /** Fire / throw / swing the equipped weapon from script (screenshots). */
  debugFire(opts: { draw?: number; charge?: number } = {}) {
    const w = this.shown ?? (isWeapon(this.ctx.inventory.equipped) ? this.ctx.inventory.equipped : null);
    if (!w) return 'nothing equipped';
    this.equipK = 1;
    this.shown = w;
    this.holders[w].visible = true;
    if (w === 'bow') {
      if (this.ctx.inventory.count('arrow') <= 0) this.ctx.inventory.add('arrow', 1);
      this.draw = opts.draw ?? 1;
      this.fireArrow();
    } else if (w === 'spear') {
      this.charge = opts.charge ?? 1;
      this.throwSpear();
    } else this.startSwing(w);
    return 'ok';
  }

  /** Freeze the viewmodel in a pose: 'swing' | 'recoil' | 'jab' | 'aim' | 'draw' | 'idle', t seconds (or draw 0..1). */
  debugPose(name: string, t = 0.2) {
    const w = this.shown ?? (isWeapon(this.ctx.inventory.equipped) ? this.ctx.inventory.equipped : null);
    if (!w) return 'nothing equipped';
    this.shown = w;
    for (const k of WEAPONS) this.holders[k].visible = k === w;
    this.equipK = 1;
    this.debugT = null;
    this.act = null;
    this.drawing = false;
    this.charging = false;
    if (name === 'swing') this.act = { kind: w === 'torch' ? 'tswing' : 'swing', keys: w === 'torch' ? K_TSWING : K_SWING, t, dur: 1, hitAt: 99, hitDone: true, sound: -1 };
    else if (name === 'recoil') this.act = { kind: 'recoil', keys: K_RECOIL, t, dur: 1, hitAt: 99, hitDone: true, sound: -1 };
    else if (name === 'jab') this.act = { kind: 'jab', keys: K_JAB, t, dur: 1, hitAt: 99, hitDone: true, sound: -1 };
    else if (name === 'aim') {
      this.aimK = 1;
      this.charging = true;
      this.charge = t;
    } else if (name === 'draw') {
      this.drawing = true;
      this.draw = t;
    }
    if (this.act) this.debugT = t;
    this.freezeDebug = name !== 'idle';
    return 'ok';
  }
  private freezeDebug = false;

  /** Release a frozen debug pose. */
  debugRelease() {
    this.debugT = null;
    this.freezeDebug = false;
    this.act = null;
    this.drawing = false;
    this.charging = false;
  }

  // ------------------------------------------------------------------ saves
  serialize() {
    return { torchHours: +this.torchHours.toFixed(3), projectiles: this.projectiles.serialize() };
  }

  deserialize(d: { torchHours?: number; projectiles?: Parameters<Projectiles['deserialize']>[0] }) {
    this.torchHours = d?.torchHours ?? TORCH_HOURS;
    if (d?.projectiles) this.projectiles.deserialize(d.projectiles);
  }
}

/** Rest pose of each tool in the fist: rotation x, y, z and position x, y, z (hand space). */
const REST: Record<WKind, [number, number, number, number, number, number]> = {
  hatchet: [-0.38, 1.05, 0.12, 0, -0.03, 0.005],
  spear: [0.03, Math.PI + 0.2, 0, 0, 0, 0],
  torch: [-0.28, 0.4, 0.14, 0, -0.04, 0],
  bow: [0.0, 0.0, 0.0, 0.0, -0.005, 0.0],
};

function angDiff(a: number, b: number) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
