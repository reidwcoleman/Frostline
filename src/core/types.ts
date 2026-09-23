// Shared types and cross-system contracts. Read docs/ARCHITECTURE.md first.
import type * as THREE from 'three';
import type { EventBus } from './Events';
import type { Input } from './Input';
import type { Settings } from './Settings';
import type { GameClock } from './Clock';
import type { Terrain } from './Terrain';
import type { World } from './World';
import type { Physics } from './Physics';
import type { PlayerState } from './PlayerState';
import type { Inventory, ItemId } from './Items';
import type { Interactions } from './Interact';
import type { SnowMarks } from './SnowMarks';
import type { EnvState } from './Env';
import type { Game } from './Game';

export type GameState = 'boot' | 'menu' | 'playing' | 'paused' | 'dead';
export type DamageCause = 'cold' | 'hunger' | 'fall' | 'crash' | 'wolf' | 'fire' | 'unknown';
export type Species = 'rabbit' | 'deer' | 'wolf' | 'bird';
export type WeatherKind = 'clear' | 'overcast' | 'snow' | 'blizzard';

export type AchievementId =
  | 'FIRST_NIGHT' // survive until day 2
  | 'SURVIVE_3' // reach day 3
  | 'SURVIVE_7' // reach day 7
  | 'SURVIVE_30'
  | 'FIRST_FIRE' // light a campfire
  | 'TIMBER' // fell a tree
  | 'LUMBERJACK' // fell 50 trees
  | 'HOMESTEAD' // build a fully enclosed shelter (walls + roof)
  | 'HUNTER' // kill a deer
  | 'WOLF_SLAYER' // kill a wolf
  | 'PACK_BREAKER' // kill 10 wolves
  | 'SPEED_DEMON' // reach 100 km/h on skis
  | 'BIG_AIR' // 3 seconds airtime
  | 'SUMMIT' // reach the highest point on the map (within 30m)
  | 'COLD_SNAP' // survive a blizzard outdoors
  | 'CHEF'; // cook meat

/** Every sound id any system may play. The audio system synthesises each one. */
export type SoundId =
  // UI
  | 'ui_hover' | 'ui_click' | 'ui_back' | 'ui_open' | 'ui_close' | 'ui_error' | 'ui_craft' | 'ui_toast' | 'ui_daybreak'
  // Movement
  | 'footstep_snow' | 'footstep_ice' | 'footstep_wood' | 'footstep_rock'
  | 'ski_glide' /* loop */ | 'ski_carve' /* loop */ | 'ski_pole_plant' | 'ski_jump' | 'ski_land' | 'ski_land_hard'
  | 'ski_on' | 'ski_off' | 'ski_scrape' | 'body_fall' | 'crash'
  // Player
  | 'player_hurt' | 'player_breath_cold' | 'player_death' | 'player_eat' | 'player_heal' | 'heartbeat' /* loop */
  // Tools & weapons
  | 'axe_swing' | 'axe_hit_wood' | 'axe_hit_stone' | 'axe_hit_flesh' | 'axe_hit_snow'
  | 'spear_swing' | 'spear_throw' | 'spear_hit'
  | 'bow_draw' | 'bow_release' | 'arrow_hit_wood' | 'arrow_hit_flesh' | 'arrow_hit_snow' | 'arrow_whoosh'
  | 'equip' | 'torch_swing'
  // World
  | 'tree_crack' | 'tree_fall' | 'tree_impact' | 'branch_snap' | 'snow_thump'
  | 'pickup' | 'build_place' | 'build_invalid' | 'build_remove' | 'door_open' | 'door_close'
  | 'fire_crackle' /* loop */ | 'fire_ignite' | 'fire_out' | 'torch_loop' /* loop */ | 'cook_sizzle'
  // Wildlife
  | 'wolf_howl' | 'wolf_growl' | 'wolf_bark' | 'wolf_attack' | 'wolf_yelp' | 'wolf_die'
  | 'deer_alert' | 'deer_die' | 'rabbit_squeak' | 'bird_flap' | 'bird_call' | 'owl'
  // Ambience one-shots
  | 'wood_creak' | 'ice_crack';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface PlayOpts {
  position?: Vec3Like; // omit for 2D (non-spatial) sounds
  volume?: number; // default 1
  pitch?: number; // playback-rate multiplier, default 1
  pitchVar?: number; // random +/- pitch variation, default small
}

export interface LoopHandle {
  setVolume(v: number): void;
  setPitch(p: number): void;
  setPosition(p: Vec3Like): void;
  stop(fadeSeconds?: number): void;
}

export interface AudioAPI {
  play(id: SoundId, opts?: PlayOpts): void;
  loop(id: SoundId, opts?: PlayOpts): LoopHandle;
}

export type ScreenId = 'none' | 'inventory' | 'crafting' | 'build' | 'map' | 'pause' | 'settings';

