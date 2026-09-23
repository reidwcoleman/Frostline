// PLACEHOLDER weather (owned by the atmosphere agent — replace freely).
import type { GameContext, GameState, System } from '../core/types';

export class Weather implements System {
  readonly name = 'weather';
  readonly updateWhen: GameState[] = ['menu', 'playing', 'dead'];
  constructor(private ctx: GameContext) {}
  init() {
    if (this.ctx.dev.weather) this.ctx.env.weather = this.ctx.dev.weather;
  }
}
