#!/usr/bin/env node
// Achievement icons for the Steamworks partner site (Stats & Achievements → each achievement needs an
// "achieved" and an "unachieved" image).  npm run steam:icons
//   → steam/achievements/icons/<API_NAME>.jpg          achieved (navy badge, warm-white glyph, one orange accent)
//   → steam/achievements/icons/<API_NAME>_locked.jpg   unachieved (greyscale, dimmed)
//   → shots/platform/achievement-sheet.png              contact sheet for review
// 256×256 JPG. Same visual language as the app icon: deep navy, warm snow white, signal-flare orange.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = path.join(root, 'steam', 'achievements', 'icons');
fs.mkdirSync(outDir, { recursive: true });
const font = fs.readFileSync(path.join(root, 'node_modules/@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff2')).toString('base64');

const W = '#F4F1EA'; // snow white
const O = '#FF6A2B'; // flare orange
const S = 'stroke-linecap="round" stroke-linejoin="round" fill="none"';

/** Glyphs drawn in a 256 box, centred on (128,128), roughly inside 64..192. */
const GLYPHS = {
  FIRST_NIGHT: `
    <path d="M70 160 H186" stroke="${W}" stroke-width="10" ${S}/>
    <path d="M92 160 A36 36 0 0 1 164 160 Z" fill="${O}"/>
    <g stroke="${O}" stroke-width="8" ${S}>
      <path d="M128 100 V84"/><path d="M90 116 L79 105"/><path d="M166 116 L177 105"/>
    </g>
    <path d="M168 62 a18 18 0 1 0 14 26 a14 14 0 1 1 -14 -26 Z" fill="${W}" opacity="0.85"/>
    <path d="M86 180 H170" stroke="${W}" stroke-width="6" opacity="0.5" ${S}/>`,
  SURVIVE_3: numeral('3'),
  SURVIVE_7: numeral('7'),
  SURVIVE_30: numeral('30'),
  FIRST_FIRE: `
    <path d="M128 64 C 150 96, 176 112, 164 148 C 158 168, 142 178, 128 178 C 110 178, 92 166, 92 144 C 92 124, 108 114, 112 96 C 122 108, 124 118, 122 128 C 136 116, 136 92, 128 64 Z" fill="${O}"/>
    <path d="M128 132 C 138 144, 146 152, 140 166 C 136 172, 120 172, 116 164 C 112 154, 122 146, 128 132 Z" fill="${W}"/>
    <g stroke="${W}" stroke-width="12" ${S}><path d="M76 196 L180 172"/><path d="M76 172 L180 196"/></g>`,
  TIMBER: `
    <path d="M52 196 H204" stroke="${W}" stroke-width="8" ${S}/>
    <path d="M74 196 V174 L84 168 L96 176 L106 170 V196 Z" fill="${W}"/>
    <g transform="rotate(64 92 168)">
      <rect x="86" y="146" width="12" height="24" fill="${W}"/>
      <path d="M92 58 L122 104 H62 Z" fill="${W}"/>
      <path d="M92 82 L130 132 H54 Z" fill="${W}"/>
      <path d="M92 108 L138 156 H46 Z" fill="${W}"/>
    </g>
    <path d="M118 66 A92 92 0 0 1 196 118" stroke="${O}" stroke-width="7" stroke-dasharray="2 14" ${S}/>`,
  LUMBERJACK: `
    <path d="M86 196 L160 76" stroke="${W}" stroke-width="14" ${S}/>
    <path d="M140 64 C 164 60, 190 74, 196 100 L 168 112 L 146 98 Z" fill="${W}"/>
    <path d="M196 100 L 168 112" stroke="${O}" stroke-width="8" ${S}/>
    <text x="80" y="118" font-family="IS" font-size="46" fill="${O}" text-anchor="middle">50</text>`,
  HOMESTEAD: `
    <path d="M62 128 L128 70 L194 128" stroke="${W}" stroke-width="12" ${S}/>
    <path d="M80 118 V190 H176 V118" stroke="${W}" stroke-width="12" ${S}/>
    <g stroke="${W}" stroke-width="5" opacity="0.55"><path d="M84 146 H172"/><path d="M84 168 H172"/></g>
    <rect x="112" y="138" width="32" height="28" rx="3" fill="${O}"/>
    <path d="M160 88 V70 H176 V102" fill="${W}"/>`,
  HUNTER: `
    <g stroke="${W}" stroke-width="10" ${S}>
      <path d="M116 176 C 104 140, 100 110, 78 78"/><path d="M104 132 L72 120"/><path d="M92 102 L96 70"/>
      <path d="M140 176 C 152 140, 156 110, 178 78"/><path d="M152 132 L184 120"/><path d="M164 102 L160 70"/>
    </g>
    <path d="M108 170 Q128 200 148 170 L140 158 H116 Z" fill="${W}"/>
    <circle cx="128" cy="196" r="7" fill="${O}"/>`,
  WOLF_SLAYER: wolf(false),
  PACK_BREAKER: wolf(true),
  SPEED_DEMON: `
    <g stroke="${W}" stroke-width="10" ${S}>
      <path d="M58 100 H120"/><path d="M44 128 H120"/><path d="M58 156 H120"/>
    </g>
    <path d="M132 84 L184 128 L132 172" stroke="${O}" stroke-width="16" ${S}/>
    <path d="M160 84 L212 128 L160 172" stroke="${W}" stroke-width="10" opacity="0.6" ${S}/>`,
  BIG_AIR: `
    <path d="M44 196 L100 164" stroke="${W}" stroke-width="10" ${S}/>
    <path d="M104 160 Q 150 30, 206 150" stroke="${W}" stroke-width="7" stroke-dasharray="4 16" ${S}/>
    <circle cx="150" cy="88" r="15" fill="${O}"/>
    <path d="M130 106 L172 98" stroke="${O}" stroke-width="7" ${S}/>
    <path d="M186 196 H214" stroke="${W}" stroke-width="10" ${S}/>`,
  SUMMIT: `
    <path d="M52 196 L112 104 L128 120 L150 84 L206 196 Z" fill="${W}"/>
    <path d="M150 84 L150 50" stroke="${W}" stroke-width="6" ${S}/>
    <path d="M152 50 L184 60 L152 72 Z" fill="${O}"/>
    <path d="M112 104 L96 150 L118 138 L128 120 Z" fill="#9DB4D9"/>`,
  COLD_SNAP: `
    <g stroke="${W}" stroke-width="9" ${S}>
      ${[0, 60, 120].map((a) => `<g transform="rotate(${a} 128 128)"><path d="M128 60 V196"/><path d="M128 84 L112 70 M128 84 L144 70"/><path d="M128 172 L112 186 M128 172 L144 186"/></g>`).join('')}
    </g>
    <circle cx="128" cy="128" r="12" fill="${O}"/>`,
  CHEF: `
    <path d="M70 120 H186 V156 A28 28 0 0 1 158 184 H98 A28 28 0 0 1 70 156 Z" fill="${W}"/>
    <path d="M58 120 H198" stroke="${W}" stroke-width="10" ${S}/>
    <g stroke="${W}" stroke-width="7" opacity="0.8" ${S}>
      <path d="M104 104 q-10 -14 0 -28 q10 -14 0 -28"/><path d="M128 104 q-10 -14 0 -28 q10 -14 0 -28"/><path d="M152 104 q-10 -14 0 -28 q10 -14 0 -28"/>
    </g>
    <path d="M104 206 q8 -18 24 -18 q16 0 24 18 Z" fill="${O}"/>`,
};

