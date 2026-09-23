#!/usr/bin/env node
// Procedural app icon for Frostline → every format the platforms and Steam want.
//   npm run icons
// Art: one bold peak (warm-white sun face, sky-blue shadow face), a carved twin ski track, and a single
// signal-orange sun/flare on deep navy. Rendered with headless Chrome (playwright-core, channel 'chrome').
//
// Outputs
//   build/icon.svg                source art (full-bleed square)
//   build/icon.png                1024² rounded square (Linux, electron-builder fallback)
//   build/icon.icns               macOS (Big Sur grid: 824² squircle on 1024² canvas, soft shadow)
//   build/icon.ico                Windows (16…256, PNG-compressed entries)
//   electron/assets/icon.png      256² window/taskbar icon (Windows/Linux BrowserWindow)
//   steam/store/assets/community_icon.jpg   184² (Steamworks → Community Assets)
//   steam/store/assets/client_icon.ico      32² + 16² (Steamworks → Client Icon)
//   shots/platform/icon-preview.png  contact sheet: every size on dark + light backgrounds (review only)
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = (...p) => path.join(root, ...p);

const C = {
  navyTop: '#0A0F15',
  navy: '#0E1419',
  navyHorizon: '#1A2433',
  snowSun: '#F4F1EA',
  snowShade: '#9DB4D9',
  snowShadeDeep: '#7D95BE',
  rock: '#4A4A52',
  track: '#33445C',
  flare: '#FF6A2B',
  forest: '#132520',
};

/** The artwork, drawn in a 1024 box. `id` keeps gradient ids unique when several copies share a page. */
function art(id = 'a') {
  return `
  <defs>
    <linearGradient id="${id}sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${C.navyTop}"/>
      <stop offset="0.55" stop-color="${C.navy}"/>
      <stop offset="1" stop-color="${C.navyHorizon}"/>
    </linearGradient>
    <radialGradient id="${id}glow" cx="742" cy="318" r="330" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${C.flare}" stop-opacity="0.38"/>
      <stop offset="0.35" stop-color="${C.flare}" stop-opacity="0.12"/>
      <stop offset="1" stop-color="${C.flare}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="${id}sunface" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="0.5" stop-color="${C.snowSun}"/>
      <stop offset="1" stop-color="#E6DDD0"/>
    </linearGradient>
    <linearGradient id="${id}shade" x1="1" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${C.snowShade}"/>
      <stop offset="1" stop-color="${C.snowShadeDeep}"/>
    </linearGradient>
    <linearGradient id="${id}sun" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FF8A55"/>
      <stop offset="1" stop-color="${C.flare}"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" fill="url(#${id}sky)"/>
  <rect width="1024" height="1024" fill="url(#${id}glow)"/>
  <!-- a few stars, low-key -->
  <g fill="#DCE6F5" opacity="0.55">
    <circle cx="170" cy="170" r="5"/><circle cx="292" cy="96" r="3.5"/><circle cx="96" cy="330" r="3"/>
    <circle cx="560" cy="120" r="3.5"/><circle cx="905" cy="140" r="4.5"/>
  </g>
  <!-- signal flare / low sun: the one accent -->
  <circle cx="742" cy="318" r="92" fill="url(#${id}sun)"/>
  <!-- far ridge -->
  <path d="M-10 700 L150 590 L250 640 L360 560 L470 660 L620 590 L760 650 L900 575 L1034 640 L1034 1034 L-10 1034 Z" fill="#223047"/>
  <!-- the peak: sun face -->
  <path d="M-20 900 L150 640 L280 500 L352 430 L448 222 L520 330 L588 372 L676 470 L790 560 L905 618 L1044 690 L1044 1044 L-20 1044 Z" fill="url(#${id}sunface)"/>
  <!-- the peak: shadow face (left of the ridge line) -->
  <path d="M-20 900 L150 640 L280 500 L352 430 L448 222 L470 330 L440 430 L476 540 L420 660 L452 780 L380 1044 L-20 1044 Z" fill="url(#${id}shade)"/>
  <!-- a sliver of exposed rock under the summit (steep faces are rock in-game) -->
  <path d="M448 222 L470 330 L458 356 L446 300 Z" fill="${C.rock}" opacity="0.75"/>
  <!-- carved twin ski track down the sun face -->
  <g fill="none" stroke="${C.track}" stroke-width="11" stroke-linecap="round" opacity="0.9">
    <path d="M486 330 C 560 392, 600 450, 540 520 S 470 640, 590 720 S 700 860, 600 1044"/>
    <path d="M504 326 C 580 388, 622 452, 562 522 S 492 642, 612 722 S 722 862, 622 1044"/>
  </g>
`;
}

const svgDoc = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">${inner}</svg>`;

/** Full-bleed square (Steam community icon, source). */
const squareSvg = (id) => svgDoc(art(id));

/** Rounded square filling the canvas (Windows / Linux). Radius scales with the art. */
const roundedSvg = (id) =>
  svgDoc(`<defs><clipPath id="${id}clip"><rect width="1024" height="1024" rx="190" ry="190"/></clipPath></defs>
  <g clip-path="url(#${id}clip)">${art(id)}</g>`);

