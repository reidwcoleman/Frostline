// In-game time of day and day counter.
import type { EventBus } from './Events';

export const DAWN = 6.5;
export const DUSK = 19;

export class GameClock {
  /** Hour of day, 0..24. */
  time = 8;
  /** Day number, starting at 1. Increments at dawn. */
  day = 1;
  /** Real seconds per in-game 24h. */
  dayLength = 24 * 60;
  /** Multiplier (sleeping uses a large value). */
  timeScale = 1;
  frozen = false;
  /** Total in-game hours elapsed since the start of the run. */
  totalHours = 0;

  constructor(private events: EventBus) {}

  reset(startHour = 8) {
    this.time = startHour;
    this.day = 1;
    this.totalHours = 0;
    this.timeScale = 1;
  }

  /** Game-hours advanced per real second at the current scale. */
  get hoursPerSecond() {
    return (24 / this.dayLength) * this.timeScale;
  }

  update(dt: number) {
    if (this.frozen) return;
    this.advance(dt * this.hoursPerSecond);
  }

  /** Advance by in-game hours, firing dawn/dusk events on crossings. */
  advance(hours: number) {
    let remaining = hours;
    while (remaining > 0) {
      const step = Math.min(remaining, 0.25);
      const before = this.time;
      let after = before + step;
      if (after >= 24) after -= 24;
      this.time = after;
      this.totalHours += step;
      remaining -= step;
      if (crossed(before, after, DAWN)) {
        this.day++;
        this.events.emit('day:start', { day: this.day });
      }
      if (crossed(before, after, DUSK)) this.events.emit('night:start', { day: this.day });
    }
  }

  setTime(hour: number) {
    this.time = ((hour % 24) + 24) % 24;
  }

  get isNight() {
    return this.time < DAWN || this.time >= DUSK;
  }

  /** "07:42" */
  label(): string {
    const h = Math.floor(this.time);
    const m = Math.floor((this.time - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}

function crossed(before: number, after: number, mark: number) {
  if (after >= before) return before < mark && after >= mark;
  // wrapped past midnight
  return before < mark || after >= mark;
}
