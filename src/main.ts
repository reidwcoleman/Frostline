import { Game } from './core/Game';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui') as HTMLElement;
const game = new Game(canvas, uiRoot);
game.boot().catch((err) => {
  console.error(err);
  uiRoot.innerHTML = `<pre style="color:#f88;padding:24px;white-space:pre-wrap">${String(err?.stack ?? err)}</pre>`;
});
