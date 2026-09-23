// Deterministic physics validation: runs the real Locomotion against analytic planes at a fixed
// 60 Hz step and reports the numbers we tune against. Run from the console / tools/shot.mjs:
//   fl.ctx.sys.player.runPhysicsTests()
import { EventBus } from '../core/Events';
import { PlayerState } from '../core/PlayerState';
import type { DevParams } from '../core/types';
import { DEG } from '../core/math';
import type { SurfaceKind } from '../core/Terrain';
import { makeControls, type Controls } from './Controls';
import { PlaneGround } from './Ground';
import { Locomotion, NO_HOOKS, type LocoHooks } from './Locomotion';
import { GRAVITY } from './tuning';

const DT = 1 / 60;
const KMH = 1 / 3.6;

interface Rig {
  p: PlayerState;
  g: PlaneGround;
  loco: Locomotion;
  c: Controls;
  log: { crashes: string[]; lands: number[] };
}

function rig(slopeDeg: number, skis: boolean, surface: SurfaceKind = 'snow'): Rig {
  const dev = { god: true, fly: false, params: new URLSearchParams() } as unknown as DevParams;
  const p = new PlayerState(new EventBus(), dev);
  const g = new PlaneGround(slopeDeg * DEG, surface);
  const loco = new Locomotion(p, g);
  const log = { crashes: [] as string[], lands: [] as number[] };
  const hooks: LocoHooks = {
    ...NO_HOOKS,
    crash: (speed, reason) => log.crashes.push(`${reason}@${(speed * 3.6).toFixed(0)}km/h`),
    land: (impact) => log.lands.push(+impact.toFixed(2)),
  };
  loco.hooks = hooks;
  p.position.set(0, 0, 0);
  p.onSkis = skis;
  p.mode = skis ? 'ski' : 'walk';
  p.yaw = p.heading = 0;
  loco.reset();
  const c = makeControls();
  c.steerYaw = 0;
  return { p, g, loco, c, log };
}

/** Start sliding at `kmh` along the ski heading on the plane (tangent to the slope). */
function launch(r: Rig, kmh: number) {
  const th = r.g.slope;
  const v = kmh * KMH;
  const hx = -Math.sin(r.p.heading),
    hz = -Math.cos(r.p.heading);
  // Plane height = z * tan(th): moving by dz changes height by dz * tan(th).
  const vy = hz * Math.tan(th);
  const l = Math.hypot(hx, vy, hz);
  r.p.velocity.set((hx / l) * v, (vy / l) * v, (hz / l) * v);
}

