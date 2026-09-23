// PLACEHOLDER main-menu flyover camera (owned by the UI agent).
import type { GameContext, GameState, System } from '../core/types';

export class MenuCamera implements System {
  readonly name = 'menuCam';
  readonly updateWhen: GameState[] = ['menu'];
  private t = 0;
  constructor(private ctx: GameContext) {}
  update(dt: number) {
    const { camera, terrain } = this.ctx;
    this.t += dt;
    const [lx, lz] = terrain.data.lakeCenter;
    const a = this.t * 0.02;
    const x = lx + Math.cos(a) * 700,
      z = lz + Math.sin(a) * 700;
    camera.position.set(x, terrain.heightAt(x, z) + 140, z);
    camera.lookAt(lx, terrain.lakeLevel + 40, lz);
  }
}
