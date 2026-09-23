// Everything the player has built: building groups (a 3 m grid anchored to the group's first
// foundation), the pieces on it (foundations on cells, walls on edges, roofs over cells, doors in
// doorways) and free pieces (campfire, bedroll, lean-to). Owns meshes, physics colliders, door
// animation and interactables; rebuilds neighbours when the topology changes so corners interlock,
// rims close up and the roof re-forms as one gable.
//
// Grid addressing (per group, in group-local metres):
//   cell (ci, cj)   centre (ci*3, cj*3), spans ±1.5
//   edge (mx, mz)   "doubled" coords of the edge midpoint = (mx*1.5, mz*1.5):
//                   X-edge (runs along X): mx even, mz odd.  Z-edge: mx odd, mz even.
//   vertex (vx, vz) both odd.
import * as THREE from 'three';
import type { GameContext } from '../core/types';
import type { BuildPieceId } from '../core/data';
import type { Collider } from '../core/Physics';
import type { Fire, FireSave } from './Fires';
import {
  buildFoundation,
  buildWall,
  buildRoof,
  buildDoor,
  buildCampfire,
  buildBedroll,
  buildLeanTo,
  COURSE,
  CORNER_OH,
  GRID,
  HALF,
  DOOR_W,
  EAVE_OH,
  GABLE_OH,
  DECK_T,
  type Built,
  type WallKind,
} from './Pieces';
import { disposeTree } from './Geo';
import { mat, releaseMat, interiorUniforms, MAX_INTERIORS } from './Materials';
import { hash2, damp } from '../core/math';

export interface Group {
  id: number;
  ox: number;
  oz: number;
  floorY: number;
  yaw: number;
  cos: number;
  sin: number;
}

export interface DoorState {
  open: boolean;
  angle: number;
  pivot: THREE.Group;
  sign: number;
}

export interface Piece {
  id: number;
  type: BuildPieceId;
  group: Group | null;
  /** Cell "ci,cj" (foundation/roof) or edge "mx,mz" (walls/doors). */
  key: string | null;
  /** Object position (world). */
  pos: THREE.Vector3;
  yaw: number;
  /** Ground normal for free pieces. */
  normal: THREE.Vector3;
  flip: boolean;
  /** Free pieces standing on a foundation: `${groupId}:${cell}`. */
  host: string | null;
  seed: number;
  object: THREE.Group;
  colliders: Collider[];
  removers: (() => void)[];
  fire: Fire | null;
  door: DoorState | null;
}

export interface PieceSave {
  type: BuildPieceId;
  g: number | null;
  key: string | null;
  p: [number, number, number];
  yaw: number;
  n: [number, number, number];
  flip: boolean;
  host: string | null;
  seed: number;
  fire?: FireSave;
  open?: boolean;
}

export interface StructuresSave {
  groups: { id: number; ox: number; oz: number; floorY: number; yaw: number }[];
  pieces: PieceSave[];
}

export const WALL_TYPES: BuildPieceId[] = ['wall', 'doorway', 'window_wall'];
export const isWallType = (t: BuildPieceId) => t === 'wall' || t === 'doorway' || t === 'window_wall';

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

export interface StructureHooks {
  createFire(pos: THREE.Vector3, state?: FireSave, onFloor?: boolean): Fire;
  removeFire(f: Fire): void;
  bedInteraction(piece: Piece): () => void;
}

export class Structures {
  readonly groups = new Map<number, Group>();
  readonly pieces = new Map<number, Piece>();
  private cells = new Map<string, Piece>();
  private edges = new Map<string, Piece>();
  private roofs = new Map<string, Piece>();
  private doors = new Map<string, Piece>();
  readonly root = new THREE.Group();
  private queue: Piece[] = [];
  private nextPiece = 1;
  private nextGroup = 1;

  constructor(private ctx: GameContext, private hooks: StructureHooks) {
    this.root.name = 'structures';
  }

  // ---------------------------------------------------------------- coordinates
  makeGroup(ox: number, oz: number, floorY: number, yaw: number, id?: number): Group {
    const g: Group = { id: id ?? this.nextGroup++, ox, oz, floorY, yaw, cos: Math.cos(yaw), sin: Math.sin(yaw) };
    this.nextGroup = Math.max(this.nextGroup, g.id + 1);
    this.groups.set(g.id, g);
    return g;
  }

