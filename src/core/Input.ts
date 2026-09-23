// Keyboard + mouse + gamepad input mapped to named actions.
// Query with input.down('jump'), input.pressed('attack') (true only on the frame it went down),
// input.released(...), input.move() for the movement vector and input.look() for look deltas.

export type Action =
  | 'forward' | 'back' | 'left' | 'right'
  | 'jump' | 'sprint' | 'crouch'
  | 'interact' | 'attack' | 'aim'
  | 'toggleSkis' | 'freelook'
  | 'inventory' | 'crafting' | 'build' | 'map' | 'pause'
  | 'slot1' | 'slot2' | 'slot3' | 'slot4' | 'slot5' | 'slot6'
  | 'nextSlot' | 'prevSlot' | 'holster'
  | 'rotate' | 'demolish';

export const DEFAULT_BINDINGS: Record<Action, string[]> = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space', 'Pad0'],
  sprint: ['ShiftLeft', 'ShiftRight', 'Pad10'],
  crouch: ['ControlLeft', 'KeyC', 'Pad1'],
  interact: ['KeyE', 'Pad2'],
  attack: ['Mouse0', 'Pad7'],
  aim: ['Mouse2', 'Pad6'],
  toggleSkis: ['KeyX', 'Pad3'],
  freelook: ['AltLeft', 'Pad11'],
  inventory: ['Tab', 'KeyI', 'Pad8'],
  crafting: ['KeyQ'],
  build: ['KeyB', 'Pad12'],
  map: ['KeyM', 'Pad13'],
  pause: ['Escape', 'KeyP', 'Pad9'],
  slot1: ['Digit1'],
  slot2: ['Digit2'],
  slot3: ['Digit3'],
  slot4: ['Digit4'],
  slot5: ['Digit5'],
  slot6: ['Digit6'],
  nextSlot: ['WheelDown', 'Pad5'],
  prevSlot: ['WheelUp', 'Pad4'],
  holster: ['KeyH', 'Pad14'],
  rotate: ['KeyR', 'Pad15'],
  demolish: ['KeyZ'],
};

/** Human-readable label for a binding code (for key caps in the UI). */
export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const map: Record<string, string> = {
    Mouse0: 'LMB', Mouse1: 'MMB', Mouse2: 'RMB', WheelUp: 'Wheel', WheelDown: 'Wheel',
    Space: 'Space', ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Ctrl', AltLeft: 'Alt',
    Escape: 'Esc', Tab: 'Tab', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Pad0: 'A', Pad1: 'B', Pad2: 'X', Pad3: 'Y', Pad4: 'LB', Pad5: 'RB', Pad6: 'LT', Pad7: 'RT',
    Pad8: 'View', Pad9: 'Menu', Pad10: 'LS', Pad11: 'RS', Pad12: 'D↑', Pad13: 'D↓', Pad14: 'D←', Pad15: 'D→',
  };
  return map[code] ?? code;
}

