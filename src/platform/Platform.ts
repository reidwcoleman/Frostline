// PLACEHOLDER platform layer (owned by the platform/Steam agent). Web implementation.
import type { AchievementId, GameContext, PlatformAPI, System } from '../core/types';

export class Platform implements System, PlatformAPI {
  readonly name = 'platform';
  readonly isElectron = false;
  readonly steam = false;
  constructor(private ctx: GameContext) {}
  unlockAchievement(id: AchievementId) {
    console.info('[platform] achievement', id);
    void this.ctx;
  }
  setStat(_name: string, _value: number) {}
  async saveWrite(slot: string, data: string) {
    localStorage.setItem('frostline.save.' + slot, data);
  }
  async saveRead(slot: string) {
    return localStorage.getItem('frostline.save.' + slot);
  }
  async saveDelete(slot: string) {
    localStorage.removeItem('frostline.save.' + slot);
  }
  setFullscreen(on: boolean) {
    if (on) void document.documentElement.requestFullscreen?.().catch(() => {});
    else if (document.fullscreenElement) void document.exitFullscreen();
  }
  quit() {
    window.close();
  }
}
