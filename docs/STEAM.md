# Shipping Frostline on Steam

This is the end-to-end guide: from this repo to a live Steam page. The code side is done; the steps marked
**you** need a human with the Steamworks account.

- [1. How the desktop build works](#1-how-the-desktop-build-works)
- [2. Commands](#2-commands)
- [3. One-time Steamworks setup](#3-one-time-steamworks-setup)
- [4. Depots and launch options](#4-depots-and-launch-options)
- [5. Steam Cloud](#5-steam-cloud)
- [6. Achievements and stats](#6-achievements-and-stats)
- [7. Steam Deck checklist](#7-steam-deck-checklist)
- [8. Build → upload → set live](#8-build--upload--set-live)
- [9. Store page](#9-store-page)
- [10. macOS signing and notarisation](#10-macos-signing-and-notarisation)
- [11. Saves, logs and data](#11-saves-logs-and-data)
- [12. Troubleshooting](#12-troubleshooting)

---

## 1. How the desktop build works

```
electron/main.cjs        main process: window, app:// protocol, CSP, IPC, before-quit handshake, logging
electron/preload.cjs     window.frostlineNative bridge (sandboxed, context-isolated, validated)
electron/steam.cjs       steamworks.js: init, overlay, achievements, INT stats (fully guarded)
electron/saves.cjs       atomic save files + .bak, per-slot write queue
electron/window-state.cjs  userData/window.json (fullscreen, windowed size/position)
src/platform/Platform.ts   renderer platform layer: native bridge or web (localStorage) fallback
src/platform/SaveSystem.ts autosave, versioned saves + migrate(), .bak fallback, death policy
src/platform/Achievements.ts  event/state watchers → unlocks + lifetime stats
```

- **The page is served from `app://frostline/`**, a privileged custom scheme (standard, secure, fetch, CORS,
  streaming), not `file://`. The page gets a real origin, so ES-module workers (terrain generation),
  IndexedDB (terrain cache) and localStorage (settings) behave exactly as on the web. The CSP travels with each
  response: `script-src 'self'`, `worker-src 'self' blob:`, `style-src 'self' 'unsafe-inline'`, no remote origins.
- **Renderer security:** `contextIsolation`, `sandbox`, no `nodeIntegration`; navigation off-origin is blocked
  and links open in the OS browser; only pointer-lock/fullscreen permissions are granted; IPC handlers reject
  calls from any other origin and validate every argument (slot names `[a-z0-9_-]{1,32}`, 16 MB cap).
- **Electron fuses** (release builds): RunAsNode, NODE_OPTIONS and `--inspect` are off, the app loads only
  from `app.asar`, and `file://` gets no extra privileges.
- **Performance switches:** discrete GPU forced, GPU rasterisation, GPU blocklist ignored, no background
  throttling (`backgroundThrottling: false`), audio autoplay allowed. Vsync stays on: `rAF` runs at the
  display's refresh rate. `FROSTLINE_UNCAPPED=1` uncaps it for benchmarking only.
- **Window:** dark `#0b1016` background (no white flash), shown on `ready-to-show`, fullscreen on first launch.
  **F11** (and **Alt+Enter** on Windows/Linux) toggles fullscreen; the in-game setting stays in sync both ways.
  The last windowed size and position are remembered in `userData/window.json`.
- **Steam is optional at runtime.** No steamworks.js, no Steam client, no ownership: the game runs and saves
  normally, and achievements are kept locally (then pushed to Steam on the next Steam launch).

## 2. Commands

| What | Command |
|---|---|
| Web dev (browser) | `npm run dev` → http://127.0.0.1:5317 |
| Desktop dev (Electron + Vite HMR) | `npm run electron:dev` (reuses a running dev server or starts one) |
| Desktop, production bundle, unpackaged | `npm run electron:start` |
| Type-check + bundle | `npm run build` |
| Package: this OS | `npm run dist` · fast unpacked only: `npm run dist:dir` |
| Package: macOS (universal dmg + dir) | `npm run dist:mac` → `release/mac-universal/Frostline.app` |
| Package: Windows (dir + NSIS) | `npm run dist:win` → `release/win-unpacked/Frostline.exe` |
| Package: Linux (dir + AppImage) | `npm run dist:linux` → `release/linux-unpacked/frostline` |
| End-to-end smoke test | `npm run smoke` (unpackaged) or `npm run smoke -- --app <binary>` |
| App icons | `npm run icons` (build/icon.*, electron/assets, steam/store/assets) |
| Achievement icons | `npm run steam:icons` (steam/achievements/icons) |
| Prepare/upload a Steam build | `npm run steam:upload` / `npm run steam:upload -- --run` |

Useful flags for the desktop app: `--no-steam`, `--devtools`, `--frostline-query=skipMenu=1&time=17`,
env `FROSTLINE_USER_DATA=/tmp/profile` (throwaway profile), `FROSTLINE_STEAM_OVERLAY=1` (overlay on macOS).

Cross-building: macOS can produce the Windows `dir` and Linux `dir` targets. Build the NSIS installer on
Windows (or with Wine), and code-sign each OS on that OS. CI with one runner per OS is the long-term answer.

## 3. One-time Steamworks setup

1. **(you) Join Steamworks.** https://partner.steamgames.com: sign the distribution agreement, complete the
   tax and bank forms, and pay the Steam Direct fee (USD 100 per app, recoupable). Wait for the App ID.
2. **(you) Put the App ID in three places:**
   - `package.json` → `"frostline": { "steamAppId": <APP_ID> }`: baked into release builds, used by
     `restartAppIfNecessary` (a copy started outside Steam relaunches through Steam).
   - `steam/steam_appid.txt`: dev runs only (`electron .` / `electron:dev`). Keep `480` (Spacewar) until you
     have your own ID, then switch so achievements show up for your app while testing.
   - `steam/scripts/app_build.vdf` → `"AppID"`.
   `steam_appid.txt` is **never shipped**: it isn't in the packaged files, and the depot scripts exclude it.
   When Steam launches the game, it sets `SteamAppId` itself.
3. **(you) Create depots** (SteamPipe → Depots): one per OS, usually App ID +1 / +2 / +3. Put the IDs into
   `steam/scripts/app_build.vdf` and the three `depot_build_*.vdf` files. Set each depot's OS filter
   (Windows / macOS / Linux + SteamOS), then **Publish**.
4. **(you) Launch options** (Installation → General): see the table below. **Publish.**
5. **(you) Stats & achievements:** see §6.
6. **(you) Steam Cloud:** see §5.
7. **(you) Build account:** create a separate Steam account for uploads, with only the "Edit App
   Metadata" and "Publish App Changes To Steam" permissions, and set up Steam Guard for it.

## 4. Depots and launch options

| OS | Build output (ContentRoot) | Launch executable | Arguments | Notes |
|---|---|---|---|---|
| Windows 64-bit | `release/win-unpacked/` | `Frostline.exe` | — | Steam overlay on. `steam_api64.dll` sits beside the addon inside `resources/app.asar.unpacked/`. |
| macOS | `release/mac-universal/` | `Frostline.app` | — | Universal (Apple silicon + Intel). Upload from a Mac so symlinks inside the Electron framework survive. |
| Linux + SteamOS | `release/linux-unpacked/` | `frostline` | `--no-sandbox` | The Steam Linux Runtime container can't use Chromium's setuid sandbox. Content isolation, context isolation and the CSP still apply. |

Steamworks.js native binaries are unpacked from the asar (`asarUnpack`); each OS build carries only its own
binaries. Keep a Linux depot, or skip it and let Steam Deck run the Windows depot through Proton. Both work;
native Linux starts faster, Proton has the better-tested Chromium GPU path. Test both on a Deck (§7) before
you pick.

## 5. Steam Cloud

Saves are small JSON files, so use **Auto-Cloud** (Steamworks → Application → Steam Cloud). No code required:

1. **Byte quota** 50 MB, **file count** 50 (a save is < 1 MB).
2. **Root paths:** add one path:
   | Root | Subdirectory | Pattern | OS | Recursive |
   |---|---|---|---|---|
   | `WinAppDataRoaming` | `Frostline/saves` | `*.json` | All OSes | no |
3. **Root overrides** (so one entry covers all platforms):
   | Original root | OS | New root | Add/replace path |
   |---|---|---|---|
   | `WinAppDataRoaming` | macOS | `MacAppSupport` | *(none)* |
   | `WinAppDataRoaming` | Linux + SteamOS | `LinuxXdgConfigHome` | *(none)* |
4. **Save** and **Publish.**

That maps to Electron's `userData` on each OS:
Windows `%APPDATA%\Frostline\saves`, macOS `~/Library/Application Support/Frostline/saves`,
Linux `~/.config/Frostline/saves`. The pattern `*.json` syncs `slot1.json` (the run) and `profile.json`
(achievements and lifetime stats), but not `*.json.bak` or `*.json.tmp`. Steam's own dialog handles sync
conflicts. Test by saving on one machine and continuing on another.

## 6. Achievements and stats

The full table (API names, display names, descriptions, hidden flags, stats, progress links) is in
**`steam/achievements.md`**. Achievement API names are exactly our `AchievementId` strings.

1. **(you)** App Admin → Stats & Achievements → **Stats:** create the 5 INT stats (`days_survived`,
   `trees_felled`, `wolves_killed`, `deer_killed`, `distance_skied`).
2. **(you)** **Achievements:** create the 16 achievements. For `LUMBERJACK` set Progress stat
   `trees_felled` 0 → 50, and for `PACK_BREAKER` `wolves_killed` 0 → 10. Hide `COLD_SNAP`.
3. **(you)** Upload the icons from `steam/achievements/icons/`: `<API>.jpg` as achieved, `<API>_locked.jpg` as
   unachieved. Regenerate them with `npm run steam:icons`.
4. **(you)** **Publish.** Stats and achievements aren't visible to the client until they are published.
5. Test with your real App ID in `steam/steam_appid.txt` and Steam running: `npm run electron:start`,
   then unlock one (e.g. light a fire). Reset from the Steam console if needed:
   `steam://open/console` → `reset_all_stats <appid>`.

Runtime behaviour: unlocks are idempotent and written to `saves/profile.json` right away. With Steam, the app
calls `SetAchievement` + `StoreStats` immediately (Steam draws the popup); stats are pushed every ~20 s and
on quit. Without Steam, an in-game toast shows instead, and the unlock syncs to Steam on the next Steam launch.
Dev URLs with `?fly=1` / `?god=1` never unlock anything.

**Overlay:** enabled on Windows/Linux (`electronEnableSteamOverlay`, which uses in-process GPU and disables
direct composition). macOS overlay support in Electron is unreliable, so it is off there unless
`FROSTLINE_STEAM_OVERLAY=1` is set. The overlay only appears when the game is launched by Steam.

## 7. Steam Deck checklist

Valve's Deck Verified review checks input, display, seamlessness and system support. For Frostline:

- [ ] **Input:** full gamepad support, with on-screen glyphs that match the controller (Steam Input reports
      a Deck as an Xbox pad). No keyboard-only screens; name entry is not needed.
- [ ] **Default controller config:** Steamworks → Steam Input → "Gamepad with Camera Controls" (or a
      custom config). Set "Uses Steam Input API: No" (the game reads the standard Gamepad API).
- [ ] **Display:** 1280×800 (16:10) with no cut-off UI; minimum text size ~9 px at 1280×800 (the UI
      agent's HUD scales with the viewport).
- [ ] **Performance:** first launch on Deck seeds the `medium` preset (see `electron/preload.cjs`); target a
      steady 60 fps. If it dips, lower renderScale to 0.85 or use `low`.
- [ ] **Seamlessness:** starts in fullscreen, with no launcher and no external browser; quitting from the menu
      exits cleanly and saves first (before-quit handshake).
- [ ] **Sleep/resume:** suspend mid-run, resume, and check that audio and rendering come back (Chromium
      handles this; test anyway).
- [ ] **Native Linux vs Proton:** test both; if the native build has any GPU issue, drop the Linux depot and
      let Proton run the Windows build.
- [ ] **Cloud:** save on Deck, continue on desktop (§5).
- [ ] Submit for review in Steamworks → Steam Deck Compatibility.

## 8. Build → upload → set live

```bash
# 1. Bump the version in package.json (shown in logs and the build description)
# 2. Build every OS you ship (the mac build on a Mac, the win installer/signing on Windows)
npm run dist:mac        # release/mac-universal/Frostline.app
npm run dist:win        # release/win-unpacked/
npm run dist:linux      # release/linux-unpacked/
# 3. Smoke-test each package on its own OS
npm run smoke -- --app release/mac-universal/Frostline.app/Contents/MacOS/Frostline
# 4. Prepare the SteamPipe build (checks IDs, skips depots that weren't built, writes release/steam/*.vdf)
npm run steam:upload
# 5. Upload (steamcmd prompts for the password + Steam Guard once, then caches the login)
STEAM_BUILD_USER=your_build_account npm run steam:upload -- --run --setlive beta
```

6. **(you)** Steamworks → SteamPipe → **Builds**: the new build appears (on the `beta` branch if you used
   `--setlive beta`). Install it through the Steam client (Properties → Betas), then play it on every OS
   and on a Deck.
7. **(you)** When it's good, **Set build live on `default`**. That is what players get.
8. Before the very first release: **Store page review** and **Build review** (Valve, usually 1–5 business
   days each), then the **release button** (the page must have been "Coming Soon" for ≥ 2 weeks).

`--preview` runs Valve's side as a dry run (checks file mappings, uploads nothing).

## 9. Store page

`steam/store/` has the kit: `short_description.txt` (223/300 chars), `about_this_game.txt` (Steam markup,
paste as-is), and `store_page.md` (tags, system requirements incl. Steam Deck notes, every graphical asset
size). Generated icons are in `steam/store/assets/`. **(you)** need to make the capsule art, trailer and
screenshots (capture real gameplay with `npm run shot`).

## 10. macOS signing and notarisation

Steam doesn't require notarisation (downloads through Steam aren't quarantined), and electron-builder
ad-hoc-signs local builds so they run on Apple silicon. For a signed release (recommended; required
outside Steam):

1. Get an Apple Developer ID Application certificate and put it in the keychain.
2. In `package.json` → `build.mac`, set `"hardenedRuntime": true` (the entitlements in
   `build/entitlements.mac.plist` already allow JIT, the unsigned steamworks addon and Steam's overlay
   injection) and add `"notarize": true`.
3. Export `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, then run `npm run dist:mac`.

Local builds for testing: `CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac` skips keychain lookups.

## 11. Saves, logs and data

| What | Where (inside `userData`) |
|---|---|
| Current run | `saves/slot1.json` (atomic: `.tmp` → fsync → rename) |
| Previous good save | `saves/slot1.json.bak` (used automatically if the current file is corrupt) |
| Achievements + lifetime stats | `saves/profile.json` |
| Window prefs | `window.json` |
| Logs (main + renderer warnings/errors) | `logs/main.log` (rotated at 2 MB) |
| Settings, terrain cache | Chromium localStorage / IndexedDB for origin `app://frostline` |

`userData` = `%APPDATA%\Frostline` · `~/Library/Application Support/Frostline` · `~/.config/Frostline`.
Dev runs use `Frostline Dev` so they never touch a real install.

**When the game saves:** every 120 s of play, at dawn, after sleeping, when pausing or quitting to the menu,
on respawn, and before the window closes. Main asks the renderer to flush (`app:before-quit`), waits for it
(max ~4 s), then exits. On the web build the fallback is `beforeunload` → localStorage.

**Death policy:** the save is kept but marked `dead`. "Continue" is offered only if the player can respawn
(a bedroll set their respawn point); they then wake at the bedroll. Without one, the run is over and New Game
starts fresh. This stops quit-before-dying save scumming and keeps the bedroll meaningful.
`ctx.sys.save.summary()` gives the menu what it needs (`canContinue`, `day`, `dead`, `fromBackup`).

**Versioning:** saves carry `version` (= `SAVE_VERSION` in `src/core/Game.ts`). When that constant is bumped,
add a step to `MIGRATIONS` in `src/platform/SaveSystem.ts`. A save from a *newer* build is never loaded or
overwritten: it is copied to `slot1-v<N>.json` first.

## 12. Troubleshooting

| Symptom | Fix |
|---|---|
| `[steam] Steam not available (...)` in `logs/main.log` | Expected without the Steam client. With Steam running: check the App ID, that the account owns the app (or use 480), and that the Steam client matches the OS/arch. |
| Achievements don't pop | Stats & Achievements must be **published**; the overlay needs a launch through Steam (Windows/Linux). |
| Game relaunches through Steam when double-clicked | Intended for release builds (`restartAppIfNecessary`). For local testing put `steam_appid.txt` next to the executable or set `FROSTLINE_NO_STEAM_RESTART=1`. |
| Linux: "The SUID sandbox helper binary was found, but is not configured correctly" | Add launch argument `--no-sandbox` (§4). |
| Black window / low fps | Check `logs/main.log` for GPU process crashes; `chrome://gpu` via `--devtools`. Try `--use-angle=gl` (Linux) or updating GPU drivers. |
| Save won't load | The game falls back to `.bak` automatically and shows a toast. Both files are plain JSON in `saves/`. |
