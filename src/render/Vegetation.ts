// Vegetation: forest (4 species, 2 mesh LODs + baked impostors), boulders and ground scatter.
//
// Trees: every frame the camera moved, trees within mesh range are gathered from the World grid,
// frustum-culled and written into per-species InstancedMeshes (LOD0 near, LOD1 mid). Separate
// shadow-only instanced meshes hold every tree within the shadow distance (so trees behind the
// camera still cast shadows forward). All trees beyond mesh range are a single static instanced
// impostor draw; LOD bands crossfade with a complementary screen-space dither.
import * as THREE from 'three';
import type { GameContext, GameState, System } from '../core/types';
import { buildTreeGeometry, buildShadowProxy, TREE_TYPES } from './trees/TreeModels';
import { createTreeMaterial, createTreeDepthMaterial, type TreeShared } from './trees/treeMaterial';
import { TreeImpostors } from './trees/Impostors';
import { Rocks } from './Rocks';
import { GroundScatter } from './GroundScatter';
import { SHADOW_RINGS, shadowOnly } from './shadowUtil';

const CAP = [3000, 8000, 14000];
/** Shadow caster meshes per species: 0 detailed (near), 1 mid proxy (near cascades), 2 cone (far cascades). */
const SHADOW_CAP = [2000, 8000, 16000];

interface Band {
  l0: number; // LOD0 -> LOD1 distance
  l1: number; // LOD1 -> LOD2 distance
  draw: number; // LOD2 -> impostor distance
  b: number; // half-width of the mesh crossfade bands
  bi: number; // half-width of the mesh -> impostor band
  far: number; // impostor max distance
  shadow: number; // shadow caster radius
  shadowLod0: number; // detailed shadow casters within this radius
}

export class Vegetation implements System {
  readonly name = 'vegetation';
  readonly updateWhen: GameState[] = ['menu', 'playing', 'paused', 'dead'];

  readonly shared: TreeShared = {
    uTime: { value: 0 },
    uWind: { value: new THREE.Vector4(1, 0, 0.2, 0.5) },
    uSnowCover: { value: 1 },
    uNoiseTex: { value: null as unknown as THREE.Texture },
  };
  /** Debug counters. */
  stats = { lod0: 0, lod1: 0, lod2: 0, shadow: 0, rebuilds: 0 };

  private geos: THREE.BufferGeometry[][] = [];
  private mats: THREE.MeshStandardMaterial[] = [];
  private depthMat!: THREE.MeshDepthMaterial;
  /** main[type][lod], lod 0..2 */
  private main: THREE.InstancedMesh[][] = [];
  /** shadows[type][0 = detailed, 1 = mid proxy, 2 = far-cascade cone] */
  private shadows: THREE.InstancedMesh[][] = [];
  private impostors!: TreeImpostors;
  private rocks!: Rocks;
  private scatter!: GroundScatter;
  private group = new THREE.Group();
  private treeMat!: Float32Array; // 16 floats per tree
  private band!: Band;
  private dirty = true;
  private readonly lastCam = new THREE.Matrix4();
  private readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();
  private readonly camPos = new THREE.Vector3();
  private readonly counts = { m: [new Int32Array(4), new Int32Array(4), new Int32Array(4)] };
  /** Shadow caster tree indices per [type][detail][ring]. */
  private shadowIdx: Int32Array[][][] = [];
  private shadowN: Int32Array[][] = [];
  private standaloneMat: THREE.MeshStandardMaterial | null = null;
  private bakeMaterial!: (normals: boolean) => THREE.Material;

  constructor(private ctx: GameContext) {
    this.group.name = 'vegetation';
  }

  /**
   * A standalone mesh of a tree (same look as the instanced forest) with its origin at the
   * trunk base. Survival uses it for the felling animation. Caller owns (and disposes) it.
   */
  createTreeMesh(type: number, scale: number, lod = 0): THREE.Object3D {
    const t = Math.max(0, Math.min(TREE_TYPES - 1, type | 0));
    const l = lod ? 1 : 0;
    const geo = (this.geos[t]?.[l] ?? buildTreeGeometry(t, l)).clone();
    if (!this.standaloneMat) this.standaloneMat = createTreeMaterial({ shared: this.shared, lodRange: new THREE.Vector4(0, 0, 0, 0), key: 'standalone', fringe: true });
    const mesh = new THREE.Mesh(geo, this.standaloneMat.clone());
    mesh.customDepthMaterial = this.depthMat ?? createTreeDepthMaterial(this.shared);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'tree-standalone';
    const g = new THREE.Group();
    g.add(mesh);
    g.scale.setScalar(scale);
    return g;
  }

