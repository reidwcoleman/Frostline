// Voice management: one-shots (pooled records, global + per-sound limits, oldest-quietest stealing, distance
// culling) and loop handles (smooth volume/pitch/position, air absorption, fade-out cull beyond maxDistance).
//
// Positional chain:  source → gain → air-absorption low-pass → HRTF panner → category bus
//                                                   └→ send gain → category reverb send
import * as THREE from 'three';
import type { LoopHandle, PlayOpts, SoundId, Vec3Like } from '../core/types';
import { SOUNDS, SOUND_IDS, type SoundDef } from './sounds';
import type { SoundBank } from './Bank';
import type { BusId, Mixer } from './Mixer';

const MAX_VOICES = 40;
const DEFAULT_MAX_INSTANCES = 6;
const DEFAULT_REF = 2;
const DEFAULT_MAX = 120;
const DEFAULT_PITCH_VAR = 0.04;

/** Air absorption: ~18 kHz next to the source, ~2.5 kHz at 400 m, never below 700 Hz. */
export function airCutoff(d: number): number {
  return Math.max(700, 18000 * Math.pow(2500 / 18000, Math.max(0, d) / 400));
}

/** The PannerNode 'inverse' model, so our culling/sends agree with what the panner does. */
export function distanceGain(d: number, ref: number, rolloff: number): number {
  return ref / (ref + rolloff * (Math.max(d, ref) - ref));
}

/** Reverb send for a positional sound: wet falls off slower than dry, so distant things sound distant. */
function sendLevel(def: SoundDef, d: number, positional: boolean): number {
  const base = def.reverbSend ?? 0;
  if (!positional) return base;
  const far = Math.min(1, Math.max(0, (d - 20) / 280));
  return (base + 0.08 * far) * Math.sqrt(distanceGain(d, def.refDistance ?? DEFAULT_REF, def.rolloff ?? 1));
}

