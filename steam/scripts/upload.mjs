#!/usr/bin/env node
// Prepare (and optionally run) a SteamPipe upload.
//
//   npm run steam:upload                       # prepare release/steam/*.vdf, print the steamcmd command
//   npm run steam:upload -- --run              # also run steamcmd (needs STEAM_BUILD_USER)
//   npm run steam:upload -- --run --setlive beta --preview
//
// Env: STEAM_BUILD_USER  Steamworks build account (a dedicated account with only "Edit App Metadata" +
//                        "Publish App Changes To Steam" permissions is recommended)
//      STEAMCMD          path to steamcmd (default: `steamcmd` on PATH, ~/Steam/steamcmd.sh, C:\steamcmd\steamcmd.exe)
// Never put passwords in scripts: steamcmd prompts once and caches the login (Steam Guard) itself.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const outDir = path.join(root, 'release', 'steam');
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const appVdfPath = path.join(here, 'app_build.vdf');
let appVdf = fs.readFileSync(appVdfPath, 'utf8');

const field = (text, key) => new RegExp(`"${key}"\\s+"([^"]*)"`).exec(text)?.[1];
const setField = (text, key, value) => text.replace(new RegExp(`("${key}"\\s+)"[^"]*"`), `$1"${value.replace(/"/g, "'")}"`);

const appId = field(appVdf, 'AppID');
const problems = [];
if (!appId || appId === '1000000' || appId === '480') problems.push(`AppID is "${appId}" — set your real App ID in steam/scripts/app_build.vdf`);

// Resolve depots: keep only those whose content exists.
const depotBlock = /"Depots"\s*\{([\s\S]*?)\}/.exec(appVdf)?.[1] ?? '';
const depots = [...depotBlock.matchAll(/"(\d+)"\s+"([^"]+)"/g)].map(([, id, file]) => ({ id, file }));
fs.mkdirSync(outDir, { recursive: true });
const kept = [];
for (const d of depots) {
  const src = path.join(here, d.file);
  let text = fs.readFileSync(src, 'utf8');
  const contentRoot = path.resolve(here, field(text, 'ContentRoot') ?? '.');
  if (d.id.startsWith('100000')) problems.push(`depot ${d.id} (${d.file}) still has a placeholder ID`);
  if (!fs.existsSync(contentRoot) || fs.readdirSync(contentRoot).length === 0) {
    console.log(`- skip depot ${d.id} (${d.file}): no build at ${path.relative(root, contentRoot)}`);
    continue;
  }
  if (fs.existsSync(path.join(contentRoot, 'steam_appid.txt'))) console.warn(`  ! ${path.relative(root, contentRoot)}/steam_appid.txt exists — it is excluded from the depot, but delete it anyway`);
  text = setField(text, 'ContentRoot', contentRoot + path.sep);
  fs.writeFileSync(path.join(outDir, d.file), text);
  kept.push(d);
  console.log(`+ depot ${d.id} ← ${path.relative(root, contentRoot)}`);
}
if (!kept.length) problems.push('no depot has build output — run `npm run dist:mac` / `dist:win` / `dist:linux` first');

const date = new Date().toISOString().slice(0, 16).replace('T', ' ');
appVdf = setField(appVdf, 'Desc', `Frostline v${pkg.version} ${date}`);
appVdf = setField(appVdf, 'ContentRoot', path.join(root, 'release') + path.sep);
appVdf = setField(appVdf, 'BuildOutput', path.join(outDir, 'output') + path.sep);
appVdf = setField(appVdf, 'SetLive', val('--setlive') ?? field(appVdf, 'SetLive') ?? '');
appVdf = setField(appVdf, 'Preview', has('--preview') ? '1' : field(appVdf, 'Preview') ?? '0');
appVdf = appVdf.replace(/"Depots"\s*\{[\s\S]*?\}/, `"Depots"\n\t{\n${kept.map((d) => `\t\t"${d.id}"\t"${d.file}"`).join('\n')}\n\t}`);
const generated = path.join(outDir, 'app_build.vdf');
fs.writeFileSync(generated, appVdf);
console.log(`\nwrote ${path.relative(root, generated)} (${kept.length} depot${kept.length === 1 ? '' : 's'})`);

function findSteamcmd() {
  const candidates = [process.env.STEAMCMD, 'steamcmd', path.join(os.homedir(), 'Steam', 'steamcmd.sh'), path.join(os.homedir(), 'steamcmd', 'steamcmd.sh'), 'C:\\steamcmd\\steamcmd.exe'].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ['+quit'], { stdio: 'ignore', shell: process.platform === 'win32' });
    if (r.status === 0 || r.status === 7) return c;
  }
  return null;
}

const user = process.env.STEAM_BUILD_USER || '<build-account>';
const cmd = `steamcmd +login ${user} +run_app_build "${generated}" +quit`;
if (problems.length) {
  console.log('\nNot ready to upload:');
  for (const p of problems) console.log('  • ' + p);
}
if (!has('--run')) {
  console.log(`\nTo upload:\n  ${cmd}\n(or: npm run steam:upload -- --run)`);
  process.exit(0);
}
if (problems.length) process.exit(1);
if (!process.env.STEAM_BUILD_USER) {
  console.error('Set STEAM_BUILD_USER to your Steamworks build account.');
  process.exit(1);
}
const steamcmd = findSteamcmd();
if (!steamcmd) {
  console.error('steamcmd not found. Install it (https://developer.valvesoftware.com/wiki/SteamCMD) or set STEAMCMD.');
  process.exit(1);
}
console.log(`\n> ${steamcmd} +login ${user} +run_app_build ${generated} +quit`);
const r = spawnSync(steamcmd, ['+login', user, '+run_app_build', generated, '+quit'], { stdio: 'inherit' });
process.exit(r.status ?? 1);
