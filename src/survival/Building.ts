// Building: placement mode with a live ghost, grid snapping, validation, demolish, persistence.
//
//   begin(pieceId) → a translucent ghost of the real mesh follows the camera ray (≤ 8 m):
//     green = valid, red = invalid (reason shown in the prompt).
//   attack  → place (consumes the cost)       rotate (R) → 90° for grid pieces / 45° taps & hold-to-spin for free pieces
//   wheel   → fine-rotate free pieces          aim / build / pause → cancel
//   demolish (hold Z) while looking at a piece → remove it, 50 % refund.
//
// Grid pieces snap to a per-building 3 m grid anchored at its first foundation (see Structures.ts).
import * as THREE from 'three';
import type { GameContext, GameState, System } from '../core/types';
import { BUILD_PIECES, PIECE, type BuildPieceDef, type BuildPieceId } from '../core/data';
import { ITEMS, type ItemId } from '../core/Items';
import { Layer, type RayHit } from '../core/Physics';
import { Structures, isWallType, type Group, type Piece, type StructuresSave } from './Structures';
import { buildFoundation, buildWall, buildDoor, buildRoof, buildCampfire, buildBedroll, buildLeanTo, GRID, HALF, COURSE, DOOR_W, type Built } from './Pieces';
import { createGhostMaterial } from './Materials';
import { clamp } from '../core/math';
import { shake } from './util';

const REACH = 8;
const GHOST_OK = new THREE.Color(0x7dffb0);
const GHOST_BAD = new THREE.Color(0xff5a4a);
const UP = new THREE.Vector3(0, 1, 0);
const MAX_STILT = 3.0;
const MAX_BURY = 0.3;

interface Candidate {
  valid: boolean;
  reason: string;
  group: Group | null;
  newGroup?: { ox: number; oz: number; floorY: number; yaw: number };
  key: string | null;
  pos: THREE.Vector3;
  yaw: number;
  normal: THREE.Vector3;
  host: string | null;
  /** Object transform of the ghost (roofs sit at the group origin). */
  ghostPos: THREE.Vector3;
  ghostYaw: number;
  ghostKey: string;
}

const _dir = new THREE.Vector3();
const _o = new THREE.Vector3();
const _p = new THREE.Vector3();

export class Building implements System {
  readonly name = 'building';
  readonly updateWhen: GameState[] = ['playing'];
  readonly pieces: BuildPieceDef[] = BUILD_PIECES;
  placing: BuildPieceId | null = null;
  /** Frame on which placement was cancelled (UI can ignore that frame's Esc/B). */
  cancelledFrame = -1;
  structures!: Structures;

  private ghost: THREE.Mesh;
  private ghostMat: THREE.ShaderMaterial;
  private ghostGeoCache = new Map<string, THREE.BufferGeometry>();
  private ghostKey = '';
  private cand: Candidate | null = null;
  /** Free-piece yaw offset and grid 90° steps. */
  private freeRot = 0;
  private gridRot = 0;
  private rotHeld = 0;
  private demolishT = 0;
  private demolishTarget: Piece | null = null;
  private suppressing = false;

  constructor(private ctx: GameContext) {
    this.ghostMat = createGhostMaterial();
    this.ghost = new THREE.Mesh(new THREE.BufferGeometry(), this.ghostMat);
    this.ghost.visible = false;
    this.ghost.frustumCulled = false;
    this.ghost.renderOrder = 10;
  }

  init() {
    const survival = this.ctx.sys.survival;
    this.structures = new Structures(this.ctx, {
      createFire: (pos, state, onFloor) => survival.fires.create(pos, state, onFloor),
      removeFire: (f) => survival.fires.remove(f),
      bedInteraction: (piece) => survival.sleep.bedInteraction(piece),
    });
    this.ctx.scene.add(this.structures.root, this.ghost);
    this.ctx.events.on('player:died', () => this.cancel());
  }

  reset() {
    this.cancel();
    this.structures?.clear();
    this.freeRot = 0;
    this.gridRot = 0;
  }

  // ---------------------------------------------------------------- public API
  /** Enter placement mode with a ghost preview of the piece. */
  begin(piece: BuildPieceId) {
    if (!PIECE[piece]) return;
    this.placing = piece;
    this.ghostKey = '';
    this.cand = null;
    this.ctx.interact.suppressed = true;
    this.suppressing = true;
    this.ctx.audio.play('ui_click');
  }

