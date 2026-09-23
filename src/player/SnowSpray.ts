// Powder spray: skid fans, carve rooster tails, landing / crash bursts, pole-plant puffs.
// One Points draw call, fixed pool, CPU-integrated. Soft round sprites with the standard fog chunks.
import * as THREE from 'three';
import type { EnvState } from '../core/Env';

const MAX = 900;

const VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute float aSeed;
uniform float uScale;
varying float vAlpha;
varying float vSeed;
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = clamp(aSize * uScale / max(-mvPosition.z, 0.05), 1.0, 256.0);
  vAlpha = aAlpha;
  vSeed = aSeed;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uShade;
varying float vAlpha;
varying float vSeed;
#include <fog_pars_fragment>
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d) * 2.0;
  // Clumpy edge so puffs don't read as perfect discs.
  float ang = atan(d.y, d.x);
  float edge = 1.0 - 0.18 * (0.5 + 0.5 * sin(ang * 5.0 + vSeed * 30.0));
  float a = vAlpha * (1.0 - smoothstep(0.2, edge, r));
  if (a < 0.01) discard;
  // Volumetric look: lit from above, cool sky-blue underside (reads against white snow).
  float lit = clamp(0.5 - d.y * 1.2 + (1.0 - r) * 0.25, 0.0, 1.0);
  vec3 col = mix(uShade, uColor, lit) * (0.94 + 0.12 * vSeed);
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

export class SnowSpray {
  readonly points: THREE.Points;
  private geo = new THREE.BufferGeometry();
  private mat: THREE.ShaderMaterial;
  private pos = new Float32Array(MAX * 3);
  private size = new Float32Array(MAX);
  private alpha = new Float32Array(MAX);
  private seed = new Float32Array(MAX);
  private vel = new Float32Array(MAX * 3);
  private life = new Float32Array(MAX);
  private maxLife = new Float32Array(MAX);
  private baseSize = new Float32Array(MAX);
  private drag = new Float32Array(MAX);
  private grav = new Float32Array(MAX);
  private count = 0;
  private color = new THREE.Color();

  constructor() {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSeed', new THREE.BufferAttribute(this.seed, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uColor: { value: new THREE.Color(1, 1, 1) }, uShade: { value: new THREE.Color(0.6, 0.7, 0.85) }, uScale: { value: 500 } }]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.points.name = 'snowSpray';
  }

  /**
   * Emit `n` particles around (x, y, z) with base velocity (vx, vy, vz) + random spread (m/s).
   * size in meters, life in seconds.
   */
  emit(n: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, spread: number, size: number, life: number, posJitter = 0.1, drag = 2.2, gravity = 4.5) {
    for (let k = 0; k < n; k++) {
      if (this.count >= MAX) return;
      const i = this.count++;
      const j = i * 3;
      this.pos[j] = x + (Math.random() - 0.5) * posJitter * 2;
      this.pos[j + 1] = y + Math.random() * posJitter;
      this.pos[j + 2] = z + (Math.random() - 0.5) * posJitter * 2;
      this.vel[j] = vx + (Math.random() - 0.5) * 2 * spread;
      this.vel[j + 1] = vy + Math.random() * spread;
      this.vel[j + 2] = vz + (Math.random() - 0.5) * 2 * spread;
      const l = life * (0.6 + Math.random() * 0.8);
      this.life[i] = l;
      this.maxLife[i] = l;
      this.baseSize[i] = size * (0.5 + Math.random());
      this.drag[i] = drag * (0.7 + Math.random() * 0.6);
      this.seed[i] = Math.random();
      this.grav[i] = gravity;
    }
  }

  update(dt: number, env: EnvState, camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer) {
    // Lit approximately: sun-warm white by day, cool blue by night (matches the snow it came from).
    const day = env.daylight;
    this.color.setRGB(0.55 + 0.42 * day, 0.6 + 0.37 * day, 0.72 + 0.24 * day);
    (this.mat.uniforms.uColor.value as THREE.Color).copy(this.color);
    // Shadowed side: the cool shadow-snow blue (#9DB4D9-ish), darker at night.
    (this.mat.uniforms.uShade.value as THREE.Color).setRGB(0.3 + 0.28 * day, 0.36 + 0.33 * day, 0.5 + 0.34 * day);
    const h = renderer.domElement.height;
    this.mat.uniforms.uScale.value = h / (2 * Math.tan((camera.fov * Math.PI) / 360));

    let i = 0;
    while (i < this.count) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        // Swap-remove with the last live particle.
        const last = --this.count;
        if (i !== last) {
          const a = i * 3,
            b = last * 3;
          this.pos[a] = this.pos[b];
          this.pos[a + 1] = this.pos[b + 1];
          this.pos[a + 2] = this.pos[b + 2];
          this.vel[a] = this.vel[b];
          this.vel[a + 1] = this.vel[b + 1];
          this.vel[a + 2] = this.vel[b + 2];
          this.life[i] = this.life[last];
          this.maxLife[i] = this.maxLife[last];
          this.baseSize[i] = this.baseSize[last];
          this.drag[i] = this.drag[last];
          this.seed[i] = this.seed[last];
          this.grav[i] = this.grav[last];
        }
        continue;
      }
      const j = i * 3;
      const d = Math.exp(-this.drag[i] * dt);
      this.vel[j] *= d;
      this.vel[j + 1] = this.vel[j + 1] * d - this.grav[i] * dt; // dust floats, clumps arc
      this.vel[j + 2] *= d;
      this.pos[j] += this.vel[j] * dt + env.wind.x * 0.12 * dt;
      this.pos[j + 1] += this.vel[j + 1] * dt;
      this.pos[j + 2] += this.vel[j + 2] * dt + env.wind.z * 0.12 * dt;
      const t = 1 - this.life[i] / this.maxLife[i]; // 0 -> 1 over life
      this.alpha[i] = Math.min(1, t * 8) * (1 - t * t) * 0.9;
      this.size[i] = this.baseSize[i] * (0.6 + t * 1.4); // puffs expand as they disperse
      i++;
    }
    this.geo.setDrawRange(0, this.count);
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aSeed as THREE.BufferAttribute).needsUpdate = true;
  }

  clear() {
    this.count = 0;
    this.geo.setDrawRange(0, 0);
  }
}
