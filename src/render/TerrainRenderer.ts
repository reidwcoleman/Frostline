// Terrain renderer: GPU CDLOD over the 4 km world plus a mirrored far ring to the horizon.
// One instanced draw for the visible surface, one for shadow casters near the camera.
// Vertex heights are computed on the GPU with the exact Terrain.heightAt() formula, so the
// rendered surface matches physics (1 m vertex spacing within ~150 m on high).
import * as THREE from 'three';
import type { GameContext, GameState, System } from '../core/types';
import { TerrainGPU, EXT_HALF } from './terrain/TerrainGPU';
import { CdlodSelector, createPatchGeometry } from './terrain/Cdlod';
import { createTerrainMaterials, type TerrainMaterials } from './terrain/terrainMaterial';
import { createWorldTextures, type WorldTextures } from './ProceduralTextures';
import { SHADOW_RINGS, cascadeExtent, ringForExtent, FAR_CASCADE_EXTENT } from './shadowUtil';

const MAX_PATCHES = 6000;

export class TerrainRenderer implements System {
  readonly name = 'terrain';
  readonly updateWhen: GameState[] = ['menu', 'playing', 'paused', 'dead'];

  /** Shared GPU terrain data (other world renderers may sample it). */
  gpu!: TerrainGPU;
  /** Shared procedural textures (noise, snow, rock). */
  textures!: WorldTextures;
  mats!: TerrainMaterials;
  /** Visible patch count last frame (debug). */
  stats = { patches: 0, shadowPatches: 0 };

  private selector!: CdlodSelector;
  private shadowSelector!: CdlodSelector;
  private readonly shadowRingCounts = [0, 0, 0];
  private sortTmp = new Float32Array(0);
  private mesh!: THREE.Mesh;
  private shadowMesh!: THREE.Mesh;
  private viewPatches!: THREE.InstancedBufferAttribute;
  private shadowPatches!: THREE.InstancedBufferAttribute;
  private readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();
  private readonly camPos = new THREE.Vector3();

  constructor(private ctx: GameContext) {}

  init() {
    const { ctx } = this;
    this.gpu = new TerrainGPU(ctx.terrain, ctx.world, ctx.renderer);
    this.textures = createWorldTextures(ctx.renderer);
    this.selector = new CdlodSelector(this.gpu);
    this.shadowSelector = new CdlodSelector(this.gpu);
    this.mats = createTerrainMaterials(this.gpu, this.textures, ctx.sys.snowTrails.uniforms, this.selector.morph, this.shadowSelector.morph);
    this.applyQuality();

    const view = createPatchGeometry(MAX_PATCHES);
    this.viewPatches = view.patches;
    this.mesh = new THREE.Mesh(view.geometry, this.mats.material);
    this.mesh.name = 'terrain';
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.matrixAutoUpdate = false;

    const shadow = createPatchGeometry(MAX_PATCHES / 2);
    this.shadowPatches = shadow.patches;
    this.shadowMesh = new THREE.Mesh(shadow.geometry, this.mats.material);
    this.shadowMesh.name = 'terrain-shadow';
    this.shadowMesh.frustumCulled = false;
    this.shadowMesh.castShadow = true;
    this.shadowMesh.receiveShadow = false;
    this.shadowMesh.customDepthMaterial = this.mats.depthMaterial;
    this.shadowMesh.matrixAutoUpdate = false;
    // Shadow-only: zero instances in every main-camera pass (incl. post prepasses), restore per cascade.
    const sg = shadow.geometry;
    this.shadowMesh.onBeforeRender = () => {
      sg.instanceCount = 0;
    };
    this.shadowMesh.onBeforeShadow = (_r, _o, _c, shadowCamera) => {
      // Far cascades get no terrain casters: the atmosphere's heightfield shadow covers mountain scale.
      const ext = cascadeExtent(shadowCamera);
      sg.instanceCount = ext >= FAR_CASCADE_EXTENT ? 0 : this.shadowRingCounts[ringForExtent(ext)];
    };

    ctx.scene.add(this.mesh, this.shadowMesh);

    ctx.events.on('settings', ({ key }) => {
      if (key === 'quality') this.applyQuality();
    });
    ctx.events.on('tree:removed', ({ id }) => this.gpu.clearForestAt(ctx.world.treeX[id], ctx.world.treeZ[id]));

    // Select once so the very first frame (menu backdrop) already has terrain.
    this.lateUpdate();
  }

