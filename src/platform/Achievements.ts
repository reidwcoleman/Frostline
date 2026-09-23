// Watches gameplay events + player/env state and unlocks achievements / bumps lifetime stats.
// Owned by Platform (ticked from Platform.update while playing). Unlocks are idempotent.
import * as THREE from 'three';
import type { AchievementId, GameContext } from '../core/types';
import type { StatId } from './achievementData';

/** What the tracker needs from Platform (keeps this file free of a circular import). */
export interface AchievementSink {
  unlockAchievement(id: AchievementId): void;
  isUnlocked(id: AchievementId): boolean;
  addStat(id: StatId, delta: number): number;
  maxStat(id: StatId, value: number): number;
  getStat(id: StatId): number;
}

const SPEED_DEMON_MS = 100 / 3.6; // 27.78 m/s
const BIG_AIR_S = 3;
const SUMMIT_RADIUS = 30;
/** Ignore this much of the map border when looking for the summit (outer rim = world edge). */
const SUMMIT_EDGE_MARGIN = 150;
/** A summit must be the highest point within this radius (m). */
const SUMMIT_PEAK_RADIUS = 120;
const HOMESTEAD_HOLD_S = 5;
/** A blizzard counts if it lasted at least this long (real seconds) and you spent most of it outside. */
const BLIZZARD_MIN_S = 45;
const BLIZZARD_OUTDOOR_FRACTION = 0.75;
/** Distance is flushed to the lifetime stat in chunks (meters). */
const DISTANCE_CHUNK = 25;

type LooseBus = { on(type: string, fn: (payload: unknown) => void): () => void };

export class Achievements {
  /** Highest point of the map (computed at init). */
  readonly summit = new THREE.Vector3();
  private summitKnown = false;
  private fastTime = 0;
  private indoorTime = 0;
  private summitCheck = 0;
  private blizzard = { active: false, time: 0, outdoor: 0, failed: false };
  private distance = 0;
  private lastPos = new THREE.Vector3();
  private hasLastPos = false;

  constructor(private ctx: GameContext, private sink: AchievementSink) {
    const ev = ctx.events;
    ev.on('newGame', () => this.resetRun());
    ev.on('loadedGame', () => {
      this.resetRun();
      this.onDay(ctx.clock.day); // retroactive for saves from before an update
    });
    ev.on('player:respawned', () => {
      this.hasLastPos = false;
      this.blizzard.failed = true;
    });
    ev.on('day:start', ({ day }) => this.onDay(day));
    ev.on('fire:lit', () => this.unlock('FIRST_FIRE'));
    ev.on('tree:felled', () => {
      const total = this.sink.addStat('trees_felled', 1);
      this.unlock('TIMBER');
      if (total >= 50) this.unlock('LUMBERJACK');
    });
    ev.on('animal:killed', ({ species }) => {
      if (species === 'deer') {
        this.sink.addStat('deer_killed', 1);
        this.unlock('HUNTER');
      } else if (species === 'wolf') {
        const total = this.sink.addStat('wolves_killed', 1);
        this.unlock('WOLF_SLAYER');
        if (total >= 10) this.unlock('PACK_BREAKER');
      }
    });
    ev.on('item:crafted', ({ recipe, item }) => {
      if (recipe === 'cook' || item === 'cooked_meat') this.unlock('CHEF');
    });
    ev.on('player:died', () => {
      if (this.blizzard.active) this.blizzard.failed = true;
    });
    // Optional event the survival module may emit when walls + roof enclose a floor.
    (ev as unknown as LooseBus).on('shelter:complete', () => this.unlock('HOMESTEAD'));
  }

  /**
   * Needs terrain: find the summit once the world exists. The raw heightmap maximum usually lies on the outer
   * rim right at the world edge (a slope the player can't stand on), so the summit is the highest real *peak*:
   * a local maximum at least SUMMIT_EDGE_MARGIN from the edge that is also the highest point within
   * SUMMIT_PEAK_RADIUS. Runs once during loading (~10 ms).
   */
  init() {
    const t = this.ctx.terrain?.data;
    if (!t) return;
    const { heights: h, res } = t;
    const margin = Math.ceil(SUMMIT_EDGE_MARGIN / t.cell);
    // 1. Cheap pass: strict 3x3 local maxima in the interior.
    const cand: number[] = [];
    for (let row = margin; row < res - margin; row++) {
      for (let col = margin; col < res - margin; col++) {
        const i = row * res + col;
        const v = h[i];
        if (v >= h[i - 1] && v > h[i + 1] && v >= h[i - res] && v > h[i + res] && v >= h[i - res - 1] && v > h[i + res + 1] && v >= h[i - res + 1] && v > h[i + res - 1]) cand.push(i);
      }
    }
    cand.sort((a, b) => h[b] - h[a]);
    // 2. Highest candidate that dominates its neighbourhood (the window may reach into the margin, so a
    //    slope that keeps climbing toward the rim is rejected).
    const r = Math.ceil(SUMMIT_PEAK_RADIUS / t.cell);
    let found = -1;
    for (let k = 0; k < cand.length && found < 0; k++) {
      const i = cand[k];
      const row = Math.floor(i / res);
      const col = i % res;
      let ok = true;
      for (let rr = Math.max(0, row - r); rr <= Math.min(res - 1, row + r) && ok; rr++) {
        for (let cc = Math.max(0, col - r); cc <= Math.min(res - 1, col + r); cc++) {
          if (h[rr * res + cc] > h[i]) {
            ok = false;
            break;
          }
        }
      }
      if (ok) found = i;
    }
    if (found < 0) return;
    const half = t.size / 2;
    this.summit.set(-half + (found % res) * t.cell, h[found], -half + Math.floor(found / res) * t.cell);
    this.summitKnown = true;
  }

