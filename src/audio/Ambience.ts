// State-driven ambience: continuous beds (real-time nodes fed by looping precomputed noise) and scheduled
// positional one-shots (forest creaks, birds, owls, distant wolves, lake ice), plus the low-health heartbeat.
//
//   wind rumble L/R, gust body, whistle L/R, blizzard ─► windBus ─► shelter low-pass ─┐
//   forest "shhh" L/R, speed rush, buffet              ─► lifeBus ───────────────────┼─► out ─► ambience bus
import type { GameContext, GameState, SoundId } from '../core/types';
import { clamp01, damp } from '../core/math';
import type { SoundBank } from './Bank';
import type { Mixer } from './Mixer';
import type { Voices } from './Voices';

/** Smoothed random value in [0,1], re-targeted every `period` seconds (gusts, wandering whistles). No allocation. */
class Drift {
  private a = Math.random();
  private b = Math.random();
  private t = Math.random();
  value = 0.5;
  constructor(private period: number) {}
  step(dt: number): number {
    this.t += dt / this.period;
    while (this.t >= 1) {
      this.t -= 1;
      this.a = this.b;
      this.b = Math.random();
    }
    const f = this.t;
    this.value = this.a + (this.b - this.a) * f * f * (3 - 2 * f);
    return this.value;
  }
}

const rand = (a: number, b: number) => a + (b - a) * Math.random();

interface PendingHowl {
  at: number; // ctx.time seconds
  x: number;
  y: number;
  z: number;
  active: boolean;
}

export class Ambience {
  private started = false;
  private out!: GainNode;
  private windBus!: GainNode;
  private shelterLP!: BiquadFilterNode;
  private lifeBus!: GainNode;
  // Wind
  private lowF: BiquadFilterNode[] = [];
  private lowG: GainNode[] = [];
  private bodyF!: BiquadFilterNode;
  private bodyG!: GainNode;
  private whisF: BiquadFilterNode[] = [];
  private whisG: GainNode[] = [];
  private blizF!: BiquadFilterNode;
  private blizG!: GainNode;
  // Life
  private forestG: GainNode[] = [];
  private rushF!: BiquadFilterNode;
  private rushG!: GainNode;
  private buffetG!: GainNode;

  private gust = [new Drift(11), new Drift(4.3), new Drift(1.7)];
  private whisDrift = [new Drift(7), new Drift(9)];
  private buffetDrift = new Drift(0.18);
  private ws = 0.2;
  private bliz = 0;
  private density = 0;
  private speedF = 0;
  private tick = 0;
  private densityTimer = 0;

  // Event timers (seconds)
  private tForest = rand(6, 14);
  private tWolf = rand(40, 90);
  private tOwl = rand(20, 50);
  private tBird = rand(4, 12);
  private tIce = rand(10, 30);
  private tIceFar = rand(60, 150);
  private howls: PendingHowl[] = [];
  private wasNight = false;

  // Heartbeat scheduling (AudioContext time)
  private nextBeat = 0;
  private beating = false;

  // Tree sampling scratch (class fields so the forEachTree callbacks allocate nothing)
  private qx = 0;
  private qz = 0;
  private qAcc = 0;
  private pickMin = 0;
  private pickMax = 0;
  private pickCount = 0;
  private pickIdx = -1;

  constructor(private ctx: GameContext, private ac: AudioContext, private mixer: Mixer, private bank: SoundBank, private voices: Voices) {
    for (let i = 0; i < 3; i++) this.howls.push({ at: 0, x: 0, y: 0, z: 0, active: false });
  }

