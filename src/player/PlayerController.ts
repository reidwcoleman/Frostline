// Player controller: input -> Locomotion (walk / ski / air / crash physics) -> effects (audio, snow
// stamps, spray, events, damage, stats) -> CameraRig -> first-person Body.
//
// Public API (other agents):
//   viewmodel / rightHand / leftHand  camera-space anchors (combat attaches weapons to the hands)
//   shake(amount)                      add camera trauma 0..1 (tree falls, explosions, hits)
//   kick(pitch, roll?)                 springy view kick in radians (recoil, impacts)
//   eyeHeight                          current eye height above the feet (stance-aware)
//   debugState(), runPhysicsTests(), place(x, z, yawDeg, skis), findSlopes(...), autopilot  (testing)
import * as THREE from 'three';
import type { GameContext, GameState, LoopHandle, SoundId, System } from '../core/types';
import type { SurfaceKind } from '../core/Terrain';
import { clamp, damp, dampAngle, DEG, angleDelta, smoothstep } from '../core/math';
import { Body } from './Body';
import { CameraRig } from './CameraRig';
import { clearControls, makeControls, type Autopilot, type Controls } from './Controls';
import { WorldGround } from './Ground';
import { Locomotion, type CrashReason, type LocoHooks } from './Locomotion';
import { runPhysicsTests } from './PhysicsLab';
import { SnowSpray } from './SnowSpray';
import { CAM, SKI, WALK } from './tuning';

const FOOTSTEP: Record<SurfaceKind, SoundId> = {
  snow: 'footstep_snow',
  ice: 'footstep_ice',
  rock: 'footstep_rock',
  wood: 'footstep_wood',
};

const _v = new THREE.Vector3();
const _p = new THREE.Vector3();

export class PlayerController implements System {
  readonly name = 'player';
  readonly updateWhen: GameState[] = ['playing', 'dead'];

  /** Camera-space root for first-person models (skis/poles/arms by the player module, weapons by combat). */
  readonly viewmodel = new THREE.Group();
  /** Anchor in the right hand where combat attaches the equipped weapon/tool/torch. */
  readonly rightHand = new THREE.Group();
  /** Anchor in the left hand (ski pole / bow grip). */
  readonly leftHand = new THREE.Group();

  /** Scripted virtual input for testing (null = real input). */
  autopilot: Autopilot | null = null;

  readonly loco: Locomotion;
  private rig: CameraRig;
  private body: Body;
  /** Combat hands us third-person tool models to hold. */
  registerHeld(id: string, obj: THREE.Object3D) {
    this.body.registerHeld(id, obj);
  }
  private spray = new SnowSpray();
  private ground: WorldGround;
  private controls: Controls = makeControls();
  private steerYaw = 0;
  private freelookReturn = false;
  /** Over-the-shoulder chase camera, toggled with the `toggleView` action (V). Default view. */
  thirdPerson = true;
  private glideLoop: LoopHandle | null = null;
  private carveLoop: LoopHandle | null = null;
  private glideVol = 0;
  private carveVol = 0;
  private scrapeT = 0;
  private prevPos = new THREE.Vector3();
  private craterT = 0;
  private sprayAcc = 0;
  private summitY = Infinity;
  private unlocked = new Set<string>();
  private lastSkid = 0;

  constructor(private ctx: GameContext) {
    this.viewmodel.name = 'viewmodel';
    this.rightHand.name = 'rightHand';
    this.leftHand.name = 'leftHand';
    ctx.camera.add(this.viewmodel);
    this.ground = new WorldGround(ctx);
    this.loco = new Locomotion(ctx.player, this.ground);
    this.loco.hooks = this.makeHooks();
    this.rig = new CameraRig(ctx);
    this.body = new Body(ctx, this.viewmodel, this.rightHand, this.leftHand);
  }

