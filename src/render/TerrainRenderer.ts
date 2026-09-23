// PLACEHOLDER terrain renderer (owned by the terrain/graphics agent — replace freely).
// Fixed grid of chunks built from Terrain.heightAt with slope-based vertex colours.
import * as THREE from 'three';
import type { GameContext, GameState, System } from '../core/types';

export class TerrainRenderer implements System {
  readonly name = 'terrain';
  readonly updateWhen: GameState[] = ['menu', 'playing', 'dead'];
  private group = new THREE.Group();

  constructor(private ctx: GameContext) {}

  init() {
    const t = this.ctx.terrain;
    const chunks = 16;
    const chunkSize = t.size / chunks;
    const segs = 64;
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
    const snow = new THREE.Color(0.92, 0.95, 1.0);
    const rock = new THREE.Color(0.35, 0.34, 0.36);
    const ice = new THREE.Color(0.6, 0.75, 0.85);
    const c = new THREE.Color();
    for (let cz = 0; cz < chunks; cz++)
      for (let cx = 0; cx < chunks; cx++) {
        const geo = new THREE.PlaneGeometry(chunkSize, chunkSize, segs, segs);
        geo.rotateX(-Math.PI / 2);
        const ox = -t.half + (cx + 0.5) * chunkSize;
        const oz = -t.half + (cz + 0.5) * chunkSize;
        const pos = geo.attributes.position as THREE.BufferAttribute;
        const colors = new Float32Array(pos.count * 3);
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i) + ox,
            z = pos.getZ(i) + oz;
          pos.setY(i, t.heightAt(x, z));
          const slope = t.slopeAngle(x, z);
          c.copy(snow).lerp(rock, THREE.MathUtils.smoothstep(slope, 0.6, 0.85));
          if (t.lakeFactor(x, z) > 0.5) c.copy(ice);
          colors.set([c.r, c.g, c.b], i * 3);
        }
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        geo.computeVertexNormals();
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(ox, 0, oz);
        mesh.receiveShadow = true;
        this.group.add(mesh);
      }
    this.ctx.scene.add(this.group);
  }
}
