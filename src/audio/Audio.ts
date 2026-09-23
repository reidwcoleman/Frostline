// PLACEHOLDER audio (owned by the UI/audio agent). Silent implementation of AudioAPI.
import type { AudioAPI, GameContext, GameState, LoopHandle, PlayOpts, SoundId, System } from '../core/types';

const NULL_LOOP: LoopHandle = { setVolume() {}, setPitch() {}, setPosition() {}, stop() {} };

export class Audio implements System, AudioAPI {
  readonly name = 'audio';
  readonly updateWhen: GameState[] = ['boot', 'menu', 'playing', 'paused', 'dead'];
  constructor(private ctx: GameContext) {}
  play(_id: SoundId, _opts?: PlayOpts) {
    void this.ctx;
  }
  loop(_id: SoundId, _opts?: PlayOpts): LoopHandle {
    return NULL_LOOP;
  }
}
