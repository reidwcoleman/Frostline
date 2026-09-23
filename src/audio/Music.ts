// Adaptive generative score. Mostly silence: short phrases (20–60 s) separated by long gaps (60–180 s).
//  - menu:  a recognisable slow D-major-pentatonic theme (felt piano over a pad, ~70 bpm) that loops with variation.
//  - day:   sparse piano/celesta motifs over a soft pad (D major pentatonic or D dorian).
//  - night: low beating drones, sparse minor notes, the occasional unsettling cluster (D aeolian/phrygian).
//  - dawn:  a short warm major phrase after the daybreak chord.
//  - tension: a pulsing low drone + tremolo string pad whose level follows a decaying "threat" value.
// Notes are scheduled ~0.5 s ahead on the AudioContext clock (sample-accurate, immune to frame hitches).
// Everything runs through the long hall reverb. Mood changes crossfade over 2–4 s; nothing is ever cut.
import type { GameContext } from '../core/types';
import { CELESTA_ROOTS, PIANO_ROOTS, nearestRoot } from './instruments';
import type { SoundBank } from './Bank';
import type { Mixer } from './Mixer';

export type MusicMood = 'menu' | 'auto' | 'silent';
type Inst = 'piano' | 'celesta';

interface NoteEv {
  t: number;
  kind: 'note';
  inst: Inst;
  midi: number;
  vel: number;
  pan: number;
}
interface PadEv {
  t: number;
  kind: 'pad';
  notes: readonly number[];
  dur: number;
  vel: number;
  attack: number;
  release: number;
  bright: number;
}
interface DroneEv {
  t: number;
  kind: 'drone';
  notes: readonly number[];
  dur: number;
  vel: number;
  attack: number;
  release: number;
}
type Ev = NoteEv | PadEv | DroneEv;

interface Phrase {
  gain: GainNode;
  events: Ev[];
  idx: number;
  end: number;
  retired: boolean;
  deadAt: number;
}

const LOOKAHEAD = 0.5;
const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
const rand = (a: number, b: number) => a + (b - a) * Math.random();
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

// ------------------------------------------------------------------ harmony

/** [pad voicing, left-hand notes] */
type Chord = readonly [readonly number[], readonly number[]];
const C = {
  D: [[50, 57, 62, 66], [38, 45, 52]],
  Dadd9: [[50, 57, 64, 66], [38, 45, 52]],
  Dmaj7: [[50, 57, 61, 66], [38, 45, 52]],
  DoverFs: [[42, 50, 57, 64], [42, 50, 57]],
  Bm7: [[47, 54, 57, 62], [47, 54, 59]],
  G: [[43, 50, 55, 59], [43, 50, 57]],
  Gmaj7: [[43, 50, 54, 59], [43, 50, 57]],
  Em7: [[40, 47, 55, 62], [40, 47, 55]],
  Asus4: [[45, 52, 57, 62], [45, 52, 57]],
  Asus2: [[45, 52, 57, 59], [45, 52, 57]],
  A: [[45, 52, 57, 61], [45, 52, 57]],
  Dm9: [[50, 53, 57, 64], [38, 45, 53]],
  GoverD: [[50, 55, 59, 62], [43, 50, 55]],
  Cmaj7: [[48, 52, 55, 59], [48, 55, 60]],
  Am7: [[45, 52, 55, 60], [45, 52, 57]],
  Fmaj7: [[41, 48, 52, 57], [41, 48, 53]],
} satisfies Record<string, Chord>;

const MAJ_PENT = [62, 64, 66, 69, 71];
const DORIAN = [62, 64, 65, 67, 69, 71, 72];
const AEOLIAN = [62, 64, 65, 67, 69, 70, 72];
const DAY_PROGS: { scale: readonly number[]; chords: readonly Chord[] }[] = [
  { scale: MAJ_PENT, chords: [C.D, C.Bm7, C.G, C.Asus2] },
  { scale: MAJ_PENT, chords: [C.D, C.G, C.Em7, C.Asus2] },
  { scale: MAJ_PENT, chords: [C.G, C.D, C.Bm7, C.Asus4] },
  { scale: MAJ_PENT, chords: [C.Dmaj7, C.Em7, C.G, C.D] },
  { scale: DORIAN, chords: [C.Dm9, C.GoverD, C.Dm9, C.Cmaj7] },
  { scale: DORIAN, chords: [C.Dm9, C.Am7, C.Fmaj7, C.GoverD] },
];