function setPannerPosition(p: PannerNode, x: number, y: number, z: number) {
  if (p.positionX) {
    p.positionX.value = x;
    p.positionY.value = y;
    p.positionZ.value = z;
  } else {
    (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
  }
}

function makePanner(ac: AudioContext, def: SoundDef): PannerNode {
  const p = ac.createPanner();
  p.panningModel = 'HRTF';
  p.distanceModel = 'inverse';
  p.refDistance = def.refDistance ?? DEFAULT_REF;
  p.maxDistance = Math.max(def.maxDistance ?? DEFAULT_MAX, p.refDistance + 1);
  p.rolloffFactor = def.rolloff ?? 1;
  return p;
}

const finite = (v: Vec3Like | undefined): v is Vec3Like =>
  !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

interface Voice {
  active: boolean;
  /** Bumped every reuse so a stale onended from a stolen voice can't free the new occupant. */
  gen: number;
  idx: number; // sound index
  start: number;
  end: number;
  level: number;
  src: AudioBufferSourceNode | null;
  gain: GainNode | null;
}

export class Voices {
  /** Listener position (world), written by Audio.update() every frame. */
  readonly listener = new THREE.Vector3();
  private pool: Voice[] = [];
  private active = 0;
  private counts: Int16Array;
  private lastVariant: Int16Array;
  private index = new Map<SoundId, number>();
  private loops: LoopVoice[] = [];
  private pending: LoopVoice[] = [];
  private loopTimer = 0;
  private readonly tmp = new THREE.Vector3();

  constructor(readonly ac: AudioContext, readonly mixer: Mixer, readonly bank: SoundBank) {
    for (let i = 0; i < MAX_VOICES; i++) this.pool.push({ active: false, gen: 0, idx: -1, start: 0, end: 0, level: 0, src: null, gain: null });
    SOUND_IDS.forEach((id, i) => this.index.set(id, i));
    this.counts = new Int16Array(SOUND_IDS.length);
    this.lastVariant = new Int16Array(SOUND_IDS.length).fill(-1);
  }

  get activeCount() {
    return this.active;
  }

  /** Random variant, never the same one twice in a row. */
  private pickVariant(id: SoundId, idx: number): AudioBuffer | undefined {
    const av = this.bank.available(id);
    if (!av.length) return undefined;
    let v = av[0];
    if (av.length > 1) {
      const last = this.lastVariant[idx];
      do v = av[Math.floor(Math.random() * av.length)];
      while (v === last);
    }
    this.lastVariant[idx] = v;
    return this.bank.variant(id, v);
  }

  play(id: SoundId, opts: PlayOpts | undefined, bus?: BusId): void {
    const ac = this.ac;
    if (ac.state !== 'running') return; // suspended: skip rather than queue a burst for later
    const def = SOUNDS[id];
    const idx = this.index.get(id);
    if (!def || idx === undefined) return;
    const vol = opts?.volume ?? 1;
    if (!(vol > 0) || !Number.isFinite(vol)) return;
    const pos = finite(opts?.position) ? opts!.position : undefined;
    let d = 0;
    let level = vol;
    if (pos) {
      d = this.tmp.set(pos.x, pos.y, pos.z).distanceTo(this.listener);
      if (d > (def.maxDistance ?? DEFAULT_MAX)) return; // cheap cull: inaudible anyway
      level *= distanceGain(d, def.refDistance ?? DEFAULT_REF, def.rolloff ?? 1);
    }
    const buf = this.pickVariant(id, idx);
    if (!buf) return;

    // Per-sound limit: steal the oldest instance of this sound.
    if (this.counts[idx] >= (def.maxInstances ?? DEFAULT_MAX_INSTANCES)) {
      let oldest: Voice | null = null;
      for (const v of this.pool) if (v.active && v.idx === idx && (!oldest || v.start < oldest.start)) oldest = v;
      if (oldest) this.steal(oldest);
    }
    let slot = this.freeSlot();
    if (!slot) {
      // Global limit: steal whichever voice has the least left to contribute (quiet and nearly finished).
      const now = ac.currentTime;
      let worst: Voice | null = null;
      let worstScore = Infinity;
      for (const v of this.pool) {
        if (!v.active) continue;
        const remain = Math.max(0, (v.end - now) / Math.max(1e-3, v.end - v.start));
        const score = v.level * (0.25 + remain);
        if (score < worstScore) {
          worstScore = score;
          worst = v;
        }
      }
      if (!worst || worstScore > level * 1.25) return; // everything playing matters more than this
      this.steal(worst);
      slot = this.freeSlot();
      if (!slot) return;
    }

    const pv = opts?.pitchVar ?? def.pitchVar ?? DEFAULT_PITCH_VAR;
    const rate = Math.min(4, Math.max(0.25, (opts?.pitch ?? 1) * (1 + (Math.random() * 2 - 1) * pv)));
    const now = ac.currentTime;
    const target = bus ?? def.category;
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ac.createGain();
    const dur = buf.duration / rate;
    if (def.loop) {
      // A seamless loop buffer played once has live edges: fade them.
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(vol, now + 0.03);
      g.gain.setValueAtTime(vol, now + Math.max(0.04, dur - 0.08));
      g.gain.linearRampToValueAtTime(0, now + dur);
    } else {
      g.gain.value = vol;
    }
    src.connect(g);
    let lp: BiquadFilterNode | null = null;
    let pn: PannerNode | null = null;
    let tap: AudioNode = g;
    if (pos) {
      lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 0.5;
      lp.frequency.value = airCutoff(d);
      pn = makePanner(ac, def);
      setPannerPosition(pn, pos.x, pos.y, pos.z);
      g.connect(lp).connect(pn).connect(this.mixer.bus[target]);
      tap = lp;
    } else {
      g.connect(this.mixer.bus[target]);
    }
    let send: GainNode | null = null;
    const sl = sendLevel(def, d, !!pos);
    if (sl > 0.001) {
      send = ac.createGain();
      send.gain.value = sl;
      tap.connect(send).connect(this.mixer.sendFor(target));
    }
    src.start(now);

    const v = slot;
    v.active = true;
    v.gen++;
    v.idx = idx;
    v.start = now;
    v.end = now + dur;
    v.level = level;
    v.src = src;
    v.gain = g;
    this.counts[idx]++;
    this.active++;
    const gen = v.gen;
    src.onended = () => {
      src.disconnect();
      g.disconnect();
      lp?.disconnect();
      pn?.disconnect();
      send?.disconnect();
      if (v.gen === gen) this.free(v);
    };
  }

  /**
   * Sample-accurate 2D one-shot at a future context time, outside the voice pool (used for the heartbeat,
   * whose beats are scheduled ahead so their rhythm never jitters with the frame rate).
   */
  scheduleAt(id: SoundId, when: number, volume: number, rate = 1, bus?: BusId): void {
    if (this.ac.state !== 'running') return;
    const buf = this.bank.variant(id, 0);
    if (!buf) return;
    const src = this.ac.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ac.createGain();
    g.gain.value = volume;
    src.connect(g).connect(this.mixer.bus[bus ?? SOUNDS[id].category]);
    src.onended = () => {
      src.disconnect();
      g.disconnect();
    };
    src.start(Math.max(when, this.ac.currentTime));
  }

  loop(id: SoundId, opts: PlayOpts | undefined, bus?: BusId): LoopHandle {
    const lv = new LoopVoice(this, id, bus ?? SOUNDS[id].category, opts);
    if (this.bank.available(id).length) lv.attach();
    else this.pending.push(lv);
    return lv;
  }

  /** A sound's first buffer just arrived: start any loops that were requested before it existed. */
  onSoundReady(id: SoundId) {
    if (!this.pending.length) return;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const lv = this.pending[i];
      if (lv.id !== id) continue;
      this.pending.splice(i, 1);
      if (!lv.stopped) lv.attach();
    }
  }

  /** @internal */
  addLoop(lv: LoopVoice) {
    this.loops.push(lv);
  }

  /** @internal */
  removeLoop(lv: LoopVoice) {
    const i = this.loops.indexOf(lv);
    if (i >= 0) this.loops.splice(i, 1);
    const j = this.pending.indexOf(lv);
    if (j >= 0) this.pending.splice(j, 1);
  }

  get loopCount() {
    return this.loops.length;
  }

  /** Is anyone running an audible loop of this sound (e.g. Survival's own heartbeat)? */
  loopActive(id: SoundId): boolean {
    for (const lv of this.loops) if (lv.id === id && !lv.stopped && lv.volume > 0.01) return true;
    for (const lv of this.pending) if (lv.id === id && !lv.stopped && lv.volume > 0.01) return true;
    return false;
  }

  update(dt: number) {
    // Sweep voices whose onended never fired (e.g. the context was suspended mid-sound).
    const now = this.ac.currentTime;
    for (const v of this.pool) if (v.active && now > v.end + 1) this.free(v);
    // Positional loops: the listener moves even when the source doesn't, so refresh distance-driven params
    // a few times a second (and immediately when a loop's position changed).
    this.loopTimer -= dt;
    const all = this.loopTimer <= 0;
    if (all) this.loopTimer = 0.1;
    for (const lv of this.loops) if (all || lv.dirty) lv.refreshDistance();
  }

  private freeSlot(): Voice | null {
    for (const v of this.pool) if (!v.active) return v;
    return null;
  }

  private free(v: Voice) {
    if (!v.active) return;
    v.active = false;
    v.gen++;
    this.counts[v.idx]--;
    this.active--;
    v.src = null;
    v.gain = null;
  }

  private steal(v: Voice) {
    const now = this.ac.currentTime;
    try {
      const p = v.gain!.gain;
      p.cancelScheduledValues(now);
      p.setValueAtTime(p.value, now);
      p.linearRampToValueAtTime(0, now + 0.015);
      v.src!.stop(now + 0.02);
    } catch {
      /* already stopped */
    }
    this.free(v); // nodes disconnect themselves in onended
  }
}

