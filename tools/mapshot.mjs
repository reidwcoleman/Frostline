#!/usr/bin/env node
// Renders a top-down hillshade map of the generated world (lake, creeks, trees, rocks, spawn).
//   node tools/mapshot.mjs --out shots/map.png [--seed 7] [--size 1024]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const out = get('--out', 'shots/map.png');
const seed = get('--seed', '');
const size = +get('--size', '1024');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.on('pageerror', (e) => console.error(String(e)));
await page.goto(`http://127.0.0.1:5317/?shot=1${seed ? '&seed=' + seed + '&nocache=1' : ''}`);
await page.waitForFunction(() => window.__frostline && window.__frostline.ready, null, { timeout: 180000 });
const data = await page.evaluate((S) => {
  const { terrain: t, world: w } = window.fl.ctx;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  const step = t.size / S;
  let min = Infinity, max = -Infinity;
  for (let k = 0; k < t.heights.length; k++) { min = Math.min(min, t.heights[k]); max = Math.max(max, t.heights[k]); }
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const x = -t.half + (i + 0.5) * step, z = -t.half + (j + 0.5) * step;
    const h = t.baseHeight(x, z);
    const e = step;
    const dx = t.baseHeight(x + e, z) - t.baseHeight(x - e, z);
    const dz = t.baseHeight(x, z + e) - t.baseHeight(x, z - e);
    const nx = -dx, ny = 2 * e, nz = -dz; const nl = Math.hypot(nx, ny, nz);
    const shade = Math.max(0, (nx * -0.6 + ny * 0.6 + nz * -0.5) / nl);
    const a = (h - min) / (max - min);
    let r = 60 + a * 190, gg = 70 + a * 180, b = 85 + a * 170;
    const k = 0.35 + 0.8 * shade; r *= k; gg *= k; b *= k;
    const f = t.flowAt(x, z); if (f > 0.62) { r *= 0.8; gg *= 0.85; b *= 1.05; }
    if (t.lakeFactor(x, z) > 0.5) { r = 120; gg = 170; b = 210; }
    // contour lines every 50m
    if (Math.abs(((h % 50) + 50) % 50) < 1.2) { r *= 0.8; gg *= 0.8; b *= 0.8; }
    const o = (j * S + i) * 4; img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = b; img.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  g.fillStyle = 'rgba(20,60,35,0.55)';
  for (let i = 0; i < w.treeCount; i += 1) g.fillRect((w.treeX[i] + t.half) / step, (w.treeZ[i] + t.half) / step, 1, 1);
  g.fillStyle = 'rgba(90,80,70,0.9)';
  for (let i = 0; i < w.rockCount; i++) g.fillRect((w.rockX[i] + t.half) / step - 1, (w.rockZ[i] + t.half) / step - 1, 2, 2);
  const [sx, sz] = t.data.spawn;
  g.fillStyle = '#ff5a1f'; g.beginPath(); g.arc((sx + t.half) / step, (sz + t.half) / step, 6, 0, 7); g.fill();
  return { url: c.toDataURL('image/png'), min, max, trees: w.treeCount, rocks: w.rockCount, lake: t.lakeLevel, spawn: t.data.spawn };
}, size);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.from(data.url.split(',')[1], 'base64'));
delete data.url;
console.log('saved', out, JSON.stringify(data));
await browser.close();
