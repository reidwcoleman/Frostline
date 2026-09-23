# Frostline — architecture & team rules

**Frostline** is a first-person alpine survival game for Steam. You are stranded in a ring of mountains
with skis, a hatchet and the cold. Ski, hunt, chop, build a cabin, survive as many days as you can.
Tagline: *Ski. Hunt. Build. Outlast the cold.*

Stack: **TypeScript + three.js (r186, WebGL2) + Vite 8**, shipped as an **Electron** app with
**steamworks.js**. Everything is procedural — no downloaded models or textures. `postprocessing` and
`n8ao` are installed for the post stack. Fonts: `@fontsource/instrument-serif`, `@fontsource/barlow-semi-condensed`.

## Pillars (what "really, really good" means here)
1. **The mountain is the star.** Terrain, light and snow must look gorgeous at every time of day.
2. **Skiing feels incredible.** Speed, carving, air, crashes — physical, readable, fast (target 60 fps).
3. **Survival is simple but tense.** Cold, hunger, night, wolves. Fire and shelter are relief.
4. **Tight scope.** Skis, hatchet, spear, bow, torch. Campfire, bedroll, lean-to, log cabin. That's it.

## Art direction — "stylized naturalism"
- Firewatch's colour grading + The Long Dark's stylised realism + SSX's crisp snow.
- **Warm sun, cool shadows**: snow in sun is warm white (#F4F1EA), in shadow it is sky-blue (#9DB4D9).
- Strong **aerial perspective**: distant ridges fade to blue/lavender haze. Golden hour is amber (#FFB36B).
- Snow **sparkles** (view-dependent glints), has wind-sculpted micro detail, soft subsurface feel.
- Rock only on steep faces: dark grey-brown (#4A4A52) with snow caught on ledges.
- Spruce forests: deep blue-green (#1F3A33) with snow-laden boughs; trees sway in the wind.
- Nights are deep blue (moonlit), starry, with **aurora** on clear nights. Fire is the only warm light.
- One UI accent: **signal-flare orange #FF6A2B**. Semantic ice-blue only for cold/warmth.

## Directory ownership (only edit files you own)
| Area | Owner | Paths |
|---|---|---|
| Core engine & contracts | lead | `src/core/**`, `src/main.ts`, `docs/ARCHITECTURE.md` |
| Terrain, vegetation, rocks, snow trails, terrain gen | world agent | `src/render/**`, `src/world/**` |
| Sky, lighting, weather, fog, post-processing | atmosphere agent | `src/atmosphere/**` |
| Player movement, skiing physics, camera, first-person body | player agent | `src/player/**` |
| Weapons, projectiles, wildlife | combat agent | `src/combat/**`, `src/wildlife/**` |
| Survival vitals, harvesting, crafting, building, fires | survival agent | `src/survival/**` |
| HUD, menus, map, audio, music, menu camera | UI agent | `src/ui/**`, `src/audio/**`, `index.html` |
| Electron, Steam, saves, achievements, packaging | platform agent | `electron/**`, `steam/**`, `src/platform/**`, `package.json`, `README.md`, `docs/STEAM.md`, `build/**` |

- The placeholder file in your area is yours: **rewrite it completely**. Keep the exported class name and the
  `constructor(ctx: GameContext)` signature (Game.ts constructs it). Add as many files as you like inside your dirs.
- **Core files (`src/core/**`)**: you may make small *additive* edits when you truly need a contract change
  (a new event in `GameEvents`, a new `SoundId`, a new field on `PlayerState`/`EnvState`). Use the Edit tool
  (never rewrite a core file), keep it backwards-compatible, and list every such edit in your final report.
- **Never run `npm install`** or edit `package.json` (platform agent only). Need a package? Say so in your report.
- **Never** `git commit`, `git checkout`, `git stash` or `git reset`. The lead commits.
- Don't edit another agent's files. If you depend on something they own, use the documented API below, write
  a graceful fallback, and mention it in your report.

## Runtime model
- `src/core/Game.ts` boots: renderer → systems constructed → terrain generated in a worker (IndexedDB cached)
  → `World.generate()` (trees, rocks) → `Physics` → each system's `init()` → state `menu` (or `playing` with `?skipMenu=1`).
- **Constructors must not touch `ctx.terrain`, `ctx.world` or `ctx.physics`** (they don't exist yet). Use `init()`.
- States: `boot → menu → playing ⇄ paused → dead`. Each system declares `updateWhen` (default `['playing']`).
- Per-frame order: input → clock → `update(dt)` of every system in order (platform, weather, sky, menuCam, player,
  weapons, wildlife, survival, crafting, building, terrain, vegetation, snowTrails, post, audio, ui, save)
  → interactions → `lateUpdate(dt)` → `ctx.sys.post.render(dt)` (the atmosphere agent owns the render call).
- `dt` is clamped to 0.1 s. Everything must be frame-rate independent (use `damp()` from `core/math`).
- Systems also implement optional `reset()` (new game / before load), `serialize()` / `deserialize()` (saves),
  `resize(w, h)`.

## The context (`ctx: GameContext`, see `src/core/types.ts`)
| Field | What |
|---|---|
| `renderer`, `scene`, `camera` | three.js objects. Camera is added to the scene; `camera.rotation.order = 'YXZ'`. near 0.1, far = quality.viewDistance |
| `terrain` | `heightAt(x,z)` (the ground truth), `normalAt`, `slopeAngle`, `surfaceAt` ('snow'/'ice'/'rock'), `lakeFactor`, `flowAt` (creeks), `raycast`, `data` (heights, lakeMask, flow, spawn, lakeCenter, lakeLevel). World is 4096 m square centred on 0; heights ~135–1420 m |
| `world` | trees & boulders in typed arrays (`treeX/Y/Z/Scale/Rot/Type/Alive/Health`, `rockX/Y/Z/R/...`), `forEachTree(x,z,r,fn)`, `forEachRock`, `nearestTree`, `treeHeight(i)`, `treeRadius(i)`, `removeTree(i)` (emits `tree:removed`) |
| `physics` | `raycast(origin, dir, maxDist, opts)` → `{kind:'terrain'|'tree'|'rock'|'collider', point, normal, index, collider}`; `addBox/addSphere/addCapsule(..., layers, owner, tag)`, `updateCollider(c)`, `remove(c)`, `overlapSphere`, `resolveCapsule(feet, r, h)`, `groundProbe(x, y, z)`. Layers: `SOLID`, `HITTABLE`, `WALKABLE`, `ENTITY`, `INTERACT` |
| `player` | `PlayerState`: position (feet), velocity, yaw/pitch, heading, mode, onSkis, vitals (health/warmth/satiety/stamina 0..100), feltTemperature, shelter, nearFire, stats, `damage()`, `heal()` |
| `inventory` | counts, hotbar (6 slots), `equipped`, `add/remove/has/hasAll/removeAll/select/cycle` |
| `interact` | `add({position, radius, label(), onInteract(), holdTime?, enabled?(), blockedReason?()})` → returns remover. Core shows the prompt and fires on E |
| `snow` | `stamp({x,z,dirX,dirZ,width,length,depth,kind})` — ski tracks, footprints, paw prints, body craters |
| `env` | `EnvState` written by atmosphere: sunDir, sunColor, daylight, fogColor, baseTemperature (+`temperatureAt(y)`), wind (m/s vector), windStrength, snowfall, visibility, weather |
| `clock` | `time` (hour 0–24), `day`, `isNight`, `setTime`, `advance(hours)`, `timeScale`, emits `day:start` / `night:start` |
| `events` | typed bus, see `GameEvents` in `src/core/Events.ts` |
| `input` | `down/pressed/released(action)`, `move()`, `look(dt)`, `trigger()`, `label(action)` for key caps, gamepad supported |
| `settings` | `data` (fov, sensitivity, volumes, quality...) + `quality` profile (`QUALITY` table in `core/Settings.ts`) |
| `audio` | `play(id, {position, volume, pitch})`, `loop(id, opts)` → handle. Ids are the `SoundId` union in `core/types.ts` |
| `ui` | `setPrompt`, `toast`, `hitMarker`, `damageFlash`, `bigTitle`, `showScreen`, `blocking` (true while a menu owns input) |
| `platform` | achievements, stats, save read/write, fullscreen, quit |
| `sys` | every concrete system, e.g. `ctx.sys.sky.acquireLight()`, `ctx.sys.player.rightHand` |
| `dev` | URL params: `skipMenu`, `pos=x,z`, `yaw`, `pitch` (deg), `time`, `freeze`, `weather`, `skis`, `seed`, `nocache`, `fly`, `god` |

### Cross-agent APIs (keep these names)
- **Light pool** (atmosphere): `ctx.sys.sky.acquireLight(): LightHandle | null` → `{ light: THREE.PointLight, release() }`.
  A fixed pool (no shader recompiles). Fires, torches and flares use it. Never add your own PointLights.
- **Viewmodel anchors** (player): `ctx.sys.player.viewmodel` (Group on the camera), `rightHand`, `leftHand`.
  Combat attaches weapon models to `rightHand` (bow to `leftHand`). The player module owns skis, poles, arms, and
  hides the right pole whenever `ctx.inventory.equipped !== null`.
- **Tree mesh** (world): `ctx.sys.vegetation.createTreeMesh(type, scale): THREE.Object3D` — a standalone copy of a
  forest tree (origin at trunk base) for the felling animation.
- **Crafting** (survival): `ctx.sys.crafting.recipes`, `missing(id)`, `canCraft(id)`, `craft(id)`, `progress`, `nearFire()`.
- **Building** (survival): `ctx.sys.building.pieces`, `begin(pieceId)`, `cancel()`, `placing`.
- **Survival** (survival): `ctx.sys.survival.consume(itemId)`.
- **Saves** (platform): `ctx.sys.save.hasSave()`, `save()`, `load()`. Game provides `collectSave()` / `applySave()`.
- **Game** (core): `ctx.game.newGame()`, `pause()`, `resume()`, `quitToMenu()`, `respawn()`, `setCursorFree(bool)`
  (UI calls it when opening/closing inventory-style screens during play), `state`.

### Gameplay flow of a hit
Combat raycasts with `ctx.physics.raycast`. Tree → `events.emit('tree:hit', {id, point, damage, tool})`
(survival handles chopping/felling/logs). Rock → `'rock:hit'` (survival gives stone). Collider whose `owner`
is an animal → combat applies damage directly. Terrain → `'terrain:hit'` (snow puff).

## Quality & performance
- Target **60 fps at 1080p on an Apple M1 at `high`**, and `medium`/`low` for Steam Deck-class hardware.
- Read your knobs from `ctx.settings.quality` (`QUALITY` in `core/Settings.ts`) and react to the `settings` event.
- Budget (high): ≤ 900 draw calls, ≤ 3 M triangles, no per-frame allocations in hot loops, no shader recompiles
  during play (fixed light pool, no toggling `castShadow`/defines at runtime), no hitches > 8 ms (build meshes
  incrementally; spread work across frames).
- Use `InstancedMesh`/merged geometry. Dispose what you remove. Share materials.
- Shadows: the atmosphere agent owns the sun + shadow cascades. Set `castShadow`/`receiveShadow` on your meshes.
- Fog: the atmosphere agent installs a global fog (scene.fog + shader chunk overrides). Your materials must keep
  `fog: true` (default for built-in materials; for ShaderMaterial include the fog chunks + `fog: true`).
- Colour pipeline: linear workflow, `SRGBColorSpace` output, tone mapping in the post stack.
  Use `MeshStandardMaterial` / `MeshPhysicalMaterial` (optionally extended via `onBeforeCompile`) so lighting,
  shadows and fog stay consistent. Keep albedo values physically plausible (fresh snow ~0.85–0.9 linear, not 1.0).

## Testing (everyone must look at their work)
- Dev server (already running): **http://127.0.0.1:5317/** — don't start another one.
- `npx tsc --noEmit` — must pass for your files. Errors in someone else's in-progress files are not yours to fix.
- **Screenshots** (each call launches its own headless Chrome on the real GPU — safe in parallel):
  `node tools/shot.mjs --q "skipMenu=1&pos=X,Z&yaw=DEG&pitch=DEG&time=17.5&freeze=1" --out shots/<you>/<name>.png`
  Add `--eval "<js>"` to script the scene (`fl` is the Game; e.g. `--eval "fl.ctx.player.onSkis=true"`),
  `--wait ms`, `--w/--h`, `--logs`. Then **Read the PNG and judge it critically**. Iterate until it looks great.
- `node tools/mapshot.mjs --out shots/map.png` — top-down map of the world (terrain, lake, trees, rocks, spawn).
- Useful spots on seed 42: spawn is by the lake (`fl.ctx.terrain.data.spawn`); find others with
  `--eval "..."` queries against `fl.ctx.terrain`.
- For motion/gameplay, drive it from `--eval`: set velocities, call methods, advance with
  `await new Promise(r=>setTimeout(r,2000))` inside the eval, then capture.
- Write screenshots to `shots/<your-area>/` (gitignored).

## Code style
- Strict TypeScript, no `any` unless at a boundary. Small focused files. Comments explain *why*.
- Match the existing style (2 spaces, single quotes, semicolons). No new global singletons; use `ctx`.
- Frame-rate independent maths. Reuse temp vectors in hot paths.