  /** Dev modes (?fly / ?god) never unlock anything. */
  private get suppressed() {
    return this.ctx.dev.fly || this.ctx.dev.god;
  }

  private unlock(id: AchievementId) {
    if (this.suppressed || this.sink.isUnlocked(id)) return;
    this.sink.unlockAchievement(id);
  }

  private onDay(day: number) {
    this.sink.maxStat('days_survived', day);
    if (day >= 2) this.unlock('FIRST_NIGHT');
    if (day >= 3) this.unlock('SURVIVE_3');
    if (day >= 7) this.unlock('SURVIVE_7');
    if (day >= 30) this.unlock('SURVIVE_30');
  }

  private resetRun() {
    this.fastTime = 0;
    this.indoorTime = 0;
    this.hasLastPos = false;
    this.blizzard = { active: false, time: 0, outdoor: 0, failed: false };
  }

  update(dt: number) {
    const { player: p, env } = this.ctx;
    if (!p.alive) return;

    // --- Speed Demon: sustained 100 km/h on skis (3D speed: steep downhill counts). Sanity-capped so a
    // teleport or physics glitch can't award it.
    const v = p.velocity.length();
    if (p.onSkis && v >= SPEED_DEMON_MS && v < 90) this.fastTime += dt;
    else this.fastTime = 0;
    if (this.fastTime >= 0.25 || (p.onSkis && p.stats.topSpeed >= SPEED_DEMON_MS && p.stats.topSpeed < 90)) this.unlock('SPEED_DEMON');

    // --- Big Air
    if ((p.airTime >= BIG_AIR_S && p.airTime < 30) || (p.stats.longestAir >= BIG_AIR_S && p.stats.longestAir < 30)) this.unlock('BIG_AIR');

    // --- Summit (checked a few times per second)
    this.summitCheck -= dt;
    if (this.summitKnown && this.summitCheck <= 0) {
      this.summitCheck = 0.25;
      if (p.position.distanceTo(this.summit) <= SUMMIT_RADIUS) this.unlock('SUMMIT');
    }

    // --- Homestead fallback: inside an enclosed shelter, warmed by a fire, for 5 s.
    if (p.indoors && (p.nearFire > 0.15 || p.shelter >= 0.9)) this.indoorTime += dt;
    else this.indoorTime = 0;
    if (this.indoorTime >= HOMESTEAD_HOLD_S) this.unlock('HOMESTEAD');

    // --- Cold Snap: live through a whole blizzard, mostly outdoors.
    const b = this.blizzard;
    const blizzardNow = env.weather === 'blizzard';
    if (blizzardNow) {
      if (!b.active) Object.assign(b, { active: true, time: 0, outdoor: 0, failed: false });
      b.time += dt;
      if (!p.indoors && p.shelter < 0.5) b.outdoor += dt;
    } else if (b.active) {
      b.active = false;
      if (!b.failed && b.time >= BLIZZARD_MIN_S && b.outdoor >= b.time * BLIZZARD_OUTDOOR_FRACTION) this.unlock('COLD_SNAP');
    }

    // --- Lifetime distance on skis (own integration so it doesn't depend on who maintains stats).
    if (this.hasLastPos && p.onSkis && !this.suppressed) {
      const dx = p.position.x - this.lastPos.x;
      const dz = p.position.z - this.lastPos.z;
      const d = Math.hypot(dx, dz);
      if (d < 8) this.distance += d; // bigger jumps are teleports/respawns
      if (this.distance >= DISTANCE_CHUNK) {
        const chunk = Math.floor(this.distance);
        this.distance -= chunk;
        this.sink.addStat('distance_skied', chunk);
      }
    }
    this.lastPos.copy(p.position);
    this.hasLastPos = true;
  }
}