  toWorld(g: Group, lx: number, lz: number, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(g.ox + lx * g.cos + lz * g.sin, g.floorY, g.oz - lx * g.sin + lz * g.cos);
  }

  toLocal(g: Group, x: number, z: number): { lx: number; lz: number } {
    const dx = x - g.ox,
      dz = z - g.oz;
    return { lx: dx * g.cos - dz * g.sin, lz: dx * g.sin + dz * g.cos };
  }

  cellKey(ci: number, cj: number) {
    return `${ci},${cj}`;
  }
  parseKey(k: string): [number, number] {
    const [a, b] = k.split(',').map(Number);
    return [a, b];
  }
  private gk(g: Group, k: string) {
    return `${g.id}:${k}`;
  }

  hasCell(g: Group, ci: number, cj: number) {
    return this.cells.has(this.gk(g, this.cellKey(ci, cj)));
  }
  hasRoof(g: Group, ci: number, cj: number) {
    return this.roofs.has(this.gk(g, this.cellKey(ci, cj)));
  }
  edgePiece(g: Group, mx: number, mz: number): Piece | undefined {
    return this.edges.get(this.gk(g, this.cellKey(mx, mz)));
  }
  doorAt(g: Group, mx: number, mz: number): Piece | undefined {
    return this.doors.get(this.gk(g, this.cellKey(mx, mz)));
  }
  foundationAt(g: Group, ci: number, cj: number): Piece | undefined {
    return this.cells.get(this.gk(g, this.cellKey(ci, cj)));
  }

  /** Cells on either side of an edge. */
  edgeCells(mx: number, mz: number): [[number, number], [number, number]] {
    if (mx % 2 === 0)
      return [
        [mx / 2, (mz - 1) / 2],
        [mx / 2, (mz + 1) / 2],
      ];
    return [
      [(mx - 1) / 2, mz / 2],
      [(mx + 1) / 2, mz / 2],
    ];
  }

  edgeAdjacentToFoundation(g: Group, mx: number, mz: number) {
    const [a, b] = this.edgeCells(mx, mz);
    return this.hasCell(g, a[0], a[1]) || this.hasCell(g, b[0], b[1]);
  }

  /** World transform for an edge piece: midpoint and yaw. */
  edgeTransform(g: Group, mx: number, mz: number): { pos: THREE.Vector3; yaw: number } {
    const pos = this.toWorld(g, mx * HALF, mz * HALF);
    const isX = mx % 2 === 0;
    return { pos, yaw: g.yaw + (isX ? 0 : Math.PI / 2) };
  }

  forEachGroupPiece(g: Group, fn: (p: Piece) => void) {
    for (const p of this.pieces.values()) if (p.group === g) fn(p);
  }

