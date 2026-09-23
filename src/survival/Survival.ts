// Survival system: vitals (warmth, satiety, stamina regen, health regen, cold/hunger damage),
// felt temperature, shelter, fires, harvesting, pickups, sleep, eating. See Vitals.ts for numbers.
import * as THREE from 'three';
import type { GameContext, GameState, LoopHandle, System } from '../core/types';
import { ITEMS, type ItemId } from '../core/Items';
import { clamp } from '../core/math';
import { Effects } from './Particles';
import { FireManager, FIRE, type FirePos } from './Fires';
import { Shelter } from './Shelter';
import { Sleep } from './Sleep';
import { Harvest, type HarvestSave } from './Harvest';
import { Pickups, type PickupsSave } from './Pickups';
import { matTime } from './Materials';
import { V, feltTemperature, stepWarmth, coldDamage, timeToDeath, warmthTarget } from './Vitals';

interface SurvivalSave {
  hotFood: number;
  homestead: boolean;
  harvest: HarvestSave;
  pickups: PickupsSave;
}

const _dir = new THREE.Vector3();

export class Survival implements System {
  readonly name = 'survival';
  readonly updateWhen: GameState[] = ['playing'];
  readonly fx: Effects;
  readonly fires: FireManager;
  readonly shelter: Shelter;
  readonly sleep: Sleep;
  readonly harvest: Harvest;
  readonly pickups: Pickups;
  /** Breakdown of the last felt-temperature calculation (for HUD tooltips / debugging). */
  readonly felt = { air: 0, wind: 0, fire: 0, shelter: 0, total: 0, target: 100 };
  private hotFood = 0;
  private homestead = false;
  private lastHours = -1;
  private staminaLast = 100;
  private staminaDelay = 0;
  private coldAcc = 0;
  private hungerAcc = 0;
  private burnAcc = 0;
  private breathT = 2;
  private heartbeat: LoopHandle | null = null;

  constructor(private ctx: GameContext) {
    this.fx = new Effects(ctx);
    this.fires = new FireManager(ctx, this.fx);
    this.shelter = new Shelter(ctx);
    this.sleep = new Sleep(ctx, this);
    this.harvest = new Harvest(ctx, this);
    this.pickups = new Pickups(ctx, this);
  }

  init() {
    this.fx.init();
    this.sleep.init();
    this.harvest.init();
    this.pickups.init();
  }

  reset() {
    this.fires.clear();
    this.fx.clear();
    this.shelter.reset();
    this.sleep.reset();
    this.harvest.reset();
    this.pickups.reset();
    this.hotFood = 0;
    this.homestead = false;
    this.lastHours = -1;
    this.staminaLast = 100;
    this.coldAcc = this.hungerAcc = this.burnAcc = 0;
    this.heartbeat?.stop(0.2);
    this.heartbeat = null;
  }

  // ---------------------------------------------------------------- public API
  /** Eat / apply an item from the inventory. Returns true if consumed. */
  consume(item: ItemId): boolean {
    const { inventory, player: p, audio, ui, events } = this.ctx;
    const def = ITEMS[item];
    if (!def || !inventory.has(item) || !p.alive) return false;
    if (def.kind === 'food') {
      if (p.satiety >= 99 && !(def.heal && p.health < 99)) {
        ui.toast("You're full", 'info');
        return false;
      }
      inventory.remove(item, 1);
      p.satiety = Math.min(100, p.satiety + (def.food ?? 0));
      if (def.heal) p.heal(def.heal);
      if (def.warmth) {
        p.warmth = Math.min(100, p.warmth + def.warmth);
        this.hotFood = V.hotFoodSeconds;
      }
      audio.play('player_eat');
    } else if (def.kind === 'medical') {
      if (p.health >= 99.5) {
        ui.toast("You're not hurt", 'info');
        return false;
      }
      inventory.remove(item, 1);
      p.heal(def.heal ?? 0);
      audio.play('player_heal');
    } else return false;
    events.emit('item:consumed', { item });
    return true;
  }