/** All notes of `scale` (given in one octave from D4) between lo and hi. */
function scaleRange(scale: readonly number[], lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let o = -3; o <= 3; o++) for (const s of scale) {
    const m = s + 12 * o;
    if (m >= lo && m <= hi) out.push(m);
  }
  return out.sort((a, b) => a - b);
}

// ------------------------------------------------------------------ the menu theme

const MENU_BPM = 70;
// [bar, beat, midi, beats] — D major pentatonic melody over D · Bm7 · Gmaj7 · Asus | D/F# · Em7 · Gmaj7 · A
const THEME: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 78, 1.5], [0, 1.5, 76, 0.5], [0, 2, 74, 2],
  [1, 0, 69, 1], [1, 1, 71, 1], [1, 2, 74, 1.5], [1, 3.5, 76, 0.5],
  [2, 0, 81, 2], [2, 2, 78, 1], [2, 3, 76, 1],
  [3, 0, 74, 3],
  [4, 0, 78, 1.5], [4, 1.5, 76, 0.5], [4, 2, 74, 2],
  [5, 0, 71, 1], [5, 1, 74, 1], [5, 2, 76, 2],
  [6, 0, 69, 1], [6, 1, 71, 1], [6, 2, 74, 1], [6, 3, 71, 1],
  [7, 0, 69, 4],
];
const THEME_CHORDS: readonly Chord[] = [C.Dadd9, C.Bm7, C.Gmaj7, C.Asus4, C.DoverFs, C.Em7, C.Gmaj7, C.A];

function menuPass(t0: number, pass: number): { events: Ev[]; end: number } {
  const beat = 60 / MENU_BPM;
  const bar = beat * 4;
  const ev: Ev[] = [];
  const hum = () => rand(-0.012, 0.012);
  const variant = pass % 4;
  for (let b = 0; b < 8; b++) {
    const [pad, lh] = THEME_CHORDS[b];
    const tb = t0 + b * bar;
    // Pads enter a touch early and overlap: chords crossfade instead of re-attacking.
    ev.push({ t: tb - 0.35, kind: 'pad', notes: pad, dur: bar + 0.2, vel: 0.055, attack: 1.4, release: 2.6, bright: 950 });
    ev.push({ t: tb + hum(), kind: 'note', inst: 'piano', midi: lh[0], vel: 0.4 * rand(0.92, 1.05), pan: -0.15 });
    ev.push({ t: tb + beat * 1.5 + hum(), kind: 'note', inst: 'piano', midi: lh[1], vel: 0.27 * rand(0.9, 1.05), pan: -0.1 });
    if (variant !== 2 || b % 2 === 0) ev.push({ t: tb + beat * 2.5 + hum(), kind: 'note', inst: 'piano', midi: lh[2], vel: 0.22 * rand(0.9, 1.05), pan: -0.05 });
  }
  for (const [b, bt, m, len] of THEME) {
    if (variant === 2 && b < 4) continue; // "space" pass: the melody only answers in the second half
    const t = t0 + (b * 4 + bt) * beat + hum();
    const accent = bt === 0 ? 1.08 : 0.95;
    const vel = (variant === 2 ? 0.38 : 0.5) * accent * rand(0.92, 1.05) * (len >= 2 ? 1.05 : 1);
    if (variant === 3 && len >= 1 && Math.random() < 0.3) {
      // Grace note from the scale neighbour below.
      const g = scaleRange(MAJ_PENT, 60, 90).filter((x) => x < m).pop();
      if (g) ev.push({ t: t - 0.11, kind: 'note', inst: 'piano', midi: g, vel: vel * 0.45, pan: 0.15 });
    }
    ev.push({ t, kind: 'note', inst: 'piano', midi: m, vel, pan: 0.12 });
    if (variant === 1 && bt === 0) ev.push({ t: t + 0.004, kind: 'note', inst: 'celesta', midi: m + 12, vel: 0.2, pan: 0.3 });
  }
  if (variant === 3) ev.push({ t: t0 + 7 * bar + beat * 2, kind: 'note', inst: 'celesta', midi: 86, vel: 0.16, pan: 0.35 });
  if (variant === 2) ev.push({ t: t0 + 3 * bar + beat * 2, kind: 'note', inst: 'celesta', midi: 93, vel: 0.12, pan: -0.3 });
  let end = t0 + 8 * bar;
  if (pass % 2 === 1) {
    // Breathe: a bar of held D before the theme returns.
    ev.push({ t: end - 0.35, kind: 'pad', notes: C.Dadd9[0], dur: bar + 0.2, vel: 0.05, attack: 1.4, release: 2.8, bright: 800 });
    ev.push({ t: end, kind: 'note', inst: 'piano', midi: 38, vel: 0.3, pan: -0.15 });
    end += bar;
  }
  ev.sort((a, b) => a.t - b.t);
  return { events: ev, end };
}

