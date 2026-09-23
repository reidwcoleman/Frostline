// Tiny DOM helpers for the UI. No framework: every screen builds its DOM once and
// patches text/classes on change, so per-frame HUD updates never allocate or thrash layout.

export type Attrs = Record<string, string | number | boolean | undefined | null>;
type Child = Node | string | null | undefined | false;

/** h('div.foo.bar', {title: 'x'}, child, 'text') */
export function h<K extends keyof HTMLElementTagNameMap = 'div'>(sel: string, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const [tag, ...classes] = sel.split('.');
  const el = document.createElement(tag || 'div') as HTMLElementTagNameMap[K];
  if (classes.length) el.className = classes.join(' ');
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === 'text') el.textContent = String(v);
      else if (k === 'html') el.innerHTML = String(v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** Parse an SVG/HTML string into a single element. */
export function frag(html: string): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

/** Only touch the DOM when the text actually changed. */
export function setText(el: HTMLElement, text: string) {
  if (el.textContent !== text) el.textContent = text;
}

export function toggle(el: Element, cls: string, on: boolean) {
  if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}

export function clear(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Cached style writes: skips identical values (transform/opacity are hot in the HUD). */
const styleCache = new WeakMap<HTMLElement, Record<string, string>>();
export function css(el: HTMLElement, prop: string, value: string) {
  let c = styleCache.get(el);
  if (!c) styleCache.set(el, (c = {}));
  if (c[prop] === value) return;
  c[prop] = value;
  el.style.setProperty(prop, value);
}

export const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** Staggered spring-in of a screen's top-level blocks (50 ms steps). */
export function stagger(blocks: Element[], baseDelay = 0) {
  blocks.forEach((b, i) => {
    const el = b as HTMLElement;
    el.classList.remove('appear');
    el.style.animationDelay = `${baseDelay + i * 50}ms`;
    void el.offsetWidth; // restart the animation
    el.classList.add('appear');
  });
}

// ---------------------------------------------------------------- formatting
export function fmtInt(n: number) {
  return Math.round(n).toLocaleString('en-US');
}

/** "−12°" with a real minus sign. */
export function fmtTemp(c: number, units: 'metric' | 'imperial') {
  const v = units === 'imperial' ? c * 1.8 + 32 : c;
  const r = Math.round(v);
  return `${r < 0 ? '−' : ''}${Math.abs(r)}°${units === 'imperial' ? 'F' : 'C'}`;
}

export function fmtSpeed(ms: number, units: 'metric' | 'imperial') {
  return units === 'imperial' ? { v: Math.round(ms * 2.23694), u: 'mph' } : { v: Math.round(ms * 3.6), u: 'km/h' };
}

export function fmtAlt(m: number, units: 'metric' | 'imperial') {
  return units === 'imperial' ? `${fmtInt(m * 3.28084)} ft` : `${fmtInt(m)} m`;
}

export function fmtDist(m: number, units: 'metric' | 'imperial') {
  if (units === 'imperial') {
    const mi = m / 1609.34;
    return mi >= 0.1 ? { v: mi.toFixed(1), u: 'mi' } : { v: fmtInt(m * 3.28084), u: 'ft' };
  }
  return m >= 1000 ? { v: (m / 1000).toFixed(1), u: 'km' } : { v: fmtInt(m), u: 'm' };
}

export function fmtClock(hour: number) {
  const h = Math.floor(hour);
  const m = Math.floor((hour - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Count a number up with an ease-out over `ms` (death-screen stats). */
export function countUp(el: HTMLElement, to: number, ms: number, format: (v: number) => string, delay = 0) {
  if (reducedMotion()) {
    el.textContent = format(to);
    return;
  }
  el.textContent = format(0);
  const start = performance.now() + delay;
  const tick = (t: number) => {
    const k = Math.min(1, Math.max(0, (t - start) / ms));
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = format(to * e);
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