  cancel() {
    if (this.placing) this.cancelledFrame = this.ctx.frame;
    this.placing = null;
    this.cand = null;
    this.ghost.visible = false;
    if (this.suppressing) {
      this.ctx.interact.suppressed = false;
      this.suppressing = false;
      this.ctx.ui?.setPrompt(null);
    }
  }

  /** Missing items for a piece (empty = affordable). */
  missing(piece: BuildPieceId): Partial<Record<ItemId, number>> {
    const out: Partial<Record<ItemId, number>> = {};
    const cost = PIECE[piece].cost;
    for (const k in cost) {
      const need = cost[k as ItemId]! - this.ctx.inventory.count(k as ItemId);
      if (need > 0) out[k as ItemId] = need;
    }
    return out;
  }

  canAfford(piece: BuildPieceId) {
    return Object.keys(this.missing(piece)).length === 0;
  }

  /** Current placement validity (for UI hints): null when not placing. */
  get placement(): { valid: boolean; reason: string } | null {
    return this.cand ? { valid: this.cand.valid, reason: this.cand.reason } : null;
  }

  // ---------------------------------------------------------------- frame
  update(dt: number) {
    const { input, ui, player } = this.ctx;
    this.structures.update(dt);
    if (!player.alive) {
      if (this.placing) this.cancel();
      return;
    }
    if (this.placing) {
      if (ui.blocking) {
        this.ghost.visible = false;
        return;
      }
      if (input.pressed('aim') || input.pressed('build') || input.pressed('pause')) {
        this.cancel();
        return;
      }
      this.handleRotation(dt);
      this.cand = this.computeCandidate(this.placing);
      this.updateGhost(this.placing, this.cand);
      if (input.pressed('attack')) this.tryPlace();
    } else {
      this.updateDemolish(dt);
    }
  }

  lateUpdate() {
    const ui = this.ctx.ui;
    if (this.placing && this.cand && !ui.blocking) {
      const def = PIECE[this.placing];
      ui.setPrompt({ action: 'attack', text: this.cand.valid ? `Place ${def.name}` : this.cand.reason, disabled: !this.cand.valid });
    } else if (this.demolishTarget && this.demolishT > 0) {
      ui.setPrompt({ action: 'demolish', text: `Demolish ${PIECE[this.demolishTarget.type].name} (50% refund)`, progress: clamp(this.demolishT / 0.6, 0, 1) });
    }
  }

  private handleRotation(dt: number) {
    const { input } = this.ctx;
    const def = PIECE[this.placing!];
    if (def.placement === 'grid') {
      if (input.pressed('rotate')) {
        this.gridRot = (this.gridRot + 1) % 4;
        this.ctx.audio.play('ui_hover');
      }
      return;
    }
    if (input.pressed('nextSlot')) this.freeRot -= Math.PI / 12;
    if (input.pressed('prevSlot')) this.freeRot += Math.PI / 12;
    if (input.down('rotate')) {
      this.rotHeld += dt;
      if (this.rotHeld > 0.22) this.freeRot += dt * 2.2;
    } else {
      if (input.released('rotate') && this.rotHeld <= 0.22) this.freeRot += Math.PI / 4;
      this.rotHeld = 0;
    }
  }

  // ---------------------------------------------------------------- aiming
  private aimRay(): { origin: THREE.Vector3; dir: THREE.Vector3; hit: RayHit | null } {
    const cam = this.ctx.camera;
    _o.copy(cam.position);
    cam.getWorldDirection(_dir);
    const hit = this.ctx.physics.raycast(_o, _dir, REACH, { mask: Layer.SOLID | Layer.HITTABLE | Layer.WALKABLE });
    return { origin: _o.clone(), dir: _dir.clone(), hit };
  }

