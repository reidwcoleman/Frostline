// Spindrift: wind-blown snow wisps skimming the ground. A few hundred soft, streaky ribbons hug the
// terrain around the player and stream downwind; they appear as the wind picks up and thicken into a
// ground blizzard in storms. One instanced draw; CPU keeps them glued to the terrain.
import * as THREE from 'three';
import type { GameContext } from '../core/types';
import { clamp, smoothstep } from '../core/math';

const MAX = 260;
const RADIUS = 75;

const VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec4 aInst;  // xyz: world position of the ribbon base, w: size
attribute vec4 aInst2; // x: alpha, y: seed, z: stretch
uniform vec3 uWindDir; // unit, horizontal
varying vec2 vUv;
varying float vA;
varying float vSeed;
void main() {
  // Ribbon lies along the wind, faces the camera around the wind axis.
  vec3 along = uWindDir;
  vec3 toCam = normalize( cameraPosition - aInst.xyz );
  vec3 side = normalize( cross( along, vec3( 0.0, 1.0, 0.0 ) ) );
  vec3 up = normalize( cross( side, along ) );
  // blend "up" toward camera-facing so ribbons don't vanish edge-on
  vec3 n = normalize( toCam - along * dot( toCam, along ) );
  vec3 h = normalize( mix( up, cross( n, along ) * sign( dot( cross( n, along ), up ) + 1e-4 ), 0.5 ) );
  float len = aInst.w * aInst2.z;
  float hgt = aInst.w * 0.22;
  vec3 world = aInst.xyz + along * position.x * len + h * ( position.y * 0.5 + 0.5 ) * hgt;
  vec4 mvPosition = viewMatrix * vec4( world, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  vUv = vec2( position.x * 0.5 + 0.5, position.y * 0.5 + 0.5 );
  vA = aInst2.x;
  vSeed = aInst2.y;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform sampler2D uNoise;
uniform vec3 uColor;
uniform float uTime;
varying vec2 vUv;
varying float vA;
varying float vSeed;
void main() {
  vec2 uv = vUv;
  // streaky noise flowing along the ribbon
  float n1 = texture2D( uNoise, vec2( uv.x * 0.9 - uTime * 0.55 + vSeed, uv.y * 0.35 + vSeed * 3.1 ) ).r;
  float n2 = texture2D( uNoise, vec2( uv.x * 2.3 - uTime * 1.1 + vSeed * 1.7, uv.y * 0.9 + vSeed ) ).a;
  float wisp = smoothstep( 0.35, 0.95, n1 * 0.7 + n2 * 0.5 );
  float edge = smoothstep( 0.0, 0.25, uv.x ) * ( 1.0 - smoothstep( 0.7, 1.0, uv.x ) );
  float vert = pow( 1.0 - uv.y, 1.6 ) * smoothstep( 0.0, 0.08, uv.y + 0.08 );
  float a = wisp * edge * vert * vA;
  if ( a < 0.004 ) discard;
  gl_FragColor = vec4( uColor, a );
  #include <fog_fragment>
}
`;

export class Spindrift {
  private mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private inst: THREE.InstancedBufferAttribute;
  private inst2: THREE.InstancedBufferAttribute;
  private life = new Float32Array(MAX);
  private maxLife = new Float32Array(MAX);
  private speed = new Float32Array(MAX);
  private surface = new Float32Array(MAX);
  private ready = false;

  constructor(private ctx: GameContext) {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.inst = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
    this.inst2 = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
    this.inst.setUsage(THREE.DynamicDrawUsage);
    this.inst2.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aInst', this.inst);
    g.setAttribute('aInst2', this.inst2);
    g.instanceCount = 0;
    this.mat = new THREE.ShaderMaterial({
      name: 'Spindrift',
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uWindDir: { value: new THREE.Vector3(1, 0, 0) },
          uColor: { value: new THREE.Color(1, 1, 1) },
          uTime: { value: 0 },
          uNoise: { value: null },
        },
      ]),
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 15;
    this.mesh.name = 'spindrift';
    ctx.scene.add(this.mesh);
  }

  private spawn(i: number, upwind: boolean) {
    const { camera, env, terrain } = this.ctx;
    const w = env.wind;
    const ws = Math.hypot(w.x, w.z) || 1;
    const dx = w.x / ws,
      dz = w.z / ws;
    let x: number, z: number;
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * RADIUS;
    x = camera.position.x + Math.cos(a) * r;
    z = camera.position.z + Math.sin(a) * r;
    if (upwind) {
      // enter from the upwind side so the stream looks continuous
      x -= dx * RADIUS * 0.6;
      z -= dz * RADIUS * 0.6;
    }
    const y = terrain.heightAt(x, z);
    const size = 5 + Math.random() * 9;
    this.inst.setXYZW(i, x, y - 0.15, z, size);
    this.inst2.setXYZW(i, 0, Math.random() * 10, 1.1 + Math.random() * 1.4, 0);
    this.life[i] = 0;
    this.maxLife[i] = 3 + Math.random() * 5;
    this.speed[i] = 0.8 + Math.random() * 0.5;
    this.surface[i] = terrain.slopeAngle(x, z) > 0.8 ? 0.25 : 1;
  }

  update(dt: number) {
    const { env, terrain, camera, sys } = this.ctx;
    if (!terrain) return;
    const storm = sys.weather.visual.storm;
    // Wind above ~6 m/s lifts loose snow; a blizzard is a wall of it.
    const ws = Math.hypot(env.wind.x, env.wind.z);
    const k = clamp(smoothstep(5.5, 13, ws) * 0.8 + storm * 0.5, 0, 1);
    const want = Math.floor(MAX * k * (0.4 + 0.6 * this.ctx.settings.quality.vegetationDensity));
    if (!this.ready) {
      for (let i = 0; i < MAX; i++) this.spawn(i, false);
      this.ready = true;
    }
    const g = this.mesh.geometry as THREE.InstancedBufferGeometry;
    g.instanceCount = want;
    this.mesh.visible = want > 0;
    if (!want) return;
    const dirx = env.wind.x / (ws || 1),
      dirz = env.wind.z / (ws || 1);
    this.mat.uniforms.uWindDir.value.set(dirx, 0, dirz);
    this.mat.uniforms.uTime.value = this.ctx.time * (0.4 + ws * 0.06);
    this.mat.uniforms.uNoise.value = sys.sky.noiseTexture;
    const c = this.mat.uniforms.uColor.value as THREE.Color;
    c.copy(env.groundColor).multiplyScalar(1.05);
    const cx = camera.position.x,
      cz = camera.position.z;
    for (let i = 0; i < want; i++) {
      this.life[i] += dt;
      const x = this.inst.getX(i) + env.wind.x * this.speed[i] * dt;
      const z = this.inst.getZ(i) + env.wind.z * this.speed[i] * dt;
      const ddx = x - cx,
        ddz = z - cz;
      if (this.life[i] > this.maxLife[i] || ddx * ddx + ddz * ddz > RADIUS * RADIUS * 1.2) {
        this.spawn(i, true);
        continue;
      }
      const y = terrain.heightAt(x, z) - 0.15;
      this.inst.setXYZ(i, x, y, z);
      const t = this.life[i] / this.maxLife[i];
      const fade = smoothstep(0, 0.2, t) * (1 - smoothstep(0.7, 1, t));
      // less drift off steep rock (little loose snow to lift)
      const alpha = fade * (0.16 + 0.34 * k) * this.surface[i];
      this.inst2.setX(i, alpha);
    }
    this.inst.needsUpdate = true;
    this.inst2.needsUpdate = true;
  }
}
