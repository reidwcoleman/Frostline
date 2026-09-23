// Frostline game orchestrator: boot, state machine, main loop, save/load plumbing.
// Systems are constructed here (see buildSystems) and updated in a fixed order.
import * as THREE from 'three';
import { EventBus } from './Events';
import { Settings } from './Settings';
import { Input } from './Input';
import { GameClock } from './Clock';
import { EnvState } from './Env';
import { Terrain } from './Terrain';
import { World } from './World';
import { Physics } from './Physics';
import { PlayerState } from './PlayerState';
import { Inventory, STARTING_KIT, type ItemId, type InventorySnapshot } from './Items';
import { Interactions } from './Interact';
import { SnowMarks } from './SnowMarks';
import { loadTerrain } from '../world/loadTerrain';
import type { DevParams, GameContext, GameState, System, Systems, WeatherKind } from './types';

import { TerrainRenderer } from '../render/TerrainRenderer';
import { Vegetation } from '../render/Vegetation';
import { SnowTrails } from '../render/SnowTrails';
import { Sky } from '../atmosphere/Sky';
import { Weather } from '../atmosphere/Weather';
import { PostFX } from '../atmosphere/PostFX';
import { PlayerController } from '../player/PlayerController';
import { Weapons } from '../combat/Weapons';
import { Wildlife } from '../wildlife/Wildlife';
import { Survival } from '../survival/Survival';
import { Crafting } from '../survival/Crafting';
import { Building } from '../survival/Building';
import { UI } from '../ui/UI';
import { MenuCamera } from '../ui/MenuCamera';
import { Audio } from '../audio/Audio';
import { Platform } from '../platform/Platform';
import { SaveSystem } from '../platform/SaveSystem';

export const WORLD_SEED = 42;
export const SAVE_VERSION = 1;

export interface SaveData {
  version: number;
  savedAt: number;
  seed: number;
  clock: { time: number; day: number; totalHours: number };
  player: ReturnType<PlayerState['serialize']>;
  inventory: InventorySnapshot;
  world: ReturnType<World['serialize']>;
  systems: Record<string, unknown>;
}

declare global {
  interface Window {
    fl?: Game;
    __frostline?: { ready: boolean; frames: number; state: GameState; fps: number };
  }
}

export class Game {
  ctx!: GameContext;
  state: GameState = 'boot';
  seed = WORLD_SEED;
  /** Ordered update list. */
  private systems: System[] = [];
  private lastT = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;
  /** Set while the UI intentionally frees the cursor (inventory etc.) so we don't auto-pause. */
  private cursorFree = false;
  private wasLocked = false;

  constructor(private canvas: HTMLCanvasElement, private uiRoot: HTMLElement) {}