/** A looping sound. Created immediately; produces sound once its buffer exists (and the context runs). */
export class LoopVoice implements LoopHandle {
  volume: number;
  pitch: number;
  stopped = false;
  dirty = true;
  private pos: THREE.Vector3 | null = null;
  private src: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private lp: BiquadFilterNode | null = null;
  private panner: PannerNode | null = null;
  private send: GainNode | null = null;
  private cull = 1;
  private readonly def: SoundDef;

  constructor(private owner: Voices, readonly id: SoundId, private bus: BusId, opts?: PlayOpts) {
    this.def = SOUNDS[id];
    this.volume = Math.max(0, opts?.volume ?? 1);
    this.pitch = opts?.pitch ?? 1;
    if (finite(opts?.position)) this.pos = new THREE.Vector3(opts!.position!.x, opts!.position!.y, opts!.position!.z);
  }

  /** @internal Build the node chain and start playing at a random offset (decorrelates identical loops). */
  attach() {
    const ac = this.owner.ac;
    if (this.stopped || this.src || ac.state === 'closed') return;
    const buf = this.owner.bank.variant(this.id, this.owner.bank.available(this.id)[0]);
    if (!buf) return;
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = clampRate(this.pitch);
    const g = ac.createGain();
    g.gain.value = 0;
    src.connect(g);
    this.src = src;
    this.gain = g;
    if (this.pos) this.buildSpatial();
    else g.connect(this.owner.mixer.bus[this.bus]);
    this.owner.addLoop(this);
    this.dirty = true;
    this.refreshDistance();
    src.start(ac.currentTime, Math.random() * buf.duration);
    this.applyGain(0.08);
  }

