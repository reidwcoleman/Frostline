// PLACEHOLDER UI (owned by the UI/audio agent — replace with the real HUD and menus).
import type { GameContext, GameState, PromptInfo, ScreenId, System, UIAPI, Vec3Like } from '../core/types';

export class UI implements System, UIAPI {
  readonly name = 'ui';
  readonly updateWhen: GameState[] = ['boot', 'menu', 'playing', 'paused', 'dead'];
  private root: HTMLDivElement;
  private loading: HTMLDivElement;
  private hud: HTMLDivElement;
  private prompt: HTMLDivElement;
  private overlay: HTMLDivElement;
  blocking = false;

  constructor(private ctx: GameContext) {
    this.root = document.createElement('div');
    this.root.style.cssText = 'position:absolute;inset:0;font:14px system-ui;color:#f2efe8;';
    this.loading = el('div', 'position:absolute;inset:0;display:grid;place-items:center;background:#0b1016;font-size:18px;');
    this.hud = el('div', 'position:absolute;left:16px;bottom:16px;white-space:pre;text-shadow:0 1px 2px #000;');
    this.prompt = el('div', 'position:absolute;left:50%;top:58%;transform:translateX(-50%);text-shadow:0 1px 2px #000;');
    this.overlay = el('div', 'position:absolute;inset:0;display:none;place-items:center;background:rgba(8,12,18,.55);pointer-events:auto;font-size:28px;cursor:pointer;');
    this.root.append(this.hud, this.prompt, this.overlay, this.loading);
    ctx.uiRoot.appendChild(this.root);
    this.overlay.addEventListener('click', () => {
      const g = this.ctx.game;
      if (g.state === 'menu' || g.state === 'dead') g.newGame();
      else if (g.state === 'paused') g.resume();
    });
    ctx.events.on('state', ({ to }) => {
      this.overlay.style.display = to === 'menu' || to === 'paused' || to === 'dead' ? 'grid' : 'none';
      this.overlay.textContent = to === 'menu' ? 'FROSTLINE — click to play' : to === 'paused' ? 'Paused — click to resume' : 'You died — click for a new game';
    });
  }

  setLoading(p: number, label: string) {
    this.loading.textContent = `${label} … ${Math.round(p * 100)}%`;
    if (p >= 1) this.loading.style.display = 'none';
  }
  setPrompt(p: PromptInfo | null) {
    this.prompt.textContent = p ? `[${this.ctx.input.label(p.action as never)}] ${p.text}` : '';
  }
  toast(text: string) {
    console.info('[toast]', text);
  }
  hitMarker() {}
  damageFlash(_from?: Vec3Like) {}
  bigTitle(title: string, subtitle?: string) {
    console.info('[title]', title, subtitle ?? '');
  }
  showScreen(_s: ScreenId) {}

  update() {
    const { player: p, clock, game } = this.ctx;
    if (game.state !== 'playing') return;
    if (this.ctx.input.pressed('pause')) game.pause();
    this.hud.textContent =
      `Day ${clock.day}  ${clock.label()}\n` +
      `HP ${p.health.toFixed(0)}  Warm ${p.warmth.toFixed(0)}  Food ${p.satiety.toFixed(0)}\n` +
      `${(p.speed * 3.6).toFixed(0)} km/h  alt ${p.position.y.toFixed(0)} m  ${window.__frostline?.fps.toFixed(0)} fps`;
  }
}

function el(tag: string, css: string) {
  const e = document.createElement(tag) as HTMLDivElement;
  e.style.cssText = css;
  return e;
}
