// Spatial focus navigation for menus: D-pad / left stick / arrow keys move a visible
// focus ring between controls, A / Enter activates, B / Esc goes back, LB / RB switch tabs.
// Mouse users never see the ring (it hides on pointer movement).

export type NavDir = 'up' | 'down' | 'left' | 'right';

const SELECTOR = 'button:not([disabled]):not([data-nonav]), [data-nav], input[type="range"]';

export interface NavHandlers {
  back(): void;
  tab?(dir: 1 | -1): void;
  /** Analog extras for the map (pan with the stick, zoom with triggers). */
  analog?(lx: number, ly: number, lt: number, rt: number, dt: number): boolean;
}

export class Nav {
  scope: HTMLElement | null = null;
  current: HTMLElement | null = null;
  handlers: NavHandlers | null = null;
  private ringVisible = false;
  private padPrev: boolean[] = [];
  private repeatDir: NavDir | null = null;
  private repeatAt = 0;
  private t = 0;
  /** Called on every focus move (hover tick). */
  onMove: (() => void) | null = null;

  constructor() {
    window.addEventListener('mousemove', () => this.hideRing(), { passive: true });
    window.addEventListener('mousedown', () => this.hideRing(), { passive: true });
  }

  setScope(scope: HTMLElement | null, handlers: NavHandlers | null, initial?: HTMLElement | null) {
    this.scope = scope;
    this.handlers = handlers;
    this.setCurrent(initial ?? null, false);
  }

  /** Focus a specific element (e.g. after re-render). */
  focus(el: HTMLElement | null, showRing = this.ringVisible) {
    this.setCurrent(el, showRing);
  }

  private hideRing() {
    if (!this.ringVisible) return;
    this.ringVisible = false;
    this.current?.classList.remove('nav-focus');
  }

  private setCurrent(el: HTMLElement | null, showRing: boolean) {
    if (this.current && this.current !== el) this.current.classList.remove('nav-focus');
    this.current = el;
    this.ringVisible = showRing;
    if (el) {
      el.classList.toggle('nav-focus', showRing);
      if (showRing) {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        el.dispatchEvent(new CustomEvent('navfocus', { bubbles: true }));
      }
    }
  }

  /** After a re-render the focused node may be gone: find its replacement by data-k. */
  repair() {
    const cur = this.current;
    if (!cur || cur.isConnected || !this.scope) return;
    const k = cur.dataset.k;
    const next = k ? (this.scope.querySelector(`[data-k="${CSS.escape(k)}"]`) as HTMLElement | null) : null;
    this.setCurrent(next, this.ringVisible && !!next);
  }

