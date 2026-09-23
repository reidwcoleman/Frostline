// Main-menu flyover: four hand-built cinematic shots found by querying the terrain
// (orbit the lake, glide along a ridge, rise over the forest, follow a creek valley).
// Golden hour, frozen clock, slow eased motion, a dip to dark between shots.
// Every camera position keeps >= 30 m clearance over the terrain around it.
import * as THREE from 'three';
import type { GameContext, GameState, System } from '../core/types';
import { mulberry32, smoothstep, clamp } from '../core/math';

interface Shot {
  name: string;
  duration: number;
  /** Camera position + look target for t in [0, 1]. */
  pose(t: number, pos: THREE.Vector3, look: THREE.Vector3): void;
}

const MENU_HOUR = 17.6;
const MENU_FOV = 52;
const CLEARANCE = 30;
const DIP = 1.1; // seconds of fade at each cut
const GOLDEN_SIN = 0.12; // sin(sun elevation) we aim for in the menu (~7°)
const SEARCH_STEPS = 14;

export class MenuCamera implements System {
  readonly name = 'menuCam';
  readonly updateWhen: GameState[] = ['menu'];
  private shots: Shot[] = [];
  private order: number[] = [];
  private idx = 0;
  private t = 0;
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private smoothLook = new THREE.Vector3();
  private first = true;
  private dipEl: HTMLDivElement | null = null;
  private inMenu = false;
  private prevViewmodel = true;
  private hour = MENU_HOUR;
  private lo = 12.75;
  private hi = 20.5;
  private search = 0;
  private prevY = -9;

  constructor(private ctx: GameContext) {
    ctx.events.on('state', ({ from, to }) => {
      if (to === 'menu') this.enter();
      else if (from === 'menu') this.exit();
    });
  }

  init() {
    try {
      this.buildShots();
    } catch (err) {
      console.error('[menuCam] shot planning failed, using fallback orbit', err);
    }
    if (!this.shots.length) this.shots.push(this.lakeOrbit());
    this.order = this.shots.map((_, i) => i);
    this.dipEl = this.ctx.uiRoot.querySelector('.dip');
  }

  // ------------------------------------------------------------------ state
  private enter() {
    const { clock, camera, sys } = this.ctx;
    this.inMenu = true;
    if (this.search === 0 && this.hour === MENU_HOUR) {
      this.lo = 12.75;
      this.hi = 20.5;
      this.prevY = -9;
      this.search = SEARCH_STEPS;
    }
    clock.setTime(this.hour);
    clock.frozen = true;
    camera.fov = MENU_FOV;
    camera.updateProjectionMatrix();
    const vm = sys.player?.viewmodel;
    if (vm) {
      this.prevViewmodel = vm.visible;
      vm.visible = false;
    }
    // Start somewhere different each visit.
    this.idx = Math.floor(Math.random() * Math.max(1, this.shots.length));
    this.t = 0;
    this.first = true;
  }

  private exit() {
    if (!this.inMenu) return;
    this.inMenu = false;
    const { clock, camera, settings, sys, dev } = this.ctx;
    clock.frozen = dev.freezeTime;
    camera.fov = settings.data.fov;
    camera.updateProjectionMatrix();
    const vm = sys.player?.viewmodel;
    if (vm) vm.visible = this.prevViewmodel;
    this.dipEl?.classList.remove('on');
  }

  /**
   * Golden hour is defined by sun elevation, not a clock value, so we bisect the afternoon
   * for the hour whose sun sits ~7° up — whatever sky model the atmosphere uses. Sky updates
   * before us each frame, so env.sunDir reflects the hour we set on the previous frame.
   */
  private findGoldenHour() {
    if (this.search <= 0) return;
    const y = this.ctx.env.sunDir.y;
    if (this.search < SEARCH_STEPS && Math.abs(y - this.prevY) < 1e-5) {
      // The sky isn't responding to time (placeholder/frozen): keep the default hour.
      this.hour = MENU_HOUR;
      this.search = 0;
      return;
    }
    this.prevY = y;
    if (y > GOLDEN_SIN) this.lo = this.hour;
    else this.hi = this.hour;
    this.hour = (this.lo + this.hi) / 2;
    this.search--;
  }