  init() {
    const { scene, events, terrain } = this.ctx;
    scene.add(this.body.world, this.spray.points);
    this.body.world.visible = false;
    let maxH = -Infinity;
    const hs = terrain.heights;
    for (let i = 0; i < hs.length; i++) if (hs[i] > maxH) maxH = hs[i];
    this.summitY = maxH - 30;

    events.on('player:respawned', () => this.reset());
    events.on('newGame', () => this.reset());
    events.on('loadedGame', () => this.reset());
    events.on('state', ({ to }) => {
      const inGame = to === 'playing' || to === 'paused' || to === 'dead';
      this.body.world.visible = inGame && !this.ctx.dev.fly;
      this.spray.points.visible = inGame;
      this.viewmodel.visible = inGame;
      if (!inGame) this.stopLoops();
    });
    events.on('player:damaged', ({ amount, cause, from }) => {
      if (cause === 'cold' || cause === 'hunger') return;
      this.shake(Math.min(0.6, 0.1 + amount * 0.02));
      let roll = 0;
      if (from) {
        const p = this.ctx.player.position;
        const side = (from.x - p.x) * Math.cos(this.ctx.player.yaw) - (from.z - p.z) * Math.sin(this.ctx.player.yaw);
        roll = -Math.sign(side) * 0.05;
      }
      this.kick(-0.04 - amount * 0.002, roll);
    });
    events.on('tree:felled', ({ id }) => {
      const w = this.ctx.world;
      const p = this.ctx.player.position;
      const d = Math.hypot(w.treeX[id] - p.x, w.treeZ[id] - p.z);
      if (d < 40) setTimeout(() => this.shake(0.45 * (1 - d / 40)), 1400);
    });
    this.reset();
  }

  reset() {
    const p = this.ctx.player;
    this.loco.reset();
    this.rig.setThirdPerson(this.thirdPerson);
    this.body.setThirdPerson(this.thirdPerson);
    this.rig.reset();
    this.body.reset();
    this.spray.clear();
    this.steerYaw = p.yaw;
    this.freelookReturn = false;
    this.prevPos.copy(p.position);
    this.stopLoops();
    this.autopilot = null;
  }

  // ------------------------------------------------------------------ public API
  /** Camera trauma (0..1). */
  shake(amount: number) {
    this.rig.shake(amount);
  }

  /** Springy view kick (radians): pitch up +, roll. */
  kick(pitch: number, roll = 0) {
    this.rig.kick(pitch, roll);
  }

  /** Current eye height above the feet. */
  get eyeHeight(): number {
    return this.rig.eye;
  }

  // ------------------------------------------------------------------ frame
  private bestSpeed = 0;
  private speedToastT = 0;
  /** Top-speed callouts on skis (a new personal best above 50 km/h). */
  private speedRecords(dt: number) {
    const p = this.ctx.player;
    this.speedToastT -= dt;
    if (!p.onSkis || !p.grounded) return;
    const kmh = p.speed * 3.6;
    if (kmh > 50 && kmh > this.bestSpeed + 6 && this.speedToastT <= 0) {
      this.bestSpeed = kmh;
      this.speedToastT = 3;
      this.ctx.ui.toast(`New top speed: ${Math.round(kmh)} km/h`, 'good');
    }
  }

  update(dt: number) {
    this.speedRecords(dt);
    const { player: p, dev, camera } = this.ctx;
    const c = this.readControls(dt);

    if (dev.fly) {
      this.flyUpdate(dt, c);
      return;
    }

    if (this.ctx.input.pressed('toggleView') && !this.ctx.ui.blocking) {
      this.thirdPerson = !this.thirdPerson;
      this.rig.setThirdPerson(this.thirdPerson);
      this.body.setThirdPerson(this.thirdPerson);
    }

    this.prevPos.copy(p.position);
    const inv = this.ctx.inventory;
    this.loco.gear.crampons = inv.has('crampons');
    this.loco.gear.iceAxe = inv.has('ice_axe');
    this.loco.update(dt, c);
    this.effects(dt);
    this.stats(dt);
    this.rig.update(dt, this.loco);
    this.body.update(dt, this.loco, this.rig.eye, false);
    this.spray.update(dt, this.ctx.env, camera, this.ctx.renderer);
  }

