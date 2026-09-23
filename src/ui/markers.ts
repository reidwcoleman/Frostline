// Points of interest for the compass strip and the map. Structures and fires live in the
// survival agent's systems; we read them defensively (duck-typed) so the UI never breaks
// if their internals change — the bedroll (respawn point) and spawn come from core state.
import type { GameContext } from '../core/types';

export type MarkerKind = 'fire' | 'bed' | 'cabin' | 'spawn';
export interface Marker {
  kind: MarkerKind;
  x: number;
  z: number;
  label: string;
}

interface Posish {
  x?: number;
  z?: number;
  position?: { x: number; z: number };
  pos?: { x: number; z: number } | [number, number, number];
}

function xz(o: Posish | null | undefined): [number, number] | null {
  if (!o) return null;
  if (o.position && typeof o.position.x === 'number') return [o.position.x, o.position.z];
  if (Array.isArray(o.pos)) return [o.pos[0], o.pos[2]];
  if (o.pos && typeof (o.pos as { x: number }).x === 'number') return [(o.pos as { x: number }).x, (o.pos as { z: number }).z];
  if (typeof o.x === 'number' && typeof o.z === 'number') return [o.x, o.z];
  return null;
}

function listOf(v: unknown): unknown[] {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (v instanceof Map) return Array.from(v.values());
  if (v instanceof Set) return Array.from(v);
  return [];
}

export function collectMarkers(ctx: GameContext): Marker[] {
  const out: Marker[] = [];
  const [sx, sz] = ctx.terrain.data.spawn;
  out.push({ kind: 'spawn', x: sx, z: sz, label: 'Crash site' });

  const rp = ctx.player.respawnPoint;
  if (rp) out.push({ kind: 'bed', x: rp.x, z: rp.z, label: 'Bedroll' });

  // Structures: find anything array-like on the building system that has positions.
  const b = ctx.sys.building as unknown as Record<string, unknown>;
  const st = b?.structures as Record<string, unknown> | undefined;
  const pieces = [st?.pieces, b?.structures, b?.placed, b?.instances].flatMap(listOf) as (Posish & { piece?: string; kind?: string; type?: string; lit?: boolean })[];
  // Cabins: cluster foundations/walls into one marker per ~12 m.
  const cabins: [number, number][] = [];
  for (const p of pieces) {
    const at = xz(p);
    if (!at) continue;
    const kind = p.piece ?? p.kind ?? p.type ?? '';
    if (kind === 'campfire') out.push({ kind: 'fire', x: at[0], z: at[1], label: 'Campfire' });
    else if (kind === 'bedroll') {
      if (!rp || Math.hypot(rp.x - at[0], rp.z - at[1]) > 3) out.push({ kind: 'bed', x: at[0], z: at[1], label: 'Bedroll' });
    } else if (kind === 'foundation' || kind === 'wall' || kind === 'roof' || kind === 'lean_to' || kind === 'doorway') {
      if (!cabins.some(([cx, cz]) => Math.hypot(cx - at[0], cz - at[1]) < 14)) cabins.push(at);
    }
  }
  for (const [x, z] of cabins) out.push({ kind: 'cabin', x, z, label: 'Shelter' });

  // Fires may also be tracked by survival.
  const s = ctx.sys.survival as unknown as Record<string, unknown>;
  const fm = s?.fires as Record<string, unknown> | unknown[] | undefined;
  const fires = Array.isArray(fm) ? fm : listOf((fm as Record<string, unknown> | undefined)?.fires);
  for (const f of fires as Posish[]) {
    const at = xz(f);
    if (at && !out.some((m) => m.kind === 'fire' && Math.hypot(m.x - at[0], m.z - at[1]) < 2)) out.push({ kind: 'fire', x: at[0], z: at[1], label: 'Campfire' });
  }
  return out;
}

export const MARKER_ICON: Record<MarkerKind, string> = { fire: 'campfire', bed: 'bedroll', cabin: 'house', spawn: 'flag' };
