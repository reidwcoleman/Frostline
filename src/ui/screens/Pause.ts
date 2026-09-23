// Pause: three outcomes, nothing else.
import { Screen } from './Screen';
import { h, stagger, fmtClock } from '../dom';
import type { UI } from '../UI';

export class Pause extends Screen {
  private panel = h('div.panel.glass.center-panel');
  private title = h('h2', { text: 'Paused' });
  private meta = h('div.meta.num');
  private resumeBtn = h<'button'>('button.btn.primary.wide', { text: 'Resume' });
  private settingsBtn = h<'button'>('button.btn.wide', { text: 'Settings' });
  private quitBtn = h<'button'>('button.btn.ghost.wide', { text: 'Save and quit to menu' });
  private stack = h('div.stack');

  constructor(ui: UI) {
    super(ui, 'pause');
    this.stack.append(this.resumeBtn, this.settingsBtn, this.quitBtn);
    this.panel.append(this.title, this.meta, this.stack);
    this.root.append(h('div.scrim'), this.panel);
    this.resumeBtn.addEventListener('click', () => this.back());
    this.settingsBtn.addEventListener('click', () => {
      ui.sfx('ui_open');
      ui.openSettings();
    });
    this.quitBtn.addEventListener('click', () => void this.saveAndQuit());
    ui.hoverSounds(this.stack);
  }

  protected onShow() {
    const c = this.ui.ctx.clock;
    this.meta.textContent = `Day ${c.day}, ${fmtClock(c.time)}`;
    this.quitBtn.disabled = false;
    this.quitBtn.textContent = 'Save and quit to menu';
    stagger([this.title, this.meta, this.stack]);
  }

  private async saveAndQuit() {
    const ctx = this.ui.ctx;
    this.ui.sfx('ui_click');
    this.quitBtn.disabled = true;
    this.quitBtn.textContent = 'Saving';
    try {
      await ctx.sys.save?.save?.();
    } catch (err) {
      console.error('[ui] save failed', err);
      this.ui.toast('Could not save', 'bad');
    }
    ctx.game.quitToMenu();
  }

  back() {
    this.ui.sfx('ui_close');
    this.ui.ctx.game.resume();
  }
}