  private readControls(dt: number): Controls {
    const { input, player: p, settings, ui } = this.ctx;
    const c = this.controls;
    const blocked = ui.blocking || !p.alive;
    clearControls(c);
    const ap = this.autopilot;
    if (ap) {
      c.moveY = (ap.forward ? 1 : 0) - (ap.back ? 1 : 0);
      c.moveX = (ap.right ? 1 : 0) - (ap.left ? 1 : 0);
      c.jump = !!ap.jump;
      c.jumpPressed = c.jump && !this.apJump;
      c.jumpReleased = !c.jump && this.apJump;
      this.apJump = c.jump;
      c.sprint = !!(ap.tuck || ap.sprint);
      c.crouch = !!ap.crouch;
      c.freelook = !!ap.freelook;
      if (ap.toggleSkis) {
        c.toggleSkis = true;
        ap.toggleSkis = false;
      }
      if (ap.steerOffset !== undefined) p.yaw = p.heading + ap.steerOffset;
      else if (ap.steerYaw !== undefined) p.yaw = ap.steerYaw;
      if (ap.pitch !== undefined) p.pitch = ap.pitch;
    } else if (!blocked) {
      const m = input.move();
      c.moveX = m.x;
      c.moveY = m.y;
      c.jump = input.down('jump');
      c.jumpPressed = input.pressed('jump');
      c.jumpReleased = input.released('jump');
      c.sprint = input.down('sprint');
      c.crouch = input.down('crouch');
      c.freelook = input.down('freelook');
      c.toggleSkis = input.pressed('toggleSkis');
      // Crisp look: raw deltas straight onto yaw/pitch, no smoothing.
      const look = input.look(dt);
      const s = CAM.sensitivity * settings.data.sensitivity;
      p.yaw -= look.x * s;
      p.pitch = clamp(p.pitch - look.y * s * (settings.data.invertY ? -1 : 1), -CAM.pitchLimit, CAM.pitchLimit);
    }
    p.yaw = wrapAngle(p.yaw);

    // Steering target: skis follow the look unless free-looking (Alt), after which the view eases back.
    if (p.onSkis && c.freelook) {
      // Free-look: the view is detached; A/D (left stick) steer the skis directly.
      this.freelookReturn = true;
      this.steerYaw = wrapAngle(this.steerYaw - c.moveX * 1.3 * dt);
    } else if (this.freelookReturn) {
      p.yaw = dampAngle(p.yaw, this.steerYaw, 12, dt);
      if (Math.abs(angleDelta(p.yaw, this.steerYaw)) < 0.03) this.freelookReturn = false;
    } else {
      this.steerYaw = p.yaw;
    }
    c.steerYaw = this.steerYaw;
    return c;
  }
  private apJump = false;

  private flyUpdate(dt: number, c: Controls) {
    const { player: p, camera } = this.ctx;
    const speed = c.sprint ? 120 : 30;
    const dir = p.lookDir(_v).multiplyScalar(c.moveY);
    dir.x += Math.cos(p.yaw) * c.moveX;
    dir.z += -Math.sin(p.yaw) * c.moveX;
    if (c.jump) dir.y += 1;
    if (c.crouch) dir.y -= 1;
    p.position.addScaledVector(dir, speed * dt);
    p.velocity.set(0, 0, 0);
    camera.position.set(p.position.x, p.position.y + p.eyeHeight, p.position.z);
    camera.rotation.set(p.pitch, p.yaw, 0, 'YXZ');
    this.body.update(dt, this.loco, this.rig.eye, true);
  }