  init() {
    const { ctx } = this;
    // Dev-only handle for in-page debugging from the screenshot tools.
    if (ctx.dev.enabled) (window as unknown as { __FL_THREE?: typeof THREE }).__FL_THREE = THREE;
    const terrainSys = ctx.sys.terrain;
    this.shared.uNoiseTex.value = terrainSys.textures.noise;

    for (let t = 0; t < TREE_TYPES; t++) this.geos.push([buildTreeGeometry(t, 0), buildTreeGeometry(t, 1), buildTreeGeometry(t, 2)]);
    this.computeBand();
    const b = this.band;
    for (let l = 0; l < 3; l++) this.mats.push(createTreeMaterial({ shared: this.shared, lodRange: new THREE.Vector4(), key: 'lod' + l, fringe: l === 0 }));
    this.applyBandToMaterials();
    this.depthMat = createTreeDepthMaterial(this.shared);

    for (let t = 0; t < TREE_TYPES; t++) {
      const row: THREE.InstancedMesh[] = [];
      for (let l = 0; l < 3; l++) {
        const im = this.makeInstanced(this.geos[t][l], this.mats[l], CAP[l], `tree${t}-lod${l}`);
        im.receiveShadow = true;
        row.push(im);
      }
      this.main.push(row);
      const s0 = this.makeInstanced(this.geos[t][1], this.mats[2], SHADOW_CAP[0], `tree${t}-shadowA`);
      const s1 = this.makeInstanced(this.geos[t][2], this.mats[2], SHADOW_CAP[1], `tree${t}-shadowB`);
      const s2 = this.makeInstanced(buildShadowProxy(t), this.mats[2], SHADOW_CAP[2], `tree${t}-shadowC`);
      const cls = ['near', 'near', 'far'] as const;
      [s0, s1, s2].forEach((sm, k) => {
        sm.castShadow = true;
        sm.customDepthMaterial = this.depthMat;
        shadowOnly(sm, cls[k]);
      });
      this.shadows.push([s0, s1, s2]);
      this.shadowIdx.push([0, 1, 2].map((k) => [0, 1, 2].map(() => new Int32Array(SHADOW_CAP[k]))));
      this.shadowN.push([new Int32Array(3), new Int32Array(3), new Int32Array(3)]);
    }

    // Precompute each tree's instance matrix.
    const w = ctx.world;
    this.treeMat = new Float32Array(w.treeCount * 16);
    const m = new THREE.Matrix4(),
      q = new THREE.Quaternion(),
      p = new THREE.Vector3(),
      s = new THREE.Vector3(),
      up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < w.treeCount; i++) {
      p.set(w.treeX[i], w.treeY[i], w.treeZ[i]);
      q.setFromAxisAngle(up, w.treeRot[i]);
      s.setScalar(w.treeScale[i]);
      m.compose(p, q, s);
      m.toArray(this.treeMat, i * 16);
    }

    // Impostors baked from the LOD0 meshes (wind frozen during the bake).
    const bakeShared: TreeShared = { ...this.shared, uWind: { value: new THREE.Vector4(1, 0, 0, 0) }, uTime: { value: 0 } };
    this.bakeMaterial = (normals: boolean) =>
      createTreeMaterial({ shared: bakeShared, lodRange: new THREE.Vector4(), key: 'bake', bake: normals ? 'normal' : 'albedo' });
    this.impostors = new TreeImpostors(ctx.renderer, w, this.shared, this.geos.map((g) => g[0]), this.bakeMaterial);
    this.impostors.setRange(b.draw - b.bi, b.draw + b.bi, b.far - 250, b.far);
    this.group.add(this.impostors.mesh);

    this.rocks = new Rocks(ctx, this.group);
    this.scatter = new GroundScatter(ctx, this.group);