  private computeCandidate(type: BuildPieceId): Candidate {
    const def = PIECE[type];
    const { origin, dir, hit } = this.aimRay();
    let c: Candidate;
    if (type === 'foundation') c = this.candFoundation(origin, dir, hit);
    else if (isWallType(type)) c = this.candWall(type, origin, dir, hit);
    else if (type === 'door') c = this.candDoor(origin, dir, hit);
    else if (type === 'roof') c = this.candRoof(origin, dir, hit);
    else c = this.candFree(type, origin, dir, hit);
    if (c.valid && !this.canAfford(type)) {
      c.valid = false;
      c.reason = 'Need ' + this.missingText(type);
    }
    void def;
    return c;
  }

  private missingText(type: BuildPieceId) {
    const m = this.missing(type);
    return Object.entries(m)
      .map(([k, n]) => `${n} ${ITEMS[k as ItemId].name.toLowerCase()}${(n as number) > 1 && !k.endsWith('s') ? 's' : ''}`)
      .join(', ');
  }

  private blank(pos: THREE.Vector3, yaw: number, reason: string): Candidate {
    return { valid: false, reason, group: null, key: null, pos, yaw, normal: UP.clone(), host: null, ghostPos: pos, ghostYaw: yaw, ghostKey: 'none' };
  }

  private playerYaw() {
    return this.ctx.player.yaw;
  }

  /** Aim point on the ground (terrain or floor) along the ray; falls back to ray end → ground. */
  private groundPoint(origin: THREE.Vector3, dir: THREE.Vector3, hit: RayHit | null): THREE.Vector3 {
    if (hit) return hit.point.clone();
    const p = origin.clone().addScaledVector(dir, REACH * 0.8);
    p.y = this.ctx.terrain.heightAt(p.x, p.z);
    return p;
  }

  private ownerPiece(hit: RayHit | null): Piece | null {
    const o = hit?.collider?.owner as Piece | undefined;
    return o && typeof o === 'object' && 'type' in o && this.structures.pieces.get(o.id) === o ? o : null;
  }

  // ---- foundation
  private candFoundation(origin: THREE.Vector3, dir: THREE.Vector3, hit: RayHit | null): Candidate {
    const S = this.structures;
    const owner = this.ownerPiece(hit);
    let group: Group | null = null;
    let ci = 0,
      cj = 0;
    const aim = this.groundPoint(origin, dir, hit);
    if (owner && owner.group && owner.type === 'foundation' && hit) {
      group = owner.group;
      const [oi, oj] = S.parseKey(owner.key!);
      const l = S.toLocal(group, hit.point.x, hit.point.z);
      const fx = l.lx / GRID - oi,
        fz = l.lz / GRID - oj;
      if (Math.abs(fx) >= Math.abs(fz)) {
        ci = oi + Math.sign(fx || 1);
        cj = oj;
      } else {
        ci = oi;
        cj = oj + Math.sign(fz || 1);
      }
    } else {
      group = (owner?.group ?? null) || S.nearestGroup(aim.x, aim.z, 6.5);
      if (group) {
        const l = S.toLocal(group, aim.x, aim.z);
        ci = Math.round(l.lx / GRID);
        cj = Math.round(l.lz / GRID);
      }
    }
    const t = this.ctx.terrain;
    if (group) {
      const pos = S.toWorld(group, ci * GRID, cj * GRID);
      const c: Candidate = { valid: true, reason: '', group, key: S.cellKey(ci, cj), pos, yaw: group.yaw, normal: UP.clone(), host: null, ghostPos: pos, ghostYaw: group.yaw, ghostKey: 'foundation' };
      if (S.hasCell(group, ci, cj)) return this.fail(c, 'A foundation is already here');
      const g = this.groundSpan(pos.x, pos.z, group.yaw);
      if (g.max > group.floorY + MAX_BURY) return this.fail(c, 'Ground too high here');
      if (g.min < group.floorY - MAX_STILT) return this.fail(c, 'Too steep here');
      const block = this.footprintBlocked(pos, group.yaw, HALF + 0.1);
      if (block) return this.fail(c, block);
      return c;
    }
    // A brand new building, aligned to where the player is looking.
    const yaw = this.playerYaw() + (this.gridRot * Math.PI) / 2;
    const span = this.groundSpan(aim.x, aim.z, yaw);
    const floorY = span.max + 0.12;
    const pos = new THREE.Vector3(aim.x, floorY, aim.z);
    const c: Candidate = {
      valid: true,
      reason: '',
      group: null,
      newGroup: { ox: aim.x, oz: aim.z, floorY, yaw },
      key: '0,0',
      pos,
      yaw,
      normal: UP.clone(),
      host: null,
      ghostPos: pos,
      ghostYaw: yaw,
      ghostKey: 'foundation',
    };
    if (!hit || hit.kind !== 'terrain') {
      if (!hit) return this.fail(c, 'Aim at the ground');
      if (hit.kind === 'tree') return this.fail(c, 'Blocked by a tree');
      if (hit.kind === 'rock') return this.fail(c, 'Blocked by a rock');
    }
    if (span.min < floorY - MAX_STILT) return this.fail(c, 'Too steep here');
    if (t.lakeFactor(aim.x, aim.z) > 0.5) return this.fail(c, "Can't build on the ice");
    const block = this.footprintBlocked(pos, yaw, HALF + 0.1);
    if (block) return this.fail(c, block);
    return c;
  }