// ------------------------------------------------------------------ generative phrases

function dayPhrase(t0: number): { events: Ev[]; end: number } {
  const prog = pick(DAY_PROGS);
  const beat = 60 / rand(58, 68);
  const chordLen = beat * 8;
  const nChords = Math.round(rand(3, 7));
  const ev: Ev[] = [];
  const notes = scaleRange(prog.scale, 69, 86);
  for (let i = 0; i < nChords; i++) {
    const [pad, lh] = prog.chords[i % prog.chords.length];
    const tc = t0 + i * chordLen;
    ev.push({ t: tc - 0.5, kind: 'pad', notes: pad, dur: chordLen + 0.4, vel: 0.05, attack: 2.2, release: 3.5, bright: 850 });
    ev.push({ t: tc, kind: 'note', inst: 'piano', midi: lh[0], vel: 0.32, pan: -0.15 });
    if (Math.random() < 0.6) ev.push({ t: tc + beat * 4, kind: 'note', inst: 'piano', midi: lh[1], vel: 0.22, pan: -0.1 });
  }
  // Melody: a short motif, stated, varied and answered, with plenty of rests. Starts after the first chord.
  const motifLen = 3 + Math.floor(Math.random() * 3);
  const steps: number[] = [];
  const rhythm: number[] = [];
  for (let k = 0; k < motifLen; k++) {
    steps.push(pick([-2, -1, -1, 1, 1, 2]));
    rhythm.push(pick([1, 1, 1.5, 2, 2, 3]));
  }
  let t = t0 + chordLen + rand(0, beat);
  const stop = t0 + (nChords - 1) * chordLen;
  let deg = Math.floor(notes.length / 2) + pick([-1, 0, 1]);
  let statement = 0;
  while (t < stop) {
    const shift = statement === 0 ? 0 : pick([-1, 1, 2]);
    let d = Math.max(0, Math.min(notes.length - 1, deg + shift));
    for (let k = 0; k < motifLen && t < stop; k++) {
      const m = notes[d];
      ev.push({ t: t + rand(-0.015, 0.015), kind: 'note', inst: 'piano', midi: m, vel: rand(0.34, 0.46), pan: 0.12 });
      if (Math.random() < 0.22) ev.push({ t: t + 0.01, kind: 'note', inst: 'celesta', midi: m + 12, vel: 0.14, pan: 0.3 });
      t += rhythm[k] * beat;
      d = Math.max(0, Math.min(notes.length - 1, d + steps[(k + statement) % motifLen] * (statement === 2 ? -1 : 1)));
    }
    t += pick([2, 3, 4, 6]) * beat; // rest
    statement++;
    deg = d;
  }
  // Settle: a low D and a last high celesta note hanging in the reverb.
  const end = t0 + nChords * chordLen;
  ev.push({ t: stop + beat * 2, kind: 'note', inst: 'piano', midi: 38, vel: 0.3, pan: -0.15 });
  if (Math.random() < 0.6) ev.push({ t: stop + beat * 4, kind: 'note', inst: 'celesta', midi: pick([86, 81, 90]), vel: 0.12, pan: 0.35 });
  ev.sort((a, b) => a.t - b.t);
  return { events: ev, end: end + 4 };
}