/** macOS Big Sur grid: 824² squircle at (100,100), drop shadow, thin inner highlight. */
const macSvg = (id) =>
  svgDoc(`<defs>
    <clipPath id="${id}clip"><rect x="100" y="100" width="824" height="824" rx="185" ry="185"/></clipPath>
    <filter id="${id}shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity="0.35"/>
    </filter>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" ry="185" fill="${C.navy}" filter="url(#${id}shadow)"/>
  <g clip-path="url(#${id}clip)"><g transform="translate(100 100) scale(${824 / 1024})">${art(id)}</g></g>
  <rect x="100.5" y="100.5" width="823" height="823" rx="185" ry="185" fill="none" stroke="#FFFFFF" stroke-opacity="0.08"/>`);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1 });

async function render(svg, size, file, { jpeg = false } = {}) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:transparent">
     <div style="width:${size}px;height:${size}px">${svg.replace('width="1024" height="1024"', `width="${size}" height="${size}"`)}</div></body></html>`,
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file, type: jpeg ? 'jpeg' : 'png', quality: jpeg ? 92 : undefined, omitBackground: !jpeg, clip: { x: 0, y: 0, width: size, height: size } });
  return file;
}

/** Minimal ICO writer: PNG-compressed entries (supported since Vista). */
function writeIco(pngFiles, file) {
  const imgs = pngFiles.map(({ size, path: p }) => ({ size, data: fs.readFileSync(p) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(imgs.length, 4);
  const dir = Buffer.alloc(16 * imgs.length);
  let offset = 6 + dir.length;
  imgs.forEach((img, i) => {
    const o = i * 16;
    dir.writeUInt8(img.size >= 256 ? 0 : img.size, o);
    dir.writeUInt8(img.size >= 256 ? 0 : img.size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(img.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += img.data.length;
  });
  fs.writeFileSync(file, Buffer.concat([header, dir, ...imgs.map((i) => i.data)]));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frostline-icons-'));

fs.writeFileSync(out('build', 'icon.svg'), squareSvg('s') + '\n');
await render(roundedSvg('r'), 1024, out('build', 'icon.png'));
await render(roundedSvg('r'), 256, out('electron', 'assets', 'icon.png'));

// Windows .ico
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoPngs = [];
for (const s of icoSizes) icoPngs.push({ size: s, path: await render(roundedSvg('r' + s), s, path.join(tmp, `ico-${s}.png`)) });
writeIco(icoPngs, out('build', 'icon.ico'));

// macOS .icns via iconutil (macOS only; electron-builder can also derive it from icon.png elsewhere)
if (process.platform === 'darwin') {
  const iconset = path.join(tmp, 'icon.iconset');
  fs.mkdirSync(iconset);
  for (const s of [16, 32, 128, 256, 512]) {
    await render(macSvg('m' + s), s, path.join(iconset, `icon_${s}x${s}.png`));
    await render(macSvg('m2' + s), s * 2, path.join(iconset, `icon_${s}x${s}@2x.png`));
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', out('build', 'icon.icns')]);
  await render(macSvg('mac'), 1024, out('shots', 'platform', 'icon-mac.png'));
} else {
  console.warn('skipping icon.icns (needs macOS iconutil)');
}

// Steam community + client icons
await render(squareSvg('c'), 184, out('steam', 'store', 'assets', 'community_icon.jpg'), { jpeg: true });
writeIco(
  [
    { size: 16, path: await render(roundedSvg('c16'), 16, path.join(tmp, 'c16.png')) },
    { size: 32, path: await render(roundedSvg('c32'), 32, path.join(tmp, 'c32.png')) },
  ],
  out('steam', 'store', 'assets', 'client_icon.ico'),
);

// Contact sheet for eyeballing small sizes on dark + light wallpapers.
const sizes = [512, 256, 128, 64, 32, 16];
const cell = (bg) =>
  `<div style="background:${bg};padding:24px;display:flex;gap:24px;align-items:flex-end">` +
  sizes.map((s) => `<img src="data:image/png;base64,${fs.readFileSync(icoPngs.find((i) => i.size === s)?.path ?? out('build', 'icon.png')).toString('base64')}" width="${s}" height="${s}" style="image-rendering:auto">`).join('') +
  `</div>`;
await page.setViewportSize({ width: 1200, height: 1200 });
await page.setContent(`<body style="margin:0">${cell('#1b1f24')}${cell('#e9edf2')}<div style="background:#0b1016;padding:24px"><img src="data:image/png;base64,${fs.readFileSync(out('shots', 'platform', 'icon-mac.png')).toString('base64')}" width="400"></div></body>`);
await page.screenshot({ path: out('shots', 'platform', 'icon-preview.png'), fullPage: true });

await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('icons written: build/icon.{svg,png,icns,ico}, electron/assets/icon.png, steam/store/assets/{community_icon.jpg,client_icon.ico}, shots/platform/icon-preview.png');
