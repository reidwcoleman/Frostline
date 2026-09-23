#!/usr/bin/env node
// End-to-end smoke test of the desktop build. Launches the real app (unpackaged prod build by default, or a
// packaged binary), drives it over the Chrome DevTools Protocol, and checks:
//   boot → main menu, WebGL renderer, terrain worker + IndexedDB cache, CSP (no violations), Steam guarded,
//   new game → save lands in userData/saves, achievement → profile.json, before-quit handshake save,
//   corrupt save → .bak fallback on the next launch.
//
//   npm run smoke                                   # electron . (needs `npm run build` first)
//   npm run smoke -- --app release/mac-arm64/Frostline.app/Contents/MacOS/Frostline
//   options: --out shots/platform  --fullscreen (also test first-launch fullscreen)  --keep (keep profile)
//
// CDP (--remote-debugging-port) is used instead of Playwright's _electron.launch because release builds turn
// off the Node inspector fuse, which _electron.launch depends on.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const flag = (name) => args.includes('--' + name);
const APP = opt('app', '');
const OUT = path.resolve(root, opt('out', 'shots/platform'));
const TEST_FULLSCREEN = flag('fullscreen');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'frostline-smoke-'));
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function launch(label) {
  const port = await freePort();
  const exe = APP ? path.resolve(root, APP) : electronPath;
  const argv = [...(APP ? [] : [root]), `--remote-debugging-port=${port}`];
  const env = { ...process.env, FROSTLINE_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.FROSTLINE_DEV_URL;
  const proc = spawn(exe, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  proc.stdout.on('data', (d) => (stdout += d));
  proc.stderr.on('data', (d) => (stdout += d));
  const exited = new Promise((r) => proc.on('exit', (code) => r(code)));

  let browser = null;
  for (let i = 0; i < 100 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      await sleep(200);
    }
  }
  if (!browser) throw new Error(`${label}: could not connect over CDP\n${stdout}`);
  let page = null;
  for (let i = 0; i < 100 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => /^(app|http):/.test(p.url())) ?? null;
    if (!page) await sleep(100);
  }
  if (!page) throw new Error(`${label}: no game page`);
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || /Content Security Policy|Refused to/.test(m.text())) consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  return { proc, browser, page, exited, consoleErrors, log: () => stdout };
}

async function waitReady(page, state = 'menu') {
  await page.waitForFunction((s) => window.__frostline?.ready && window.__frostline.state === s, state, { timeout: 180000, polling: 250 });
}

const saveFile = (slot) => path.join(profile, 'saves', slot + '.json');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

