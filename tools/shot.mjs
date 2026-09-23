#!/usr/bin/env node
// Headless screenshot tool. Each call launches its own Chrome, so parallel agents never collide.
//
//   node tools/shot.mjs --q "skipMenu=1&pos=100,200&yaw=45&time=17" --out shots/sunset.png
//   node tools/shot.mjs --q "skipMenu=1" --eval "fl.ctx.player.onSkis=true" --wait 4000 --out shots/x.png
//
// Options:
//   --url   base url (default http://127.0.0.1:5317/)
//   --q     query string appended to the url (dev params, see src/core/types.ts DevParams)
//   --out   output png path (default shots/shot.png)
//   --w/--h viewport (default 1600x900)
//   --wait  extra ms to wait after the game reports ready (default 2500)
//   --eval  JS to run in the page after ready (can be repeated); `fl` is the Game instance
//   --frames  minimum rendered frames before capture (default 30)
//   --logs  print console output
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = { url: 'http://127.0.0.1:5317/', q: '', out: 'shots/shot.png', w: 1600, h: 900, wait: 2500, frames: 30, evals: [], logs: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const v = args[i + 1];
  if (a === '--url') (opt.url = v), i++;
  else if (a === '--q') (opt.q = v), i++;
  else if (a === '--out') (opt.out = v), i++;
  else if (a === '--w') (opt.w = +v), i++;
  else if (a === '--h') (opt.h = +v), i++;
  else if (a === '--wait') (opt.wait = +v), i++;
  else if (a === '--frames') (opt.frames = +v), i++;
  else if (a === '--eval') (opt.evals.push(v), i++);
  else if (a === '--logs') opt.logs = true;
}
const url = opt.url + (opt.q ? (opt.url.includes('?') ? '&' : '?') + opt.q.replace(/^\?/, '') : '') + (opt.q.includes('shot') ? '' : (opt.q || opt.url.includes('?') ? '&' : '?') + 'shot=1');

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const page = await browser.newPage({ viewport: { width: opt.w, height: opt.h } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
  if (opt.logs) console.log(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(String(e)));
const t0 = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded' });
try {
  await page.waitForFunction(() => window.__frostline && window.__frostline.ready, null, { timeout: 120000, polling: 250 });
} catch {
  console.error('Timed out waiting for the game to become ready');
}
for (const e of opt.evals) {
  try {
    const r = await page.evaluate(e);
    if (r !== undefined) console.log('eval →', JSON.stringify(r)?.slice(0, 500));
  } catch (err) {
    console.error('eval failed:', err.message);
  }
}
await page.waitForFunction((n) => window.__frostline && window.__frostline.frames >= n, opt.frames, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(opt.wait);
fs.mkdirSync(path.dirname(opt.out), { recursive: true });
await page.screenshot({ path: opt.out });
const info = await page.evaluate(() => ({ ...window.__frostline, gl: (() => { const c = document.createElement('canvas').getContext('webgl2'); const d = c && c.getExtension('WEBGL_debug_renderer_info'); return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown'; })() }));
console.log(`saved ${opt.out} in ${((Date.now() - t0) / 1000).toFixed(1)}s`, JSON.stringify(info));
if (errors.length) console.log('console errors:\n  ' + errors.slice(0, 15).join('\n  '));
await browser.close();
