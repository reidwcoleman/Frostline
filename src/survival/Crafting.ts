// PLACEHOLDER crafting system (owned by the survival/building agent).
import type { GameContext, System } from '../core/types';
import { RECIPES, type Recipe } from '../core/data';
import type { ItemId } from '../core/Items';

export class Crafting implements System {
  readonly name = 'crafting';
  readonly recipes: Recipe[] = RECIPES;
  constructor(private ctx: GameContext) {}
  /** Is the player near a lit fire (cooking)? */
  nearFire(): boolean {
    return false;
  }
  /** Items still missing for a recipe (empty object = affordable). */
  missing(id: string): Partial<Record<ItemId, number>> {
    const r = this.recipes.find((x) => x.id === id);
    const out: Partial<Record<ItemId, number>> = {};
    if (!r) return out;
    for (const k in r.cost) {
      const need = r.cost[k as ItemId]! - this.ctx.inventory.count(k as ItemId);
      if (need > 0) out[k as ItemId] = need;
    }
    return out;
  }
  canCraft(id: string): boolean {
    const r = this.recipes.find((x) => x.id === id);
    return !!r && Object.keys(this.missing(id)).length === 0 && (!r.needsFire || this.nearFire());
  }
  /** Start crafting. Returns false if not possible. */
  craft(id: string): boolean {
    const r = this.recipes.find((x) => x.id === id);
    if (!r || !this.canCraft(id)) return false;
    this.ctx.inventory.removeAll(r.cost);
    this.ctx.inventory.add(r.out, r.count);
    this.ctx.events.emit('item:crafted', { recipe: r.id, item: r.out, count: r.count });
    return true;
  }
  /** 0..1 progress of the craft in progress, or -1 when idle. */
  get progress(): number {
    return -1;
  }
}
