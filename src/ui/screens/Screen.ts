// Base for full-screen UI layers (menu, journal, pause, settings, death).
import type { UI } from '../UI';
import type { NavHandlers } from '../Nav';

export abstract class Screen implements NavHandlers {
  readonly root: HTMLDivElement;
  isOpen = false;

  constructor(protected ui: UI, cls: string) {
    this.root = document.createElement('div');
    this.root.className = `screen ${cls}`;
  }

  /** Called when the screen becomes the top layer. */
  show() {
    this.isOpen = true;
    this.root.classList.add('open');
    this.onShow();
  }

  hide() {
    this.isOpen = false;
    this.root.classList.remove('open');
    this.onHide();
  }

  protected onShow() {}
  protected onHide() {}

  /** Element that should receive gamepad focus first. */
  initialFocus(): HTMLElement | null {
    return this.root.querySelector('.primary:not([disabled])') ?? this.root.querySelector('button:not([disabled])');
  }

  abstract back(): void;
  tab?(dir: 1 | -1): void;
  analog?(lx: number, ly: number, lt: number, rt: number, dt: number): boolean;
  update?(dt: number): void;
  /** Keyboard hook before generic navigation; return true if consumed. */
  key?(e: KeyboardEvent): boolean;
}