function run(r: Rig, seconds: number, each?: (t: number) => boolean | void) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    r.loco.update(DT, r.c);
    r.c.jumpPressed = r.c.jumpReleased = r.c.toggleSkis = false;
    if (each && each((i + 1) * DT)) return (i + 1) * DT;
  }
  return seconds;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export function runPhysicsTests() {
  const out: Record<string, unknown> = {};

  // 1. Straight run down a 25° slope: time to 60 / 100 km/h, terminal speed, upright vs tuck.
  for (const tuck of [false, true]) {
    const r = rig(25, true);
    r.c.sprint = tuck;
    launch(r, 10); // tuck needs a little speed
    let t60 = -1,
      t100 = -1;
    run(r, 60, (t) => {
      const v = r.p.velocity.length();
      if (t60 < 0 && v >= 60 * KMH) t60 = t;
      if (t100 < 0 && v >= 100 * KMH) t100 = t;
    });
    out[tuck ? 'slope25_tuck' : 'slope25_upright'] = {
      t60kmh: r2(t60),
      t100kmh: r2(t100),
      terminalKmh: r2(r.p.velocity.length() * 3.6),
      crashes: r.log.crashes,
    };
  }

  // 2. Snowplow stop from 50 km/h on the flat.
  {
    const r = rig(0, true);
    r.p.velocity.set(0, 0, -50 * KMH);
    r.c.moveY = -1;
    const t = run(r, 30, () => r.p.velocity.length() < 0.2);
    out.snowplowStop50 = { distance: r2(-r.p.position.z), seconds: r2(t) };
  }
  // 2b. Glide out (no input) from 50 km/h on the flat.
  {
    const r = rig(0, true);
    r.p.velocity.set(0, 0, -50 * KMH);
    const t = run(r, 120, () => r.p.velocity.length() < 0.2);
    out.glideOut50 = { distance: r2(-r.p.position.z), seconds: r2(t) };
  }

  // 3. Hockey stop from 50 km/h: (a) look 90° to the side, (b) back + right keys.
  {
    const r = rig(0, true);
    r.p.velocity.set(0, 0, -50 * KMH);
    r.c.steerYaw = -Math.PI / 2;
    const t = run(r, 20, () => r.p.velocity.length() < 0.3);
    out.hockeyStopLook50 = { distance: r2(Math.hypot(r.p.position.x, r.p.position.z)), seconds: r2(t), crashes: r.log.crashes };
  }
  {
    const r = rig(0, true);
    r.p.velocity.set(0, 0, -50 * KMH);
    r.c.moveY = -1;
    r.c.moveX = 1;
    const t = run(r, 20, () => r.p.velocity.length() < 0.3);
    out.hockeyStopKeys50 = { distance: r2(Math.hypot(r.p.position.x, r.p.position.z)), seconds: r2(t) };
  }

  // 4. Carving: slalom on 18° at speed; max centripetal g while the edges hold (no skid).
  {
    const r = rig(18, true);
    launch(r, 70);
    let maxG = 0,
      maxGSkid = 0,
      minV = 1e9,
      maxV = 0;
    let dir = 1;
    run(r, 12, (t) => {
      if (Math.floor(t / 1.6) % 2 === 0) dir = 1;
      else dir = -1;
      r.c.steerYaw = dir * 0.5; // within the carve envelope
      const g = Math.abs(r.loco.latAcc) / GRAVITY;
      if (r.loco.skidSpeed < 0.3) maxG = Math.max(maxG, g);
      else maxGSkid = Math.max(maxGSkid, g);
      const v = r.p.velocity.length();
      if (t > 2) {
        minV = Math.min(minV, v);
        maxV = Math.max(maxV, v);
      }
    });
    out.slalom18 = { maxCarveG: r2(maxG), maxSkidG: r2(maxGSkid), speedRangeKmh: [r2(minV * 3.6), r2(maxV * 3.6)], crashes: r.log.crashes };
  }
  // 4b. Max carve: at 60 km/h on 12° the look leads the skis by a constant 0.4 rad (inside the carve
  //     envelope), with and without the edge key. Reports centripetal g and turn radius.
  for (const edge of [false, true]) {
    const r = rig(12, true);
    r.p.heading = 0.6; // start across the fall line a little so the turn stays on the slope
    launch(r, 60);
    r.c.moveX = edge ? -1 : 0;
    let maxG = 0,
      skid = 0,
      radius = 1e9;
    run(r, 1.2, () => {
      r.c.steerYaw = r.p.heading + 0.4;
      maxG = Math.max(maxG, Math.abs(r.loco.latAcc) / GRAVITY);
      skid = Math.max(skid, r.loco.skidSpeed);
      if (Math.abs(r.loco.turnRate) > 1e-3) radius = Math.min(radius, r.p.velocity.length() / Math.abs(r.loco.turnRate));
    });
    out[edge ? 'carve60_edgeKey' : 'carve60'] = { maxG: r2(maxG), minRadiusM: r2(radius), maxSkidMs: r2(skid), endKmh: r2(r.p.velocity.length() * 3.6) };
  }

  // 5. Ollie on the flat: hold 0.6 s, release; peak height.
  {
    const r = rig(0, true);
    r.p.velocity.set(0, 0, -5);
    r.c.jump = true;
    run(r, 0.6);
    r.c.jump = false;
    r.c.jumpReleased = true;
    let peak = 0,
      air = 0;
    run(r, 3, () => {
      peak = Math.max(peak, r.p.position.y - r.g.height(0, 0, r.p.position.z));
      if (!r.p.grounded) air += DT;
      return r.p.grounded && air > 0.1;
    });
    out.ollieCharged = { peakM: r2(peak), airS: r2(air) };
    const q = rig(0, true);
    q.p.velocity.set(0, 0, -5);
    q.c.jump = true;
    run(q, 1 / 60);
    q.c.jump = false;
    q.c.jumpReleased = true;
    let peak2 = 0;
    run(q, 2, () => {
      peak2 = Math.max(peak2, q.p.position.y - q.g.height(0, 0, q.p.position.z));
    });
    out.ollieTap = { peakM: r2(peak2) };
  }

  // 6. Walking: speeds on the flat, and climbing.
  {
    const w = rig(0, false);
    w.c.moveY = 1;
    let tTo = -1;
    run(w, 3, (t) => {
      if (tTo < 0 && w.p.speed > 1.7 * 0.82 * 0.95) tTo = t;
    });
    const walk = w.p.speed;
    w.c.sprint = true;
    run(w, 3);
    const sprint = w.p.speed;
    const stam = w.p.stamina;
    w.c.sprint = false;
    w.c.crouch = true;
    run(w, 2);
    out.walkFlat = { walk: r2(walk), timeTo95pct: r2(tTo), sprint: r2(sprint), crouch: r2(w.p.speed), staminaAfter3sSprint: r2(stam), note: 'deep snow x0.82' };
  }
  for (const deg of [30, 38, 45]) {
    const w = rig(deg, false);
    w.p.yaw = w.p.heading = Math.PI; // face uphill (+Z)
    w.c.steerYaw = Math.PI;
    w.c.moveY = 1;
    const y0 = w.p.position.y;
    run(w, 5);
    out['walkUp' + deg] = { climbedM: r2(w.p.position.y - y0), sliding: w.loco.sliding };
  }

  // 6b. Structures: walk onto a 0.35 m foundation (step up), blocked by a 0.8 m one.
  for (const top of [0.35, 0.8]) {
    const w = rig(0, false);
    w.g.ledge = { x0: -2, x1: 2, z0: -8, z1: -4, top };
    w.c.moveY = 1;
    run(w, 5);
    out['foundation' + top] = { feetY: r2(w.p.position.y), z: r2(w.p.position.z), onTop: Math.abs(w.p.position.y - top) < 0.01, surface: w.p.surface };
  }

  // 7. Ice: glide on a 5° frozen slope vs snow.
  for (const surf of ['snow', 'ice'] as const) {
    const r = rig(5, true, surf);
    run(r, 20);
    out['glide5_' + surf] = { kmhAfter20s: r2(r.p.velocity.length() * 3.6) };
  }

  // 8. Landings on skis: flat drop from 2 m and 6 m; kicker onto a 30° downslope.
  for (const h of [2, 6]) {
    const r = rig(0, true);
    r.p.velocity.set(0, 0, -10);
    r.p.position.y = h;
    r.p.grounded = false;
    run(r, 2);
    out['dropFlat' + h + 'm'] = { impacts: r.log.lands, crashes: r.log.crashes };
  }
  {
    const r = rig(30, true);
    r.p.velocity.set(0, 0, -15); // horizontal 54 km/h off a lip 4 m above a 30° slope
    r.p.position.y = 4;
    r.p.grounded = false;
    run(r, 3);
    out.landDownslope30 = { impacts: r.log.lands, crashes: r.log.crashes };
  }
  {
    // Sideways landing at speed catches an edge.
    const r = rig(10, true);
    r.p.velocity.set(0, 0, -15);
    r.p.position.y = 2;
    r.p.grounded = false;
    r.p.heading = Math.PI / 2;
    r.c.steerYaw = Math.PI / 2;
    run(r, 2);
    out.landSideways = { crashes: r.log.crashes };
  }
  // 9. Tree impact at 40 km/h.
  {
    const r = rig(0, true);
    r.g.wallZ = -8;
    r.p.velocity.set(0, 0, -40 * KMH);
    run(r, 2);
    out.treeImpact40 = { crashes: r.log.crashes };
  }
  // 10. Standing still across a 30° slope holds (edges), facing down it slides.
  {
    const r = rig(30, true);
    r.p.heading = Math.PI / 2;
    r.c.steerYaw = Math.PI / 2;
    run(r, 3);
    out.standAcross30 = { driftM: r2(r.p.position.length()) };
  }
  return out;
}
