// PLACEHOLDER sky + lighting (owned by the atmosphere agent — replace freely).
import * as THREE from 'three';
import type { GameContext, GameState, System } from '../core/types';

/** A pooled point light (fires, torches, flares). Pooling avoids shader recompiles. */
export interface LightHandle {
  light: THREE.PointLight;
  release(): void;
}

export const LIGHT_POOL_SIZE = 6;

export class Sky implements System {
  readonly name = 'sky';
  readonly updateWhen: GameState[] = ['menu', 'playing', 'paused', 'dead'];
  sun = new THREE.DirectionalLight(0xffffff, 3);
  hemi = new THREE.HemisphereLight(0xbfd6ff, 0xe8eef8, 1.1);

  private pool: THREE.PointLight[] = [];
  private used = new Set<THREE.PointLight>();

  constructor(private ctx: GameContext) {}

  /** Borrow a point light from the fixed pool (null if exhausted). Set colour/intensity/distance/position yourself. */
  acquireLight(): LightHandle | null {
    const light = this.pool.find((l) => !this.used.has(l));
    if (!light) return null;
    this.used.add(light);
    light.visible = true;
    return {
      light,
      release: () => {
        light.intensity = 0;
        light.visible = true;
        this.used.delete(light);
      },
    };
  }

  init() {
    const { scene } = this.ctx;
    for (let i = 0; i < LIGHT_POOL_SIZE; i++) {
      const l = new THREE.PointLight(0xff9a50, 0, 18, 2);
      this.pool.push(l);
      scene.add(l);
    }
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const c = this.sun.shadow.camera;
    c.left = c.bottom = -120;
    c.right = c.top = 120;
    c.near = 1;
    c.far = 1200;
    this.sun.shadow.bias = -0.0005;
    scene.add(this.sun, this.sun.target, this.hemi);
    scene.fog = new THREE.Fog(0xcfdcea, 200, 3500);
    scene.background = new THREE.Color(0x9fc2e6);
  }

  update() {
    const { env, clock, camera, scene } = this.ctx;
    const h = clock.time;
    const ang = ((h - 6) / 24) * Math.PI * 2; // sunrise at 6, noon at 12
    env.sunDir.set(Math.cos(ang) * 0.7, Math.sin(ang), 0.45).normalize();
    env.daylight = THREE.MathUtils.smoothstep(env.sunDir.y, -0.12, 0.2);
    this.sun.intensity = 3.2 * env.daylight + 0.05;
    this.hemi.intensity = 0.25 + 0.9 * env.daylight;
    this.sun.position.copy(camera.position).addScaledVector(env.sunDir, 500);
    this.sun.target.position.copy(camera.position);
    const day = new THREE.Color(0x9fc2e6),
      night = new THREE.Color(0x0a1220);
    (scene.background as THREE.Color).copy(night).lerp(day, env.daylight);
    (scene.fog as THREE.Fog).color.copy(night).lerp(new THREE.Color(0xcfdcea), env.daylight);
  }
}