  private applyQuality() {
    const q = this.ctx.settings.quality;
    const K = Math.max(6, 6 * q.terrainDetail);
    this.selector.configure(K, q.terrainDetail < 0.7 ? 1 : 0);
    // Shadow casters: 2 m spacing is plenty (the receiver bias hides the tiny difference).
    this.shadowSelector.configure(6, 1);
  }

  update(dt: number) {
    const u = this.mats.uniforms;
    const env = this.ctx.env;
    u.tTime.value += dt;
    u.tSkyColor.value.copy(env.skyColor);
    u.tFogColor.value.copy(env.fogColor);
    u.tEnvFallback.value = this.ctx.scene.environment ? 0 : 1;
    if (env.wind.lengthSq() > 0.01) {
      // Ripples form across the prevailing wind; ease toward it very slowly (snow "remembers").
      const target = Math.atan2(env.wind.z, env.wind.x);
      let d = target - u.tWindAngle.value;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      u.tWindAngle.value += d * Math.min(1, dt * 0.002);
    }
  }

  /** LOD selection runs after every system has moved the camera this frame. */
  lateUpdate() {
    const { camera, settings } = this.ctx;
    camera.updateMatrixWorld();
    camera.getWorldPosition(this.camPos);
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
    this.mats.uniforms.tLodCam.value.copy(this.camPos);

    const q = settings.quality;
    const n = this.selector.selectView(this.camPos, this.frustum, Math.min(camera.far, EXT_HALF * 1.5), this.viewPatches.array as Float32Array);
    this.commit(this.mesh, this.viewPatches, n);
    this.stats.patches = n;

    const arr = this.shadowPatches.array as Float32Array;
    const ns = this.shadowSelector.selectSphere(this.camPos, Math.min(q.shadowDistance + 60, SHADOW_RINGS[SHADOW_RINGS.length - 1]), arr);
    this.sortPatchesByRing(arr, ns);
    this.commit(this.shadowMesh, this.shadowPatches, ns);
    this.stats.shadowPatches = ns;
  }

  /** Reorder shadow patches nearest-ring-first so small cascades can draw just a prefix. */
  private sortPatchesByRing(arr: Float32Array, n: number) {
    if (this.sortTmp.length < arr.length) this.sortTmp = new Float32Array(arr.length);
    const tmp = this.sortTmp;
    const cx = this.camPos.x,
      cz = this.camPos.z;
    let c = 0;
    for (let ring = 0; ring <= SHADOW_RINGS.length; ring++) {
      const lo = ring === 0 ? -1 : SHADOW_RINGS[ring - 1];
      const hi = ring < SHADOW_RINGS.length ? SHADOW_RINGS[ring] : Infinity;
      for (let i = 0; i < n; i++) {
        const o = i * 4;
        const half = arr[o + 2] * 8; // patch = 16 quads
        const dx = Math.max(Math.abs(arr[o] + half - cx) - half, 0);
        const dz = Math.max(Math.abs(arr[o + 1] + half - cz) - half, 0);
        const d = Math.hypot(dx, dz);
        if (d > lo && d <= hi) {
          tmp[c * 4] = arr[o];
          tmp[c * 4 + 1] = arr[o + 1];
          tmp[c * 4 + 2] = arr[o + 2];
          tmp[c * 4 + 3] = arr[o + 3];
          c++;
        }
      }
      this.shadowRingCounts[ring] = c;
    }
    arr.set(tmp.subarray(0, c * 4));
  }

  private commit(mesh: THREE.Mesh, attr: THREE.InstancedBufferAttribute, n: number) {
    const g = mesh.geometry as THREE.InstancedBufferGeometry;
    g.instanceCount = n;
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, Math.max(4, n * 4));
    attr.needsUpdate = true;
    mesh.visible = n > 0;
  }
}
