// Map: the paper topographic map with the player arrow and points of interest.
// Wheel / triggers zoom, drag / left stick pan, the crosshair button recentres.
import { h, css, setText, fmtAlt } from '../dom';
import { icon } from '../icons';
import { collectMarkers, MARKER_ICON, type Marker } from '../markers';
import { yawToBearing } from '../Hud';
import { clamp } from '../../core/math';
import type { PaperMap } from '../mapRender';
import type { UI } from '../UI';
import type { JournalTab } from './Journal';

const MIN_Z = 1,
  MAX_Z = 7;

export class MapTab implements JournalTab {
  readonly id = 'map' as const;
  readonly root = h('div', { style: 'display:contents' });
  private wrap = h('div.pane.mapwrap.glass');
  private view = h('div.mapview');
  private overlay = h('div.overlay');
  private you = h('div.you', {
    html: '<svg viewBox="-14 -14 28 28" style="width:100%;height:100%;overflow:visible"><circle r="11" fill="rgba(255,106,43,0.16)"/><path d="M0 -9 L6.5 7 L0 3.2 L-6.5 7Z" fill="#FF6A2B" stroke="#2a1408" stroke-width="1.1" stroke-linejoin="round"/></svg>',
  });
  private info = h('div.mapinfo');
  private elev = h('b.num');
  private scale = h('div.mapscale');
  private scaleLbl = h('span');
  private scaleBar = h('i');
  private zoomIn = h<'button'>('button', { 'data-k': 'zin', title: 'Zoom in', html: icon('plus') });
  private zoomOut = h<'button'>('button', { 'data-k': 'zout', title: 'Zoom out', html: icon('minus') });
  private centerBtn = h<'button'>('button', { 'data-k': 'ctr', title: 'Centre on you', html: icon('crosshair') });
  private map: PaperMap | null = null;
  private z = 2.4;
  private cx = 0;
  private cz = 0;
  private vw = 0;
  private vh = 0;
  private markers: Marker[] = [];
  private markerEls: HTMLDivElement[] = [];
  private drag: { x: number; y: number; cx: number; cz: number } | null = null;

