// Frostline's procedural audio engine. Every sound is synthesised at boot (in workers, see Bank.ts); nothing is
// downloaded. This file is the System/AudioAPI facade: context lifecycle, listener, settings, state reactions,
// threat detection for the score, and debug measurements.
//
// Graph (see Mixer.ts):  voices/ambience/music ─► category buses + reverb sends ─► master ─► visibility mute
//                        ─► safety limiter ─► destination
import * as THREE from 'three';
import type { AudioAPI, GameContext, GameState, LoopHandle, PlayOpts, SoundId, System } from '../core/types';
import type { BufferStats } from './analyze';
import { Ambience } from './Ambience';
import { SoundBank, type SynthTiming } from './Bank';
import { BUSES, Mixer, type BusId } from './Mixer';
import { Music, type MusicMood } from './Music';
import { SOUND_IDS } from './sounds';
import { Voices } from './Voices';

export type { MusicMood };

export interface AudioDebugReport {
  ready: boolean;
  sampleRate: number;
  contextState: string;
  synth: SynthTiming;
  sounds: Record<string, { peak: number; rmsDb: number; stDb: number; durationS: number; centroidHz: number; bad: boolean } | null>;
}

declare global {
  interface Window {
    __audioStats?: AudioDebugReport;
    webkitAudioContext?: typeof AudioContext;
  }
}

const NULL_LOOP: LoopHandle = { setVolume() {}, setPitch() {}, setPosition() {}, stop() {} };
/** Wolf sounds that, close to the listener, mean danger (drives the score's tension layer). */
const THREATS = new Set<SoundId>(['wolf_growl', 'wolf_bark', 'wolf_attack']);

const reported = new Set<string>();
function reportOnce(key: string, err: unknown) {
  if (reported.has(key)) return;
  reported.add(key);
  console.warn(`[audio] ${key}:`, err);
}

export class Audio implements System, AudioAPI {
  readonly name = 'audio';
  readonly updateWhen: GameState[] = ['boot', 'menu', 'playing', 'paused', 'dead'];

  private ac: AudioContext | null = null;
  private mixer: Mixer | null = null;
  private bank: SoundBank | null = null;
  private voices: Voices | null = null;
  private ambience: Ambience | null = null;
  private music: Music | null = null;
  private initialized = false;
  private readonly fwd = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private meters: Partial<Record<BusId | 'master', AnalyserNode>> = {};

  constructor(private ctx: GameContext) {
    try {
      const AC = window.AudioContext ?? window.webkitAudioContext;
      if (!AC) throw new Error('WebAudio not supported');
      this.ac = new AC({ latencyHint: 'interactive' });
      this.mixer = new Mixer(this.ac, ctx.settings);
      this.bank = new SoundBank(this.ac);
      this.voices = new Voices(this.ac, this.mixer, this.bank);
      this.ambience = new Ambience(ctx, this.ac, this.mixer, this.bank, this.voices);
      this.music = new Music(ctx, this.ac, this.mixer, this.bank);
      this.bank.onBuffer((key, id) => this.onBuffer(key, id));
      // Synthesis starts now (constructors may not touch the world, but this doesn't): it overlaps the
      // terrain load, so by init() it is usually finished.
      this.bank.start();
    } catch (err) {
      console.warn('[audio] disabled:', err);
      this.ac = null;
      return;
    }

    // Autoplay policy: the context starts suspended until a user gesture.
    const gesture = () => this.unlock();
    for (const type of ['pointerdown', 'keydown', 'touchend'] as const) window.addEventListener(type, gesture, { capture: true, passive: true });
    this.ac.addEventListener('statechange', () => {
      if (this.ac?.state === 'running') {
        for (const type of ['pointerdown', 'keydown', 'touchend'] as const) window.removeEventListener(type, gesture, { capture: true });
      }
    });
    document.addEventListener('visibilitychange', () => this.mixer?.setHidden(document.hidden));
    if (document.hidden) this.mixer.setHidden(true);

    ctx.events.on('settings', ({ key }) => {
      if (key === 'masterVolume' || key === 'musicVolume' || key === 'sfxVolume' || key === 'ambienceVolume') this.mixer?.applyVolumes();
    });
    ctx.events.on('state', ({ from, to }) => this.onState(from, to));
    ctx.events.on('day:start', () => this.music?.onDawn());
    ctx.events.on('night:start', () => this.music?.onNight());
    ctx.events.on('player:damaged', ({ cause }) => {
      if (cause === 'wolf') this.music?.addThreat(1);
    });
    ctx.events.on('newGame', () => this.onNewRun());
    ctx.events.on('loadedGame', () => this.onNewRun());
  }

