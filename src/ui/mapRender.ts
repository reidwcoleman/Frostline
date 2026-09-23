// The paper topographic map, rendered once from the real heightmap: warm paper, swiss-style
// hillshade, forest tint from the actual trees, creeks from the drainage map, the frozen
// lake, 25 m contours with 100 m index lines, and the summit spot height.
import type { GameContext } from '../core/types';
import { drawContours } from './contours';

export interface PaperMap {
  canvas: HTMLCanvasElement;
  /** world metres per canvas pixel */
  mpp: number;
  size: number;
  summit: { x: number; z: number; h: number };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const sstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export function renderPaperMap(ctx: GameContext, size = 2048): PaperMap {
  const t = ctx.terrain;
  const res = t.res;
  const H = t.heights;
  const lake = t.data.lakeMask;
  const flow = t.data.flow;
  const minH = t.data.minHeight,
    maxH = t.data.maxHeight;

  // ---- forest density from the real trees (16 m bins, blurred)
  const bins = 256;
  const dens = new Float32Array(bins * bins);
  const w = ctx.world;
  const binM = t.size / bins;
  for (let i = 0; i < w.treeCount; i++) {
    const bx = Math.floor((w.treeX[i] + t.half) / binM),
      bz = Math.floor((w.treeZ[i] + t.half) / binM);
    if (bx >= 0 && bz >= 0 && bx < bins && bz < bins) dens[bz * bins + bx] += 1;
  }
  const blur = new Float32Array(bins * bins);
  for (let z = 0; z < bins; z++)
    for (let x = 0; x < bins; x++) {
      let s = 0,
        n = 0;
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx,
            zz = z + dz;
          if (xx < 0 || zz < 0 || xx >= bins || zz >= bins) continue;
          const wgt = dx === 0 && dz === 0 ? 2 : 1;
          s += dens[zz * bins + xx] * wgt;
          n += wgt;
        }
      blur[z * bins + x] = s / n;
    }

