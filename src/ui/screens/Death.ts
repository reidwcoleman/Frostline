// Death screen: the cause in plain words, how long you lasted in serif, and the run's
// stats counting up — the one orchestrated moment of this flow.
import { Screen } from './Screen';
import { h, stagger, countUp, fmtInt } from '../dom';
import type { UI } from '../UI';
import type { DamageCause } from '../../core/types';

const CAUSE: Record<DamageCause, string> = {
  cold: 'You froze to death.',
  hunger: 'You starved.',
  fall: 'The fall was too far.',
  crash: 'You crashed at speed.',
  wolf: 'The wolves found you.',
  fire: 'The fire took you.',
  unknown: 'The mountain took you.',
};

export class Death extends Screen {
  private cause = h('div.cause');
  private headline = h('h1');
  private stats = h('div.stats');
  private btns = h('div.btns');
  private respawnBtn = h<'button'>('button.btn', { text: 'Respawn at bedroll' });
  private newBtn = h<'button'>('button.btn', { text: 'New game' });
  private menuBtn = h<'button'>('button.btn.ghost', { text: 'Main menu' });
  /** From the 'player:died' event (PlayerState.die doesn't record it). */
  private causeOfDeath: DamageCause | null = null;

  constructor(ui: UI) {
    super(ui, 'death');
    ui.ctx.events.on('player:died', ({ cause }) => (this.causeOfDeath = cause));
    ui.ctx.events.on('player:respawned', () => (this.causeOfDeath = null));
    ui.ctx.events.on('newGame', () => (this.causeOfDeath = null));
    this.btns.append(this.respawnBtn, this.newBtn, this.menuBtn);
    this.root.append(h('div.col', null, this.cause, this.headline, this.stats, this.btns));
    const g = ui.ctx.game;
    this.respawnBtn.addEventListener('click', () => {
      ui.sfx('ui_click');
      g.respawn();
    });
    this.newBtn.addEventListener('click', () => {
      ui.sfx('ui_click');
      g.newGame();
    });
    this.menuBtn.addEventListener('click', () => {
      ui.sfx('ui_back');
      g.quitToMenu();
    });
    ui.hoverSounds(this.btns);
  }

  protected onShow() {
    const ctx = this.ui.ctx;
    const p = ctx.player;
    const units = ctx.settings.data.units;
    this.cause.textContent = CAUSE[this.causeOfDeath ?? p.lastDamageCause] ?? CAUSE.unknown;

    const hours = ctx.clock.totalHours;
    const days = Math.max(p.stats.daysSurvived ?? 0, Math.floor(hours / 24));
    this.headline.textContent = days >= 1 ? `You survived ${days} ${days === 1 ? 'day' : 'days'}` : `You lasted ${Math.max(1, Math.round(hours))} ${Math.round(hours) === 1 ? 'hour' : 'hours'}`;

    const hasBed = !!p.respawnPoint;
    this.respawnBtn.style.display = hasBed ? '' : 'none';
    this.respawnBtn.classList.toggle('primary', hasBed);
    this.newBtn.classList.toggle('primary', !hasBed);

    const st = p.stats;
    const imp = units === 'imperial';
    const dist = st.distanceSkied ?? 0;
    const cells: { k: string; v: number; fmt: (v: number) => string; unit?: string }[] = [
      { k: 'Skied', v: imp ? dist / 1609.34 : dist / 1000, fmt: (v) => v.toFixed(1), unit: imp ? 'mi' : 'km' },
      { k: 'Top speed', v: (st.topSpeed ?? 0) * (imp ? 2.23694 : 3.6), fmt: (v) => fmtInt(v), unit: imp ? 'mph' : 'km/h' },
      { k: 'Longest air', v: st.longestAir ?? 0, fmt: (v) => v.toFixed(1), unit: 's' },
      { k: 'Highest point', v: (st.highestAltitude ?? 0) * (imp ? 3.28084 : 1), fmt: (v) => fmtInt(v), unit: imp ? 'ft' : 'm' },
      { k: 'Trees felled', v: st.treesFelled ?? 0, fmt: (v) => fmtInt(v) },
      { k: 'Animals hunted', v: st.kills ?? 0, fmt: (v) => fmtInt(v) },
    ];
    this.stats.innerHTML = '';
    cells.forEach((c, i) => {
      const n = h('span');
      const cell = h('div.stat', null, h('div.n', null, n, c.unit ? h('small', { text: c.unit }) : null), h('div.k', { text: c.k }));
      this.stats.append(cell);
      countUp(n, c.v, 1400, c.fmt, 900 + i * 90);
    });
    stagger([this.cause, this.headline, this.stats, this.btns], 250);
  }

  initialFocus() {
    return this.respawnBtn.style.display !== 'none' ? this.respawnBtn : this.newBtn;
  }

  back() {
    /* death is a decision point: no implicit back */
  }
}
