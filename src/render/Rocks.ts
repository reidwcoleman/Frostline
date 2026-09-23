// Boulders: a few shared, procedurally chiselled rock shapes (faceted granite blocks), instanced
// per type with two LODs. Snow caps come from the shader (world up-facing facets), so the same
// geometry reads right in any orientation. `rock:removed` hides a boulder.
import * as THREE from 'three';
import type { GameContext } from '../core/types';
import { hash2, mulberry32 } from '../core/math';
import { replaceInclude } from './shaders/lighting';

const TYPES = 3;
const CAP0 = 1500;
const CAP1 = 6000;

/** Smooth 3D value noise (deterministic, for mesh displacement only). */
function vnoise3(x: number, y: number, z: number, seed: number) {
  const xi = Math.floor(x),
    yi = Math.floor(y),
    zi = Math.floor(z);
  const fx = x - xi,
    fy = y - yi,
    fz = z - zi;
  const u = fx * fx * (3 - 2 * fx),
    v = fy * fy * (3 - 2 * fy),
    w = fz * fz * (3 - 2 * fz);
  const h = (i: number, j: number, k: number) => hash2(xi + i + (zi + k) * 7919, yi + j, seed) * 2 - 1;
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(
    l(l(h(0, 0, 0), h(1, 0, 0), u), l(h(0, 1, 0), h(1, 1, 0), u), v),
    l(l(h(0, 0, 1), h(1, 0, 1), u), l(h(0, 1, 1), h(1, 1, 1), u), v),
    w,
  );
}

export function buildRockGeometry(type: number, lod: number): THREE.BufferGeometry {
  const base = new THREE.IcosahedronGeometry(1, lod === 0 ? 3 : 1);
  const pos = base.attributes.position as THREE.BufferAttribute;
  const rng = mulberry32(700 + type * 31);
  // Planar cuts give the chiselled, fractured-granite look.
  const cuts: { n: THREE.Vector3; d: number }[] = [];
  const nc = 7 + type * 2;
  for (let k = 0; k < nc; k++) {
    const n = new THREE.Vector3(rng() * 2 - 1, rng() * 1.6 - 0.5, rng() * 2 - 1).normalize();
    cuts.push({ n, d: 0.62 + rng() * 0.3 });
  }
  const stretch = new THREE.Vector3(1 + type * 0.18, 0.8 - type * 0.08, 0.9);
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    const n1 = vnoise3(p.x * 1.6 + type * 3, p.y * 1.6, p.z * 1.6, 11 + type);
    const n2 = vnoise3(p.x * 4.1, p.y * 4.1 + type, p.z * 4.1, 23 + type);
    p.multiplyScalar(1 + n1 * 0.22 + n2 * 0.06);
    for (const c of cuts) {
      const dd = p.dot(c.n);
      if (dd > c.d) p.addScaledVector(c.n, -(dd - c.d) * 0.92);
    }
    p.multiply(stretch);
    // Settled base: flatten the bottom so it sits into the snow.
    if (p.y < -0.35) p.y = -0.35 + (p.y + 0.35) * 0.35;
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  base.computeVertexNormals();
  base.computeBoundingSphere();
  return base;
}

