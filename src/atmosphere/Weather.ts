// Weather: a clear -> overcast -> snow -> blizzard chain (and back) that drifts over in-game hours.
// Later days are harsher; blizzards are rare, dangerous events (~1 per 2 days after day 2, 1-3 h long).
// Drives ctx.env (weather, wind, snowfall, visibility, temperature) and the visual parameters the sky,
// fog and particles read. Honours ?weather= (locks it) and serialises its state.
import * as THREE from 'three';
import type { GameContext, GameState, System, WeatherKind } from '../core/types';
import { clamp, damp, hash1, lerp, smoothstep } from '../core/math';
import { SnowParticles } from './SnowParticles';
import { Spindrift } from './Spindrift';

export interface WeatherVisual {
  cloudCover: number;
  /** Optical thickness of the cloud deck (darker undersides, deeper shadows). */
  cloudThickness: number;
  cloudAltitude: number;
  /** Cloud field scroll (m). */
  cloudOffset: THREE.Vector2;
  /** Uniform weather fog density (1/m). */
  weatherFog: number;
  /** Valley fog density at the lake level (1/m). */
  valleyFog: number;
  hazeMul: number;
  /** Aurora activity tonight 0..1 (sky hides it under clouds / daylight). */
  aurora: number;
  /** 0..1 blizzard factor (for post whiteout / audio). */
  storm: number;
  /** High cirrus coverage 0..1 and streak direction (rad). */
  cirrus: number;
  cirrusAngle: number;
}

interface KindParams {
  cover: number;
  thickness: number;
  fog: number;
  snow: number;
  wind: number;
  gust: number;
  haze: number;
  temp: number;
}

const PARAMS: Record<WeatherKind, KindParams> = {
  clear: { cover: 0.18, thickness: 6, fog: 0, snow: 0, wind: 3.5, gust: 0.35, haze: 1.0, temp: 0 },
  overcast: { cover: 0.9, thickness: 14, fog: 0.00022, snow: 0.04, wind: 6, gust: 0.4, haze: 1.35, temp: -1 },
  snow: { cover: 1.0, thickness: 22, fog: 0.0032, snow: 0.55, wind: 7.5, gust: 0.45, haze: 1.6, temp: -2 },
  blizzard: { cover: 1.0, thickness: 34, fog: 0.062, snow: 1.0, wind: 19, gust: 0.6, haze: 2.2, temp: -10 },
};

const DURATION: Record<WeatherKind, [number, number]> = {
  clear: [1.5, 4],
  overcast: [1, 2.5],
  snow: [2, 5],
  blizzard: [0.75, 2],
};

/** Small serialisable PRNG. */
class Rng {
  constructor(public s: number) {}
  next() {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number) {
    return a + (b - a) * this.next();
  }
}

export class Weather implements System {
  readonly name = 'weather';
  readonly updateWhen: GameState[] = ['menu', 'playing', 'dead'];

  /** Visual parameters (sky, fog, particles). */
  readonly visual: WeatherVisual = {
    cloudCover: 0.18,
    cloudThickness: 6,
    cloudAltitude: 2700,
    cloudOffset: new THREE.Vector2(),
    weatherFog: 0,
    valleyFog: 0,
    hazeMul: 1,
    aurora: 0,
    storm: 0,
    cirrus: 0.35,
    cirrusAngle: 0.6,
  };

  current: WeatherKind = 'clear';
  target: WeatherKind = 'clear';
  /** 0..1 transition progress current -> target. */
  progress = 1;
  /** In-game hours the transition takes. */
  transitionHours = 0.4;
  /** In-game hours left before the next change. */
  remaining = 6;
  private rng = new Rng(20240917);
  private locked = false;
  /** Per-instance flavour of a clear day (some have more fair-weather cumulus). */
  private clearCover = 0.18;
  private cirrusTarget = 0.35;
  private windAngle = 0.6;
  private gustT = 0;
  private temp = -6;
  private announced: WeatherKind = 'clear';
  private particles: SnowParticles | null = null;
  private spindrift: Spindrift | null = null;
  private _w = new THREE.Vector3();

  constructor(private ctx: GameContext) {}

  init() {
    this.particles = new SnowParticles(this.ctx);
    this.spindrift = new Spindrift(this.ctx);
    this.reset();
  }

  reset() {
    const dev = this.ctx.dev.weather;
    this.rng = new Rng(((this.ctx.game.seed ?? 42) * 7919 + 17) >>> 0);
    this.locked = !!dev && dev in PARAMS;
    // Open on gently falling snow (the game's signature mood); it clears, clouds over and snows
    // again on its own, with the first storms possible from day one.
    this.current = this.target = this.locked ? (dev as WeatherKind) : 'snow';
    this.progress = 1;
    this.remaining = this.locked ? 1e9 : 2.5;
    this.clearCover = 0.12;
    this.cirrusTarget = 0.45;
    this.windAngle = this.rng.range(0, Math.PI * 2);
    this.announced = this.current;
    this.snapVisuals();
    this.ctx.env.weather = this.current;
  }

