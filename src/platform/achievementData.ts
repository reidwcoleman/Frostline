// Achievement + stat definitions. The ids are the Steam API names 1:1 (steam/achievements.md mirrors this
// table for the Steamworks partner site). UI may import ACHIEVEMENTS for display names.
import type { AchievementId } from '../core/types';

export interface AchievementDef {
  name: string;
  description: string;
  /** Hidden on Steam until unlocked. */
  hidden: boolean;
  /** Progress stat (Steam "progress stat" link), if any. */
  progress?: { stat: StatId; max: number };
}

export const ACHIEVEMENTS: Record<AchievementId, AchievementDef> = {
  FIRST_NIGHT: { name: 'First Light', description: 'Survive your first night on the mountain.', hidden: false },
  SURVIVE_3: { name: 'Settling In', description: 'Reach day 3.', hidden: false },
  SURVIVE_7: { name: 'A Week Above the Treeline', description: 'Reach day 7.', hidden: false },
  SURVIVE_30: { name: 'Frostline', description: 'Reach day 30.', hidden: false },
  FIRST_FIRE: { name: 'Kindling', description: 'Light a campfire.', hidden: false },
  TIMBER: { name: 'Timber!', description: 'Fell a tree.', hidden: false },
  LUMBERJACK: { name: 'Lumberjack', description: 'Fell 50 trees.', hidden: false, progress: { stat: 'trees_felled', max: 50 } },
  HOMESTEAD: { name: 'Homestead', description: 'Build a fully enclosed shelter.', hidden: false },
  HUNTER: { name: 'Hunter', description: 'Take down a deer.', hidden: false },
  WOLF_SLAYER: { name: 'Wolf Slayer', description: 'Kill a wolf.', hidden: false },
  PACK_BREAKER: { name: 'Pack Breaker', description: 'Kill 10 wolves.', hidden: false, progress: { stat: 'wolves_killed', max: 10 } },
  SPEED_DEMON: { name: 'Speed Demon', description: 'Reach 100 km/h on skis.', hidden: false },
  BIG_AIR: { name: 'Big Air', description: 'Stay airborne for 3 seconds.', hidden: false },
  SUMMIT: { name: 'Summit', description: 'Stand on the highest point of the range.', hidden: false },
  COLD_SNAP: { name: 'Cold Snap', description: 'Weather a blizzard out in the open.', hidden: true },
  CHEF: { name: 'Camp Cook', description: 'Cook meat over a fire.', hidden: false },
};

export const ACHIEVEMENT_IDS = Object.keys(ACHIEVEMENTS) as AchievementId[];

/** Lifetime INT stats (Steam stat API names). */
export type StatId = 'days_survived' | 'trees_felled' | 'wolves_killed' | 'deer_killed' | 'distance_skied';

export const STATS: Record<StatId, { name: string; description: string; kind: 'increment' | 'max' }> = {
  days_survived: { name: 'Longest run (days)', description: 'Highest day number reached in a single run.', kind: 'max' },
  trees_felled: { name: 'Trees felled', description: 'Trees felled across all runs.', kind: 'increment' },
  wolves_killed: { name: 'Wolves killed', description: 'Wolves killed across all runs.', kind: 'increment' },
  deer_killed: { name: 'Deer hunted', description: 'Deer killed across all runs.', kind: 'increment' },
  distance_skied: { name: 'Distance skied (m)', description: 'Meters travelled on skis across all runs.', kind: 'increment' },
};

export const STAT_IDS = Object.keys(STATS) as StatId[];
