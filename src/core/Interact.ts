// "Press E to ..." interactions. Systems register Interactables; each frame the one the
// player is looking at (within reach) is shown as a prompt and triggered on 'interact'.
import * as THREE from 'three';
import type { GameContext, PromptInfo } from './types';

export interface Interactable {
  /** World position of the thing (centre of the part you look at). */
  position: THREE.Vector3;
  /** Extra reach tolerance (meters) — big objects use bigger values. */
  radius: number;
  /** Prompt text, e.g. "Sleep", "Harvest deer", "Open door". */
  label(): string;
  /** Hidden when false. */
  enabled?(): boolean;
  /** Shown greyed-out with this reason when it returns a string (e.g. "Too cold to sleep"). */
  blockedReason?(): string | null;
  /** Hold duration in seconds (0/undefined = instant). */
  holdTime?: number;
  onInteract(): void;
}

const REACH = 2.6;
const _dir = new THREE.Vector3();
const _to = new THREE.Vector3();

export class Interactions {
  private items = new Set<Interactable>();
  current: Interactable | null = null;
  private holdProgress = 0;
  /** Other systems (e.g. weapons/building) can claim the prompt; interactions yield to them. */
  suppressed = false;

  add(item: Interactable): () => void {
    this.items.add(item);
    return () => this.remove(item);
  }

  remove(item: Interactable) {
    this.items.delete(item);
    if (this.current === item) this.current = null;
  }

  clear() {
    this.items.clear();
    this.current = null;
  }

  update(ctx: GameContext, dt: number) {
    const p = ctx.player;
    if (!p.alive || ctx.ui.blocking || this.suppressed) {
      if (this.current) ctx.ui.setPrompt(null);
      this.current = null;
      this.holdProgress = 0;
      return;
    }
    const eye = ctx.camera.position;
    ctx.camera.getWorldDirection(_dir);
    let best: Interactable | null = null;
    let bestScore = -Infinity;
    for (const it of this.items) {
      if (it.enabled && !it.enabled()) continue;
      _to.copy(it.position).sub(eye);
      const dist = _to.length();
      if (dist > REACH + it.radius) continue;
      _to.divideScalar(Math.max(dist, 1e-4));
      const dot = _to.dot(_dir);
      // Angular tolerance grows with object size and proximity.
      const minDot = Math.cos(Math.min(1.2, Math.atan2(it.radius + 0.35, Math.max(dist, 0.3))));
      if (dot < minDot) continue;
      const score = dot * 2 - dist * 0.3;
      if (score > bestScore) {
        bestScore = score;
        best = it;
      }
    }
    if (best !== this.current) this.holdProgress = 0;
    this.current = best;
    if (!best) {
      ctx.ui.setPrompt(null);
      return;
    }
    const blocked = best.blockedReason?.() ?? null;
    const prompt: PromptInfo = { action: 'interact', text: blocked ?? best.label(), disabled: !!blocked };
    if (!blocked) {
      const hold = best.holdTime ?? 0;
      if (hold > 0) {
        if (ctx.input.down('interact')) {
          this.holdProgress += dt / hold;
          if (this.holdProgress >= 1) {
            this.holdProgress = 0;
            best.onInteract();
          }
        } else this.holdProgress = 0;
        prompt.progress = this.holdProgress;
      } else if (ctx.input.pressed('interact')) {
        best.onInteract();
      }
    }
    ctx.ui.setPrompt(prompt);
  }
}