  async init() {
    if (!this.bank) return;
    // Usually already done (synthesis overlapped the terrain load); never hold the boot hostage.
    await Promise.race([this.bank.ready, new Promise<void>((r) => setTimeout(r, 6000))]);
    this.initialized = true;
    this.music?.start();
    this.ambience?.tryStart();
    const t = this.bank.timing;
    if (this.bank.isReady) {
      console.info(
        `[audio] synthesised ${t.jobs} buffers in ${t.wallMs.toFixed(0)} ms wall (${t.mode}, ${t.workers} workers; ` +
          `sum ${t.sumJobMs.toFixed(0)} ms, max job ${t.maxJobMs.toFixed(0)} ms ${t.maxJobKey}, max main-thread slice ${t.maxMainChunkMs.toFixed(1)} ms)`,
      );
    } else {
      void this.bank.ready.then(() => console.info(`[audio] synthesis finished late: ${this.bank!.timing.wallMs.toFixed(0)} ms`));
    }
  }

  // ------------------------------------------------------------------ public API

  play(id: SoundId, opts?: PlayOpts): void {
    if (!this.voices) return;
    try {
      this.voices.play(id, opts);
      if (opts?.position && THREATS.has(id)) {
        const p = opts.position;
        const d = this.tmp.set(p.x, p.y, p.z).distanceTo(this.voices.listener);
        if (d < 50) this.music?.addThreat(id === 'wolf_attack' ? 1 : 1 - Math.max(0, d - 15) / 50);
      }
    } catch (err) {
      reportOnce('play ' + id, err);
    }
  }

  loop(id: SoundId, opts?: PlayOpts): LoopHandle {
    if (!this.voices) return NULL_LOOP;
    try {
      return this.voices.loop(id, opts);
    } catch (err) {
      reportOnce('loop ' + id, err);
      return NULL_LOOP;
    }
  }

  /** Resume the AudioContext. Call from any user gesture (it is also hooked to the first pointer/key event). */
  unlock(): void {
    const ac = this.ac;
    if (!ac || ac.state === 'running' || ac.state === 'closed') return;
    ac.resume().catch(() => {
      /* not allowed yet: the next gesture will try again */
    });
  }

  /**
   * 'menu' → the title theme; 'auto' → the gameplay score (silence-heavy, day/night/dawn/tension); 'silent' →
   * fade everything out (death screen). The engine also follows game state on its own; the latest call wins.
   */
  setMusicMood(m: MusicMood): void {
    this.music?.setMood(m);
  }

  /** Per-sound measurements (variant 0) + synthesis timing, once synthesis is complete. Also sets window.__audioStats. */
  async debugStats(): Promise<AudioDebugReport> {
    if (this.bank) await this.bank.ready;
    const sounds: AudioDebugReport['sounds'] = {};
    for (const id of SOUND_IDS) {
      const s: BufferStats | undefined = this.bank?.stats.get(id);
      sounds[id] = s
        ? { peak: round(s.peak, 3), rmsDb: round(s.rmsDb, 1), stDb: round(s.stDb, 1), durationS: round(s.durationS, 2), centroidHz: Math.round(s.centroidHz), bad: s.bad }
        : null;
    }
    const report: AudioDebugReport = {
      ready: !!this.bank?.isReady,
      sampleRate: this.ac?.sampleRate ?? 0,
      contextState: this.ac?.state ?? 'none',
      synth: { ...(this.bank?.timing ?? ({} as SynthTiming)) },
      sounds,
    };
    window.__audioStats = report;
    return report;
  }