const ROCK_VERT_PARS = /* glsl */ `
varying vec3 vRW;
varying vec3 vRN;
varying float vRSeed;
`;
const ROCK_VERT = /* glsl */ `
#include <worldpos_vertex>
{
  mat4 rm = modelMatrix;
  #ifdef USE_INSTANCING
  rm = modelMatrix * instanceMatrix;
  #endif
  vRW = (rm * vec4(transformed, 1.0)).xyz;
  vRN = normalize(mat3(rm) * objectNormal);
  vRSeed = fract(sin(dot(rm[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
}
`;
const ROCK_FRAG_PARS = /* glsl */ `
uniform sampler2D uRockTex;
uniform sampler2D uNoiseTex;
uniform float uSnowCover;
varying vec3 vRW;
varying vec3 vRN;
varying float vRSeed;
float rSnow;
vec3 rN;
`;
const ROCK_FRAG_MAP = /* glsl */ `
{
  vec3 n = normalize(vRN);
  vec3 w = pow(abs(n), vec3(4.0));
  w /= w.x + w.y + w.z;
  const float sc = 1.0 / 3.5;
  vec4 tx = texture(uRockTex, vRW.zy * sc);
  vec4 ty = texture(uRockTex, vRW.xz * sc + 0.3);
  vec4 tz = texture(uRockTex, vRW.xy * sc + 0.6);
  vec2 gx = (tx.xy - 0.5) * 4.0, gy = (ty.xy - 0.5) * 4.0, gz = (tz.xy - 0.5) * 4.0;
  vec3 grad = w.x * vec3(0.0, gx.y, gx.x) + w.y * vec3(gy.x, 0.0, gy.y) + w.z * vec3(gz.x, gz.y, 0.0);
  rN = normalize(n - (grad - dot(grad, n) * n) * 0.6);
  float av = w.x * tx.w + w.y * ty.w + w.z * tz.w;
  float h = w.x * tx.z + w.y * ty.z + w.z * tz.z;
  vec3 cool = vec3(0.075, 0.075, 0.088);
  vec3 warm = vec3(0.11, 0.09, 0.072);
  vec3 rock = mix(cool, warm, vRSeed * 0.8) * (0.6 + 0.8 * av);
  float lichen = smoothstep(0.62, 0.78, texture(uNoiseTex, vRW.xz * 0.21 + vRW.y * 0.1).b);
  rock = mix(rock, vec3(0.16, 0.16, 0.1), lichen * 0.4 * (1.0 - smoothstep(0.3, 0.8, rN.y)));
  float nz = texture(uNoiseTex, vRW.xz * 0.37 + vRW.y * 0.2).r;
  float cap = rN.y + (nz - 0.5) * 0.5 + (h - 0.5) * 0.2;
  rSnow = smoothstep(0.42, 0.58, cap) * uSnowCover;
  // Rime / snow dust in crevices.
  rock = mix(rock, vec3(0.5, 0.52, 0.56), (1.0 - h) * 0.15);
  diffuseColor.rgb = mix(rock, vec3(0.84, 0.86, 0.9), rSnow);
}
`;

export function createRockMaterial(noise: THREE.Texture, rockTex: THREE.Texture, snowCover: THREE.IUniform<number>) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 });
  m.name = 'rock';
  const uniforms = { uRockTex: { value: rockTex }, uNoiseTex: { value: noise }, uSnowCover: snowCover };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    let vs = shader.vertexShader;
    vs = vs.replace('#include <common>', `#include <common>\n${ROCK_VERT_PARS}`);
    vs = replaceInclude(vs, 'worldpos_vertex', ROCK_VERT);
    shader.vertexShader = vs;
    let fs = shader.fragmentShader;
    fs = fs.replace('#include <common>', `#include <common>\n${ROCK_FRAG_PARS}`);
    fs = replaceInclude(fs, 'map_fragment', ROCK_FRAG_MAP);
    fs = replaceInclude(fs, 'roughnessmap_fragment', 'float roughnessFactor = mix(0.82, 0.9, rSnow);');
    fs = replaceInclude(fs, 'normal_fragment_maps', 'normal = normalize((viewMatrix * vec4(rN, 0.0)).xyz);');
    shader.fragmentShader = fs;
  };
  m.customProgramCacheKey = () => 'frostline-rock-1';
  return m;
}

export class Rocks {
  private mats: Float32Array;
  private lod0: THREE.InstancedMesh[] = [];
  private lod1: THREE.InstancedMesh[] = [];
  private dirty = true;
  private readonly last = new THREE.Vector3(1e9, 0, 0);
  private readonly lastQ = new THREE.Quaternion();
  private readonly frustum = new THREE.Frustum();
  private readonly proj = new THREE.Matrix4();
  private readonly cam = new THREE.Vector3();
  private readonly camQ = new THREE.Quaternion();
  private near = 70;
  private far = 650;

