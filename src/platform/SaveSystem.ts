// Save system: one run per slot, versioned + migrated, written through Platform (atomic files + .bak on
// desktop, localStorage on the web).
//
// When we save:  every 120 s of play · at dawn · after sleeping · when pausing / quitting to menu ·
//                on death (marked dead) · on respawn · right before the window closes (Electron handshake,
//                or beforeunload on the web).
// Death policy:  the save is kept but marked `dead`. "Continue" is only offered if the player can respawn
//                (a bedroll set their respawn point); otherwise the run is over and New Game starts fresh.
//                This stops "quit before dying" save-scumming while keeping bedrolls meaningful.
// Corruption:    an unreadable/invalid save falls back to the .bak copy (previous good save).
import type { DamageCause, GameContext, GameState, System } from '../core/types';
import { SAVE_VERSION, type SaveData } from '../core/Game';
import type { Platform } from './Platform';

export const SAVE_SLOT = 'slot1';
const AUTOSAVE_INTERVAL = 120; // seconds of play
const TOAST_COOLDOWN = 180; // seconds (real time) between "Saved" toasts

export interface SaveMeta {
  dead: boolean;
  /** A dead run can continue only when a respawn point (bedroll) exists. */
  canRespawn: boolean;
  deathCause?: DamageCause;
  day: number;
  /** Seconds of play in this run. */
  playTime: number;
  appVersion: string;
}

export interface StoredSave extends SaveData {
  meta: SaveMeta;
}

export interface SaveSummary {
  day: number;
  savedAt: number;
  playTime: number;
  dead: boolean;
  canRespawn: boolean;
  /** Offer "Continue" in the main menu. */
  canContinue: boolean;
  fromBackup: boolean;
}

type Json = Record<string, unknown>;
/** toast: true = autosave toast (rate-limited), 'always' = manual save. */
type WriteOpts = { toast?: boolean | 'always'; dead?: boolean; cause?: DamageCause };

/**
 * Save migrations, keyed by the version they upgrade FROM. When SAVE_VERSION (core/Game.ts) is bumped to N,
 * add `[N-1]: (d) => ({ ...d, version: N, ...newFields })`. Keep old entries forever.
 */
const MIGRATIONS: Record<number, (d: Json) => Json> = {
  // Pre-release saves had no version field.
  0: (d) => ({ ...d, version: 1 }),
};

export class SaveTooNewError extends Error {
  constructor(readonly version: number) {
    super(`save is from a newer version of Frostline (v${version} > v${SAVE_VERSION})`);
  }
}

/** Parse-validated + migrated save, or throws. */
export function migrate(raw: unknown): StoredSave {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('save is not an object');
  let d = raw as Json;
  let v = typeof d.version === 'number' ? d.version : 0;
  if (v > SAVE_VERSION) throw new SaveTooNewError(v);
  while (v < SAVE_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) throw new Error(`no save migration from v${v}`);
    d = step(d);
    const next = typeof d.version === 'number' ? d.version : v;
    if (next <= v) throw new Error(`save migration from v${v} did not advance the version`);
    v = next;
  }
  validate(d);
  const clock = d.clock as { day: number };
  const m = (d.meta ?? {}) as Partial<SaveMeta>;
  d.meta = {
    dead: m.dead === true,
    canRespawn: m.canRespawn === true,
    deathCause: m.deathCause,
    day: typeof m.day === 'number' ? m.day : clock.day,
    playTime: typeof m.playTime === 'number' ? m.playTime : 0,
    appVersion: typeof m.appVersion === 'string' ? m.appVersion : 'unknown',
  } satisfies SaveMeta;
  return d as unknown as StoredSave;
}

function validate(d: Json) {
  const isObj = (x: unknown): x is Json => !!x && typeof x === 'object' && !Array.isArray(x);
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
  if (!num(d.seed)) throw new Error('save: bad seed');
  if (!isObj(d.clock) || !num(d.clock.time) || !num(d.clock.day)) throw new Error('save: bad clock');
  if (!isObj(d.player) || !Array.isArray(d.player.pos) || d.player.pos.length !== 3 || !d.player.pos.every(num)) throw new Error('save: bad player');
  if (!isObj(d.inventory)) throw new Error('save: bad inventory');
  if (!isObj(d.world)) throw new Error('save: bad world');
  if (d.systems !== undefined && !isObj(d.systems)) throw new Error('save: bad systems');
  if (d.systems === undefined) d.systems = {};
}