  // ------------------------------------------------------------------ frame
  update(dt: number) {
    if (!this.shots.length) return;
    const { camera, clock } = this.ctx;
    this.findGoldenHour();
    clock.setTime(this.hour);
    const shot = this.shots[this.order[this.idx % this.order.length]];
    this.t += dt;
    if (this.t >= shot.duration) {
      this.t = 0;
      this.idx++;
      this.first = true;
    }
    const cur = this.shots[this.order[this.idx % this.order.length]];
    // Linear + eased blend: never fully stops, but settles in and out gently.
    const k = this.t / cur.duration;
    const u = 0.5 * k + 0.5 * smoothstep(0, 1, k);
    cur.pose(u, this.pos, this.look);
    if (this.first) {
      this.smoothLook.copy(this.look);
      this.first = false;
    } else this.smoothLook.lerp(this.look, 1 - Math.exp(-dt * 2.5));
    camera.position.copy(this.pos);
    camera.lookAt(this.smoothLook);

    // Dip to the ground colour around cuts.
    const dip = this.t < DIP * 0.6 || this.t > cur.duration - DIP;
    this.dipEl?.classList.toggle('on', dip && !this.firstEver());
  }

  private firstShown = false;
  private firstEver() {
    // The very first shot fades in from the loading screen instead.
    if (!this.firstShown && this.t > DIP) this.firstShown = true;
    return !this.firstShown;
  }

  // ------------------------------------------------------------------ planning
  private sunAzimuth(): number {
    // Sun direction at the menu hour, as the atmosphere agent computes it (fallback: west).
    const s = this.ctx.env.sunDir;
    if (Math.hypot(s.x, s.z) < 1e-3) return Math.PI;
    return Math.atan2(s.z, s.x);
  }

  private buildShots() {
    const rng = mulberry32(this.ctx.terrain.data.seed * 7 + 1);
    this.shots = [this.lakeOrbit(), this.ridgeGlide(rng), this.forestRise(rng), this.valleyFlight(rng)].filter((s): s is Shot => !!s);
  }

