#!/usr/bin/env node
// Dev-only batch screenshot runner for the combat/wildlife agent: boots the game ONCE and runs a
// list of jobs (JS setup + wait + capture) on the same page, retrying a job if a Vite HMR reload
// wipes the page mid-way.
//   node src/combat/dev/shoot.mjs jobs.json
// jobs.json: { "q": "skipMenu=1&time=11&freeze=1", "w": 1600, "h": 900,
//              "jobs": [ { "out": "shots/combat/x.png", "js": "...", "wait": 800 } ] }
// `js` runs as an async function body with `fl` in scope; return values are printed.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const base = spec.url ?? 'http://127.0.0.1:5317/';
const url = base + '?' + (spec.q ?? 'skipMenu=1') + '&shot=1';
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const page = await browser.newPage({ viewport: { width: spec.w ?? 1600, height: spec.h ?? 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
  if (spec.logs) console.log(`[${m.type()}] ${m.text()}`);
});

async function boot() {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__frostline && window.__frostline.ready && window.__frostline.frames > 20, null, { timeout: 180000, polling: 250 });
  if (spec.init) await page.evaluate(`(async () => { ${spec.init} })()`);
}

const t0 = Date.now();
await boot();
console.log(`booted in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
for (const job of spec.jobs) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await page.evaluate(`(async () => { ${job.js ?? ''} })()`);
      if (r !== undefined) console.log(`  ${path.basename(job.out)} →`, JSON.stringify(r)?.slice(0, 400));
      await page.waitForTimeout(job.wait ?? 500);
      if (job.after) {
        const r2 = await page.evaluate(`(async () => { ${job.after} })()`);
        if (r2 !== undefined) console.log(`  after →`, JSON.stringify(r2)?.slice(0, 400));
      }
      fs.mkdirSync(path.dirname(job.out), { recursive: true });
      await page.screenshot({ path: job.out });
      console.log(`saved ${job.out}`);
      break;
    } catch (err) {
      console.log(`  retry ${job.out}: ${String(err.message).slice(0, 120)}`);
      try {
        await page.waitForTimeout(1500);
        await boot();
      } catch (e2) {
        console.log('  reboot failed', String(e2).slice(0, 100));
      }
    }
  }
}
const fps = await page.evaluate(() => window.__frostline?.fps).catch(() => -1);
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s fps=${fps}`);
if (errors.length) console.log('errors:\n  ' + [...new Set(errors)].slice(0, 12).join('\n  '));
await browser.close();
