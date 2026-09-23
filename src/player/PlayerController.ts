// PLACEHOLDER player controller (owned by the player/skiing agent — replace freely).
// Basic walking with mouse look, gravity, tree/rock collision and a ?fly=1 noclip.
import * as THREE from 'three';
import type { GameContext, GameState, System } from '../core/types';
import { clamp } from '../core/math';

export class PlayerController implements System {
  readonly name = 'player';
  readonly updateWhen: GameState[] = ['playing', 'dead'];

  /** Camera-space root for first-person models (skis/poles/arms by the player module, weapons by combat). */
  readonly viewmodel = new THREE.Group();
  /** Anchor in the right hand where combat attaches the equipped weapon/tool/torch. */
  readonly rightHand = new THREE.Group();
  /** Anchor in the left hand (ski pole / bow grip). */
  readonly leftHand = new THREE.Group();

  constructor(private ctx: GameContext) {
    this.viewmodel.name = 'viewmodel';
    this.rightHand.position.set(0.28, -0.3, -0.5);
    this.leftHand.position.set(-0.28, -0.3, -0.5);
    this.viewmodel.add(this.rightHand, this.leftHand);
    ctx.camera.add(this.viewmodel);
  }

  update(dt: number) {
    const { input, player: p, physics, camera, settings, ui, dev } = this.ctx;
    const blocked = ui.blocking || !p.alive;
    if (!blocked) {
      const look = input.look(dt);
      const s = 0.0022 * settings.data.sensitivity;
      p.yaw -= look.x * s;
      p.pitch = clamp(p.pitch - look.y * s * (settings.data.invertY ? -1 : 1), -1.5, 1.5);
    }
    const mv = blocked ? { x: 0, y: 0 } : input.move();
    const fwd = new THREE.Vector3(-Math.sin(p.yaw), 0, -Math.cos(p.yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);

    if (dev.fly) {
      const speed = input.down('sprint') ? 120 : 30;
      const dir = p.lookDir().multiplyScalar(mv.y).addScaledVector(right, mv.x);
      p.position.addScaledVector(dir, speed * dt);
      p.velocity.set(0, 0, 0);
    } else {
      const speed = input.down('sprint') ? 6 : 3.2;
      const want = fwd.multiplyScalar(mv.y * speed).addScaledVector(right, mv.x * speed);
      p.velocity.x = want.x;
      p.velocity.z = want.z;
      p.velocity.y -= 9.81 * dt;
      if (p.grounded && input.pressed('jump') && !blocked) p.velocity.y = 4.2;
      p.position.addScaledVector(p.velocity, dt);
      physics.resolveCapsule(p.position, p.radius, p.height);
      const g = physics.groundProbe(p.position.x, p.position.y + 0.6, p.position.z);
      if (p.position.y <= g.y + 0.02) {
        p.position.y = g.y;
        p.velocity.y = Math.max(0, p.velocity.y);
        p.grounded = true;
      } else p.grounded = false;
    }
    camera.position.copy(p.eyePosition);
    camera.rotation.set(p.pitch, p.yaw, 0, 'YXZ');
  }
}
