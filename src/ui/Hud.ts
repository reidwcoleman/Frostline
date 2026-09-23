// In-game HUD. Built once; update() only writes to the DOM when a value actually changes.
// Principle: subtract. Vitals appear when they matter, the hotbar fades when idle,
// the speedometer exists only on skis.
import { h, setText, toggle, css, fmtTemp, fmtSpeed, fmtAlt, fmtClock } from './dom';
import { icon, itemIcon } from './icons';
import { cap } from './keys';
import { ITEMS, HOTBAR_SIZE, type ItemId } from '../core/Items';
import { PIECE, RECIPES } from '../core/data';
import { collectMarkers, MARKER_ICON, type Marker } from './markers';
import { damp, angleDelta, clamp } from '../core/math';
import type { GameContext, PromptInfo, Vec3Like } from '../core/types';
import type { Action } from '../core/Input';

const RAD2DEG = 180 / Math.PI;
const RING_C = 2 * Math.PI * 17;

type VitalKey = 'health' | 'warmth' | 'food' | 'stamina';
interface Vital {
  key: VitalKey;
  el: HTMLDivElement;
  fill: HTMLElement;
  val: HTMLElement | null;
  shown: number; // smoothed display value
  last: number;
  changedAt: number;
}

interface FeedEntry {
  item: ItemId;
  amount: number;
  el: HTMLDivElement;
  amt: HTMLElement;
  at: number;
}

/** Bearing in degrees (0 = north = -Z, 90 = east = +X) for a look yaw. */
export function yawToBearing(yaw: number) {
  return (((-yaw * RAD2DEG) % 360) + 360) % 360;
}
export function bearingTo(dx: number, dz: number) {
  return ((Math.atan2(dx, -dz) * RAD2DEG) % 360 + 360) % 360;
}

export class Hud {
  readonly root: HTMLDivElement;
  private scrimBL = h('div.scrim-bl');
  private scrimBR = h('div.scrim-br');
  private xhair = h('div.xhair');
  private hit = h('div.hit', null, h('i'), h('i'), h('i'), h('i'));
  private dmgdir = h('div.dmgdir', { html: '<svg viewBox="-100 -100 200 200"><path d="M -33.7 -83.4 A 90 90 0 0 1 33.7 -83.4"/></svg>' });
  private vigLow = h('div.vig-low');
  // prompt
  private prompt = h('div.prompt.off');
  private promptCap = h('span');
  private promptRing: SVGCircleElement;
  private promptText = h('span');
  private promptKey = '';
  private promptProgress = -1;
  private promptOn = false;
  // compass
  private compass = h('div.compass');
  private strip = h('div.strip');
  private caret = h('div.compass-caret');
  private compassNum = h('div.compass-num.num');
  private ppd = 3.6;
  private compassW = 0;
  private markerEls: HTMLDivElement[] = [];
  private markers: Marker[] = [];
  private markerT = 0;
  // clock / fps
  private clock = h('div.clock');
  private clockIcon = h('span');
  private clockDay = h('span');
  private clockTime = h('span.time.num');
  private night: boolean | null = null;
  private fps = h('div.fps.num');
  // vitals
  private vitalsEl = h('div.vitals');
  private vitals: Vital[] = [];
  // hotbar
  private hotbar = h('div.hotbar.idle');
  private slots: { el: HTMLDivElement; ico: HTMLElement; c: HTMLElement; id: ItemId | null }[] = [];
  private hotbarKey = '';
  private hotbarActive = -99;
  private hotbarLabel = h('div.hotbar-label');
  private labelUntil = 0;
  // speedo
  private speedo = h('div.speedo.off');
  private speedV = h('span.v.num');
  private speedU = h('span.u');
  private altEl = h('div.alt.num');
  private speedShown = 0;
  private speedoOffAt = 0;
  // feed / toasts
  private feed = h('div.feed');
  private feedEntries: FeedEntry[] = [];
  private toasts = h('div.toasts');
  // crafting + build help
  private craftbar = h('div.craftbar');
  private craftLabel = h('span');
  private craftFill = h('i');
  private buildhelp = h('div.buildhelp.off');
  private buildKey = '';
  private hints = h('div.buildhelp.off');
  private hintsUntil = 0;
  // title card
  private title = h('div.titlecard');
  private titleT = h('div.t');
  private titleS = h('div.s');
  private titleTimers: number[] = [];
  // pointer relock hint
  private relock = h('div.relock');
  everLocked = false;

