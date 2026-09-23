// Platform layer: Electron/Steam when the preload bridge exists (window.frostlineNative), otherwise a web
// fallback (localStorage). Owns achievements, lifetime stats (the "profile") and fullscreen plumbing.
import type { AchievementId, GameContext, GameState, PlatformAPI, System } from '../core/types';
import { Achievements, type AchievementSink } from './Achievements';
import { ACHIEVEMENTS, STAT_IDS, STATS, type StatId } from './achievementData';

/** Lifetime progress, stored in the 'profile' slot (saves/profile.json on desktop, Steam Cloud synced). */
interface Profile {
  v: 1;
  achievements: AchievementId[];
  stats: Partial<Record<StatId, number>>;
}

const PROFILE_SLOT = 'profile';
const WEB_PREFIX = 'frostline.save.';
const SLOT_RE = /^[a-z0-9_-]{1,32}$/;
/** Push dirty stats to Steam at most this often (s). Main also calls StoreStats every 60 s. */
const STAT_PUSH_INTERVAL = 20;

export class Platform implements System, PlatformAPI, AchievementSink {
  readonly name = 'platform';
  readonly updateWhen: GameState[] = ['playing'];
  readonly isElectron: boolean;
  readonly steam: boolean;
  /** Preload bridge, or null in the browser. */
  readonly native: FrostlineNative | null;
  readonly achievements: Achievements;
  readonly appVersion: string;

  private unlocked = new Set<AchievementId>();
  private stats: Partial<Record<StatId, number>> = {};
  private dirtyStats = new Set<StatId>();
  private statPushT = 0;
  private profileTimer: ReturnType<typeof setTimeout> | null = null;
  private profileLoaded: Promise<void>;
  /** Set while we mirror an external fullscreen change into settings (don't bounce it back). */
  private syncingFullscreen = false;

  constructor(private ctx: GameContext) {
    this.native = (typeof window !== 'undefined' && window.frostlineNative) || null;
    this.isElectron = !!this.native;
    this.steam = !!this.native?.steam.available();
    this.appVersion = this.native?.app.version ?? (import.meta.env.DEV ? 'dev' : 'web');
    this.achievements = new Achievements(ctx, this);
    this.profileLoaded = this.loadProfile();
    this.bindFullscreen();
    if (this.native) {
      const s = this.native.steam.info();
      console.info(`[platform] electron ${this.native.app.platform}-${this.native.app.arch} v${this.appVersion}; steam: ${s.available ? `app ${s.appId} (${s.user})` : s.reason}`);
    }
  }

  async init() {
    this.achievements.init();
    // Don't hold up boot for long on a slow disk; the profile merges in whenever it arrives.
    await Promise.race([this.profileLoaded, new Promise((r) => setTimeout(r, 1500))]);
  }

  update(dt: number) {
    this.achievements.update(dt);
    this.statPushT += dt;
    if (this.statPushT >= STAT_PUSH_INTERVAL) {
      this.statPushT = 0;
      this.pushStats();
    }
  }

  // ------------------------------------------------------------------ achievements
  unlockAchievement(id: AchievementId) {
    if (!(id in ACHIEVEMENTS) || this.unlocked.has(id)) return;
    this.unlocked.add(id);
    this.saveProfileSoon(250);
    if (this.steam && this.native) {
      this.pushStats(); // progress stats first, so Steam's popup shows the right numbers
      void this.native.steam.unlockAchievement(id).catch((err) => console.warn('[platform] steam unlock failed', id, err));
    }
    console.info('[platform] achievement unlocked:', id);
    this.ctx.events.emit('achievement', { id });
    // Steam shows its own popup; everywhere else we show a toast.
    if (!this.steam) this.ctx.ui.toast(`Achievement unlocked — ${ACHIEVEMENTS[id].name}`, 'good');
  }

  isUnlocked(id: AchievementId): boolean {
    return this.unlocked.has(id);
  }

  unlockedAchievements(): AchievementId[] {
    return [...this.unlocked];
  }