  /** Debug: RMS/peak (dBFS) of each bus over the last ~43 ms (analysers are created on first call). */
  debugMeters(): Record<string, { rmsDb: number; peakDb: number }> | null {
    const ac = this.ac,
      mixer = this.mixer;
    if (!ac || !mixer) return null;
    const out: Record<string, { rmsDb: number; peakDb: number }> = {};
    const targets: [BusId | 'master', AudioNode][] = [...BUSES.map((b) => [b, mixer.bus[b]] as [BusId, AudioNode]), ['master', mixer.limiter]];
    for (const [k, node] of targets) {
      let an = this.meters[k];
      if (!an) {
        an = ac.createAnalyser();
        an.fftSize = 2048;
        node.connect(an);
        this.meters[k] = an;
      }
      const buf = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(buf);
      let s = 0,
        p = 0;
      for (let i = 0; i < buf.length; i++) {
        s += buf[i] * buf[i];
        p = Math.max(p, Math.abs(buf[i]));
      }
      out[k] = { rmsDb: round(20 * Math.log10(Math.sqrt(s / buf.length) + 1e-9), 1), peakDb: round(20 * Math.log10(p + 1e-9), 1) };
    }
    return out;
  }

  /** Debug: counts of live voices/loops and the context state. */
  debugVoices() {
    return {
      state: this.ac?.state ?? 'none',
      voices: this.voices?.activeCount ?? 0,
      loops: this.voices?.loopCount ?? 0,
      mood: this.music?.currentMood ?? 'none',
    };
  }

  // ------------------------------------------------------------------ System

  reset() {
    this.onNewRun();
  }

  update(dt: number) {
    if (!this.ac || !this.voices || this.ac.state === 'closed') return;
    try {
      this.updateListener();
      this.voices.update(dt);
      if (!this.initialized) return;
      const state = this.ctx.game.state;
      this.ambience?.update(dt, state);
      this.music?.update(dt);
    } catch (err) {
      reportOnce('update', err);
    }
  }

  // ------------------------------------------------------------------ internals

  private updateListener() {
    const cam = this.ctx.camera;
    const l = this.ac!.listener;
    const p = cam.position;
    // Orientation from the camera quaternion (the camera is a direct child of the scene).
    this.fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    this.voices!.listener.copy(p);
    if (l.positionX) {
      l.positionX.value = p.x;
      l.positionY.value = p.y;
      l.positionZ.value = p.z;
      l.forwardX.value = this.fwd.x;
      l.forwardY.value = this.fwd.y;
      l.forwardZ.value = this.fwd.z;
      l.upX.value = this.up.x;
      l.upY.value = this.up.y;
      l.upZ.value = this.up.z;
    } else {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(this.fwd.x, this.fwd.y, this.fwd.z, this.up.x, this.up.y, this.up.z);
    }
  }

  private onBuffer(key: string, id: SoundId | null) {
    if (id) {
      this.voices?.onSoundReady(id);
      return;
    }
    const buf = this.bank?.misc.get(key);
    if (!buf || !this.mixer) return;
    if (key === 'ir:valley') this.mixer.valley.buffer = buf;
    else if (key === 'ir:hall') this.mixer.hall.buffer = buf;
  }

  private onState(from: GameState, to: GameState) {
    // Default musical behaviour per state; the UI can override with setMusicMood() at any time.
    if (to === 'menu') this.music?.setMood('menu');
    else if (to === 'playing' && from !== 'paused') this.music?.setMood('auto');
    else if (to === 'dead') this.music?.setMood('silent');
  }

  private onNewRun() {
    this.ambience?.reset();
    this.music?.reset();
  }
}

const round = (v: number, d: number) => {
  const k = Math.pow(10, d);
  return Math.round(v * k) / k;
};
