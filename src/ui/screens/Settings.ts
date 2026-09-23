// Settings: every SettingsData field, grouped in four tabs (LB / RB on a pad).
// Changes apply immediately (Settings persists itself); there is no "apply" step.
import { Screen } from './Screen';
import { h, stagger, clear } from '../dom';
import { capFor, ACTION_NAMES, padCap } from '../keys';
import type { SettingsData, QualityLevel } from '../../core/Settings';
import { keyLabel, type Action } from '../../core/Input';
import type { UI } from '../UI';

type TabId = 'display' | 'controls' | 'audio' | 'keys';
const TABS: { id: TabId; name: string }[] = [
  { id: 'display', name: 'Display' },
  { id: 'controls', name: 'Controls' },
  { id: 'audio', name: 'Audio' },
  { id: 'keys', name: 'Keys' },
];

type NumKey = { [K in keyof SettingsData]: SettingsData[K] extends number ? K : never }[keyof SettingsData];
type BoolKey = { [K in keyof SettingsData]: SettingsData[K] extends boolean ? K : never }[keyof SettingsData];

export class Settings extends Screen {
  private panel = h('div.panel.glass.center-panel');
  private title = h('h2', { text: 'Settings' });
  private tabs = h('div.seg.stabs');
  private list = h('div.list.scroll');
  private foot = h('div.foot');
  private doneBtn = h<'button'>('button.btn.primary', { text: 'Done' });
  private resetBtn = h<'button'>('button.btn.ghost', { text: 'Reset to defaults' });
  private cur: TabId = 'display';
  private tabBtns = new Map<TabId, HTMLButtonElement>();
  private hint = h('div.hints');

  constructor(ui: UI) {
    super(ui, 'settings');
    for (const t of TABS) {
      const b = h<'button'>('button', { text: t.name });
      b.addEventListener('click', () => this.setTab(t.id, true));
      this.tabs.append(b);
      this.tabBtns.set(t.id, b);
    }
    const top = h('div.top', null, this.title, this.hint);
    this.foot.append(this.resetBtn, this.doneBtn);
    this.panel.append(top, this.tabs, this.list, this.foot);
    this.root.append(h('div.scrim'), this.panel);
    this.doneBtn.addEventListener('click', () => this.back());
    this.resetBtn.addEventListener('click', () => {
      ui.sfx('ui_click');
      ui.ctx.settings.reset();
      this.render();
    });
    ui.hoverSounds(this.panel);
  }

  protected onShow() {
    this.setTab(this.cur, false);
    this.hint.innerHTML = this.ui.ctx.input.usingGamepad ? `<span class="h">${padCap('LB')}${padCap('RB')}Tabs</span>` : '';
    stagger([this.title, this.tabs, this.list, this.foot]);
  }

  initialFocus() {
    return this.tabBtns.get(this.cur) ?? null;
  }

  tab(dir: 1 | -1) {
    const i = TABS.findIndex((t) => t.id === this.cur);
    this.setTab(TABS[(i + dir + TABS.length) % TABS.length].id, true);
    this.ui.nav.focus(this.tabBtns.get(this.cur) ?? null);
  }

  private setTab(id: TabId, sound: boolean) {
    if (sound && id !== this.cur) this.ui.sfx('ui_click');
    this.cur = id;
    for (const [k, b] of this.tabBtns) b.classList.toggle('on', k === id);
    this.render();
  }