  /** Build the beds once the noise loops exist. Safe to call repeatedly. */
  tryStart(): boolean {
    if (this.started) return true;
    const pinkA = this.bank.misc.get('noise:pinkA');
    const pinkB = this.bank.misc.get('noise:pinkB');
    const brownA = this.bank.misc.get('noise:brownA');
    const brownB = this.bank.misc.get('noise:brownB');
    if (!pinkA || !pinkB || !brownA || !brownB || this.ac.state === 'closed') return false;
    const ac = this.ac;
    this.out = ac.createGain();
    this.out.gain.value = 0;
    this.out.connect(this.mixer.bus.ambience);
    this.windBus = ac.createGain();
    this.shelterLP = ac.createBiquadFilter();
    this.shelterLP.type = 'lowpass';
    this.shelterLP.frequency.value = 20000;
    this.shelterLP.Q.value = 0.5;
    this.windBus.connect(this.shelterLP).connect(this.out);
    this.lifeBus = ac.createGain();
    this.lifeBus.gain.value = 0;
    this.lifeBus.connect(this.out);

    const layer = (buf: AudioBuffer, type: BiquadFilterType, f: number, q: number, pan: number, dest: AudioNode): [BiquadFilterNode, GainNode] => {
      const src = ac.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const flt = ac.createBiquadFilter();
      flt.type = type;
      flt.frequency.value = f;
      flt.Q.value = q;
      const g = ac.createGain();
      g.gain.value = 0;
      src.connect(flt).connect(g);
      if (pan !== 0) {
        const p = ac.createStereoPanner();
        p.pan.value = pan;
        g.connect(p).connect(dest);
      } else g.connect(dest);
      src.start(0, Math.random() * buf.duration);
      return [flt, g];
    };

    // Two decorrelated noise loops panned apart give the wind width without any stereo processing.
    for (const [buf, pan] of [[brownA, -0.7], [brownB, 0.7]] as const) {
      const [f, g] = layer(buf, 'lowpass', 300, 0.6, pan, this.windBus);
      this.lowF.push(f);
      this.lowG.push(g);
    }
    [this.bodyF, this.bodyG] = layer(pinkA, 'bandpass', 900, 0.8, 0, this.windBus);
    for (const [buf, pan] of [[pinkB, -0.5], [pinkA, 0.5]] as const) {
      const [f, g] = layer(buf, 'bandpass', 1100, 9, pan, this.windBus);
      this.whisF.push(f);
      this.whisG.push(g);
    }
    // Blizzard: a low roaring band plus a hiss of driven snow, summed into one gain.
    const blizBus = ac.createGain();
    blizBus.gain.value = 1;
    blizBus.connect(this.windBus);
    [this.blizF, this.blizG] = layer(brownB, 'bandpass', 500, 1.6, -0.2, blizBus);
    // The driven-snow hiss feeds the roar's gain node, so one automation drives both.
    const [, hissG] = layer(pinkB, 'highpass', 2600, 0.7, 0, this.blizG);
    hissG.gain.value = 0.35;

    for (const [buf, pan] of [[pinkA, -0.6], [pinkB, 0.6]] as const) {
      const [, g] = layer(buf, 'bandpass', 2600, 0.6, pan, this.lifeBus);
      this.forestG.push(g);
    }
    [this.rushF, this.rushG] = layer(pinkB, 'bandpass', 400, 0.7, 0, this.lifeBus);
    [, this.buffetG] = layer(brownA, 'lowpass', 160, 0.7, 0, this.lifeBus);
    this.started = true;
    return true;
  }

  reset() {
    this.tForest = rand(6, 14);
    this.tWolf = rand(40, 90);
    this.tOwl = rand(20, 50);
    this.tBird = rand(4, 12);
    this.tIce = rand(10, 30);
    this.tIceFar = rand(60, 150);
    for (const h of this.howls) h.active = false;
    this.beating = false;
  }

  /** Night just fell: bring the first wolves in sooner. */
  onNight() {
    this.tWolf = Math.min(this.tWolf, rand(15, 40));
    this.tOwl = Math.min(this.tOwl, rand(10, 30));
  }