  /** Min/max terrain height over a 3 m cell footprint. */
  private groundSpan(x: number, z: number, yaw: number) {
    const t = this.ctx.terrain;
    const c = Math.cos(yaw),
      s = Math.sin(yaw);
    let min = Infinity,
      max = -Infinity;
    for (let i = -2; i <= 2; i++)
      for (let j = -2; j <= 2; j++) {
        const lx = (i / 2) * (HALF - 0.1),
          lz = (j / 2) * (HALF - 0.1);
        const h = t.heightAt(x + lx * c + lz * s, z - lx * s + lz * c);
        min = Math.min(min, h);
        max = Math.max(max, h);
      }
    return { min, max };
  }

  /** Trees / rocks / free pieces inside a square footprint (half-size h) → reason or null. */
  private footprintBlocked(pos: THREE.Vector3, yaw: number, h: number): string | null {
    const w = this.ctx.world;
    const c = Math.cos(yaw),
      s = Math.sin(yaw);
    let reason: string | null = null;
    const inside = (x: number, z: number, r: number) => {
      const dx = x - pos.x,
        dz = z - pos.z;
      const lx = dx * c - dz * s,
        lz = dx * s + dz * c;
      return Math.abs(lx) < h + r && Math.abs(lz) < h + r;
    };
    w.forEachTree(pos.x, pos.z, h * 1.5 + 1, (i) => {
      if (inside(w.treeX[i], w.treeZ[i], w.treeRadius(i))) {
        reason = 'Blocked by a tree';
        return true;
      }
    });
    if (reason) return reason;
    w.forEachRock(pos.x, pos.z, h * 1.5, (i) => {
      if (w.rockY[i] + w.rockR[i] > pos.y - 0.2 && inside(w.rockX[i], w.rockZ[i], w.rockR[i] * 0.8)) {
        reason = 'Blocked by a rock';
        return true;
      }
    });
    if (reason) return reason;
    for (const p of this.structures.pieces.values()) {
      if (p.group) continue;
      if (inside(p.pos.x, p.pos.z, 0.6)) return `Blocked by the ${PIECE[p.type].name.toLowerCase()}`;
    }
    return null;
  }

  private fail(c: Candidate, reason: string): Candidate {
    c.valid = false;
    c.reason = reason;
    return c;
  }

  // ---- walls
  private targetGroup(aim: THREE.Vector3, hit: RayHit | null, dist: number): Group | null {
    const owner = this.ownerPiece(hit);
    return owner?.group ?? this.structures.nearestGroup(aim.x, aim.z, dist);
  }

