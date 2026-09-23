// Animated torch flame: a few camera-facing additive quads running a noise-driven flame
// shader (white-hot core, orange body, red licks), plus embers and smoke emitted into the
// shared effect pools, and a flickering light borrowed from the sky's light pool.
import * as THREE from 'three';

const VERT = /* glsl */ `
varying vec2 vUv;
uniform float uScale;
void main() {
  vUv = uv;
  // Cylindrical billboard: keep the flame upright, face the camera around Y.
  vec4 center = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec3 up = normalize((modelViewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  vec3 right = normalize(cross(up, vec3(0.0, 0.0, 1.0)));
  vec3 p = center.xyz + right * position.x * uScale + up * position.y * uScale;
  gl_Position = projectionMatrix * vec4(p, 1.0);
}`;

const FRAG = /* glsl */ `
varying vec2 vUv;
uniform float uTime;
uniform float uSeed;
uniform float uIntensity;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 11.7; a *= 0.5; }
  return v;
}
void main() {
  vec2 uv = vUv;
  float t = uTime * 2.6 + uSeed * 10.0;
  float n = fbm(vec2(uv.x * 3.2 + uSeed, uv.y * 2.4 - t));
  float n2 = fbm(vec2(uv.x * 6.0 - uSeed, uv.y * 5.0 - t * 1.7));
  float x = uv.x - 0.5 + (n - 0.5) * 0.34 * uv.y + sin(uv.y * 5.0 - t * 1.3) * 0.04 * uv.y;
  float h = uv.y + (n2 - 0.5) * 0.28;
  float width = mix(0.36, 0.015, pow(clamp(h, 0.0, 1.0), 0.75)) * smoothstep(-0.05, 0.12, uv.y);
  float d = abs(x) / max(width, 0.001);
  float body = smoothstep(1.0, 0.25, d) * smoothstep(0.98, 0.45, h) * smoothstep(0.0, 0.07, uv.y);
  float core = smoothstep(0.55, 0.0, d) * smoothstep(0.62, 0.05, h) * smoothstep(0.0, 0.1, uv.y);
  vec3 red = vec3(0.9, 0.16, 0.02);
  vec3 orange = vec3(1.0, 0.48, 0.08);
  vec3 yellow = vec3(1.0, 0.82, 0.42);
  vec3 col = mix(red, orange, smoothstep(0.1, 0.7, body));
  col = mix(col, yellow, core);
  col += vec3(1.0, 0.95, 0.85) * core * core * 0.6;
  float a = body;
  gl_FragColor = vec4(col * a * uIntensity, a);
}`;

export class TorchFlame {
  readonly group = new THREE.Group();
  private mats: THREE.ShaderMaterial[] = [];
  private emberT = 0;
  private smokeT = 0;
  flicker = 1;
  private seed = Math.random() * 10;

  constructor() {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.translate(0, 0.5, 0);
    // Three layered tongues of different size/seed for depth.
    const layers: [number, number, number][] = [
      [0.25, 0.0, 1.0],
      [0.19, 0.37, 1.15],
      [0.14, 0.73, 1.3],
    ];
    for (const [scale, seed, inten] of layers) {
      const m = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: { uTime: { value: 0 }, uSeed: { value: seed + this.seed }, uIntensity: { value: inten }, uScale: { value: scale } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      });
      const q = new THREE.Mesh(geo, m);
      q.frustumCulled = false;
      q.renderOrder = 10;
      this.mats.push(m);
      this.group.add(q);
    }
  }

  /** Advance the flame; emits embers/smoke at `world` through the provided callbacks. */
  update(dt: number, time: number, world: THREE.Vector3, windX: number, windZ: number, emitEmber: (x: number, y: number, z: number, vx: number, vy: number, vz: number) => void, emitSmoke: (x: number, y: number, z: number) => void) {
    for (const m of this.mats) m.uniforms.uTime.value = time;
    // Flicker: layered sines + noise-like wobble, used for the light too.
    const f = 0.82 + Math.sin(time * 13.1) * 0.06 + Math.sin(time * 23.7 + 1.3) * 0.05 + Math.sin(time * 5.3) * 0.07;
    this.flicker = f;
    this.group.scale.set(1, 0.92 + (f - 0.82) * 0.9, 1);
    this.emberT -= dt;
    if (this.emberT <= 0) {
      this.emberT = 0.05 + Math.random() * 0.12;
      emitEmber(world.x + (Math.random() - 0.5) * 0.05, world.y + 0.05 + Math.random() * 0.08, world.z + (Math.random() - 0.5) * 0.05, windX * 0.15 + (Math.random() - 0.5) * 0.4, 0.8 + Math.random() * 0.9, windZ * 0.15 + (Math.random() - 0.5) * 0.4);
    }
    this.smokeT -= dt;
    if (this.smokeT <= 0) {
      this.smokeT = 0.18 + Math.random() * 0.2;
      emitSmoke(world.x, world.y + 0.22, world.z);
    }
  }
}
