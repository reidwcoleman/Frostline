// Crafting: recipe list with have/need chips (missing counts in red) + a detail pane with
// the craft button, progress and the "needs a fire" state.
import { h, clear, css } from '../dom';
import { itemIcon, icon } from '../icons';
import { ITEMS, type ItemId } from '../../core/Items';
import { RECIPES, type Recipe } from '../../core/data';
import type { UI } from '../UI';
import type { JournalTab } from './Journal';

export class CraftingTab implements JournalTab {
  readonly id = 'crafting' as const;
  readonly root = h('div', { style: 'display:contents' });
  private list = h('div.pane.main.glass');
  private rows = h('div.rows');
  private side = h('div.pane.side.glass');
  private sel: string | null = null;
  private rowEls = new Map<string, HTMLButtonElement>();
  private stateKey = '';
  private progressFill: HTMLElement | null = null;
  private progressLabel: HTMLElement | null = null;

  constructor(private ui: UI) {
    const scroll = h('div.scroll', null, this.rows);
    this.list.append(scroll);
    this.root.append(this.list, this.side);
    ui.ctx.events.on('item:crafted', () => {
      if (this.root.isConnected) this.ui.sfx('ui_craft');
    });
  }

  private get recipes(): Recipe[] {
    return this.ui.ctx.sys.crafting?.recipes ?? RECIPES;
  }

  private missing(r: Recipe): Partial<Record<ItemId, number>> {
    const c = this.ui.ctx.sys.crafting;
    if (c?.missing) return c.missing(r.id);
    const out: Partial<Record<ItemId, number>> = {};
    for (const k in r.cost) {
      const need = r.cost[k as ItemId]! - this.ui.ctx.inventory.count(k as ItemId);
      if (need > 0) out[k as ItemId] = need;
    }
    return out;
  }

  private nearFire(): boolean {
    try {
      return !!this.ui.ctx.sys.crafting?.nearFire?.();
    } catch {
      return false;
    }
  }

  show() {
    this.stateKey = '';
    this.render();
  }
  hide() {}

  hints() {
    return '';
  }

  initialFocus(): HTMLElement | null {
    return (this.sel && this.rowEls.get(this.sel)) || (this.rows.firstElementChild as HTMLElement | null);
  }

  /** A key over everything that affects what's drawn (counts + fire + progress state). */
  private computeKey() {
    const inv = this.ui.ctx.inventory;
    let k = this.nearFire() ? 'F' : 'f';
    k += (this.ui.ctx.sys.crafting?.progress ?? -1) >= 0 ? 'P' : 'p';
    for (const id of ['log', 'stick', 'stone', 'hide', 'raw_meat', 'cloth'] as ItemId[]) k += inv.count(id) + ',';
    return k + this.sel;
  }

  private render() {
    this.stateKey = this.computeKey();
    clear(this.rows);
    this.rowEls.clear();
    const fire = this.nearFire();
    const inv = this.ui.ctx.inventory;
    if (!this.sel) this.sel = this.recipes[0]?.id ?? null;
    for (const r of this.recipes) {
      const miss = this.missing(r);
      const ok = Object.keys(miss).length === 0 && (!r.needsFire || fire);
      const chips = h('div.chips');
      for (const k in r.cost) {
        const id = k as ItemId;
        const need = r.cost[id]!;
        const have = inv.count(id);
        chips.append(h('span.chip' + (have < need ? '.short' : ''), { title: ITEMS[id].name, html: itemIcon(id) + `<span><span class="n">${Math.min(have, 99)}</span><span class="d">/${need}</span></span>` }));
      }
      const sub = r.needsFire ? h('div.sub', { html: icon('campfire') + `<span>${fire ? 'At the fire' : 'Needs a fire'}</span>` }) : r.count > 1 ? h('div.sub', { text: `Makes ${r.count}` }) : null;
      const row = h<'button'>('button.row' + (ok ? '' : '.na'), { 'data-k': 'r:' + r.id }, h('span.well', { html: itemIcon(r.out) }), h('div', null, h('div.name', { text: r.name.replace(/ ×\d+$/, '') }), sub), chips);
      row.classList.toggle('sel', r.id === this.sel);
      row.addEventListener('click', () => {
        if (this.sel === r.id && ok) this.craft(r);
        else this.select(r.id);
      });
      row.addEventListener('navfocus', () => this.select(r.id));
      this.rows.append(row);
      this.rowEls.set(r.id, row);
    }
    this.ui.hoverSounds(this.rows);
    this.renderDetail();
  }

