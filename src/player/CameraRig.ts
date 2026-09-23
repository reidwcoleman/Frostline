// First-person camera feel: crisp look (no smoothing), stance height, head bob synced to stride,
// landing dip spring, carve lean, speed FOV kick, trauma-based shake, crash tumble and death camera.
import type { GameContext } from '../core/types';
import { clamp, damp, lerp, smoothstep, TAU } from '../core/math';
import { Simplex2 } from '../core/noise';
import { CAM, EYE, SKI } from './tuning';
import type { Locomotion } from './Locomotion';

export class CameraRig {
  /** Current eye height above the feet (smoothed stance). */
  eye: number = EYE.stand;
  private dipY = 0;
  private dipV = 0;
  private trauma = 0;
  private roll = 0;
  private fov = 78;
  private shakeT = 0;
  private noise = new Simplex2(911);
  private kickP = 0;
  private kickPV = 0;
  private kickR = 0;
  private kickRV = 0;
  private bobAmp = 0;
  private sway = 0;
  // crash tumble
  private tumble = 0;
  private tumbleRoll = 0;
  // death
  private deadT = -1;
  private deadRoll = 0;
  private deadYaw = 0;
  /** Extra pitch applied while clipping skis on/off (looking down at the bindings). */
  private togglePitch = 0;
  // Leg absorption: the head rides a filtered copy of the feet height.
  private headY = 0;
  private headVy = 0;
  private lastFeetY = 0;
  private headInit = false;

  constructor(private ctx: GameContext) {
    this.fov = ctx.settings.data.fov;
  }

  reset() {
    this.dipY = this.dipV = this.trauma = this.roll = 0;
    this.kickP = this.kickPV = this.kickR = this.kickRV = 0;
    this.tumble = this.tumbleRoll = 0;
    this.deadT = -1;
    this.togglePitch = 0;
    this.eye = this.ctx.player.onSkis ? EYE.ski : EYE.stand;
    this.headInit = false;
  }

  /**
   * Feet height as the head experiences it: vertical velocity is low-passed and integrated, then
   * pulled back to the real feet. Steady descents pass through with no lag; sharp bumps and steps
   * are absorbed (clamped to ±0.18 m) like a skier's knees would.
   */
  private absorbedFeetY(dt: number, feetY: number): number {
    if (!this.headInit || Math.abs(feetY - this.headY) > 1.5 || dt <= 0) {
      this.headInit = true;
      this.headY = this.lastFeetY = feetY;
      this.headVy = 0;
      return feetY;
    }
    const vy = (feetY - this.lastFeetY) / dt;
    this.lastFeetY = feetY;
    this.headVy = damp(this.headVy, vy, 16, dt);
    this.headY += this.headVy * dt;
    this.headY = damp(this.headY, feetY, 7, dt);
    this.headY = clamp(this.headY, feetY - 0.18, feetY + 0.18);
    return this.headY;
  }

  /** Add camera trauma (0..1). Shake strength is trauma², so small values are subtle. */
  shake(amount: number) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Landing dip: downward velocity kick for the eye spring (m/s). */
  dip(v: number) {
    this.dipV -= v;
  }

  /** Rotational kick (radians) that springs back: pitch up +, roll. */
  kick(pitch: number, roll = 0) {
    this.kickPV += pitch * 14;
    this.kickRV += roll * 14;
  }

  startTumble(spin: number) {
    this.tumble = 0.0001;
    this.tumbleRoll = (Math.random() - 0.5) * 1.6 + spin * 0.4;
  }