  private candWall(type: BuildPieceId, origin: THREE.Vector3, dir: THREE.Vector3, hit: RayHit | null): Candidate {
    const S = this.structures;
    const aim = this.groundPoint(origin, dir, hit);
    // Looking at a wall face: step back toward the camera so the aim lands on the right edge.
    if (hit && hit.kind === 'collider' && Math.abs(hit.normal.y) < 0.5) aim.addScaledVector(dir, -0.2);
    const group = this.targetGroup(aim, hit, 5);
    if (!group) return this.blank(aim, this.playerYaw(), 'Walls go on a foundation');
    const l = S.toLocal(group, aim.x, aim.z);
    const ci = Math.round(l.lx / GRID),
      cj = Math.round(l.lz / GRID);
    const fx = l.lx / GRID - ci,
      fz = l.lz / GRID - cj;
    let mx: number, mz: number;
    if (Math.abs(fx) >= Math.abs(fz)) {
      mx = 2 * ci + (fx >= 0 ? 1 : -1);
      mz = 2 * cj;
    } else {
      mx = 2 * ci;
      mz = 2 * cj + (fz >= 0 ? 1 : -1);
    }
    const { pos, yaw } = S.edgeTransform(group, mx, mz);
    const isX = mx % 2 === 0;
    const c: Candidate = { valid: true, reason: '', group, key: S.cellKey(mx, mz), pos, yaw, normal: UP.clone(), host: null, ghostPos: pos, ghostYaw: yaw, ghostKey: `${type}:${isX ? 'x' : 'z'}` };
    if (!S.edgeAdjacentToFoundation(group, mx, mz)) return this.fail(c, 'Walls go on a foundation edge');
    const existing = S.edgePiece(group, mx, mz);
    if (existing) return this.fail(c, `A ${PIECE[existing.type].name.toLowerCase()} is already here`);
    if (type !== 'doorway' && this.playerInBox(pos, yaw, HALF, 2.7, 0.2)) return this.fail(c, "You're in the way");
    return c;
  }

  private playerInBox(pos: THREE.Vector3, yaw: number, hx: number, h: number, hz: number) {
    const p = this.ctx.player;
    const dx = p.position.x - pos.x,
      dz = p.position.z - pos.z;
    const c = Math.cos(yaw),
      s = Math.sin(yaw);
    const lx = dx * c - dz * s,
      lz = dx * s + dz * c;
    const r = p.radius;
    return Math.abs(lx) < hx + r && Math.abs(lz) < hz + r && p.position.y < pos.y + h && p.position.y + p.height > pos.y;
  }