  // ------------------------------------------------------------------ boot
  async boot() {
    const dev = parseDev();
    const events = new EventBus();
    const settings = new Settings(events);
    const q = settings.quality;

    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      preserveDrawingBuffer: dev.params.has('shot'),
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatioCap) * settings.data.renderScale);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(settings.data.fov, window.innerWidth / window.innerHeight, 0.1, q.viewDistance);
    camera.rotation.order = 'YXZ';
    scene.add(camera); // so viewmodels parented to the camera render

    const input = new Input(this.canvas);
    const clock = new GameClock(events);
    const player = new PlayerState(events, dev);

    // Terrain/world/physics are filled in after generation; constructors must not touch them.
    this.ctx = {
      game: this,
      canvas: this.canvas,
      uiRoot: this.uiRoot,
      renderer,
      scene,
      camera,
      events,
      input,
      settings,
      clock,
      env: new EnvState(),
      terrain: null as unknown as Terrain,
      world: null as unknown as World,
      physics: null as unknown as Physics,
      player,
      inventory: new Inventory(events),
      interact: new Interactions(),
      snow: new SnowMarks(),
      audio: null as unknown as GameContext['audio'],
      ui: null as unknown as GameContext['ui'],
      platform: null as unknown as GameContext['platform'],
      sys: null as unknown as Systems,
      dev,
      time: 0,
      frame: 0,
    };
    if (dev.seed !== undefined) this.seed = dev.seed;
    window.fl = this;
    window.__frostline = { ready: false, frames: 0, state: 'boot', fps: 0 };

    this.buildSystems();

    const terrainData = await loadTerrain(this.seed, (p, label) => this.ctx.ui.setLoading(p * 0.8, label), { noCache: dev.noCache });
    this.ctx.terrain = new Terrain(terrainData);
    this.ctx.ui.setLoading(0.82, 'Growing forests');
    await nextFrame();
    this.ctx.world = new World(this.ctx.terrain, events);
    this.ctx.world.generate(this.seed);
    this.ctx.physics = new Physics(this.ctx.terrain, this.ctx.world);

    const n = this.systems.length;
    for (let i = 0; i < n; i++) {
      const s = this.systems[i];
      this.ctx.ui.setLoading(0.86 + 0.14 * (i / n), 'Preparing ' + s.name);
      await nextFrame();
      await s.init?.();
    }
    this.ctx.ui.setLoading(1, 'Ready');

    window.addEventListener('resize', () => this.onResize());
    events.on('settings', ({ key }) => {
      if (key === 'fov') {
        camera.fov = settings.data.fov;
        camera.updateProjectionMatrix();
      }
      if (key === 'quality' || key === 'renderScale') this.onResize();
    });
    events.on('player:died', () => {
      if (this.state === 'playing') this.setState('dead');
    });
    document.addEventListener('pointerlockchange', () => this.onPointerLockChange());

    if (dev.skipMenu) this.newGame();
    else this.setState('menu');

    this.lastT = performance.now();
    requestAnimationFrame(this.loop);
  }

  private buildSystems() {
    const ctx = this.ctx;
    // UI, audio and platform first: they back ctx.ui / ctx.audio / ctx.platform.
    const ui = new UI(ctx);
    ctx.ui = ui;
    const audio = new Audio(ctx);
    ctx.audio = audio;
    const platform = new Platform(ctx);
    ctx.platform = platform;

    const sys: Systems = {
      ui,
      audio,
      platform,
      save: new SaveSystem(ctx),
      weather: new Weather(ctx),
      sky: new Sky(ctx),
      menuCam: new MenuCamera(ctx),
      player: new PlayerController(ctx),
      weapons: new Weapons(ctx),
      wildlife: new Wildlife(ctx),
      survival: new Survival(ctx),
      crafting: new Crafting(ctx),
      building: new Building(ctx),
      terrain: new TerrainRenderer(ctx),
      vegetation: new Vegetation(ctx),
      snowTrails: new SnowTrails(ctx),
      post: new PostFX(ctx),
    };
    ctx.sys = sys;
    // Update order matters: environment -> camera/player -> gameplay -> world rendering -> audio/ui.
    this.systems = [
      sys.platform,
      sys.weather,
      sys.sky,
      sys.menuCam,
      sys.player,
      sys.weapons,
      sys.wildlife,
      sys.survival,
      sys.crafting,
      sys.building,
      sys.terrain,
      sys.vegetation,
      sys.snowTrails,
      sys.post,
      sys.audio,
      sys.ui,
      sys.save,
    ];
  }

  // ------------------------------------------------------------------ state
  setState(next: GameState) {
    const from = this.state;
    if (from === next) return;
    this.state = next;
    if (window.__frostline) window.__frostline.state = next;
    if (next === 'playing') {
      this.ctx.input.enabled = true;
      if (!this.cursorFree) this.ctx.input.requestPointerLock();
    } else {
      this.ctx.input.exitPointerLock();
    }
    this.ctx.events.emit('state', { from, to: next });
  }

  /** UI calls this when opening/closing screens that need the mouse cursor during play. */
  setCursorFree(free: boolean) {
    this.cursorFree = free;
    if (free) this.ctx.input.exitPointerLock();
    else if (this.state === 'playing') this.ctx.input.requestPointerLock();
  }

  private onPointerLockChange() {
    const locked = this.ctx.input.pointerLocked;
    // Browser Esc releases pointer lock without a keydown: treat that as pause.
    if (this.wasLocked && !locked && this.state === 'playing' && !this.cursorFree) this.pause();
    this.wasLocked = locked;
  }

  private resetWorldAndSystems() {
    const ctx = this.ctx;
    ctx.world.resetAlive();
    ctx.inventory.clear();
    ctx.interact.clear();
    ctx.player.reset();
    for (const s of this.systems) s.reset?.();
  }

  newGame() {
    const ctx = this.ctx;
    this.resetWorldAndSystems();
    ctx.clock.reset(8.5);
    for (const [id, n] of Object.entries(STARTING_KIT)) ctx.inventory.add(id as ItemId, n);
    ctx.inventory.select(-1);
    const [sx, sz] = ctx.terrain.data.spawn;
    ctx.player.teleport(sx, ctx.terrain.heightAt(sx, sz) + 0.05, sz);
    // Face the lake.
    const [lx, lz] = ctx.terrain.data.lakeCenter;
    ctx.player.yaw = Math.atan2(-(lx - sx), -(lz - sz));
    ctx.player.heading = ctx.player.yaw;
    this.applyDevOverrides();
    ctx.events.emit('newGame', { seed: this.seed });
    this.setState('playing');
  }

  private applyDevOverrides() {
    const { dev, player, terrain, clock } = this.ctx;
    if (dev.pos) player.teleport(dev.pos[0], terrain.heightAt(dev.pos[0], dev.pos[1]) + 0.05, dev.pos[1]);
    if (dev.yaw !== undefined) player.yaw = player.heading = dev.yaw * (Math.PI / 180);
    if (dev.pitch !== undefined) player.pitch = dev.pitch * (Math.PI / 180);
    if (dev.time !== undefined) clock.setTime(dev.time);
    clock.frozen = dev.freezeTime;
    if (dev.skis) {
      player.onSkis = true;
      player.mode = 'ski';
    }
  }

  pause() {
    if (this.state !== 'playing') return;
    this.setState('paused');
  }

  resume() {
    if (this.state !== 'paused') return;
    this.cursorFree = false;
    this.setState('playing');
  }

  quitToMenu() {
    this.cursorFree = false;
    this.setState('menu');
  }

  /** Respawn at the bedroll (or spawn) after death. */
  respawn() {
    const ctx = this.ctx;
    const p = ctx.player;
    const rp = p.respawnPoint ?? new THREE.Vector3(ctx.terrain.data.spawn[0], 0, ctx.terrain.data.spawn[1]);
    const keepStats = p.stats;
    const keepRespawn = p.respawnPoint;
    p.reset();
    p.stats = keepStats;
    p.respawnPoint = keepRespawn;
    p.health = 60;
    p.warmth = 60;
    p.satiety = 60;
    p.teleport(rp.x, ctx.physics.groundProbe(rp.x, rp.y + 2, rp.z).y + 0.05, rp.z);
    ctx.events.emit('player:respawned', {});
    this.setState('playing');
  }

  // ------------------------------------------------------------------ save
  collectSave(): SaveData {
    const ctx = this.ctx;
    const systems: Record<string, unknown> = {};
    for (const s of this.systems) if (s.serialize) systems[s.name] = s.serialize();
    return {
      version: SAVE_VERSION,
      savedAt: Date.now(),
      seed: this.seed,
      clock: { time: ctx.clock.time, day: ctx.clock.day, totalHours: ctx.clock.totalHours },
      player: ctx.player.serialize(),
      inventory: ctx.inventory.snapshot(),
      world: ctx.world.serialize(),
      systems,
    };
  }

  applySave(d: SaveData) {
    const ctx = this.ctx;
    this.resetWorldAndSystems();
    ctx.clock.reset(d.clock.time);
    ctx.clock.day = d.clock.day;
    ctx.clock.totalHours = d.clock.totalHours;
    ctx.player.deserialize(d.player);
    ctx.inventory.restore(d.inventory);
    ctx.world.deserialize(d.world);
    for (const s of this.systems) {
      if (s.deserialize && d.systems[s.name] !== undefined) {
        try {
          s.deserialize(d.systems[s.name]);
        } catch (err) {
          console.error(`[save] ${s.name} failed to load`, err);
        }
      }
    }
    ctx.events.emit('loadedGame', {});
    this.setState('playing');
  }

  // ------------------------------------------------------------------ loop
  private onResize() {
    const { renderer, camera, settings } = this.ctx;
    const w = window.innerWidth,
      h = window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, settings.quality.pixelRatioCap) * settings.data.renderScale);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.far = settings.quality.viewDistance;
    camera.updateProjectionMatrix();
    for (const s of this.systems) s.resize?.(w, h);
  }

  private runs(s: System) {
    return (s.updateWhen ?? ['playing']).includes(this.state);
  }

  private loop = (t: number) => {
    requestAnimationFrame(this.loop);
    const ctx = this.ctx;
    const rawDt = (t - this.lastT) / 1000;
    this.lastT = t;
    const dt = Math.min(Math.max(rawDt, 0), 0.1);
    ctx.time += dt;
    ctx.frame++;

    this.fpsAcc += rawDt;
    this.fpsFrames++;
    if (this.fpsAcc > 0.5) {
      window.__frostline!.fps = this.fpsFrames / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }

    ctx.input.update();
    if (this.state === 'playing') ctx.clock.update(dt);

    for (const s of this.systems) {
      if (!s.update || !this.runs(s)) continue;
      try {
        s.update(dt);
      } catch (err) {
        reportOnce(s.name + '.update', err);
      }
    }
    if (this.state === 'playing') ctx.interact.update(ctx, dt);
    for (const s of this.systems) {
      if (!s.lateUpdate || !this.runs(s)) continue;
      try {
        s.lateUpdate(dt);
      } catch (err) {
        reportOnce(s.name + '.lateUpdate', err);
      }
    }

    try {
      ctx.sys.post.render(dt);
    } catch (err) {
      reportOnce('render', err);
    }
    ctx.input.endFrame();

    const fr = window.__frostline!;
    fr.frames++;
    if (this.state !== 'boot') fr.ready = true;
  };
}

const reported = new Set<string>();
function reportOnce(key: string, err: unknown) {
  if (reported.has(key)) return;
  reported.add(key);
  console.error(`[frostline] ${key} threw:`, err);
}

function nextFrame() {
  return new Promise<void>((r) => requestAnimationFrame(() => r()));
}

function parseDev(): DevParams {
  const p = new URLSearchParams(location.search);
  const num = (k: string) => (p.has(k) && p.get(k) !== '' ? Number(p.get(k)) : undefined);
  const flag = (k: string) => p.has(k) && p.get(k) !== '0' && p.get(k) !== 'false';
  const pos = p.get('pos')?.split(',').map(Number);
  return {
    enabled: flag('dev') || import.meta.env.DEV,
    skipMenu: flag('skipMenu'),
    pos: pos && pos.length === 2 && pos.every(Number.isFinite) ? [pos[0], pos[1]] : undefined,
    yaw: num('yaw'),
    pitch: num('pitch'),
    time: num('time'),
    freezeTime: flag('freeze'),
    weather: (p.get('weather') as WeatherKind | null) ?? undefined,
    skis: flag('skis'),
    seed: num('seed'),
    noCache: flag('nocache'),
    fly: flag('fly'),
    god: flag('god'),
    params: p,
  };
}