  constructor(private ctx: GameContext, parent: THREE.Object3D) {
    const t = ctx.sys.terrain.textures;
    const mat = createRockMaterial(t.noise, t.rock, ctx.sys.vegetation.shared.uSnowCover);
    for (let k = 0; k < TYPES; k++) {
      const a = new THREE.InstancedMesh(buildRockGeometry(k, 0), mat, CAP0);
      const b = new THREE.InstancedMesh(buildRockGeometry(k, 1), mat, CAP1);
      for (const im of [a, b]) {
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        im.count = 0;
        im.frustumCulled = false;
        im.receiveShadow = true;
        im.matrixAutoUpdate = false;
        parent.add(im);
      }
      a.castShadow = true;
      a.name = `rock${k}-lod0`;
      b.name = `rock${k}-lod1`;
      this.lod0.push(a);
      this.lod1.push(b);
    }
    const w = ctx.world;
    this.mats = new Float32Array(w.rockCount * 16);
    const m = new THREE.Matrix4(),
      q = new THREE.Quaternion(),
      p = new THREE.Vector3(),
      s = new THREE.Vector3(),
      e = new THREE.Euler();
    for (let i = 0; i < w.rockCount; i++) {
      const r = w.rockR[i];
      p.set(w.rockX[i], w.rockY[i], w.rockZ[i]);
      e.set((hash2(i, 1, 5) - 0.5) * 0.3, w.rockRot[i], (hash2(i, 2, 5) - 0.5) * 0.3);
      q.setFromEuler(e);
      s.set(r, r * (0.88 + 0.12 * hash2(i, 3, 5)), r);
      m.compose(p, q, s);
      m.toArray(this.mats, i * 16);
    }
    ctx.events.on('rock:removed', () => (this.dirty = true));
    const q2 = ctx.settings.quality;
    this.far = Math.max(350, q2.treeDrawDistance * 2);
  }

  restore() {
    this.dirty = true;
  }

  update() {
    const { camera } = this.ctx;
    camera.getWorldPosition(this.cam);
    camera.getWorldQuaternion(this.camQ);
    if (!this.dirty && this.cam.distanceToSquared(this.last) < 4 && this.camQ.angleTo(this.lastQ) < 0.02) return;
    this.dirty = false;
    this.last.copy(this.cam);
    this.lastQ.copy(this.camQ);
    camera.updateMatrixWorld();
    this.proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.proj);
    const planes = this.frustum.planes;
    const w = this.ctx.world;
    const c0 = [0, 0, 0],
      c1 = [0, 0, 0];
    const cx = this.cam.x,
      cy = this.cam.y,
      cz = this.cam.z;
    const near2 = this.near * this.near,
      far2 = this.far * this.far;
    w.forEachRock(cx, cz, this.far, (i) => {
      const x = w.rockX[i],
        y = w.rockY[i],
        z = w.rockZ[i],
        r = w.rockR[i] * 1.3;
      const d2 = (x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2;
      if (d2 > far2) return;
      for (let k = 0; k < 6; k++) {
        const pl = planes[k];
        if (pl.normal.x * x + pl.normal.y * y + pl.normal.z * z + pl.constant < -r) return;
      }
      const t = w.rockType[i] % TYPES;
      // Big boulders keep full detail further out.
      const lod0 = d2 < near2 * (1 + w.rockR[i] * 0.6);
      if (lod0) {
        if (c0[t] < CAP0) copy16(this.mats, i, this.lod0[t].instanceMatrix.array as Float32Array, c0[t]++);
      } else if (c1[t] < CAP1) copy16(this.mats, i, this.lod1[t].instanceMatrix.array as Float32Array, c1[t]++);
    });
    for (let t = 0; t < TYPES; t++) {
      setCount(this.lod0[t], c0[t]);
      setCount(this.lod1[t], c1[t]);
    }
  }
}

function copy16(src: Float32Array, i: number, dst: Float32Array, k: number) {
  const o = i * 16,
    p = k * 16;
  for (let j = 0; j < 16; j++) dst[p + j] = src[o + j];
}

function setCount(im: THREE.InstancedMesh, n: number) {
  im.count = n;
  im.visible = n > 0;
  if (n) {
    im.instanceMatrix.clearUpdateRanges();
    im.instanceMatrix.addUpdateRange(0, n * 16);
    im.instanceMatrix.needsUpdate = true;
  }
}
