// Inventory: item grid + detail pane (eat / use / equip / assign to hotbar).
import { h, clear } from '../dom';
import { itemIcon, icon } from '../icons';
import { ITEMS, HOTBAR_SIZE, type ItemId, type ItemKind } from '../../core/Items';
import { RECIPES, BUILD_PIECES } from '../../core/data';
import type { UI } from '../UI';
import type { JournalTab } from './Journal';

const KIND_ORDER: ItemKind[] = ['tool', 'weapon', 'light', 'ammo', 'food', 'medical', 'resource'];

export class InventoryTab implements JournalTab {
  readonly id = 'inventory' as const;
  readonly root = h('div', { style: 'display:contents' });
  private grid = h('div.pane.main.glass');
  private cells = h('div.cells');
  private scroll = h('div.scroll');
  private side = h('div.pane.side.glass');
  private sel: ItemId | null = null;
  private sig = '';
  private cellEls = new Map<ItemId, HTMLButtonElement>();
  weightText = '';

  constructor(private ui: UI) {
    this.scroll.append(this.cells);
    this.grid.append(this.scroll);
    this.root.append(this.grid, this.side);
    ui.ctx.events.on('item:changed', () => {
      if (this.root.isConnected) this.render();
    });
    ui.ctx.events.on('equip:changed', () => {
      if (this.root.isConnected) this.renderDetail();
    });
  }

  private items(): [ItemId, number][] {
    return this.ui.ctx.inventory
      .entries()
      .filter(([, n]) => n > 0)
      .sort((a, b) => KIND_ORDER.indexOf(ITEMS[a[0]].kind) - KIND_ORDER.indexOf(ITEMS[b[0]].kind) || ITEMS[a[0]].name.localeCompare(ITEMS[b[0]].name));
  }

  show() {
    this.sig = '';
    this.render();
  }
  hide() {}

  initialFocus(): HTMLElement | null {
    return (this.sel && this.cellEls.get(this.sel)) || (this.cells.firstElementChild as HTMLElement | null);
  }

  hints() {
    return '';
  }

  private render() {
    const inv = this.ui.ctx.inventory;
    const items = this.items();
    const key = items.map(([id, n]) => `${id}:${n}`).join(',') + '|' + inv.hotbar.join(',');
    let weight = 0;
    for (const [id, n] of items) weight += ITEMS[id].weight * n;
    this.weightText = `Carrying ${weight.toFixed(1)} kg`;
    this.ui.journalInfo(this.weightText);
    if (key !== this.sig) {
      this.sig = key;
      clear(this.cells);
      this.cellEls.clear();
      if (!items.length) {
        this.cells.style.display = 'none';
        if (!this.grid.querySelector('.empty-note')) this.grid.append(h('div.empty-note', { text: 'Nothing in your pack yet. Chop trees for logs and pick up sticks and stones.' }));
      } else {
        this.cells.style.display = '';
        this.grid.querySelector('.empty-note')?.remove();
      }
      for (const [id, n] of items) {
        const def = ITEMS[id];
        const slot = inv.hotbar.indexOf(id);
        const cell = h<'button'>('button.cell', { 'data-k': 'i:' + id, html: itemIcon(id) }, h('span.name', { text: def.name }), def.stack > 1 ? h('span.c.num', { text: String(n) }) : null, slot >= 0 ? h('span.inbar.num', { text: String(slot + 1) }) : null);
        cell.addEventListener('click', () => {
          this.ui.sfx('ui_click');
          this.select(id);
        });
        cell.addEventListener('navfocus', () => this.select(id, false));
        this.cells.append(cell);
        this.cellEls.set(id, cell);
      }
      // Faint empty slots give the pack a shape instead of a void.
      const total = Math.max(24, Math.ceil(items.length / 6) * 6);
      for (let i = items.length; i < total && items.length; i++) this.cells.append(h('div.cell.ph', { 'aria-hidden': 'true' }));
      this.ui.hoverSounds(this.cells);
      if (!this.sel || !inv.has(this.sel)) this.sel = items[0]?.[0] ?? null;
    }
    for (const [id, el] of this.cellEls) el.classList.toggle('sel', id === this.sel);
    this.renderDetail();
  }

  private select(id: ItemId, sound = true) {
    if (this.sel === id) return;
    this.sel = id;
    for (const [k, el] of this.cellEls) el.classList.toggle('sel', k === id);
    this.renderDetail();
    void sound;
  }