  update(dt: number, loco: Locomotion) {
    const { camera, player: p, settings, terrain } = this.ctx;
    const s = settings.data;
    const shakeScale = s.cameraShake;

    // ---- stance height
    let target: number;
    if (p.mode === 'dead') target = EYE.dead;
    else if (p.mode === 'crashed') target = EYE.crashed;
    else if (p.onSkis) {
      target = lerp(EYE.ski, EYE.skiCrouch, loco.crouch);
      target = lerp(target, EYE.tuck, loco.tuck);
      target = Math.min(target, lerp(EYE.ski, EYE.charge, loco.charge));
      target -= loco.poling * 0.06 * Math.max(0, Math.sin(loco.polePhase * TAU));
    } else target = p.crouching ? EYE.crouch : EYE.stand;
    if (loco.toggleT >= 0) {
      // Bend down to clip in / out.
      const k = Math.sin(Math.PI * clamp(loco.toggleT / SKI.toggleTime, 0, 1));
      target -= 0.45 * k;
      this.togglePitch = -0.55 * k;
    } else this.togglePitch = damp(this.togglePitch, 0, 10, dt);
    const lambda = p.mode === 'crashed' ? 8 : p.mode === 'dead' ? 2.2 : 10;
    this.eye = damp(this.eye, target, lambda, dt);

    // ---- landing dip spring
    const acc = -CAM.dipStiffness * this.dipY - CAM.dipDamping * this.dipV;
    this.dipV += acc * dt;
    this.dipY += this.dipV * dt;
    this.dipY = clamp(this.dipY, -0.6, 0.25);

    // ---- kick springs
    this.kickPV += (-120 * this.kickP - 16 * this.kickPV) * dt;
    this.kickP += this.kickPV * dt;
    this.kickRV += (-120 * this.kickR - 16 * this.kickRV) * dt;
    this.kickR += this.kickRV * dt;

    // ---- head bob (walking) synced to stride
    const hs = p.speed;
    let bobY = 0,
      bobX = 0;
    if (!p.onSkis && p.grounded && p.mode === 'walk' && !loco.sliding) {
      const amp = s.headBob ? lerp(CAM.bobWalk, CAM.bobSprint, smoothstep(1.8, 4.5, hs)) * smoothstep(0.2, 1.2, hs) * (p.crouching ? 0.6 : 1) : 0;
      this.bobAmp = damp(this.bobAmp, amp, 8, dt);
      const ph = (loco.stepIndex + loco.strideDist / Math.max(loco.strideLen, 0.1)) * Math.PI;
      bobY = -Math.abs(Math.sin(ph)) * this.bobAmp + this.bobAmp * 0.5;
      bobX = Math.cos(ph) * this.bobAmp * 0.45;
    } else {
      this.bobAmp = damp(this.bobAmp, 0, 8, dt);
      if (p.onSkis && loco.poling > 0.05 && s.headBob) bobY = -Math.max(0, Math.sin(loco.polePhase * TAU)) * 0.035 * loco.poling;
    }

    // ---- continuous shake from speed / skid / rough snow
    let sustained = 0;
    if (p.onSkis && p.grounded && (p.mode === 'ski')) {
      sustained = smoothstep(10, 42, hs) * 0.32 + loco.skid * 0.22 + (p.surface === 'rock' ? 0.25 * smoothstep(1, 8, hs) : 0);
      sustained += Math.min(0.2, Math.abs(loco.compression) * 0.01);
    }
    this.trauma = Math.max(0, this.trauma - dt * 1.1);
    const tr = Math.min(1, Math.max(this.trauma, sustained)) * shakeScale;
    const tr2 = tr * tr;
    this.shakeT += dt * (18 + 20 * tr);
    const n = this.noise;
    const shP = n.noise(this.shakeT, 1.3) * CAM.maxShakeRot * tr2;
    const shY = n.noise(this.shakeT, 7.9) * CAM.maxShakeRot * tr2;
    const shR = n.noise(this.shakeT, 13.1) * CAM.maxShakeRot * tr2 * 1.3;
    const shPos = n.noise(this.shakeT * 1.3, 21.7) * CAM.maxShakePos * tr2;

    // ---- carve lean + look sway
    const leanTarget = p.onSkis && (p.mode === 'ski' || p.mode === 'air') ? -p.carve * CAM.roll * smoothstep(2, 12, hs) : 0;
    this.roll = damp(this.roll, leanTarget, 6, dt);
    this.sway = damp(this.sway, 0, 6, dt);

    // ---- FOV kick with speed
    const kick = p.onSkis ? smoothstep(CAM.fovKickSpeed[0], CAM.fovKickSpeed[1], p.velocity.length()) * CAM.fovKick : p.sprinting ? 2.5 : 0;
    this.fov = damp(this.fov, s.fov + kick, 3, dt);
    if (Math.abs(camera.fov - this.fov) > 0.01) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    }

    // ---- crash tumble
    let tumbleP = 0,
      tumbleR = 0;
    if (p.mode === 'crashed') {
      if (this.tumble <= 0) this.startTumble(loco.crashSpin);
      this.tumble += dt;
      const t = this.tumble;
      // One forward somersault that decelerates, then a rolling wobble while sliding.
      const flip = 1 - Math.pow(1 - clamp(t / 0.85, 0, 1), 3);
      tumbleP = -flip * TAU * (loco.crashSpin > 0 ? 1 : -0.5);
      const wob = Math.exp(-t * 2.2);
      tumbleR = this.tumbleRoll * Math.sin(t * 7) * wob + this.tumbleRoll * 0.35 * (1 - wob) * smoothstep(0, 0.4, t);
      // Settle back upright during the get-up.
      const rise = smoothstep(SKI.crashTime - 0.5, SKI.crashTime, loco.crashT);
      tumbleR *= 1 - rise;
    } else if (this.tumble > 0) {
      this.tumble = 0;
    }

    // ---- death camera: fall to the snow, tilt over, drift
    let deathR = 0,
      deathP = 0,
      deathYaw = 0;
    if (p.mode === 'dead') {
      if (this.deadT < 0) {
        this.deadT = 0;
        this.deadRoll = Math.random() < 0.5 ? -1 : 1;
      }
      this.deadT += dt;
      const t = this.deadT;
      const fall = smoothstep(0, 1.6, t);
      deathR = this.deadRoll * 1.25 * fall;
      deathP = -0.25 * fall + Math.sin(t * 0.35) * 0.03;
      this.deadYaw += dt * 0.02 * fall;
      deathYaw = this.deadYaw;
    } else {
      this.deadT = -1;
      this.deadYaw = 0;
    }

    // ---- compose
    const feetY = p.mode === 'dead' || p.mode === 'crashed' ? p.position.y : this.absorbedFeetY(dt, p.position.y);
    if (p.mode === 'dead' || p.mode === 'crashed') this.headInit = false;
    const eyeY = feetY + this.eye + this.dipY + bobY + shPos;
    camera.position.set(p.position.x, eyeY, p.position.z);
    if (bobX !== 0) {
      camera.position.x += Math.cos(p.yaw) * bobX;
      camera.position.z += -Math.sin(p.yaw) * bobX;
    }
    // Never let the eye sink into the snow (death, tumbles, steep ground).
    const gy = terrain.heightAt(camera.position.x, camera.position.z);
    if (camera.position.y < gy + 0.18) camera.position.y = gy + 0.18;

    const pitch = clamp(p.pitch + this.togglePitch, -CAM.pitchLimit, CAM.pitchLimit) + this.kickP + shP + tumbleP + deathP;
    camera.rotation.set(pitch, p.yaw + shY + deathYaw, this.roll + this.kickR + shR + tumbleR + deathR + this.sway, 'YXZ');
  }
}