  private render() {
    clear(this.list);
    const s = this.ui.ctx.settings;
    const d = s.data;
    const rows: HTMLElement[] = [];
    if (this.cur === 'display') {
      rows.push(
        this.seg('Quality', ['low', 'medium', 'high', 'ultra'] as QualityLevel[], ['Low', 'Medium', 'High', 'Ultra'], d.quality, (v) => s.set('quality', v)),
        this.slider('Render scale', 'renderScale', 0.5, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
        this.slider('Field of view', 'fov', 60, 100, 1, (v) => `${Math.round(v)}°`),
        this.toggleRow('Fullscreen', 'fullscreen', (on) => this.ui.ctx.platform.setFullscreen(on)),
        this.toggleRow('Show frame rate', 'showFps'),
        this.seg('Units', ['metric', 'imperial'] as const, ['Metric', 'Imperial'], d.units, (v) => s.set('units', v)),
      );
    } else if (this.cur === 'controls') {
      rows.push(
        this.slider('Look sensitivity', 'sensitivity', 0.1, 3, 0.05, (v) => v.toFixed(2)),
        this.toggleRow('Invert look', 'invertY'),
        this.slider('Camera shake', 'cameraShake', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
        this.toggleRow('Head bob', 'headBob'),
        this.toggleRow('Motion blur', 'motionBlur'),
      );
    } else if (this.cur === 'audio') {
      const pct = (v: number) => `${Math.round(v * 100)}%`;
      rows.push(
        this.slider('Master', 'masterVolume', 0, 1, 0.05, pct),
        this.slider('Music', 'musicVolume', 0, 1, 0.05, pct),
        this.slider('Effects', 'sfxVolume', 0, 1, 0.05, pct),
        this.slider('Ambience', 'ambienceVolume', 0, 1, 0.05, pct),
      );
    } else {
      rows.push(this.bindings());
    }
    this.list.append(...rows);
    this.resetBtn.style.visibility = this.cur === 'keys' ? 'hidden' : '';
  }

  private row(label: string, ctl: HTMLElement, sub?: string) {
    return h('div.srow', null, h('div.lab', null, label, sub ? h('small', { text: sub }) : null), h('div.ctl', null, ctl));
  }

  private slider(label: string, key: NumKey, min: number, max: number, step: number, fmt: (v: number) => string) {
    const s = this.ui.ctx.settings;
    const input = h<'input'>('input.range', { type: 'range', min, max, step, value: s.data[key] });
    const val = h('span.val', { text: fmt(s.data[key]) });
    const paint = () => input.style.setProperty('--p', `${((Number(input.value) - min) / (max - min)) * 100}%`);
    paint();
    input.addEventListener('input', () => {
      const v = Number(input.value);
      val.textContent = fmt(v);
      paint();
      s.set(key, v);
    });
    input.addEventListener('change', () => this.ui.sfx('ui_hover'));
    const wrap = h('div.ctl', null, input, val);
    return h('div.srow', null, h('div.lab', { text: label }), wrap);
  }

  private toggleRow(label: string, key: BoolKey, after?: (on: boolean) => void) {
    const s = this.ui.ctx.settings;
    const sw = h<'button'>('button.switch', { 'aria-label': label }, h('i'));
    sw.classList.toggle('on', s.data[key]);
    sw.addEventListener('click', () => {
      const on = !s.data[key];
      s.set(key, on);
      sw.classList.toggle('on', on);
      this.ui.sfx('ui_click');
      after?.(on);
    });
    return this.row(label, sw);
  }

  private seg<T extends string>(label: string, values: readonly T[], names: string[], cur: T, set: (v: T) => void) {
    const seg = h('div.seg');
    values.forEach((v, i) => {
      const b = h<'button'>('button', { text: names[i] });
      b.classList.toggle('on', v === cur);
      b.addEventListener('click', () => {
        set(v);
        this.ui.sfx('ui_click');
        for (const c of Array.from(seg.children)) c.classList.remove('on');
        b.classList.add('on');
      });
      seg.append(b);
    });
    return this.row(label, seg);
  }

  private bindings() {
    const input = this.ui.ctx.input;
    const wrap = h('div.binds');
    const order: Action[] = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'crouch', 'toggleSkis', 'interact', 'attack', 'aim', 'freelook', 'inventory', 'crafting', 'build', 'map', 'rotate', 'demolish', 'nextSlot', 'holster', 'pause'];
    for (const a of order) {
      const codes = input.bindings[a] ?? [];
      // ShiftLeft/ShiftRight both read "Shift": show each label once.
      const kb = codes.filter((c, i) => !c.startsWith('Pad') && codes.findIndex((d) => keyLabel(d) === keyLabel(c)) === i).slice(0, 2);
      const pad = codes.filter((c) => c.startsWith('Pad')).slice(0, 1);
      const keys = h('div.keys', { html: [...kb, ...pad].map(capFor).join('') });
      wrap.append(h('div.bind', { 'data-nav': a }, h('span.lab', { text: ACTION_NAMES[a] ?? a }), keys));
    }
    wrap.append(h('div.bind', null, h('span.lab', { text: 'Hotbar slots' }), h('div.keys', { html: ['Digit1', 'Digit6'].map(capFor).join('<span style="color:var(--ink-3);padding:0 2px">–</span>') })));
    return wrap;
  }

  back() {
    this.ui.sfx('ui_close');
    this.ui.popScreen();
  }
}
