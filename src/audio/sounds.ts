// Every SoundId in the game and how to synthesise it. `Record<SoundId, SoundDef>` makes TypeScript fail the
// build if a new id is added to the union without a generator here.
//
// Levels: each rendered buffer is loudness-normalised per category (see jobs.ts) under a −3 dBFS peak ceiling,
// then multiplied by `gain` — so `gain` is pure mix intent (a footstep sits under an axe hit), not a fudge for
// how loud the synthesis happened to come out.
import type { SoundId } from '../core/types';
import type { Rendered, Rng } from './dsp';
import * as ui from './gen/ui';
import * as mv from './gen/movement';
import * as pl from './gen/player';
import * as tl from './gen/tools';
import * as wd from './gen/world';
import * as wl from './gen/wildlife';

export type Category = 'sfx' | 'ui' | 'ambience';

export interface SoundDef {
  /** Number of pre-rendered variations (picked randomly per play, never the same twice in a row). */
  variants: number;
  gen: (sr: number, rng: Rng, variant: number) => Rendered;
  /** Mix level after loudness normalisation (0..1). */
  gain: number;
  category: Category;
  /** Seamless loop (normalised on steady-state loudness, no end fades). */
  loop?: boolean;
  /** PannerNode reference distance (m): full level inside this radius. Default 2. */
  refDistance?: number;
  /** Beyond this, positional one-shots are culled and loops fade out. Default 120. */
  maxDistance?: number;
  /** Rolloff factor for the inverse distance model. Default 1. */
  rolloff?: number;
  /** Send level to the category's reverb (valley for sfx/ambience, hall for ui). */
  reverbSend?: number;
  /** Concurrent instances of this id before the oldest is stolen. Default 6. */
  maxInstances?: number;
  /** Random ± playback-rate variation per play. Default 0.04. */
  pitchVar?: number;
}

