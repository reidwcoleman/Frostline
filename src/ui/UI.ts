// Frostline UI: loading screen, HUD, menus and the journal. Implements UIAPI (ctx.ui).
// Layers, bottom to top: HUD -> menu dip -> base screen (main menu / death) -> overlay
// stack (journal, pause, settings) -> sleep fade -> loading.
import './ui.css';
import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import '@fontsource/barlow-semi-condensed/500.css';
import '@fontsource/barlow-semi-condensed/600.css';

import type { GameContext, GameState, PromptInfo, ScreenId, SoundId, System, UIAPI, Vec3Like } from '../core/types';
import type { Action } from '../core/Input';
import { h, setText, fmtClock, fmtTemp } from './dom';
import { grainURL } from './contours';
import { Hud } from './Hud';
import { Nav } from './Nav';
import { Loading } from './Loading';
import { MainMenu } from './screens/MainMenu';
import { Journal, type JournalTabId } from './screens/Journal';
import { Pause } from './screens/Pause';
import { Settings } from './screens/Settings';
import { Death } from './screens/Death';
import type { Screen } from './screens/Screen';
import { renderPaperMap, type PaperMap } from './mapRender';

const TAB_OF: Partial<Record<Action, JournalTabId>> = { inventory: 'inventory', crafting: 'crafting', build: 'build', map: 'map' };
const SCREEN_ACTIONS: Action[] = ['inventory', 'crafting', 'build', 'map', 'pause'];

/** Friendlier words for the boot phases reported by Game ("Preparing <system>"). */
const LOADING_WORDS: Record<string, string> = {
  platform: 'Waking up',
  save: 'Finding your tracks',
  weather: 'Gathering clouds',
  sky: 'Lighting the sky',
  menuCam: 'Framing the view',
  player: 'Waxing the skis',
  weapons: 'Sharpening the hatchet',
  wildlife: 'Tracking wolves',
  survival: 'Stacking firewood',
  crafting: 'Sorting tools',
  building: 'Measuring logs',
  terrain: 'Shaping the mountains',
  vegetation: 'Growing forests',
  snowTrails: 'Settling fresh snow',
  post: 'Grading the light',
  audio: 'Tuning the wind',
  ui: 'Drawing the map',
};

interface AudioExtras {
  unlock?(): void;
  setMusicMood?(m: 'menu' | 'auto' | 'silent'): void;
}

export class UI implements System, UIAPI {
  readonly name = 'ui';
  readonly updateWhen: GameState[] = ['boot', 'menu', 'playing', 'paused', 'dead'];
  readonly root: HTMLDivElement;
  readonly hud: Hud;
  readonly nav = new Nav();
  private loading = new Loading();
  private dip = h('div.dip');
  private sleepEl = h('div.sleep');
  private sleepTime = h('span.time.num');
  private menu!: MainMenu;
  journal!: Journal;
  private pause!: Pause;
  private settingsScreen!: Settings;
  private death!: Death;
  private base: Screen | null = null;
  private stack: Screen[] = [];
  private shown: Screen | null = null;
  private handled = new Set<Action>();
  private paper: PaperMap | null = null;
  private deathTimer = -1;
  private sleeping = false;
  private pendingDawn = -1;
  private lastHover: Element | null = null;
  private lastHoverT = 0;
  private ready = false;

