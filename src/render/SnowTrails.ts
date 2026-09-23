// PLACEHOLDER snow deformation (owned by the terrain/graphics agent).
import type { GameContext, GameState, System } from '../core/types';

export class SnowTrails implements System {
  readonly name = 'snowTrails';
  readonly updateWhen: GameState[] = ['menu', 'playing', 'dead'];
  constructor(private ctx: GameContext) {}
  update() {
    this.ctx.snow.drain();
  }
}
