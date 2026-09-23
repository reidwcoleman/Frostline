// Main menu: a frosted rail over the live mountain flyover, with real contour lines of
// the terrain drawn behind the logo.
import { Screen } from './Screen';
import { h, stagger } from '../dom';
import { drawContours } from '../contours';
import { padCap } from '../keys';
import type { UI } from '../UI';

export class MainMenu extends Screen {
  private rail = h('div.rail.grain');
  private canvas = h<'canvas'>('canvas');
  private logo = h('div.logo.serif', { text: 'Frostline' });
  private tag = h('div.tag', { text: 'Ski. Hunt. Build. Outlast the cold.' });
  private btns = h('div.btns');
  private cont = h<'button'>('button.mbtn');
  private contSub = h('span.sub.num');
  private newBtn = h<'button'>('button.mbtn', { text: 'New game' });
  private settingsBtn = h<'button'>('button.mbtn', { text: 'Settings' });
  private quitBtn = h<'button'>('button.mbtn', { text: 'Quit' });
  private foot = h('div.foot');
  private footHint = h('span.hints');
  private drawnFor = '';
  private hasSave = false;

  constructor(ui: UI) {
    super(ui, 'menu');
    this.cont.append(h('span', { text: 'Continue' }), this.contSub);
    this.btns.append(this.cont, this.newBtn, this.settingsBtn, this.quitBtn);
    this.foot.append(h('span', { text: 'Version 0.1' }), this.footHint);
    this.rail.append(this.canvas, this.logo, this.tag, this.btns, this.foot);
    this.root.append(this.rail);

    const ctx = ui.ctx;
    this.cont.addEventListener('click', () => {
      ui.unlockAudio();
      ui.sfx('ui_click');
      void ui.continueGame();
    });
    this.newBtn.addEventListener('click', () => {
      ui.unlockAudio();
      ui.sfx('ui_click');
      ctx.game.newGame();
    });
    this.settingsBtn.addEventListener('click', () => {
      ui.unlockAudio();
      ui.sfx('ui_open');
      ui.openSettings();
    });
    this.quitBtn.addEventListener('click', () => {
      ui.sfx('ui_back');
      ctx.platform.quit();
    });
    ui.hoverSounds(this.btns);
  }

  protected onShow() {
    const ctx = this.ui.ctx;
    this.quitBtn.style.display = ctx.platform?.isElectron ? '' : 'none';
    this.setHasSave(this.hasSave);
    void this.refreshSave();
    this.drawContours();
    this.footHint.innerHTML = this.ui.ctx.input.usingGamepad ? `<span class="h">${padCap('A')}Select</span>` : '';
    // On boot, wait for the loading screen to lift before the rail animates in.
    const booting = !!document.querySelector('.loading:not(.done)');
    stagger([this.logo, this.tag, this.btns, this.foot], booting ? 1000 : 120);
  }

  private setHasSave(has: boolean) {
    this.hasSave = has;
    this.cont.style.display = has ? '' : 'none';
    this.cont.classList.toggle('primary', has);
    this.newBtn.classList.toggle('primary', !has);
  }

  private async refreshSave() {
    const ctx = this.ui.ctx;
    try {
      const save = ctx.sys.save as unknown as { summary?: () => Promise<{ day: number; canContinue: boolean } | null> };
      if (save?.summary) {
        const s = await save.summary();
        const has = !!s?.canContinue;
        this.contSub.textContent = has && s ? `Day ${s.day}` : '';
        if (has !== this.hasSave) {
          this.setHasSave(has);
          if (this.isOpen) this.ui.nav.focus(this.initialFocus());
        }
        return;
      }
      const has = !!(await ctx.sys.save?.hasSave?.());
      let day = '';
      if (has) {
        const raw = await ctx.platform.saveRead('slot1').catch(() => null);
        if (raw) {
          try {
            const d = JSON.parse(raw) as { clock?: { day?: number } };
            if (d.clock?.day) day = `Day ${d.clock.day}`;
          } catch {
            /* unreadable save: still offer Continue */
          }
        }
      }
      this.contSub.textContent = day;
      if (has !== this.hasSave) {
        this.setHasSave(has);
        if (this.isOpen) this.ui.nav.focus(this.initialFocus());
      }
    } catch {
      this.setHasSave(false);
    }
  }

  initialFocus(): HTMLElement | null {
    return this.hasSave ? this.cont : this.newBtn;
  }

  /** Real contour lines around the lake, fitted to the rail and faded top/bottom. */
  private drawContours() {
    const ctx = this.ui.ctx;
    const t = ctx.terrain;
    if (!t) return;
    const rw = this.rail.clientWidth || 480,
      rh = this.rail.clientHeight || 900;
    const key = `${rw}x${rh}`;
    if (key === this.drawnFor) return;
    this.drawnFor = key;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const c = this.canvas;
    c.width = Math.round(rw * dpr);
    c.height = Math.round(rh * dpr);
    const g = c.getContext('2d');
    if (!g) return;
    // World window: 2600 m tall, centred a little north of the lake so ridges fill the rail.
    const [lx, lz] = t.data.lakeCenter;
    const worldH = 2600,
      worldW = (worldH * rw) / rh;
    const stride = 2;
    const cell = t.cell * stride;
    const nw = Math.ceil(worldW / cell) + 1,
      nh = Math.ceil(worldH / cell) + 1;
    const grid = new Float32Array(nw * nh);
    const x0 = lx - worldW * 0.62,
      z0 = lz - worldH * 0.55;
    for (let j = 0; j < nh; j++)
      for (let i = 0; i < nw; i++) {
        const gi = Math.round((x0 + i * cell + t.half) / t.cell);
        const gj = Math.round((z0 + j * cell + t.half) / t.cell);
        grid[j * nw + i] = t.sampleGrid(gi, gj);
      }
    drawContours(g, grid, nw, nh, {
      interval: 20,
      indexEvery: 5,
      minor: { color: 'rgba(242,239,232,0.06)', width: 1 * dpr },
      index: { color: 'rgba(242,239,232,0.12)', width: 1.25 * dpr },
      ox: 0,
      oy: 0,
      sx: c.width / (nw - 1),
      sy: c.height / (nh - 1),
    });
    // Fade out toward the top and bottom so type sits on calm ground.
    g.globalCompositeOperation = 'destination-in';
    const grad = g.createLinearGradient(0, 0, 0, c.height);
    grad.addColorStop(0, 'rgba(0,0,0,0.15)');
    grad.addColorStop(0.3, 'rgba(0,0,0,1)');
    grad.addColorStop(0.75, 'rgba(0,0,0,0.9)');
    grad.addColorStop(1, 'rgba(0,0,0,0.1)');
    g.fillStyle = grad;
    g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = 'source-over';
  }

  resize() {
    if (this.isOpen) this.drawContours();
  }

  back() {
    /* the root menu has nowhere to go back to */
  }
}