function nightPhrase(t0: number): { events: Ev[]; end: number } {
  const dur = rand(30, 60);
  const ev: Ev[] = [];
  // Felt more than heard: D1/A1/D2 with slowly beating detuned partners, kept low so the sub-bass never
  // crowds the SFX headroom.
  ev.push({ t: t0, kind: 'drone', notes: [26, 33, 38], dur, vel: 0.06, attack: 7, release: 9 });
  ev.push({ t: t0 + 3, kind: 'pad', notes: pick([[50, 53, 57, 64], [46, 50, 53, 57], [50, 53, 55, 60]]), dur: dur - 6, vel: 0.03, attack: 6, release: 7, bright: 520 });
  const notes = scaleRange(AEOLIAN, 50, 74);
  let t = t0 + rand(6, 10);
  let clusterDone = Math.random() < 0.45;
  while (t < t0 + dur - 6) {
    const m = pick(notes);
    ev.push({ t, kind: 'note', inst: 'piano', midi: m, vel: rand(0.22, 0.36), pan: rand(-0.3, 0.3) });
    if (Math.random() < 0.3) {
      const m2 = m + pick([3, 5, 7]); // minor third / fourth / fifth answer
      ev.push({ t: t + rand(0.6, 1.4), kind: 'note', inst: 'piano', midi: m2, vel: rand(0.18, 0.28), pan: rand(-0.3, 0.3) });
    }
    if (!clusterDone && t > t0 + dur * 0.4) {
      clusterDone = true;
      // Unsettling cluster: D–Eb–F (phrygian colour), low piano or glassy high celesta.
      const high = Math.random() < 0.5;
      const base = high ? 86 : 50;
      for (const [k, dm] of [[0, 0], [1, 1], [2, 3]] as const) {
        ev.push({ t: t + 2.5 + k * rand(0.02, 0.09), kind: 'note', inst: high ? 'celesta' : 'piano', midi: base + dm, vel: high ? 0.1 : 0.17, pan: rand(-0.4, 0.4) });
      }
    }
    t += rand(3, 7);
  }
  if (Math.random() < 0.5) ev.push({ t: t0 + dur * 0.7, kind: 'note', inst: 'celesta', midi: pick([86, 81, 89]), vel: 0.09, pan: 0.4 });
  ev.sort((a, b) => a.t - b.t);
  return { events: ev, end: t0 + dur + 9 };
}

function dawnPhrase(t0: number): { events: Ev[]; end: number } {
  const ev: Ev[] = [];
  ev.push({ t: t0, kind: 'pad', notes: [50, 57, 61, 64, 66], dur: 9, vel: 0.05, attack: 3, release: 5, bright: 1300 });
  ev.push({ t: t0 + 0.4, kind: 'note', inst: 'piano', midi: 38, vel: 0.36, pan: -0.15 });
  const arp = [50, 57, 64, 66, 69];
  arp.forEach((m, i) => ev.push({ t: t0 + 0.6 + i * 0.4, kind: 'note', inst: 'piano', midi: m, vel: 0.26 + i * 0.03, pan: -0.1 + i * 0.06 }));
  const mel: [number, number, number][] = [[3.2, 76, 0.42], [4.0, 78, 0.44], [4.8, 81, 0.48], [6.6, 74, 0.38], [7.4, 76, 0.36], [8.6, 74, 0.34]];
  for (const [dt, m, v] of mel) ev.push({ t: t0 + dt, kind: 'note', inst: 'piano', midi: m, vel: v, pan: 0.12 });
  ev.push({ t: t0 + 5.0, kind: 'note', inst: 'celesta', midi: 93, vel: 0.13, pan: 0.35 });
  ev.push({ t: t0 + 8.62, kind: 'note', inst: 'celesta', midi: 86, vel: 0.1, pan: -0.3 });
  ev.sort((a, b) => a.t - b.t);
  return { events: ev, end: t0 + 16 };
}

// ------------------------------------------------------------------ the engine