  // ------------------------------------------------------------------ continuous effects
  private effects(dt: number) {
    const { player: p, snow, audio } = this.ctx;
    const loco = this.loco;
    const v = p.velocity;
    const speed = v.length();
    const skiing = p.onSkis && p.mode === 'ski' && p.grounded;
    const hx = Math.cos(p.heading),
      hz = -Math.sin(p.heading); // ski right vector
    const fx = -Math.sin(p.heading),
      fz = -Math.cos(p.heading);

    // ---- ski tracks: two parallel grooves, deeper when carving, smeared when skidding.
    const dx = p.position.x - this.prevPos.x,
      dz = p.position.z - this.prevPos.z;
    const moved = Math.hypot(dx, dz);
    if (skiing && moved > 0.01 && moved < 10 && !loco.packed) {
      const mx = (p.position.x + this.prevPos.x) * 0.5,
        mz = (p.position.z + this.prevPos.z) * 0.5;
      const ux = dx / moved,
        uz = dz / moved;
      const half = SKI.trackSpacing * 0.5 + 0.07 * loco.plow;
      const width = 0.1 + loco.skid * 0.45;
      const depth = clamp(0.35 + Math.abs(p.carve) * 0.4 + loco.skid * 0.2, 0, 1);
      for (const side of [-1, 1]) {
        snow.stamp({ x: mx + hx * half * side, z: mz + hz * half * side, dirX: ux, dirZ: uz, width, length: moved + 0.06, depth, kind: 'ski' });
      }
    }

    // ---- body craters while tumbling
    if (p.mode === 'crashed' || (p.mode === 'dead' && speed > 0.5)) {
      this.craterT -= dt;
      if (p.grounded && this.craterT <= 0 && !loco.packed) {
        this.craterT = 0.16;
        const l = Math.max(speed, 1e-3);
        snow.stamp({ x: p.position.x, z: p.position.z, dirX: v.x / l || 1, dirZ: v.z / l, width: 0.9, length: 1.3, depth: 0.8, kind: 'body' });
        if (speed > 3) this.spray.emit(Math.min(14, 3 + speed), p.position.x, p.position.y + 0.2, p.position.z, v.x * 0.35, 1.5, v.z * 0.35, 1.6, 0.35, 1.1, 0.5);
      }
    }

    // ---- spray: skids fan out downhill of the edges; carves throw a rooster tail at speed.
    if (skiing && !loco.packed) {
      const skid = loco.skid;
      const carveK = Math.abs(p.carve) * smoothstep(8, 22, speed);
      const rate = skid * (40 + speed * 14) + carveK * 26 + smoothstep(18, 40, speed) * 6;
      this.sprayAcc += rate * dt;
      const n = Math.floor(this.sprayAcc);
      this.sprayAcc -= n;
      if (n > 0) {
        // Skid spray flies in the direction of travel, off the downhill (outside) edges.
        const l = Math.max(speed, 1e-3);
        const ox = v.x / l,
          oz = v.z / l;
        const lat = Math.sign(v.x * hx + v.z * hz) || 1;
        for (let k = 0; k < n; k++) {
          const along = (Math.random() - 0.4) * 1.2;
          const x = p.position.x + fx * along + hx * lat * 0.14,
            z = p.position.z + fz * along + hz * lat * 0.14;
          const up = 1.2 + skid * 2.6 + Math.random() * 1.2;
          const fling = 0.55 + skid * 0.3;
          const vx = ox * speed * fling + hx * lat * skid * 2.2,
            vz = oz * speed * fling + hz * lat * skid * 2.2;
          if (k & 1) {
            // Crisp clumps: small, dense, thrown in an arc.
            this.spray.emit(1, x, p.position.y + 0.05, z, vx * 1.1, up * 1.2, vz * 1.1, 0.8 + skid * 0.6, 0.07 + skid * 0.06, 0.55 + skid * 0.3, 0.06, 1.2, 9);
          } else {
            // Dust: soft, floats and hangs in the air behind the turn.
            this.spray.emit(1, x, p.position.y + 0.05, z, vx * 0.8, up * 0.8, vz * 0.8, 0.9 + skid, 0.16 + skid * 0.16, 0.9 + skid * 0.5, 0.08, 2.4, 3);
          }
        }
      }
    } else this.sprayAcc = 0;

    // ---- audio loops
    const onSnowSkis = p.onSkis && (p.mode === 'ski' || p.mode === 'air');
    if (onSnowSkis && !this.glideLoop) this.startLoops();
    if (!p.onSkis && this.glideLoop && loco.toggleT < 0) this.stopLoops();
    if (this.glideLoop && this.carveLoop) {
      const gTarget = skiing ? smoothstep(0.4, 28, speed) * (loco.packed ? 0.6 : 1) : 0;
      const cTarget = skiing ? clamp(Math.abs(p.carve) * smoothstep(3, 18, speed) * 0.8 + loco.skid * 1.0, 0, 1) : 0;
      this.glideVol = damp(this.glideVol, gTarget, 10, dt);
      this.carveVol = damp(this.carveVol, cTarget, 14, dt);
      this.glideLoop.setVolume(this.glideVol);
      this.glideLoop.setPitch(0.75 + clamp(speed / 40, 0, 1) * 0.65 + (p.surface === 'ice' ? 0.2 : 0));
      this.carveLoop.setVolume(this.carveVol);
      this.carveLoop.setPitch(0.85 + loco.skid * 0.35 + clamp(speed / 50, 0, 0.3));
      _p.set(p.position.x, p.position.y + 0.1, p.position.z);
      this.glideLoop.setPosition(_p);
      this.carveLoop.setPosition(_p);
    }
    // Scrape one-shots: skid onsets, sustained hard skids, rock under the skis.
    this.scrapeT -= dt;
    const scraping = skiing && (loco.skid > 0.45 || (p.surface === 'rock' && speed > 1.5) || (p.surface === 'ice' && loco.skid > 0.2));
    if (scraping && (this.lastSkid <= 0.45 || this.scrapeT <= 0)) {
      audio.play('ski_scrape', { position: p.position, volume: clamp(0.35 + loco.skid * 0.6, 0, 1), pitch: p.surface === 'rock' ? 0.7 : 1 });
      this.scrapeT = 0.38;
    }
    this.lastSkid = scraping ? loco.skid : 0;
  }