try {
  // ------------------------------------------------------------ run 1: fresh profile
  if (!TEST_FULLSCREEN) fs.writeFileSync(path.join(profile, 'window.json'), JSON.stringify({ fullscreen: false, width: 1600, height: 900 }));
  const t0 = Date.now();
  let r = await launch('run 1');
  await waitReady(r.page, 'menu');
  check('boots to the main menu', true, `${((Date.now() - t0) / 1000).toFixed(1)} s (fresh profile, terrain generated)`);

  const diag = await r.page.evaluate(async () => {
    const n = window.frostlineNative;
    const gl = window.fl.ctx.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const idbKeys = await new Promise((resolve) => {
      const req = indexedDB.open('frostline-cache', 1);
      req.onsuccess = () => {
        try {
          const k = req.result.transaction('terrain', 'readonly').objectStore('terrain').getAllKeys();
          k.onsuccess = () => resolve(k.result);
          k.onerror = () => resolve([]);
        } catch {
          resolve([]);
        }
      };
      req.onerror = () => resolve([]);
    });
    // Load the terrain module worker + a blob: worker under the production CSP.
    const moduleWorker = await (async () => {
      const main = [...document.scripts].find((s) => s.type === 'module' && s.src);
      const m = main && /terrain\.worker-[\w-]+\.js/.exec(await (await fetch(main.src)).text());
      if (!m) return 'worker asset not found';
      return new Promise((res) => {
        const w = new Worker(new URL('assets/' + m[0], location.href), { type: 'module' });
        const t = setTimeout(() => (w.terminate(), res(true)), 1000);
        w.onerror = (e) => (clearTimeout(t), w.terminate(), res('error: ' + (e.message || 'load failed')));
      });
    })();
    const blobWorker = await new Promise((res) => {
      const w = new Worker(URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' })));
      w.onmessage = () => (w.terminate(), res(true));
      w.onerror = () => res(false);
      setTimeout(() => res(false), 2000);
    });
    const f0 = window.__frostline.frames;
    await new Promise((res) => setTimeout(res, 2000));
    return {
      href: location.href,
      native: !!n,
      version: n?.app.version,
      steam: n?.steam.info(),
      platform: { isElectron: window.fl.ctx.platform.isElectron, steam: window.fl.ctx.platform.steam },
      webgl2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext,
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      moduleWorker,
      blobWorker,
      idbKeys,
      fps: (window.__frostline.frames - f0) / 2,
      nodeLeak: typeof window.require !== 'undefined' || typeof window.process !== 'undefined',
      evalBlocked: (() => {
        try {
          (0, eval)('1');
          return false;
        } catch {
          return true;
        }
      })(),
    };
  });
  check('served from app:// origin', diag.href.startsWith('app://frostline/'), diag.href);
  check('preload bridge present', diag.native && diag.platform.isElectron, `v${diag.version}`);
  check('no Node globals in the renderer', !diag.nodeLeak);
  check('CSP enforced (eval blocked)', diag.evalBlocked);
  check('WebGL2 on the GPU', diag.webgl2 && !/SwiftShader|llvmpipe/i.test(diag.renderer), diag.renderer);
  check('rendering frames', diag.fps > 20, `${diag.fps.toFixed(0)} fps in the menu`);
  check('terrain generated in the worker + cached in IndexedDB (fresh profile)', diag.idbKeys.length > 0, JSON.stringify(diag.idbKeys));
  check('module worker loads under CSP', diag.moduleWorker === true, String(diag.moduleWorker));
  check('blob: worker loads under CSP', diag.blobWorker === true);
  check('Steam guarded', diag.steam && (diag.steam.available || diag.steam.reason), diag.steam.available ? `Steam available: app ${diag.steam.appId} as ${diag.steam.user}` : `skipped: ${diag.steam.reason}`);
  await r.page.screenshot({ path: path.join(OUT, 'electron-menu.png') });

  if (TEST_FULLSCREEN) {
    await sleep(1500);
    const fs1 = await r.page.evaluate(() => window.frostlineNative.window.isFullscreen());
    check('first launch is fullscreen', fs1);
    await r.page.evaluate(() => window.frostlineNative.window.setFullscreen(false));
    await sleep(1500);
    const fs2 = await r.page.evaluate(async () => ({ win: await window.frostlineNative.window.isFullscreen(), setting: window.fl.ctx.settings.data.fullscreen }));
    check('leave fullscreen via bridge, setting mirrors it', !fs2.win && fs2.setting === false, JSON.stringify(fs2));
    // Back to fullscreen through the settings path (what the options menu does), then play + quit fullscreen.
    await r.page.evaluate(() => window.fl.ctx.settings.set('fullscreen', true));
    await sleep(2000);
    const fs3 = await r.page.evaluate(() => window.frostlineNative.window.isFullscreen());
    check('settings.fullscreen=true re-enters fullscreen', fs3);
  }

  // New game → play → save
  await r.page.evaluate(() => window.fl.newGame());
  await sleep(4000);
  await r.page.screenshot({ path: path.join(OUT, 'electron-play.png') });
  await r.page.evaluate(async () => {
    window.fl.ctx.events.emit('fire:lit', { id: 0 });
    await window.fl.ctx.sys.save.save();
  });
  await sleep(600);
  const s1 = fs.existsSync(saveFile('slot1')) ? readJson(saveFile('slot1')) : null;
  check('save written to userData/saves/slot1.json', !!s1 && s1.version >= 1 && s1.meta && !s1.meta.dead, s1 ? `${fs.statSync(saveFile('slot1')).size} bytes, day ${s1.meta.day}` : 'missing');
  const prof = fs.existsSync(saveFile('profile')) ? readJson(saveFile('profile')) : null;
  check('achievement persisted in profile.json', prof?.achievements?.includes('FIRST_FIRE'), JSON.stringify(prof?.achievements));

  // Quit through the app (main runs the before-quit handshake → final save)
  await sleep(1500); // let some play time pass so the final save differs
  const before = s1?.savedAt ?? 0;
  await r.page.evaluate(() => window.frostlineNative.window.quit()).catch(() => {});
  const tq = Date.now();
  const code = await Promise.race([r.exited, sleep(45000).then(() => 'timeout')]);
  check('quits cleanly', code === 0, `exit ${code} after ${((Date.now() - tq) / 1000).toFixed(1)} s`);
  if (code === 'timeout') {
    r.proc.kill('SIGKILL'); // don't let a stuck instance hold the single-instance lock for run 2
    await sleep(1000);
  }
  const s2 = readJson(saveFile('slot1'));
  check('before-quit handshake saved', s2.savedAt > before, `savedAt +${s2.savedAt - before} ms`);
  check('.bak of previous save kept', fs.existsSync(saveFile('slot1') + '.bak'));
  const mainLog = fs.readFileSync(path.join(profile, 'logs', 'main.log'), 'utf8');
  check('main.log written', /renderer flush: ok/.test(mainLog), 'renderer flush: ' + (/renderer flush: (\S+)/.exec(mainLog)?.[1] ?? '?'));
  check('no console errors / CSP violations (run 1)', r.consoleErrors.length === 0, r.consoleErrors.slice(0, 5).join(' | '));
  await r.browser.close().catch(() => {});

  // ------------------------------------------------------------ run 2: corrupt save → backup
  fs.writeFileSync(saveFile('slot1'), '{"version":1, "seed": 42, this is not json');
  r = await launch('run 2');
  await waitReady(r.page, 'menu');
  const sum = await r.page.evaluate(() => window.fl.ctx.sys.save.summary());
  check('corrupt save falls back to .bak', sum?.fromBackup && sum.canContinue, JSON.stringify(sum));
  const loaded = await r.page.evaluate(() => window.fl.ctx.sys.save.load());
  await sleep(2500);
  const st = await r.page.evaluate(() => window.fl.state);
  check('continue from backup', loaded && st === 'playing', `load()=${loaded}, state=${st}`);
  await r.page.screenshot({ path: path.join(OUT, 'electron-continue.png') });
  check('no console errors / CSP violations (run 2)', r.consoleErrors.length === 0, r.consoleErrors.slice(0, 5).join(' | '));
  await r.page.evaluate(() => window.frostlineNative.window.quit()).catch(() => {});
  const code2 = await Promise.race([r.exited, sleep(45000).then(() => 'timeout')]);
  if (code2 === 'timeout') r.proc.kill('SIGKILL');
  await r.browser.close().catch(() => {});
} catch (err) {
  check('smoke test ran to completion', false, String(err?.stack ?? err));
} finally {
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${path.relative(root, OUT)}/electron-*.png  Profile: ${profile}`);
  if (!flag('keep')) fs.rmSync(profile, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
