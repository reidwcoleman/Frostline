// Type of the Electron preload bridge (electron/preload.cjs). Absent in the browser build.
export {};

declare global {
  interface FrostlineSteamInfo {
    available: boolean;
    appId: number;
    reason: string;
    user: string;
    steamDeck: boolean;
    overlay: boolean;
    language: string;
  }

  interface FrostlineSaveEntry {
    slot: string;
    size: number;
    /** ms since epoch */
    modified: number;
  }

  type FrostlineOverlayDialog = 'friends' | 'community' | 'players' | 'settings' | 'group' | 'stats' | 'achievements' | 'store';

  interface FrostlineNative {
    steam: {
      available(): boolean;
      info(): FrostlineSteamInfo;
      unlockAchievement(id: string): Promise<boolean>;
      isAchieved(id: string): Promise<boolean>;
      /** INT stats only (steamworks.js 0.4); values are rounded. */
      setStat(name: string, value: number): Promise<boolean>;
      getStat(name: string): Promise<number | null>;
      storeStats(): Promise<boolean>;
      activateOverlay(dialog?: FrostlineOverlayDialog): Promise<boolean>;
    };
    save: {
      /** Slot names: [a-z0-9_-]{1,32}. Resolves null when the slot doesn't exist. */
      read(slot: string): Promise<string | null>;
      readBackup(slot: string): Promise<string | null>;
      write(slot: string, data: string): Promise<boolean>;
      delete(slot: string): Promise<boolean>;
      list(): Promise<FrostlineSaveEntry[]>;
    };
    window: {
      setFullscreen(on: boolean): Promise<boolean>;
      isFullscreen(): Promise<boolean>;
      /** Returns an unsubscribe function. */
      onFullscreenChange(fn: (on: boolean) => void): () => void;
      quit(): Promise<boolean>;
    };
    app: {
      readonly version: string;
      readonly platform: string;
      readonly arch: string;
      readonly packaged: boolean;
      readonly dev: boolean;
      /** Running on Steam Deck hardware. */
      readonly steamDeck: boolean;
      /** Awaited (max ~3.5 s) before the window closes, so the last save can finish. */
      onBeforeQuit(fn: (() => Promise<void> | void) | null): void;
      openExternal(url: string): Promise<boolean>;
    };
  }

  interface Window {
    frostlineNative?: FrostlineNative;
  }
}