  private startLoops() {
    const a = this.ctx.audio;
    this.glideLoop = a.loop('ski_glide', { volume: 0, position: this.ctx.player.position });
    this.carveLoop = a.loop('ski_carve', { volume: 0, position: this.ctx.player.position });
    this.glideVol = this.carveVol = 0;
  }

  private stopLoops() {
    this.glideLoop?.stop(0.3);
    this.carveLoop?.stop(0.3);
    this.glideLoop = this.carveLoop = null;
  }

  // ------------------------------------------------------------------ stats + achievements
  private stats(dt: number) {
    const { player: p, platform } = this.ctx;
    const st = p.stats;
    const speed = p.velocity.length();
    if (p.onSkis && (p.mode === 'ski' || p.mode === 'air')) {
      const d = Math.hypot(p.position.x - this.prevPos.x, p.position.z - this.prevPos.z);
      if (d < 10) st.distanceSkied += d;
      if (speed > st.topSpeed) st.topSpeed = speed;
      if (speed * 3.6 >= 100) this.unlock('SPEED_DEMON');
      if (!p.grounded && this.loco.airT > st.longestAir) st.longestAir = this.loco.airT;
      if (!p.grounded && this.loco.airT >= 3) this.unlock('BIG_AIR');
    }
    if (p.position.y > st.highestAltitude) st.highestAltitude = p.position.y;
    if (p.position.y >= this.summitY && p.grounded) this.unlock('SUMMIT');
    void dt;
    void platform;
  }

  private unlock(id: 'SPEED_DEMON' | 'BIG_AIR' | 'SUMMIT') {
    if (this.unlocked.has(id) || this.ctx.dev.fly) return;
    this.unlocked.add(id);
    this.ctx.platform.unlockAchievement(id);
  }

