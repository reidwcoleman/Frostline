// Timed crafting. craft(id) takes the materials up front and finishes after Recipe.seconds;
// cancel() refunds. Recipes that need a fire require standing within 3 m of a burning one (and
// are cancelled if you walk away). Cooking can also be done directly at a fire ("Cook meat").
import type { GameContext, GameState, System } from '../core/types';
import { RECIPES, type Recipe } from '../core/data';
import type { ItemId } from '../core/Items';

const FIRE_RANGE = 3;

export class Crafting implements System {
  readonly name = 'crafting';
  readonly updateWhen: GameState[] = ['playing', 'paused'];
  readonly recipes: Recipe[] = RECIPES;
  /** Recipe being crafted right now (null when idle). */
  current: Recipe | null = null;
  private elapsed = 0;

  constructor(private ctx: GameContext) {}

  reset() {
    this.current = null;
    this.elapsed = 0;
  }

  /** Is the player near a lit fire (cooking)? */
  nearFire(): boolean {
    const s = this.ctx.sys.survival;
    return !!s && s.fires.nearestLit(this.ctx.player.position) <= FIRE_RANGE;
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
    if (!r || this.current) return false;
    return Object.keys(this.missing(id)).length === 0 && (!r.needsFire || this.nearFire());
  }

  /** Why a recipe can't be crafted right now (null = it can). */
  blockedReason(id: string): string | null {
    const r = this.recipes.find((x) => x.id === id);
    if (!r) return 'Unknown recipe';
    if (this.current) return `Crafting ${this.current.name.toLowerCase()}…`;
    if (Object.keys(this.missing(id)).length) return 'Missing materials';
    if (r.needsFire && !this.nearFire()) return 'Needs a fire';
    return null;
  }

  /** Start crafting. Returns false if not possible. */
  craft(id: string): boolean {
    const r = this.recipes.find((x) => x.id === id);
    if (!r || !this.canCraft(id)) {
      this.ctx.audio.play('ui_error');
      return false;
    }
    if (!this.ctx.inventory.removeAll(r.cost)) return false;
    this.current = r;
    this.elapsed = 0;
    if (r.seconds <= 0) this.finish();
    return true;
  }

  /** Stop the craft in progress and give the materials back. */
  cancel() {
    const r = this.current;
    if (!r) return;
    for (const k in r.cost) this.ctx.inventory.add(k as ItemId, r.cost[k as ItemId]!);
    this.current = null;
    this.elapsed = 0;
  }

  /** 0..1 progress of the craft in progress, or -1 when idle. */
  get progress(): number {
    return this.current ? Math.min(1, this.elapsed / Math.max(0.01, this.current.seconds)) : -1;
  }

  update(dt: number) {
    const r = this.current;
    if (!r) return;
    if (!this.ctx.player.alive) {
      this.cancel();
      return;
    }
    if (this.ctx.game.state !== 'playing' && !this.ctx.ui.blocking) return;
    if (r.needsFire && !this.nearFire()) {
      this.cancel();
      this.ctx.ui.toast(`Moved away from the fire — ${r.name.toLowerCase()} cancelled`, 'warn');
      return;
    }
    this.elapsed += dt;
    if (this.elapsed >= r.seconds) this.finish();
  }

  private finish() {
    const r = this.current!;
    this.current = null;
    this.elapsed = 0;
    this.ctx.inventory.add(r.out, r.count);
    this.ctx.audio.play(r.id === 'cook' ? 'cook_sizzle' : 'ui_craft');
    this.ctx.events.emit('item:crafted', { recipe: r.id, item: r.out, count: r.count });
  }
}