  update(dt: number, state: GameState) {
    if (!this.started && !this.tryStart()) return;
    const ctx = this.ctx;
    const now = this.ac.currentTime;
    const playing = state === 'playing';

    // --- continuous parameters at ~20 Hz (smoothed with setTargetAtTime: no zipper, few automation events)
    for (const g of this.gust) g.step(dt);
    for (const w of this.whisDrift) w.step(dt);
    this.buffetDrift.step(dt);
    this.ws = damp(this.ws, clamp01(ctx.env.windStrength), 0.6, dt);
    const blizTarget = Math.max(ctx.env.weather === 'blizzard' ? 1 : 0, clamp01(ctx.env.snowfall) * 0.3);
    this.bliz = damp(this.bliz, blizTarget, 0.25, dt);
    const p = ctx.player;
    const v = Math.hypot(p.velocity.x, p.velocity.y, p.velocity.z);
    // Wind in the ears: starts around 15 km/h, strong by ~80 km/h (speed² feel).
    const sp = clamp01((v - 4.2) / (22.2 - 4.2));
    const rushTarget = playing && (p.onSkis || p.mode === 'air') ? sp * sp : 0;
    this.speedF = damp(this.speedF, rushTarget, 6, dt);

    this.densityTimer -= dt;
    if (this.densityTimer <= 0) {
      this.densityTimer = 0.35;
      this.sampleDensity();
    }

    this.tick += dt;
    if (this.tick >= 0.05) {
      this.tick = 0;
      this.applyBeds(now, state);
    }

    if (playing) this.events(dt);
    else for (const h of this.howls) h.active = false;
    this.heartbeat(now, playing);
  }

  private applyBeds(now: number, state: GameState) {
    const tc = 0.12;
    const ws = this.ws;
    const g0 = this.gust[0].value,
      g1 = this.gust[1].value,
      g2 = this.gust[2].value;
    // Irregular gust envelope: slow swells with faster flurries riding on top, strongest in high wind.
    const gust = clamp01(0.55 * g0 + 0.3 * g1 + 0.15 * g2);
    const gustier = clamp01((gust - 0.35) * (0.8 + ws));
    for (let i = 0; i < 2; i++) {
      this.lowG[i].gain.setTargetAtTime((0.12 + 0.55 * ws) * (0.55 + 0.7 * gust) * 0.5, now, tc);
      this.lowF[i].frequency.setTargetAtTime(170 + 260 * ws * gust + 40 * i, now, tc);
      const wf = 650 + 700 * this.whisDrift[i].value + 500 * ws * gust;
      this.whisF[i].frequency.setTargetAtTime(wf, now, 0.25);
      this.whisG[i].gain.setTargetAtTime(ws * ws * (0.05 + 1.3 * gustier * gustier) * 1.6, now, tc);
    }
    this.bodyG.gain.setTargetAtTime(Math.pow(ws, 1.4) * (0.25 + 0.9 * gust) * 0.4, now, tc);
    this.bodyF.frequency.setTargetAtTime(600 + 700 * gust * ws, now, tc);
    this.blizG.gain.setTargetAtTime(this.bliz * (0.5 + 0.7 * gust) * 0.9, now, tc);
    this.blizF.frequency.setTargetAtTime(380 + 420 * gust, now, tc);

    // Shelter/indoors muffles the wind (only meaningful while playing).
    const p = this.ctx.player;
    const shelter = state === 'playing' ? clamp01(p.shelter + (p.indoors ? 0.6 : 0)) : 0;
    this.shelterLP.frequency.setTargetAtTime(20000 * Math.pow(0.05, shelter), now, 0.3);
    this.windBus.gain.setTargetAtTime(1 - 0.55 * shelter, now, 0.3);

    // Forest needles hiss with the wind, only where there are trees.
    const life = state === 'playing' ? 1 : 0;
    const fg = this.density * (0.15 + 0.85 * ws) * (0.5 + 0.7 * gust) * 0.28;
    for (let i = 0; i < 2; i++) this.forestG[i].gain.setTargetAtTime(fg, now, 0.3);
    this.rushG.gain.setTargetAtTime(this.speedF * 1.1, now, 0.08);
    this.rushF.frequency.setTargetAtTime(350 + 1600 * Math.sqrt(this.speedF), now, 0.08);
    this.buffetG.gain.setTargetAtTime(this.speedF * this.speedF * (0.4 + 0.6 * this.buffetDrift.value) * 0.9, now, 0.05);
    this.lifeBus.gain.setTargetAtTime(life, now, 0.5);

    // Overall: silent at boot, ducked in pause, wind-only in menu and on the death screen.
    const outLevel = state === 'boot' ? 0 : state === 'paused' ? 0.3 : 1;
    this.out.gain.setTargetAtTime(outLevel, now, state === 'paused' ? 0.25 : 0.8);
  }

