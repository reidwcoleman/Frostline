// Steamworks integration (main process only). Fully guarded: if steamworks.js can't load, Steam isn't
// running, or the user doesn't own the app, every call becomes a no-op and the game runs normally.
//
// App ID resolution (first hit wins):
//   1. SteamAppId env var            – set by the Steam client when it launches the game
//   2. steam/steam_appid.txt         – development only (480 = Spacewar); never shipped
//   3. package.json frostline.steamAppId – the real App ID baked into release builds
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SPACEWAR = 480;
const STORE_INTERVAL_MS = 60_000;

/** @type {any} */
let client = null;
let storeTimer = null;
let statsDirty = false;

const state = {
  available: false,
  appId: 0,
  /** Why Steam is unavailable (for logs / the settings screen). */
  reason: 'not initialised',
  user: '',
  steamDeck: false,
  overlay: false,
  language: '',
};

function readAppIdFile(file) {
  try {
    const n = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function resolveAppId({ projectRoot, isPackaged, configuredAppId }) {
  const env = Number(process.env.SteamAppId || process.env.STEAM_APP_ID || 0);
  if (Number.isInteger(env) && env > 0) return env;
  if (!isPackaged) {
    const dev = readAppIdFile(path.join(projectRoot, 'steam', 'steam_appid.txt'));
    if (dev) return dev;
  }
  // A tester can drop steam_appid.txt next to the packaged executable to run it outside Steam.
  const local = readAppIdFile(path.join(path.dirname(process.execPath), 'steam_appid.txt'));
  if (local) return local;
  const n = Number(configuredAppId || 0);
  return Number.isInteger(n) && n > 0 ? n : SPACEWAR;
}

/**
 * Initialise Steam. Must run before app 'ready' so the overlay's Chromium switches take effect.
 * @returns {{ restarting: boolean }} restarting=true means Steam will relaunch us: quit immediately.
 */
function init(opts) {
  const log = opts.log || console.log;
  if (process.env.FROSTLINE_NO_STEAM === '1' || process.argv.includes('--no-steam')) {
    state.reason = 'disabled (--no-steam)';
    log('[steam] ' + state.reason);
    return { restarting: false };
  }
  const appId = resolveAppId(opts);
  state.appId = appId;

  let steamworks;
  try {
    steamworks = require('steamworks.js');
  } catch (err) {
    state.reason = 'steamworks.js failed to load: ' + (err && err.message);
    log('[steam] ' + state.reason);
    return { restarting: false };
  }

  // Release builds started outside Steam (double-clicking the exe) relaunch through the Steam client so
  // ownership, the overlay and cloud saves work. Skipped for Spacewar and when a local steam_appid.txt exists.
  const launchedBySteam = !!process.env.SteamAppId;
  const localAppIdFile = fs.existsSync(path.join(path.dirname(process.execPath), 'steam_appid.txt'));
  if (opts.isPackaged && appId !== SPACEWAR && !launchedBySteam && !localAppIdFile && process.env.FROSTLINE_NO_STEAM_RESTART !== '1') {
    try {
      if (steamworks.restartAppIfNecessary(appId)) {
        log('[steam] relaunching through the Steam client');
        return { restarting: true };
      }
    } catch (err) {
      log('[steam] restartAppIfNecessary failed: ' + (err && err.message));
    }
  }

  try {
    client = steamworks.init(appId);
  } catch (err) {
    client = null;
    state.reason = 'Steam not available (' + ((err && err.message) || 'init failed') + ')';
    log('[steam] ' + state.reason + ' — continuing without Steam');
    return { restarting: false };
  }

  state.available = true;
  state.reason = '';
  try {
    state.user = client.localplayer.getName();
  } catch {
    /* optional */
  }
  try {
    state.steamDeck = client.utils.isSteamRunningOnSteamDeck();
  } catch {
    /* optional */
  }
  try {
    state.language = client.apps.currentGameLanguage();
  } catch {
    /* optional */
  }

  // Overlay (Shift+Tab). It needs in-process GPU + frame invalidation; reliable on Windows and Linux.
  // macOS Electron overlay support is poor, so it is opt-in there (FROSTLINE_STEAM_OVERLAY=1).
  const wantOverlay = process.platform !== 'darwin' || process.env.FROSTLINE_STEAM_OVERLAY === '1';
  if (wantOverlay && process.env.FROSTLINE_STEAM_OVERLAY !== '0') {
    try {
      // The game renders every frame (menu included), so skip the per-window invalidation timer.
      steamworks.electronEnableSteamOverlay(true);
      state.overlay = true;
    } catch (err) {
      log('[steam] overlay unavailable: ' + (err && err.message));
    }
  }

  storeTimer = setInterval(() => flush(), STORE_INTERVAL_MS);
  if (storeTimer.unref) storeTimer.unref();
  log(`[steam] ready: app ${appId}, user "${state.user}", deck=${state.steamDeck}, overlay=${state.overlay}`);
  return { restarting: false };
}

function info() {
  return { ...state };
}

/** Unlock an achievement. Our AchievementId strings are the Steam API names 1:1. */
function unlockAchievement(id) {
  if (!client) return false;
  try {
    if (client.achievement.isActivated(id)) return true;
    const ok = client.achievement.activate(id);
    // StoreStats is what actually shows the toast and persists the unlock.
    client.stats.store();
    return ok;
  } catch (err) {
    console.warn('[steam] unlock failed', id, err && err.message);
    return false;
  }
}

function isAchieved(id) {
  if (!client) return false;
  try {
    return client.achievement.isActivated(id);
  } catch {
    return false;
  }
}

/** Steamworks.js 0.4 exposes INT stats only; values are rounded. */
function setStat(name, value) {
  if (!client) return false;
  try {
    const ok = client.stats.setInt(name, Math.max(0, Math.round(value)));
    statsDirty = statsDirty || ok;
    return ok;
  } catch (err) {
    console.warn('[steam] setStat failed', name, err && err.message);
    return false;
  }
}

function getStat(name) {
  if (!client) return null;
  try {
    return client.stats.getInt(name);
  } catch {
    return null;
  }
}

function flush() {
  if (!client || !statsDirty) return false;
  try {
    statsDirty = false;
    return client.stats.store();
  } catch {
    return false;
  }
}

const DIALOGS = { friends: 0, community: 1, players: 2, settings: 3, group: 4, stats: 5, achievements: 6 };

function activateOverlay(dialog) {
  if (!client) return false;
  try {
    const d = DIALOGS[dialog];
    if (d === undefined) return false;
    client.overlay.activateDialog(d);
    return true;
  } catch {
    return false;
  }
}

function activateOverlayStore() {
  if (!client) return false;
  try {
    client.overlay.activateToStore(state.appId, 0);
    return true;
  } catch {
    return false;
  }
}

function shutdown() {
  if (storeTimer) clearInterval(storeTimer);
  statsDirty = true;
  flush();
}

module.exports = { init, info, unlockAchievement, isAchieved, setStat, getStat, flush, activateOverlay, activateOverlayStore, shutdown, DIALOGS };
