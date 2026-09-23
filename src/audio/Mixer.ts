// The bus graph.
//
//   voices ─► bus[sfx|ui|music|ambience] ─┐
//   voices ─► valleySend[cat] ─► valley convolver ─► valleyReturn ─┤
//   voices ─► hallSend[cat]   ─► hall convolver   ─► hallReturn   ─┼─► master ─► visibility ─► limiter ─► destination
//
// Category volume lives on three nodes per category (dry bus + both sends) so the reverb tails obey the same
// slider as the dry sound. Every change is smoothed with setTargetAtTime: sliders never zipper or click.
import type { Settings } from '../core/Settings';

export type BusId = 'sfx' | 'ui' | 'music' | 'ambience';
export const BUSES: readonly BusId[] = ['sfx', 'ui', 'music', 'ambience'];

/** Fixed trims under the player's sliders: music sits well under SFX, UI a touch under gameplay. */
const TRIM: Record<BusId, number> = { sfx: 0.75, ui: 0.5, music: 0.5, ambience: 0.85 };

export class Mixer {
  readonly master: GainNode;
  readonly visibility: GainNode;
  readonly limiter: DynamicsCompressorNode;
  readonly bus = {} as Record<BusId, GainNode>;
  readonly valleySend = {} as Record<BusId, GainNode>;
  readonly hallSend = {} as Record<BusId, GainNode>;
  readonly valley: ConvolverNode;
  readonly hall: ConvolverNode;

  constructor(readonly ac: AudioContext, private settings: Settings) {
    this.limiter = ac.createDynamicsCompressor();
    // A gentle safety limiter, not a mix-bus squash: it only acts when many loud things pile up.
    this.limiter.threshold.value = -4;
    this.limiter.knee.value = 3;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.2;
    this.limiter.connect(ac.destination);
    this.visibility = ac.createGain();
    this.visibility.connect(this.limiter);
    this.master = ac.createGain();
    this.master.connect(this.visibility);

    this.valley = ac.createConvolver();
    this.valley.normalize = false; // IRs are energy-normalised at synthesis: predictable wet levels
    this.hall = ac.createConvolver();
    this.hall.normalize = false;
    const valleyReturn = ac.createGain();
    valleyReturn.gain.value = 0.6;
    const hallReturn = ac.createGain();
    hallReturn.gain.value = 0.8;
    this.valley.connect(valleyReturn).connect(this.master);
    this.hall.connect(hallReturn).connect(this.master);

    for (const b of BUSES) {
      this.bus[b] = ac.createGain();
      this.bus[b].connect(this.master);
      this.valleySend[b] = ac.createGain();
      this.valleySend[b].connect(this.valley);
      this.hallSend[b] = ac.createGain();
      this.hallSend[b].connect(this.hall);
    }
    this.applyVolumes(true);
  }

  /** Perceptual taper: sliders are linear 0..1, loudness is not. */
  private static taper(v: number): number {
    const x = Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 1;
    return x * x;
  }

  volumeOf(b: BusId): number {
    const d = this.settings.data;
    const v = b === 'music' ? d.musicVolume : b === 'ambience' ? d.ambienceVolume : d.sfxVolume;
    return Mixer.taper(v) * TRIM[b];
  }

  applyVolumes(immediate = false) {
    const now = this.ac.currentTime;
    const set = (p: AudioParam, v: number) => {
      if (immediate) p.value = v;
      else p.setTargetAtTime(v, now, 0.06);
    };
    set(this.master.gain, Mixer.taper(this.settings.data.masterVolume));
    for (const b of BUSES) {
      const v = this.volumeOf(b);
      set(this.bus[b].gain, v);
      set(this.valleySend[b].gain, v);
      set(this.hallSend[b].gain, v);
    }
  }

  /** Mute smoothly while the tab/window is hidden. */
  setHidden(hidden: boolean) {
    this.visibility.gain.setTargetAtTime(hidden ? 0 : 1, this.ac.currentTime, hidden ? 0.08 : 0.25);
  }

  /** Which reverb a category sends to: the hall for music/UI, the valley for the world. */
  sendFor(b: BusId): GainNode {
    return b === 'music' || b === 'ui' ? this.hallSend[b] : this.valleySend[b];
  }
}
