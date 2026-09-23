// Frostline — Electron main process.
//
//   dev:        npm run electron:dev        (loads the Vite dev server, FROSTLINE_DEV_URL)
//   production: packaged app / `electron .` (serves dist/ from the privileged app:// scheme)
//
// Why app:// instead of file://: a standard + secure custom scheme gives the page a real origin, so ES-module
// workers (terrain generation), IndexedDB (terrain cache), localStorage (settings) and fetch behave exactly
// like on the web, and we control the CSP + MIME types. See docs/STEAM.md for the full picture.
'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, screen, session, shell } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const steam = require('./steam.cjs');
const saves = require('./saves.cjs');
const windowState = require('./window-state.cjs');
const pkg = require('../package.json');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const APP_SCHEME = 'app';
const APP_HOST = 'frostline';
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const BG = '#0b1016';
const IS_MAC = process.platform === 'darwin';

const argValue = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

/** Dev server URL; only loopback http is accepted. */
const DEV_URL = (() => {
  const raw = process.env.FROSTLINE_DEV_URL || argValue('dev-url') || '';
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return u.origin + '/';
  } catch {
    /* fall through */
  }
  console.warn('[main] ignoring non-loopback dev url', raw);
  return '';
})();
const IS_DEV = !!DEV_URL;
/** Extra query string for the game (dev params, e.g. "skipMenu=1&time=17"). */
const EXTRA_QUERY = (process.env.FROSTLINE_QUERY || argValue('frostline-query') || '').replace(/^\?/, '');
const ALLOW_DEVTOOLS = IS_DEV || process.argv.includes('--devtools') || process.env.FROSTLINE_DEVTOOLS === '1';

// Keep dev data (saves, settings, terrain cache) apart from the shipping install. FROSTLINE_USER_DATA points
// a run at a throwaway profile (smoke tests, QA).
if (process.env.FROSTLINE_USER_DATA) app.setPath('userData', path.resolve(process.env.FROSTLINE_USER_DATA));
else if (IS_DEV) app.setPath('userData', app.getPath('userData') + ' Dev');