export class Music {
  private input: GainNode;
  private menuG: GainNode;
  private scoreG: GainNode;
  private tensionG: GainNode;
  private phrases: Phrase[] = [];
  private mood: MusicMood = 'silent';
  private menuPassN = 0;
  private menuPhrase: Phrase | null = null;
  private scorePhrase: Phrase | null = null;
  private nextScoreAt = Infinity;
  private threat = 0;
  private tensionBuilt = false;
  private moodGain = { menu: 0, score: 0 };
  private started = false;
  private tensionTimer = 0;

  constructor(private ctx: GameContext, private ac: AudioContext, private mixer: Mixer, private bank: SoundBank) {
    this.input = ac.createGain();
    // Internal level: piano notes peak around −20 dBFS at default settings, under the SFX.
    this.input.gain.value = 2.2;
    const dry = ac.createGain();
    dry.gain.value = 0.75;
    const wet = ac.createGain();
    wet.gain.value = 0.65;
    this.input.connect(dry).connect(mixer.bus.music);
    this.input.connect(wet).connect(mixer.hallSend.music);
    this.menuG = ac.createGain();
    this.scoreG = ac.createGain();
    this.tensionG = ac.createGain();
    for (const g of [this.menuG, this.scoreG, this.tensionG]) {
      g.gain.value = 0;
      g.connect(this.input);
    }
  }

  get currentMood(): MusicMood {
    return this.mood;
  }

  start() {
    this.started = true;
  }

  setMood(m: MusicMood) {
    if (m === this.mood) return;
    this.mood = m;
    const now = this.ac.currentTime;
    if (m === 'menu') {
      this.fadeGroup(this.menuG, 1, 1.0);
      this.fadeGroup(this.scoreG, 0, 0.8);
      this.retire(this.scorePhrase, 3);
      this.scorePhrase = null;
      this.menuPassN = 0;
      this.menuPhrase = null; // a fresh pass is scheduled in update()
      this.moodGain.menu = 1;
      this.moodGain.score = 0;
    } else if (m === 'auto') {
      this.fadeGroup(this.menuG, 0, 1.0);
      this.retire(this.menuPhrase, 3.5);
      this.menuPhrase = null;
      this.fadeGroup(this.scoreG, 1, 0.8);
      this.moodGain.menu = 0;
      this.moodGain.score = 1;
      // A gentle opening shortly after the game starts, then the long silences take over.
      this.nextScoreAt = now + rand(8, 16);
    } else {
      this.fadeGroup(this.menuG, 0, 0.9);
      this.fadeGroup(this.scoreG, 0, 0.9);
      this.retire(this.menuPhrase, 3);
      this.retire(this.scorePhrase, 3);
      this.menuPhrase = this.scorePhrase = null;
      this.moodGain.menu = this.moodGain.score = 0;
      this.nextScoreAt = Infinity;
    }
  }

  /** Something threatening happened near the listener (0..1). Decays over ~20 s. */
  addThreat(level: number) {
    if (!Number.isFinite(level)) return;
    this.threat = Math.max(this.threat, Math.min(1, level));
  }

  onDawn() {
    if (this.mood !== 'auto' || this.ctx.game.state !== 'playing') return;
    const now = this.ac.currentTime;
    this.retire(this.scorePhrase, 3);
    this.scorePhrase = this.launch(this.scoreG, dawnPhrase(now + 2.5));
    this.nextScoreAt = this.scorePhrase.end + rand(70, 160);
  }

  onNight() {
    if (this.mood !== 'auto' || this.scorePhrase) return;
    this.nextScoreAt = Math.min(this.nextScoreAt, this.ac.currentTime + rand(8, 20));
  }

  reset() {
    this.retire(this.scorePhrase, 2);
    this.scorePhrase = null;
    this.threat = 0;
    if (this.mood === 'auto') this.nextScoreAt = this.ac.currentTime + rand(8, 16);
  }

