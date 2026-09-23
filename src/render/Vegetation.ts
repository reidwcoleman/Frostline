// PLACEHOLDER vegetation renderer (owned by the terrain/graphics agent — replace freely).
import * as THREE from 'three';
import type { GameContext, GameState, System } from '../core/types';

export class Vegetation implements System {
  readonly name = 'vegetation';
  readonly updateWhen: GameState[] = ['menu', 'playing', 'dead'];
  private meshes: THREE.InstancedMesh[] = [];
  private lookup: { mesh: THREE.InstancedMesh; idx: number }[] = [];

  constructor(private ctx: GameContext) {}

  /**
   * A standalone mesh of a tree (same look as the instanced forest) with its origin at the
   * trunk base. Survival uses it for the felling animation. Caller owns (and disposes) it.
   */
  createTreeMesh(type: number, scale: number): THREE.Object3D {
    const h = [15, 17, 10, 5.5][type] ?? 15;
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.3, h, 6), new THREE.MeshStandardMaterial({ color: 0x4a3526 }));
    trunk.position.y = h / 2;
    const crown = new THREE.Mesh(new THREE.ConeGeometry(2.6, h * 0.75, 7), new THREE.MeshStandardMaterial({ color: 0x1f3a2c }));
    crown.position.y = h * 0.55;
    g.add(trunk, crown);
    g.scale.setScalar(scale);
    return g;
  }

  init() {
    const w = this.ctx.world;
    const t = this.ctx.terrain;
    const cone = new THREE.ConeGeometry(2.6, 11, 7);
    cone.translate(0, 8, 0);
    const mat = new THREE.MeshStandardMaterial({ color: 0x1f3a2c, roughness: 1 });
    const chunk = 256;
    const dim = Math.ceil(t.size / chunk);
    const buckets: number[][] = Array.from({ length: dim * dim }, () => []);
    for (let i = 0; i < w.treeCount; i++) {
      const cx = Math.min(dim - 1, Math.floor((w.treeX[i] + t.half) / chunk));
      const cz = Math.min(dim - 1, Math.floor((w.treeZ[i] + t.half) / chunk));
      buckets[cz * dim + cx].push(i);
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    for (const b of buckets) {
      if (!b.length) continue;
      const mesh = new THREE.InstancedMesh(cone, mat, b.length);
      b.forEach((ti, k) => {
        const sc = w.treeHeight(ti) / 15;
        p.set(w.treeX[ti], w.treeY[ti], w.treeZ[ti]);
        s.set(sc, sc, sc);
        m.compose(p, q, s);
        mesh.setMatrixAt(k, m);
        this.lookup[ti] = { mesh, idx: k };
      });
      mesh.computeBoundingSphere();
      mesh.castShadow = true;
      this.meshes.push(mesh);
      this.ctx.scene.add(mesh);
    }
    this.ctx.events.on('tree:removed', ({ id }) => {
      const l = this.lookup[id];
      if (!l) return;
      l.mesh.setMatrixAt(l.idx, new THREE.Matrix4().makeScale(0, 0, 0));
      l.mesh.instanceMatrix.needsUpdate = true;
    });
  }
}
