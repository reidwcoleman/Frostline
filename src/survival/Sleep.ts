// Sleeping in a bedroll: "Sleep until dawn" at night, "Rest 1 hour" by day.
// Blocked when it's too cold (no fire/cabin), or wolves are near. Sleeping fast-forwards the clock
// (everything keeps simulating: fires burn fuel, satiety drains, you heal) and sets the respawn
// point. You wake early if the fire dies and you get cold, if something attacks, or wolves come.
import * as THREE from 'three';
import type { GameContext } from '../core/types';
import type { Piece } from './Structures';
import type { Survival } from './Survival';
import { DAWN } from '../core/Clock';
import { wolfNear } from './util';

/** Real seconds a full night's sleep takes (the UI fades on sleep:start / sleep:end). */
const NIGHT_SECONDS = 5;
const REST_SECONDS = 2;

export class Sleep {
  sleeping = false;
  private bedPos = new THREE.Vector3();
  private hoursLeft = 0;
  private hoursTotal = 0;
  private wake: string | null = null;
  private offDamage: (() => void) | null = null;

  constructor(private ctx: GameContext, private survival: Survival) {}

  init() {
    this.offDamage = this.ctx.events.on('player:damaged', () => {
      if (this.sleeping) this.wake = 'Something woke you!';
    });
  }

  reset() {
    if (this.sleeping) this.end(null);
    this.sleeping = false;
  }

  /** Interactable for a bedroll piece. Returns the remover. */
  bedInteraction(piece: Piece): () => void {
    const pos = piece.pos.clone().add(new THREE.Vector3(0, 0.35, 0));
    return this.ctx.interact.add({
      position: pos,
      radius: 0.9,
      label: () => (this.ctx.clock.isNight ? 'Sleep until dawn' : 'Rest 1 hour'),
      blockedReason: () => this.blockedReason(piece.pos),
      onInteract: () => this.start(piece.pos),
    });
  }

  /** Why you can't sleep here right now (null = you can). */
  blockedReason(at: THREE.Vector3): string | null {
    if (this.sleeping) return 'Sleeping…';
    const s = this.survival;
    if (wolfNear(this.ctx, at, 28)) return 'Wolves are prowling nearby';
    // Would we be warm enough lying here? (current conditions + the bedroll bonus)
    const felt = s.feltTemperatureAt(at, true);
    if (felt < -5 && s.fires.warmthAt(at) < 0.15 && !this.ctx.player.indoors) return 'Too cold to sleep — light a fire or get indoors';
    return null;
  }

  start(at: THREE.Vector3) {
    if (this.sleeping || this.blockedReason(at)) return;
    const { clock, events, player, ui } = this.ctx;
    const night = clock.isNight;
    const hours = night ? (((DAWN - clock.time) % 24) + 24) % 24 + 0.1 : 1;
    this.hoursTotal = hours;
    this.hoursLeft = hours;
    this.sleeping = true;
    this.wake = null;
    this.bedPos.copy(at);
    const seconds = night ? NIGHT_SECONDS : REST_SECONDS;
    // clock: hoursPerSecond = 24/dayLength * timeScale
    clock.timeScale = Math.max(1, (hours / seconds) * (clock.dayLength / 24));
    const first = !player.respawnPoint || player.respawnPoint.distanceTo(at) > 0.5;
    player.respawnPoint = at.clone();
    player.velocity.set(0, 0, 0);
    events.emit('sleep:start', { hours });
    if (first) ui.toast('Bedroll set as your respawn point', 'info');
  }

  update(dt: number, hours: number) {
    if (!this.sleeping) return;
    const p = this.ctx.player;
    this.hoursLeft -= hours;
    // Keep the sleeper in bed.
    p.velocity.set(0, 0, 0);
    p.position.x = this.bedPos.x;
    p.position.z = this.bedPos.z;
    if (!p.alive) {
      this.end(null);
      return;
    }
    if (!this.wake) {
      if (p.feltTemperature < -6 && !p.indoors && this.survival.fires.warmthAt(p.position) < 0.1) this.wake = 'You woke up shivering — the fire has gone out';
      else if (wolfNear(this.ctx, p.position, 18)) this.wake = 'You woke to growling nearby';
    }
    if (this.wake || this.hoursLeft <= 0) this.end(this.wake);
    void dt;
  }

  private end(reason: string | null) {
    const { clock, events, ui } = this.ctx;
    clock.timeScale = 1;
    this.sleeping = false;
    events.emit('sleep:end', {});
    if (reason) ui.toast(reason, 'warn');
    this.wake = null;
  }

  dispose() {
    this.offDamage?.();
  }
}
