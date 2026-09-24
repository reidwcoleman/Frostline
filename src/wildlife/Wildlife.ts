// Wildlife system: spawns and despawns animals around the player by biome and time of day,
// runs group AI (wolf packs, deer herds, ptarmigan flocks), perception (noise, wind, scent,
// fire), LOD, carcasses and saves. Dev helpers live at fl.ctx.sys.wildlife.
import * as THREE from 'three';
import type { GameContext, GameState, Species, System } from '../core/types';
import { TREELINE } from '../core/World';
import { clamp, damp, smoothstep } from '../core/math';
import { createAnimalMaterial, type AnimalMaterial } from './material';
import { buildDeer, buildHare, buildWolf, type QuadModel } from './models';
import { Animal } from './Animal';
import { Pack, Wolf } from './Wolf';
import { Deer, Herd } from './Deer';
import { Hare } from './Hare';
import { Bird, buildPtarmigan, buildRaven, type BirdModel } from './Birds';

export type SpawnKind = 'wolf' | 'deer' | 'rabbit' | 'hare' | 'ptarmigan' | 'raven' | 'bird';

interface FireInfo {
  pos: THREE.Vector3;
  radius: number;
}

const _v = new THREE.Vector3();
const _look = new THREE.Vector3();
const MAX_ANIMALS = 56;

export class Wildlife implements System {
  readonly name = 'wildlife';
  readonly updateWhen: GameState[] = ['playing', 'dead'];
  readonly root = new THREE.Group();
  readonly animals: Animal[] = [];
  readonly packs: Pack[] = [];
  readonly herds: Herd[] = [];
  readonly flocks: Bird[][] = [];
  mat!: AnimalMaterial;
  models!: { wolf: [QuadModel, QuadModel]; deer: [QuadModel, QuadModel]; hare: QuadModel; ptarmigan: BirdModel; raven: BirdModel };

  // ---- perception snapshot (refreshed every frame)
  readonly player = new THREE.Vector3();
  readonly playerChest = new THREE.Vector3();
  playerNoise = 1;
  playerBleeding = false;
  torchLit = false;
  readonly torchPos = new THREE.Vector3();
  private fires: FireInfo[] = [];
  private fireScanT = 0;

  /** Dev: disable all behaviour (animals still animate). */
  ai = true;
  /** Dev: disable automatic spawning. */
  autoSpawn = true;
  private spawnT = 3;
  private grace = 4;
  private wolfKills = 0;
  private frame = 0;
  private lastWolfSpawn = -999;

  constructor(readonly ctx: GameContext) {
    this.root.name = 'wildlife';
  }

  init() {
    this.mat = createAnimalMaterial();
    this.models = {
      wolf: [buildWolf(0), buildWolf(1)],
      deer: [buildDeer(false), buildDeer(true)],
      hare: buildHare(),
      ptarmigan: buildPtarmigan(),
      raven: buildRaven(),
    };
    this.ctx.scene.add(this.root);
    this.ctx.events.on('tree:hit', ({ point }) => this.hear(point, 1));
    this.ctx.events.on('rock:hit', ({ point }) => this.hear(point, 0.8));
    // Warm up the shader so the first spawn doesn't hitch.
    const warm = new Hare(this, 1);
    warm.place(this.ctx.terrain.data.spawn[0], this.ctx.terrain.data.spawn[1]);
    warm.object.visible = true;
    this.root.add(warm.object);
    this.ctx.renderer.compile(this.root, this.ctx.camera);
    warm.object.removeFromParent();
  }

  reset() {
    for (const a of this.animals) a.dispose();
    this.animals.length = 0;
    this.packs.length = 0;
    this.herds.length = 0;
    this.flocks.length = 0;
    this.spawnT = 3;
    this.grace = 4;
    this.lastWolfSpawn = -999;
  }

  // ------------------------------------------------------------------ perception
  private perceive(dt: number) {
    const ctx = this.ctx;
    const pl = ctx.player;
    this.player.copy(pl.position);
    this.playerChest.set(pl.position.x, pl.position.y + 1.2, pl.position.z);
    const spd = pl.speed;
    let noise = spd < 0.3 ? 0.6 : spd < 3.5 ? 0.85 : spd < 7 ? 1.25 : 1.55;
    if (pl.crouching) noise *= 0.6;
    this.playerNoise = noise;
    this.playerBleeding = performance.now() / 1000 - pl.lastDamageTime < 90 || pl.health < 35;
    const w = ctx.sys.weapons as unknown as { torchLit?: boolean; torchPosition?: THREE.Vector3 } | undefined;
    this.torchLit = !!w?.torchLit;
    if (w?.torchPosition) this.torchPos.copy(w.torchPosition);
    this.fireScanT -= dt;
    if (this.fireScanT <= 0) {
      this.fireScanT = 0.3;
      this.scanFires();
    }
  }