  /** Force a weather state (dev / scripted events). transitionHours = 0 snaps instantly. */
  setWeather(kind: WeatherKind, transitionHours = 0.3, lock = false) {
    this.locked = lock;
    if (transitionHours <= 0) {
      this.current = this.target = kind;
      this.progress = 1;
      this.snapVisuals();
    } else {
      if (this.progress < 1) this.current = this.progress > 0.5 ? this.target : this.current;
      this.target = kind;
      this.progress = 0;
      this.transitionHours = transitionHours;
    }
    this.remaining = lock ? 1e9 : this.rng.range(DURATION[kind][0], DURATION[kind][1]);
  }

  private pickNext(from: WeatherKind): WeatherKind {
    const day = this.ctx.clock.day;
    const r = this.rng.next();
    switch (from) {
      case 'clear':
        return r < 0.2 ? 'clear' : 'overcast';
      case 'overcast': {
        const pSnow = clamp(0.68 + 0.04 * day, 0.68, 0.85);
        return r < pSnow ? 'snow' : 'clear';
      }
      case 'snow': {
        // Storms from day 1: occasional at first, more often as the winter deepens.
        const pBliz = clamp(0.22 + 0.06 * (day - 1), 0.22, 0.55);
        if (r < pBliz) return 'blizzard';
        return this.rng.next() < 0.4 ? 'snow' : 'overcast';
      }
      case 'blizzard':
        return 'snow';
    }
  }

  private params(kind: WeatherKind): KindParams {
    const p = PARAMS[kind];
    if (kind === 'clear') return { ...p, cover: this.clearCover };
    return p;
  }

  private snapVisuals() {
    const p = this.params(this.current);
    const v = this.visual;
    v.cloudCover = p.cover;
    v.cloudThickness = p.thickness;
    v.weatherFog = p.fog;
    v.hazeMul = p.haze;
    v.storm = this.current === 'blizzard' ? 1 : 0;
    v.cirrus = this.cirrusTarget;
    this.ctx.env.snowfall = p.snow;
  }

