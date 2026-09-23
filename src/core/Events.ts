// Typed event bus. Every cross-system notification goes through here.
import type * as THREE from 'three';
import type { ItemId } from './Items';
import type { BuildPieceId } from './data';
import type { GameState, DamageCause, Species, WeatherKind, AchievementId } from './types';
import type { SettingsData } from './Settings';

export interface GameEvents {
  state: { from: GameState; to: GameState };
  newGame: { seed: number };
  loadedGame: {};
  settings: { key: keyof SettingsData };

  'player:damaged': { amount: number; cause: DamageCause; from?: THREE.Vector3 };
  'player:healed': { amount: number };
  'player:died': { cause: DamageCause };
  'player:respawned': {};
  'player:landed': { impact: number };
  'player:crashed': { speed: number };
  'player:skis': { on: boolean };
  'player:jump': {};

  'tree:hit': { id: number; point: THREE.Vector3; damage: number; tool: ItemId | null };
  'tree:felled': { id: number };
  /** Tree removed from the world (felled & cleaned up, or loaded as removed). Renderers listen. */
  'tree:removed': { id: number };
  'rock:hit': { id: number; point: THREE.Vector3; damage: number; tool: ItemId | null };
  'rock:removed': { id: number };
  'terrain:hit': { point: THREE.Vector3; normal: THREE.Vector3; tool: ItemId | null };

  'item:changed': { item: ItemId; delta: number; total: number };
  'item:crafted': { recipe: string; item: ItemId; count: number };
  'item:consumed': { item: ItemId };
  'equip:changed': { item: ItemId | null };

  'structure:placed': { piece: BuildPieceId; id: number };
  'structure:removed': { piece: BuildPieceId; id: number };
  'fire:lit': { id: number };
  'fire:out': { id: number };
  /** The player stood inside a fully enclosed, roofed shelter for the first time (HOMESTEAD). */
  'shelter:complete': {};

  'animal:killed': { species: Species; by: ItemId | null; id: number };
  'animal:harvested': { species: Species; id: number };

  'day:start': { day: number };
  'night:start': { day: number };
  'weather:changed': { kind: WeatherKind };
  'sleep:start': { hours: number };
  'sleep:end': {};

  achievement: { id: AchievementId };
}

type Handler<T> = (payload: T) => void;

export class EventBus {
  private map = new Map<string, Set<Handler<any>>>();

  on<K extends keyof GameEvents>(type: K, fn: Handler<GameEvents[K]>): () => void {
    let set = this.map.get(type);
    if (!set) this.map.set(type, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  once<K extends keyof GameEvents>(type: K, fn: Handler<GameEvents[K]>): () => void {
    const off = this.on(type, (p) => {
      off();
      fn(p);
    });
    return off;
  }

  emit<K extends keyof GameEvents>(type: K, payload: GameEvents[K]): void {
    const set = this.map.get(type);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[events] handler for "${type}" threw`, err);
      }
    }
  }
}