function numeral(n) {
  return `
    <path d="M78 96 A56 56 0 0 1 178 96" stroke="${O}" stroke-width="8" ${S}/>
    <text x="128" y="${n.length > 1 ? 178 : 182}" font-family="IS" font-size="${n.length > 1 ? 104 : 124}" fill="${W}" text-anchor="middle">${n}</text>
    <path d="M100 196 H156" stroke="${W}" stroke-width="6" opacity="0.55" ${S}/>`;
}

function wolf(pack) {
  const head = (dx, s, o) => `
    <g transform="translate(${dx} 0) translate(128 128) scale(${s}) translate(-128 -128)" opacity="${o}">
      <path d="M82 70 L106 106 H150 L174 70 L182 128 L156 170 L128 196 L100 170 L74 128 Z" fill="${W}"/>
      <path d="M110 136 L124 144 L110 146 Z" fill="${O}"/><path d="M146 136 L132 144 L146 146 Z" fill="${O}"/>
      <path d="M118 176 L128 184 L138 176" stroke="#0E1419" stroke-width="5" ${S}/>
    </g>`;
  if (!pack) return head(0, 1, 1);
  return head(-56, 0.62, 0.55) + head(56, 0.62, 0.55) + head(0, 0.86, 1) + `<text x="200" y="212" font-family="IS" font-size="44" fill="${O}" text-anchor="middle">10</text>`;
}

function badge(id, locked) {
  const bgA = locked ? '#1B1E23' : '#0E1419';
  const bgB = locked ? '#2A2E35' : '#1D2A3B';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
    <defs>
      <style>@font-face{font-family:IS;src:url(data:font/woff2;base64,${font}) format('woff2')}</style>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${bgA}"/><stop offset="1" stop-color="${bgB}"/></linearGradient>
      <radialGradient id="glow" cx="128" cy="128" r="150" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${O}" stop-opacity="${locked ? 0 : 0.16}"/><stop offset="1" stop-color="${O}" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="256" height="256" fill="url(#bg)"/>
    <rect width="256" height="256" fill="url(#glow)"/>
    <rect x="10" y="10" width="236" height="236" rx="28" fill="none" stroke="${locked ? '#3A3F47' : '#FFFFFF'}" stroke-opacity="${locked ? 1 : 0.12}" stroke-width="3"/>
    <g ${locked ? 'filter="url(#gray)" opacity="0.42"' : ''}>${GLYPHS[id]}</g>
    <filter id="gray"><feColorMatrix type="saturate" values="0"/></filter>
  </svg>`;
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
const ids = Object.keys(GLYPHS);
for (const id of ids) {
  for (const locked of [false, true]) {
    await page.setContent(`<body style="margin:0">${badge(id, locked)}</body>`);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(outDir, `${id}${locked ? '_locked' : ''}.jpg`), type: 'jpeg', quality: 92, clip: { x: 0, y: 0, width: 256, height: 256 } });
  }
}
// Contact sheet: achieved row + locked row per achievement, at 128 px.
await page.setViewportSize({ width: 8 * 136 + 8, height: 4 * 136 + 8 });
const cells = ids.flatMap((id) => [false, true].map((l) => `<div style="width:128px;height:128px;overflow:hidden;border-radius:6px">${badge(id, l).replace('width="256" height="256"', 'width="128" height="128"')}</div>`));
await page.setContent(`<body style="margin:0;background:#0b1016;display:grid;grid-template-columns:repeat(8,128px);gap:8px;padding:8px">${cells.join('')}</body>`);
await page.evaluate(() => document.fonts.ready);
fs.mkdirSync(path.join(root, 'shots', 'platform'), { recursive: true });
await page.screenshot({ path: path.join(root, 'shots', 'platform', 'achievement-sheet.png'), fullPage: true });
await browser.close();
console.log(`wrote ${ids.length * 2} icons to ${path.relative(root, outDir)}/`);
