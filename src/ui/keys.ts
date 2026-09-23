// Key caps and gamepad glyphs for prompts, hints and the controls list.
import { keyLabel, type Action, type Input } from '../core/Input';

const MOUSE: Record<string, string> = {
  // Mouse outline with the relevant button filled in.
  Mouse0: '<path d="M12 3.5v6.5H6.5V9A5.5 5.5 0 0 1 12 3.5z" fill="currentColor" stroke="none"/>',
  Mouse2: '<path d="M12 3.5v6.5h5.5V9A5.5 5.5 0 0 0 12 3.5z" fill="currentColor" stroke="none"/>',
  Mouse1: '<path d="M12 6.5v3" stroke-width="2.4"/>',
  WheelUp: '<path d="M12 6v4M10.5 7.5 12 6l1.5 1.5"/>',
  WheelDown: '<path d="M12 6v4M10.5 8.5 12 10l1.5-1.5"/>',
};

function mouseSvg(code: string) {
  return `<svg class="mouse" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="width:1.5rem;height:1.5rem;display:block"><rect x="6.5" y="3.5" width="11" height="17" rx="5.5"/><path d="M6.5 10h11M12 3.5V10"/>${MOUSE[code] ?? ''}</svg>`;
}

/** HTML for one binding code as a cap/glyph. */
export function capFor(code: string): string {
  if (code in MOUSE) return mouseSvg(code);
  const label = keyLabel(code);
  if (code.startsWith('Pad')) {
    const face = ['A', 'B', 'X', 'Y'].includes(label);
    return `<span class="key pad${face ? ' face' : ''}">${escape(label)}</span>`;
  }
  return `<span class="key">${escape(label)}</span>`;
}

/** Cap for an action, respecting whether the player is on a gamepad right now. */
export function cap(input: Input, action: Action): string {
  const codes = input.bindings[action] ?? [];
  const pick = input.usingGamepad ? codes.find((c) => c.startsWith('Pad')) : codes.find((c) => !c.startsWith('Pad'));
  return capFor(pick ?? codes[0] ?? '');
}

/** Cap for a raw pad button index (menus: A confirm, B back, LB/RB tabs). */
export function padCap(label: 'A' | 'B' | 'X' | 'Y' | 'LB' | 'RB' | 'LT' | 'RT' | 'Menu'): string {
  const face = ['A', 'B', 'X', 'Y'].includes(label);
  return `<span class="key pad${face ? ' face' : ''}">${label}</span>`;
}

export function kbCap(label: string): string {
  return `<span class="key">${escape(label)}</span>`;
}

function escape(s: string) {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

export const ACTION_NAMES: Partial<Record<Action, string>> = {
  forward: 'Move forward',
  back: 'Move back',
  left: 'Strafe left',
  right: 'Strafe right',
  jump: 'Jump',
  sprint: 'Sprint / tuck',
  crouch: 'Crouch',
  interact: 'Interact',
  attack: 'Use / attack',
  aim: 'Aim / block',
  toggleSkis: 'Skis on / off',
  freelook: 'Look around',
  inventory: 'Inventory',
  crafting: 'Crafting',
  build: 'Build',
  map: 'Map',
  pause: 'Pause',
  nextSlot: 'Next item',
  prevSlot: 'Previous item',
  holster: 'Empty hands',
  rotate: 'Rotate piece',
  demolish: 'Demolish',
};