export class SaveSystem implements System {
  readonly name = 'save';
  readonly updateWhen: GameState[] = ['playing'];

  /** A run is in progress this session (new game started or save loaded). */
  private active = false;
  private playTime = 0;
  private sinceSave = 0;
  private lastSavedPlayTime = -1;
  private lastToast = -Infinity;
  private chain: Promise<unknown> = Promise.resolve();
  private flushedForQuit = false;
  private deadMarked = false;
  /** Last error, for the UI (null = fine). */
  lastError: string | null = null;
  /** ms timestamp of the last successful write. */
  lastSavedAt = 0;

  constructor(private ctx: GameContext) {
    const ev = ctx.events;
    ev.on('newGame', () => this.beginRun(0)); // (load() calls beginRun itself with the stored play time)
    ev.on('state', ({ from, to }) => {
      if (!this.active || this.deadMarked) return;
      if (from === 'playing' && (to === 'paused' || to === 'menu')) void this.autosave(false);
      else if (from === 'paused' && to === 'menu') void this.autosave(false);
    });
    ev.on('sleep:end', () => void this.autosave(true));
    ev.on('day:start', () => void this.autosave(true));
    ev.on('player:died', ({ cause }) => {
      if (!this.active) return;
      this.deadMarked = true;
      void this.enqueue({ dead: true, cause });
    });
    ev.on('player:respawned', () => {
      this.deadMarked = false;
      void this.autosave(false, true);
    });

    const native = typeof window !== 'undefined' ? window.frostlineNative : undefined;
    if (native) native.app.onBeforeQuit(() => this.flushForQuit());
    window.addEventListener('beforeunload', () => this.saveOnUnload());
  }

  private get platform(): Platform {
    return this.ctx.sys.platform;
  }

  private beginRun(playTime: number) {
    this.active = true;
    this.playTime = playTime;
    this.sinceSave = 0;
    this.lastSavedPlayTime = -1;
    this.deadMarked = false;
    this.flushedForQuit = false;
  }

  update(dt: number) {
    if (!this.active) return;
    this.playTime += dt;
    this.sinceSave += dt;
    if (this.sinceSave >= AUTOSAVE_INTERVAL) void this.autosave(true);
  }

  // ------------------------------------------------------------------ public API
  /** A run the player can continue (alive, or dead with a respawn point). */
  async hasSave(): Promise<boolean> {
    const s = await this.summary();
    return !!s?.canContinue;
  }

  /** Details for the main menu ("Continue — Day 4"). Null when there is no readable save. */
  async summary(): Promise<SaveSummary | null> {
    await this.chain.catch(() => {});
    const r = await this.readBest().catch(() => null);
    if (!r) return null;
    const { meta } = r.save;
    const seedOk = r.save.seed === this.ctx.game.seed;
    return {
      day: meta.day,
      savedAt: r.save.savedAt,
      playTime: meta.playTime,
      dead: meta.dead,
      canRespawn: meta.canRespawn,
      canContinue: seedOk && (!meta.dead || meta.canRespawn),
      fromBackup: r.fromBackup,
    };
  }

  /** Save now (manual save from the pause menu, or other systems). Always confirms with a toast. */
  async save(): Promise<void> {
    if (!this.active) return;
    await this.enqueue({ toast: 'always' });
  }

  /** Load the run. Returns false when there is nothing (continuable) to load. */
  async load(): Promise<boolean> {
    await this.chain.catch(() => {});
    let r: { save: StoredSave; fromBackup: boolean } | null;
    try {
      r = await this.readBest();
    } catch (err) {
      this.report('Could not read your save.', err);
      return false;
    }
    if (!r) return false;
    const d = r.save;
    if (d.seed !== this.ctx.game.seed) {
      console.warn(`[save] save is for world seed ${d.seed}, this world is ${this.ctx.game.seed}`);
      return false;
    }
    if (d.meta.dead && !d.meta.canRespawn) return false;
    this.ctx.game.applySave(d);
    this.beginRun(d.meta.playTime);
    this.lastSavedPlayTime = this.playTime;
    if (d.meta.dead) {
      // Died with a bedroll: wake up there.
      this.ctx.game.respawn();
    }
    if (r.fromBackup) this.ctx.ui.toast('Your last save was damaged — restored the one before it.', 'warn');
    return true;
  }

  /** Delete the run (e.g. "Abandon run" in the menu). */
  async deleteSave(): Promise<void> {
    await this.chain.catch(() => {});
    await this.platform.saveDelete(SAVE_SLOT);
    this.active = false;
  }