  /** Open the Steam overlay (achievements page by default). Returns false when unavailable. */
  async openSteamOverlay(dialog: FrostlineOverlayDialog = 'achievements'): Promise<boolean> {
    if (!this.steam || !this.native) return false;
    return this.native.steam.activateOverlay(dialog).catch(() => false);
  }

  // ------------------------------------------------------------------ stats
  /** PlatformAPI: set an absolute stat value. */
  setStat(name: string, value: number) {
    if (!Number.isFinite(value) || !/^[a-z0-9_]{1,64}$/.test(name)) return;
    const id = name as StatId;
    if (this.stats[id] === value) return;
    this.stats[id] = value;
    this.dirtyStats.add(id);
    this.saveProfileSoon();
  }

  getStat(id: StatId): number {
    return this.stats[id] ?? 0;
  }

  addStat(id: StatId, delta: number): number {
    const v = this.getStat(id) + delta;
    this.setStat(id, v);
    return v;
  }

  maxStat(id: StatId, value: number): number {
    const v = Math.max(this.getStat(id), value);
    this.setStat(id, v);
    return v;
  }

  /** Send dirty stats to Steam (main batches StoreStats). */
  pushStats() {
    if (!this.steam || !this.native || this.dirtyStats.size === 0) return;
    for (const id of this.dirtyStats) void this.native.steam.setStat(id, this.getStat(id)).catch(() => {});
    this.dirtyStats.clear();
    void this.native.steam.storeStats().catch(() => {});
  }

  // ------------------------------------------------------------------ profile persistence
  private async loadProfile() {
    try {
      const raw = await this.saveRead(PROFILE_SLOT);
      if (raw) this.mergeProfile(JSON.parse(raw) as Partial<Profile>);
    } catch (err) {
      console.warn('[platform] profile unreadable, trying backup', err);
      try {
        const bak = await this.saveReadBackup(PROFILE_SLOT);
        if (bak) this.mergeProfile(JSON.parse(bak) as Partial<Profile>);
      } catch {
        /* start fresh */
      }
    }
    if (this.steam && this.native) await this.syncWithSteam();
  }

  private mergeProfile(p: Partial<Profile>) {
    for (const id of p.achievements ?? []) if (id in ACHIEVEMENTS) this.unlocked.add(id);
    for (const id of STAT_IDS) {
      const v = p.stats?.[id];
      if (typeof v === 'number' && Number.isFinite(v) && v > (this.stats[id] ?? 0)) this.stats[id] = v;
    }
  }

  /** Steam is authoritative across machines: take the max of each stat, and push offline unlocks up. */
  private async syncWithSteam() {
    const n = this.native!;
    for (const id of STAT_IDS) {
      const remote = await n.steam.getStat(id).catch(() => null);
      const local = this.stats[id] ?? 0;
      if (remote !== null && remote > local) this.stats[id] = remote;
      else if (local > (remote ?? 0)) this.dirtyStats.add(id);
    }
    for (const id of Object.keys(ACHIEVEMENTS) as AchievementId[]) {
      const remote = await n.steam.isAchieved(id).catch(() => false);
      if (remote) this.unlocked.add(id);
      else if (this.unlocked.has(id)) void n.steam.unlockAchievement(id).catch(() => {});
    }
    this.pushStats();
  }

  private saveProfileSoon(delayMs = 5000) {
    if (this.profileTimer) clearTimeout(this.profileTimer);
    this.profileTimer = setTimeout(() => void this.saveProfileNow(), delayMs);
  }

  async saveProfileNow() {
    if (this.profileTimer) clearTimeout(this.profileTimer);
    this.profileTimer = null;
    const p: Profile = { v: 1, achievements: [...this.unlocked], stats: { ...this.stats } };
    try {
      await this.saveWrite(PROFILE_SLOT, JSON.stringify(p));
    } catch (err) {
      console.warn('[platform] could not save profile', err);
    }
    this.pushStats();
  }

