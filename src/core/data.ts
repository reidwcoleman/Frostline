// Crafting recipes and buildable pieces (data only; logic lives in src/survival).
import type { ItemId } from './Items';

export interface Recipe {
  id: string;
  name: string;
  out: ItemId;
  count: number;
  cost: Partial<Record<ItemId, number>>;
  /** Requires standing near a lit fire. */
  needsFire?: boolean;
  seconds: number; // craft time
}

export const RECIPES: Recipe[] = [
  { id: 'spear', name: 'Spear', out: 'spear', count: 1, cost: { stick: 3, stone: 1 }, seconds: 2 },
  { id: 'bow', name: 'Hunting bow', out: 'bow', count: 1, cost: { stick: 4, hide: 1 }, seconds: 4 },
  { id: 'arrows', name: 'Arrows ×4', out: 'arrow', count: 4, cost: { stick: 2, stone: 1 }, seconds: 2 },
  { id: 'torch', name: 'Torch', out: 'torch', count: 1, cost: { stick: 1, cloth: 1 }, seconds: 1 },
  { id: 'bandage', name: 'Bandage', out: 'bandage', count: 1, cost: { cloth: 2 }, seconds: 1.5 },
  { id: 'cook', name: 'Cook meat', out: 'cooked_meat', count: 1, cost: { raw_meat: 1 }, needsFire: true, seconds: 3 },
];

export type BuildPieceId =
  | 'campfire'
  | 'bedroll'
  | 'lean_to'
  | 'foundation'
  | 'wall'
  | 'doorway'
  | 'window_wall'
  | 'door'
  | 'roof';

export interface BuildPieceDef {
  id: BuildPieceId;
  name: string;
  description: string;
  cost: Partial<Record<ItemId, number>>;
  /** 'free' = anywhere on ground; 'grid' = snaps to the 3m building grid / other pieces. */
  placement: 'free' | 'grid';
  /** Shelter contribution when the player is inside/under it. */
  shelter: number;
}

/** Building grid spacing in meters. Foundations are GRID x GRID, walls GRID wide x 3m tall. */
export const BUILD_GRID = 3;

export const BUILD_PIECES: BuildPieceDef[] = [
  { id: 'campfire', name: 'Campfire', description: 'Warmth, light and cooking. Burns logs and sticks.', cost: { stick: 4, stone: 4 }, placement: 'free', shelter: 0 },
  { id: 'bedroll', name: 'Bedroll', description: 'Sleep through the night. Sets your respawn point.', cost: { hide: 2, stick: 2 }, placement: 'free', shelter: 0 },
  { id: 'lean_to', name: 'Lean-to', description: 'A quick windbreak of logs and boughs.', cost: { log: 3, stick: 6 }, placement: 'free', shelter: 0.55 },
  { id: 'foundation', name: 'Log foundation', description: 'Level floor for a cabin. Snaps to the grid.', cost: { log: 4 }, placement: 'grid', shelter: 0.05 },
  { id: 'wall', name: 'Log wall', description: 'Keeps the wind out.', cost: { log: 4 }, placement: 'grid', shelter: 0.2 },
  { id: 'doorway', name: 'Doorway', description: 'A wall with an opening for a door.', cost: { log: 3 }, placement: 'grid', shelter: 0.12 },
  { id: 'window_wall', name: 'Window wall', description: 'A wall with a small shuttered window.', cost: { log: 3 }, placement: 'grid', shelter: 0.16 },
  { id: 'door', name: 'Door', description: 'Fits a doorway. Wolves cannot open it.', cost: { log: 2, stick: 2 }, placement: 'grid', shelter: 0.1 },
  { id: 'roof', name: 'Roof', description: 'Pitched log roof panel.', cost: { log: 3, stick: 4 }, placement: 'grid', shelter: 0.3 },
];

export const PIECE = Object.fromEntries(BUILD_PIECES.map((p) => [p.id, p])) as Record<BuildPieceId, BuildPieceDef>;