  focusables(): HTMLElement[] {
    if (!this.scope) return [];
    return (Array.from(this.scope.querySelectorAll(SELECTOR)) as HTMLElement[]).filter((e) => {
      if (e.closest('[data-nonav]')) return false;
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  }

  move(dir: NavDir) {
    this.repair();
    const list = this.focusables();
    if (!list.length) return;
    let cur = this.current && list.includes(this.current) ? this.current : null;
    if (!cur) {
      this.setCurrent(list[0], true);
      this.onMove?.();
      return;
    }
    if (!this.ringVisible) {
      // First press only reveals where focus is.
      this.setCurrent(cur, true);
      return;
    }
    // Sliders consume left/right.
    if ((dir === 'left' || dir === 'right') && cur instanceof HTMLInputElement && cur.type === 'range') {
      const step = Number(cur.step) || 1;
      const v = Number(cur.value) + (dir === 'right' ? step : -step);
      cur.value = String(Math.min(Number(cur.max), Math.max(Number(cur.min), v)));
      cur.dispatchEvent(new Event('input', { bubbles: true }));
      cur.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    const a = cur.getBoundingClientRect();
    const ax = a.left + a.width / 2,
      ay = a.top + a.height / 2;
    const [ux, uy] = dir === 'up' ? [0, -1] : dir === 'down' ? [0, 1] : dir === 'left' ? [-1, 0] : [1, 0];
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    for (const e of list) {
      if (e === cur) continue;
      const r = e.getBoundingClientRect();
      // Nearest edge-to-centre distance along the axis handles wide rows vs small chips.
      const bx = Math.max(r.left, Math.min(ax, r.right)),
        by = Math.max(r.top, Math.min(ay, r.bottom));
      const cx = r.left + r.width / 2,
        cy = r.top + r.height / 2;
      const dx = (ux !== 0 ? cx : bx) - ax,
        dy = (uy !== 0 ? cy : by) - ay;
      const along = dx * ux + dy * uy;
      if (along <= 4) continue;
      const across = Math.abs(dx * uy - dy * ux);
      const score = along + across * 2.2;
      if (score < bestScore) {
        bestScore = score;
        best = e;
      }
    }
    if (best) {
      this.setCurrent(best, true);
      this.onMove?.();
    }
  }

  activate() {
    this.repair();
    if (!this.current || !this.ringVisible) {
      if (!this.ringVisible && this.current) this.setCurrent(this.current, true);
      else this.move('down');
      return;
    }
    const el = this.current;
    if (el instanceof HTMLInputElement && el.type === 'range') return;
    el.click();
  }

  /** Keyboard navigation. Returns true when the key was consumed. */
  key(e: KeyboardEvent): boolean {
    if (!this.scope) return false;
    switch (e.code) {
      case 'ArrowUp':
        this.move('up');
        return true;
      case 'ArrowDown':
        this.move('down');
        return true;
      case 'ArrowLeft':
        this.move('left');
        return true;
      case 'ArrowRight':
        this.move('right');
        return true;
      case 'Enter':
      case 'NumpadEnter':
        this.activate();
        return true;
      case 'Escape':
      case 'Backspace':
        this.handlers?.back();
        return true;
    }
    return false;
  }

  /** Poll the first connected gamepad. Call every frame while a menu is open. */
  pollPad(dt: number) {
    this.t += dt;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad: Gamepad | null = null;
    for (const p of pads) if (p && p.connected) { pad = p; break; }
    if (!pad || !this.scope) return;
    const b = (i: number) => !!pad!.buttons[i]?.pressed;
    const edge = (i: number) => {
      const on = b(i);
      const was = this.padPrev[i] ?? false;
      this.padPrev[i] = on;
      return on && !was;
    };
    const lx = pad.axes[0] ?? 0,
      ly = pad.axes[1] ?? 0;
    let dir: NavDir | null = null;
    if (b(12) || ly < -0.6) dir = 'up';
    else if (b(13) || ly > 0.6) dir = 'down';
    else if (b(14) || lx < -0.6) dir = 'left';
    else if (b(15) || lx > 0.6) dir = 'right';
    // Keep the edge state of the d-pad current even while the stick drives.
    for (const i of [12, 13, 14, 15]) this.padPrev[i] = b(i);

    let stickUsed = false;
    if (this.handlers?.analog) {
      const lt = pad.buttons[6]?.value ?? 0,
        rt = pad.buttons[7]?.value ?? 0;
      const dz = (v: number) => (Math.abs(v) < 0.15 ? 0 : v);
      stickUsed = this.handlers.analog(dz(lx), dz(ly), lt, rt, dt);
    }
    const dpad = b(12) || b(13) || b(14) || b(15);

    if (dir && (dpad || !stickUsed)) {
      if (dir !== this.repeatDir) {
        this.repeatDir = dir;
        this.repeatAt = this.t + 0.38;
        this.move(dir);
      } else if (this.t >= this.repeatAt) {
        this.repeatAt = this.t + 0.11;
        this.move(dir);
      }
    } else this.repeatDir = null;

    if (edge(0)) this.activate();
    if (edge(1)) this.handlers?.back();
    if (edge(4)) this.handlers?.tab?.(-1);
    if (edge(5)) this.handlers?.tab?.(1);
    if (edge(9)) this.handlers?.back();
  }

  /** Sync pad edge state without acting (so the button that opened a menu doesn't also press inside it). */
  primePad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads)
      if (p && p.connected) {
        for (let i = 0; i < p.buttons.length; i++) this.padPrev[i] = p.buttons[i].pressed;
        break;
      }
  }
}