  // ---- door
  private candDoor(origin: THREE.Vector3, dir: THREE.Vector3, hit: RayHit | null): Candidate {
    const S = this.structures;
    const aim = this.groundPoint(origin, dir, hit);
    if (hit) aim.copy(hit.point);
    let best: Piece | null = null;
    let bd = 3.2 * 3.2;
    for (const p of S.pieces.values()) {
      if (p.type !== 'doorway' || !p.group) continue;
      const [mx, mz] = S.parseKey(p.key!);
      if (S.doorAt(p.group, mx, mz)) continue;
      _p.copy(p.pos).setY(p.pos.y + 1);
      const d = _p.distanceToSquared(aim);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    if (!best) return this.blank(aim, this.playerYaw(), 'Doors fit into an empty doorway');
    const c: Candidate = { valid: true, reason: '', group: best.group, key: best.key, pos: best.pos.clone(), yaw: best.yaw, normal: UP.clone(), host: null, ghostPos: best.pos.clone(), ghostYaw: best.yaw, ghostKey: 'door' };
    if (this.playerInBox(best.pos, best.yaw, DOOR_W / 2, 2.1, 0.25)) return this.fail(c, "You're standing in the doorway");
    return c;
  }

  // ---- roof
  private candRoof(origin: THREE.Vector3, dir: THREE.Vector3, hit: RayHit | null): Candidate {
    const S = this.structures;
    const p = this.ctx.player.position;
    const aimG = this.groundPoint(origin, dir, hit);
    const group = this.targetGroup(aimG, hit, 9) ?? S.nearestGroup(p.x, p.z, 9);
    if (!group) return this.blank(aimG, this.playerYaw(), 'Roofs go on top of walls');
    // Aim on the wall-top plane (so you can place roofs looking up from inside).
    const planeY = group.floorY + 2.8;
    let aim = aimG;
    if (Math.abs(dir.y) > 1e-3) {
      const t = (planeY - origin.y) / dir.y;
      if (t > 0 && t < 14) aim = origin.clone().addScaledVector(dir, t);
    }
    const l = S.toLocal(group, aim.x, aim.z);
    const ci = Math.round(l.lx / GRID),
      cj = Math.round(l.lz / GRID);
    const pos = S.toWorld(group, ci * GRID, cj * GRID);
    const gpos = new THREE.Vector3(group.ox, group.floorY, group.oz);
    const c: Candidate = { valid: true, reason: '', group, key: S.cellKey(ci, cj), pos, yaw: group.yaw, normal: UP.clone(), host: null, ghostPos: gpos, ghostYaw: group.yaw, ghostKey: `roof:${group.id}:${ci},${cj}:${this.roofSignature(group)}` };
    if (!S.hasCell(group, ci, cj)) return this.fail(c, 'Roofs need a foundation below');
    if (S.hasRoof(group, ci, cj)) return this.fail(c, 'Already roofed');
    const walls = [
      [2 * ci + 1, 2 * cj],
      [2 * ci - 1, 2 * cj],
      [2 * ci, 2 * cj + 1],
      [2 * ci, 2 * cj - 1],
    ].some(([a, b]) => !!S.edgePiece(group, a, b));
    const nbrRoof = S.hasRoof(group, ci + 1, cj) || S.hasRoof(group, ci - 1, cj) || S.hasRoof(group, ci, cj + 1) || S.hasRoof(group, ci, cj - 1);
    if (!walls && !nbrRoof) return this.fail(c, 'Needs a wall to rest on');
    return c;
  }

  private roofSignature(g: Group) {
    let n = 0;
    for (const p of this.structures.pieces.values()) if (p.group === g && (p.type === 'roof' || isWallType(p.type))) n = n * 31 + p.id;
    return n;
  }

  // ---- free pieces
  private candFree(type: BuildPieceId, origin: THREE.Vector3, dir: THREE.Vector3, hit: RayHit | null): Candidate {
    const S = this.structures;
    // Default facing: lean-to opening / bedroll foot toward the player.
    const yaw = this.playerYaw() + this.freeRot;
    if (!hit) {
      const p = this.groundPoint(origin, dir, null);
      return this.blank(p, yaw, 'Aim at the ground');
    }
    const pos = hit.point.clone();
    let normal = hit.normal.clone();
    let host: string | null = null;
    const c: Candidate = { valid: true, reason: '', group: null, key: null, pos, yaw, normal, host: null, ghostPos: pos, ghostYaw: yaw, ghostKey: type };
    const owner = this.ownerPiece(hit);
    if (hit.kind === 'collider') {
      if (!owner || owner.type !== 'foundation' || hit.normal.y < 0.7) return this.fail(c, 'Needs flat ground or a floor');
      normal = UP.clone();
      host = `${owner.group!.id}:${owner.key}`;
      pos.y = owner.group!.floorY;
    } else if (hit.kind === 'tree') return this.fail(c, 'Too close to a tree');
    else if (hit.kind === 'rock') return this.fail(c, 'Blocked by a rock');
    else normal = this.ctx.terrain.normalAt(pos.x, pos.z);
    c.normal = normal;
    c.host = host;
    c.pos = pos;
    c.ghostPos = pos;
    if (normal.y < Math.cos((30 * Math.PI) / 180)) return this.fail(c, 'Too steep');
    const radius = type === 'lean_to' ? 1.7 : type === 'bedroll' ? 1.0 : 0.85;
    const w = this.ctx.world;
    let reason: string | null = null;
    w.forEachTree(pos.x, pos.z, radius + 0.4, (i) => {
      if (Math.hypot(w.treeX[i] - pos.x, w.treeZ[i] - pos.z) < radius * 0.8 + w.treeRadius(i)) {
        reason = 'Too close to a tree';
        return true;
      }
    });
    if (reason) return this.fail(c, reason);
    w.forEachRock(pos.x, pos.z, radius, (i) => {
      const d = Math.hypot(w.rockX[i] - pos.x, w.rockZ[i] - pos.z);
      if (d < radius * 0.7 + w.rockR[i] * 0.85 && w.rockY[i] + w.rockR[i] * 0.6 > pos.y) {
        reason = 'Blocked by a rock';
        return true;
      }
    });
    if (reason) return this.fail(c, reason);
    for (const p of S.pieces.values()) {
      if (p.group) continue;
      const min = radius * 0.6 + (p.type === 'lean_to' ? 1.4 : 0.7);
      if (p.pos.distanceTo(pos) < min) return this.fail(c, `Too close to the ${PIECE[p.type].name.toLowerCase()}`);
    }
    // Walls in the way (floors are fine: we stand on them).
    const hits = this.ctx.physics.overlapSphere(pos.clone().add(new THREE.Vector3(0, 0.6, 0)), radius * 0.55, Layer.SOLID);
    if (hits.some((col) => col.tag !== 'floor')) return this.fail(c, 'Blocked by a wall');
    if (type === 'campfire' && this.ctx.terrain.lakeFactor(pos.x, pos.z) > 0.5) return this.fail(c, 'A fire would melt through the ice');
    return c;
  }

  // ---------------------------------------------------------------- ghost
  private updateGhost(type: BuildPieceId, c: Candidate) {
    const key = c.ghostKey;
    if (key !== this.ghostKey) {
      this.ghostKey = key;
      let geo = this.ghostGeoCache.get(key);
      if (!geo) {
        geo = this.ghostGeometry(type, c);
        // Roof ghosts depend on the building; don't let the cache grow without bound.
        if (!key.startsWith('roof:')) this.ghostGeoCache.set(key, geo);
        else {
          const old = this.ghost.geometry;
          if (old && !Array.from(this.ghostGeoCache.values()).includes(old)) old.dispose();
        }
      }
      this.ghost.geometry = geo;
    }
    const g = this.ghost;
    g.visible = true;
    g.position.copy(c.ghostPos);
    if (PIECE[type].placement === 'free') {
      const k = type === 'lean_to' ? 0.5 : 1;
      const n = new THREE.Vector3().copy(UP).lerp(c.normal, k).normalize();
      g.quaternion.setFromUnitVectors(UP, n).multiply(new THREE.Quaternion().setFromAxisAngle(UP, c.ghostYaw));
    } else {
      g.quaternion.setFromAxisAngle(UP, c.ghostYaw);
    }
    (this.ghostMat.uniforms.uColor.value as THREE.Color).copy(c.valid ? GHOST_OK : GHOST_BAD);
  }

  private ghostGeometry(type: BuildPieceId, c: Candidate): THREE.BufferGeometry {
    let built: Built | null = null;
    switch (type) {
      case 'foundation':
        built = buildFoundation({ groundAt: () => -0.4, nbr: { px: false, nx: false, pz: false, nz: false }, roofed: true, seed: 1 });
        break;
      case 'wall':
      case 'doorway':
      case 'window_wall': {
        const isZ = c.ghostKey.endsWith(':z');
        built = buildWall({ kind: type, offset: isZ ? COURSE / 2 : 0, extA: 0.05, extB: 0.05, capA: true, capB: true, outside: 0, roofed: true, seed: 2, courseSeed: 2, along: 0 });
        break;
      }
      case 'door': {
        // The leaf is built from its hinge: shift it into the doorway.
        const geo = buildDoor(3).geo.toMergedGeometry();
        geo.applyMatrix4(new THREE.Matrix4().makeTranslation(-DOOR_W / 2 + 0.025, 0.02, 0));
        return geo;
      }
      case 'roof': {
        if (!c.group || !c.key) return new THREE.BufferGeometry();
        const [ci, cj] = this.structures.parseKey(c.key);
        built = buildRoof(this.structures.roofContext(c.group, ci, cj, 4, [ci, cj]));
        break;
      }
      case 'campfire':
        built = buildCampfire(5);
        break;
      case 'bedroll':
        built = buildBedroll(6);
        break;
      case 'lean_to':
        built = buildLeanTo(7);
        break;
    }
    return built ? built.geo.toMergedGeometry() : new THREE.BufferGeometry();
  }

  // ---------------------------------------------------------------- place
  private tryPlace() {
    const c = this.cand;
    const type = this.placing!;
    const { ctx } = this;
    if (!c || !c.valid) {
      ctx.audio.play('build_invalid');
      return;
    }
    if (!ctx.inventory.removeAll(PIECE[type].cost)) {
      ctx.audio.play('build_invalid');
      return;
    }
    const S = this.structures;
    let group = c.group;
    if (!group && c.newGroup) group = S.makeGroup(c.newGroup.ox, c.newGroup.oz, c.newGroup.floorY, c.newGroup.yaw);
    const piece = S.add(type, {
      group: PIECE[type].placement === 'grid' ? group : null,
      key: PIECE[type].placement === 'grid' ? c.key : null,
      pos: c.pos,
      yaw: c.yaw,
      normal: c.normal,
      host: c.host,
      seed: Structures.seedFor(c.pos.x + ctx.frame * 0.37, c.pos.z),
    });
    ctx.audio.play('build_place', { position: c.pos });
    const fx = ctx.sys.survival.fx;
    fx.snowBurst(c.pos.x, c.pos.y + 0.1, c.pos.z, type === 'foundation' || type === 'roof' ? 22 : 12, type === 'foundation' ? 3 : 1.5, 1);
    shake(ctx, 0.08);
    ctx.events.emit('structure:placed', { piece: type, id: piece.id });
    this.ghostKey = '';
    // Out of materials → leave build mode so the player isn't stuck with a red ghost.
    if (!this.canAfford(type)) {
      ctx.ui.toast(`Out of materials for ${PIECE[type].name.toLowerCase()}`, 'info');
      this.cancel();
    }
  }

  // ---------------------------------------------------------------- demolish
  private updateDemolish(dt: number) {
    const { input, ui } = this.ctx;
    if (!input.down('demolish') || ui.blocking) {
      if (this.demolishT > 0 || this.demolishTarget) {
        this.demolishT = 0;
        this.demolishTarget = null;
        if (this.suppressing) {
          this.ctx.interact.suppressed = false;
          this.suppressing = false;
          ui.setPrompt(null);
        }
      }
      return;
    }
    const target = this.lookedAtPiece(5);
    if (target !== this.demolishTarget) {
      this.demolishTarget = target;
      this.demolishT = 0;
    }
    if (!target) return;
    if (!this.suppressing) {
      this.ctx.interact.suppressed = true;
      this.suppressing = true;
    }
    this.demolishT += dt;
    if (this.demolishT >= 0.6) {
      this.demolish(target);
      this.demolishT = 0;
      this.demolishTarget = null;
    }
  }

  /** The piece under the crosshair (colliders, or proximity for collider-less free pieces). */
  lookedAtPiece(maxDist: number): Piece | null {
    const cam = this.ctx.camera;
    _o.copy(cam.position);
    cam.getWorldDirection(_dir);
    const hit = this.ctx.physics.raycast(_o, _dir, maxDist, { mask: Layer.SOLID | Layer.HITTABLE | Layer.WALKABLE, trees: false, rocks: false });
    const owner = this.ownerPiece(hit);
    let best: Piece | null = owner;
    let bestD = hit ? hit.distance : maxDist;
    for (const p of this.structures.pieces.values()) {
      if (p.colliders.length && p.type !== 'lean_to') continue;
      _p.copy(p.pos).setY(p.pos.y + 0.25);
      const t = _p.clone().sub(_o).dot(_dir);
      if (t < 0 || t > bestD + 0.5) continue;
      const closest = _o.clone().addScaledVector(_dir, t);
      if (closest.distanceTo(_p) < 0.7 && t < bestD + 0.3) {
        best = p;
        bestD = t;
      }
    }
    return best;
  }

  demolish(p: Piece) {
    const { ctx } = this;
    const removed = this.structures.remove(p);
    const refund: Partial<Record<ItemId, number>> = {};
    for (const r of removed) {
      const cost = PIECE[r.type].cost;
      for (const k in cost) refund[k as ItemId] = (refund[k as ItemId] ?? 0) + Math.floor(cost[k as ItemId]! * 0.5);
      ctx.events.emit('structure:removed', { piece: r.type, id: r.id });
      ctx.sys.survival.fx.snowBurst(r.pos.x, r.pos.y + 0.5, r.pos.z, 14, 1.5, 1.2);
      ctx.sys.survival.fx.chips(r.pos.x, r.pos.y + 1, r.pos.z, 0, 1, 0, 10, true);
    }
    for (const k in refund) if (refund[k as ItemId]! > 0) ctx.inventory.add(k as ItemId, refund[k as ItemId]!);
    ctx.audio.play('build_remove', { position: p.pos });
  }

  // ---------------------------------------------------------------- saves
  serialize(): StructuresSave {
    return this.structures.serialize();
  }

  deserialize(d: StructuresSave) {
    this.cancel();
    this.structures.deserialize(d);
  }
}
