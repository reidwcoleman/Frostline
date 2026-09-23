// Build: the nine pieces as glyph cards with costs. Choosing an affordable piece starts
// placement (ctx.sys.building.begin) and closes the journal.
import { h, clear } from '../dom';
import { icon, itemIcon } from '../icons';
import { ITEMS, type ItemId } from '../../core/Items';
import { BUILD_PIECES, type BuildPieceDef } from '../../core/data';
import type { UI } from '../UI';
import type { JournalTab } from './Journal';

export class BuildTab implements JournalTab {
  readonly id = 'build' as const;
  readonly root = h('div', { style: 'display:contents' });
  private main = h('div.pane.main.glass');
  private grid = h('div.bgrid');
  private side = h('div.pane.side.glass');
  private sel: string | null = null;
  private cards = new Map<string, HTMLButtonElement>();
  private sig = '';

  constructor(private ui: UI) {
    this.main.append(h('div.scroll', null, this.grid));
    this.root.append(this.main, this.side);
  }

  private get pieces(): BuildPieceDef[] {
    return this.ui.ctx.sys.building?.pieces ?? BUILD_PIECES;
  }

  private short(p: BuildPieceDef): [ItemId, number][] {
    const inv = this.ui.ctx.inventory;
    const out: [ItemId, number][] = [];
    for (const k in p.cost) {
      const id = k as ItemId;
      const d = p.cost[id]! - inv.count(id);
      if (d > 0) out.push([id, d]);
    }
    return out;
  }

  show() {
    this.render();
  }
  hide() {}
  hints() {
    return '';
  }

  initialFocus(): HTMLElement | null {
    return (this.sel && this.cards.get(this.sel)) || (this.grid.firstElementChild as HTMLElement | null);
  }

  private invKey() {
    const inv = this.ui.ctx.inventory;
    return (['log', 'stick', 'stone', 'hide'] as ItemId[]).map((i) => inv.count(i)).join(',');
  }

  private render() {
    this.sig = this.invKey();
    clear(this.grid);
    this.cards.clear();
    const inv = this.ui.ctx.inventory;
    if (!this.sel) this.sel = this.pieces[0]?.id ?? null;
    for (const p of this.pieces) {
      const ok = this.short(p).length === 0;
      const chips = h('div.chips');
      for (const k in p.cost) {
        const id = k as ItemId;
        const need = p.cost[id]!;
        const have = inv.count(id);
        chips.append(h('span.chip' + (have < need ? '.short' : ''), { title: ITEMS[id].name, html: itemIcon(id) + `<span><span class="n">${Math.min(have, 99)}</span><span class="d">/${need}</span></span>` }));
      }
      const card = h<'button'>('button.bcard' + (ok ? '' : '.na'), { 'data-k': 'b:' + p.id, html: icon(p.id) }, h('div.name', { text: p.name }), chips);
      card.classList.toggle('sel', p.id === this.sel);
      card.addEventListener('mouseenter', () => this.select(p.id, false));
      card.addEventListener('navfocus', () => this.select(p.id, false));
      card.addEventListener('click', () => this.choose(p, card));
      this.grid.append(card);
      this.cards.set(p.id, card);
    }
    this.ui.hoverSounds(this.grid);
    this.renderDetail();
  }

  private select(id: string, sound: boolean) {
    if (this.sel === id) return;
    this.sel = id;
    if (sound) this.ui.sfx('ui_hover');
    for (const [k, el] of this.cards) el.classList.toggle('sel', k === id);
    this.renderDetail();
  }

  private choose(p: BuildPieceDef, el: HTMLElement) {
    if (this.short(p).length) {
      this.ui.sfx('ui_error');
      el.classList.remove('shake');
      void el.offsetWidth;
      el.classList.add('shake');
      this.select(p.id, false);
      return;
    }
    this.ui.sfx('ui_click');
    this.ui.closeJournal();
    this.ui.ctx.sys.building?.begin?.(p.id);
  }

  private renderDetail() {
    clear(this.side);
    const p = this.pieces.find((x) => x.id === this.sel);
    if (!p) return;
    const inv = this.ui.ctx.inventory;
    const d = h('div.detail');
    d.append(h('div.well', { html: icon(p.id) }), h('div.title', { text: p.name }), h('div.desc', { text: p.description }));
    const facts = h('div.facts');
    for (const k in p.cost) {
      const id = k as ItemId;
      const need = p.cost[id]!;
      const have = inv.count(id);
      facts.append(h('div.fact', null, h('span.k', { html: itemIcon(id) + `<span>${ITEMS[id].name}</span>` }), h('span.v' + (have < need ? '.short' : ''), { text: `${have} / ${need}` })));
    }
    if (p.shelter > 0.1) facts.append(h('div.fact', null, h('span.k', { html: '<span>Shelter from wind</span>' }), h('span.v', { text: `${Math.round(p.shelter * 100)}%` })));
    facts.append(h('div.fact', null, h('span.k', { html: '<span>Placement</span>' }), h('span.v', { text: p.placement === 'grid' ? 'Snaps to the grid' : 'Anywhere on the ground' })));
    d.append(facts);
    const short = this.short(p);
    const b = h<'button'>('button.btn.primary.wide', { 'data-k': 'act', text: short.length ? `Need ${short[0][1]} more ${ITEMS[short[0][0]].name.toLowerCase()}` : `Place ${p.name.toLowerCase()}` });
    if (short.length) b.classList.add('disabled');
    b.addEventListener('click', () => this.choose(p, b));
    d.append(h('div.actions', null, b));
    this.side.append(d);
  }

  update() {
    if (this.invKey() !== this.sig) this.render();
  }
}