  constructor(private ui: UI) {
    this.info.append(h('span', { text: 'Elevation' }), this.elev);
    this.scale.append(this.scaleLbl, this.scaleBar);
    this.view.append(this.overlay);
    this.overlay.append(this.you);
    const ctl = h('div.mapctl', null, this.zoomIn, this.zoomOut, this.centerBtn);
    this.wrap.append(this.view, ctl, this.scale, this.info);
    this.root.append(this.wrap);

    this.zoomIn.addEventListener('click', () => this.zoomBy(1.5));
    this.zoomOut.addEventListener('click', () => this.zoomBy(1 / 1.5));
    this.centerBtn.addEventListener('click', () => {
      ui.sfx('ui_click');
      this.recenter();
    });
    this.view.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const r = this.view.getBoundingClientRect();
        this.zoomAt(e.deltaY < 0 ? 1.18 : 1 / 1.18, e.clientX - r.left, e.clientY - r.top);
      },
      { passive: false },
    );
    this.view.addEventListener('pointerdown', (e) => {
      this.drag = { x: e.clientX, y: e.clientY, cx: this.cx, cz: this.cz };
      this.view.setPointerCapture(e.pointerId);
    });
    this.view.addEventListener('pointermove', (e) => {
      if (!this.drag || !this.map) return;
      const mpp = this.mppScreen();
      this.cx = this.drag.cx - (e.clientX - this.drag.x) * mpp;
      this.cz = this.drag.cz - (e.clientY - this.drag.y) * mpp;
      this.apply();
    });
    const end = () => (this.drag = null);
    this.view.addEventListener('pointerup', end);
    this.view.addEventListener('pointercancel', end);
  }

  show() {
    this.map = this.ui.paperMap();
    if (this.map && !this.map.canvas.parentElement) this.view.prepend(this.map.canvas);
    this.markers = collectMarkers(this.ui.ctx);
    this.markerEls.forEach((e) => e.remove());
    this.markerEls = this.markers.map((m) => {
      const el = h('div.mk', { html: icon(MARKER_ICON[m.kind]) }, h('span.lbl', { text: m.kind === 'spawn' ? 'Start' : m.label }));
      this.overlay.insertBefore(el, this.you);
      return el;
    });
    this.recenter();
  }
  hide() {
    this.drag = null;
  }
  hints() {
    return '';
  }
  initialFocus() {
    return this.centerBtn;
  }

  private recenter() {
    const p = this.ui.ctx.player.position;
    this.cx = p.x;
    this.cz = p.z;
    this.apply();
  }

  /** Screen pixels → world metres at the current zoom. */
  private mppScreen() {
    if (!this.map) return 1;
    const fit = Math.min(this.vw || 800, this.vh || 600) / this.map.size;
    return this.map.mpp / (fit * this.z);
  }

  private zoomBy(f: number) {
    this.ui.sfx('ui_hover');
    this.zoomAt(f, this.vw / 2, this.vh / 2);
  }

  private zoomAt(f: number, sx: number, sy: number) {
    const before = this.mppScreen();
    const wx = this.cx + (sx - this.vw / 2) * before,
      wz = this.cz + (sy - this.vh / 2) * before;
    this.z = clamp(this.z * f, MIN_Z, MAX_Z);
    const after = this.mppScreen();
    this.cx = wx - (sx - this.vw / 2) * after;
    this.cz = wz - (sy - this.vh / 2) * after;
    this.apply();
  }

  analog(lx: number, ly: number, lt: number, rt: number, dt: number) {
    if (lx || ly) {
      const speed = 700 * this.mppScreen() * dt;
      this.cx += lx * speed;
      this.cz += ly * speed;
    }
    if (rt > 0.1 || lt > 0.1) this.zoomAt(Math.pow(2.2, (rt - lt) * dt * 1.6), this.vw / 2, this.vh / 2);
    else if (lx || ly) this.apply();
  }

  key(e: KeyboardEvent): boolean {
    const step = 120 * this.mppScreen();
    switch (e.code) {
      case 'Equal':
      case 'NumpadAdd':
        this.zoomBy(1.5);
        return true;
      case 'Minus':
      case 'NumpadSubtract':
        this.zoomBy(1 / 1.5);
        return true;
      case 'KeyC':
        this.recenter();
        return true;
      case 'KeyW':
        this.cz -= step;
        break;
      case 'KeyS':
        this.cz += step;
        break;
      case 'KeyA':
        this.cx -= step;
        break;
      case 'KeyD':
        this.cx += step;
        break;
      default:
        return false;
    }
    this.apply();
    return true;
  }

  private apply() {
    if (!this.map) return;
    this.vw = this.view.clientWidth;
    this.vh = this.view.clientHeight;
    const t = this.ui.ctx.terrain;
    const mpp = this.mppScreen();
    // Keep the map from sliding off-screen.
    const hwx = (this.vw / 2) * mpp,
      hwz = (this.vh / 2) * mpp;
    const lim = t.half;
    this.cx = hwx >= lim ? 0 : clamp(this.cx, -lim + hwx, lim - hwx);
    this.cz = hwz >= lim ? 0 : clamp(this.cz, -lim + hwz, lim - hwz);
    const scale = this.map.mpp / mpp;
    const tx = this.vw / 2 - ((this.cx + t.half) / this.map.mpp) * scale;
    const ty = this.vh / 2 - ((this.cz + t.half) / this.map.mpp) * scale;
    css(this.map.canvas, 'transform', `translate(${tx.toFixed(1)}px,${ty.toFixed(1)}px) scale(${scale.toFixed(4)})`);
    this.placeOverlay();
    // Scale bar: a round distance ~ 1/5 of the view.
    const target = this.vw * 0.18 * mpp;
    const nice = [50, 100, 200, 250, 500, 1000, 2000].reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
    const imp = this.ui.ctx.settings.data.units === 'imperial';
    setText(this.scaleLbl, imp ? `${Math.round(nice * 3.28084)} ft` : nice >= 1000 ? `${nice / 1000} km` : `${nice} m`);
    css(this.scaleBar, 'width', `${(nice / mpp).toFixed(1)}px`);
  }

  private toScreen(x: number, z: number): [number, number] {
    const mpp = this.mppScreen();
    return [this.vw / 2 + (x - this.cx) / mpp, this.vh / 2 + (z - this.cz) / mpp];
  }

  private placeOverlay() {
    const p = this.ui.ctx.player;
    const [px, py] = this.toScreen(p.position.x, p.position.z);
    css(this.you, 'transform', `translate(${px.toFixed(1)}px,${py.toFixed(1)}px) rotate(${yawToBearing(p.yaw).toFixed(1)}deg)`);
    this.markers.forEach((m, i) => {
      const [x, y] = this.toScreen(m.x, m.z);
      css(this.markerEls[i], 'transform', `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`);
      // Don't stack a marker under the player's own arrow.
      const near = Math.hypot(m.x - p.position.x, m.z - p.position.z) < 40;
      css(this.markerEls[i], 'opacity', near ? '0' : '1');
    });
    setText(this.elev, fmtAlt(p.position.y, this.ui.ctx.settings.data.units));
  }

  update() {
    if (this.vw !== this.view.clientWidth || this.vh !== this.view.clientHeight) this.apply();
    else this.placeOverlay();
  }
}