export const SOUNDS: Record<SoundId, SoundDef> = {
  // ---------------------------------------------------------------- UI
  ui_hover: { variants: 1, gen: ui.uiHover, gain: 0.3, category: 'ui', maxInstances: 2, pitchVar: 0.015 },
  ui_click: { variants: 1, gen: ui.uiClick, gain: 0.6, category: 'ui', maxInstances: 3, pitchVar: 0.02 },
  ui_back: { variants: 1, gen: ui.uiBack, gain: 0.5, category: 'ui', maxInstances: 3, pitchVar: 0.02 },
  ui_open: { variants: 1, gen: ui.uiOpen, gain: 0.55, category: 'ui', maxInstances: 2, pitchVar: 0 },
  ui_close: { variants: 1, gen: ui.uiClose, gain: 0.5, category: 'ui', maxInstances: 2, pitchVar: 0 },
  ui_error: { variants: 1, gen: ui.uiError, gain: 0.6, category: 'ui', maxInstances: 2, pitchVar: 0.01 },
  ui_craft: { variants: 1, gen: ui.uiCraft, gain: 0.65, category: 'ui', maxInstances: 2, pitchVar: 0 },
  ui_toast: { variants: 1, gen: ui.uiToast, gain: 0.5, category: 'ui', maxInstances: 2, pitchVar: 0 },
  ui_daybreak: { variants: 1, gen: ui.uiDaybreak, gain: 0.85, category: 'ui', maxInstances: 1, pitchVar: 0, reverbSend: 0.35 },

  // ---------------------------------------------------------------- movement
  footstep_snow: { variants: 8, gen: mv.footstepSnow, gain: 0.42, category: 'sfx', maxInstances: 3, pitchVar: 0.06, refDistance: 2, maxDistance: 60 },
  footstep_ice: { variants: 4, gen: mv.footstepIce, gain: 0.42, category: 'sfx', maxInstances: 3, pitchVar: 0.05, refDistance: 2, maxDistance: 60 },
  footstep_wood: { variants: 6, gen: mv.footstepWood, gain: 0.48, category: 'sfx', maxInstances: 3, pitchVar: 0.05, refDistance: 2, maxDistance: 60 },
  footstep_rock: { variants: 6, gen: mv.footstepRock, gain: 0.42, category: 'sfx', maxInstances: 3, pitchVar: 0.06, refDistance: 2, maxDistance: 60 },
  ski_glide: { variants: 1, gen: mv.skiGlide, gain: 0.5, category: 'sfx', loop: true, refDistance: 3, maxDistance: 90 },
  ski_carve: { variants: 1, gen: mv.skiCarve, gain: 0.55, category: 'sfx', loop: true, refDistance: 3, maxDistance: 90 },
  ski_pole_plant: { variants: 4, gen: mv.skiPolePlant, gain: 0.38, category: 'sfx', maxInstances: 2, pitchVar: 0.06 },
  ski_jump: { variants: 2, gen: mv.skiJump, gain: 0.55, category: 'sfx', maxInstances: 2 },
  ski_land: { variants: 3, gen: mv.skiLand, gain: 0.75, category: 'sfx', maxInstances: 2, reverbSend: 0.05 },
  ski_land_hard: { variants: 2, gen: mv.skiLandHard, gain: 0.9, category: 'sfx', maxInstances: 2, reverbSend: 0.08 },
  ski_on: { variants: 1, gen: mv.skiOn, gain: 0.55, category: 'sfx', maxInstances: 1, pitchVar: 0.02 },
  ski_off: { variants: 1, gen: mv.skiOff, gain: 0.55, category: 'sfx', maxInstances: 1, pitchVar: 0.02 },
  ski_scrape: { variants: 3, gen: mv.skiScrape, gain: 0.55, category: 'sfx', maxInstances: 2 },
  body_fall: { variants: 3, gen: mv.bodyFall, gain: 0.75, category: 'sfx', maxInstances: 2, reverbSend: 0.08, refDistance: 3, maxDistance: 120 },
  crash: { variants: 2, gen: mv.crash, gain: 0.95, category: 'sfx', maxInstances: 1, reverbSend: 0.12, pitchVar: 0.03 },

  // ---------------------------------------------------------------- player
  player_hurt: { variants: 3, gen: pl.playerHurt, gain: 0.8, category: 'sfx', maxInstances: 2, pitchVar: 0.05 },
  player_breath_cold: { variants: 4, gen: pl.playerBreathCold, gain: 0.26, category: 'sfx', maxInstances: 1, pitchVar: 0.05 },
  player_death: { variants: 1, gen: pl.playerDeath, gain: 0.95, category: 'sfx', maxInstances: 1, pitchVar: 0, reverbSend: 0.2 },
  player_eat: { variants: 2, gen: pl.playerEat, gain: 0.55, category: 'sfx', maxInstances: 1 },
  player_heal: { variants: 1, gen: pl.playerHeal, gain: 0.55, category: 'sfx', maxInstances: 1, pitchVar: 0 },
  heartbeat: { variants: 1, gen: pl.heartbeat, gain: 0.85, category: 'sfx', loop: true, maxInstances: 2, pitchVar: 0 },

  // ---------------------------------------------------------------- tools & weapons
  axe_swing: { variants: 3, gen: tl.axeSwing, gain: 0.45, category: 'sfx', maxInstances: 2, pitchVar: 0.05 },
  axe_hit_wood: { variants: 4, gen: tl.axeHitWood, gain: 0.9, category: 'sfx', maxInstances: 3, reverbSend: 0.14, refDistance: 3, maxDistance: 160 },
  axe_hit_stone: { variants: 4, gen: tl.axeHitStone, gain: 0.8, category: 'sfx', maxInstances: 3, reverbSend: 0.12, refDistance: 3, maxDistance: 160 },
  axe_hit_flesh: { variants: 4, gen: tl.axeHitFlesh, gain: 0.75, category: 'sfx', maxInstances: 3, refDistance: 3, maxDistance: 80 },
  axe_hit_snow: { variants: 3, gen: tl.axeHitSnow, gain: 0.55, category: 'sfx', maxInstances: 3, refDistance: 3, maxDistance: 60 },
  spear_swing: { variants: 2, gen: tl.spearSwing, gain: 0.45, category: 'sfx', maxInstances: 2 },
  spear_throw: { variants: 2, gen: tl.spearThrow, gain: 0.55, category: 'sfx', maxInstances: 2 },
  spear_hit: { variants: 3, gen: tl.spearHit, gain: 0.8, category: 'sfx', maxInstances: 3, reverbSend: 0.1, refDistance: 3, maxDistance: 140 },
  bow_draw: { variants: 2, gen: tl.bowDraw, gain: 0.45, category: 'sfx', maxInstances: 1, pitchVar: 0.03 },
  bow_release: { variants: 3, gen: tl.bowRelease, gain: 0.75, category: 'sfx', maxInstances: 2 },
  arrow_hit_wood: { variants: 3, gen: tl.arrowHitWood, gain: 0.75, category: 'sfx', maxInstances: 3, reverbSend: 0.1, refDistance: 3, maxDistance: 140 },
  arrow_hit_flesh: { variants: 3, gen: tl.arrowHitFlesh, gain: 0.7, category: 'sfx', maxInstances: 3, refDistance: 3, maxDistance: 80 },
  arrow_hit_snow: { variants: 3, gen: tl.arrowHitSnow, gain: 0.45, category: 'sfx', maxInstances: 3, refDistance: 3, maxDistance: 60 },
  arrow_whoosh: { variants: 2, gen: tl.arrowWhoosh, gain: 0.5, category: 'sfx', maxInstances: 3, refDistance: 2, maxDistance: 40 },
  equip: { variants: 3, gen: tl.equip, gain: 0.45, category: 'sfx', maxInstances: 1 },
  torch_swing: { variants: 2, gen: tl.torchSwing, gain: 0.5, category: 'sfx', maxInstances: 2 },

  // ---------------------------------------------------------------- world
  tree_crack: { variants: 2, gen: wd.treeCrack, gain: 0.95, category: 'sfx', maxInstances: 2, reverbSend: 0.25, refDistance: 6, maxDistance: 320, pitchVar: 0.05 },
  tree_fall: { variants: 2, gen: wd.treeFall, gain: 0.85, category: 'sfx', maxInstances: 2, reverbSend: 0.3, refDistance: 8, maxDistance: 320, pitchVar: 0.05 },
  tree_impact: { variants: 2, gen: wd.treeImpact, gain: 1, category: 'sfx', maxInstances: 2, reverbSend: 0.45, refDistance: 12, maxDistance: 600, pitchVar: 0.05 },
  branch_snap: { variants: 4, gen: wd.branchSnap, gain: 0.7, category: 'sfx', maxInstances: 3, reverbSend: 0.2, refDistance: 5, maxDistance: 200 },
  snow_thump: { variants: 4, gen: wd.snowThump, gain: 0.55, category: 'sfx', maxInstances: 3, reverbSend: 0.1, refDistance: 5, maxDistance: 120 },
  pickup: { variants: 3, gen: wd.pickup, gain: 0.45, category: 'sfx', maxInstances: 3, pitchVar: 0 },
  build_place: { variants: 3, gen: wd.buildPlace, gain: 0.8, category: 'sfx', maxInstances: 2, reverbSend: 0.1, refDistance: 3, maxDistance: 120 },
  build_invalid: { variants: 2, gen: wd.buildInvalid, gain: 0.5, category: 'sfx', maxInstances: 1, pitchVar: 0.01 },
  build_remove: { variants: 2, gen: wd.buildRemove, gain: 0.75, category: 'sfx', maxInstances: 2, reverbSend: 0.08, refDistance: 3, maxDistance: 120 },
  door_open: { variants: 2, gen: wd.doorOpen, gain: 0.65, category: 'sfx', maxInstances: 2, refDistance: 3, maxDistance: 60 },
  door_close: { variants: 2, gen: wd.doorClose, gain: 0.75, category: 'sfx', maxInstances: 2, refDistance: 3, maxDistance: 60 },
  fire_crackle: { variants: 1, gen: wd.fireCrackle, gain: 0.65, category: 'sfx', loop: true, refDistance: 2.5, maxDistance: 50, pitchVar: 0.05 },
  fire_ignite: { variants: 1, gen: wd.fireIgnite, gain: 0.8, category: 'sfx', maxInstances: 2, refDistance: 3, maxDistance: 60 },
  fire_out: { variants: 1, gen: wd.fireOut, gain: 0.65, category: 'sfx', maxInstances: 2, refDistance: 3, maxDistance: 60 },
  torch_loop: { variants: 1, gen: wd.torchLoop, gain: 0.45, category: 'sfx', loop: true, refDistance: 1.5, maxDistance: 30 },
  cook_sizzle: { variants: 1, gen: wd.cookSizzle, gain: 0.45, category: 'sfx', loop: true, refDistance: 1.5, maxDistance: 25 },

  // ---------------------------------------------------------------- wildlife
  wolf_howl: { variants: 4, gen: wl.wolfHowl, gain: 1, category: 'sfx', maxInstances: 4, reverbSend: 0.6, refDistance: 100, maxDistance: 2500, pitchVar: 0.05 },
  wolf_growl: { variants: 3, gen: wl.wolfGrowl, gain: 0.85, category: 'sfx', maxInstances: 3, reverbSend: 0.04, refDistance: 4, maxDistance: 80, pitchVar: 0.06 },
  wolf_bark: { variants: 3, gen: wl.wolfBark, gain: 0.9, category: 'sfx', maxInstances: 3, reverbSend: 0.25, refDistance: 8, maxDistance: 320, pitchVar: 0.06 },
  wolf_attack: { variants: 2, gen: wl.wolfAttack, gain: 1, category: 'sfx', maxInstances: 2, reverbSend: 0.08, refDistance: 4, maxDistance: 100 },
  wolf_yelp: { variants: 2, gen: wl.wolfYelp, gain: 0.8, category: 'sfx', maxInstances: 2, reverbSend: 0.15, refDistance: 6, maxDistance: 220 },
  wolf_die: { variants: 1, gen: wl.wolfDie, gain: 0.8, category: 'sfx', maxInstances: 2, reverbSend: 0.15, refDistance: 6, maxDistance: 220, pitchVar: 0.05 },
  deer_alert: { variants: 2, gen: wl.deerAlert, gain: 0.75, category: 'sfx', maxInstances: 2, reverbSend: 0.2, refDistance: 8, maxDistance: 260 },
  deer_die: { variants: 2, gen: wl.deerDie, gain: 0.75, category: 'sfx', maxInstances: 2, reverbSend: 0.15, refDistance: 6, maxDistance: 220 },
  rabbit_squeak: { variants: 3, gen: wl.rabbitSqueak, gain: 0.5, category: 'sfx', maxInstances: 2, refDistance: 3, maxDistance: 60, pitchVar: 0.06 },
  bird_flap: { variants: 3, gen: wl.birdFlap, gain: 0.55, category: 'sfx', maxInstances: 3, refDistance: 4, maxDistance: 80 },
  bird_call: { variants: 3, gen: wl.birdCall, gain: 0.45, category: 'sfx', maxInstances: 3, reverbSend: 0.15, refDistance: 10, maxDistance: 260, pitchVar: 0.03 },
  owl: { variants: 2, gen: wl.owl, gain: 0.55, category: 'sfx', maxInstances: 2, reverbSend: 0.35, refDistance: 25, maxDistance: 500, pitchVar: 0.03 },

  // ---------------------------------------------------------------- ambience one-shots
  wood_creak: { variants: 4, gen: wl.woodCreak, gain: 0.55, category: 'ambience', maxInstances: 3, reverbSend: 0.1, refDistance: 8, maxDistance: 160, pitchVar: 0.08 },
  ice_crack: { variants: 4, gen: wl.iceCrack, gain: 1, category: 'ambience', maxInstances: 3, reverbSend: 0.55, refDistance: 80, maxDistance: 3000, pitchVar: 0.08 },
};

export const SOUND_IDS = Object.keys(SOUNDS) as SoundId[];