  /** Tree density near the listener (0..1): a handful of times per second, never per frame. */
  private sampleDensity() {
    const { world, terrain, camera } = this.ctx;
    if (!world || !terrain) return;
    const x = camera.position.x,
      z = camera.position.z;
    this.qx = x;
    this.qz = z;
    this.qAcc = 0;
    world.forEachTree(x, z, 40, this.densityVisitor);
    // The menu camera flies high above the forest: fade the forest out with height above ground.
    const agl = camera.position.y - terrain.heightAt(x, z);
    const target = clamp01(this.qAcc / 18) * (1 - clamp01((agl - 15) / 40));
    this.density = this.density + (target - this.density) * 0.5;
  }

  private densityVisitor = (i: number) => {
    const w = this.ctx.world;
    const dx = w.treeX[i] - this.qx,
      dz = w.treeZ[i] - this.qz;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < 40) this.qAcc += 1 - d / 40;
  };

  /** Reservoir-sample one living tree in the ring [min, max] around the listener; -1 if none. */
  private pickTree(min: number, max: number): number {
    const c = this.ctx.camera.position;
    this.qx = c.x;
    this.qz = c.z;
    this.pickMin = min;
    this.pickMax = max;
    this.pickCount = 0;
    this.pickIdx = -1;
    this.ctx.world.forEachTree(c.x, c.z, max, this.pickVisitor);
    return this.pickIdx;
  }

  private pickVisitor = (i: number) => {
    const w = this.ctx.world;
    const dx = w.treeX[i] - this.qx,
      dz = w.treeZ[i] - this.qz;
    const d2 = dx * dx + dz * dz;
    if (d2 < this.pickMin * this.pickMin || d2 > this.pickMax * this.pickMax) return;
    this.pickCount++;
    if (Math.random() * this.pickCount < 1) this.pickIdx = i;
  };

  private playAtTree(id: SoundId, tree: number, hMin: number, hMax: number, volume = 1) {
    const w = this.ctx.world;
    const h = Math.min(w.treeHeight(tree) * 0.8, rand(hMin, hMax));
    this.voices.play(id, { position: { x: w.treeX[tree], y: w.treeY[tree] + h, z: w.treeZ[tree] }, volume }, 'ambience');
  }

  private events(dt: number) {
    const { clock, env, terrain, camera } = this.ctx;
    const night = clock.isNight;
    if (night && !this.wasNight) this.onNight();
    this.wasNight = night;
    const forest = this.density;

    // Forest life: creaks under wind load, snow sliding off boughs, the odd snapping branch.
    this.tForest -= dt * (forest > 0.2 ? 0.5 + forest : 0);
    if (this.tForest <= 0) {
      this.tForest = rand(8, 30);
      const tree = this.pickTree(15, 60);
      if (tree >= 0) {
        const r = Math.random();
        if (r < 0.2 + 0.35 * this.ws) this.playAtTree('wood_creak', tree, 3, 9, 0.8 + 0.4 * this.ws);
        else if (r < 0.62) this.playAtTree('snow_thump', tree, 4, 10);
        else this.playAtTree('branch_snap', tree, 2, 8, 0.7);
      }
    }

    // Birds by day in the forest (not in a blizzard).
    this.tBird -= dt * (!night && forest > 0.15 && env.weather !== 'blizzard' ? 1 : 0);
    if (this.tBird <= 0) {
      this.tBird = rand(6, 20);
      const tree = this.pickTree(15, 70);
      if (tree >= 0) {
        this.playAtTree(Math.random() < 0.12 ? 'bird_flap' : 'bird_call', tree, 5, 12, 0.8);
        // Sometimes a second bird answers from elsewhere.
        if (Math.random() < 0.3) this.tBird = rand(0.8, 2.5);
      }
    }

    // Owls at night in the forest.
    this.tOwl -= dt * (night && forest > 0.2 ? 1 : 0);
    if (this.tOwl <= 0) {
      this.tOwl = rand(25, 70);
      const tree = this.pickTree(30, 120);
      if (tree >= 0) this.playAtTree('owl', tree, 6, 12, 0.9);
    }

    // Distant wolves at night: a howl far down the valley, sometimes answered by one or two others.
    this.tWolf -= dt * (night ? 1 : 0);
    if (this.tWolf <= 0) {
      this.tWolf = rand(50, 140);
      const a = Math.random() * Math.PI * 2;
      const d = rand(250, 600);
      this.howlAt(camera.position.x + Math.cos(a) * d, camera.position.z + Math.sin(a) * d, 0);
      const answers = Math.random() < 0.6 ? (Math.random() < 0.5 ? 1 : 2) : 0;
      for (let k = 0; k < answers; k++) {
        const a2 = a + (Math.random() < 0.5 ? -1 : 1) * rand(0.2, 0.9);
        const d2 = d + rand(-100, 180);
        this.howlAt(camera.position.x + Math.cos(a2) * d2, camera.position.z + Math.sin(a2) * d2, k === 0 ? rand(1.5, 5) : rand(4, 9));
      }
    }
    for (const h of this.howls) {
      if (!h.active || this.ctx.time < h.at) continue;
      h.active = false;
      this.voices.play('wolf_howl', { position: { x: h.x, y: h.y, z: h.z }, volume: rand(0.8, 1), pitchVar: 0.08 }, 'ambience');
    }

    // Lake ice: eerie cracks when out on (or near) the lake, and occasionally far off at night.
    const lake = terrain.lakeFactor(camera.position.x, camera.position.z);
    this.tIce -= dt * (lake > 0.3 ? 1 : 0);
    if (this.tIce <= 0) {
      this.tIce = rand(12, 45);
      this.iceNear();
    }
    this.tIceFar -= dt * (night && lake <= 0.3 ? 1 : 0);
    if (this.tIceFar <= 0) {
      this.tIceFar = rand(90, 240);
      const [lx, lz] = terrain.data.lakeCenter;
      const a = Math.random() * Math.PI * 2;
      const r = rand(0, 150);
      const x = lx + Math.cos(a) * r,
        z = lz + Math.sin(a) * r;
      if (terrain.lakeFactor(x, z) > 0.5) this.voices.play('ice_crack', { position: { x, y: terrain.lakeLevel, z }, volume: 1 }, 'ambience');
    }
  }

  private howlAt(x: number, z: number, delay: number) {
    const t = this.ctx.terrain;
    const lim = t.half - 40;
    x = Math.min(lim, Math.max(-lim, x));
    z = Math.min(lim, Math.max(-lim, z));
    for (const h of this.howls) {
      if (h.active) continue;
      h.active = true;
      h.at = this.ctx.time + delay;
      h.x = x;
      h.z = z;
      h.y = t.heightAt(x, z) + 1.2;
      return;
    }
  }

  private iceNear() {
    const t = this.ctx.terrain;
    const c = this.ctx.camera.position;
    for (let k = 0; k < 6; k++) {
      const a = Math.random() * Math.PI * 2;
      const d = rand(40, 300);
      const x = c.x + Math.cos(a) * d,
        z = c.z + Math.sin(a) * d;
      if (t.lakeFactor(x, z) > 0.5) {
        this.voices.play('ice_crack', { position: { x, y: t.lakeLevel, z }, volume: rand(0.6, 1) }, 'ambience');
        return;
      }
    }
  }

  /** Low-health heartbeat: beats scheduled ahead on the audio clock; rate and volume rise as health drops. */
  private heartbeat(now: number, playing: boolean) {
    const p = this.ctx.player;
    // If gameplay code already runs its own heartbeat loop, don't double it.
    const want = playing && p.alive && p.health < 30 && this.ac.state === 'running' && !this.voices.loopActive('heartbeat');
    if (!want) {
      this.beating = false;
      return;
    }
    const k = clamp01((30 - p.health) / 30);
    if (!this.beating || this.nextBeat < now - 0.2) {
      this.beating = true;
      this.nextBeat = now + 0.05;
    }
    while (this.nextBeat < now + 0.25) {
      this.voices.scheduleAt('heartbeat', this.nextBeat, 0.35 + 0.65 * k, 1 + 0.08 * k, 'sfx');
      this.nextBeat += 1.05 - 0.5 * k; // ~57 → ~110 bpm
    }
  }
}