    ctx.scene.add(this.group);

    ctx.events.on('tree:removed', ({ id }) => {
      this.impostors.hide(id);
      this.dirty = true;
    });
    const restore = () => {
      this.impostors.rebuild();
      this.rocks.restore();
      this.dirty = true;
    };
    ctx.events.on('newGame', restore);
    ctx.events.on('loadedGame', restore);
    ctx.events.on('settings', ({ key }) => {
      if (key !== 'quality') return;
      this.computeBand();
      this.applyBandToMaterials();
      const bb = this.band;
      this.impostors.setRange(bb.draw - bb.bi, bb.draw + bb.bi, bb.far - 250, bb.far);
      this.dirty = true;
    });
    this.lateUpdate();
  }

  private applyBandToMaterials() {
    const b = this.band;
    const set = (l: number, a: number, bb: number, c: number, d: number) => (this.mats[l].userData.lodRange as THREE.Vector4).set(a, bb, c, d);
    set(0, 0, 0, b.l0 - b.b, b.l0 + b.b);
    set(1, b.l0 - b.b, b.l0 + b.b, b.l1 - b.b, b.l1 + b.b);
    set(2, b.l1 - b.b, b.l1 + b.b, b.draw - b.bi, b.draw + b.bi);
  }

  private computeBand() {
    const q = this.ctx.settings.quality;
    const draw = q.treeDrawDistance;
    this.band = {
      l0: Math.min(draw * 0.3, 40 + 30 * q.terrainDetail),
      l1: Math.min(draw * 0.6, 100 + 60 * q.terrainDetail),
      draw,
      b: 6,
      bi: 14,
      far: q.impostorDistance,
      shadow: Math.min(q.shadowDistance, draw),
      shadowLod0: 45,
    };
  }

  private makeInstanced(geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, name: string) {
    const im = new THREE.InstancedMesh(geo, mat, cap);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.count = 0;
    im.frustumCulled = false;
    im.name = name;
    im.matrixAutoUpdate = false;
    this.group.add(im);
    return im;
  }

  update(dt: number) {
    const { env } = this.ctx;
    this.shared.uTime.value += dt;
    const w = this.shared.uWind.value;
    const wl = Math.hypot(env.wind.x, env.wind.z);
    if (wl > 1e-3) w.set(env.wind.x / wl, env.wind.z / wl, Math.min(1, Math.max(env.windStrength, wl / 25)), 0.5);
    else w.z = env.windStrength;
    this.rocks.update();
    this.scatter.update(dt);
  }

  lateUpdate() {
    const cam = this.ctx.camera;
    cam.updateMatrixWorld();
    const moved = !matricesClose(cam.matrixWorld, this.lastCam, 0.25, 0.002);
    if (!moved && !this.dirty) return;
    this.lastCam.copy(cam.matrixWorld);
    this.dirty = false;
    this.rebuildTrees();
  }

  /** Write shadow casters ring by ring (nearest first) and record the per-ring prefix counts. */
  private writeShadow(t: number, k: number): number {
    const im = this.shadows[t][k];
    const dst = im.instanceMatrix.array as Float32Array;
    const n = this.shadowN[t][k];
    const idx = this.shadowIdx[t][k];
    const rc = im.userData.ringCounts as number[];
    let c = 0;
    for (let r = 0; r < 3; r++) {
      const list = idx[r];
      for (let j = 0; j < n[r]; j++) copyMat(this.treeMat, list[j], dst, c++);
      rc[r] = c;
    }
    im.visible = c > 0;
    if (c > 0) {
      im.instanceMatrix.clearUpdateRanges();
      im.instanceMatrix.addUpdateRange(0, c * 16);
      im.instanceMatrix.needsUpdate = true;
    }
    return c;
  }

  private rebuildTrees() {
    const { ctx } = this;
    const cam = ctx.camera;
    const w = ctx.world;
    cam.getWorldPosition(this.camPos);
    this.projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
    const planes = this.frustum.planes;
    const b = this.band;
    const cx = this.camPos.x,
      cy = this.camPos.y,
      cz = this.camPos.z;
    const cm = this.counts.m;
    for (let l = 0; l < 3; l++) cm[l].fill(0);
    const SI = this.shadowIdx,
      SN = this.shadowN;
    for (let t = 0; t < TREE_TYPES; t++) for (let k = 0; k < 3; k++) SN[t][k].fill(0);
    const r0 = SHADOW_RINGS[0] * SHADOW_RINGS[0],
      r1 = SHADOW_RINGS[1] * SHADOW_RINGS[1];
    const sq = (v: number) => v * v;
    const e0 = sq(b.l0 + b.b),
      s1 = sq(b.l0 - b.b),
      e1 = sq(b.l1 + b.b),
      s2 = sq(b.l1 - b.b),
      e2 = sq(b.draw + b.bi),
      sh2 = sq(b.shadow),
      sh02 = sq(b.shadowLod0);
    const TM = this.treeMat;
    const main = this.main;
    const radius = Math.max(b.draw + b.bi, b.shadow);
    w.forEachTree(cx, cz, radius, (i) => {
      const x = w.treeX[i],
        y = w.treeY[i],
        z = w.treeZ[i];
      const dx = x - cx,
        dy = y - cy,
        dz = z - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      const t = w.treeType[i];
      if (d2 < sh2) {
        const ring = d2 < r0 ? 0 : d2 < r1 ? 1 : 2;
        // Near cascades: detailed casters close by, mid proxies out to the last ring.
        if (ring < 2) {
          const k = d2 < sh02 ? 0 : 1;
          const n = SN[t][k];
          if (n[0] + n[1] < SHADOW_CAP[k]) SI[t][k][ring][n[ring]++] = i;
        }
        // Far cascades: a cone per tree.
        const nc = SN[t][2];
        if (nc[0] < SHADOW_CAP[2]) SI[t][2][0][nc[0]++] = i;
      }
      if (d2 > e2) return;
      // Frustum test against the crown's bounding sphere.
      const h = w.treeHeight(i);
      const sy = y + h * 0.5,
        r = h * 0.6;
      for (let k = 0; k < 6; k++) {
        const pl = planes[k];
        if (pl.normal.x * x + pl.normal.y * sy + pl.normal.z * z + pl.constant < -r) return;
      }
      if (d2 < e0 && cm[0][t] < CAP[0]) copyMat(TM, i, main[t][0].instanceMatrix.array as Float32Array, cm[0][t]++);
      if (d2 > s1 && d2 < e1 && cm[1][t] < CAP[1]) copyMat(TM, i, main[t][1].instanceMatrix.array as Float32Array, cm[1][t]++);
      if (d2 > s2 && cm[2][t] < CAP[2]) copyMat(TM, i, main[t][2].instanceMatrix.array as Float32Array, cm[2][t]++);
    });
    const tot = [0, 0, 0];
    let sh = 0;
    for (let t = 0; t < TREE_TYPES; t++) {
      for (let l = 0; l < 3; l++) {
        commit(main[t][l], cm[l][t]);
        tot[l] += cm[l][t];
      }
      for (let k = 0; k < 3; k++) sh += this.writeShadow(t, k);
    }
    this.stats.lod0 = tot[0];
    void sh02;
    this.stats.lod1 = tot[1];
    this.stats.lod2 = tot[2];
    this.stats.shadow = sh;
    this.stats.rebuilds++;
  }
}

function copyMat(src: Float32Array, i: number, dst: Float32Array, k: number) {
  const o = i * 16,
    p = k * 16;
  for (let j = 0; j < 16; j++) dst[p + j] = src[o + j];
}

function commit(im: THREE.InstancedMesh, n: number) {
  im.count = n;
  im.visible = n > 0;
  if (n > 0) {
    im.instanceMatrix.clearUpdateRanges();
    im.instanceMatrix.addUpdateRange(0, n * 16);
    im.instanceMatrix.needsUpdate = true;
  }
}

function matricesClose(a: THREE.Matrix4, b: THREE.Matrix4, posEps: number, rotEps: number) {
  const ae = a.elements,
    be = b.elements;
  for (let k = 0; k < 12; k++) if (Math.abs(ae[k] - be[k]) > rotEps) return false;
  for (let k = 12; k < 15; k++) if (Math.abs(ae[k] - be[k]) > posEps) return false;
  return true;
}
