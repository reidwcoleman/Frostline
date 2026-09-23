// Small CPU particle pools rendered as THREE.Points: snow bursts, wood/stone chips, fire embers,
// sparks and smoke. Fixed capacity, swap-remove, no per-frame allocation.
import * as THREE from 'three';
import type { GameContext } from '../core/types';

export interface SpawnOpts {
  vx?: number;
  vy?: number;
  vz?: number;
  life: number;
  size: number;
  r: number;
  g: number;
  b: number;
  a?: number;
  /** Gravity multiplier (1 = 9.81 m/s² down, negative = buoyant). */
  gravity?: number;
  /** Linear drag per second. */
  drag?: number;
  /** Size growth per second (m/s). */
  grow?: number;
  /** 0 = hard disc (chips), 1 = soft gaussian puff. */
  soft?: number;
  /** How strongly the wind carries it (0..1). */
  wind?: number;
  /** Stop on the ground (terrain) instead of falling through. */
  collide?: boolean;
}

const VERT = /* glsl */ `
  attribute vec4 aColor;
  attribute float aSize;
  attribute float aSoft;
  uniform float uScale;
  varying vec4 vColor;
  varying float vSoft;
  varying float vFade;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float d = max(-mv.z, 0.05);
    gl_PointSize = clamp(aSize * uScale / d, 1.0, 360.0);
    vColor = aColor;
    vSoft = aSoft;
    // Fade out particles that are very close to the camera (no giant blobs) and far away (cheap fog).
    vFade = smoothstep(0.15, 0.7, d) * (1.0 - smoothstep(250.0, 600.0, d));
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uLight;
  uniform float uAdditive;
  varying vec4 vColor;
  varying float vSoft;
  varying float vFade;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(c, c);
    if (r2 > 1.0) discard;
    float hard = 1.0 - smoothstep(0.7, 1.0, r2);
    float soft = exp(-r2 * 3.2) * (1.0 - r2);
    float a = mix(hard, soft, vSoft) * vColor.a * vFade;
    vec3 col = uAdditive > 0.5 ? vColor.rgb : vColor.rgb * uLight;
    gl_FragColor = vec4(col * (uAdditive > 0.5 ? a : 1.0), uAdditive > 0.5 ? 1.0 : a);
  }
`;

export class ParticlePool {
  readonly points: THREE.Points;
  private n = 0;
  private pos: Float32Array;
  private vel: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private soft: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private alpha0: Float32Array;
  private gravity: Float32Array;
  private drag: Float32Array;
  private grow: Float32Array;
  private windK: Float32Array;
  private collide: Uint8Array;
  private geo: THREE.BufferGeometry;
  private material: THREE.ShaderMaterial;

  constructor(private ctx: GameContext, readonly capacity: number, additive: boolean) {
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 4);
    this.size = new Float32Array(capacity);
    this.soft = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.alpha0 = new Float32Array(capacity);
    this.gravity = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.grow = new Float32Array(capacity);
    this.windK = new Float32Array(capacity);
    this.collide = new Uint8Array(capacity);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSoft', new THREE.BufferAttribute(this.soft, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uScale: { value: 800 },
        uLight: { value: new THREE.Color(1, 1, 1) },
        uAdditive: { value: additive ? 1 : 0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 6 : 5;
  }

  get count() {
    return this.n;
  }

  spawn(x: number, y: number, z: number, o: SpawnOpts) {
    let i = this.n;
    if (i >= this.capacity) {
      // Recycle the oldest-ish particle (index 0) rather than dropping new effects.
      i = (Math.random() * this.capacity) | 0;
    } else this.n++;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = o.vx ?? 0;
    this.vel[i * 3 + 1] = o.vy ?? 0;
    this.vel[i * 3 + 2] = o.vz ?? 0;
    this.col[i * 4] = o.r;
    this.col[i * 4 + 1] = o.g;
    this.col[i * 4 + 2] = o.b;
    this.col[i * 4 + 3] = o.a ?? 1;
    this.alpha0[i] = o.a ?? 1;
    this.size[i] = o.size;
    this.soft[i] = o.soft ?? 1;
    this.life[i] = o.life;
    this.maxLife[i] = o.life;
    this.gravity[i] = o.gravity ?? 1;
    this.drag[i] = o.drag ?? 0.5;
    this.grow[i] = o.grow ?? 0;
    this.windK[i] = o.wind ?? 0;
    this.collide[i] = o.collide ? 1 : 0;
  }

