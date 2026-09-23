// PLACEHOLDER survival system (owned by the survival/building agent).
import type { GameContext, System } from '../core/types';
import type { ItemId } from '../core/Items';

export class Survival implements System {
  readonly name = 'survival';
  constructor(private ctx: GameContext) {}
  /** Eat / apply an item from the inventory. Returns true if consumed. */
  consume(item: ItemId): boolean {
    void item;
    void this.ctx;
    return false;
  }
}