  private now = 0;
  private lastFlash = -1;

  constructor(private ctx: GameContext) {
    this.root = h('div.hud.hidden');

    // prompt
    const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ring.setAttribute('class', 'ring');
    ring.setAttribute('viewBox', '0 0 40 40');
    ring.innerHTML = `<circle class="track" cx="20" cy="20" r="17"/><circle class="p" cx="20" cy="20" r="17" stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C}"/>`;
    this.promptRing = ring.querySelector('.p') as SVGCircleElement;
    ring.style.display = 'none';
    const capwrap = h('span.capwrap', null, this.promptCap);
    capwrap.append(ring);
    this.prompt.append(capwrap, this.promptText);

    // compass
    this.compass.append(this.strip);

    // clock
    this.clock.append(this.clockIcon, this.clockDay, this.clockTime);

    // vitals
    const vdefs: [VitalKey, boolean][] = [
      ['health', false],
      ['warmth', true],
      ['food', false],
      ['stamina', false],
    ];
    for (const [key, hasVal] of vdefs) {
      const fill = h('i');
      const val = hasVal ? h('span.val.num') : null;
      const el = h('div.vital.off', null, h('span', { html: icon(key) }).firstChild as HTMLElement, h('div.bar', null, fill), val ?? h('span'));
      this.vitalsEl.append(el);
      this.vitals.push({ key, el, fill, val, shown: 100, last: 100, changedAt: -99 });
    }

    // hotbar
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const ico = h('span');
      const c = h('span.c.num');
      const el = h('div.slot.empty', null, h('span.n', { text: String(i + 1) }), ico, c);
      this.hotbar.append(el);
      this.slots.push({ el, ico, c, id: null });
    }
    this.hotbarLabel.style.opacity = '0';

    // speedo
    this.speedo.append(h('div', null, this.speedV, this.speedU), this.altEl);

    // crafting bar
    this.craftbar.append(this.craftLabel, h('div.line', null, this.craftFill));
    this.craftbar.style.opacity = '0';

    // title card
    this.title.append(this.titleT, h('div.rule'), this.titleS);

    this.relock.innerHTML = '';
    this.relock.style.opacity = '0';

    this.root.append(
      this.vigLow,
      this.scrimBL,
      this.scrimBR,
      this.dmgdir,
      this.xhair,
      this.hit,
      this.prompt,
      this.craftbar,
      this.compass,
      this.caret,
      this.compassNum,
      this.clock,
      this.fps,
      this.vitalsEl,
      this.hotbarLabel,
      this.hotbar,
      this.buildhelp,
      this.hints,
      this.speedo,
      this.feed,
      this.toasts,
      this.title,
      this.relock,
    );