  private renderDetail() {
    const ctx = this.ui.ctx;
    const inv = ctx.inventory;
    clear(this.side);
    const id = this.sel;
    if (!id || !inv.has(id)) {
      this.side.append(h('div.empty-note', { text: 'Select an item to see what it does.' }));
      return;
    }
    const def = ITEMS[id];
    const n = inv.count(id);
    const d = h('div.detail');
    d.append(h('div.well', { html: itemIcon(id) }), h('div.title', { text: n > 1 ? `${def.name}  ×${n}` : def.name }), h('div.desc', { text: def.description }));

    const facts = h('div.facts');
    const fact = (k: string, v: string, ico?: string) => facts.append(h('div.fact', null, h('span.k', { html: (ico ? icon(ico) : '') + `<span>${k}</span>` }), h('span.v', { text: v })));
    if (def.food) fact('Food', `+${def.food}`, 'food');
    if (def.heal) fact('Health', `+${def.heal}`, 'health');
    if (def.warmth) fact('Warmth', `+${def.warmth}`, 'warmth');
    const uses = [...RECIPES.filter((r) => r.cost[id]).map((r) => r.name.replace(/ ×\d+$/, '')), ...BUILD_PIECES.filter((p) => p.cost[id]).map((p) => p.name)];
    if (uses.length) fact('Used for', uses.length > 3 ? `${uses.slice(0, 3).join(', ')} +${uses.length - 3}` : uses.join(', '));
    fact('Weight', `${(def.weight * n).toFixed(def.weight * n < 10 ? 1 : 0)} kg`);
    d.append(facts);

    const actions = h('div.actions');
    const consumable = def.kind === 'food' || def.kind === 'medical';
    if (consumable) {
      const b = h<'button'>('button.btn.primary.wide', { text: def.kind === 'food' ? (id === 'raw_meat' ? 'Eat raw' : 'Eat') : 'Apply bandage' });
      b.addEventListener('click', () => {
        const ok = ctx.sys.survival?.consume?.(id) ?? false;
        if (ok) this.ui.sfx('ui_click');
        else {
          this.ui.sfx('ui_error');
          b.classList.remove('shake');
          void b.offsetWidth;
          b.classList.add('shake');
        }
        this.render();
      });
      actions.append(b);
    }
    if (def.equip) {
      const inHand = inv.equipped === id;
      const b = h<'button'>('button.btn.wide' + (consumable ? '' : '.primary'), { text: inHand ? 'Put away' : 'Hold in hand' });
      b.addEventListener('click', () => {
        this.ui.sfx('ui_click');
        if (inv.equipped === id) inv.select(-1);
        else {
          let slot = inv.hotbar.indexOf(id);
          if (slot < 0) {
            slot = inv.hotbar.indexOf(null);
            if (slot < 0) slot = HOTBAR_SIZE - 1;
            inv.hotbar[slot] = id;
          }
          inv.select(slot);
        }
        this.sig = '';
        this.render();
      });
      actions.append(b);
    }
    if (def.equip || consumable) {
      actions.append(h('div.label', { text: 'Hotbar slot' }));
      const row = h('div.assign');
      for (let i = 0; i < HOTBAR_SIZE; i++) {
        const cur = inv.hotbar[i];
        const b = h<'button'>('button', { title: cur ? ITEMS[cur].name : 'Empty', html: cur && cur !== id ? itemIcon(cur) : `<span class="num">${i + 1}</span>` });
        b.classList.toggle('here', cur === id);
        b.addEventListener('click', () => {
          this.ui.sfx('ui_click');
          this.assign(id, i);
        });
        row.append(b);
      }
      actions.append(row);
    }
    if (actions.childElementCount) d.append(actions);
    this.side.append(d);
    this.ui.hoverSounds(actions);
  }

  /** Put an item in a hotbar slot, swapping with wherever it was. */
  private assign(id: ItemId, slot: number) {
    const inv = this.ui.ctx.inventory;
    const equipped = inv.equipped;
    const from = inv.hotbar.indexOf(id);
    const displaced = inv.hotbar[slot];
    if (from === slot) {
      inv.hotbar[slot] = null;
    } else {
      inv.hotbar[slot] = id;
      if (from >= 0) inv.hotbar[from] = displaced && displaced !== id ? displaced : null;
    }
    // Keep whatever was in hand in hand.
    const hand = equipped ? inv.hotbar.indexOf(equipped) : -1;
    inv.selected = hand;
    this.ui.ctx.events.emit('equip:changed', { item: inv.equipped });
    this.sig = '';
    this.render();
    this.ui.hud.wakeHotbar();
  }

  update() {
    // Counts can change while open (e.g. crafting finishes).
    const key = this.sig;
    if (key) {
      const inv = this.ui.ctx.inventory;
      const now = this.items().map(([i, n]) => `${i}:${n}`).join(',') + '|' + inv.hotbar.join(',');
      if (now !== key) this.render();
    }
    this.ui.journalInfo(this.weightText);
  }
}
