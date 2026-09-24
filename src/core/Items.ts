// Item definitions + the player's inventory and hotbar.
import type { EventBus } from './Events';

export type ItemId =
  | 'log'
  | 'stick'
  | 'stone'
  | 'hide'
  | 'raw_meat'
  | 'cooked_meat'
  | 'cloth'
  | 'bandage'
  | 'hatchet'
  | 'spear'
  | 'bow'
  | 'arrow'
  | 'torch'
  | 'crampons'
  | 'ice_axe';

export type ItemKind = 'resource' | 'food' | 'medical' | 'tool' | 'weapon' | 'ammo' | 'light';

export interface ItemDef {
  id: ItemId;
  name: string;
  kind: ItemKind;
  stack: number; // max stack size (1 = unique tool)
  description: string;
  /** Equippable in the hand (shows a viewmodel). */
  equip?: boolean;
  /** Food: satiety restored (0..100 scale). */
  food?: number;
  /** Medical/food health restored. */
  heal?: number;
  /** Warmth restored when eaten (hot food). */
  warmth?: number;
  weight: number; // kg, for flavour / future encumbrance
}

export const ITEMS: Record<ItemId, ItemDef> = {
  log: { id: 'log', name: 'Log', kind: 'resource', stack: 20, weight: 6, description: 'Split timber. Builds walls, roofs and fires.' },
  stick: { id: 'stick', name: 'Stick', kind: 'resource', stack: 60, weight: 0.3, description: 'Kindling and handles.' },
  stone: { id: 'stone', name: 'Stone', kind: 'resource', stack: 40, weight: 1, description: 'Hearth rings and sharp edges.' },
  hide: { id: 'hide', name: 'Hide', kind: 'resource', stack: 10, weight: 1.5, description: 'Warm, tough, and a bit smelly.' },
  raw_meat: { id: 'raw_meat', name: 'Raw meat', kind: 'food', stack: 10, weight: 0.5, food: 12, description: 'Cook it first if you can.' },
  cooked_meat: { id: 'cooked_meat', name: 'Cooked meat', kind: 'food', stack: 10, weight: 0.4, food: 38, heal: 8, warmth: 10, description: 'Hot, filling, restores a little health.' },
  cloth: { id: 'cloth', name: 'Cloth', kind: 'resource', stack: 20, weight: 0.1, description: 'Torn from a spare shirt.' },
  bandage: { id: 'bandage', name: 'Bandage', kind: 'medical', stack: 10, weight: 0.1, heal: 30, description: 'Stops the bleeding.' },
  hatchet: { id: 'hatchet', name: 'Hatchet', kind: 'tool', stack: 1, weight: 1.2, equip: true, description: 'Chops trees, splits stone, and bites wolves.' },
  spear: { id: 'spear', name: 'Spear', kind: 'weapon', stack: 1, weight: 1.5, equip: true, description: 'Hold to aim, release to throw. Retrieve it after.' },
  bow: { id: 'bow', name: 'Hunting bow', kind: 'weapon', stack: 1, weight: 1, equip: true, description: 'Hold to draw. Needs arrows.' },
  arrow: { id: 'arrow', name: 'Arrow', kind: 'ammo', stack: 30, weight: 0.05, description: 'Stone-tipped. Recoverable.' },
  crampons: { id: 'crampons', name: 'Crampons', kind: 'tool', stack: 1, weight: 0.9, description: 'Stone spikes lashed to your boots. Walk up steep snow and ice without slipping.' },
  ice_axe: { id: 'ice_axe', name: 'Ice axe', kind: 'tool', stack: 1, weight: 0.8, description: 'Swing it into the slope and haul yourself up. Lets you climb the steepest faces (tiring).' },
  torch: { id: 'torch', name: 'Torch', kind: 'light', stack: 5, weight: 0.4, equip: true, description: 'Light and warmth. Wolves keep their distance.' },
};

export const HOTBAR_SIZE = 6;

export interface InventorySnapshot {
  items: Partial<Record<ItemId, number>>;
  hotbar: (ItemId | null)[];
  selected: number;
}

export class Inventory {
  private counts = new Map<ItemId, number>();
  hotbar: (ItemId | null)[] = new Array(HOTBAR_SIZE).fill(null);
  /** Selected hotbar slot, or -1 for empty hands. */
  selected = -1;

