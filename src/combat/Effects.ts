// Impact feedback: small fixed pools, no allocations per frame.
//  - debris: instanced lit chips (wood, stone, snow clumps, blood droplets) with gravity, spin
//    and a rest on the ground before they shrink away. Blood droplets leave stains where they land.
//  - puffs: camera-facing soft sprites (snow puffs, blood mist, smoke) with per-instance alpha.
//  - sparks: additive sprites (steel on stone, torch embers).
//  - stains: blood decals lying on the snow, fading slowly.
// Materials are built-in (Basic/Standard) patched via onBeforeCompile so the atmosphere agent's
// fog + lighting chunks apply unchanged.
import * as THREE from 'three';
import type { GameContext } from '../core/types';
import { clamp } from '../core/math';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _e = new THREE.Euler();
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

function softTexture(kind: 'soft' | 'blotch'): THREE.CanvasTexture {
  const S = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d')!;
  if (kind === 'soft') {
    const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.45, 'rgba(255,255,255,0.55)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, S, S);
  } else {
    // Irregular splat: a few overlapping soft blobs.
    g.clearRect(0, 0, S, S);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 14; i++) {
      const r = i === 0 ? S * 0.3 : S * (0.05 + rnd() * 0.12);
      const a = rnd() * Math.PI * 2,
        d = i === 0 ? 0 : S * (0.12 + rnd() * 0.26);
      const x = S / 2 + Math.cos(a) * d,
        y = S / 2 + Math.sin(a) * d;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, 'rgba(255,255,255,0.95)');
      gr.addColorStop(0.7, 'rgba(255,255,255,0.8)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

// ---------------------------------------------------------------------------- sprites
class SpritePool {
  readonly mesh: THREE.Mesh;
  private pos: Float32Array;
  private col: Float32Array;
  private sr: Float32Array;
  private posA: THREE.InstancedBufferAttribute;
  private colA: THREE.InstancedBufferAttribute;
  private srA: THREE.InstancedBufferAttribute;
  private vel: Float32Array;
  private life: Float32Array;
  private age: Float32Array;
  private grow: Float32Array;
  private base: Float32Array; // base rgba
  private drag: Float32Array;
  private grav: Float32Array;
  private next = 0;
  private live = 0;

  constructor(readonly max: number, additive: boolean, map: THREE.Texture) {
    const g = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    g.index = quad.index;
    g.setAttribute('position', quad.getAttribute('position'));
    g.setAttribute('uv', quad.getAttribute('uv'));
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.sr = new Float32Array(max * 2);
    this.posA = new THREE.InstancedBufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.colA = new THREE.InstancedBufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    this.srA = new THREE.InstancedBufferAttribute(this.sr, 2).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', this.posA);
    g.setAttribute('iCol', this.colA);
    g.setAttribute('iSR', this.srA);
    g.instanceCount = 0;
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.age = new Float32Array(max);
    this.grow = new Float32Array(max);
    this.base = new Float32Array(max * 4);
    this.drag = new Float32Array(max);
    this.grav = new Float32Array(max);
    const mat = new THREE.MeshBasicMaterial({
      map,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: true,
    });
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 iPos;\nattribute vec4 iCol;\nattribute vec2 iSR;\nvarying vec4 vPC;')
        .replace(
          '#include <begin_vertex>',
          [
            'vPC = iCol;',
            'float cr = cos(iSR.y), sr = sin(iSR.y);',
            'vec2 q = position.xy * iSR.x;',
            'q = vec2(cr * q.x - sr * q.y, sr * q.x + cr * q.y);',
            'vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);',
            'vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);',
            'vec3 transformed = iPos + camR * q.x + camU * q.y;',
          ].join('\n'),
        );
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec4 vPC;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor *= vPC;');
    };
    mat.customProgramCacheKey = () => 'fl-sprite-' + (additive ? 'add' : 'norm');
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, grow: number, life: number, r: number, g: number, b: number, a: number, drag = 1.5, grav = 0) {
    let i: number;
    if (this.live < this.max) i = this.live++;
    else {
      i = this.next;
      this.next = (this.next + 1) % this.max;
    }
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.sr[i * 2] = size;
    this.sr[i * 2 + 1] = Math.random() * 6.28;
    this.grow[i] = grow;
    this.life[i] = life;
    this.age[i] = 0;
    this.drag[i] = drag;
    this.grav[i] = grav;
    this.base[i * 4] = r;
    this.base[i * 4 + 1] = g;
    this.base[i * 4 + 2] = b;
    this.base[i * 4 + 3] = a;
  }

  update(dt: number) {
    let n = this.live;
    for (let i = 0; i < n; i++) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        // Swap-remove with the last live particle.
        n--;
        this.copy(n, i);
        i--;
        continue;
      }
      const k = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= k;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k - this.grav[i] * dt;
      this.vel[i * 3 + 2] *= k;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.sr[i * 2] += this.grow[i] * dt;
      this.sr[i * 2 + 1] += dt * 0.4;
      const t = this.age[i] / this.life[i];
      const fade = t < 0.12 ? t / 0.12 : 1 - (t - 0.12) / 0.88;
      this.col[i * 4] = this.base[i * 4];
      this.col[i * 4 + 1] = this.base[i * 4 + 1];
      this.col[i * 4 + 2] = this.base[i * 4 + 2];
      this.col[i * 4 + 3] = this.base[i * 4 + 3] * fade * fade;
    }
    this.live = n;
    if (this.next >= n) this.next = 0;
    (this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = n;
    this.posA.needsUpdate = this.colA.needsUpdate = this.srA.needsUpdate = true;
  }

  private copy(from: number, to: number) {
    if (from === to) return;
    for (let k = 0; k < 3; k++) {
      this.pos[to * 3 + k] = this.pos[from * 3 + k];
      this.vel[to * 3 + k] = this.vel[from * 3 + k];
    }
    for (let k = 0; k < 4; k++) {
      this.col[to * 4 + k] = this.col[from * 4 + k];
      this.base[to * 4 + k] = this.base[from * 4 + k];
    }
    this.sr[to * 2] = this.sr[from * 2];
    this.sr[to * 2 + 1] = this.sr[from * 2 + 1];
    this.life[to] = this.life[from];
    this.age[to] = this.age[from];
    this.grow[to] = this.grow[from];
    this.drag[to] = this.drag[from];
    this.grav[to] = this.grav[from];
  }

  clear() {
    this.live = 0;
    this.next = 0;
    (this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = 0;
  }
}

// ---------------------------------------------------------------------------- debris
interface Chip {
  p: THREE.Vector3;
  v: THREE.Vector3;
  r: THREE.Euler;
  w: THREE.Vector3;
  s: number;
  life: number;
  age: number;
  rest: boolean;
  blood: boolean;
}

class DebrisPool {
  readonly mesh: THREE.InstancedMesh;
  private chips: Chip[] = [];
  private next = 0;
  onBloodLand: ((x: number, z: number, s: number) => void) | null = null;

  constructor(private ctx: GameContext, readonly max: number, geo: THREE.BufferGeometry, mat: THREE.Material) {
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    for (let i = 0; i < max; i++) this.mesh.setColorAt(i, _c.setRGB(1, 1, 1));
    for (let i = 0; i < max; i++)
      this.chips.push({ p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Euler(), w: new THREE.Vector3(), s: 1, life: 0, age: 1, rest: false, blood: false });
  }

  emit(p: THREE.Vector3, v: THREE.Vector3, size: number, color: THREE.Color, life: number, blood = false) {
    const c = this.chips[this.next];
    const idx = this.next;
    this.next = (this.next + 1) % this.max;
    c.p.copy(p);
    c.v.copy(v);
    c.r.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    c.w.set((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30);
    c.s = size;
    c.life = life;
    c.age = 0;
    c.rest = false;
    c.blood = blood;
    this.mesh.setColorAt(idx, color);
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt: number) {
    const t = this.ctx.terrain;
    let maxIdx = -1;
    for (let i = 0; i < this.max; i++) {
      const c = this.chips[i];
      if (c.age >= c.life) {
        if (i < this.mesh.count) {
          _m.makeScale(0, 0, 0);
          this.mesh.setMatrixAt(i, _m);
        }
        continue;
      }
      maxIdx = i;
      c.age += dt;
      if (!c.rest) {
        c.v.y -= 9.8 * dt;
        c.v.multiplyScalar(Math.exp(-0.6 * dt));
        c.p.addScaledVector(c.v, dt);
        c.r.x += c.w.x * dt;
        c.r.y += c.w.y * dt;
        c.r.z += c.w.z * dt;
        const gy = t.heightAt(c.p.x, c.p.z);
        if (c.p.y < gy + c.s * 0.3) {
          c.p.y = gy + c.s * 0.3;
          if (c.blood) {
            this.onBloodLand?.(c.p.x, c.p.z, c.s);
            c.age = c.life; // absorbed into the snow
            continue;
          }
          if (c.v.y < -2.5) {
            c.v.y *= -0.25;
            c.v.x *= 0.5;
            c.v.z *= 0.5;
            c.w.multiplyScalar(0.5);
          } else {
            c.rest = true;
            c.r.x = Math.round(c.r.x / Math.PI) * Math.PI;
          }
        }
      }
      const fade = clamp((c.life - c.age) / 0.6, 0, 1);
      _q.setFromEuler(_e.copy(c.r));
      _s.setScalar(c.s * fade);
      _m.compose(c.p, _q, _s);
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.count = maxIdx + 1;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear() {
    for (const c of this.chips) c.age = c.life = 0;
    this.mesh.count = 0;
  }
}

// ---------------------------------------------------------------------------- stains
class StainPool {
  readonly mesh: THREE.InstancedMesh;
  private fade: Float32Array;
  private fadeA: THREE.InstancedBufferAttribute;
  private born: Float32Array;
  private life: Float32Array;
  private next = 0;
  private used = 0;

  constructor(private ctx: GameContext, readonly max: number) {
    const g = new THREE.PlaneGeometry(1, 1);
    g.rotateX(-Math.PI / 2);
    this.fade = new Float32Array(max);
    this.fadeA = new THREE.InstancedBufferAttribute(this.fade, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iFade', this.fadeA);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x5a0d10,
      roughness: 0.55,
      metalness: 0,
      alphaMap: softTexture('blotch'),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float iFade;\nvarying float vFade;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvFade = iFade;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vFade;').replace('#include <alphamap_fragment>', '#include <alphamap_fragment>\ndiffuseColor.a *= vFade;');
    };
    mat.customProgramCacheKey = () => 'fl-stain';
    this.mesh = new THREE.InstancedMesh(g, mat, max);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 1;
    this.born = new Float32Array(max);
    this.life = new Float32Array(max);
  }

  add(x: number, z: number, size: number, life = 600) {
    const t = this.ctx.terrain;
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.used = Math.max(this.used, i + 1);
    const y = t.heightAt(x, z) + 0.025;
    t.normalAt(x, z, _n);
    _q.setFromUnitVectors(UP, _n);
    const rot = new THREE.Quaternion().setFromAxisAngle(UP, Math.random() * Math.PI * 2);
    _q.multiply(rot);
    _s.set(size * (0.8 + Math.random() * 0.4), 1, size * (0.8 + Math.random() * 0.4));
    _m.compose(_p.set(x, y, z), _q, _s);
    this.mesh.setMatrixAt(i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.born[i] = this.ctx.time;
    this.life[i] = life;
    this.fade[i] = 0.9;
    this.mesh.count = this.used;
    this.fadeA.needsUpdate = true;
  }

  update() {
    const now = this.ctx.time;
    let dirty = false;
    for (let i = 0; i < this.used; i++) {
      if (this.fade[i] <= 0) continue;
      const age = now - this.born[i];
      const f = age < 0.4 ? 0.2 + (age / 0.4) * 0.7 : clamp(1 - (age - this.life[i] * 0.7) / (this.life[i] * 0.3), 0, 0.9);
      if (Math.abs(f - this.fade[i]) > 0.004) {
        this.fade[i] = f;
        dirty = true;
      }
    }
    if (dirty) this.fadeA.needsUpdate = true;
  }

  clear() {
    this.fade.fill(0);
    this.fadeA.needsUpdate = true;
    this.used = this.next = 0;
    this.mesh.count = 0;
  }
}

// ---------------------------------------------------------------------------- facade
const WOOD = [new THREE.Color(0xc9a878), new THREE.Color(0xe2cda6), new THREE.Color(0x6e4b2e)];
const STONE = [new THREE.Color(0x6b6b72), new THREE.Color(0x8a8a90), new THREE.Color(0x4d4d55)];
const SNOW = new THREE.Color(0xe9eef4);
const BLOOD = new THREE.Color(0x4a0708);

export class Effects {
  private debris!: DebrisPool;
  private drops!: DebrisPool;
  private puffs!: SpritePool;
  private sparks!: SpritePool;
  private stains!: StainPool;
  readonly root = new THREE.Group();
  /** Brightness multiplier for unlit sprites (night-dim puffs). */
  private light = 1;

  constructor(private ctx: GameContext) {
    this.root.name = 'combat-effects';
  }

  init() {
    const ctx = this.ctx;
    const chipGeo = new THREE.BoxGeometry(1, 0.35, 0.6);
    const chipMat = new THREE.MeshStandardMaterial({ roughness: 0.85 });
    this.debris = new DebrisPool(ctx, 160, chipGeo, chipMat);
    const dropGeo = new THREE.IcosahedronGeometry(0.5, 0);
    const dropMat = new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0 });
    this.drops = new DebrisPool(ctx, 96, dropGeo, dropMat);
    this.drops.onBloodLand = (x, z, s) => {
      if (Math.random() < 0.55) this.stains.add(x, z, 0.05 + s * 3.5, 420);
    };
    const soft = softTexture('soft');
    this.puffs = new SpritePool(256, false, soft);
    this.sparks = new SpritePool(256, true, soft);
    this.stains = new StainPool(ctx, 160);
    this.root.add(this.debris.mesh, this.drops.mesh, this.puffs.mesh, this.sparks.mesh, this.stains.mesh);
    ctx.scene.add(this.root);
  }

  update(dt: number) {
    const env = this.ctx.env;
    this.light = 0.18 + 0.82 * env.daylight;
    this.debris.update(dt);
    this.drops.update(dt);
    this.puffs.update(dt);
    this.sparks.update(dt);
    this.stains.update();
  }

  reset() {
    this.debris?.clear();
    this.drops?.clear();
    this.puffs?.clear();
    this.sparks?.clear();
    this.stains?.clear();
  }

  // ------------------------------------------------------------ emitters
  woodChips(point: THREE.Vector3, normal: THREE.Vector3, dir: THREE.Vector3, amount = 1) {
    const n = Math.round(7 * amount);
    for (let i = 0; i < n; i++) {
      _p.copy(normal).multiplyScalar(2 + Math.random() * 3).addScaledVector(dir, -1.2);
      _p.x += (Math.random() - 0.5) * 3;
      _p.y += 1 + Math.random() * 2.5;
      _p.z += (Math.random() - 0.5) * 3;
      this.debris.emit(point, _p, 0.03 + Math.random() * 0.035, WOOD[i % 3], 3 + Math.random() * 3);
    }
    // A little snow knocked off the bark.
    for (let i = 0; i < 3 * amount; i++) this.puff(point, normal, 0.25, 0.9, 0.6);
  }

  stoneChips(point: THREE.Vector3, normal: THREE.Vector3, amount = 1) {
    for (let i = 0; i < 5 * amount; i++) {
      _p.copy(normal).multiplyScalar(2 + Math.random() * 3);
      _p.x += (Math.random() - 0.5) * 3;
      _p.y += 1 + Math.random() * 2;
      _p.z += (Math.random() - 0.5) * 3;
      this.debris.emit(point, _p, 0.02 + Math.random() * 0.025, STONE[i % 3], 2 + Math.random() * 2);
    }
    this.puff(point, normal, 0.2, 0.5, 0.5, 0.55, 0.55, 0.58);
  }

  sparks_(point: THREE.Vector3, normal: THREE.Vector3, amount = 1) {
    const n = Math.round(14 * amount);
    for (let i = 0; i < n; i++) {
      const sp = 3 + Math.random() * 6;
      _p.copy(normal).multiplyScalar(sp * 0.6);
      _p.x += (Math.random() - 0.5) * sp;
      _p.y += Math.random() * sp * 0.6;
      _p.z += (Math.random() - 0.5) * sp;
      this.sparks.emit(point.x, point.y, point.z, _p.x, _p.y, _p.z, 0.025 + Math.random() * 0.02, -0.02, 0.25 + Math.random() * 0.35, 3.5, 2.2, 0.9, 1, 1.5, 9.8);
    }
    this.sparks.emit(point.x, point.y, point.z, 0, 0, 0, 0.18, 1.2, 0.08, 3, 2.4, 1.4, 1, 0, 0);
  }

  /** Public alias: sparks on stone. */
  sparksAt(point: THREE.Vector3, normal: THREE.Vector3, amount = 1) {
    this.sparks_(point, normal, amount);
  }

  snowPuff(point: THREE.Vector3, normal: THREE.Vector3, amount = 1) {
    for (let i = 0; i < 6 * amount; i++) this.puff(point, normal, 0.22 + Math.random() * 0.2, 1.2, 0.7 + Math.random() * 0.5);
    for (let i = 0; i < 4 * amount; i++) {
      _p.copy(normal).multiplyScalar(1.5 + Math.random() * 2);
      _p.x += (Math.random() - 0.5) * 2;
      _p.y += 0.5 + Math.random() * 1.5;
      _p.z += (Math.random() - 0.5) * 2;
      this.debris.emit(point, _p, 0.025 + Math.random() * 0.03, SNOW, 0.8 + Math.random() * 0.6);
    }
  }

  private puff(point: THREE.Vector3, normal: THREE.Vector3, size: number, speed: number, life: number, r = 0.93, g = 0.95, b = 0.98, a = 0.75) {
    const L = this.light;
    const vx = normal.x * speed + (Math.random() - 0.5) * speed,
      vy = normal.y * speed + Math.random() * speed * 0.6,
      vz = normal.z * speed + (Math.random() - 0.5) * speed;
    this.puffs.emit(point.x, point.y, point.z, vx, vy, vz, size, size * 1.4, life, r * L, g * L, b * L, a, 2.5, 0.4);
  }

  /** Blood spray from a wound: droplets that stain the snow + a faint mist. */
  blood(point: THREE.Vector3, dir: THREE.Vector3, amount = 1) {
    const n = Math.round(8 * amount);
    for (let i = 0; i < n; i++) {
      _p.copy(dir).multiplyScalar(1 + Math.random() * 2.5);
      _p.x += (Math.random() - 0.5) * 2.2;
      _p.y += Math.random() * 2.2;
      _p.z += (Math.random() - 0.5) * 2.2;
      this.drops.emit(point, _p, 0.012 + Math.random() * 0.018, BLOOD, 3, true);
    }
    const L = this.light;
    for (let i = 0; i < 2 * amount; i++) this.puffs.emit(point.x, point.y, point.z, dir.x * 0.6, 0.2, dir.z * 0.6, 0.12, 0.35, 0.45, 0.35 * L, 0.03 * L, 0.03 * L, 0.45, 3, 0);
  }

  /** Single drop on the snow (wounded animal trail). */
  bloodDrip(x: number, z: number, size = 1) {
    this.stains.add(x + (Math.random() - 0.5) * 0.3, z + (Math.random() - 0.5) * 0.3, (0.05 + Math.random() * 0.07) * size, 480);
  }

  /** Harvest patch under a carcass. */
  bloodPatch(x: number, z: number, size = 1) {
    this.stains.add(x, z, size * 1.1, 360);
    for (let i = 0; i < 4; i++) this.stains.add(x + (Math.random() - 0.5) * size, z + (Math.random() - 0.5) * size, size * (0.25 + Math.random() * 0.3), 300);
  }

  /** Warm embers (torch). */
  ember(x: number, y: number, z: number, vx: number, vy: number, vz: number) {
    this.sparks.emit(x, y, z, vx, vy, vz, 0.012 + Math.random() * 0.014, -0.01, 0.6 + Math.random() * 0.9, 3.2, 1.5, 0.45, 1, 0.8, -0.6);
  }

  /** A breath of vapour in the cold: pale, soft, quick to fade. */
  breath(x: number, y: number, z: number, vx: number, vy: number, vz: number, k = 1) {
    const L = 0.35 + 0.65 * this.light;
    this.puffs.emit(x, y, z, vx, vy, vz, 0.015 + Math.random() * 0.01, 0.1 + Math.random() * 0.05, 0.7 + Math.random() * 0.35, 0.55 * L, 0.57 * L, 0.6 * L, 0.035 * k, 2.8, -0.03);
  }

  /** Grey smoke wisp. */
  smoke(x: number, y: number, z: number, size = 0.1) {
    const L = this.light;
    this.puffs.emit(x, y, z, (Math.random() - 0.5) * 0.2, 0.6 + Math.random() * 0.3, (Math.random() - 0.5) * 0.2, size, 0.35, 1.2 + Math.random() * 0.6, 0.3 * L, 0.3 * L, 0.32 * L, 0.18, 0.6, -0.1);
  }

  /** Generic lit debris (used for snow off a flying spear etc). */
  chip(p: THREE.Vector3, v: THREE.Vector3, size: number, color: THREE.Color, life: number) {
    this.debris.emit(p, v, size, color, life);
  }
}
