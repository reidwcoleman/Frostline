// PLACEHOLDER weapons system (owned by the combat/wildlife agent).
import type { GameContext, System } from '../core/types';

export class Weapons implements System {
  readonly name = 'weapons';
  constructor(private ctx: GameContext) {}
  update(_dt: number) {
    void this.ctx;
  }
}