  update(dt: number) {
    if (!this.started) return;
    const ac = this.ac;
    const now = ac.currentTime;
    this.threat = Math.max(0, this.threat - dt / 20);
    this.tensionTimer -= dt;
    if (this.tensionTimer <= 0) {
      this.tensionTimer = 0.1; // 10 Hz is plenty for a level that moves over seconds
      this.updateTension(now);
    }
    if (ac.state !== 'running') return; // the clock is frozen: nothing to schedule

    if (this.mood === 'menu' && (!this.menuPhrase || this.menuPhrase.end - now < 1.5)) {
      const t0 = this.menuPhrase ? this.menuPhrase.end : now + 1.2;
      this.menuPhrase = this.launch(this.menuG, menuPass(t0, this.menuPassN++));
    }
    if (this.mood === 'auto' && this.ctx.game.state === 'playing') {
      if (this.scorePhrase && now > this.scorePhrase.end) this.scorePhrase = null;
      if (!this.scorePhrase && now >= this.nextScoreAt) {
        const p = this.ctx.clock.isNight ? nightPhrase(now + 0.3) : dayPhrase(now + 0.3);
        this.scorePhrase = this.launch(this.scoreG, p);
        this.nextScoreAt = p.end + rand(60, 180);
      }
    }

    const horizon = now + LOOKAHEAD;
    for (let i = this.phrases.length - 1; i >= 0; i--) {
      const ph = this.phrases[i];
      if (!ph.retired) {
        while (ph.idx < ph.events.length && ph.events[ph.idx].t < horizon) {
          const ev = ph.events[ph.idx++];
          // Events that slipped into the past (tab was hidden) are dropped, never played as a burst.
          if (ev.t >= now - 0.05) this.schedule(ev, ph.gain);
        }
      }
      if (now > ph.deadAt || (!ph.retired && ph.idx >= ph.events.length && now > ph.end + 12)) {
        ph.gain.disconnect();
        this.phrases.splice(i, 1);
      }
    }
  }

  private launch(group: GainNode, p: { events: Ev[]; end: number }): Phrase {
    const g = this.ac.createGain();
    g.connect(group);
    const ph: Phrase = { gain: g, events: p.events, idx: 0, end: p.end, retired: false, deadAt: Infinity };
    this.phrases.push(ph);
    return ph;
  }

  private retire(ph: Phrase | null, fade: number) {
    if (!ph || ph.retired) return;
    const now = this.ac.currentTime;
    ph.retired = true;
    ph.gain.gain.setTargetAtTime(0, now, fade / 3);
    ph.deadAt = now + fade + 10;
  }

  private fadeGroup(g: GainNode, v: number, tc: number) {
    const now = this.ac.currentTime;
    g.gain.cancelScheduledValues(now);
    g.gain.setTargetAtTime(v, now, tc);
  }

  private schedule(ev: Ev, dest: AudioNode) {
    const ac = this.ac;
    if (ev.kind === 'note') {
      const roots = ev.inst === 'piano' ? PIANO_ROOTS : CELESTA_ROOTS;
      const { root, rate } = nearestRoot(roots, ev.midi);
      const buf = this.bank.misc.get(`${ev.inst}:${root}`);
      if (!buf) return;
      const src = ac.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      const g = ac.createGain();
      g.gain.value = ev.vel;
      const pan = ac.createStereoPanner();
      pan.pan.value = ev.pan;
      src.connect(g).connect(pan).connect(dest);
      src.onended = () => {
        src.disconnect();
        g.disconnect();
        pan.disconnect();
      };
      src.start(ev.t);
      return;
    }
    // Pads and drones are synthesised live: detuned oscillators through a slowly moving low-pass.
    const out = ac.createGain();
    out.gain.value = 0;
    const t = ev.t;
    const hold = t + ev.attack + Math.max(0, ev.dur - ev.attack);
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(ev.vel, t + ev.attack);
    out.gain.setValueAtTime(ev.vel, hold);
    out.gain.setTargetAtTime(0, hold, ev.release / 4);
    const stopAt = hold + ev.release * 1.3;
    let head: AudioNode = out;
    let lp: BiquadFilterNode | null = null;
    if (ev.kind === 'pad') {
      lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 0.7;
      // Slow filter motion: opens through the chord, closes into the release.
      lp.frequency.setValueAtTime(ev.bright * 0.55, t);
      lp.frequency.linearRampToValueAtTime(ev.bright, t + ev.attack + ev.dur * 0.35);
      lp.frequency.linearRampToValueAtTime(ev.bright * 0.6, stopAt);
      lp.connect(out);
      head = lp;
    }
    out.connect(dest);
    const oscs: OscillatorNode[] = [];
    for (const m of ev.notes) {
      const f = hz(m);
      const layers: [OscillatorType, number, number][] =
        ev.kind === 'pad'
          ? [['sawtooth', -7 + rand(-2, 2), 1], ['sawtooth', 7 + rand(-2, 2), 1]]
          : [['sine', 0, 1], ['triangle', 12 + rand(-3, 3), 0.5]]; // drone: the detuned pair beats slowly
      for (const [type, cents, amp] of layers) {
        const o = ac.createOscillator();
        o.type = type;
        o.frequency.value = f;
        o.detune.value = cents;
        let node: AudioNode = o;
        if (amp !== 1) {
          const ag = ac.createGain();
          ag.gain.value = amp;
          o.connect(ag);
          node = ag;
        }
        node.connect(head);
        o.start(t);
        o.stop(stopAt);
        oscs.push(o);
      }
    }
    oscs[oscs.length - 1].onended = () => {
      for (const o of oscs) o.disconnect();
      lp?.disconnect();
      out.disconnect();
    };
  }