  // ------------------------------------------------------------------ discrete events from the physics
  private makeHooks(): LocoHooks {
    return {
      footstep: (side, surface, packed, pos, dirX, dirZ, speed) => {
        const { audio, snow } = this.ctx;
        audio.play(FOOTSTEP[surface], { position: pos, volume: clamp(0.35 + speed * 0.13, 0.3, 1), pitchVar: 0.08 });
        if (!packed) {
          // Right vector of the walking direction.
          const rx = -dirZ,
            rz = dirX;
          snow.stamp({ x: pos.x + rx * side * 0.12, z: pos.z + rz * side * 0.12, dirX, dirZ, width: 0.13, length: 0.3, depth: 0.55, kind: 'foot' });
        }
      },
      jump: (onSkis, charge) => {
        const p = this.ctx.player;
        this.ctx.events.emit('player:jump', {});
        if (onSkis) {
          this.ctx.audio.play('ski_jump', { position: p.position, volume: 0.5 + charge * 0.5 });
          if (!this.loco.packed) this.spray.emit(10 + Math.round(charge * 14), p.position.x, p.position.y + 0.05, p.position.z, p.velocity.x * 0.3, 1.2, p.velocity.z * 0.3, 1.2, 0.2, 0.8, 0.4);
        }
        this.rig.dip(-0.6 - charge * 0.6);
      },
      land: (impact, severity, onSkis, air) => {
        const { player: p, audio, events, snow } = this.ctx;
        events.emit('player:landed', { impact });
        this.rig.dip(Math.min(2.6, 0.4 + impact * 0.22));
        this.rig.shake(Math.min(0.7, impact * 0.05 + (severity ? 0.25 : 0)));
        if (onSkis) {
          audio.play(severity ? 'ski_land_hard' : 'ski_land', { position: p.position, volume: clamp(0.3 + impact * 0.1, 0.3, 1) });
          if (severity) {
            const dmg = (impact - SKI.landHard) * SKI.landHardDamage;
            if (dmg > 0.5) p.damage(dmg, 'fall');
          }
          // Stomped a big one: the rush tops up stamina and warms you.
          if (air > 0.75 && !severity) {
            const tier = air > 2 ? 'Huge air' : air > 1.3 ? 'Big air' : 'Nice air';
            p.stamina = Math.min(100, p.stamina + 12 + air * 10);
            p.warmth = Math.min(100, p.warmth + air * 2);
            this.ctx.ui.toast(`${tier}: ${air.toFixed(1)} s`, 'good');
          }
          if (!this.loco.packed) {
            const n = Math.round(12 + impact * 5 + air * 6);
            this.spray.emit(n, p.position.x, p.position.y + 0.05, p.position.z, p.velocity.x * 0.25, 1 + impact * 0.25, p.velocity.z * 0.25, 1.2 + impact * 0.2, 0.22, 1, 0.5);
            const hx = Math.cos(p.heading),
              hz = -Math.sin(p.heading);
            for (const side of [-1, 1]) {
              snow.stamp({ x: p.position.x + hx * side * 0.1, z: p.position.z + hz * side * 0.1, dirX: -Math.sin(p.heading), dirZ: -Math.cos(p.heading), width: 0.16, length: 1.4, depth: clamp(0.5 + impact * 0.06, 0, 1), kind: 'ski' });
            }
          }
        } else {
          if (impact > WALK.fallDamageSpeed) {
            audio.play('body_fall', { position: p.position });
            p.damage((impact - WALK.fallDamageSpeed) * WALK.fallDamagePer, 'fall');
          } else audio.play(FOOTSTEP[p.surface], { position: p.position, volume: clamp(0.5 + impact * 0.1, 0.5, 1) });
        }
      },
      crash: (speed, reason, impact) => this.onCrash(speed, reason, impact),
      bump: (impact) => {
        const p = this.ctx.player;
        this.ctx.audio.play('snow_thump', { position: p.position, volume: clamp(impact * 0.15, 0.2, 1) });
        this.rig.shake(Math.min(0.5, impact * 0.07));
        this.rig.kick(-0.02, (Math.random() - 0.5) * 0.06);
        // Snow shaken loose from branches / the rock.
        this.spray.emit(Math.round(8 + impact * 3), p.position.x, p.position.y + 2.2, p.position.z, 0, -0.5, 0, 0.8, 0.22, 1.4, 0.8, 1.2);
      },
      polePlant: (side) => {
        const p = this.ctx.player;
        this.body.plant(side);
        const hx = Math.cos(p.heading),
          hz = -Math.sin(p.heading);
        const fx = -Math.sin(p.heading),
          fz = -Math.cos(p.heading);
        const sides = side === 0 ? [-1, 1] : [side];
        for (const s of sides) {
          _p.set(p.position.x + fx * 0.45 + hx * s * 0.42, p.position.y, p.position.z + fz * 0.45 + hz * s * 0.42);
          this.ctx.audio.play('ski_pole_plant', { position: _p, volume: 0.55, pitchVar: 0.1 });
          if (!this.loco.packed) {
            this.ctx.snow.stamp({ x: _p.x, z: _p.z, dirX: fx, dirZ: fz, width: 0.09, length: 0.09, depth: 0.7, kind: 'paw' });
            this.spray.emit(4, _p.x, _p.y + 0.03, _p.z, 0, 0.6, 0, 0.4, 0.1, 0.5, 0.05);
          }
        }
      },
      skiToggle: (on, phase) => {
        const { audio, events, player: p } = this.ctx;
        if (phase === 'click') audio.play(on ? 'ski_on' : 'ski_off', { position: p.position });
        if (phase === 'done') {
          events.emit('player:skis', { on });
          if (on) this.startLoops();
          else this.stopLoops();
          this.steerYaw = p.yaw;
        }
      },
      gotUp: () => {
        this.rig.shake(0.1);
        this.steerYaw = this.ctx.player.yaw;
      },
    };
  }