  /**
   * Lit campfires. Prefers an explicit API from the survival system; falls back to any
   * pooled point light that is on (fires borrow lights from the sky's pool).
   */
  private scanFires() {
    const fires: FireInfo[] = [];
    const surv = this.ctx.sys.survival as unknown as Record<string, unknown> | undefined;
    const fm = surv?.['fires'] as { positionsList?: () => { x: number; y: number; z: number; radius: number }[] } | undefined;
    let got = false;
    try {
      if (fm && typeof fm.positionsList === 'function') {
        got = true;
        for (const f of fm.positionsList()) fires.push({ pos: new THREE.Vector3(f.x, f.y, f.z), radius: Math.max(5, f.radius) });
      }
    } catch {
      got = false;
    }
    if (!got) {
      const torchLight = (this.ctx.sys.weapons as unknown as { torchLight?: THREE.Object3D | null })?.torchLight;
      this.ctx.scene.traverse((o) => {
        const l = o as THREE.PointLight;
        if (!l.isPointLight || !l.visible || l.intensity < 0.5 || l === torchLight) return;
        const p = l.getWorldPosition(new THREE.Vector3());
        fires.push({ pos: p, radius: 9 });
      });
    }
    this.fires = fires;
  }

  /** 0..1 how scary fire is at a point (1 = right next to a campfire). */
  fearAt(p: THREE.Vector3): number {
    let f = 0;
    for (const fire of this.fires) {
      const d = Math.hypot(p.x - fire.pos.x, p.z - fire.pos.z);
      f = Math.max(f, 1 - d / (fire.radius + 4));
    }
    return clamp(f, 0, 1);
  }
  fireRadiusNear(p: THREE.Vector3): number {
    let best = 0,
      bd = Infinity;
    for (const fire of this.fires) {
      const d = Math.hypot(p.x - fire.pos.x, p.z - fire.pos.z);
      if (d < bd) {
        bd = d;
        best = fire.radius;
      }
    }
    return best;
  }

  /** How far a prey animal notices the player (noise, crouching, wind, darkness). */
  detectRange(base: number, at: THREE.Vector3): number {
    return base * this.playerNoise * this.windFactor(at) * this.coverFactor(at) * (this.ctx.clock.isNight ? (this.torchLit ? 1.2 : 0.75) : 1);
  }

  /**
   * Visual cover between the animal and the player: trunks and boughs along the sight line hide
   * you (stalk through the forest edge, don't walk across the open meadow). Scent (wind) and noise
   * still carry, so cover never makes you invisible — floor of ~0.45.
   */
  coverFactor(at: THREE.Vector3): number {
    const w = this.ctx.world;
    const dx = this.player.x - at.x,
      dz = this.player.z - at.z;
    const d = Math.hypot(dx, dz);
    if (d < 6) return 1;
    let trees = 0;
    for (const f of [0.3, 0.55, 0.8]) {
      w.forEachTree(at.x + dx * f, at.z + dz * f, 2.6, () => {
        trees++;
      });
    }
    return Math.max(0.45, 1 - trees * 0.12);
  }

  /** Downwind of the player = smells you from further away. */
  windFactor(at: THREE.Vector3): number {
    const w = this.ctx.env.wind;
    const wl = Math.hypot(w.x, w.z);
    if (wl < 0.1) return 1;
    const dx = at.x - this.player.x,
      dz = at.z - this.player.z;
    const d = Math.hypot(dx, dz) || 1;
    const dot = (w.x * dx + w.z * dz) / (wl * d);
    const k = Math.min(1, wl / 6);
    return 1 + (dot > 0 ? 0.55 : 0.3) * dot * k;
  }

  /** Wolves: scent range (night, blood, meat, wind, days survived). */
  scentRange(at: THREE.Vector3): number {
    const ctx = this.ctx;
    let r = ctx.clock.isNight ? 125 : 55;
    if (this.playerBleeding) r *= 1.6;
    if (this.nearestCarcass(this.player, 20)) r *= 1.3;
    if (ctx.inventory.count('raw_meat') >= 3) r *= 1.15;
    r *= this.windFactor(at);
    r *= 1 + Math.min(0.6, (ctx.clock.day - 1) * 0.06);
    return r;
  }