  /** Lit fires as {x,y,z,radius}: wolves won't come inside `radius`. Don't mutate. */
  firePositions(): FirePos[] {
    return this.fires.positionsList();
  }

  /** Felt temperature at a point for the player's current exposure (sleep checks, UI previews). */
  feltTemperatureAt(at: THREE.Vector3, sleeping = false): number {
    const { env, player } = this.ctx;
    return feltTemperature({
      air: env.temperatureAt(at.y),
      windStrength: env.windStrength,
      speed: 0,
      snowfall: env.snowfall,
      windBlock: this.shelter.windBlock,
      roof: this.shelter.roof,
      shelter: this.shelter.shelter,
      indoors: player.indoors,
      fire: this.fires.warmthAt(at),
      torch: false,
      hotFood: this.hotFood / V.hotFoodSeconds,
      sleeping,
    });
  }

  /** Dev/tuning: seconds to death at a constant felt temperature from full vitals. */
  simulate(felt: number) {
    return { felt, target: warmthTarget(felt), secondsToDeath: timeToDeath(felt), minutes: +(timeToDeath(felt) / 60).toFixed(2) };
  }

  // ---------------------------------------------------------------- frame
  update(dt: number) {
    const { clock } = this.ctx;
    matTime.value += dt;
    // In-game hours elapsed this frame (covers timeScale during sleep; 0 when frozen).
    const hours = this.lastHours < 0 ? 0 : clamp(clock.totalHours - this.lastHours, 0, 12);
    this.lastHours = clock.totalHours;
    this.fx.update(dt);
    this.fires.update(dt, hours);
    this.shelter.update(dt);
    this.harvest.update(dt);
    this.pickups.update(dt);
    this.sleep.update(dt, hours);
    this.vitals(dt, hours);
  }

