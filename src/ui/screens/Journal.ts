// The journal: one frosted layer with four tabs (inventory, crafting, build, map).
// Tab / Q / B / M jump straight to a tab (pressing the same key again closes);
// LB / RB cycle on a gamepad.
import { Screen } from './Screen';
import { h, stagger, setText } from '../dom';
import { icon } from '../icons';
import { cap, capFor, padCap } from '../keys';
import { InventoryTab } from './InventoryTab';
import { CraftingTab } from './CraftingTab';
import { BuildTab } from './BuildTab';
import { MapTab } from './MapTab';
import type { UI } from '../UI';
import type { Action } from '../../core/Input';

export type JournalTabId = 'inventory' | 'crafting' | 'build' | 'map';

export interface JournalTab {
  readonly id: JournalTabId;
  readonly root: HTMLElement;
  show(): void;
  hide(): void;
  update?(dt: number): void;
  initialFocus(): HTMLElement | null;
  hints(): string;
  analog?(lx: number, ly: number, lt: number, rt: number, dt: number): void;
  key?(e: KeyboardEvent): boolean;
}

const META: { id: JournalTabId; name: string; icon: string; action: Action }[] = [
  { id: 'inventory', name: 'Inventory', icon: 'backpack', action: 'inventory' },
  { id: 'crafting', name: 'Crafting', icon: 'hammer', action: 'crafting' },
  { id: 'build', name: 'Build', icon: 'house', action: 'build' },
  { id: 'map', name: 'Map', icon: 'map', action: 'map' },
];

export class Journal extends Screen {
  private tabsEl = h('div.tabs.glass');
  private body = h('div.body');
  private foot = h('div.foot');
  readonly infoEl = h('div.hints.num');
  private hintsEl = h('div.hints');
  private tabBtns = new Map<JournalTabId, HTMLButtonElement>();
  private tabs: Record<JournalTabId, JournalTab>;
  current: JournalTabId = 'inventory';
  private lbCap = h('span.bumper');
  private rbCap = h('span.bumper');
  private padMode: boolean | null = null;

  constructor(ui: UI) {
    super(ui, 'journal');
    this.tabs = {
      inventory: new InventoryTab(ui),
      crafting: new CraftingTab(ui),
      build: new BuildTab(ui),
      map: new MapTab(ui),
    };
    this.tabsEl.append(this.lbCap);
    for (const m of META) {
      const b = h<'button'>('button.tab', { 'data-k': 't:' + m.id, html: icon(m.icon) + `<span>${m.name}</span><span class="kc"></span>` });
      b.addEventListener('click', () => {
        if (m.id !== this.current) {
          this.ui.sfx('ui_click');
          this.setTab(m.id);
        }
      });
      this.tabsEl.append(b);
      this.tabBtns.set(m.id, b);
    }
    this.tabsEl.append(this.rbCap);
    this.foot.append(this.infoEl, this.hintsEl);
    this.root.append(h('div.scrim'), this.tabsEl, this.body, this.foot);
    ui.hoverSounds(this.tabsEl);
  }

  open(tab: JournalTabId) {
    this.current = tab;
  }

  protected onShow() {
    this.padMode = null;
    this.refreshCaps();
    this.setTab(this.current, true);
    stagger([this.tabsEl, this.body, this.foot]);
  }

  protected onHide() {
    this.tabs[this.current].hide();
    this.tabs[this.current].root.remove();
  }

  private refreshCaps() {
    const pad = this.ui.ctx.input.usingGamepad;
    if (pad === this.padMode) return;
    this.padMode = pad;
    this.lbCap.innerHTML = pad ? padCap('LB') : '';
    this.rbCap.innerHTML = pad ? padCap('RB') : '';
    for (const m of META) {
      const kc = this.tabBtns.get(m.id)!.querySelector('.kc') as HTMLElement;
      kc.innerHTML = pad ? '' : cap(this.ui.ctx.input, m.action);
    }
    this.renderHints();
  }

  private renderHints() {
    const pad = this.ui.ctx.input.usingGamepad;
    const extra = this.tabs[this.current].hints();
    const close = pad ? `<span class="h">${padCap('B')}Close</span>` : `<span class="h">${'<span class="key">Esc</span>'}Close</span>`;
    const map =
      this.current === 'map'
        ? pad
          ? `<span class="h">${padCap('LT')}${padCap('RT')}Zoom</span><span class="h"><span class="key pad">LS</span>Pan</span>`
          : `<span class="h">${capFor('WheelUp')}Zoom</span><span class="h">${capFor('Mouse0')}Drag to pan</span>`
        : '';
    this.hintsEl.innerHTML = extra + map + close;
  }

  setTab(id: JournalTabId, initial = false) {
    const prev = this.tabs[this.current];
    if (!initial || prev.root.parentElement) {
      prev.hide();
      prev.root.remove();
    }
    this.current = id;
    for (const [k, b] of this.tabBtns) b.classList.toggle('on', k === id);
    const t = this.tabs[id];
    setText(this.infoEl, '');
    this.body.append(t.root);
    t.show();
    this.renderHints();
    this.ui.nav.focus(t.initialFocus(), this.ui.ctx.input.usingGamepad);
  }

  initialFocus() {
    return this.tabs[this.current].initialFocus();
  }

  tab(dir: 1 | -1) {
    const i = META.findIndex((m) => m.id === this.current);
    this.ui.sfx('ui_click');
    this.setTab(META[(i + dir + META.length) % META.length].id);
  }

  /** Only the map uses the stick/triggers directly; elsewhere the stick moves focus. */
  analog(lx: number, ly: number, lt: number, rt: number, dt: number): boolean {
    const t = this.tabs[this.current];
    if (!t.analog) return false;
    t.analog(lx, ly, lt, rt, dt);
    return true;
  }

  key(e: KeyboardEvent) {
    return this.tabs[this.current].key?.(e) ?? false;
  }

  update(dt: number) {
    this.refreshCaps();
    this.tabs[this.current].update?.(dt);
  }

  back() {
    this.ui.closeJournal();
  }
}
