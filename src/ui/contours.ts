// Topographic contour lines (marching squares) — the UI's signature motif. Used by the
// loading screen (noise terrain), the main-menu rail (real heightmap) and the paper map.
import { Simplex2 } from '../core/noise';

export interface ContourStyle {
  interval: number; // height step between lines
  indexEvery: number; // every Nth line is an index (bolder) line; 0 = none
  minor: { color: string; width: number };
  index: { color: string; width: number };
  /** grid -> canvas transform */
  ox: number;
  oy: number;
  sx: number;
  sy: number;
}

/**
 * Strokes contour lines of a height grid onto a 2D canvas. Minor and index lines are
 * each one path so overlapping segment ends don't double up alpha.
 */
export function drawContours(g: CanvasRenderingContext2D, grid: ArrayLike<number>, w: number, h: number, st: ContourStyle, stride = 1) {
  const minor = new Path2D();
  const index = new Path2D();
  const { interval, indexEvery, ox, oy } = st;
  const sx = st.sx * stride,
    sy = st.sy * stride;
  const cw = Math.floor((w - 1) / stride),
    ch = Math.floor((h - 1) / stride);
  for (let j = 0; j < ch; j++) {
    const r0 = j * stride * w,
      r1 = (j + 1) * stride * w;
    for (let i = 0; i < cw; i++) {
      const a = grid[r0 + i * stride],
        b = grid[r0 + (i + 1) * stride],
        c = grid[r1 + (i + 1) * stride],
        d = grid[r1 + i * stride];
      let lo = a,
        hi = a;
      if (b < lo) lo = b;
      if (b > hi) hi = b;
      if (c < lo) lo = c;
      if (c > hi) hi = c;
      if (d < lo) lo = d;
      if (d > hi) hi = d;
      let k0 = Math.ceil(lo / interval);
      const k1 = Math.floor(hi / interval);
      if (k0 * interval === lo) k0++; // a line exactly on a corner belongs to the neighbour
      for (let k = k0; k <= k1; k++) {
        const L = k * interval;
        const idx = ((a > L ? 8 : 0) | (b > L ? 4 : 0) | (c > L ? 2 : 0) | (d > L ? 1 : 0)) as number;
        if (idx === 0 || idx === 15) continue;
        const p = indexEvery > 0 && k % indexEvery === 0 ? index : minor;
        // Edge crossings (grid units, relative to the cell origin).
        const tx = (L - a) / (b - a); // top: a -> b
        const ry = (L - b) / (c - b); // right: b -> c
        const bx = (L - d) / (c - d); // bottom: d -> c
        const ly = (L - a) / (d - a); // left: a -> d
        const X = ox + i * sx,
          Y = oy + j * sy;
        const T = () => [X + tx * sx, Y] as const;
        const R = () => [X + sx, Y + ry * sy] as const;
        const B = () => [X + bx * sx, Y + sy] as const;
        const Lf = () => [X, Y + ly * sy] as const;
        const seg = (p1: readonly [number, number], p2: readonly [number, number]) => {
          p.moveTo(p1[0], p1[1]);
          p.lineTo(p2[0], p2[1]);
        };
        switch (idx) {
          case 1: case 14: seg(Lf(), B()); break;
          case 2: case 13: seg(B(), R()); break;
          case 3: case 12: seg(Lf(), R()); break;
          case 4: case 11: seg(T(), R()); break;
          case 6: case 9: seg(T(), B()); break;
          case 7: case 8: seg(Lf(), T()); break;
          case 5: {
            const centre = (a + b + c + d) / 4 > L;
            if (centre) { seg(Lf(), B()); seg(T(), R()); } else { seg(Lf(), T()); seg(B(), R()); }
            break;
          }
          case 10: {
            const centre = (a + b + c + d) / 4 > L;
            if (centre) { seg(Lf(), T()); seg(B(), R()); } else { seg(Lf(), B()); seg(T(), R()); }
            break;
          }
        }
      }
    }
  }
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.strokeStyle = st.minor.color;
  g.lineWidth = st.minor.width;
  g.stroke(minor);
  if (indexEvery > 0) {
    g.strokeStyle = st.index.color;
    g.lineWidth = st.index.width;
    g.stroke(index);
  }
}

/** A plausible mountain field from noise, for the loading screen (the real terrain isn't ready yet). */
export function noiseField(w: number, h: number, seed = 7): Float32Array {
  const n = new Simplex2(seed);
  const out = new Float32Array(w * h);
  const s = 1 / Math.max(w, h);
  let lo = Infinity,
    hi = -Infinity;
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      // Few, broad octaves with a gentle domain warp: long flowing lines like a real
      // topo sheet, not busy camouflage.
      const x = i * s * 1.35,
        y = j * s * 1.35;
      const wx = x + 0.35 * n.noise(x * 0.8 + 11.7, y * 0.8 - 4.2),
        wy = y + 0.35 * n.noise(x * 0.8 - 7.3, y * 0.8 + 2.9);
      const ridge = 1 - Math.abs(n.noise(wx * 1.1 + 5.5, wy * 1.1 - 3.3));
      const v = n.noise(wx, wy) * 0.75 + ridge * ridge * 0.45 + n.noise(wx * 2.3 + 9, wy * 2.3) * 0.12;
      out[j * w + i] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  // Normalise to 0..1000 so a fixed interval gives a predictable number of lines.
  const k = 1000 / Math.max(1e-6, hi - lo);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) * k;
  return out;
}

/** Procedural film grain as a data URL, tiled at ~3% over panels so flat colour doesn't feel dead. */
export function grainURL(size = 160): string {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const img = g.createImageData(size, size);
  let s = 1234567;
  for (let i = 0; i < img.data.length; i += 4) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const v = (s >> 8) & 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}
