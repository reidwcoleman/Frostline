// The survival numbers, in one place, as pure functions (easy to tune and to simulate).
//
// Felt temperature (°C) = air at altitude + wind chill (blocked by shelter) + snow wetting
//   + fire + indoors + torch + hot food + bedroll.
// Warmth (0..100) moves toward a target set by the felt temperature: it drains at a rate that
// grows steeply with cold and recovers quickly near heat. At 0 warmth you take cold damage.
import { clamp } from '../core/math';

export const V = {
  // ---- felt temperature contributions (°C)
  windChill: 14, // at windStrength 1 (gale), fully exposed
  speedChill: 6, // skiing at 30 m/s (apparent wind)
  snowWet: 3, // heavy snowfall, no roof
  fireWarmth: 34, // standing right by a full fire
  fireShelterBoost: 0.5, // fire warmth × (1 + boost × shelter)
  indoorsBonus: 9, // enclosed cabin traps body heat
  shelterBonus: 3, // partial shelter (lean-to) × shelter
  forestWindBlock: 0.3, // dense forest blocks this much wind
  torch: 7,
  hotFood: 8, // decays over hotFoodSeconds
  hotFoodSeconds: 150,
  bedroll: 6,

  // ---- warmth dynamics (per real second)
  // Calibrated against Weather.ts (clear night at 400 m ≈ −16 °C air, light wind → felt ≈ −17.5):
  //   outdoors at night, no fire, from full: ~7.5 min to death; blizzard at 1200 m (felt ≈ −40): ~2.6 min;
  //   2 m from a full fire at night: felt ≈ +12 → warms ~1 pt/s, indefinitely safe.
  comfort: 5, // felt °C at which warmth target reaches 100
  targetSlope: 6, // warmth target drops this much per °C below comfort (−7 °C → 28, −12 °C → 0)
  drainBase: 0.03,
  drainScale: 0.24, // drain = base + scale × (cold/15)^exp, cold = max(0, -felt)  (−15 °C ≈ 0.27/s)
  drainExp: 1.57,
  gainBase: 0.2,
  gainPerDeg: 0.07,
  gainMax: 2.6,

  // ---- damage at empty meters (hp per real second)
  coldDps: 0.4,
  coldDpsPerDeg: 0.035, // extra per °C below -10
  hungerDps: 0.12,

  // ---- satiety (per in-game hour)
  satietyPerHour: 100 / 36, // 1.5 in-game days from full to empty
  sleepSatietyMul: 0.55,
  coldHungerMul: 0.8, // extra multiplier when freezing (warmth < 40)
  sprintHungerMul: 0.6,
  skiHungerMul: 0.25,

  // ---- health regen (per real second) & while sleeping (per in-game hour)
  regen: 0.05,
  regenWellFed: 0.04,
  sleepHealPerHour: 6,

  // ---- stamina (per real second)
  staminaRegen: 14,
  staminaRegenRest: 24,
  staminaDelay: 0.9,
};

export interface FeltInputs {
  air: number;
  windStrength: number;
  speed: number;
  snowfall: number;
  windBlock: number; // 0..1
  roof: number; // 0..1
  shelter: number; // 0..1
  indoors: boolean;
  fire: number; // 0..1.25 warmth field
  torch: boolean;
  hotFood: number; // 0..1
  sleeping: boolean;
}

export function feltTemperature(i: FeltInputs): number {
  const exposed = 1 - clamp(i.windBlock, 0, 1);
  const chill = -(V.windChill * i.windStrength + V.speedChill * Math.min(i.speed, 30) / 30) * exposed;
  const wet = -V.snowWet * i.snowfall * (1 - i.roof);
  const fire = V.fireWarmth * i.fire * (1 + V.fireShelterBoost * i.shelter);
  const room = i.indoors ? V.indoorsBonus : V.shelterBonus * i.shelter;
  const raw = i.air + chill + wet + fire + room + (i.torch ? V.torch : 0) + V.hotFood * i.hotFood + (i.sleeping ? V.bedroll : 0);
  // Soft cap: a fire in a snug cabin reads as "toasty" (~20–26 °C), not a sauna.
  return raw > 18 ? 18 + (raw - 18) * 0.3 : raw;
}

export function warmthTarget(felt: number): number {
  return clamp(100 - (V.comfort - felt) * V.targetSlope, 0, 100);
}

/** New warmth after dt seconds at a felt temperature. */
export function stepWarmth(warmth: number, felt: number, dt: number): number {
  const target = warmthTarget(felt);
  if (warmth > target) {
    const cold = Math.max(0, -felt);
    const drain = V.drainBase + V.drainScale * Math.pow(cold / 15, V.drainExp);
    return Math.max(target, warmth - drain * dt);
  }
  const gain = Math.min(V.gainMax, V.gainBase + V.gainPerDeg * Math.max(0, felt));
  return Math.min(target, warmth + gain * dt);
}

export function coldDamage(felt: number): number {
  return V.coldDps + V.coldDpsPerDeg * Math.max(0, -felt - 10);
}

/**
 * Seconds until death, standing still from full vitals at a constant felt temperature
 * (dev helper for tuning: `fl.ctx.sys.survival.simulate(-20)`).
 */
export function timeToDeath(felt: number, warmth0 = 100, health0 = 100): number {
  let w = warmth0,
    h = health0,
    t = 0;
  const dt = 0.25;
  while (t < 3600 * 3) {
    w = stepWarmth(w, felt, dt);
    if (w <= 0) h -= coldDamage(felt) * dt;
    if (h <= 0) return t;
    t += dt;
  }
  return Infinity;
}
