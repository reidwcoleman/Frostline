# Frostline — Steam achievements & stats

Enter these on the Steamworks partner site → **App Admin → Stats & Achievements**, then **Publish** (Publish tab).
The **API names are exactly our `AchievementId` strings** (`src/core/types.ts`); display text mirrors
`src/platform/achievementData.ts` — keep all three in sync. Unlock logic lives in `src/platform/Achievements.ts`.

Icons: `npm run steam:icons` renders `steam/achievements/icons/<API_NAME>.jpg` (achieved) and
`<API_NAME>_locked.jpg` (unachieved), 256×256 JPG, ready to upload.

## Achievements (16)

| API name | Display name | Description | Hidden | Progress stat | Unlocks when |
|---|---|---|---|---|---|
| `FIRST_NIGHT` | First Light | Survive your first night on the mountain. | no | — | `day:start` with day ≥ 2 |
| `SURVIVE_3` | Settling In | Reach day 3. | no | — | day ≥ 3 |
| `SURVIVE_7` | A Week Above the Treeline | Reach day 7. | no | — | day ≥ 7 |
| `SURVIVE_30` | Frostline | Reach day 30. | no | — | day ≥ 30 |
| `FIRST_FIRE` | Kindling | Light a campfire. | no | — | `fire:lit` |
| `TIMBER` | Timber! | Fell a tree. | no | — | first `tree:felled` |
| `LUMBERJACK` | Lumberjack | Fell 50 trees. | no | `trees_felled` 0 → 50 | lifetime trees felled ≥ 50 |
| `HOMESTEAD` | Homestead | Build a fully enclosed shelter. | no | — | `shelter:complete`, or indoors + fire/full shelter for 5 s |
| `HUNTER` | Hunter | Take down a deer. | no | — | `animal:killed` species deer |
| `WOLF_SLAYER` | Wolf Slayer | Kill a wolf. | no | — | first wolf killed |
| `PACK_BREAKER` | Pack Breaker | Kill 10 wolves. | no | `wolves_killed` 0 → 10 | lifetime wolves ≥ 10 |
| `SPEED_DEMON` | Speed Demon | Reach 100 km/h on skis. | no | — | ≥ 27.78 m/s on skis for 0.25 s |
| `BIG_AIR` | Big Air | Stay airborne for 3 seconds. | no | — | `player.airTime` ≥ 3 s |
| `SUMMIT` | Summit | Stand on the highest point of the range. | no | — | within 30 m of the highest peak (highest local maximum ≥ 150 m from the world edge that tops everything within 120 m; recomputed from the terrain each boot) |
| `COLD_SNAP` | Cold Snap | Weather a blizzard out in the open. | **yes** | — | alive through a whole blizzard (≥ 45 s), ≥ 75 % of it outdoors |
| `CHEF` | Camp Cook | Cook meat over a fire. | no | — | `item:crafted` recipe `cook` |

Rules: dev runs with `?fly=1` or `?god=1` never unlock anything. Unlocks earned while Steam was offline are kept in
`saves/profile.json` and pushed to Steam on the next launch with Steam running.

## Stats (5, all INT)

steamworks.js 0.4 exposes INT stats only. Create each as **INT**, "Set by: Client", **Increment only** ✓,
Default 0, and leave **Max change** empty: progress earned offline is pushed in one go on the next Steam
launch, and a max-change limit would reject it.

| API name | Display name | Notes |
|---|---|---|
| `days_survived` | Longest run (days) | Highest day number reached in one run (only ever grows) |
| `trees_felled` | Trees felled | Progress stat for `LUMBERJACK` |
| `wolves_killed` | Wolves killed | Progress stat for `PACK_BREAKER` |
| `deer_killed` | Deer hunted | |
| `distance_skied` | Distance skied (m) | Integrated from player movement on skis, pushed in 25 m chunks every ~20 s |

For the two progress achievements, set **Progress Stat** to the stat above with min 0 / max 50 (or 10) so the
Steam client shows "12 / 50".
