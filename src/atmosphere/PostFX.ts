// PLACEHOLDER render pipeline (owned by the atmosphere agent — replace with the post stack).
import * as THREE from 'three';
import type { GameContext, System } from '../core/types';

export class PostFX implements System {
  readonly name = 'post';
  constructor(private ctx: GameContext) {}
  init() {
    this.ctx.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.ctx.renderer.toneMappingExposure = 1;
  }
  /** Called by Game every frame after all updates. */
  render(_dt: number) {
    this.ctx.renderer.render(this.ctx.scene, this.ctx.camera);
  }
}