  // ------------------------------------------------------------------ saves
  async saveWrite(slot: string, data: string) {
    assertSlot(slot);
    if (this.native) {
      await this.native.save.write(slot, data);
      return;
    }
    // Web: keep the previous valid save as .bak, like the desktop build. Runs synchronously (beforeunload-safe).
    const key = WEB_PREFIX + slot;
    const prev = localStorage.getItem(key);
    try {
      if (prev && isJson(prev)) localStorage.setItem(key + '.bak', prev);
    } catch {
      localStorage.removeItem(key + '.bak'); // quota: the backup is the first thing to go
    }
    try {
      localStorage.setItem(key, data);
    } catch (err) {
      // Quota: drop the backup and retry once (throws to the caller if it still doesn't fit).
      localStorage.removeItem(key + '.bak');
      localStorage.setItem(key, data);
      console.warn('[platform] localStorage quota pressure', err);
    }
  }

  async saveRead(slot: string): Promise<string | null> {
    assertSlot(slot);
    if (this.native) return this.native.save.read(slot);
    return localStorage.getItem(WEB_PREFIX + slot);
  }

  async saveReadBackup(slot: string): Promise<string | null> {
    assertSlot(slot);
    if (this.native) return this.native.save.readBackup(slot);
    return localStorage.getItem(WEB_PREFIX + slot + '.bak');
  }

  async saveDelete(slot: string) {
    assertSlot(slot);
    if (this.native) {
      await this.native.save.delete(slot);
      return;
    }
    localStorage.removeItem(WEB_PREFIX + slot);
    localStorage.removeItem(WEB_PREFIX + slot + '.bak');
  }

  async saveList(): Promise<FrostlineSaveEntry[]> {
    if (this.native) return this.native.save.list();
    const out: FrostlineSaveEntry[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(WEB_PREFIX) || k.endsWith('.bak')) continue;
      const v = localStorage.getItem(k) ?? '';
      out.push({ slot: k.slice(WEB_PREFIX.length), size: v.length, modified: 0 });
    }
    return out;
  }

  // ------------------------------------------------------------------ window
  setFullscreen(on: boolean) {
    if (this.native) {
      void this.native.window.setFullscreen(on).catch(() => {});
      return;
    }
    if (on && !document.fullscreenElement) void document.documentElement.requestFullscreen?.().catch(() => {});
    else if (!on && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  }

  /** Keep settings.fullscreen and the real window state in agreement, whichever side changes. */
  private bindFullscreen() {
    const { settings, events } = this.ctx;
    const mirror = (on: boolean) => {
      if (settings.data.fullscreen === on) return;
      this.syncingFullscreen = true;
      try {
        settings.set('fullscreen', on);
      } finally {
        this.syncingFullscreen = false;
      }
    };
    events.on('settings', ({ key }) => {
      if (key === 'fullscreen' && !this.syncingFullscreen) this.setFullscreen(settings.data.fullscreen);
    });
    if (this.native) {
      // F11 / Alt+Enter / the macOS green button / Steam Deck all go through the main process.
      this.native.window.onFullscreenChange(mirror);
      // The window was created from window.json; make the setting agree without toggling the window.
      // macOS animates into fullscreen, so a "false" right at boot may just be mid-transition: re-check later.
      const check = (final: boolean) =>
        void this.native!.window.isFullscreen().then((on) => {
          if (on || final) mirror(on);
          else setTimeout(() => check(true), 2000);
        });
      check(false);
    } else {
      document.addEventListener('fullscreenchange', () => mirror(!!document.fullscreenElement));
    }
  }

  quit() {
    if (this.native) {
      // Main runs the before-quit handshake, so SaveSystem gets to write the last save.
      void this.native.window.quit();
      return;
    }
    window.close();
  }
}

function assertSlot(slot: string) {
  if (!SLOT_RE.test(slot)) throw new Error('invalid save slot: ' + slot);
}

function isJson(s: string) {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

export { ACHIEVEMENTS, STATS };