  /** Nearest group having a foundation cell centre within `maxDist` (horizontal) of (x, z). */
  nearestGroup(x: number, z: number, maxDist: number): Group | null {
    let best: Group | null = null;
    let bd = maxDist * maxDist;
    for (const p of this.cells.values()) {
      const dx = p.pos.x - x,
        dz = p.pos.z - z;
      const d = dx * dx + dz * dz;
      if (d < bd) {
        bd = d;
        best = p.group;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- add / remove
  add(
    type: BuildPieceId,
    o: { group?: Group | null; key?: string | null; pos: THREE.Vector3; yaw: number; normal?: THREE.Vector3; flip?: boolean; host?: string | null; seed?: number },
    restore?: { fire?: FireSave; open?: boolean },
    deferNeighbours = false,
  ): Piece {
    const piece: Piece = {
      id: this.nextPiece++,
      type,
      group: o.group ?? null,
      key: o.key ?? null,
      pos: o.pos.clone(),
      yaw: o.yaw,
      normal: (o.normal ?? UP).clone(),
      flip: !!o.flip,
      host: o.host ?? null,
      seed: o.seed ?? Math.floor(Math.random() * 100000),
      object: new THREE.Group(),
      colliders: [],
      removers: [],
      fire: null,
      door: null,
    };
    this.pieces.set(piece.id, piece);
    const g = piece.group;
    if (g && piece.key) {
      const k = this.gk(g, piece.key);
      if (type === 'foundation') this.cells.set(k, piece);
      else if (type === 'roof') this.roofs.set(k, piece);
      else if (type === 'door') this.doors.set(k, piece);
      else if (isWallType(type)) this.edges.set(k, piece);
    }
    this.root.add(piece.object);
    if (type === 'door') {
      piece.door = { open: !!restore?.open, angle: restore?.open ? 1.7 : 0, pivot: new THREE.Group(), sign: 1 };
    }
    this.build(piece);
    this.attachBehaviour(piece, restore);
    if (g && !deferNeighbours) this.markGroupDirty(g, piece);
    return piece;
  }

  /** Remove a piece and whatever depended on it. Returns every removed piece. */
  remove(piece: Piece): Piece[] {
    const removed: Piece[] = [];
    const kill = (p: Piece) => {
      if (!this.pieces.has(p.id)) return;
      this.pieces.delete(p.id);
      removed.push(p);
      const g = p.group;
      if (g && p.key) {
        const k = this.gk(g, p.key);
        if (p.type === 'foundation') this.cells.delete(k);
        else if (p.type === 'roof') this.roofs.delete(k);
        else if (p.type === 'door') this.doors.delete(k);
        else if (isWallType(p.type)) this.edges.delete(k);
      }
      this.destroyVisual(p);
      for (const r of p.removers) r();
      p.removers.length = 0;
      if (p.fire) {
        this.hooks.removeFire(p.fire);
        releaseMat('ash', `fire${p.id}`);
        releaseMat('charred', `fire${p.id}`);
        p.fire = null;
      }
      this.root.remove(p.object);
    };
    kill(piece);
    const g = piece.group;
    if (g) {
      // Cascade: walls with no foundation, roofs over missing cells, doors in missing doorways,
      // free pieces standing on a removed floor.
      for (const p of [...this.pieces.values()]) {
        if (p.group === g && p.key) {
          const [a, b] = this.parseKey(p.key);
          if (isWallType(p.type) && !this.edgeAdjacentToFoundation(g, a, b)) kill(p);
          else if (p.type === 'roof' && !this.hasCell(g, a, b)) kill(p);
        }
      }
      for (const p of [...this.pieces.values()]) {
        if (p.type === 'door' && p.group === g && p.key) {
          const [a, b] = this.parseKey(p.key);
          const e = this.edgePiece(g, a, b);
          if (!e || e.type !== 'doorway') kill(p);
        }
        if (p.host && removed.some((r) => r.type === 'foundation' && r.group && p.host === `${r.group.id}:${r.key}`)) kill(p);
      }
      let any = false;
      for (const p of this.cells.values()) if (p.group === g) any = true;
      if (!any) this.groups.delete(g.id);
      else this.markGroupDirty(g);
    }
    return removed;
  }

  clear() {
    for (const p of [...this.pieces.values()]) {
      this.destroyVisual(p);
      for (const r of p.removers) r();
      if (p.fire) {
        this.hooks.removeFire(p.fire);
        releaseMat('ash', `fire${p.id}`);
        releaseMat('charred', `fire${p.id}`);
      }
      this.root.remove(p.object);
    }
    this.pieces.clear();
    this.cells.clear();
    this.edges.clear();
    this.roofs.clear();
    this.doors.clear();
    this.groups.clear();
    this.queue.length = 0;
    this.nextGroup = 1;
    interiorUniforms.uBldN.value = 0;
  }

  markGroupDirty(g: Group, except?: Piece) {
    for (const p of this.pieces.values()) {
      if (p.group !== g || p === except || p.type === 'door') continue;
      if (!this.queue.includes(p)) this.queue.push(p);
    }
  }

  // ---------------------------------------------------------------- building meshes
  private destroyVisual(p: Piece) {
    for (const c of p.colliders) this.ctx.physics.remove(c);
    p.colliders.length = 0;
    for (const ch of [...p.object.children]) {
      if (p.door && ch === p.door.pivot) {
        for (const d of [...p.door.pivot.children]) {
          disposeTree(d);
          p.door.pivot.remove(d);
        }
        continue;
      }
      disposeTree(ch);
      p.object.remove(ch);
    }
  }

  /** (Re)build mesh + colliders for a piece from the current topology. */
  build(p: Piece) {
    this.destroyVisual(p);
    const built = this.construct(p);
    if (!built) return;
    const variant = p.type === 'campfire' ? { ash: `fire${p.id}`, charred: `fire${p.id}` } : undefined;
    const mesh = built.geo.toGroup({ castShadow: true, receiveShadow: true, variant });
    const o = p.object;
    this.placeObject(p);
    if (p.door) {
      const d = p.door;
      d.pivot.add(mesh);
      if (!d.pivot.parent) o.add(d.pivot);
      // The collider is registered for the closed pose; it's simply disabled while open.
      d.pivot.rotation.y = d.pivot.userData.base ?? 0;
      o.updateMatrixWorld(true);
      this.addColliders(p, built, d.pivot);
      this.applyDoor(p);
    } else {
      o.add(mesh);
      o.updateMatrixWorld(true);
      this.addColliders(p, built, o);
    }
  }

  private placeObject(p: Piece) {
    const o = p.object;
    const g = p.group;
    if (p.type === 'roof' && g) {
      o.position.set(g.ox, g.floorY, g.oz);
      o.rotation.set(0, g.yaw, 0);
      return;
    }
    o.position.copy(p.pos);
    if (p.group) {
      o.rotation.set(0, p.yaw, 0);
    } else {
      // Free pieces lean with the ground (lean-to only half-way so posts stay plausible).
      const k = p.type === 'lean_to' ? 0.5 : 1;
      const n = _v.copy(UP).lerp(p.normal, k).normalize();
      _q.setFromUnitVectors(UP, n);
      o.quaternion.copy(_q).multiply(new THREE.Quaternion().setFromAxisAngle(UP, p.yaw));
    }
    if (p.door) {
      const d = p.door;
      const [mx, mz] = this.parseKey(p.key!);
      const inside = this.doorInsideSign(p.group!, mx, mz);
      const hx = p.flip ? DOOR_W / 2 - 0.025 : -DOOR_W / 2 + 0.025;
      d.pivot.position.set(hx, 0.02, 0);
      d.pivot.userData.base = p.flip ? Math.PI : 0;
      // Opening swings the free edge toward the inside (wall-local ±Z).
      d.sign = (p.flip ? 1 : -1) * inside;
    }
  }

  /** Wall-local Z sign that points indoors for a doorway at edge (mx, mz). */
  private doorInsideSign(g: Group, mx: number, mz: number): number {
    const [a, b] = this.edgeCells(mx, mz);
    const ha = this.hasCell(g, a[0], a[1]),
      hb = this.hasCell(g, b[0], b[1]);
    // Cell b is on the wall-local +Z side for both edge orientations.
    if (hb && !ha) return 1;
    if (ha && !hb) return -1;
    return 1;
  }

  private addColliders(p: Piece, built: Built, frame: THREE.Object3D) {
    frame.updateMatrixWorld(true);
    const wq = frame.getWorldQuaternion(new THREE.Quaternion());
    for (const s of built.colliders) {
      const c = s.center.clone().applyMatrix4(frame.matrixWorld);
      const q = wq.clone().multiply(s.quat);
      const col = this.ctx.physics.addBox(c, s.half, q, s.layers, p, s.tag ?? p.type);
      p.colliders.push(col);
    }
  }

  private construct(p: Piece): Built | null {
    const g = p.group;
    switch (p.type) {
      case 'foundation': {
        const [ci, cj] = this.parseKey(p.key!);
        const t = this.ctx.terrain;
        const cos = g!.cos,
          sin = g!.sin;
        return buildFoundation({
          seed: p.seed,
          roofed: this.hasRoof(g!, ci, cj),
          nbr: { px: this.hasCell(g!, ci + 1, cj), nx: this.hasCell(g!, ci - 1, cj), pz: this.hasCell(g!, ci, cj + 1), nz: this.hasCell(g!, ci, cj - 1) },
          groundAt: (x, z) => t.heightAt(p.pos.x + x * cos + z * sin, p.pos.z - x * sin + z * cos) - g!.floorY,
        });
      }
      case 'wall':
      case 'doorway':
      case 'window_wall': {
        const [mx, mz] = this.parseKey(p.key!);
        return buildWall(this.wallContext(g!, mx, mz, p.type, p.seed));
      }
      case 'roof': {
        const [ci, cj] = this.parseKey(p.key!);
        return buildRoof(this.roofContext(g!, ci, cj, p.seed));
      }
      case 'door':
        return buildDoor(p.seed);
      case 'campfire':
        return buildCampfire(p.seed);
      case 'bedroll':
        return buildBedroll(p.seed);
      case 'lean_to':
        return buildLeanTo(p.seed);
    }
    return null;
  }

  wallContext(g: Group, mx: number, mz: number, kind: WallKind, seed: number) {
    const isX = mx % 2 === 0;
    // Wall-local -X / +X ends map to these vertices (see header comment).
    const A: [number, number] = isX ? [mx - 1, mz] : [mx, mz + 1];
    const B: [number, number] = isX ? [mx + 1, mz] : [mx, mz - 1];
    const endInfo = (v: [number, number], collinear: [number, number]) => {
      const [vx, vz] = v;
      const perps: [number, number][] = isX
        ? [
            [vx, vz - 1],
            [vx, vz + 1],
          ]
        : [
            [vx - 1, vz],
            [vx + 1, vz],
          ];
      const hasPerp = perps.some(([a, b]) => !!this.edgePiece(g, a, b));
      if (hasPerp) return { ext: CORNER_OH, cap: true };
      if (this.edgePiece(g, collinear[0], collinear[1])) return { ext: 0, cap: false };
      return { ext: 0.05, cap: true };
    };
    const ea = endInfo(A, isX ? [mx - 2, mz] : [mx, mz + 2]);
    const eb = endInfo(B, isX ? [mx + 2, mz] : [mx, mz - 2]);
    const [ca, cb] = this.edgeCells(mx, mz);
    const ha = this.hasCell(g, ca[0], ca[1]),
      hb = this.hasCell(g, cb[0], cb[1]);
    const outside = ha && !hb ? 1 : hb && !ha ? -1 : 0;
    const roofed = this.hasRoof(g, ca[0], ca[1]) || this.hasRoof(g, cb[0], cb[1]);
    // Wall-local +X is group +X for X-edges and group -Z for Z-edges.
    const along = isX ? mx * HALF : -mz * HALF;
    const courseSeed = g.id * 1000 + (isX ? 0 : 500) + (isX ? mz : mx) * 7;
    return { kind, offset: isX ? 0 : COURSE / 2, extA: ea.ext, extB: eb.ext, capA: ea.cap, capB: eb.cap, outside, roofed, seed, courseSeed, along };
  }

  /** Whole-building gable: the roof layout for one cell given every roof in the group. */
  roofContext(g: Group, ci: number, cj: number, seed: number, extra?: [number, number]) {
    let i0 = Infinity,
      i1 = -Infinity,
      j0 = Infinity,
      j1 = -Infinity;
    const has = (a: number, b: number) => this.hasRoof(g, a, b) || (!!extra && extra[0] === a && extra[1] === b);
    for (const p of this.roofs.values()) {
      if (p.group !== g) continue;
      const [a, b] = this.parseKey(p.key!);
      i0 = Math.min(i0, a);
      i1 = Math.max(i1, a);
      j0 = Math.min(j0, b);
      j1 = Math.max(j1, b);
    }
    for (const [a, b] of [[ci, cj], extra ?? [ci, cj]]) {
      i0 = Math.min(i0, a);
      i1 = Math.max(i1, a);
      j0 = Math.min(j0, b);
      j1 = Math.max(j1, b);
    }
    const ridgeX = i1 - i0 >= j1 - j0;
    const edgeWall = (mx: number, mz: number) => !!this.edgePiece(g, mx, mz);
    const x0 = ci * GRID - HALF,
      x1 = ci * GRID + HALF,
      z0 = cj * GRID - HALF,
      z1 = cj * GRID + HALF;
    if (ridgeX) {
      const extA0 = has(ci - 1, cj) ? 0 : GABLE_OH;
      const extA1 = has(ci + 1, cj) ? 0 : GABLE_OH;
      return {
        ridgeX,
        a0: x0,
        a1: x1,
        s0: z0,
        s1: z1,
        sc: ((j0 + j1) / 2) * GRID,
        halfSpan: (j1 - j0 + 1) * HALF,
        eaveY: 2.705 + DECK_T,
        extA0,
        extA1,
        extS0: has(ci, cj - 1) ? 0 : EAVE_OH,
        extS1: has(ci, cj + 1) ? 0 : EAVE_OH,
        gableA0: extA0 > 0 && edgeWall(2 * ci - 1, 2 * cj),
        gableA1: extA1 > 0 && edgeWall(2 * ci + 1, 2 * cj),
        gableBase: 2.7,
        seed,
      };
    }
    // Ridge along Z: roof frame a = z, s = -x.
    const extA0 = has(ci, cj - 1) ? 0 : GABLE_OH;
    const extA1 = has(ci, cj + 1) ? 0 : GABLE_OH;
    return {
      ridgeX,
      a0: z0,
      a1: z1,
      s0: -x1,
      s1: -x0,
      sc: -((i0 + i1) / 2) * GRID,
      halfSpan: (i1 - i0 + 1) * HALF,
      eaveY: 2.855 + DECK_T,
      extA0,
      extA1,
      extS0: has(ci + 1, cj) ? 0 : EAVE_OH,
      extS1: has(ci - 1, cj) ? 0 : EAVE_OH,
      gableA0: extA0 > 0 && edgeWall(2 * ci, 2 * cj - 1),
      gableA1: extA1 > 0 && edgeWall(2 * ci, 2 * cj + 1),
      gableBase: 2.55,
      seed,
    };
  }

  // ---------------------------------------------------------------- behaviour
  private attachBehaviour(p: Piece, restore?: { fire?: FireSave; open?: boolean }) {
    const { ctx } = this;
    if (p.type === 'campfire') {
      const fire = this.hooks.createFire(p.pos.clone().add(new THREE.Vector3(0, 0.02, 0)), restore?.fire, !!p.host);
      fire.glowUniforms = [mat('ash', `fire${p.id}`).userData.glow, mat('charred', `fire${p.id}`).userData.glow];
      p.fire = fire;
    } else if (p.type === 'bedroll') {
      p.removers.push(this.hooks.bedInteraction(p));
    } else if (p.type === 'door' && p.door) {
      const d = p.door;
      const center = p.pos.clone().add(new THREE.Vector3(0, 1.05, 0));
      p.removers.push(
        ctx.interact.add({
          position: center,
          radius: 0.55,
          label: () => (d.open ? 'Close door' : 'Open door'),
          onInteract: () => {
            d.open = !d.open;
            ctx.audio.play(d.open ? 'door_open' : 'door_close', { position: center });
          },
        }),
      );
    }
  }

  private applyDoor(p: Piece) {
    const d = p.door!;
    d.pivot.rotation.y = (d.pivot.userData.base ?? 0) + d.angle * d.sign;
    const closed = d.angle < 0.25;
    for (const c of p.colliders) c.enabled = closed;
  }

  /** Per frame: animate doors and rebuild a few dirty neighbours. */
  update(dt: number) {
    for (const p of this.pieces.values()) {
      if (!p.door) continue;
      const d = p.door;
      const target = d.open ? 1.7 : 0;
      if (Math.abs(d.angle - target) > 1e-3) {
        d.angle = damp(d.angle, target, 7, dt);
        if (Math.abs(d.angle - target) < 0.01) d.angle = target;
        this.applyDoor(p);
      }
    }
    let budget = 3;
    while (budget-- > 0 && this.queue.length) {
      const p = this.queue.shift()!;
      if (this.pieces.has(p.id)) this.build(p);
    }
    this.interiorTimer -= dt;
    if (this.interiorTimer <= 0) {
      this.interiorTimer = 0.5;
      this.updateInteriors();
    }
  }

  private interiorTimer = 0;

  /** Feed the nearest enclosed buildings to the material interior-occlusion uniforms. */
  updateInteriors() {
    const cam = this.ctx.camera.position;
    const list: { d: number; g: Group; x0: number; x1: number; z0: number; z1: number; ridgeX: boolean; enc: number }[] = [];
    for (const g of this.groups.values()) {
      let i0 = Infinity,
        i1 = -Infinity,
        j0 = Infinity,
        j1 = -Infinity,
        n = 0;
      for (const p of this.roofs.values()) {
        if (p.group !== g) continue;
        const [a, b] = this.parseKey(p.key!);
        i0 = Math.min(i0, a);
        i1 = Math.max(i1, a);
        j0 = Math.min(j0, b);
        j1 = Math.max(j1, b);
        n++;
      }
      if (!n) continue;
      let walls = 0,
        per = 0;
      for (let i = i0; i <= i1; i++)
        for (const mz of [2 * j0 - 1, 2 * j1 + 1]) {
          per++;
          if (this.edgePiece(g, 2 * i, mz)) walls++;
        }
      for (let j = j0; j <= j1; j++)
        for (const mx of [2 * i0 - 1, 2 * i1 + 1]) {
          per++;
          if (this.edgePiece(g, mx, 2 * j)) walls++;
        }
      const roofFrac = n / ((i1 - i0 + 1) * (j1 - j0 + 1));
      const enc = Math.pow(walls / per, 1.5) * roofFrac;
      if (enc < 0.05) continue;
      const d = Math.hypot(g.ox - cam.x, g.oz - cam.z);
      list.push({ d, g, x0: i0 * GRID - HALF, x1: i1 * GRID + HALF, z0: j0 * GRID - HALF, z1: j1 * GRID + HALF, ridgeX: i1 - i0 >= j1 - j0, enc });
    }
    list.sort((a, b) => a.d - b.d);
    const u = interiorUniforms.uBld.value;
    const n = Math.min(list.length, MAX_INTERIORS);
    for (let k = 0; k < n; k++) {
      const b = list[k];
      u[k * 3].set(b.g.ox, b.g.oz, b.g.cos, b.g.sin);
      u[k * 3 + 1].set(b.x0, b.x1, b.z0, b.z1);
      u[k * 3 + 2].set(b.g.floorY, b.g.floorY + (b.ridgeX ? 2.705 : 2.855), b.ridgeX ? 1 : 0, b.enc);
    }
    interiorUniforms.uBldN.value = n;
  }

  /** Rebuild everything queued right now (load). */
  flush() {
    while (this.queue.length) {
      const p = this.queue.shift()!;
      if (this.pieces.has(p.id)) this.build(p);
    }
  }

  // ---------------------------------------------------------------- saves
  serialize(): StructuresSave {
    const pieces: PieceSave[] = [];
    // Order: foundations, walls, roofs, doors, free pieces (so topology exists when restoring).
    const rank = (t: BuildPieceId) => (t === 'foundation' ? 0 : isWallType(t) ? 1 : t === 'roof' ? 2 : t === 'door' ? 3 : 4);
    const list = [...this.pieces.values()].sort((a, b) => rank(a.type) - rank(b.type));
    for (const p of list) {
      const s: PieceSave = {
        type: p.type,
        g: p.group ? p.group.id : null,
        key: p.key,
        p: [p.pos.x, p.pos.y, p.pos.z],
        yaw: p.yaw,
        n: [p.normal.x, p.normal.y, p.normal.z],
        flip: p.flip,
        host: p.host,
        seed: p.seed,
      };
      if (p.fire) s.fire = p.fire.serialize();
      if (p.door) s.open = p.door.open;
      pieces.push(s);
    }
    return {
      groups: [...this.groups.values()].map((g) => ({ id: g.id, ox: g.ox, oz: g.oz, floorY: g.floorY, yaw: g.yaw })),
      pieces,
    };
  }

  deserialize(d: StructuresSave) {
    this.clear();
    if (!d) return;
    for (const g of d.groups ?? []) this.makeGroup(g.ox, g.oz, g.floorY, g.yaw, g.id);
    for (const s of d.pieces ?? []) {
      const g = s.g !== null ? this.groups.get(s.g) ?? null : null;
      if (s.g !== null && !g) continue;
      this.add(
        s.type,
        { group: g, key: s.key, pos: new THREE.Vector3(...s.p), yaw: s.yaw, normal: new THREE.Vector3(...s.n), flip: s.flip, host: s.host, seed: s.seed },
        { fire: s.fire, open: s.open },
        true,
      );
    }
    for (const g of this.groups.values()) this.markGroupDirty(g);
    this.flush();
  }

  /** Rough "random" but stable seed for a new piece. */
  static seedFor(x: number, z: number) {
    return Math.floor(hash2(Math.floor(x * 10), Math.floor(z * 10), 99) * 100000);
  }
}