  constructor(readonly ctx: GameContext) {
    this.root = h('div.fl');
    document.documentElement.style.setProperty('--grain', `url(${grainURL()})`);
    this.hud = new Hud(ctx);
    this.sleepEl.append(h('div.t', null, 'Sleeping', this.sleepTime));
    this.root.append(this.hud.root, this.dip, this.sleepEl, this.loading.root);
    ctx.uiRoot.appendChild(this.root);
    // Kick font loading early so the loading screen draws in the right faces.
    for (const f of ['400 1em "Instrument Serif"', 'italic 400 1em "Instrument Serif"', '500 1em "Barlow Semi Condensed"', '600 1em "Barlow Semi Condensed"'])
      void document.fonts?.load(f).catch(() => {});

    this.menu = new MainMenu(this);
    this.journal = new Journal(this);
    this.pause = new Pause(this);
    this.settingsScreen = new Settings(this);
    this.death = new Death(this);
    for (const s of [this.menu, this.death, this.journal, this.pause, this.settingsScreen]) this.root.insertBefore(s.root, this.sleepEl);

    this.nav.onMove = () => this.sfx('ui_hover');
    window.addEventListener('keydown', this.onKey);
    ctx.canvas.addEventListener('click', () => {
      const g = ctx.game;
      if (g.state === 'playing' && !this.blocking && !ctx.input.pointerLocked) ctx.input.requestPointerLock();
    });
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement) this.hud.everLocked = true;
    });

    ctx.events.on('state', ({ from, to }) => this.onState(from, to));
    ctx.events.on('sleep:start', () => {
      this.sleeping = true;
      this.sleepEl.classList.add('on');
    });
    ctx.events.on('sleep:end', () => {
      this.sleeping = false;
      this.sleepEl.classList.remove('on');
      if (this.pendingDawn > 0) {
        const d = this.pendingDawn;
        this.pendingDawn = -1;
        window.setTimeout(() => this.dawn(d), 1300);
      }
    });
    ctx.events.on('day:start', ({ day }) => {
      if (ctx.game.state !== 'playing') return;
      if (this.sleeping) this.pendingDawn = day;
      else this.dawn(day);
    });
    ctx.events.on('newGame', () => {
      this.hud.wakeHotbar();
      window.setTimeout(() => {
        if (ctx.game.state === 'playing') {
          this.hud.bigTitle('Day 1', 'Find shelter before dark');
          this.sfx('ui_daybreak');
        }
      }, 1400);
      // Once the title has cleared, a single pill of the keys that matter on day one.
      window.setTimeout(() => {
        if (ctx.game.state === 'playing' && !this.stack.length)
          this.hud.showHints([
            ['toggleSkis', 'Skis'],
            ['interact', 'Pick up'],
            ['inventory', 'Inventory'],
            ['build', 'Build'],
            ['map', 'Map'],
          ]);
      }, 7600);
    });
    ctx.events.on('loadedGame', () => {
      window.setTimeout(() => {
        if (ctx.game.state === 'playing') this.hud.bigTitle(`Day ${ctx.clock.day}`, this.conditions(), 3200);
      }, 900);
    });
    ctx.events.on('player:respawned', () => {
      window.setTimeout(() => this.hud.bigTitle(`Day ${ctx.clock.day}`, 'You wake at your bedroll', 3000), 700);
    });
  }

  async init() {
    try {
      await document.fonts?.ready;
    } catch {
      /* fonts are a nicety */
    }
    // The paper map is expensive (~0.3 s): draw it while the loading screen is still up.
    try {
      this.paper = renderPaperMap(this.ctx);
    } catch (err) {
      console.error('[ui] map render failed', err);
    }
    this.hud.resize();
    this.ready = true;
  }

  // ------------------------------------------------------------------ UIAPI
  get blocking(): boolean {
    return this.stack.length > 0 || this.ctx.game?.state !== 'playing';
  }

  setLoading(p: number, label: string) {
    const m = /^Preparing (\w+)/.exec(label);
    this.loading.set(p, m ? (LOADING_WORDS[m[1]] ?? 'Almost there') : label === 'Ready' ? 'Ready' : label);
  }

  setPrompt(p: PromptInfo | null) {
    this.hud.setPrompt(p);
  }
  toast(text: string, kind?: 'info' | 'good' | 'warn' | 'bad') {
    this.hud.toast(text, kind);
    if (kind === 'warn' || kind === 'bad') this.sfx('ui_toast');
  }
  hitMarker(kill?: boolean) {
    this.hud.hitMarker(kill);
  }
  damageFlash(fromWorld?: Vec3Like) {
    this.hud.damageFlash(fromWorld);
  }
  bigTitle(title: string, subtitle?: string) {
    this.hud.bigTitle(title, subtitle);
  }

  showScreen(s: ScreenId) {
    const g = this.ctx.game;
    switch (s) {
      case 'none':
        if (this.stack.includes(this.journal)) this.closeJournal();
        if (this.stack.includes(this.settingsScreen)) this.popScreen();
        break;
      case 'pause':
        if (g.state === 'playing') {
          if (this.stack.includes(this.journal)) this.closeJournal();
          g.pause();
        }
        break;
      case 'settings':
        this.openSettings();
        break;
      default:
        this.openJournal(s);
    }
  }

  // ------------------------------------------------------------------ helpers for screens
  sfx(id: SoundId) {
    try {
      this.ctx.audio?.play(id);
    } catch {
      /* audio is optional */
    }
  }

  private audioExtras(): AudioExtras {
    return (this.ctx.sys?.audio ?? {}) as unknown as AudioExtras;
  }

  unlockAudio() {
    try {
      this.audioExtras().unlock?.();
    } catch {
      /* ignore */
    }
  }

  private mood(m: 'menu' | 'auto' | 'silent') {
    try {
      this.audioExtras().setMusicMood?.(m);
    } catch {
      /* ignore */
    }
  }

  /** Delegated hover ticks for every button inside a container. */
  hoverSounds(container: HTMLElement) {
    if (container.dataset.hoverSfx) return;
    container.dataset.hoverSfx = '1';
    container.addEventListener('pointerover', (e) => {
      const b = (e.target as HTMLElement).closest('button, input[type="range"]');
      if (!b || b === this.lastHover || (b as HTMLButtonElement).disabled) return;
      this.lastHover = b;
      const now = performance.now();
      if (now - this.lastHoverT < 45) return;
      this.lastHoverT = now;
      this.sfx('ui_hover');
    });
    container.addEventListener('pointerout', (e) => {
      if ((e.target as HTMLElement).closest('button') === this.lastHover) this.lastHover = null;
    });
  }

  paperMap(): PaperMap | null {
    if (!this.paper && this.ctx.terrain) this.paper = renderPaperMap(this.ctx);
    return this.paper;
  }

  journalInfo(text: string) {
    setText(this.journal.infoEl, text);
  }

  async continueGame() {
    try {
      const ok = await this.ctx.sys.save?.load?.();
      if (!ok) this.toast('No saved game found', 'bad');
    } catch (err) {
      console.error('[ui] load failed', err);
      this.toast('That save could not be loaded', 'bad');
    }
  }

  openSettings() {
    if (this.stack.includes(this.settingsScreen)) return;
    this.push(this.settingsScreen);
  }

  popScreen() {
    const top = this.stack.pop();
    if (top === this.journal && this.ctx.game.state === 'playing') this.ctx.game.setCursorFree(false);
    this.refresh();
  }

  openJournal(tab: JournalTabId) {
    const g = this.ctx.game;
    if (g.state !== 'playing' || !this.ctx.player.alive) return;
    if (this.stack.includes(this.journal)) {
      if (this.journal.current !== tab) this.journal.setTab(tab);
      return;
    }
    if (this.stack.length) return;
    // Opening the journal cancels a placement in progress.
    if (this.ctx.sys.building?.placing) this.ctx.sys.building.cancel();
    this.journal.open(tab);
    g.setCursorFree(true);
    this.sfx('ui_open');
    this.push(this.journal);
  }

  closeJournal() {
    const i = this.stack.indexOf(this.journal);
    if (i < 0) return;
    this.stack.splice(i, 1);
    this.sfx('ui_close');
    if (this.ctx.game.state === 'playing') this.ctx.game.setCursorFree(false);
    this.refresh();
  }

  private push(s: Screen) {
    this.stack.push(s);
    this.nav.primePad();
    this.refresh();
  }

  private top(): Screen | null {
    return this.stack[this.stack.length - 1] ?? this.base;
  }

  /** Show exactly the top layer; point gamepad navigation at it. */
  private refresh() {
    const top = this.top();
    if (top !== this.shown) {
      this.shown?.hide();
      this.shown = top;
      if (top) {
        top.show();
        this.nav.setScope(top.root, top, top.initialFocus());
        if (this.ctx.input.usingGamepad) this.nav.focus(top.initialFocus(), true);
      } else this.nav.setScope(null, null);
    }
  }

  private onState(from: GameState, to: GameState) {
    // Leaving play with the journal open (death, pause, quit): give the cursor back to the game.
    if (to !== 'playing' && this.stack.includes(this.journal)) this.ctx.game.setCursorFree(false);
    if (to === 'menu') {
      this.stack = [];
      this.base = this.menu;
      this.deathTimer = -1;
      this.sleeping = false;
      this.sleepEl.classList.remove('on');
      this.mood('menu');
    } else if (to === 'playing') {
      this.stack = this.stack.filter((s) => s === this.journal);
      this.base = null;
      this.deathTimer = -1;
      this.mood('auto');
      if (from === 'paused') this.sfx('ui_close');
    } else if (to === 'paused') {
      if (this.stack.includes(this.journal)) this.stack = [];
      if (!this.stack.includes(this.pause)) this.stack = [this.pause];
      this.sfx('ui_open');
    } else if (to === 'dead') {
      this.stack = [];
      this.base = null;
      this.deathTimer = 1.8;
      this.mood('silent');
      this.hud.setPrompt(null);
    }
    this.refresh();
  }

  private dawn(day: number) {
    this.hud.bigTitle(`Day ${day}`, day === 2 ? 'You made it through the night' : this.conditions());
    this.sfx('ui_daybreak');
  }

  private conditions(): string {
    const { env, player, settings } = this.ctx;
    const words: Record<string, string> = { clear: 'Clear', overcast: 'Overcast', snow: 'Snowing', blizzard: 'Blizzard' };
    const temp = fmtTemp(env.temperatureAt(player.position.y), settings.data.units);
    return `${words[env.weather] ?? 'Cold'}, ${temp}`;
  }

  // ------------------------------------------------------------------ input
  private actionOf(code: string): Action | null {
    const b = this.ctx.input.bindings;
    for (const a of SCREEN_ACTIONS) if (b[a]?.includes(code)) return a;
    return null;
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.repeat || !this.ready) return;
    const g = this.ctx.game;
    const top = this.top();
    const act = this.actionOf(e.code);
    if (act) this.handled.add(act);

    if (top === this.journal) {
      if (act && act !== 'pause') {
        const tab = TAB_OF[act]!;
        if (tab === this.journal.current) this.closeJournal();
        else {
          this.sfx('ui_click');
          this.journal.setTab(tab);
        }
        e.preventDefault();
        return;
      }
      if (this.journal.key(e)) return;
      if (this.nav.key(e)) e.preventDefault();
      return;
    }
    if (top) {
      if (act === 'pause' && top === this.pause && e.code !== 'Escape') {
        this.pause.back();
        return;
      }
      if (top.key?.(e)) return;
      if (this.nav.key(e)) e.preventDefault();
      return;
    }
    if (g.state === 'playing' && act) this.gameplayAction(act);
  };

  /** Screen hotkeys during play (keyboard via onKey, gamepad via update). */
  private gameplayAction(act: Action) {
    const g = this.ctx.game;
    if (act === 'pause') {
      const b = this.ctx.sys.building;
      if (b?.placing) b.cancel();
      else g.pause();
      return;
    }
    const tab = TAB_OF[act];
    if (tab) this.openJournal(tab);
  }

  // ------------------------------------------------------------------ frame
  update(dt: number) {
    const ctx = this.ctx;
    const g = ctx.game;
    const state = g.state;
    const top = this.top();

    if (this.deathTimer > 0) {
      this.deathTimer -= dt;
      if (this.deathTimer <= 0 && state === 'dead') {
        this.base = this.death;
        this.refresh();
      }
    }

    if (top) {
      this.nav.pollPad(dt);
      top.update?.(dt);
      // Gamepad View button toggles the journal closed again.
      if (top === this.journal && ctx.input.usingGamepad && ctx.input.pressed('inventory') && !this.handled.has('inventory')) this.closeJournal();
    } else if (state === 'playing') {
      if (ctx.input.usingGamepad)
        for (const a of SCREEN_ACTIONS) if (ctx.input.pressed(a) && !this.handled.has(a)) this.gameplayAction(a);
      this.hotbarInput();
    }
    this.handled.clear();

    if (this.sleeping) setText(this.sleepTime, fmtClock(ctx.clock.time));
    this.hud.update(dt, state === 'playing' && this.stack.length === 0);
  }

  private hotbarInput() {
    const { input, inventory, player, sys } = this.ctx;
    if (!player.alive || sys.building?.placing) return;
    for (let i = 0; i < 6; i++) {
      if (input.pressed(('slot' + (i + 1)) as Action)) {
        inventory.toggle(i);
        this.hud.wakeHotbar();
      }
    }
    if (input.pressed('nextSlot')) {
      inventory.cycle(1);
      this.hud.wakeHotbar();
    }
    if (input.pressed('prevSlot')) {
      inventory.cycle(-1);
      this.hud.wakeHotbar();
    }
    if (input.pressed('holster')) {
      inventory.select(-1);
      this.hud.wakeHotbar();
    }
  }

  resize() {
    this.hud.resize();
    this.menu.resize();
  }

  /** Dev/screenshot hook: show the loading screen frozen at a given progress. */
  debugLoading(p: number, label: string) {
    const l = new Loading();
    this.root.append(l.root);
    l.set(p, label);
    return 'ok';
  }
}