export class Input {
  bindings: Record<Action, string[]> = structuredClone(DEFAULT_BINDINGS);
  private held = new Set<string>();
  private downThisFrame = new Set<string>();
  private upThisFrame = new Set<string>();
  private mouseDX = 0;
  private mouseDY = 0;
  private wheelQueue: string[] = [];
  pointerLocked = false;
  /** True when the last input came from a gamepad (UI shows pad glyphs). */
  usingGamepad = false;
  private padButtons: boolean[] = [];
  private padAxes: number[] = [0, 0, 0, 0];
  private padTriggers = [0, 0];
  /** Set false to stop requesting pointer lock (menus). */
  enabled = true;

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow') || e.code === 'AltLeft') e.preventDefault();
      if (e.repeat) return;
      this.usingGamepad = false;
      this.press(e.code);
    });
    window.addEventListener('keyup', (e) => this.release(e.code));
    window.addEventListener('mousedown', (e) => {
      this.usingGamepad = false;
      this.press('Mouse' + e.button);
    });
    window.addEventListener('mouseup', (e) => this.release('Mouse' + e.button));
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked) return;
      // Guard against the occasional huge spike some browsers emit on lock.
      if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    window.addEventListener(
      'wheel',
      (e) => {
        this.wheelQueue.push(e.deltaY > 0 ? 'WheelDown' : 'WheelUp');
      },
      { passive: true },
    );
    window.addEventListener('blur', () => {
      this.held.clear();
    });
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
    });
  }

  private press(code: string) {
    if (!this.held.has(code)) this.downThisFrame.add(code);
    this.held.add(code);
  }
  private release(code: string) {
    if (this.held.has(code)) this.upThisFrame.add(code);
    this.held.delete(code);
  }

  requestPointerLock() {
    if (this.pointerLocked) return;
    try {
      const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* needs a user gesture */
    }
  }
  exitPointerLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /** Call once at the start of every frame. */
  update() {
    for (const w of this.wheelQueue) {
      this.downThisFrame.add(w);
      this.upThisFrame.add(w);
    }
    this.wheelQueue.length = 0;
    this.pollGamepad();
  }

  /** Call once at the end of every frame. */
  endFrame() {
    this.downThisFrame.clear();
    this.upThisFrame.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
  }

  private pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = pads && Array.from(pads).find((p) => p && p.connected);
    if (!pad) return;
    for (let i = 0; i < Math.min(16, pad.buttons.length); i++) {
      const b = pad.buttons[i];
      const on = i === 6 || i === 7 ? b.value > 0.35 : b.pressed;
      const was = this.padButtons[i] ?? false;
      if (on && !was) {
        this.press('Pad' + i);
        this.usingGamepad = true;
      } else if (!on && was) this.release('Pad' + i);
      this.padButtons[i] = on;
    }
    this.padTriggers[0] = pad.buttons[6]?.value ?? 0;
    this.padTriggers[1] = pad.buttons[7]?.value ?? 0;
    for (let a = 0; a < 4; a++) {
      const v = pad.axes[a] ?? 0;
      this.padAxes[a] = Math.abs(v) < 0.14 ? 0 : (v - Math.sign(v) * 0.14) / 0.86;
      if (this.padAxes[a] !== 0) this.usingGamepad = true;
    }
  }

  down(a: Action): boolean {
    for (const c of this.bindings[a]) if (this.held.has(c)) return true;
    return false;
  }
  pressed(a: Action): boolean {
    for (const c of this.bindings[a]) if (this.downThisFrame.has(c)) return true;
    return false;
  }
  released(a: Action): boolean {
    for (const c of this.bindings[a]) if (this.upThisFrame.has(c)) return true;
    return false;
  }

  /** Movement vector: x = strafe right, y = forward. Length <= 1. */
  move(): { x: number; y: number } {
    let x = (this.down('right') ? 1 : 0) - (this.down('left') ? 1 : 0);
    let y = (this.down('forward') ? 1 : 0) - (this.down('back') ? 1 : 0);
    x += this.padAxes[0];
    y -= this.padAxes[1];
    const l = Math.hypot(x, y);
    if (l > 1) {
      x /= l;
      y /= l;
    }
    return { x, y };
  }

  /** Look delta in "mouse pixels" this frame (gamepad right stick scaled to match). */
  look(dt: number): { x: number; y: number } {
    const padScale = 900 * dt;
    const rx = this.padAxes[2],
      ry = this.padAxes[3];
    // Slight response curve on the stick for precision.
    return {
      x: this.mouseDX + Math.sign(rx) * rx * rx * padScale,
      y: this.mouseDY + Math.sign(ry) * ry * ry * padScale,
    };
  }

  /** Analog trigger values (0..1) for aim/attack. */
  trigger(which: 'aim' | 'attack'): number {
    const pad = which === 'aim' ? this.padTriggers[0] : this.padTriggers[1];
    return Math.max(pad, this.down(which) ? 1 : 0);
  }

  /** First key-cap label for an action (respects gamepad mode). */
  label(a: Action): string {
    const codes = this.bindings[a];
    const pick = this.usingGamepad ? codes.find((c) => c.startsWith('Pad')) : codes.find((c) => !c.startsWith('Pad'));
    return keyLabel(pick ?? codes[0]);
  }
}