  // ---- base raster at heightmap resolution
  const base = document.createElement('canvas');
  base.width = base.height = res;
  const bg = base.getContext('2d')!;
  const img = bg.createImageData(res, res);
  const px = img.data;
  // Palette (sRGB 0..255)
  const paperLo = [214, 204, 182]; // valley paper, warmer
  const paperHi = [242, 239, 231]; // high snowfields
  const shadow = [118, 124, 136]; // cool swiss shadow
  const forest = [122, 140, 116]; // muted sage, not lime
  const ice = [174, 202, 214];
  const creek = [96, 142, 176];
  // Light from the north-west, 45° up (cartographic convention).
  const lx = -0.5,
    lz = -0.5,
    ly = 0.7071;
  const cell = t.cell;
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const k = j * res + i;
      const hC = H[k];
      const hx = (H[j * res + Math.min(res - 1, i + 1)] - H[j * res + Math.max(0, i - 1)]) / (2 * cell);
      const hz = (H[Math.min(res - 1, j + 1) * res + i] - H[Math.max(0, j - 1) * res + i]) / (2 * cell);
      // normal = (-hx, 1, -hz) normalised
      const inv = 1 / Math.sqrt(hx * hx + 1 + hz * hz);
      let shade = (-hx * lx + ly - hz * lz) * inv; // 0..1
      shade = Math.max(0, Math.min(1, shade));
      const e = (hC - minH) / (maxH - minH);
      // Paper tone by elevation, then hillshade toward a cool shadow.
      const tone = sstep(0.05, 0.85, e);
      let r = lerp(paperLo[0], paperHi[0], tone),
        g = lerp(paperLo[1], paperHi[1], tone),
        b = lerp(paperLo[2], paperHi[2], tone);
      const sh = Math.pow(1 - shade, 1.35) * 0.9;
      r = lerp(r, shadow[0], sh);
      g = lerp(g, shadow[1], sh);
      b = lerp(b, shadow[2], sh);
      // Brighten sun-facing slopes a touch for relief.
      const hi = Math.max(0, shade - 0.78) * 0.9;
      r = lerp(r, 250, hi);
      g = lerp(g, 248, hi);
      b = lerp(b, 242, hi);
      // Forest tint.
      const wx = -t.half + i * cell,
        wz = -t.half + j * cell;
      // Bilinear density so forest edges are soft, not 16 m blocks.
      const gx = Math.min(bins - 1.001, Math.max(0, (wx + t.half) / binM - 0.5));
      const gz = Math.min(bins - 1.001, Math.max(0, (wz + t.half) / binM - 0.5));
      const ix = gx | 0,
        iz = gz | 0,
        tx = gx - ix,
        tz = gz - iz;
      const d00 = blur[iz * bins + ix],
        d10 = blur[iz * bins + ix + 1],
        d01 = blur[(iz + 1) * bins + ix],
        d11 = blur[(iz + 1) * bins + ix + 1];
      const dd = (d00 * (1 - tx) + d10 * tx) * (1 - tz) + (d01 * (1 - tx) + d11 * tx) * tz;
      const f = sstep(0.5, 3.4, dd) * 0.5;
      r = lerp(r, forest[0] * (0.75 + 0.25 * shade), f);
      g = lerp(g, forest[1] * (0.75 + 0.25 * shade), f);
      b = lerp(b, forest[2] * (0.75 + 0.25 * shade), f);
      // Creeks.
      const fl = flow[k] / 255;
      const c = sstep(0.74, 0.9, fl) * 0.85;
      r = lerp(r, creek[0], c);
      g = lerp(g, creek[1], c);
      b = lerp(b, creek[2], c);
      // Lake ice.
      const l = lake[k] / 255;
      if (l > 0) {
        r = lerp(r, ice[0], l);
        g = lerp(g, ice[1], l);
        b = lerp(b, ice[2], l);
      }
      px[k * 4] = r;
      px[k * 4 + 1] = g;
      px[k * 4 + 2] = b;
      px[k * 4 + 3] = 255;
    }
  }
  bg.putImageData(img, 0, 0);

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(base, 0, 0, size, size);

  // 1 km grid, very faint.
  const s = size / t.size;
  g.strokeStyle = 'rgba(60,48,36,0.07)';
  g.lineWidth = 1;
  g.beginPath();
  for (let m = -2000; m <= 2000; m += 1000) {
    const p = (m + t.half) * s;
    g.moveTo(p, 0);
    g.lineTo(p, size);
    g.moveTo(0, p);
    g.lineTo(size, p);
  }
  g.stroke();

  // Contours (not over the lake: it's flat, so none are generated there anyway).
  const sc = size / (res - 1);
  drawContours(g, H, res, res, {
    interval: 25,
    indexEvery: 4,
    minor: { color: 'rgba(120,86,56,0.30)', width: 0.9 },
    index: { color: 'rgba(110,74,44,0.62)', width: 1.5 },
    ox: 0,
    oy: 0,
    sx: sc,
    sy: sc,
  });

  // Lake shoreline.
  const lakeF = new Float32Array(res * res);
  for (let k = 0; k < lakeF.length; k++) lakeF[k] = lake[k];
  drawContours(g, lakeF, res, res, {
    interval: 127.5,
    indexEvery: 0,
    minor: { color: 'rgba(70,112,140,0.75)', width: 1.4 },
    index: { color: 'transparent', width: 0 },
    ox: 0,
    oy: 0,
    sx: sc,
    sy: sc,
  });

  // Water label, cartographic style: italic serif in lake blue.
  const [lcx, lcz] = t.data.lakeCenter;
  g.font = 'italic 400 36px "Instrument Serif", serif';
  g.textAlign = 'center';
  g.fillStyle = 'rgba(48, 88, 116, 0.8)';
  g.fillText('Frozen lake', (lcx + t.half) * s, (lcz + t.half) * s + 12);

  // Paper grain.
  const grain = g.getImageData(0, 0, size, size);
  const gd = grain.data;
  let seed = 99991;
  for (let i = 0; i < gd.length; i += 4) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const n = ((seed >>> 24) - 128) * 0.045;
    gd[i] += n;
    gd[i + 1] += n;
    gd[i + 2] += n;
  }
  g.putImageData(grain, 0, 0);

  // Summit spot height.
  let best = 0;
  for (let k = 1; k < H.length; k++) if (H[k] > H[best]) best = k;
  const si = best % res,
    sj = Math.floor(best / res);
  const summit = { x: -t.half + si * cell, z: -t.half + sj * cell, h: H[best] };
  const sxp = si * sc,
    syp = sj * sc;
  g.fillStyle = '#3b2f25';
  g.beginPath();
  g.moveTo(sxp, syp - 6);
  g.lineTo(sxp + 5.5, syp + 4);
  g.lineTo(sxp - 5.5, syp + 4);
  g.closePath();
  g.fill();
  g.font = '600 20px "Barlow Semi Condensed", sans-serif';
  g.textAlign = 'center';
  g.lineWidth = 4;
  g.strokeStyle = 'rgba(240,235,222,0.85)';
  const lbl = `${Math.round(summit.h).toLocaleString('en-US')}`;
  g.strokeText(lbl, sxp, syp + 24);
  g.fillText(lbl, sxp, syp + 24);

  return { canvas, mpp: t.size / size, size, summit };
}