  /** Max terrain height within r metres of (x, z) — sampled on a small ring pattern. */
  private maxAround(x: number, z: number, r: number) {
    const t = this.ctx.terrain;
    let m = t.heightAt(x, z);
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      m = Math.max(m, t.heightAt(x + Math.cos(ang) * r, z + Math.sin(ang) * r), t.heightAt(x + Math.cos(ang) * r * 0.5, z + Math.sin(ang) * r * 0.5));
    }
    return m;
  }

  /**
   * Build a clearance profile along a parametric XZ path: for each sample the minimum safe
   * camera height, dilated along the path and smoothed so the camera glides over bumps.
   */
  private clearanceProfile(xz: (t: number) => [number, number], samples = 64) {
    const raw = new Float32Array(samples + 1);
    for (let i = 0; i <= samples; i++) {
      const [x, z] = xz(i / samples);
      raw[i] = this.maxAround(x, z, 45) + CLEARANCE;
    }
    // Dilate (moving max) then smooth.
    const dil = new Float32Array(samples + 1);
    for (let i = 0; i <= samples; i++) {
      let m = -Infinity;
      for (let j = Math.max(0, i - 4); j <= Math.min(samples, i + 4); j++) m = Math.max(m, raw[j]);
      dil[i] = m;
    }
    const sm = new Float32Array(samples + 1);
    for (let i = 0; i <= samples; i++) {
      let s = 0,
        n = 0;
      for (let j = Math.max(0, i - 3); j <= Math.min(samples, i + 3); j++) {
        s += dil[j];
        n++;
      }
      sm[i] = Math.max(s / n, raw[i]);
    }
    return (t: number) => {
      const f = clamp(t, 0, 1) * samples;
      const i = Math.floor(f);
      const j = Math.min(samples, i + 1);
      return sm[i] + (sm[j] - sm[i]) * (f - i);
    };
  }

  private lakeOrbit(): Shot {
    const t = this.ctx.terrain;
    const [lx, lz] = t.data.lakeCenter;
    const R = 560;
    const sweep = 0.9;
    // Clearance for the whole circle, so the start angle can follow the sun at run time.
    const ring = (u: number): [number, number] => {
      const a = u * Math.PI * 2;
      return [lx + Math.cos(a) * R, lz + Math.sin(a) * R];
    };
    const floor = this.clearanceProfile(ring, 128);
    let a0 = 0;
    return {
      name: 'lake orbit',
      duration: 30,
      pose: (u, pos, look) => {
        // Side-lit: camera ~55° off the sun azimuth, so slopes show warm light and long shadows.
        if (u < 0.002) a0 = this.sunAzimuth() + 0.95;
        const a = a0 + sweep * u;
        const x = lx + Math.cos(a) * R,
          z = lz + Math.sin(a) * R;
        const ringU = (((a / (Math.PI * 2)) % 1) + 1) % 1;
        const y = Math.max(t.lakeLevel + 150 - 30 * u, floor(ringU));
        pos.set(x, y, z);
        // Look across the lake to the mountains beyond.
        const dx = lx - x,
          dz = lz - z;
        const d = Math.hypot(dx, dz);
        look.set(lx + (dx / d) * 380, t.lakeLevel + 70, lz + (dz / d) * 380);
      },
    };
  }

  private ridgeGlide(rng: () => number): Shot | null {
    const t = this.ctx.terrain;
    const [lx, lz] = t.data.lakeCenter;
    let best = { score: -Infinity, x: 0, z: 0, dir: 0 };
    for (let i = 0; i < 700; i++) {
      const x = lx + (rng() - 0.5) * 3000,
        z = lz + (rng() - 0.5) * 3000;
      if (!t.inBounds(x, z, 500)) continue;
      const h = t.baseHeight(x, z);
      if (h < t.lakeLevel + 250) continue;
      // Ridge direction: the heading along which height changes least.
      let bestDir = 0,
        flat = Infinity;
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI;
        const c = Math.cos(a) * 220,
          s = Math.sin(a) * 220;
        const f = Math.abs(t.baseHeight(x + c, z + s) - h) + Math.abs(t.baseHeight(x - c, z - s) - h);
        if (f < flat) {
          flat = f;
          bestDir = a;
        }
      }
      const px = -Math.sin(bestDir) * 180,
        pz = Math.cos(bestDir) * 180;
      const prominence = h - 0.5 * (t.baseHeight(x + px, z + pz) + t.baseHeight(x - px, z - pz));
      const toLake = Math.hypot(lx - x, lz - z);
      const score = prominence * 1.5 - flat * 0.8 + h * 0.15 - Math.abs(toLake - 1100) * 0.05;
      if (score > best.score) best = { score, x, z, dir: bestDir };
    }
    if (!isFinite(best.score)) return null;
    const dx = Math.cos(best.dir),
      dz = Math.sin(best.dir);
    // Offset to the lake side of the crest so we look across the valley past the ridge.
    let nx = -dz,
      nz = dx;
    if (nx * (lx - best.x) + nz * (lz - best.z) < 0) {
      nx = -nx;
      nz = -nz;
    }
    const L = 420;
    const xz = (u: number): [number, number] => [best.x + dx * L * (u - 0.5) * 2 + nx * 90, best.z + dz * L * (u - 0.5) * 2 + nz * 90];
    const floor = this.clearanceProfile(xz);
    return {
      name: 'ridge glide',
      duration: 26,
      pose: (u, pos, look) => {
        const [x, z] = xz(u);
        pos.set(x, floor(u) + 25, z);
        // Look out across the valley, angled a little along the direction of travel.
        const fx = nx * 0.85 + dx * 0.5,
          fz = nz * 0.85 + dz * 0.5;
        look.set(x + fx * 900, pos.y - 170, z + fz * 900);
      },
    };
  }

  private forestRise(rng: () => number): Shot | null {
    const { terrain: t, world } = this.ctx;
    const [lx, lz] = t.data.lakeCenter;
    let best = { n: -1, x: 0, z: 0 };
    for (let i = 0; i < 240; i++) {
      const a = rng() * Math.PI * 2,
        r = 250 + rng() * 1100;
      const x = lx + Math.cos(a) * r,
        z = lz + Math.sin(a) * r;
      if (!t.inBounds(x, z, 300) || t.lakeFactor(x, z) > 0) continue;
      let n = 0;
      world.forEachTree(x, z, 45, () => {
        n++;
      });
      if (n > best.n) best = { n, x, z };
    }
    if (best.n < 5) return null;
    // Rise while pulling back, looking toward the lake and the peaks beyond it.
    const tx = lx - best.x,
      tz = lz - best.z;
    const td = Math.hypot(tx, tz) || 1;
    const fx = tx / td,
      fz = tz / td;
    const xz = (u: number): [number, number] => [best.x - fx * 160 * u, best.z - fz * 160 * u];
    const floor = this.clearanceProfile(xz);
    return {
      name: 'forest rise',
      duration: 24,
      pose: (u, pos, look) => {
        const [x, z] = xz(u);
        const ground = t.heightAt(x, z);
        pos.set(x, Math.max(floor(u), ground + CLEARANCE + 6 + 210 * u * u), z);
        look.set(x + fx * 1200, t.lakeLevel + 60 + 90 * u, z + fz * 1200);
      },
    };
  }

  private valleyFlight(rng: () => number): Shot | null {
    const t = this.ctx.terrain;
    const [lx, lz] = t.data.lakeCenter;
    // Start at a creek up-valley and follow steepest descent toward the lake.
    let start: [number, number] | null = null;
    let bestF = 0;
    for (let i = 0; i < 400; i++) {
      const a = rng() * Math.PI * 2,
        r = 900 + rng() * 700;
      const x = lx + Math.cos(a) * r,
        z = lz + Math.sin(a) * r;
      if (!t.inBounds(x, z, 300)) continue;
      const f = t.flowAt(x, z);
      if (f > bestF) {
        bestF = f;
        start = [x, z];
      }
    }
    if (!start) return null;
    const pts: [number, number][] = [start];
    let [x, z] = start;
    for (let i = 0; i < 40; i++) {
      // Steepest descent with a pull toward the lake so we don't stall in hollows.
      let bx = 0,
        bz = 0,
        bh = Infinity;
      const h0 = t.baseHeight(x, z);
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const nx = x + Math.cos(a) * 25,
          nz = z + Math.sin(a) * 25;
        const pull = Math.hypot(lx - nx, lz - nz) * 0.02;
        const hh = t.baseHeight(nx, nz) + pull;
        if (hh < bh) {
          bh = hh;
          bx = nx;
          bz = nz;
        }
      }
      if (bh >= h0 + 1 && i > 10) break;
      x = bx;
      z = bz;
      pts.push([x, z]);
      if (t.lakeFactor(x, z) > 0.5) break;
    }
    if (pts.length < 12) return null;
    // Smooth the polyline.
    const sm = pts.map((_, i) => {
      let sx = 0,
        sz = 0,
        n = 0;
      for (let j = Math.max(0, i - 3); j <= Math.min(pts.length - 1, i + 3); j++) {
        sx += pts[j][0];
        sz += pts[j][1];
        n++;
      }
      return [sx / n, sz / n] as [number, number];
    });
    const at = (u: number): [number, number] => {
      const f = clamp(u, 0, 1) * (sm.length - 1);
      const i = Math.floor(f),
        j = Math.min(sm.length - 1, i + 1);
      const k = f - i;
      return [sm[i][0] + (sm[j][0] - sm[i][0]) * k, sm[i][1] + (sm[j][1] - sm[i][1]) * k];
    };
    const floor = this.clearanceProfile(at);
    return {
      name: 'valley flight',
      duration: 24,
      pose: (u, pos, look) => {
        const [px, pz] = at(u);
        pos.set(px, floor(u) + 40, pz);
        const [ax, az] = at(Math.min(1, u + 0.25));
        const dx = ax - px,
          dz = az - pz;
        const d = Math.hypot(dx, dz) || 1;
        // Look far down-valley, only slightly down, so the far peaks frame the shot.
        look.set(px + (dx / d) * 1100, pos.y - 70, pz + (dz / d) * 1100);
      },
    };
  }
}