  constructor(private events: EventBus) {}

  count(id: ItemId): number {
    return this.counts.get(id) ?? 0;
  }

  has(id: ItemId, n = 1): boolean {
    return this.count(id) >= n;
  }

  /** Adds items; returns how many were actually added. Equippables auto-slot into the hotbar. */
  add(id: ItemId, n = 1): number {
    if (n <= 0) return 0;
    const cur = this.count(id);
    const cap = ITEMS[id].stack * (ITEMS[id].stack === 1 ? 1 : 99); // effectively unlimited stacks, uniques capped at 1
    const added = Math.min(n, cap - cur);
    if (added <= 0) return 0;
    this.counts.set(id, cur + added);
    if ((ITEMS[id].equip || ITEMS[id].kind === 'food' || ITEMS[id].kind === 'medical') && !this.hotbar.includes(id)) {
      const free = this.hotbar.indexOf(null);
      if (free >= 0) this.hotbar[free] = id;
    }
    this.events.emit('item:changed', { item: id, delta: added, total: cur + added });
    return added;
  }

  /** Removes items if available; returns false (and removes nothing) if not enough. */
  remove(id: ItemId, n = 1): boolean {
    const cur = this.count(id);
    if (cur < n) return false;
    const next = cur - n;
    if (next === 0) this.counts.delete(id);
    else this.counts.set(id, next);
    if (next === 0) {
      const slot = this.hotbar.indexOf(id);
      // Consumables leave the bar when used up; tools stay (they can't be used up anyway).
      if (slot >= 0) {
        this.hotbar[slot] = null;
        if (slot === this.selected) this.select(-1);
      }
    }
    this.events.emit('item:changed', { item: id, delta: -n, total: next });
    return true;
  }

  hasAll(cost: Partial<Record<ItemId, number>>): boolean {
    for (const k in cost) if (!this.has(k as ItemId, cost[k as ItemId]!)) return false;
    return true;
  }

  removeAll(cost: Partial<Record<ItemId, number>>): boolean {
    if (!this.hasAll(cost)) return false;
    for (const k in cost) this.remove(k as ItemId, cost[k as ItemId]!);
    return true;
  }

  /** Item currently in hand (null = empty hands / ski poles). */
  get equipped(): ItemId | null {
    if (this.selected < 0) return null;
    const id = this.hotbar[this.selected];
    return id && this.has(id) ? id : null;
  }

  select(slot: number) {
    const prev = this.equipped;
    this.selected = slot >= 0 && slot < HOTBAR_SIZE && this.hotbar[slot] ? slot : -1;
    const next = this.equipped;
    if (prev !== next) this.events.emit('equip:changed', { item: next });
  }

  /** Toggle a slot: selecting the active slot again returns to empty hands. */
  toggle(slot: number) {
    this.select(this.selected === slot ? -1 : slot);
  }

  cycle(dir: 1 | -1) {
    const filled = this.hotbar.map((h, i) => (h ? i : -1)).filter((i) => i >= 0);
    if (!filled.length) return this.select(-1);
    const order = [-1, ...filled];
    const idx = order.indexOf(this.selected);
    const next = order[(idx + dir + order.length) % order.length];
    this.select(next);
  }

  entries(): [ItemId, number][] {
    return Array.from(this.counts.entries());
  }

  clear() {
    this.counts.clear();
    this.hotbar = new Array(HOTBAR_SIZE).fill(null);
    this.selected = -1;
  }

  snapshot(): InventorySnapshot {
    return { items: Object.fromEntries(this.counts) as InventorySnapshot['items'], hotbar: [...this.hotbar], selected: this.selected };
  }

  restore(s: InventorySnapshot) {
    this.counts = new Map(Object.entries(s.items) as [ItemId, number][]);
    this.hotbar = [...s.hotbar];
    while (this.hotbar.length < HOTBAR_SIZE) this.hotbar.push(null);
    this.selected = s.selected;
  }
}

/** What the player spawns with. */
export const STARTING_KIT: Partial<Record<ItemId, number>> = {
  hatchet: 1,
  cloth: 3,
  cooked_meat: 2,
  stick: 4,
};