  /** Player speed toward a point (m/s, + = approaching). */
  playerApproachSpeed(at: THREE.Vector3): number {
    const v = this.ctx.player.velocity;
    const dx = at.x - this.player.x,
      dz = at.z - this.player.z;
    const d = Math.hypot(dx, dz) || 1;
    return (v.x * dx + v.z * dz) / d;
  }

  headingFrom(p: THREE.Vector3) {
    return Math.atan2(this.player.x - p.x, this.player.z - p.z);
  }

  nearest(species: Species, p: THREE.Vector3, maxR: number): Animal | null {
    let best: Animal | null = null,
      bd = maxR;
    for (const a of this.animals) {
      if (a.species !== species || !a.alive) continue;
      const d = Math.hypot(a.pos.x - p.x, a.pos.z - p.z);
      if (d < bd) {
        bd = d;
        best = a;
      }
    }
    return best;
  }

  nearestCarcass(p: THREE.Vector3, maxR: number): Animal | null {
    let best: Animal | null = null,
      bd = maxR;
    for (const a of this.animals) {
      if (!a.carcass || a.harvested || a.species === 'bird') continue;
      const d = Math.hypot(a.pos.x - p.x, a.pos.z - p.z);
      if (d < bd) {
        bd = d;
        best = a;
      }
    }
    return best;
  }

  /** A loud noise (chopping, impacts): prey startles, wolves at night get curious. */
  hear(point: THREE.Vector3, loudness: number) {
    for (const h of this.herds) {
      const c = h.centroid(_v);
      const d = Math.hypot(c.x - point.x, c.z - point.z);
      if (d < 25 * loudness) h.panic(point, true);
      else if (d < 60 * loudness) h.alert(point);
    }
    for (const a of this.animals) {
      if (!a.alive) continue;
      const d = Math.hypot(a.pos.x - point.x, a.pos.z - point.z);
      if (a instanceof Hare && d < 18 * loudness) a.startBolt();
      if (a instanceof Bird && a.kind === 'ptarmigan' && d < 10 * loudness) a.flush(Math.random() * 0.3);
    }
    if (this.ctx.clock.isNight) {
      for (const p of this.packs) {
        if (p.state !== 'roam') continue;
        const c = p.centroid(_v);
        if (Math.hypot(c.x - point.x, c.z - point.z) < 140 * loudness) {
          p.lastKnown.copy(point);
          p.setState('track');
        }
      }
    }
  }

  onKilled(a: Animal) {
    const ctx = this.ctx;
    ctx.events.emit('animal:killed', { species: a.species, by: a.killedBy, id: a.id });
    ctx.player.stats.kills++;
    if (a.species === 'deer') ctx.platform.unlockAchievement('HUNTER');
    if (a.species === 'wolf') {
      ctx.platform.unlockAchievement('WOLF_SLAYER');
      this.wolfKills++;
      ctx.platform.setStat('wolves_killed', this.wolfKills);
      if (this.wolfKills >= 10) ctx.platform.unlockAchievement('PACK_BREAKER');
    }
    // Scavengers: ravens start circling over fresh kills.
    const raven = this.animals.find((r) => r instanceof Bird && r.kind === 'raven' && r.alive) as Bird | undefined;
    if (raven) raven.setCircle(a.pos.x, a.pos.z, 18);
  }

  onPlayerBitten() {
    // Packs press the advantage on a bleeding player: shorten the next stalk.
  }

