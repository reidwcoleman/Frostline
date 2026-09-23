// Shelter detection: rays from the player's head — up (roof) and horizontally in 12 directions
// (walls/terrain/rocks) — against structure colliders. Produces:
//   roof 0..1, walls 0..1, windBlock 0..1 (walls weighted toward the upwind side, + forest),
//   shelter 0..1 and indoors (roofed and mostly enclosed). Runs at ~5 Hz, results are smoothed.
import * as THREE from 'three';
import type { GameContext } from '../core/types';
import { Layer } from '../core/Physics';
import { clamp, damp } from '../core/math';
import { V as VIT } from './Vitals';

const H_DIRS = 12;
const UP_RAYS: THREE.Vector3[] = [new THREE.Vector3(0, 1, 0)];
for (let i = 0; i < 4; i++) {
  const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
  UP_RAYS.push(new THREE.Vector3(Math.cos(a) * 0.5, 0.866, Math.sin(a) * 0.5));
}
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();

export class Shelter {
  roof = 0;
  walls = 0;
  windBlock = 0;
  shelter = 0;
  indoors = false;
  /** Fully enclosed by structures (every ray hits a built piece) — the HOMESTEAD moment. */
  enclosed = false;
  private rawRoof = 0;
  private rawWalls = 0;
  private rawWind = 0;
  private rawStructWalls = 0;
  private timer = 0;

  constructor(private ctx: GameContext) {}

  reset() {
    this.roof = this.walls = this.windBlock = this.shelter = 0;
    this.rawRoof = this.rawWalls = this.rawWind = this.rawStructWalls = 0;
    this.indoors = this.enclosed = false;
  }

  update(dt: number) {
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = 0.2;
      this.sample();
    }
    // Smooth so walking through a doorway doesn't flicker the HUD.
    this.roof = damp(this.roof, this.rawRoof, 6, dt);
    this.walls = damp(this.walls, this.rawWalls, 6, dt);
    this.windBlock = damp(this.windBlock, this.rawWind, 4, dt);
    this.shelter = clamp(0.5 * this.roof + 0.5 * this.walls, 0, 1);
    this.indoors = this.rawRoof >= 0.8 && this.rawWalls >= 0.75;
    this.enclosed = this.rawRoof >= 0.95 && this.rawStructWalls >= 0.99;
  }

  private sample() {
    const { player, physics, env, world } = this.ctx;
    const p = player.position;
    const head = player.crouching ? 1.0 : 1.6;
    _o.set(p.x, p.y + head, p.z);
    // Roof: vertical ray counts double.
    let roofHits = 0,
      roofW = 0;
    for (let i = 0; i < UP_RAYS.length; i++) {
      const w = i === 0 ? 2 : 1;
      roofW += w;
      const h = physics.raycast(_o, UP_RAYS[i], 7, { mask: Layer.SOLID, terrain: false, trees: false, rocks: false });
      if (h) roofHits += w;
    }
    this.rawRoof = roofHits / roofW;
    // Walls: 12 horizontal rays at chest height; terrain & rocks count as a windbreak too.
    const wl = env.windStrength > 0.01 ? Math.hypot(env.wind.x, env.wind.z) : 0;
    const upwindX = wl > 0 ? -env.wind.x / wl : 0,
      upwindZ = wl > 0 ? -env.wind.z / wl : 0;
    let hits = 0,
      structHits = 0,
      windW = 0,
      windHit = 0;
    _o.y = p.y + Math.min(head, 1.2);
    for (let i = 0; i < H_DIRS; i++) {
      const a = (i / H_DIRS) * Math.PI * 2;
      _d.set(Math.cos(a), 0, Math.sin(a));
      const h = physics.raycast(_o, _d, 4.5, { mask: Layer.SOLID, terrain: true, trees: false, rocks: true });
      const hit = h ? 1 : 0;
      hits += hit;
      if (h && h.kind === 'collider') structHits++;
      const w = wl > 0 ? Math.max(0, _d.x * upwindX + _d.z * upwindZ) : 1;
      windW += w;
      windHit += w * hit;
    }
    this.rawWalls = hits / H_DIRS;
    this.rawStructWalls = structHits / H_DIRS;
    const windward = windW > 0 ? windHit / windW : this.rawWalls;
    // Dense forest breaks the wind.
    let trees = 0;
    world.forEachTree(p.x, p.z, 9, () => {
      trees++;
      return trees >= 8;
    });
    const forest = clamp((trees - 2) / 6, 0, 1) * VIT.forestWindBlock;
    this.rawWind = clamp(0.3 * this.rawRoof + 0.7 * windward + forest, 0, 1);
  }
}