    ctx.events.on('item:changed', ({ item, delta }) => {
      if (ctx.game.state === 'playing' && delta > 0) this.pushFeed(item, delta);
      this.hotbarKey = ''; // force a hotbar refresh
    });
    ctx.events.on('equip:changed', ({ item }) => {
      this.hotbarKey = '';
      this.wakeHotbar();
      if (item) {
        setText(this.hotbarLabel, ITEMS[item].name);
        this.labelUntil = this.now + 1.6;
      }
    });
    ctx.events.on('loadedGame', () => (this.hotbarKey = ''));
    ctx.events.on('newGame', () => (this.hotbarKey = ''));
    ctx.events.on('player:damaged', ({ amount, cause, from }) => {
      // Continuous drains (cold, hunger) use vignettes instead of flashing every tick.
      if (cause === 'cold' || cause === 'hunger') return;
      if (amount < 2 && cause !== 'wolf') return;
      this.damageFlash(from);
    });
  }

  // ------------------------------------------------------------------ API
  setPrompt(p: PromptInfo | null) {
    if (!p) {
      if (this.promptOn) {
        this.promptOn = false;
        this.prompt.classList.add('off');
        toggle(this.xhair, 'active', false);
      }
      return;
    }
    const input = this.ctx.input;
    const key = `${p.action}|${p.text}|${p.disabled ? 1 : 0}|${input.usingGamepad ? 1 : 0}`;
    if (key !== this.promptKey) {
      this.promptKey = key;
      this.promptCap.innerHTML = cap(input, p.action as Action);
      setText(this.promptText, p.text);
      toggle(this.prompt, 'disabled', !!p.disabled);
    }
    const prog = p.progress !== undefined && p.progress > 0 ? clamp(p.progress, 0, 1) : -1;
    if (prog !== this.promptProgress) {
      const ring = this.promptRing.ownerSVGElement as SVGSVGElement;
      ring.style.display = prog >= 0 ? '' : 'none';
      if (prog >= 0) this.promptRing.setAttribute('stroke-dashoffset', String(RING_C * (1 - prog)));
      this.promptProgress = prog;
    }
    if (!this.promptOn) {
      this.promptOn = true;
      this.prompt.classList.remove('off');
    }
    toggle(this.xhair, 'active', !p.disabled);
  }

  toast(text: string, kind: 'info' | 'good' | 'warn' | 'bad' = 'info') {
    for (const t of Array.from(this.toasts.children) as HTMLElement[]) {
      if (t.dataset.text === text && !t.classList.contains('gone')) {
        t.dataset.until = String(this.now + 3.4);
        return;
      }
    }
    const el = h('div.toast.' + kind, null, h('span.dot'), h('span', { text }));
    el.dataset.text = text;
    el.dataset.until = String(this.now + 3.4);
    this.toasts.append(el);
    while (this.toasts.children.length > 3) this.toasts.firstElementChild!.remove();
  }

  hitMarker(kill = false) {
    toggle(this.hit, 'kill', kill);
    this.hit.classList.remove('show');
    void this.hit.offsetWidth;
    this.hit.classList.add('show');
  }

  damageFlash(from?: Vec3Like) {
    if (this.now - this.lastFlash < 0.12) return;
    this.lastFlash = this.now;
    // The full-screen red flash and frost belong to the post stack (PostFX); the HUD adds direction.
    if (from) {
      const p = this.ctx.player.position;
      const rel = angleDelta(yawToBearing(this.ctx.player.yaw) / RAD2DEG, bearingTo(from.x - p.x, from.z - p.z) / RAD2DEG) * RAD2DEG;
      this.dmgdir.style.transform = `rotate(${rel.toFixed(1)}deg)`;
      this.dmgdir.classList.remove('show');
      void this.dmgdir.offsetWidth;
      this.dmgdir.classList.add('show');
    }
  }

  /** Orchestrated title card (dawn "Day N", first day). */
  bigTitle(title: string, subtitle = '', holdMs = 4200) {
    for (const t of this.titleTimers) clearTimeout(t);
    this.titleTimers = [];
    this.title.classList.remove('show', 'hide');
    setText(this.titleT, title);
    setText(this.titleS, subtitle);
    (this.titleS as HTMLElement).style.display = subtitle ? '' : 'none';
    void this.title.offsetWidth;
    this.titleTimers.push(
      window.setTimeout(() => this.title.classList.add('show'), 30),
      window.setTimeout(() => this.title.classList.add('hide'), holdMs),
      window.setTimeout(() => this.title.classList.remove('show', 'hide'), holdMs + 1800),
    );
  }

  pushFeed(item: ItemId, amount: number) {
    const e = this.feedEntries.find((f) => f.item === item && this.now - f.at < 2.5 && !f.el.classList.contains('gone'));
    if (e) {
      e.amount += amount;
      e.at = this.now;
      setText(e.amt, `+${e.amount}`);
      e.el.style.animation = 'none';
      void e.el.offsetWidth;
      e.el.style.animation = '';
      return;
    }
    const amt = h('span.amt.num', { text: `+${amount}` });
    const el = h('div.feed-item', { html: itemIcon(item) }, amt, h('span.name', { text: ITEMS[item].name }));
    this.feed.append(el);
    this.feedEntries.push({ item, amount, el, amt, at: this.now });
    while (this.feedEntries.length > 5) this.feedEntries.shift()!.el.remove();
  }

  /** First-run key hints (a single pill above the hotbar that fades on its own). */
  showHints(actions: [Action, string][], seconds = 9) {
    const i = this.ctx.input;
    this.hints.innerHTML = actions.map(([a, label]) => `<span class="k">${cap(i, a)}${label}</span>`).join('');
    this.hintsUntil = this.now + seconds;
  }

  /** Force the hotbar visible (inventory change, key press). */
  wakeHotbar() {
    this.hotbarActive = this.now;
  }

  resize() {
    this.compassW = this.compass.clientWidth;
    if (!this.compassW) return;
    this.ppd = this.compassW / 150;
    const ppd = this.ppd;
    this.strip.innerHTML = '';
    this.strip.style.width = `${1080 * ppd}px`;
    const names: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    const frag = document.createDocumentFragment();
    for (let d = -360; d <= 720; d += 15) {
      const x = (d + 360) * ppd;
      const nd = ((d % 360) + 360) % 360;
      const name = names[nd];
      if (name) {
        const card = nd % 90 === 0;
        const l = h('div.lbl' + (card ? '.card' : ''), { text: name });
        l.style.left = `${x}px`;
        frag.append(l);
      } else {
        const t = h('div.tick' + (nd % 45 === 0 ? '.major' : ''));
        t.style.left = `${x}px`;
        frag.append(t);
      }
    }
    this.strip.append(frag);
  }

  // ------------------------------------------------------------------ frame
  update(dt: number, visible: boolean) {
    const ctx = this.ctx;
    this.now += dt;
    toggle(this.root, 'hidden', !visible);
    this.updateToastsAndFeed();
    if (!visible) return;
    if (!this.compassW) this.resize();

    const p = ctx.player;
    const units = ctx.settings.data.units;

    // ---- compass
    const bearing = yawToBearing(p.yaw);
    css(this.strip, 'transform', `translate3d(${(this.compassW / 2 - (bearing + 360) * this.ppd).toFixed(1)}px,0,0)`);
    this.markerT -= dt;
    if (this.markerT <= 0) {
      this.markerT = 0.5;
      this.markers = collectMarkers(ctx);
      while (this.markerEls.length < this.markers.length) {
        const el = h('div.mk');
        this.compass.append(el);
        this.markerEls.push(el);
      }
      this.markerEls.forEach((el, i) => {
        const m = this.markers[i];
        const k = m ? m.kind : '';
        if (el.dataset.kind !== k) {
          el.dataset.kind = k;
          el.innerHTML = m ? icon(MARKER_ICON[m.kind]) : '';
        }
      });
    }
    let centred: Marker | null = null;
    let centredDist = 0;
    for (let i = 0; i < this.markerEls.length; i++) {
      const el = this.markerEls[i];
      const m = this.markers[i];
      if (!m) {
        css(el, 'opacity', '0');
        continue;
      }
      const dx = m.x - p.position.x,
        dz = m.z - p.position.z;
      const dist = Math.hypot(dx, dz);
      const rel = angleDelta(bearing / RAD2DEG, bearingTo(dx, dz) / RAD2DEG) * RAD2DEG;
      const vis = Math.abs(rel) < 72 && dist > 12 && !(m.kind === 'spawn' && dist < 80);
      css(el, 'opacity', vis ? (dist > 1500 ? '0.55' : '1') : '0');
      if (vis) css(el, 'transform', `translate3d(${(this.compassW / 2 + rel * this.ppd).toFixed(1)}px,0,0)`);
      if (vis && Math.abs(rel) < 6 && (!centred || dist < centredDist)) {
        centred = m;
        centredDist = dist;
      }
    }
    const dist = centred ? (units === 'imperial' ? `${Math.round(centredDist * 3.28084)} ft` : centredDist >= 1000 ? `${(centredDist / 1000).toFixed(1)} km` : `${Math.round(centredDist)} m`) : '';
    setText(this.compassNum, centred ? `${centred.label}  ${dist}` : `${Math.round(bearing) % 360}°`);

    // ---- clock
    const night = ctx.clock.isNight;
    if (night !== this.night) {
      this.night = night;
      this.clockIcon.innerHTML = icon(night ? 'moon' : 'sun');
    }
    setText(this.clockDay, `Day ${ctx.clock.day}`);
    setText(this.clockTime, fmtClock(ctx.clock.time));

    // ---- fps
    const showFps = ctx.settings.data.showFps;
    css(this.fps, 'display', showFps ? 'block' : 'none');
    if (showFps) setText(this.fps, `${Math.round(window.__frostline?.fps ?? 0)} fps`);

    // ---- vitals
    let anyVital = false;
    const warmthFalling = p.feltTemperature < 0 && p.nearFire < 0.2;
    for (const v of this.vitals) {
      const value = v.key === 'health' ? p.health : v.key === 'warmth' ? p.warmth : v.key === 'food' ? p.satiety : p.stamina;
      if (Math.abs(value - v.last) > 0.02) v.changedAt = this.now;
      const rising = value > v.last + 0.001;
      v.last = value;
      v.shown = damp(v.shown, value, 10, dt);
      css(v.fill, 'transform', `scaleX(${(clamp(v.shown, 0, 100) / 100).toFixed(3)})`);
      const lowAt = v.key === 'stamina' ? 15 : v.key === 'food' ? 20 : 25;
      const low = value < lowAt;
      toggle(v.el, 'low', low);
      if (v.key === 'warmth') {
        toggle(v.el, 'cold', !low && warmthFalling && !rising);
        if (v.val) setText(v.val, fmtTemp(p.feltTemperature, units));
      }
      // Stamina only matters while it's being spent; the rest while below full.
      const show = low || (v.key === 'stamina' ? value < 97 && this.now - v.changedAt < 2.5 : value < 97 || this.now - v.changedAt < 2.5);
      toggle(v.el, 'off', !show);
      anyVital ||= show;
    }
    toggle(this.scrimBL, 'on', anyVital);
    css(this.vigLow, 'opacity', (p.health < 30 ? ((30 - p.health) / 30) * 0.9 : 0).toFixed(2));

    // ---- hotbar
    this.updateHotbar();
    const building = ctx.sys.building?.placing ?? null;
    const hotbarVisible = this.now - this.hotbarActive < 4 || building !== null;
    toggle(this.hotbar, 'idle', !hotbarVisible);
    css(this.hotbarLabel, 'opacity', this.now < this.labelUntil ? '1' : '0');

    // ---- speedometer (skis only)
    const speed = Math.hypot(p.velocity.x, p.velocity.y, p.velocity.z);
    this.speedShown = damp(this.speedShown, speed, 8, dt);
    const onSkis = p.onSkis && p.alive;
    if (onSkis && speed > 1.4) this.speedoOffAt = this.now + 2;
    const speedoOn = onSkis && this.now < this.speedoOffAt;
    toggle(this.speedo, 'off', !speedoOn);
    toggle(this.scrimBR, 'on', speedoOn || this.feedEntries.length > 0);
    if (speedoOn) {
      const s = fmtSpeed(this.speedShown, units);
      setText(this.speedV, String(s.v));
      setText(this.speedU, s.u);
      setText(this.altEl, fmtAlt(p.position.y, units));
    }

    // ---- crafting progress (outside the crafting screen)
    const prog = ctx.sys.crafting?.progress ?? -1;
    if (prog >= 0) {
      const cur = (ctx.sys.crafting as unknown as { current?: { name?: string; id?: string } | string | null }).current;
      const name = typeof cur === 'string' ? RECIPES.find((r) => r.id === cur)?.name : cur?.name;
      setText(this.craftLabel, name ? `Crafting ${name.replace(/ ×\d+$/, '').toLowerCase()}` : 'Crafting');
      css(this.craftFill, 'transform', `scaleX(${clamp(prog, 0, 1).toFixed(3)})`);
    }
    css(this.craftbar, 'opacity', prog >= 0 ? '1' : '0');

    // ---- build help strip
    const bkey = building ? `${building}|${ctx.input.usingGamepad ? 1 : 0}` : '';
    if (bkey !== this.buildKey) {
      this.buildKey = bkey;
      if (building) {
        const i = ctx.input;
        const piece = PIECE[building];
        this.buildhelp.innerHTML =
          `<span class="piece">${piece?.name ?? 'Build'}</span>` +
          `<span class="k">${cap(i, 'attack')}Place</span>` +
          `<span class="k">${cap(i, 'rotate')}Rotate</span>` +
          `<span class="k">${cap(i, 'demolish')}Demolish</span>` +
          `<span class="k">${cap(i, 'aim')}Cancel</span>`;
      }
      toggle(this.buildhelp, 'off', !building);
    }

    toggle(this.hints, 'off', this.now > this.hintsUntil || building !== null);

    // ---- crosshair hidden while building (the ghost is the reticle)
    toggle(this.xhair, 'hide', building !== null || !p.alive);

    // ---- pointer-lock hint for real players who lost the lock
    const needLock = this.everLocked && ctx.game.state === 'playing' && !ctx.ui.blocking && !ctx.input.pointerLocked && !ctx.input.usingGamepad;
    if (needLock && !this.relock.innerHTML) this.relock.innerHTML = `${cap(ctx.input, 'attack')}<span>Click to look around</span>`;
    css(this.relock, 'opacity', needLock ? '1' : '0');
  }

  private lastSel = -2;
  private updateHotbar() {
    const inv = this.ctx.inventory;
    // Cheap early-out: events clear hotbarKey; otherwise only the selection can change.
    if (this.hotbarKey && inv.selected === this.lastSel) return;
    this.lastSel = inv.selected;
    let key = String(inv.selected);
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const id = inv.hotbar[i];
      key += '|' + (id ?? '') + ':' + (id ? inv.count(id) : 0);
    }
    if (key === this.hotbarKey) return;
    if (this.hotbarKey) this.wakeHotbar();
    this.hotbarKey = key;
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const s = this.slots[i];
      const id = inv.hotbar[i];
      const has = !!id && inv.has(id);
      if (s.id !== id) {
        s.id = id;
        s.ico.innerHTML = id ? itemIcon(id) : '';
      }
      toggle(s.el, 'empty', !has);
      const n = id ? inv.count(id) : 0;
      setText(s.c, id && ITEMS[id].stack > 1 && n > 0 ? String(n) : '');
      toggle(s.el, 'sel', inv.selected === i && has);
    }
  }

  private updateToastsAndFeed() {
    for (const t of Array.from(this.toasts.children) as HTMLElement[]) {
      const until = Number(t.dataset.until);
      if (this.now > until && !t.classList.contains('gone')) {
        t.classList.add('gone');
        t.dataset.until = String(this.now + 0.5);
        t.dataset.dead = '1';
      } else if (t.dataset.dead && this.now > until) t.remove();
    }
    for (let i = this.feedEntries.length - 1; i >= 0; i--) {
      const f = this.feedEntries[i];
      const age = this.now - f.at;
      if (age > 3.2 && !f.el.classList.contains('gone')) f.el.classList.add('gone');
      if (age > 3.8) {
        f.el.remove();
        this.feedEntries.splice(i, 1);
      }
    }
  }
}