export interface PromptInfo {
  action: string; // Input action name shown as a key cap, e.g. 'interact', 'attack'
  text: string; // "Chop", "Sleep until dawn", ...
  progress?: number; // 0..1 for hold interactions
  disabled?: boolean; // grey it out (e.g. "Need 4 logs")
}

export interface UIAPI {
  setPrompt(p: PromptInfo | null): void;
  toast(text: string, kind?: 'info' | 'good' | 'warn' | 'bad'): void;
  hitMarker(kill?: boolean): void;
  damageFlash(fromWorld?: Vec3Like): void;
  bigTitle(title: string, subtitle?: string): void;
  showScreen(screen: ScreenId): void;
  /** True while a screen (inventory, map, pause...) owns input. Gameplay should ignore look/move/attack. */
  readonly blocking: boolean;
  /** Current loading progress for boot (0..1). */
  setLoading(p: number, label: string): void;
}

export interface PlatformAPI {
  readonly isElectron: boolean;
  readonly steam: boolean;
  unlockAchievement(id: AchievementId): void;
  setStat(name: string, value: number): void;
  saveWrite(slot: string, data: string): Promise<void>;
  saveRead(slot: string): Promise<string | null>;
  saveDelete(slot: string): Promise<void>;
  setFullscreen(on: boolean): void;
  quit(): void;
}

/** Every gameplay module implements this. */
export interface System {
  readonly name: string;
  /** States in which update() runs. Default ['playing']. */
  readonly updateWhen?: GameState[];
  /** Called once after the world exists and every system is constructed. */
  init?(): void | Promise<void>;
  /** New game or before loading a save: return to a clean state. */
  reset?(): void;
  update?(dt: number): void;
  /** After every update(), before render. Same updateWhen gating. */
  lateUpdate?(dt: number): void;
  /** Window resized (CSS pixels). */
  resize?(width: number, height: number): void;
  /** Save-game support. Return JSON-serialisable data. */
  serialize?(): unknown;
  deserialize?(data: any): void;
}

/** Parsed URL parameters for development / automated screenshots. */
export interface DevParams {
  enabled: boolean; // ?dev=1 or running on the vite dev server
  skipMenu: boolean; // ?skipMenu=1 -> start a new game immediately
  pos?: [number, number]; // ?pos=x,z  teleport player
  yaw?: number; // ?yaw=deg
  pitch?: number; // ?pitch=deg
  time?: number; // ?time=17.5 hour of day
  freezeTime: boolean; // ?freeze=1
  weather?: WeatherKind; // ?weather=blizzard
  skis?: boolean; // ?skis=1
  seed?: number; // ?seed=123
  noCache: boolean; // ?nocache=1 regenerate terrain
  fly: boolean; // ?fly=1 noclip camera (player controller honours it)
  god: boolean; // ?god=1 no damage / no vitals drain
  params: URLSearchParams;
}

// Forward declarations of the concrete systems (implemented by the owning modules).
import type { TerrainRenderer } from '../render/TerrainRenderer';
import type { Vegetation } from '../render/Vegetation';
import type { SnowTrails } from '../render/SnowTrails';
import type { Sky } from '../atmosphere/Sky';
import type { Weather } from '../atmosphere/Weather';
import type { PostFX } from '../atmosphere/PostFX';
import type { PlayerController } from '../player/PlayerController';
import type { Weapons } from '../combat/Weapons';
import type { Wildlife } from '../wildlife/Wildlife';
import type { Survival } from '../survival/Survival';
import type { Crafting } from '../survival/Crafting';
import type { Building } from '../survival/Building';
import type { UI } from '../ui/UI';
import type { MenuCamera } from '../ui/MenuCamera';
import type { Audio } from '../audio/Audio';
import type { Platform } from '../platform/Platform';
import type { SaveSystem } from '../platform/SaveSystem';

export interface Systems {
  terrain: TerrainRenderer;
  vegetation: Vegetation;
  snowTrails: SnowTrails;
  sky: Sky;
  weather: Weather;
  post: PostFX;
  player: PlayerController;
  weapons: Weapons;
  wildlife: Wildlife;
  survival: Survival;
  crafting: Crafting;
  building: Building;
  ui: UI;
  menuCam: MenuCamera;
  audio: Audio;
  platform: Platform;
  save: SaveSystem;
}

export interface GameContext {
  game: Game;
  canvas: HTMLCanvasElement;
  uiRoot: HTMLElement;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  events: EventBus;
  input: Input;
  settings: Settings;
  clock: GameClock;
  env: EnvState;
  terrain: Terrain;
  world: World;
  physics: Physics;
  player: PlayerState;
  inventory: Inventory;
  interact: Interactions;
  snow: SnowMarks;
  audio: AudioAPI;
  ui: UIAPI;
  platform: PlatformAPI;
  sys: Systems;
  dev: DevParams;
  /** Seconds since boot (real time, unaffected by pause). */
  time: number;
  /** Frame counter. */
  frame: number;
}

export type { ItemId };