  update(dt: number, light: THREE.Color) {
    const { camera, renderer, env, terrain } = this.ctx;
    const h = renderer.domElement.height;
    this.material.uniforms.uScale.value = (h * 0.5) / Math.tan((camera.fov * Math.PI) / 360);
    (this.material.uniforms.uLight.value as THREE.Color).copy(light);
    const wx = env.wind.x,
      wz = env.wind.z;
    let i = 0;
    while (i < this.n) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.kill(i);
        continue;
      }
      const k = i * 3;
      const drag = Math.exp(-this.drag[i] * dt);
      const wk = this.windK[i];
      this.vel[k] = (this.vel[k] - wx * wk) * drag + wx * wk;
      this.vel[k + 2] = (this.vel[k + 2] - wz * wk) * drag + wz * wk;
      this.vel[k + 1] = this.vel[k + 1] * drag - 9.81 * this.gravity[i] * dt;
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] += this.vel[k + 1] * dt;
      this.pos[k + 2] += this.vel[k + 2] * dt;
      if (this.collide[i]) {
        const gy = terrain.heightAt(this.pos[k], this.pos[k + 2]);
        if (this.pos[k + 1] < gy + 0.02) {
          this.pos[k + 1] = gy + 0.02;
          this.vel[k] *= 0.3;
          this.vel[k + 2] *= 0.3;
          this.vel[k + 1] = 0;
          this.gravity[i] = 0;
        }
      }
      this.size[i] += this.grow[i] * dt;
      const t = this.life[i] / this.maxLife[i];
      // Fade in quickly, fade out over the last 40% of life.
      const fin = Math.min(1, (1 - t) * 12);
      this.col[i * 4 + 3] = this.alpha0[i] * fin * Math.min(1, t / 0.4);
      i++;
    }
    this.geo.setDrawRange(0, this.n);
    if (this.n > 0) {
      (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (this.geo.attributes.aColor as THREE.BufferAttribute).needsUpdate = true;
      (this.geo.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
      (this.geo.attributes.aSoft as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  private kill(i: number) {
    const last = --this.n;
    if (i === last) return;
    const k = i * 3,
      l = last * 3;
    this.pos[k] = this.pos[l];
    this.pos[k + 1] = this.pos[l + 1];
    this.pos[k + 2] = this.pos[l + 2];
    this.vel[k] = this.vel[l];
    this.vel[k + 1] = this.vel[l + 1];
    this.vel[k + 2] = this.vel[l + 2];
    for (let c = 0; c < 4; c++) this.col[i * 4 + c] = this.col[last * 4 + c];
    this.size[i] = this.size[last];
    this.soft[i] = this.soft[last];
    this.life[i] = this.life[last];
    this.maxLife[i] = this.maxLife[last];
    this.alpha0[i] = this.alpha0[last];
    this.gravity[i] = this.gravity[last];
    this.drag[i] = this.drag[last];
    this.grow[i] = this.grow[last];
    this.windK[i] = this.windK[last];
    this.collide[i] = this.collide[last];
  }

  clear() {
    this.n = 0;
    this.geo.setDrawRange(0, 0);
  }
}

/** The survival module's effect library, built on two pools (lit alpha + additive glow). */
export class Effects {
  readonly lit: ParticlePool;
  readonly glow: ParticlePool;
  private light = new THREE.Color();

  constructor(private ctx: GameContext) {
    this.lit = new ParticlePool(ctx, 3000, false);
    this.glow = new ParticlePool(ctx, 1200, true);
  }

  init() {
    this.ctx.scene.add(this.lit.points, this.glow.points);
  }

  update(dt: number) {
    const env = this.ctx.env;
    // Particles are unlit sprites: approximate sky ambient + sun so snow puffs match the scene.
    const d = env.daylight;
    this.light.setRGB(0.12 + 0.95 * d, 0.14 + 0.95 * d, 0.2 + 0.95 * d);
    this.light.r += env.sunColor.r * 0.25 * d;
    this.light.g += env.sunColor.g * 0.25 * d;
    this.light.b += env.sunColor.b * 0.25 * d;
    this.lit.update(dt, this.light);
    this.glow.update(dt, this.light);
  }

  clear() {
    this.lit.clear();
    this.glow.clear();
  }

  /** Powdery snow cloud (tree impact, felling, collecting). */
  snowBurst(x: number, y: number, z: number, count: number, spread: number, up = 1.5, heavy = false) {
    const k = heavy ? 1 : 0;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * spread;
      const s = (0.8 + Math.random() * 1.2) * (1 + k * 0.6);
      this.lit.spawn(x + Math.cos(a) * r * 0.5, y + Math.random() * 0.4, z + Math.sin(a) * r * 0.5, {
        vx: Math.cos(a) * s * (0.6 + Math.random()),
        vy: up * (0.3 + Math.random()),
        vz: Math.sin(a) * s * (0.6 + Math.random()),
        life: (1.0 + Math.random() * 1.2) * (1 + k * 1.2),
        size: (0.25 + Math.random() * 0.35) * (1 + k * 0.8),
        grow: (0.35 + Math.random() * 0.4) * (1 + k),
        r: 0.8,
        g: 0.83,
        b: 0.88,
        a: heavy ? 0.5 : 0.38,
        gravity: 0.03,
        drag: 1.6,
        soft: 1,
        wind: 0.5,
      });
    }
  }

  /** Snow shaken off branches: falls from the crown as fine flakes + a few clumps. */
  snowShake(x: number, y0: number, y1: number, z: number, radius: number, count: number) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const h = y0 + Math.random() * (y1 - y0);
      const r = radius * (0.3 + Math.random() * 0.7) * (1 - (h - y0) / Math.max(1, y1 - y0) * 0.6);
      const clump = Math.random() < 0.25;
      this.lit.spawn(x + Math.cos(a) * r, h, z + Math.sin(a) * r, {
        vx: (Math.random() - 0.5) * 0.6,
        vy: -0.5 - Math.random(),
        vz: (Math.random() - 0.5) * 0.6,
        life: 1.6 + Math.random() * 1.4,
        size: clump ? 0.12 + Math.random() * 0.1 : 0.05 + Math.random() * 0.05,
        grow: clump ? 0.15 : 0.02,
        r: 0.95,
        g: 0.97,
        b: 1,
        a: clump ? 0.9 : 0.8,
        gravity: clump ? 0.45 : 0.12,
        drag: clump ? 0.4 : 1.8,
        soft: clump ? 0.6 : 0.3,
        wind: 0.4,
        collide: true,
      });
    }
  }

  /** Chips flying off a hit (wood or stone). */
  chips(x: number, y: number, z: number, nx: number, ny: number, nz: number, count: number, wood: boolean) {
    for (let i = 0; i < count; i++) {
      const s = 2 + Math.random() * 3;
      const c = wood ? 0.55 + Math.random() * 0.3 : 0.35 + Math.random() * 0.25;
      this.lit.spawn(x, y, z, {
        vx: nx * s + (Math.random() - 0.5) * 2.5,
        vy: ny * s + 1 + Math.random() * 2,
        vz: nz * s + (Math.random() - 0.5) * 2.5,
        life: 0.9 + Math.random() * 0.8,
        size: 0.025 + Math.random() * 0.035,
        r: wood ? c * 1.25 : c,
        g: wood ? c * 0.95 : c,
        b: wood ? c * 0.65 : c * 1.02,
        a: 1,
        gravity: 1,
        drag: 0.3,
        soft: 0,
        collide: true,
      });
    }
  }

  /** Rising embers from a fire. */
  ember(x: number, y: number, z: number, strength: number) {
    const hot = Math.random();
    this.glow.spawn(x + (Math.random() - 0.5) * 0.4, y, z + (Math.random() - 0.5) * 0.4, {
      vx: (Math.random() - 0.5) * 0.6,
      vy: 1.2 + Math.random() * 1.6 * strength,
      vz: (Math.random() - 0.5) * 0.6,
      life: 0.8 + Math.random() * 1.6,
      size: 0.02 + Math.random() * 0.025,
      r: 1.6,
      g: 0.55 + hot * 0.45,
      b: 0.12 + hot * 0.1,
      a: 1,
      gravity: -0.02,
      drag: 0.6,
      soft: 0.2,
      wind: 0.35,
    });
  }

  /** Burst of sparks (adding a log, lighting). */
  sparks(x: number, y: number, z: number, count: number) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 0.5 + Math.random() * 2;
      this.glow.spawn(x, y, z, {
        vx: Math.cos(a) * s,
        vy: 2 + Math.random() * 3,
        vz: Math.sin(a) * s,
        life: 0.6 + Math.random() * 1.2,
        size: 0.025 + Math.random() * 0.02,
        r: 1.8,
        g: 0.8,
        b: 0.25,
        a: 1,
        gravity: 0.25,
        drag: 0.9,
        soft: 0.2,
        wind: 0.2,
      });
    }
  }

  /** Soft smoke puff drifting with the wind. */
  smoke(x: number, y: number, z: number, strength: number, dark = 0.4) {
    const g = dark + Math.random() * 0.12;
    // Buoyant, thinning column that bends downwind.
    this.lit.spawn(x + (Math.random() - 0.5) * 0.3, y, z + (Math.random() - 0.5) * 0.3, {
      vx: (Math.random() - 0.5) * 0.25,
      vy: 0.9 + Math.random() * 0.6,
      vz: (Math.random() - 0.5) * 0.25,
      life: 5 + Math.random() * 3.5,
      size: 0.28 + Math.random() * 0.2,
      grow: 0.45 + Math.random() * 0.35,
      r: g,
      g: g,
      b: g * 1.05,
      a: 0.075 * strength,
      gravity: -0.012,
      drag: 0.22,
      soft: 1,
      wind: 0.35,
    });
  }

  /** Warm breath vapour in front of the face when it's cold. */
  breath(x: number, y: number, z: number, dx: number, dz: number) {
    for (let i = 0; i < 5; i++) {
      this.lit.spawn(x + dx * 0.35, y - 0.12, z + dz * 0.35, {
        vx: dx * (0.5 + Math.random() * 0.4) + (Math.random() - 0.5) * 0.15,
        vy: 0.05 + Math.random() * 0.1,
        vz: dz * (0.5 + Math.random() * 0.4) + (Math.random() - 0.5) * 0.15,
        life: 0.9 + Math.random() * 0.6,
        size: 0.06 + Math.random() * 0.05,
        grow: 0.35,
        r: 0.95,
        g: 0.97,
        b: 1,
        a: 0.12,
        gravity: -0.01,
        drag: 1.8,
        soft: 1,
        wind: 0.3,
      });
    }
  }
}