  private buildSpatial() {
    const ac = this.owner.ac;
    const g = this.gain!;
    g.disconnect();
    this.lp = ac.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.Q.value = 0.5;
    this.panner = makePanner(ac, this.def);
    g.connect(this.lp).connect(this.panner).connect(this.owner.mixer.bus[this.bus]);
    this.send = ac.createGain();
    this.send.gain.value = 0;
    this.lp.connect(this.send).connect(this.owner.mixer.sendFor(this.bus));
  }

  /** @internal Distance-driven params: air absorption, reverb send, fade-out near maxDistance. */
  refreshDistance() {
    this.dirty = false;
    if (!this.pos || !this.panner || !this.lp) return;
    const now = this.owner.ac.currentTime;
    setPannerPosition(this.panner, this.pos.x, this.pos.y, this.pos.z);
    const d = this.pos.distanceTo(this.owner.listener);
    this.lp.frequency.setTargetAtTime(airCutoff(d), now, 0.05);
    const max = this.def.maxDistance ?? DEFAULT_MAX;
    const cull = 1 - Math.min(1, Math.max(0, (d - max * 0.8) / (max * 0.2)));
    if (cull !== this.cull) {
      this.cull = cull;
      this.applyGain(0.15);
    }
    this.send?.gain.setTargetAtTime(sendLevel(this.def, d, true) * this.volume * cull, now, 0.1);
  }

  private applyGain(tc: number) {
    if (!this.gain) return;
    this.gain.gain.setTargetAtTime(this.volume * this.cull, this.owner.ac.currentTime, tc);
  }

  setVolume(v: number): void {
    if (!Number.isFinite(v) || this.stopped) return;
    const nv = Math.max(0, v);
    if (Math.abs(nv - this.volume) < 1e-4) return;
    this.volume = nv;
    this.applyGain(0.05);
  }

  setPitch(p: number): void {
    if (!Number.isFinite(p) || this.stopped) return;
    if (Math.abs(p - this.pitch) < 1e-4) return;
    this.pitch = p;
    this.src?.playbackRate.setTargetAtTime(clampRate(p), this.owner.ac.currentTime, 0.05);
  }

  setPosition(p: Vec3Like): void {
    if (!finite(p) || this.stopped) return;
    if (!this.pos) {
      this.pos = new THREE.Vector3(p.x, p.y, p.z);
      // A loop created 2D and given a position later becomes positional.
      if (this.gain) this.buildSpatial();
    } else this.pos.set(p.x, p.y, p.z);
    this.dirty = true;
  }

  stop(fadeSeconds = 0.25): void {
    if (this.stopped) return;
    this.stopped = true;
    this.owner.removeLoop(this);
    const src = this.src;
    if (!src || !this.gain) return;
    const ac = this.owner.ac;
    const now = ac.currentTime;
    const fade = Math.max(0.01, Number.isFinite(fadeSeconds) ? fadeSeconds : 0.25);
    const p = this.gain.gain;
    try {
      p.cancelScheduledValues(now);
      p.setValueAtTime(p.value, now);
      p.linearRampToValueAtTime(0, now + fade);
      src.stop(now + fade + 0.05);
    } catch {
      /* already stopped */
    }
    const nodes: (AudioNode | null)[] = [src, this.gain, this.lp, this.panner, this.send];
    src.onended = () => {
      for (const n of nodes) n?.disconnect();
    };
    // A suspended context never fires onended; don't keep the graph alive forever in that case.
    if (ac.state !== 'running') for (const n of nodes) n?.disconnect();
  }
}

function clampRate(p: number) {
  return Math.min(4, Math.max(0.05, p));
}
