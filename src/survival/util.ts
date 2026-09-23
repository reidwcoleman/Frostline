// Small helpers for optional cross-agent APIs (graceful fallbacks when a system lacks them).
import type * as THREE from 'three';
import type { GameContext } from '../core/types';
import { Layer } from '../core/Physics';

/** Camera shake via the player module if it exposes `shake(amount)`. */
export function shake(ctx: GameContext, amount: number) {
  const p = ctx.sys.player as unknown as { shake?: (a: number) => void };
  if (amount > 0 && typeof p?.shake === 'function') p.shake(amount * ctx.settings.data.cameraShake);
}

interface AnimalLike {
  species?: string;
  alive?: boolean;
  dead?: boolean;
  state?: string;
  position?: THREE.Vector3;
}

/**
 * Is a live wolf within `r` of `p`? Uses `ctx.sys.wildlife.threatNear(pos, r)` if the wildlife
 * module provides it, otherwise scans ENTITY colliders whose owner looks like a wolf.
 */
export function wolfNear(ctx: GameContext, p: THREE.Vector3, r: number): boolean {
  const w = ctx.sys.wildlife as unknown as { threatNear?: (p: THREE.Vector3, r: number) => boolean };
  if (typeof w?.threatNear === 'function') return w.threatNear(p, r);
  const r2 = r * r;
  for (const c of ctx.physics.all()) {
    if (!c.enabled || (c.layers & Layer.ENTITY) === 0) continue;
    const o = c.owner as AnimalLike | undefined;
    if (!o || o.species !== 'wolf' || o.alive === false || o.dead === true || o.state === 'dead') continue;
    if (c.position.distanceToSquared(p) < r2) return true;
  }
  return false;
}
