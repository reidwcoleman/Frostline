// Preload bridge (sandboxed, context-isolated). Exposes a small, typed, validated surface as
// window.frostlineNative — see src/platform/frostline-native.d.ts for the TypeScript view.
// Sandboxed preloads can only require 'electron' (and a few core shims), so this file is self-contained.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function readInfo() {
  const prefix = '--frostline-info=';
  const arg = process.argv.find((a) => a.startsWith(prefix));
  try {
    return arg ? JSON.parse(decodeURIComponent(arg.slice(prefix.length))) : {};
  } catch {
    return {};
  }
}
const info = readInfo();
const steamInfo = info.steam || { available: false, reason: 'unknown' };

// First launch on Steam Deck: start from the 'medium' preset (60 fps target at 1280×800). Only seeds settings
// when none exist yet, so the player's own choices always win. Key/shape = src/core/Settings.ts.
try {
  const SETTINGS_KEY = 'frostline.settings.v1';
  if (info.steamDeck && !window.localStorage.getItem(SETTINGS_KEY)) {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ quality: 'medium', fullscreen: true }));
  }
} catch {
  /* storage unavailable: defaults apply */
}

const SLOT_RE = /^[a-z0-9_-]{1,32}$/;
const slotOk = (slot) => {
  if (typeof slot !== 'string' || !SLOT_RE.test(slot)) throw new Error('invalid save slot: ' + slot);
  return slot;
};

// ---- before-quit handshake: main asks, the game saves, we answer.
let beforeQuit = null;
ipcRenderer.on('app:before-quit', async (_event, token) => {
  try {
    if (beforeQuit) {
      await Promise.race([Promise.resolve().then(() => beforeQuit()), new Promise((r) => setTimeout(r, 3500))]);
    }
  } catch (err) {
    console.error('[frostline] before-quit handler failed', err);
  }
  ipcRenderer.send('app:quit-ready', token);
});

// ---- fullscreen change notifications (F11, Alt+Enter, macOS green button, Steam Deck, ...)
const fsListeners = new Set();
ipcRenderer.on('window:fullscreen-changed', (_event, on) => {
  for (const fn of fsListeners) {
    try {
      fn(!!on);
    } catch (err) {
      console.error(err);
    }
  }
});

contextBridge.exposeInMainWorld('frostlineNative', {
  steam: {
    available: () => !!steamInfo.available,
    info: () => ({ ...steamInfo }),
    unlockAchievement: (id) => ipcRenderer.invoke('steam:unlock', String(id)),
    isAchieved: (id) => ipcRenderer.invoke('steam:is-achieved', String(id)),
    setStat: (name, value) => ipcRenderer.invoke('steam:set-stat', String(name), Number(value)),
    getStat: (name) => ipcRenderer.invoke('steam:get-stat', String(name)),
    storeStats: () => ipcRenderer.invoke('steam:store'),
    activateOverlay: (dialog) => ipcRenderer.invoke('steam:overlay', String(dialog || 'achievements')),
  },
  save: {
    read: (slot) => ipcRenderer.invoke('save:read', slotOk(slot)),
    readBackup: (slot) => ipcRenderer.invoke('save:read-backup', slotOk(slot)),
    write: (slot, data) => {
      if (typeof data !== 'string') return Promise.reject(new Error('save data must be a string'));
      return ipcRenderer.invoke('save:write', slotOk(slot), data);
    },
    delete: (slot) => ipcRenderer.invoke('save:delete', slotOk(slot)),
    list: () => ipcRenderer.invoke('save:list'),
  },
  window: {
    setFullscreen: (on) => ipcRenderer.invoke('window:set-fullscreen', !!on),
    isFullscreen: () => ipcRenderer.invoke('window:is-fullscreen'),
    onFullscreenChange: (fn) => {
      if (typeof fn !== 'function') return () => {};
      fsListeners.add(fn);
      return () => fsListeners.delete(fn);
    },
    quit: () => ipcRenderer.invoke('app:quit'),
  },
  app: {
    version: String(info.version || '0.0.0'),
    platform: String(info.platform || 'unknown'),
    arch: String(info.arch || 'unknown'),
    packaged: !!info.packaged,
    dev: !!info.dev,
    steamDeck: !!info.steamDeck,
    /** Register the function that runs (and is awaited, max ~3.5 s) before the window closes. */
    onBeforeQuit: (fn) => {
      beforeQuit = typeof fn === 'function' ? fn : null;
    },
    openExternal: (url) => ipcRenderer.invoke('app:open-external', String(url)),
  },
});
