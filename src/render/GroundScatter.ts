// Ground scatter (visual only): snow-covered shrubs, dead grass tufts, fallen logs, stumps.
// Filled in later in this file.
import type * as THREE from 'three';
import type { GameContext } from '../core/types';

export class GroundScatter {
  constructor(
    private ctx: GameContext,
    private parent: THREE.Object3D,
  ) {}
  update(_dt: number) {
    void this.ctx;
    void this.parent;
  }
}