// ------------------------------------------------------------------ logging
// userData/logs/main.log (rotated at 2 MB). Renderer warnings/errors are mirrored here for bug reports.
let logStream = null;
const pending = [];
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`;
  console.log(line);
  if (logStream) logStream.write(line + '\n');
  else if (pending.length < 500) pending.push(line);
}
function openLog() {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'main.log');
    try {
      if (fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, file + '.old');
    } catch {
      /* no log yet */
    }
    logStream = fs.createWriteStream(file, { flags: 'a' });
    for (const l of pending.splice(0)) logStream.write(l + '\n');
  } catch (err) {
    console.warn('[main] logging disabled', err);
  }
}

// ------------------------------------------------------------------ single instance
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  main();
}

function main() {
  log(`Frostline ${pkg.version} (${process.platform}-${process.arch}, electron ${process.versions.electron}, ${app.isPackaged ? 'packaged' : IS_DEV ? 'dev' : 'unpackaged'})`);

  // ---------------------------------------------------------------- Chromium switches (before ready)
  // Games want the discrete GPU, GPU raster, and no background throttling.
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
  app.commandLine.appendSwitch('force_high_performance_gpu');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  // Menu music/ambience may start before the first click.
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  if (process.env.FROSTLINE_UNCAPPED === '1') {
    // Benchmarking only: render as fast as possible (tearing!).
    app.commandLine.appendSwitch('disable-frame-rate-limit');
    app.commandLine.appendSwitch('disable-gpu-vsync');
  }

  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
  ]);

  // ---------------------------------------------------------------- Steam (before ready: overlay switches)
  const steamResult = steam.init({
    projectRoot: ROOT,
    isPackaged: app.isPackaged,
    configuredAppId: pkg.frostline && pkg.frostline.steamAppId,
    log,
  });
  if (steamResult.restarting) {
    app.exit(0);
    return;
  }

  if (process.platform === 'win32') app.setAppUserModelId('com.reidcoleman.frostline');
  app.setAboutPanelOptions({ applicationName: 'Frostline', applicationVersion: pkg.version, copyright: '© Reid Coleman' });

  /** @type {BrowserWindow | null} */
  let win = null;
  let allowClose = false;
  let flushing = null;

  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(async () => {
    openLog();
    saves.configure(app.getPath('userData'));
    saves.cleanupTemp();
    log('[main] userData', app.getPath('userData'));
    registerProtocol();
    hardenSession(session.defaultSession);
    registerIpc();
    buildMenu();
    win = createWindow();
  });

  app.on('window-all-closed', () => {
    log('[main] all windows closed, quitting');
    app.quit();
  });
  app.on('will-quit', () => {
    log('[main] will-quit');
    steam.shutdown();
    if (logStream) logStream.end();
  });
  app.on('child-process-gone', (_e, d) => log('[main] child process gone', d.type, d.reason, d.exitCode));

  // ---------------------------------------------------------------- app:// protocol
  function registerProtocol() {
    protocol.handle(APP_SCHEME, async (request) => {
      const url = new URL(request.url);
      if (url.host !== APP_HOST) return new Response('Not found', { status: 404 });
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/' || rel === '') rel = '/index.html';
      const file = path.normalize(path.join(DIST, rel));
      if (file !== DIST && !file.startsWith(DIST + path.sep)) return new Response('Forbidden', { status: 403 });
      try {
        const body = await fsp.readFile(file);
        return new Response(body, { status: 200, headers: responseHeaders(file) });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    });
  }

  function responseHeaders(file) {
    return {
      'Content-Type': mimeType(file),
      'Content-Security-Policy': csp(),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    };
  }

  // ---------------------------------------------------------------- security
  function csp() {
    const devSrc = IS_DEV ? ` ${DEV_URL.replace(/\/$/, '')} ${DEV_URL.replace(/^http/, 'ws').replace(/\/$/, '')}` : '';
    return [
      "default-src 'self'",
      `script-src 'self'${devSrc}`,
      // Inline <style> in index.html and style attributes set by the UI.
      `style-src 'self' 'unsafe-inline'${devSrc}`,
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "media-src 'self' data: blob:",
      `connect-src 'self' data: blob:${devSrc}`,
      // Terrain generation runs in a module worker (same origin); libraries may spawn blob: workers.
      "worker-src 'self' blob:",
      "child-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; ');
  }

  function isTrustedUrl(url) {
    if (!url) return false;
    if (url.startsWith(APP_ORIGIN + '/')) return true;
    return IS_DEV && url.startsWith(DEV_URL);
  }

  function hardenSession(ses) {
    const allowed = new Set(['pointerLock', 'fullscreen', 'keyboardLock', 'clipboard-sanitized-write']);
    ses.setPermissionRequestHandler((_wc, permission, cb, details) => cb(allowed.has(permission) && isTrustedUrl(details.requestingUrl || '')));
    ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
    if (IS_DEV) {
      // The Vite dev server doesn't send our CSP; add it so dev matches production.
      ses.webRequest.onHeadersReceived({ urls: [DEV_URL + '*'] }, (details, cb) => {
        const headers = { ...details.responseHeaders };
        if (details.resourceType === 'mainFrame') headers['Content-Security-Policy'] = [csp()];
        cb({ responseHeaders: headers });
      });
    }
  }

  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      openExternal(url);
      return { action: 'deny' };
    });
    const guard = (e, url) => {
      if (isTrustedUrl(url)) return;
      e.preventDefault();
      openExternal(url);
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    // A page-level beforeunload must never block quitting the game.
    contents.on('will-prevent-unload', (e) => e.preventDefault());
  });

  function openExternal(url) {
    try {
      const u = new URL(url);
      if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:') void shell.openExternal(u.toString());
    } catch {
      /* ignore malformed */
    }
  }

  // ---------------------------------------------------------------- window
  function createWindow() {
    const ws = windowState.create(app.getPath('userData'), screen);
    const prefs = ws.prefs;
    const info = {
      version: pkg.version,
      platform: process.platform,
      arch: process.arch,
      packaged: app.isPackaged,
      dev: IS_DEV,
      steam: steam.info(),
      // Steam sets SteamDeck=1 in the environment on Deck hardware (also covers Steam not initialising).
      steamDeck: steam.info().steamDeck || process.env.SteamDeck === '1',
    };
    const w = new BrowserWindow({
      title: 'Frostline',
      width: prefs.width,
      height: prefs.height,
      x: prefs.x,
      y: prefs.y,
      minWidth: 960,
      minHeight: 540,
      useContentSize: true,
      show: false,
      backgroundColor: BG,
      // macOS: a window created fullscreen while hidden gets stuck mid-transition (never fullscreen, and close()
      // waits for the transition forever) — so on mac we enter fullscreen right after show() instead.
      fullscreen: IS_MAC ? false : prefs.fullscreen,
      fullscreenable: true,
      autoHideMenuBar: true,
      icon: process.platform === 'darwin' ? undefined : path.join(__dirname, 'assets', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false,
        spellcheck: false,
        devTools: ALLOW_DEVTOOLS,
        autoplayPolicy: 'no-user-gesture-required',
        additionalArguments: ['--frostline-info=' + encodeURIComponent(JSON.stringify(info))],
      },
    });
    ws.track(w);
    if (prefs.maximized && !prefs.fullscreen) w.maximize();
    w.setMenuBarVisibility(false);

    w.once('ready-to-show', () => {
      // A game should come to the front (macOS won't complete a fullscreen transition for a background app).
      if (IS_MAC) app.focus({ steal: true });
      w.show();
      w.focus();
      if (IS_MAC && prefs.fullscreen) w.setFullScreen(true);
    });
    // Safety net: never leave an invisible window if ready-to-show doesn't fire (GPU hiccup).
    setTimeout(() => {
      if (!w.isDestroyed() && !w.isVisible()) w.show();
    }, 8000);

    const sendFullscreen = () => !w.isDestroyed() && w.webContents.send('window:fullscreen-changed', w.isFullScreen());
    w.on('enter-full-screen', sendFullscreen);
    w.on('leave-full-screen', sendFullscreen);

    w.webContents.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
      const toggleFs = input.key === 'F11' || (input.key === 'Enter' && input.alt && process.platform !== 'darwin');
      if (toggleFs) {
        e.preventDefault();
        w.setFullScreen(!w.isFullScreen());
      } else if (ALLOW_DEVTOOLS && (input.key === 'F12' || (input.key.toLowerCase() === 'i' && input.shift && (input.control || input.meta)))) {
        e.preventDefault();
        w.webContents.toggleDevTools();
      }
    });

    // Electron ≥ 35: level/message live on the event object (single-arg handler avoids the deprecation path).
    w.webContents.on('console-message', (event) => {
      const level = String(event.level);
      if (level !== 'error' && level !== 'warning') return;
      log(`[renderer:${level}]`, String(event.message).slice(0, 2000));
    });

    let crashes = 0;
    w.webContents.on('render-process-gone', async (_e, details) => {
      log('[main] renderer gone', details.reason, details.exitCode);
      if (details.reason === 'clean-exit' || allowClose) return;
      crashes++;
      if (crashes <= 1) {
        w.webContents.reload();
        return;
      }
      const { response } = await dialog.showMessageBox(w, {
        type: 'error',
        title: 'Frostline',
        message: 'Frostline stopped unexpectedly.',
        detail: 'Your last save is safe. Restart the game?',
        buttons: ['Restart', 'Quit'],
        defaultId: 0,
      });
      if (response === 0) w.webContents.reload();
      else app.quit();
    });
    w.on('unresponsive', () => log('[main] window unresponsive'));

    // Before-quit handshake: let the renderer write its last save, then close for real.
    w.on('close', (e) => {
      if (allowClose) return;
      e.preventDefault();
      log('[main] close requested (fullscreen=' + w.isFullScreen() + ')');
      flushRenderer(w).then(async (result) => {
        log('[main] renderer flush:', result);
        await saves.drain().catch(() => {});
        steam.flush();
        allowClose = true;
        // Everything is saved. Exit directly: on macOS, closing/destroying a native-fullscreen window at quit
        // keeps the process alive ~30 s while AppKit tears down the fullscreen Space.
        log('[main] exiting');
        // app.exit skips Chromium's graceful teardown, so persist localStorage (settings) explicitly.
        try {
          w.webContents.session.flushStorageData();
        } catch {
          /* window already gone */
        }
        steam.shutdown();
        if (logStream) logStream.end();
        app.exit(0);
      });
    });
    w.on('closed', () => {
      if (win === w) win = null;
    });

    const base = IS_DEV ? DEV_URL : `${APP_ORIGIN}/index.html`;
    void w.loadURL(EXTRA_QUERY ? `${base}?${EXTRA_QUERY}` : base).catch((err) => log('[main] load failed', String(err)));
    return w;
  }

  function flushRenderer(w, timeoutMs = 4000) {
    if (flushing) return flushing;
    flushing = new Promise((resolve) => {
      if (w.isDestroyed() || w.webContents.isCrashed()) return resolve('renderer gone');
      const token = Math.random().toString(36).slice(2);
      const done = (r) => {
        clearTimeout(timer);
        ipcMain.removeListener('app:quit-ready', onReady);
        resolve(r);
      };
      const onReady = (event, t) => {
        if (event.sender === w.webContents && t === token) done('ok');
      };
      const timer = setTimeout(() => done('timeout'), timeoutMs);
      ipcMain.on('app:quit-ready', onReady);
      w.webContents.send('app:before-quit', token);
    });
    return flushing;
  }

  // ---------------------------------------------------------------- IPC
  function registerIpc() {
    /** Wrap a handler: reject calls from anything but our own page. */
    const handle = (channel, fn) =>
      ipcMain.handle(channel, (event, ...args) => {
        const url = event.senderFrame ? event.senderFrame.url : '';
        if (!isTrustedUrl(url)) throw new Error('untrusted sender');
        return fn(event, ...args);
      });
    const winOf = (event) => BrowserWindow.fromWebContents(event.sender);

    // Steam
    handle('steam:info', () => steam.info());
    handle('steam:unlock', (_e, id) => {
      if (typeof id !== 'string' || !/^[A-Z0-9_]{1,64}$/.test(id)) throw new Error('invalid achievement id');
      return steam.unlockAchievement(id);
    });
    handle('steam:is-achieved', (_e, id) => typeof id === 'string' && /^[A-Z0-9_]{1,64}$/.test(id) && steam.isAchieved(id));
    handle('steam:set-stat', (_e, name, value) => {
      if (typeof name !== 'string' || !/^[a-z0-9_]{1,64}$/.test(name)) throw new Error('invalid stat name');
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('invalid stat value');
      return steam.setStat(name, value);
    });
    handle('steam:get-stat', (_e, name) => (typeof name === 'string' && /^[a-z0-9_]{1,64}$/.test(name) ? steam.getStat(name) : null));
    handle('steam:store', () => steam.flush());
    handle('steam:overlay', (_e, dialogName) => (dialogName === 'store' ? steam.activateOverlayStore() : steam.activateOverlay(String(dialogName))));

    // Saves
    handle('save:read', (_e, slot) => saves.read(slot));
    handle('save:read-backup', (_e, slot) => saves.readBackup(slot));
    handle('save:write', (_e, slot, data) => saves.write(slot, data));
    handle('save:delete', (_e, slot) => saves.remove(slot));
    handle('save:list', () => saves.list());

    // Window / app
    handle('window:set-fullscreen', (e, on) => {
      const w = winOf(e);
      if (w && w.isFullScreen() !== !!on) w.setFullScreen(!!on);
      return !!on;
    });
    handle('window:is-fullscreen', (e) => {
      const w = winOf(e);
      return w ? w.isFullScreen() : false;
    });
    handle('app:quit', () => {
      setImmediate(() => app.quit());
      return true;
    });
    handle('app:open-external', (_e, url) => {
      openExternal(String(url));
      return true;
    });
  }

  // ---------------------------------------------------------------- menu
  function buildMenu() {
    if (process.platform !== 'darwin') {
      Menu.setApplicationMenu(null);
      return;
    }
    // macOS needs an app menu for Cmd+Q / Cmd+H and an Edit menu for copy/paste in text fields.
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'editMenu' },
        { label: 'View', submenu: [{ role: 'togglefullscreen' }] },
        { role: 'windowMenu' },
      ]),
    );
  }
}

// ------------------------------------------------------------------ helpers
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.txt': 'text/plain; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.ktx2': 'image/ktx2',
};
function mimeType(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}
