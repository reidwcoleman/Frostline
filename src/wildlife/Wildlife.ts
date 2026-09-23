// PLACEHOLDER wildlife system (owned by the combat/wildlife agent).
import type { GameContext, GameState, System } from '../core/types';

export class Wildlife implements System {
  readonly name = 'wildlife';
  readonly updateWhen: GameState[] = ['playing', 'dead'];
  constructor(private ctx: GameContext) {}
  update(_dt: number) {
    void this.ctx;
  }
}