  /** Persistent tension layer, built lazily; its level follows the threat. */
  private updateTension(now: number) {
    const target = this.mood === 'auto' ? Math.pow(this.threat, 1.2) : 0;
    if (target > 0.001 && !this.tensionBuilt) this.buildTension();
    if (!this.tensionBuilt) return;
    const cur = this.tensionG.gain.value;
    this.tensionG.gain.setTargetAtTime(target, now, target > cur ? 1.0 : 3.0);
    // Duck the score under the tension so they don't fight.
    this.scoreG.gain.setTargetAtTime(this.moodGain.score * (1 - 0.75 * this.threat), now, 0.8);
  }

  private buildTension() {
    const ac = this.ac;
    this.tensionBuilt = true;
    // Low pulsing drone: saws on D1/D2 through a dark low-pass, amplitude pulsed like a slow heartbeat.
    const pulseLP = ac.createBiquadFilter();
    pulseLP.type = 'lowpass';
    pulseLP.frequency.value = 200;
    pulseLP.Q.value = 1.4;
    const pulseAmp = ac.createGain();
    pulseAmp.gain.value = 0.5;
    const lfo = ac.createOscillator();
    lfo.frequency.value = 1.25;
    const lfoDepth = ac.createGain();
    lfoDepth.gain.value = 0.45;
    lfo.connect(lfoDepth).connect(pulseAmp.gain);
    for (const [m, det] of [[26, 0], [38, 6]] as const) {
      const o = ac.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = hz(m);
      o.detune.value = det;
      o.connect(pulseLP);
      o.start();
    }
    const pulseOut = ac.createGain();
    pulseOut.gain.value = 0.22;
    pulseLP.connect(pulseAmp).connect(pulseOut).connect(this.tensionG);
    lfo.start();
    // Tremolo "strings": a close, dissonant voicing (D–Eb–A–D) with fast tremolo.
    const strLP = ac.createBiquadFilter();
    strLP.type = 'lowpass';
    strLP.frequency.value = 1500;
    strLP.Q.value = 0.6;
    const strPeak = ac.createBiquadFilter();
    strPeak.type = 'peaking';
    strPeak.frequency.value = 850;
    strPeak.Q.value = 1;
    strPeak.gain.value = 4;
    const trem = ac.createGain();
    trem.gain.value = 0.6;
    const tlfo = ac.createOscillator();
    tlfo.frequency.value = 6.5;
    const tdepth = ac.createGain();
    tdepth.gain.value = 0.4;
    tlfo.connect(tdepth).connect(trem.gain);
    for (const m of [50, 51, 57, 62]) {
      for (const det of [-6, 6]) {
        const o = ac.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = hz(m);
        o.detune.value = det + rand(-2, 2);
        o.connect(strLP);
        o.start();
      }
    }
    const strOut = ac.createGain();
    strOut.gain.value = 0.018;
    strLP.connect(strPeak).connect(trem).connect(strOut).connect(this.tensionG);
    tlfo.start();
  }
}