  update(dt: number) {
    const { clock, env } = this.ctx;
    const hours = clock.frozen || this.ctx.game.state !== 'playing' ? 0 : dt * clock.hoursPerSecond;

    // ---- state machine ----------------------------------------------------------------------
    if (this.progress < 1) {
      this.progress = Math.min(1, this.progress + hours / Math.max(this.transitionHours, 1e-3));
      if (this.progress >= 1) this.current = this.target;
    } else if (!this.locked) {
      this.remaining -= hours;
      if (this.remaining <= 0) {
        const next = this.pickNext(this.current);
        if (next === 'clear') {
          this.clearCover = this.rng.next() < 0.45 ? 0 : this.rng.range(0.1, 0.34);
          this.cirrusTarget = this.rng.range(0.05, 0.7);
        }
        this.target = next;
        this.progress = next === this.current ? 1 : 0;
        this.transitionHours = next === 'blizzard' || this.current === 'blizzard' ? this.rng.range(0.25, 0.45) : this.rng.range(0.35, 0.8);
        this.remaining = this.rng.range(DURATION[next][0], DURATION[next][1]);
      }
    }
    const shown: WeatherKind = this.progress >= 0.35 ? this.target : this.current;
    if (shown !== this.announced) {
      this.announced = shown;
      env.weather = shown;
      this.ctx.events.emit('weather:changed', { kind: shown });
    }
    env.weather = shown;

    // ---- blended parameters -----------------------------------------------------------------
    const a = this.params(this.current),
      b = this.params(this.target);
    const t = smoothstep(0, 1, this.progress);
    // Clouds build first, snow and fog follow (and clear in reverse).
    const worsening = b.fog + b.snow > a.fog + a.snow;
    const tc = worsening ? smoothstep(0, 0.6, this.progress) : smoothstep(0.4, 1, this.progress);
    const tf = worsening ? smoothstep(0.3, 1, this.progress) : smoothstep(0, 0.7, this.progress);
    const v = this.visual;
    v.cloudCover = lerp(a.cover, b.cover, tc);
    v.cloudThickness = lerp(a.thickness, b.thickness, tc);
    // fog density blends geometrically (visibility feels linear that way)
    v.weatherFog = Math.exp(lerp(Math.log(a.fog + 1e-5), Math.log(b.fog + 1e-5), tf)) - 1e-5;
    v.hazeMul = lerp(a.haze, b.haze, t);
    v.storm = lerp(this.current === 'blizzard' ? 1 : 0, this.target === 'blizzard' ? 1 : 0, tf);
    v.cirrus = damp(v.cirrus, this.cirrusTarget, 0.05, dt);
    env.snowfall = lerp(a.snow, b.snow, tf);

    // Valley fog: settles in the cold clear hours around dawn, burns off by late morning.
    const h = clock.time;
    const dawnFog = smoothstep(2.5, 6.5, h) * (1 - smoothstep(7.5, 10.5, h)) + 0.35 * smoothstep(20, 23.5, h) + 0.35 * (1 - smoothstep(0, 3, h));
    v.valleyFog = (0.0003 + 0.0016 * dawnFog) * (1 - v.cloudCover * 0.5);

    // Aurora tonight: day one always shows it; afterwards it's a gamble.
    const nightDay = h < 12 ? clock.day - 1 : clock.day;
    const roll = hash1(nightDay, 911);
    v.aurora = nightDay <= 1 ? 1 : roll < 0.35 ? 0 : 0.35 + 0.65 * hash1(nightDay, 77);

    // ---- wind -------------------------------------------------------------------------------
    this.gustT += dt;
    this.windAngle += (Math.sin(this.gustT * 0.013) * 0.004 + (this.rng.next() - 0.5) * 0.001) * dt * 10;
    const base = lerp(a.wind, b.wind, tf);
    const gustiness = lerp(a.gust, b.gust, tf);
    const g1 = Math.sin(this.gustT * 0.73) * 0.5 + Math.sin(this.gustT * 1.91 + 1.3) * 0.3 + Math.sin(this.gustT * 0.21 + 4.1) * 0.2;
    const gust = Math.max(0, g1) * gustiness;
    const speed = base * (0.8 + gust);
    const ang = this.windAngle + Math.sin(this.gustT * 0.37) * 0.12 * gustiness;
    env.wind.set(Math.cos(ang) * speed, 0, Math.sin(ang) * speed);
    env.windStrength = clamp(speed / 24, 0, 1);

    v.cirrusAngle = ang + 0.5;
    // Clouds drift with the wind aloft (a bit faster, veered).
    const aloft = 2.2;
    v.cloudOffset.x -= Math.cos(ang + 0.35) * base * aloft * dt;
    v.cloudOffset.y -= Math.sin(ang + 0.35) * base * aloft * dt;
    if (Math.abs(v.cloudOffset.x) > 5.2e5) v.cloudOffset.x %= 5200 * 20;
    if (Math.abs(v.cloudOffset.y) > 5.2e5) v.cloudOffset.y %= 5200 * 20;

    // ---- visibility & temperature -------------------------------------------------------------
    const haze = 2.6e-4 * v.hazeMul;
    env.visibility = clamp(3.9 / (haze + v.weatherFog + v.valleyFog * 0.3), 50, 8000);
    // Diurnal: ~-4 °C mid-afternoon, ~-14 °C before dawn; clouds flatten the swing.
    const diurnal = Math.cos(((h - 14.5) / 24) * Math.PI * 2);
    const amp = 5 * (1 - 0.5 * v.cloudCover);
    const mid = -9 + 1.5 * v.cloudCover;
    const drift = -Math.min(3, Math.max(0, clock.day - 3) * 0.25);
    const weatherT = lerp(a.temp, b.temp, tf);
    const targetTemp = mid + amp * diurnal + weatherT + drift;
    this.temp = hours > 0 || this.ctx.game.state === 'playing' ? damp(this.temp, targetTemp, 0.5, dt) : targetTemp;
    if (!Number.isFinite(this.temp)) this.temp = targetTemp;
    env.baseTemperature = this.temp;
  }

  lateUpdate(dt: number) {
    this.particles?.update(dt);
    this.spindrift?.update(dt);
  }

  serialize() {
    return {
      current: this.current,
      target: this.target,
      progress: this.progress,
      transitionHours: this.transitionHours,
      remaining: this.remaining,
      rng: this.rng.s,
      clearCover: this.clearCover,
      cirrus: this.cirrusTarget,
      windAngle: this.windAngle,
      temp: this.temp,
    };
  }

  deserialize(d: ReturnType<Weather['serialize']>) {
    if (!d || this.locked) return;
    const ok = (k: unknown): k is WeatherKind => typeof k === 'string' && k in PARAMS;
    if (ok(d.current)) this.current = d.current;
    if (ok(d.target)) this.target = d.target;
    this.progress = clamp(Number(d.progress) || 1, 0, 1);
    this.transitionHours = Number(d.transitionHours) || 0.4;
    this.remaining = Number(d.remaining) || 3;
    this.rng.s = (Number(d.rng) >>> 0) || 1;
    this.clearCover = Number(d.clearCover) || 0;
    this.cirrusTarget = Number(d.cirrus) || 0.3;
    this.windAngle = Number(d.windAngle) || 0;
    this.temp = Number.isFinite(d.temp) ? d.temp : -6;
    this.snapVisuals();
    this.announced = this.progress >= 0.35 ? this.target : this.current;
    this.ctx.env.weather = this.announced;
  }

  /** Wind vector (m/s) — convenience for other systems. */
  windAt(out = this._w) {
    return out.copy(this.ctx.env.wind);
  }
}