  // ------------------------------------------------------------------ update
  update(dt: number) {
    const ctx = this.ctx;
    if (!ctx.terrain) return;
    this.frame++;
    this.perceive(dt);
    const p = this.player;

    if (this.ai) {
      for (const pk of this.packs) pk.update(dt);
      for (const h of this.herds) h.update(dt);
    }

    for (const a of this.animals) {
      a.distToPlayer = Math.hypot(a.pos.x - p.x, a.pos.z - p.z);
      if (a.carcass) continue;
      const full = a.distToPlayer < 75;
      a.far = a.distToPlayer > 150;
      const la = a as Animal & { lodAcc?: number };
      if (a.far && a.alive) {
        la.lodAcc = (la.lodAcc ?? 0) + dt;
        if ((this.frame + a.id) % 3 !== 0) continue;
        const d = la.lodAcc;
        la.lodAcc = 0;
        this.step(a, Math.min(d, 0.25), false);
      } else this.step(a, dt, full);
    }

    // Despawn / cleanup.
    for (let i = this.animals.length - 1; i >= 0; i--) {
      const a = this.animals[i];
      const far = a.distToPlayer > (a.carcass ? 420 : 310);
      if (a.remove || far) {
        a.dispose();
        this.animals.splice(i, 1);
      }
    }
    this.cleanupGroups();

    if (this.autoSpawn && ctx.game.state === 'playing') {
      this.grace -= dt;
      this.spawnT -= dt;
      if (this.spawnT <= 0 && this.grace <= 0) {
        const living = this.count(() => true);
        this.spawnT = living < 12 ? 0.35 : 1.0;
        this.spawner();
      }
    }

    // Eyeshine at night; soft rim tinted by the sky.
    const dark = 1 - ctx.env.daylight;
    this.mat.glow.value = smoothstep(0.3, 0.95, dark) * 0.55;
    this.mat.rim.value.copy(ctx.env.skyColor).multiplyScalar(0.18 + 0.3 * ctx.env.daylight);
    this.mat.snow.value = damp(this.mat.snow.value, smoothstep(0.15, 0.7, ctx.env.snowfall) * 0.75, 0.2, dt);
  }

  private step(a: Animal, dt: number, full: boolean) {
    if (!this.ai && a.alive) {
      // Frozen behaviour (dev): keep animating in place.
      const anyA = a as unknown as { animate: (dt: number, full: boolean) => void; syncColliders: () => void };
      a.speed = a.desiredSpeed;
      anyA.animate(dt, true);
      anyA.syncColliders();
      return;
    }
    a.update(dt, full);
  }

  private cleanupGroups() {
    for (let i = this.packs.length - 1; i >= 0; i--) {
      const pk = this.packs[i];
      for (let k = pk.members.length - 1; k >= 0; k--) if (pk.members[k].remove || !this.animals.includes(pk.members[k])) pk.members.splice(k, 1);
      if (!pk.members.some((m) => m.alive)) this.packs.splice(i, 1);
    }
    for (let i = this.herds.length - 1; i >= 0; i--) {
      const h = this.herds[i];
      for (let k = h.members.length - 1; k >= 0; k--) if (!this.animals.includes(h.members[k])) h.members.splice(k, 1);
      if (!h.members.some((m) => m.alive)) this.herds.splice(i, 1);
    }
    for (let i = this.flocks.length - 1; i >= 0; i--) {
      const f = this.flocks[i];
      for (let k = f.length - 1; k >= 0; k--) if (!this.animals.includes(f[k])) f.splice(k, 1);
      if (!f.length) this.flocks.splice(i, 1);
    }
  }

  // ------------------------------------------------------------------ spawning
  private count(pred: (a: Animal) => boolean) {
    let n = 0;
    for (const a of this.animals) if (a.alive && pred(a)) n++;
    return n;
  }

  private spawner() {
    const ctx = this.ctx;
    const clock = ctx.clock;
    const night = clock.isNight;
    const hour = clock.time;
    const day = clock.day;
    const living = this.count(() => true);
    if (living >= MAX_ANIMALS) return;
    const twilight = (hour > 5.5 && hour < 9) || (hour > 16.5 && hour < 20);

    // Wolves: the night belongs to them. By day, rarely a cautious pair.
    const packTarget = night ? (day >= 3 ? 4 : 3) : 2;
    const wolfCount = this.count((a) => a.species === 'wolf');
    if (this.packs.length < packTarget && ctx.time - this.lastWolfSpawn > 22 && living + 2 <= MAX_ANIMALS) {
      const size = night ? Math.min(6, 3 + (day >= 2 ? 1 : 0) + (day >= 4 ? 1 : 0)) : 2 + Math.floor(Math.random() * 2);
      const pos = this.findSpawn(130, 220, (x, z) => this.okWolf(x, z));
      if (pos && wolfCount + size <= 18) {
        this.spawnPack(pos.x, pos.z, Math.max(2, size));
        this.lastWolfSpawn = ctx.time;
        return;
      }
    }
    // Deer herds in forest glades and valleys; they bed down at night.
    const herdTarget = night ? 3 : 6;
    if (this.herds.length < herdTarget && living + 3 <= MAX_ANIMALS) {
      const pos = this.findSpawn(60, 220, (x, z) => this.okDeer(x, z));
      if (pos) {
        this.spawnHerd(pos.x, pos.z, 3 + Math.floor(Math.random() * 5));
        return;
      }
    }
    // Hares: forest edges, busiest at dawn/dusk.
    const hareTarget = twilight ? 12 : night ? 7 : 11;
    if (this.count((a) => a.species === 'rabbit') < hareTarget) {
      const pos = this.findSpawn(40, 160, (x, z) => this.okHare(x, z));
      if (pos) {
        this.spawn('hare', pos.x, pos.z);
        return;
      }
    }
    // Ptarmigan above the treeline.
    if (this.flocks.length < 4 && living + 4 <= MAX_ANIMALS) {
      const pos = this.findSpawn(45, 200, (x, z) => this.okPtarmigan(x, z));
      if (pos) {
        this.spawnFlock(pos.x, pos.z, 3 + Math.floor(Math.random() * 4));
        return;
      }
    }
    // Ravens by day.
    const ravens = this.count((a) => a instanceof Bird && a.kind === 'raven');
    if (!night && ravens < 4) {
      const a = Math.random() * Math.PI * 2;
      const x = this.player.x + Math.sin(a) * 120,
        z = this.player.z + Math.cos(a) * 120;
      if (ctx.terrain.inBounds(x, z, 80)) {
        const r = this.spawn('raven', x, z) as Bird;
        r.setCircle(this.player.x + (Math.random() - 0.5) * 120, this.player.z + (Math.random() - 0.5) * 120);
      }
    }
  }