  // ------------------------------------------------------------------ internals
  private autosave(showToast: boolean, force = false): Promise<void> {
    if (!this.active || this.deadMarked) return Promise.resolve();
    // Nothing happened since the last save (e.g. pause -> quit to menu).
    if (!force && this.lastSavedPlayTime >= 0 && this.playTime - this.lastSavedPlayTime < 0.5) return Promise.resolve();
    this.sinceSave = 0;
    return this.enqueue({ toast: showToast });
  }

  private enqueue(opts: WriteOpts): Promise<void> {
    const job = this.chain.catch(() => {}).then(() => this.write(opts));
    this.chain = job;
    return job;
  }

  private build(opts: { dead?: boolean; cause?: DamageCause }): StoredSave {
    const base = this.ctx.game.collectSave();
    const dead = !!opts.dead || !this.ctx.player.alive;
    return {
      ...base,
      meta: {
        dead,
        canRespawn: dead && this.ctx.player.respawnPoint !== null,
        deathCause: dead ? (opts.cause ?? this.ctx.player.lastDamageCause) : undefined,
        day: base.clock.day,
        playTime: Math.round(this.playTime),
        appVersion: this.platform.appVersion,
      },
    };
  }

  private async write(opts: WriteOpts) {
    let json: string;
    try {
      json = JSON.stringify(this.build(opts));
    } catch (err) {
      this.report('Could not prepare the save.', err);
      return;
    }
    try {
      await this.platform.saveWrite(SAVE_SLOT, json);
      this.lastSavedPlayTime = this.playTime;
      this.lastSavedAt = Date.now();
      this.lastError = null;
      if (!opts.dead && (opts.toast === 'always' || (opts.toast && this.ctx.time - this.lastToast > TOAST_COOLDOWN))) {
        this.lastToast = this.ctx.time;
        this.ctx.ui.toast('Saved', 'info');
      }
    } catch (err) {
      this.report('Saving failed — check disk space.', err);
    }
    void this.platform.saveProfileNow();
  }

  /** Newest valid save: primary, else the .bak copy. Null if neither exists/parses. */
  private async readBest(): Promise<{ save: StoredSave; fromBackup: boolean } | null> {
    const p = this.platform;
    const raw = await p.saveRead(SAVE_SLOT);
    if (raw) {
      try {
        return { save: migrate(JSON.parse(raw)), fromBackup: false };
      } catch (err) {
        if (err instanceof SaveTooNewError) {
          // Keep a copy so a New Game here can't destroy progress from a newer build.
          await p.saveWrite(`${SAVE_SLOT}-v${err.version}`, raw).catch(() => {});
          console.warn('[save]', err.message);
          return null;
        }
        console.warn('[save] primary save unreadable, trying backup:', err);
      }
    }
    const bak = await p.saveReadBackup(SAVE_SLOT);
    if (bak) {
      try {
        return { save: migrate(JSON.parse(bak)), fromBackup: true };
      } catch (err) {
        console.warn('[save] backup unreadable too:', err);
      }
    }
    return null;
  }

  /** Electron handshake: runs (awaited) right before the window closes. */
  private async flushForQuit() {
    const state = this.ctx.game.state;
    if (this.active && !this.deadMarked && (state === 'playing' || state === 'paused')) await this.autosave(false);
    else await this.chain.catch(() => {});
    await this.platform.saveProfileNow();
    this.flushedForQuit = true;
  }

  /** Web (and Electron reloads): synchronous best-effort save while the page unloads. */
  private saveOnUnload() {
    if (this.flushedForQuit || !this.active || this.deadMarked) return;
    const state = this.ctx.game.state;
    if (state !== 'playing' && state !== 'paused') return;
    if (this.lastSavedPlayTime >= 0 && this.playTime - this.lastSavedPlayTime < 0.5) return;
    try {
      // Platform.saveWrite does its localStorage work synchronously; on desktop the IPC message is dispatched
      // immediately and completes in the main process after the page is gone.
      void this.platform.saveWrite(SAVE_SLOT, JSON.stringify(this.build({}))).catch(() => {});
      void this.platform.saveProfileNow();
    } catch (err) {
      console.warn('[save] unload save failed', err);
    }
  }

  private report(msg: string, err: unknown) {
    console.error('[save]', msg, err);
    this.lastError = msg;
    this.ctx.ui.toast(msg, 'bad');
  }
}
