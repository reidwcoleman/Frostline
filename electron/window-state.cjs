// Persisted window preferences: userData/window.json
//   { fullscreen, width, height, x?, y?, maximized }
// Fullscreen is the default for a first launch. The windowed size/position is remembered separately so
// leaving fullscreen restores the last windowed layout.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = { fullscreen: true, width: 1600, height: 900, x: undefined, y: undefined, maximized: false };

function create(userDataDir, screen) {
  const file = path.join(userDataDir, 'window.json');
  let prefs = { ...DEFAULTS };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof raw.fullscreen === 'boolean') prefs.fullscreen = raw.fullscreen;
    if (typeof raw.maximized === 'boolean') prefs.maximized = raw.maximized;
    if (Number.isFinite(raw.width) && Number.isFinite(raw.height)) {
      prefs.width = Math.max(960, Math.round(raw.width));
      prefs.height = Math.max(540, Math.round(raw.height));
    }
    if (Number.isFinite(raw.x) && Number.isFinite(raw.y)) {
      prefs.x = Math.round(raw.x);
      prefs.y = Math.round(raw.y);
    }
  } catch {
    /* first launch or corrupt file: defaults */
  }

  // Drop a saved position that is no longer on any display (monitor unplugged etc.).
  if (prefs.x !== undefined && screen) {
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return prefs.x + 64 < a.x + a.width && prefs.x + prefs.width - 64 > a.x && prefs.y >= a.y - 8 && prefs.y + 64 < a.y + a.height;
    });
    if (!visible) prefs.x = prefs.y = undefined;
  }
  // Clamp the windowed size to the primary work area.
  if (screen) {
    const wa = screen.getPrimaryDisplay().workAreaSize;
    prefs.width = Math.min(prefs.width, wa.width);
    prefs.height = Math.min(prefs.height, wa.height);
  }

  let timer = null;
  function writeNow() {
    try {
      fs.mkdirSync(userDataDir, { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(prefs, null, 2));
      fs.renameSync(tmp, file);
    } catch (err) {
      console.warn('[window] could not save window.json', err && err.message);
    }
  }
  function save() {
    clearTimeout(timer);
    timer = setTimeout(writeNow, 400);
  }

  /** Track a BrowserWindow: remember windowed bounds, maximised and fullscreen state. */
  function track(win) {
    const captureBounds = () => {
      if (win.isDestroyed() || win.isFullScreen() || win.isMaximized() || win.isMinimized()) return;
      const b = win.getBounds();
      Object.assign(prefs, { width: b.width, height: b.height, x: b.x, y: b.y });
      save();
    };
    win.on('resize', captureBounds);
    win.on('move', captureBounds);
    win.on('maximize', () => {
      prefs.maximized = true;
      save();
    });
    win.on('unmaximize', () => {
      prefs.maximized = false;
      save();
    });
    win.on('enter-full-screen', () => {
      prefs.fullscreen = true;
      save();
    });
    win.on('leave-full-screen', () => {
      prefs.fullscreen = false;
      save();
    });
    win.on('close', () => {
      clearTimeout(timer);
      writeNow();
    });
  }

  return { prefs, track, save, writeNow, file };
}

module.exports = { create, DEFAULTS };
