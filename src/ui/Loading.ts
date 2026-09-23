// Boot loading screen: logo, drifting contour motif, a thin signal-orange progress line.
import { h, setText } from './dom';
import { drawContours, noiseField } from './contours';

export class Loading {
  readonly root: HTMLDivElement;
  private fill = h('i');
  private label = h('div.label');
  private canvas = h<'canvas'>('canvas');
  private done = false;
  private shown = 0;

  constructor() {
    this.root = h('div.loading');
    const center = h('div.center', null, h('div.logo.serif', { text: 'Frostline' }), h('div.bar', null, this.fill), this.label);
    this.root.append(this.canvas, h('div.vignette'), center);
    this.draw();
  }

  private draw() {
    const w = Math.max(640, window.innerWidth),
      hgt = Math.max(400, window.innerHeight);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(hgt * dpr);
    const g = this.canvas.getContext('2d');
    if (!g) return;
    const gw = 260,
      gh = Math.round((gw * hgt) / w);
    const field = noiseField(gw, gh, 11);
    const sx = this.canvas.width / (gw - 1),
      sy = this.canvas.height / (gh - 1);
    drawContours(g, field, gw, gh, {
      interval: 25,
      indexEvery: 5,
      minor: { color: 'rgba(242,239,232,0.05)', width: 1 * dpr },
      index: { color: 'rgba(242,239,232,0.1)', width: 1.3 * dpr },
      ox: 0,
      oy: 0,
      sx,
      sy,
    });
  }

  set(p: number, label: string) {
    if (this.done) return;
    // Never go backwards (terrain progress is reported in a few phases).
    this.shown = Math.max(this.shown, p);
    this.fill.style.transform = `scaleX(${this.shown.toFixed(3)})`;
    setText(this.label, label);
    if (p >= 1) {
      this.done = true;
      window.setTimeout(() => this.root.classList.add('done'), 350);
      window.setTimeout(() => this.root.remove(), 1500);
    }
  }
}
