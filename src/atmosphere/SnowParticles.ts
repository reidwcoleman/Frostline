// Falling snow around the camera: one instanced draw of soft flakes in a wrapping box that is fixed in
// world space (so flakes stream past as you move). Flakes stretch into streaks along their motion
// relative to the camera (fast skiing, blizzard gales), fade near the lens, and are fogged like
// everything else. Density follows ctx.env.snowfall by hiding a fraction of the pool — no reallocations.
import * as THREE from 'three';
import type { GameContext } from '../core/types';
import { clamp, smoothstep } from '../core/math';

const MAX = 16000;
const _tmp = new THREE.Vector3();
const _col = new THREE.Color();
const BOX = 34; // metres, box edge

const VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec4 aSeed;   // xyz: position in box (0..1), w: random
uniform vec3 uCam;
uniform vec3 uOffset;   // shared displacement (fall + wind), wraps
uniform vec3 uRelVel;   // flake velocity minus camera velocity (m/s)
uniform float uBox;
uniform float uDensity; // 0..1 fraction of flakes shown
uniform float uSize;
uniform float uStreak;  // seconds of motion smeared into each flake
uniform float uTime;
varying vec2 vQuad;
varying float vAlpha;
varying float vStretch;
void main() {
  float w = aSeed.w;
  float visible = step( w, uDensity );
  // speed classes so the shared offset can wrap without popping
  float k = 0.8 + 0.1 * floor( fract( w * 7.31 ) * 5.0 );
  vec3 p = aSeed.xyz * uBox + uOffset * k;
  // little flutter per flake
  float ph = w * 61.0;
  p.x += sin( uTime * ( 1.1 + w ) + ph ) * 0.35;
  p.z += cos( uTime * ( 0.9 + w * 0.7 ) + ph * 1.3 ) * 0.35;
  vec3 rel = mod( p - uCam + 0.5 * uBox, uBox ) - 0.5 * uBox;
  vec3 world = uCam + rel;
  vec4 mvCenter = viewMatrix * vec4( world, 1.0 );
  // screen-space streak direction from the relative motion
  vec3 vel = ( mat3( viewMatrix ) * ( uRelVel * k ) ) * uStreak;
  vec2 axis = vel.xy;
  float len = length( axis );
  float size = uSize * ( 0.6 + 0.8 * fract( w * 13.7 ) );
  vec2 dir = len > 1e-4 ? axis / len : vec2( 0.0, 1.0 );
  vec2 perp = vec2( - dir.y, dir.x );
  float along = max( len * 0.5, size );
  vec2 off = dir * position.y * along + perp * position.x * size;
  vec4 mvPosition = mvCenter + vec4( off, 0.0, 0.0 );
  vStretch = along / size;
  vQuad = position.xy;
  float dist = length( rel );
  vAlpha = visible * smoothstep( 0.35, 1.6, dist ) * ( 1.0 - smoothstep( uBox * 0.36, uBox * 0.5, dist ) );
  // long streaks spread the same light over more pixels
  vAlpha /= mix( 1.0, vStretch, 0.6 );
  gl_Position = projectionMatrix * mvPosition;
  if ( visible < 0.5 ) gl_Position = vec4( 0.0, 0.0, 2.0, 1.0 );
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vQuad;
varying float vAlpha;
varying float vStretch;
void main() {
  // soft round flake / capsule streak
  vec2 q = vQuad;
  float r = length( q );
  // (GLSL smoothstep needs edge0 < edge1 — reversed edges are undefined and return 0 on Metal)
  float a = ( 1.0 - smoothstep( 0.25, 1.0, r ) ) * vAlpha * uOpacity;
  if ( a < 0.003 ) discard;
  gl_FragColor = vec4( uColor, a );
  #include <fog_fragment>
}
`;

export class SnowParticles {
  private mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private offset = new THREE.Vector3();
  private prevCam = new THREE.Vector3();
  private camVel = new THREE.Vector3();
  private count = MAX;
  private first = true;

  constructor(private ctx: GameContext) {
    const base = new THREE.InstancedBufferGeometry();
    base.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    base.setIndex([0, 1, 2, 0, 2, 3]);
    const seeds = new Float32Array(MAX * 4);
    for (let i = 0; i < MAX; i++) {
      seeds[i * 4] = Math.random();
      seeds[i * 4 + 1] = Math.random();
      seeds[i * 4 + 2] = Math.random();
      seeds[i * 4 + 3] = Math.random();
    }
    base.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    base.instanceCount = MAX;
    this.mat = new THREE.ShaderMaterial({
      name: 'SnowFlakes',
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uCam: { value: new THREE.Vector3() },
          uOffset: { value: new THREE.Vector3() },
          uRelVel: { value: new THREE.Vector3() },
          uBox: { value: BOX },
          uDensity: { value: 0 },
          uSize: { value: 0.022 },
          uStreak: { value: 0.03 },
          uTime: { value: 0 },
          uColor: { value: new THREE.Color(1, 1, 1) },
          uOpacity: { value: 0.9 },
        },
      ]),
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: true,
    });
    this.mesh = new THREE.Mesh(base, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    this.mesh.name = 'snowfall';
    ctx.scene.add(this.mesh);
    this.applyQuality();
    ctx.events.on('settings', ({ key }) => key === 'quality' && this.applyQuality());
  }

  private applyQuality() {
    this.count = Math.min(MAX, this.ctx.settings.quality.snowParticles);
    (this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = this.count;
  }

  update(dt: number) {
    const { camera, env, sys } = this.ctx;
    const u = this.mat.uniforms;
    const snow = env.snowfall;
    this.mesh.visible = snow > 0.005;
    const cam = camera.position;
    if (this.first) {
      this.prevCam.copy(cam);
      this.first = false;
    }
    if (dt > 0) {
      const inst = _tmp.subVectors(cam, this.prevCam).divideScalar(Math.max(dt, 1e-3));
      if (inst.lengthSq() > 120 * 120) inst.set(0, 0, 0); // teleport
      this.camVel.lerp(inst, 1 - Math.exp(-dt * 12));
    }
    this.prevCam.copy(cam);
    if (!this.mesh.visible) return;

    const storm = sys.weather.visual.storm;
    // Flake velocity: fall + wind (heavier snow falls a bit faster; gales drive it sideways)
    const fall = 1.1 + 0.6 * snow;
    const vx = env.wind.x * (0.85 + 0.15 * storm),
      vz = env.wind.z * (0.85 + 0.15 * storm);
    this.offset.x += vx * dt;
    this.offset.y -= fall * dt;
    this.offset.z += vz * dt;
    const P = BOX * 10;
    this.offset.x %= P;
    this.offset.y %= P;
    this.offset.z %= P;
    u.uOffset.value.copy(this.offset);
    u.uCam.value.copy(cam);
    u.uRelVel.value.set(vx - this.camVel.x, -fall - this.camVel.y, vz - this.camVel.z);
    u.uTime.value = this.ctx.time;
    // Show a fraction of the pool: light snow is sparse, blizzards fill the box.
    u.uDensity.value = clamp(Math.pow(snow, 1.3) * 0.85 + storm * 0.15, 0, 1);
    u.uSize.value = 0.02 + 0.008 * snow;
    // Motion smear: ~1/30 s, longer at speed so skiing through snowfall streaks nicely.
    const rel = Math.hypot(vx - this.camVel.x, vz - this.camVel.z, -fall - this.camVel.y);
    u.uStreak.value = 0.028 + 0.02 * smoothstep(8, 25, rel);
    // Lit like small bright ice crystals: ambient sky + a share of the sun, brighter backlit.
    const sky = sys.sky;
    const c = u.uColor.value as THREE.Color;
    c.copy(sky.ambient).multiplyScalar(2.2).add(_col.copy(sky.lightColor).multiplyScalar(sky.lightIntensity * Math.max(sky.lightDir.y, 0.15) * 0.35 * (1 - sys.weather.visual.cloudCover * 0.8)));
    u.uOpacity.value = 0.85;
  }
}