  /** Random point in a ring around the player, out of sight, satisfying `ok`. */
  private findSpawn(rMin: number, rMax: number, ok: (x: number, z: number) => boolean): THREE.Vector3 | null {
    const ctx = this.ctx;
    const t = ctx.terrain;
    ctx.player.lookDir(_look);
    const lx = _look.x,
      lz = _look.z;
    const ll = Math.hypot(lx, lz) || 1;
    for (let k = 0; k < 14; k++) {
      const a = Math.random() * Math.PI * 2;
      const r = rMin + Math.random() * (rMax - rMin);
      const x = this.player.x + Math.sin(a) * r,
        z = this.player.z + Math.cos(a) * r;
      if (!t.inBounds(x, z, 60)) continue;
      // Out of sight: behind the player, or far enough that fog + trees hide the pop-in.
      const facing = (Math.sin(a) * lx + Math.cos(a) * lz) / ll;
      if (facing > 0.25 && r < 150) continue;
      if (facing > 0.25) {
        // In front and far: require the line of sight to be blocked.
        _v.set(x, t.heightAt(x, z) + 1, z);
        const eye = ctx.camera.position;
        const dir = _v.clone().sub(eye);
        const len = dir.length();
        dir.divideScalar(len);
        const hit = ctx.physics.raycast(eye, dir, len - 1, { mask: 0 });
        if (!hit) continue;
      }
      if (!ok(x, z)) continue;
      return new THREE.Vector3(x, t.heightAt(x, z), z);
    }
    return null;
  }

  private treesNear(x: number, z: number, r: number) {
    let n = 0;
    this.ctx.world.forEachTree(x, z, r, () => {
      n++;
    });
    return n;
  }
  private okWolf(x: number, z: number) {
    const t = this.ctx.terrain;
    return t.slopeAngle(x, z) < 0.5 && t.lakeFactor(x, z) < 0.5;
  }
  private okDeer(x: number, z: number) {
    const t = this.ctx.terrain;
    const h = t.heightAt(x, z);
    if (h > TREELINE - 40 || t.slopeAngle(x, z) > 0.38 || t.lakeFactor(x, z) > 0.01) return false;
    // A glade: open right here, forest around.
    if (this.treesNear(x, z, 4) > 1) return false;
    const around = this.treesNear(x, z, 45);
    return around >= 3 || t.flowAt(x, z) > 0.4;
  }
  private okHare(x: number, z: number) {
    const t = this.ctx.terrain;
    const h = t.heightAt(x, z);
    if (h > TREELINE + 20 || t.slopeAngle(x, z) > 0.45 || t.lakeFactor(x, z) > 0.01) return false;
    return this.treesNear(x, z, 2) === 0 && this.treesNear(x, z, 30) >= 1;
  }
  private okPtarmigan(x: number, z: number) {
    const t = this.ctx.terrain;
    return t.heightAt(x, z) > TREELINE - 60 && t.slopeAngle(x, z) < 0.5 && this.treesNear(x, z, 10) === 0;
  }

