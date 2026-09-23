// PLACEHOLDER save system (owned by the platform/Steam agent).
import type { GameContext, GameState, System } from '../core/types';
import type { SaveData } from '../core/Game';

export class SaveSystem implements System {
  readonly name = 'save';
  readonly updateWhen: GameState[] = ['playing'];
  constructor(private ctx: GameContext) {}
  async hasSave(): Promise<boolean> {
    return !!(await this.ctx.platform.saveRead('slot1'));
  }
  async save(): Promise<void> {
    await this.ctx.platform.saveWrite('slot1', JSON.stringify(this.ctx.game.collectSave()));
  }
  async load(): Promise<boolean> {
    const raw = await this.ctx.platform.saveRead('slot1');
    if (!raw) return false;
    this.ctx.game.applySave(JSON.parse(raw) as SaveData);
    return true;
  }
}
