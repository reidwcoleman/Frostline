// Snow deformation (ski tracks, footprints, paw prints). Filled in below; uniforms are created in
// the constructor so the terrain material can bind them before this system's init().
import * as THREE from 'three';
import type { GameContext, GameState, System } from '../core/types';

export class SnowTrails implements System {
  readonly name = 'snowTrails';
  readonly updateWhen: GameState[] = ['menu', 'playing', 'dead'];
  readonly uniforms: { [k: string]: THREE.IUniform } = {
    tTrailTex: { value: new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1) },
    tTrailRect: { value: new THREE.Vector4(1e6, 1e6, 1 / 128, 1 / 1024) },
    tTrailDepth: { value: 0.12 },
  };
  constructor(private ctx: GameContext) {
    (this.uniforms.tTrailTex.value as THREE.DataTexture).needsUpdate = true;
  }
  update() {
    this.ctx.snow.drain();
  }
}
