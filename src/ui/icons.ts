// One consistent icon set: 24-unit grid, round caps/joins, stroke only (currentColor),
// stroke width set in CSS (--sw) so the same glyph reads at hotbar size and card size.
import type { ItemId } from '../core/Items';
import type { BuildPieceId } from '../core/data';

const P: Record<string, string> = {
  // ---- items
  log: '<ellipse cx="7" cy="12" rx="3.5" ry="5.5"/><ellipse cx="7" cy="12" rx="1.1" ry="1.9"/><path d="M7 6.5h10.5a3.5 5.5 0 0 1 0 11H7"/><path d="M12 9.5h4"/><path d="M13 14.5h3.5"/>',
  stick: '<path d="M4.5 19.5 19.5 4.5"/><path d="M9 15 8.2 10.5"/><path d="M13.5 10.5l4 .9"/>',
  stone: '<path d="M4 15.5C4 11 7.5 7 12 7c4.5 0 8 3 8 7 0 3-2.3 4.5-5.5 4.5h-7C5.5 18.5 4 17.5 4 15.5z"/><path d="M8.5 11.8c1-1.1 2.6-1.7 4.2-1.5"/>',
  hide: '<path d="M8 4.5c1.2 1 2.5 1.5 4 1.5s2.8-.5 4-1.5l1.2 3.6-1.7 2 1 5.4 2 3.1-3 .4c-1-.8-2.3-1.2-3.5-1.2s-2.5.4-3.5 1.2l-3-.4 2-3.1 1-5.4-1.7-2z"/>',
  raw_meat: '<path d="M5 13.5C5 9 8.5 5.5 13 5.5c3.5 0 6 2.3 6 5.5 0 4.5-4 7.5-8.5 7.5C7.2 18.5 5 16.5 5 13.5z"/><circle cx="14.2" cy="10.6" r="1.8"/><path d="M8.3 14.2c1.6.8 3.6.7 5.2-.4"/>',
  cooked_meat: '<path d="M9.2 14.8C6.6 12.3 7 7.8 9.9 5.4c3-2.5 7.6-2.3 9.9.4 2.3 2.8 1.6 7.2-1.5 9.4-2.6 1.9-6 2.1-8.2.6z"/><path d="M9.6 14.4 6.4 17.6"/><circle cx="4.9" cy="17.3" r="1.45"/><circle cx="6.7" cy="19.1" r="1.45"/><path d="M12.3 7.3c1.1-.8 2.5-1 3.8-.6"/>',
  cloth: '<path d="M4 8.5 12 5l8 3.5-8 3.5z"/><path d="M4 12.5l8 3.5 8-3.5"/><path d="M4 16.5l8 3.5 8-3.5"/>',
  bandage: '<rect x="2.5" y="8.5" width="19" height="7" rx="3.5" transform="rotate(-45 12 12)"/><rect x="9.5" y="9.5" width="5" height="5" rx="1" transform="rotate(-45 12 12)"/>',
  hatchet: '<path d="M14.6 9.4 4.5 19.5"/><path d="M17 9.1 12.7 2.1Q9.6 3.6 8.1 6.7L15.1 11z"/>',
  spear: '<path d="M4 20 14.8 9.2"/><path d="M14 10c.6-2.6 2.6-4.9 6-6-.9 3.3-3.4 5.3-6 6z"/><path d="M12.4 9.6l2 2"/>',
  bow: '<path d="M7 3.5C15 6 17.5 9.5 17.5 12S15 18 7 20.5"/><path d="M7 3.5v17"/><path d="M16.2 10.5v3"/>',
  arrow: '<path d="M5.5 18.5 18.5 5.5"/><path d="M18.5 5.5H14M18.5 5.5V10"/><path d="M6.5 17.5H3.5M6.5 17.5v3"/><path d="M8.8 15.2H6M8.8 15.2V18"/>',
  torch: '<path d="M12 21v-8.5"/><path d="M9.5 12.5h5l-.6-2.4h-3.8z"/><path d="M12 3c1.8 1.9 3 3.4 3 4.9a3 3 0 0 1-6 0c0-1 .5-2 1.2-2.6.3 1 .8 1.5 1.3 1.7-.2-1.4-.1-2.8.5-4z"/>',
  // ---- vitals
  health: '<path d="M12 19.5s-7.5-4.4-7.5-9.8A4.2 4.2 0 0 1 12 7.1a4.2 4.2 0 0 1 7.5 2.6c0 5.4-7.5 9.8-7.5 9.8z"/>',
  warmth: '<path d="M10 13.6V5.5a2 2 0 0 1 4 0v8.1a4 4 0 1 1-4 0z"/><path d="M12 9v7.2"/>',
  food: '<path d="M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10"/><path d="M17 21V3c-2 1.5-3 4-3 8h3"/>',
  stamina: '<path d="M13 3 5.5 13.5H12L11 21l7.5-10.5H12z"/>',
  // ---- build pieces
  campfire: '<path d="M4 20.5l16-4M20 20.5l-16-4"/><path d="M12 3c2 2.2 3.4 4 3.4 6.1a3.4 3.4 0 0 1-6.8 0c0-1.3.6-2.4 1.5-3.1.3 1.1.9 1.7 1.6 1.9C11.3 6.4 11.4 4.6 12 3z"/>',
  bedroll: '<rect x="3" y="12" width="18" height="6.5" rx="3.25"/><path d="M8.5 12v6.5"/><path d="M8.5 12c0-1.7 1.2-2.8 3-2.8h6.3A3.2 3.2 0 0 1 21 12.4"/>',
  lean_to: '<path d="M3 20h18"/><path d="M4 20 16.5 5.5"/><path d="M16.5 5.5V20"/><path d="M8 15.4l8.5 1.1M11.5 11.3l5 .6"/>',
  foundation: '<path d="M3 12.5 12 8l9 4.5-9 4.5z"/><path d="M3 12.5V15l9 4.5 9-4.5v-2.5"/><path d="M12 17v2.5"/>',
  wall: '<rect x="3.5" y="5.5" width="17" height="13" rx="1.5"/><path d="M3.5 9.8h17M3.5 14.2h17"/>',
  doorway: '<path d="M9 18.5H3.5v-13h17v13H15"/><path d="M9 18.5v-8h6v8"/><path d="M3.5 9.5H9m6 0h5.5M3.5 14H9m6 0h5.5"/>',
  window_wall: '<rect x="3.5" y="5.5" width="17" height="13" rx="1.5"/><rect x="9.5" y="8.5" width="5" height="5" rx=".8"/><path d="M3.5 16h17M3.5 11h6M14.5 11h6"/>',
  door: '<rect x="6.5" y="3.5" width="11" height="17" rx="1.5"/><path d="M12 3.5v17"/><path d="M14.4 12.5h.2"/>',
  roof: '<path d="M2.5 15.5 12 7l9.5 8.5"/><path d="M5.5 16 12 10.2l6.5 5.8"/><path d="M2.5 15.5h3M18.5 16h3"/>',
  // ---- ui
  backpack: '<path d="M6 10a6 6 0 0 1 12 0v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19z"/><path d="M10 4.4V3h4v1.4"/><path d="M9 14.5h6v3.5H9z"/>',
  hammer: '<path d="M12.3 9.9 4.6 17.6"/><path d="M9.3 6.9 11.9 4.3l6 6.1-2.5 2.5z"/>',
  house: '<path d="M4 11 12 4l8 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/>',
  map: '<path d="M3.5 6.5 9 4l6 2.5L20.5 4v13.5L15 20l-6-2.5-5.5 2.5z"/><path d="M9 4v13.5M15 6.5V20"/>',
  flag: '<path d="M6 21V4"/><path d="M6 4.5h11l-2.5 4 2.5 4H6"/>',
  pin: '<path d="M12 21s6-5.6 6-10.5a6 6 0 0 0-12 0C6 15.4 12 21 12 21z"/><circle cx="12" cy="10.5" r="2"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  crosshair: '<circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
  snow: '<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/><path d="M9.5 4.5 12 6l2.5-1.5M9.5 19.5 12 18l2.5 1.5"/>',
};

export type IconName = keyof typeof P | ItemId | BuildPieceId;

export function icon(name: string, cls = 'ico'): string {
  const body = P[name] ?? P.stone;
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export function itemIcon(id: ItemId, cls = 'ico'): string {
  return icon(id, cls);
}