  private onCrash(speed: number, reason: CrashReason, impact: number) {
    const { player: p, audio, events, snow } = this.ctx;
    const kmh = speed * 3.6;
    let dmg: number;
    if (reason === 'impact') dmg = Math.max(3, (impact * 3.6 - 20) * 0.75);
    else if (reason === 'landing') dmg = Math.max(6, (impact - 8) * 5 + kmh * 0.12);
    else dmg = 4 + kmh * 0.12;
    events.emit('player:crashed', { speed });
    audio.play('crash', { position: p.position, volume: clamp(0.5 + kmh / 80, 0.5, 1) });
    this.rig.shake(1);
    this.rig.dip(2);
    // Big burst of powder + a body-sized crater.
    const packed = this.loco.packed;
    if (!packed) {
      this.spray.emit(Math.round(40 + kmh * 1.2), p.position.x, p.position.y + 0.3, p.position.z, p.velocity.x * 0.35, 2.2, p.velocity.z * 0.35, 2.2 + kmh * 0.02, 0.35, 1.5, 0.6);
      const l = Math.max(speed, 1e-3);
      snow.stamp({ x: p.position.x, z: p.position.z, dirX: p.velocity.x / l || 1, dirZ: p.velocity.z / l, width: 1.1, length: 1.8, depth: 1, kind: 'body' });
    }
    this.craterT = 0.1;
    p.damage(dmg, 'crash');
  }