  private vitals(dt: number, hours: number) {
    const { player: p, env, inventory, dev, audio, events, ui } = this.ctx;
    if (!p.alive) {
      this.heartbeat?.stop(0.5);
      this.heartbeat = null;
      return;
    }
    const sh = this.shelter;
    const fireW = this.fires.warmthAt(p.position);
    const torch = inventory.equipped === 'torch';
    p.shelter = sh.shelter;
    p.indoors = sh.indoors;
    p.nearFire = clamp(fireW + (torch ? 0.25 : 0), 0, 1);
    this.hotFood = Math.max(0, this.hotFood - dt);
    const air = env.temperatureAt(p.position.y);
    const felt = feltTemperature({
      air,
      windStrength: env.windStrength,
      speed: p.onSkis ? p.speed : 0,
      snowfall: env.snowfall,
      windBlock: sh.windBlock,
      roof: sh.roof,
      shelter: sh.shelter,
      indoors: sh.indoors,
      fire: fireW,
      torch,
      hotFood: this.hotFood / V.hotFoodSeconds,
      sleeping: this.sleep.sleeping,
    });
    p.feltTemperature = felt;
    this.felt.air = air;
    this.felt.fire = V.fireWarmth * fireW;
    this.felt.wind = felt - air - this.felt.fire;
    this.felt.shelter = sh.shelter;
    this.felt.total = felt;
    this.felt.target = warmthTarget(felt);

    const god = dev.god;
    // ---- warmth
    if (!god) p.warmth = stepWarmth(p.warmth, felt, dt);
    else p.warmth = Math.max(p.warmth, stepWarmth(p.warmth, felt, dt));
    // ---- satiety (in-game hours)
    if (!god) {
      let mul = 1;
      if (p.warmth < 40) mul += V.coldHungerMul * (1 - p.warmth / 40);
      if (p.sprinting) mul += V.sprintHungerMul;
      if (p.onSkis && p.speed > 3) mul += V.skiHungerMul;
      if (this.sleep.sleeping) mul *= V.sleepSatietyMul;
      p.satiety = Math.max(0, p.satiety - hours * V.satietyPerHour * mul);
    }
    // ---- damage from empty meters (applied in chunks so the HUD doesn't flash every frame)
    if (p.warmth <= 0.01) {
      this.coldAcc += coldDamage(felt) * dt;
      if (this.coldAcc >= 2) {
        p.damage(this.coldAcc, 'cold');
        this.coldAcc = 0;
      }
    } else this.coldAcc = 0;
    if (p.satiety <= 0.01) {
      this.hungerAcc += V.hungerDps * dt + (this.sleep.sleeping ? hours * 2 : 0);
      if (this.hungerAcc >= 2) {
        p.damage(this.hungerAcc, 'hunger');
        this.hungerAcc = 0;
      }
    } else this.hungerAcc = 0;
    if (this.fires.inFlames(p.position)) {
      this.burnAcc += FIRE.burnDps * dt;
      if (this.burnAcc >= 3) {
        p.damage(this.burnAcc, 'fire');
        this.burnAcc = 0;
      }
    } else this.burnAcc = Math.max(0, this.burnAcc - dt);
    // ---- health regeneration when warm and fed
    const sinceHurt = performance.now() / 1000 - p.lastDamageTime;
    if (p.alive && p.health < 100 && p.warmth > 50 && p.satiety > 30 && sinceHurt > 6) {
      let r = V.regen + (p.satiety > 70 ? V.regenWellFed : 0);
      if (p.indoors || p.nearFire > 0.3) r *= 1.5;
      p.health = Math.min(100, p.health + r * dt + (this.sleep.sleeping ? V.sleepHealPerHour * hours : 0));
    }
    // ---- stamina regen (the player controller drains it)
    if (p.stamina < this.staminaLast - 1e-3) this.staminaDelay = V.staminaDelay;
    this.staminaDelay -= dt;
    if (this.staminaDelay <= 0 && !p.sprinting && p.stamina < 100) {
      let r = p.speed < 0.5 ? V.staminaRegenRest : V.staminaRegen;
      if (p.warmth < 25) r *= 0.6;
      if (p.satiety < 15) r *= 0.6;
      p.stamina = Math.min(100, p.stamina + r * dt);
    }
    this.staminaLast = p.stamina;

    // ---- feedback: breath vapour, cold breathing, heartbeat
    this.breathT -= dt * (p.sprinting ? 2 : 1);
    if (this.breathT <= 0 && !this.sleep.sleeping) {
      this.breathT = 3.2 + Math.random() * 1.6;
      if (felt < 2) {
        const cam = this.ctx.camera;
        cam.getWorldDirection(_dir);
        this.fx.breath(cam.position.x, cam.position.y, cam.position.z, _dir.x, _dir.z);
      }
      if (p.warmth < 35 || felt < -14) audio.play('player_breath_cold', { volume: clamp(0.35 + (35 - p.warmth) / 50, 0.3, 1) });
    }
    if (p.health < 25) {
      if (!this.heartbeat) this.heartbeat = audio.loop('heartbeat', { volume: 0 });
      this.heartbeat.setVolume(clamp((30 - p.health) / 25, 0.2, 1));
      this.heartbeat.setPitch(1 + (25 - p.health) / 60);
    } else if (this.heartbeat && p.health > 30) {
      this.heartbeat.stop(1.5);
      this.heartbeat = null;
    }

    // ---- first time inside a sealed cabin
    if (!this.homestead && sh.enclosed) {
      this.homestead = true;
      events.emit('shelter:complete', {});
      ui.toast('Four walls and a roof. The wind can’t reach you here.', 'good');
    }
  }

  // ---------------------------------------------------------------- saves
  serialize(): SurvivalSave {
    return { hotFood: this.hotFood, homestead: this.homestead, harvest: this.harvest.serialize(), pickups: this.pickups.serialize() };
  }

  deserialize(d: SurvivalSave) {
    if (!d) return;
    this.hotFood = d.hotFood ?? 0;
    this.homestead = !!d.homestead;
    this.harvest.deserialize(d.harvest);
    this.pickups.deserialize(d.pickups);
  }
}