  // ------------------------------------------------------------------ public spawn API (also dev helpers)
  /** Spawn one animal. Omit x/z to place it ~12 m in front of the player. */
  spawn(kind: SpawnKind, x?: number, z?: number, opts: { heading?: number; variant?: number; scale?: number } = {}): Animal {
    const ctx = this.ctx;
    if (x === undefined || z === undefined) {
      ctx.player.lookDir(_look);
      const l = Math.hypot(_look.x, _look.z) || 1;
      x = ctx.player.position.x + (_look.x / l) * 12;
      z = ctx.player.position.z + (_look.z / l) * 12;
    }
    let a: Animal;
    switch (kind) {
      case 'wolf':
        a = new Wolf(this, (opts.variant ?? (Math.random() < 0.6 ? 0 : 1)) as 0 | 1, opts.scale ?? 0.95 + Math.random() * 0.12);
        break;
      case 'deer':
        a = new Deer(this, (opts.variant ?? (Math.random() < 0.3 ? 1 : 0)) === 1, opts.scale ?? 0.94 + Math.random() * 0.1);
        break;
      case 'rabbit':
      case 'hare':
        a = new Hare(this, opts.scale ?? 1 + Math.random() * 0.12);
        break;
      case 'raven':
        a = new Bird(this, 'raven');
        break;
      default:
        a = new Bird(this, 'ptarmigan');
    }
    a.place(x, z, opts.heading ?? Math.random() * Math.PI * 2);
    if (a instanceof Bird && a.kind === 'raven') {
      a.air = 45;
      a.setCircle(x, z);
    }
    this.root.add(a.object);
    a.addColliders();
    a.distToPlayer = Math.hypot(a.pos.x - this.player.x, a.pos.z - this.player.z);
    // Pose it immediately so the first rendered frame is correct.
    (a as unknown as { animate: (dt: number, full: boolean) => void }).animate(0.016, true);
    this.animals.push(a);
    return a;
  }

  spawnPack(x: number, z: number, n = 3): Wolf[] {
    const pack = new Pack(this);
    const out: Wolf[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const w = this.spawn('wolf', x + Math.sin(a) * 2.5, z + Math.cos(a) * 2.5) as Wolf;
      pack.add(w);
      out.push(w);
    }
    this.packs.push(pack);
    return out;
  }

  spawnHerd(x: number, z: number, n = 4): Deer[] {
    const herd = new Herd(this);
    herd.home.set(x, 0, z);
    const out: Deer[] = [];
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2,
        r = 2 + Math.random() * 6;
      const d = this.spawn('deer', x + Math.sin(a) * r, z + Math.cos(a) * r, { variant: i === 0 && n > 2 && Math.random() < 0.7 ? 1 : 0 }) as Deer;
      herd.add(d);
      out.push(d);
    }
    this.herds.push(herd);
    return out;
  }

  spawnFlock(x: number, z: number, n = 5): Bird[] {
    const flock: Bird[] = [];
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2,
        r = 0.8 + Math.random() * 3.5;
      const b = this.spawn('ptarmigan', x + Math.sin(a) * r, z + Math.cos(a) * r) as Bird;
      b.flock = flock;
      flock.push(b);
    }
    this.flocks.push(flock);
    return flock;
  }

  /** Remove every animal (dev). */
  clear() {
    this.reset();
    this.grace = 1e9;
  }

  /** Dev: list what's alive. */
  list() {
    return this.animals.map((a) => ({ id: a.id, species: a.species, state: a.state, mode: (a as unknown as { mode?: string }).mode, hp: Math.round(a.health), d: Math.round(a.distToPlayer), x: Math.round(a.pos.x), z: Math.round(a.pos.z) }));
  }

  // ------------------------------------------------------------------ saves
  serialize() {
    return {
      carcasses: this.animals.filter((a) => a.carcass && !a.harvested).map((a) => a.serializeCarcass()),
      wolfKills: this.wolfKills,
    };
  }

  deserialize(d: { carcasses?: { s: Species; x: number; z: number; h: number; r: number; v: number }[]; wolfKills?: number }) {
    this.wolfKills = d?.wolfKills ?? 0;
    for (const c of d?.carcasses ?? []) {
      const kind: SpawnKind = c.s === 'rabbit' ? 'hare' : c.s === 'bird' ? 'ptarmigan' : c.s;
      const a = this.spawn(kind, c.x, c.z, { heading: c.h, variant: c.v });
      a.forceCarcass(c.r);
    }
  }
}