  private select(id: string) {
    if (this.sel === id) return;
    this.sel = id;
    this.ui.sfx('ui_hover');
    for (const [k, el] of this.rowEls) el.classList.toggle('sel', k === id);
    this.renderDetail();
    this.stateKey = this.computeKey();
  }

  private craftLabel(r: Recipe) {
    if (r.id === 'cook') return 'Cook meat';
    const out = ITEMS[r.out].name.toLowerCase();
    return r.count > 1 ? `Craft ${r.count} ${out}s` : `Craft ${r.name.toLowerCase()}`;
  }

  private renderDetail() {
    clear(this.side);
    this.progressFill = this.progressLabel = null;
    const r = this.recipes.find((x) => x.id === this.sel);
    if (!r) return;
    const inv = this.ui.ctx.inventory;
    const fire = this.nearFire();
    const miss = this.missing(r);
    const d = h('div.detail');
    d.append(h('div.well', { html: itemIcon(r.out) }), h('div.title', { text: r.name.replace(/ ×(\d+)$/, '') }), h('div.desc', { text: ITEMS[r.out].description }));
    const facts = h('div.facts');
    for (const k in r.cost) {
      const id = k as ItemId;
      const need = r.cost[id]!;
      const have = inv.count(id);
      facts.append(h('div.fact', null, h('span.k', { html: itemIcon(id) + `<span>${ITEMS[id].name}</span>` }), h('span.v' + (have < need ? '.short' : ''), { text: `${have} / ${need}` })));
    }
    if (r.needsFire) facts.append(h('div.fact', null, h('span.k', { html: icon('campfire') + '<span>Lit fire nearby</span>' }), h('span.v' + (fire ? '' : '.muted'), { text: fire ? 'Yes' : 'No' })));
    facts.append(h('div.fact', null, h('span.k', { html: '<span>Time</span>' }), h('span.v', { text: `${r.seconds} s` })));
    d.append(facts);

    const actions = h('div.actions');
    const prog = this.ui.ctx.sys.crafting?.progress ?? -1;
    if (prog >= 0) {
      const crafting = this.ui.ctx.sys.crafting as unknown as { current?: Recipe | null; cancel?: () => void };
      const cur = crafting.current;
      this.progressFill = h('i');
      this.progressLabel = h('span', { text: cur ? `Crafting ${cur.name.replace(/ ×\d+$/, '').toLowerCase()}` : 'Crafting' });
      actions.append(h('div.progress', null, this.progressFill, this.progressLabel));
      if (crafting.cancel) {
        const c = h<'button'>('button.btn.ghost.wide', { 'data-k': 'cancel', text: 'Cancel and refund' });
        c.addEventListener('click', () => {
          this.ui.sfx('ui_back');
          crafting.cancel?.();
          this.render();
        });
        actions.append(c);
      }
    } else {
      const missKeys = Object.keys(miss) as ItemId[];
      let label = this.craftLabel(r);
      let can = true;
      if (missKeys.length) {
        const first = missKeys[0];
        const n = miss[first]!;
        label = `Need ${n} more ${ITEMS[first].name.toLowerCase()}`;
        can = false;
      } else if (r.needsFire && !fire) {
        label = 'Stand by a lit fire';
        can = false;
      }
      const b = h<'button'>('button.btn.primary.wide', { 'data-k': 'act', text: label });
      if (!can) b.classList.add('disabled');
      b.addEventListener('click', () => {
        if (!can) {
          this.ui.sfx('ui_error');
          b.classList.remove('shake');
          void b.offsetWidth;
          b.classList.add('shake');
          return;
        }
        this.craft(r);
      });
      actions.append(b);
    }
    d.append(actions);
    this.side.append(d);
  }

  private craft(r: Recipe) {
    const c = this.ui.ctx.sys.crafting;
    const ok = c?.craft?.(r.id) ?? false;
    this.ui.sfx(ok ? 'ui_click' : 'ui_error');
    this.render();
  }

  update() {
    if (this.computeKey() !== this.stateKey) this.render();
    const prog = this.ui.ctx.sys.crafting?.progress ?? -1;
    if (this.progressFill && prog >= 0) css(this.progressFill, 'transform', `scaleX(${prog.toFixed(3)})`);
  }
}