  // ------------------------------------------------------------------ testing helpers
  /** Snapshot of the movement state for automated tests. */
  debugState() {
    const p = this.ctx.player;
    const l = this.loco;
    const n = l.groundN;
    return {
      mode: p.mode,
      onSkis: p.onSkis,
      grounded: p.grounded,
      pos: [r2(p.position.x), r2(p.position.y), r2(p.position.z)],
      vel: [r2(p.velocity.x), r2(p.velocity.y), r2(p.velocity.z)],
      kmh: r2(p.velocity.length() * 3.6),
      headingDeg: r2(p.heading / DEG),
      yawDeg: r2(p.yaw / DEG),
      carve: r2(p.carve),
      latG: r2(l.latAcc / 9.81),
      skid: r2(l.skid),
      skidMs: r2(l.skidSpeed),
      plow: r2(l.plow),
      tuck: p.tucking,
      airTime: r2(l.airT),
      lastAir: r2(l.lastAirTime),
      hag: r2(l.hag),
      slopeDeg: r2(Math.acos(clamp(n.y, -1, 1)) / DEG),
      surface: p.surface,
      stamina: r2(p.stamina),
      health: r2(p.health),
      eye: r2(this.rig.eye),
      fov: r2(this.ctx.camera.fov),
      stats: { ...p.stats, topSpeedKmh: r2(p.stats.topSpeed * 3.6) },
    };
  }

  /** Deterministic physics validation on analytic slopes (see PhysicsLab). */
  runPhysicsTests() {
    return runPhysicsTests();
  }

  /** Teleport onto the snow at (x, z) facing yawDeg, optionally already on skis. */
  place(x: number, z: number, yawDeg = 0, skis = true, speed = 0) {
    const p = this.ctx.player;
    const y = this.ctx.physics.groundProbe(x, 5000, z).y;
    p.teleport(x, y, z);
    p.yaw = p.heading = yawDeg * DEG;
    p.onSkis = skis;
    p.mode = skis ? 'ski' : 'walk';
    p.velocity.set(-Math.sin(p.yaw) * speed, 0, -Math.cos(p.yaw) * speed);
    this.loco.reset();
    this.steerYaw = p.yaw;
    this.body.reset();
    this.prevPos.copy(p.position);
    return this.debugState();
  }

  /**
   * Find open ski slopes: spots whose fall line keeps a mean grade in [minDeg, maxDeg] for `runLen`
   * meters with no trees or boulders in the corridor. Returns up to `count` { x, z, y, yawDeg, gradeDeg }.
   */
  findSlopes(minDeg = 18, maxDeg = 32, count = 5, runLen = 150, step = 48) {
    const { terrain, world } = this.ctx;
    const res: { x: number; z: number; y: number; yawDeg: number; gradeDeg: number }[] = [];
    const lim = terrain.half - 200;
    const nrm = new THREE.Vector3();
    for (let z = -lim; z < lim && res.length < count * 6; z += step) {
      for (let x = -lim; x < lim; x += step) {
        terrain.normalAt(x, z, nrm);
        const hl = Math.hypot(nrm.x, nrm.z);
        if (hl < 0.05) continue;
        const ux = nrm.x / hl,
          uz = nrm.z / hl; // downhill
        const y0 = terrain.heightAt(x, z);
        const y1 = terrain.heightAt(x + ux * runLen, z + uz * runLen);
        const grade = Math.atan2(y0 - y1, runLen) / DEG;
        if (grade < minDeg || grade > maxDeg) continue;
        let ok = true;
        let maxLocal = 0;
        for (let s = 10; s <= runLen && ok; s += 10) {
          const px = x + ux * s,
            pz = z + uz * s;
          maxLocal = Math.max(maxLocal, terrain.slopeAngle(px, pz) / DEG);
          if (terrain.lakeFactor(px, pz) > 0.2) ok = false;
          world.forEachTree(px, pz, 6, () => {
            ok = false;
            return true;
          });
          world.forEachRock(px, pz, 3, () => {
            ok = false;
            return true;
          });
        }
        if (!ok || maxLocal > maxDeg + 12) continue;
        res.push({ x, z, y: r2(y0), yawDeg: r2(Math.atan2(-ux, -uz) / DEG), gradeDeg: r2(grade) });
      }
    }
    res.sort((a, b) => b.y - a.y);
    return res.slice(0, count);
  }
}

function r2(v: number) {
  return Math.round(v * 100) / 100;
}

function wrapAngle(a: number) {
  const TAU = Math.PI * 2;
  a = a % TAU;
  if (a > Math.PI) a -= TAU;
  else if (a < -Math.PI) a += TAU;
  return a;
}
