// Procedural conifer models. Geometry is in "tree space": origin at the trunk base, height =
// the species' nominal height (World TREE_HEIGHT) so an instance only needs a uniform scale.
//
// Attributes (all LODs):
//   position, normal (blended toward a crown-volume normal for soft foliage lighting)
//   color   base albedo (linear) — needles / bark
//   uv      u = around the tier in "lobe" units, v = 0 at the trunk .. 1 at the branch tip
//   aSnow   0..1 how much snow this surface can hold (tops of boughs ~1, undersides 0)
//   aSway   0..1 wind bend weight (grows with height and toward branch tips)
import * as THREE from 'three';
import { mulberry32, type Rng } from '../../core/math';

export const TREE_HEIGHTS = [15, 17, 10, 5.5];
export const TREE_TYPES = 4;

class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  snow: number[] = [];
  sway: number[] = [];
  idx: number[] = [];
  get count() {
    return this.pos.length / 3;
  }
  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: THREE.Color, u: number, vv: number, snow: number, sway: number) {
    this.pos.push(x, y, z);
    const l = Math.hypot(nx, ny, nz) || 1;
    this.nrm.push(nx / l, ny / l, nz / l);
    this.col.push(c.r, c.g, c.b);
    this.uv.push(u, vv);
    this.snow.push(snow);
    this.sway.push(sway);
    return this.count - 1;
  }
  tri(a: number, b: number, c: number) {
    this.idx.push(a, b, c);
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aSnow', new THREE.Float32BufferAttribute(this.snow, 1));
    g.setAttribute('aSway', new THREE.Float32BufferAttribute(this.sway, 1));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

interface Detail {
  tiers: number; // tier count multiplier (1 = full)
  seg: number; // angular segments per lobe
  trunkSeg: number;
  rings: number; // radial rings on the tier top surface
}
const LOD_DETAIL: Detail[] = [
  { tiers: 1, seg: 3, trunkSeg: 7, rings: 3 },
  { tiers: 0.62, seg: 2, trunkSeg: 5, rings: 1 },
  { tiers: 0.34, seg: 1, trunkSeg: 4, rings: 1 },
];

const tmpC = new THREE.Color();

/** Tapered cylinder (bark). */
function trunk(b: Builder, r0: number, r1: number, y0: number, y1: number, seg: number, bark: THREE.Color, H: number, lean = 0, rng?: Rng) {
  const rings = 4;
  const base = b.count;
  for (let k = 0; k <= rings; k++) {
    const t = k / rings;
    const y = y0 + (y1 - y0) * t;
    const r = r0 + (r1 - r0) * Math.pow(t, 0.8);
    const ox = lean * t * t * (y1 - y0);
    for (let s = 0; s <= seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      const jit = rng ? 1 + (rng() - 0.5) * 0.12 : 1;
      const cx = Math.cos(a),
        cz = Math.sin(a);
      tmpC.copy(bark).multiplyScalar(0.85 + 0.3 * (0.5 + 0.5 * Math.sin(a * 3 + k)));
      b.v(ox + cx * r * jit, y, cz * r * jit, cx, 0.15, cz, tmpC, s / seg, 2 + t, 0.15, Math.pow(Math.max(0, y) / H, 1.6) * 0.8);
    }
  }
  const w = seg + 1;
  for (let k = 0; k < rings; k++)
    for (let s = 0; s < seg; s++) {
      const a = base + k * w + s;
      b.tri(a, a + w, a + 1);
      b.tri(a + 1, a + w, a + w + 1);
    }
}

interface TierOpts {
  y: number; // attach height at the trunk
  R: number; // outer radius
  droop: number; // tip drop below attach height
  lobes: number;
  phase: number;
  thick: number; // underside thickness near the trunk
  needle: THREE.Color;
  snow: number; // snow capacity 0..1
  H: number;
  cx?: number; // centre offset (pine clusters)
  cz?: number;
  dome?: number; // raise the middle (rounded clusters)
  lobeDepth?: number;
}

/** One drooping bough tier: a lobed, star-shaped skirt with a thick underside. */
function tier(b: Builder, o: TierOpts, d: Detail, rng: Rng) {
  const segs = o.lobes * d.seg;
  const ringsT = d.rings;
  const cx = o.cx ?? 0,
    cz = o.cz ?? 0;
  const dome = o.dome ?? 0;
  const depth = o.lobeDepth ?? 0.42;
  const H = o.H;
  const radius: number[] = [];
  const tipDrop: number[] = [];
  const lobeV: number[] = [];
  // Sparser LODs droop a little more so the skirts still overlap and hide the trunk.
  const droopK = d.tiers < 0.5 ? 1.5 : d.tiers < 1 ? 1.25 : 1;
  for (let s = 0; s <= segs; s++) {
    const a = (s / segs) * Math.PI * 2;
    const lobe = Math.pow(0.5 + 0.5 * Math.cos(o.lobes * a + o.phase), 1.6);
    lobeV.push(lobe);
    radius.push(o.R * (1 - depth + depth * lobe) * (0.92 + rng() * 0.16));
    tipDrop.push(o.droop * droopK * (0.75 + 0.45 * lobe));
  }
  radius[segs] = radius[0];
  tipDrop[segs] = tipDrop[0];
  // u runs in lobe units with lobe centres (branch spines) at integers.
  const lobeU = (s: number) => ((s / segs) * Math.PI * 2 * o.lobes + o.phase) / (Math.PI * 2);
  const w = segs + 1;
  // Top surface: rings from the trunk to the tips.
  const topBase = b.count;
  for (let k = 0; k <= ringsT; k++) {
    const t = k / ringsT;
    for (let s = 0; s <= segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      const ca = Math.cos(a),
        sa = Math.sin(a);
      const r = 0.08 * o.R + (radius[s] - 0.08 * o.R) * t;
      // Droop curve: nearly flat near the trunk, bending down toward the tip; snow pillows on top.
      const y = o.y - tipDrop[s] * Math.pow(t, 1.7) + dome * (1 - t * t) + o.snow * 0.05 * o.R * Math.sin(Math.PI * t) + lobeV[s] * 0.07 * o.R * Math.sin(Math.PI * Math.min(1, t * 1.3));
      const x = cx + ca * r,
        z = cz + sa * r;
      // Normal: blend the surface tilt with an outward crown-volume normal.
      const slope = (tipDrop[s] * 1.7 * Math.pow(t, 0.7)) / Math.max(0.3, radius[s]);
      const nx = ca * (slope * 0.6 + 0.55 * t),
        nz = sa * (slope * 0.6 + 0.55 * t);
      const ny = 1;
      tmpC.copy(o.needle).multiplyScalar(0.75 + 0.5 * t + (rng() - 0.5) * 0.12);
      const snowCap = o.snow * (1 - 0.55 * Math.pow(t, 3));
      b.v(x, y, z, nx, ny, nz, tmpC, lobeU(s), t, snowCap, Math.min(1, Math.pow(Math.max(0, y) / H, 1.4) * 0.7 + t * 0.45));
    }
  }
  for (let k = 0; k < ringsT; k++)
    for (let s = 0; s < segs; s++) {
      const a = topBase + k * w + s;
      b.tri(a, a + 1, a + w);
      b.tri(a + 1, a + w + 1, a + w);
    }
  // Underside: tip ring -> a ring hugging the trunk lower down (dark, no snow).
  const botBase = b.count;
  for (let k = 0; k <= 1; k++) {
    for (let s = 0; s <= segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      const ca = Math.cos(a),
        sa = Math.sin(a);
      const r = k === 0 ? radius[s] * 0.985 : 0.1 * o.R;
      const y = k === 0 ? o.y - tipDrop[s] - 0.02 : o.y - o.thick;
      tmpC.copy(o.needle).multiplyScalar(k === 0 ? 0.55 : 0.28);
      b.v(cx + ca * r, y, cz + sa * r, ca * 0.9, -0.55, sa * 0.9, tmpC, lobeU(s), k === 0 ? 1 : 0, 0, k === 0 ? Math.min(1, Math.pow(Math.max(0, y) / H, 1.4) * 0.7 + 0.45) : 0.2);
    }
  }
  for (let s = 0; s < segs; s++) {
    const a = botBase + s;
    b.tri(a, a + 1, a + w);
    b.tri(a + 1, a + w + 1, a + w);
  }
}

/** Dead branch stub (4-sided tapered prism). */
function stick(b: Builder, x: number, y: number, z: number, dx: number, dy: number, dz: number, len: number, r: number, bark: THREE.Color, H: number) {
  const dir = new THREE.Vector3(dx, dy, dz).normalize();
  const up = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const s1 = new THREE.Vector3().crossVectors(dir, up).normalize();
  const s2 = new THREE.Vector3().crossVectors(s1, dir).normalize();
  const base = b.count;
  const seg = 4;
  for (let k = 0; k <= 1; k++) {
    const rr = k === 0 ? r : r * 0.25;
    const px = x + dir.x * len * k,
      py = y + dir.y * len * k,
      pz = z + dir.z * len * k;
    for (let s = 0; s <= seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      const nx = s1.x * Math.cos(a) + s2.x * Math.sin(a);
      const ny = s1.y * Math.cos(a) + s2.y * Math.sin(a);
      const nz = s1.z * Math.cos(a) + s2.z * Math.sin(a);
      b.v(px + nx * rr, py + ny * rr, pz + nz * rr, nx, ny, nz, bark, s / seg, 2 + k, Math.max(0, ny) * 0.9, Math.min(1, (py / H) * 0.8 + k * 0.4));
    }
  }
  for (let s = 0; s < seg; s++) {
    const a = base + s;
    b.tri(a, a + seg + 1, a + 1);
    b.tri(a + 1, a + seg + 1, a + seg + 2);
  }
}

const SPRUCE_NEEDLE = new THREE.Color(0.018, 0.05, 0.04);
const FIR_NEEDLE = new THREE.Color(0.02, 0.055, 0.042);
const PINE_NEEDLE = new THREE.Color(0.03, 0.06, 0.035);
const BARK = new THREE.Color(0.075, 0.055, 0.042);
const PINE_BARK_UP = new THREE.Color(0.22, 0.09, 0.045);
const SNAG_BARK = new THREE.Color(0.3, 0.27, 0.23);

function conifer(b: Builder, d: Detail, rng: Rng, H: number, widthRatio: number, crownBase: number, tierCount: number, needle: THREE.Color, snow: number, trunkR: number) {
  trunk(b, trunkR, trunkR * 0.25, -0.4, H * 0.97, d.trunkSeg, BARK, H, 0, rng);
  const n = Math.max(4, Math.round(tierCount * d.tiers));
  const yb = H * crownBase;
  for (let k = 0; k < n; k++) {
    const t = k / n;
    const y = yb + (H - yb) * Math.pow(t, 0.92) + (rng() - 0.5) * 0.15 * ((H - yb) / n);
    const taper = Math.pow(1 - t, 1.08);
    const R = Math.max(0.25, H * widthRatio * taper * (0.9 + rng() * 0.2) + 0.12);
    tier(
      b,
      {
        y,
        R,
        droop: R * (0.42 + rng() * 0.12) * (0.7 + 0.3 * (1 - t)),
        lobes: Math.max(5, Math.round(8 - t * 3 + rng())),
        phase: rng() * 6.283,
        thick: R * 0.5 + 0.2,
        needle,
        snow: snow * (0.85 + rng() * 0.3),
        H,
        lobeDepth: 0.38 + rng() * 0.12,
      },
      d,
      rng,
    );
  }
  // Leader: a small spike on top.
  tier(b, { y: H * 0.985, R: 0.22, droop: 0.28, lobes: 5, phase: 0, thick: 0.35, needle, snow: snow * 0.6, H, lobeDepth: 0.3 }, { ...d, rings: 1 }, rng);
}

function pine(b: Builder, d: Detail, rng: Rng, H: number) {
  // Scots pine: straight clear bole, orange upper bark, an irregular rounded crown of big puffs.
  trunk(b, 0.32, 0.1, -0.4, H * 0.9, d.trunkSeg, BARK, H, 0, rng);
  trunk(b, 0.21, 0.07, H * 0.5, H * 0.95, d.trunkSeg, PINE_BARK_UP, H, 0, rng);
  const layers = 3;
  const perLayer = [4, 3, 2];
  for (let L = 0; L < layers; L++) {
    const n = Math.max(1, Math.round(perLayer[L] * Math.max(0.7, d.tiers)));
    const t = L / (layers - 1);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + L * 0.9 + rng() * 0.8;
      const off = (1 - t * 0.75) * (1.3 + rng() * 1.1);
      const cx = Math.cos(a) * off,
        cz = Math.sin(a) * off;
      const y = H * (0.62 + 0.27 * t) + (rng() - 0.5) * 0.9;
      const R = (2.2 + rng() * 0.8) * (1 - t * 0.35);
      stick(b, 0, y - 0.9, 0, cx, 0.7, cz, off + 0.4, 0.1, PINE_BARK_UP, H);
      tier(
        b,
        { y, R, droop: R * 0.3, lobes: 7 + Math.floor(rng() * 3), phase: rng() * 6.28, thick: R * 0.55, needle: PINE_NEEDLE, snow: 1, H, cx, cz, dome: R * 0.42, lobeDepth: 0.3 },
        d,
        rng,
      );
    }
  }
  // Crown top.
  tier(b, { y: H * 0.96, R: 1.5, droop: 0.4, lobes: 7, phase: rng() * 6.28, thick: 0.8, needle: PINE_NEEDLE, snow: 1, H, dome: 0.6, lobeDepth: 0.3 }, d, rng);
}

function snag(b: Builder, d: Detail, rng: Rng, H: number) {
  // Dead, silver-grey, broken-topped; stubby branches drooping, snow along their tops.
  trunk(b, 0.3, 0.12, -0.4, H * 0.86, d.trunkSeg, SNAG_BARK, H, 0.025, rng);
  // Jagged broken top: two splinters.
  stick(b, 0.03, H * 0.84, 0, 0.12, 1, 0.05, H * 0.1, 0.12, SNAG_BARK, H);
  stick(b, -0.05, H * 0.84, 0.03, -0.1, 1, 0.12, H * 0.06, 0.08, SNAG_BARK, H);
  const n = Math.round(14 * Math.max(0.6, d.tiers));
  for (let k = 0; k < n; k++) {
    const t = k / n;
    const y = H * (0.22 + 0.6 * t) + (rng() - 0.5) * 0.3;
    const a = rng() * Math.PI * 2;
    const len = (2.6 - t * 1.6) * (0.45 + rng() * 0.75);
    const r = 0.11 * (1 - t * 0.5);
    stick(b, Math.cos(a) * 0.15, y, Math.sin(a) * 0.15, Math.cos(a), -0.25 + rng() * 0.5, Math.sin(a), len, r, SNAG_BARK, H);
  }
}

/** Build tree geometry for a species and LOD (0 near, 1 mid, 2 far/shadow proxy). Deterministic per variant. */
export function buildTreeGeometry(type: number, lod: number, variant = 0): THREE.BufferGeometry {
  const rng = mulberry32(1000 + type * 97 + variant * 13);
  const d = LOD_DETAIL[Math.min(lod, LOD_DETAIL.length - 1)];
  const b = new Builder();
  const H = TREE_HEIGHTS[type];
  switch (type) {
    case 0: // Norway spruce: narrow spire, heavy drooping tiers.
      conifer(b, d, rng, H, 0.2, 0.09, 20, SPRUCE_NEEDLE, 1, 0.3);
      break;
    case 1:
      pine(b, d, rng, H);
      break;
    case 2:
      snag(b, d, rng, H);
      break;
    default: // Young subalpine fir: dense, broad, loaded with snow.
      conifer(b, d, rng, H, 0.3, 0.02, 12, FIR_NEEDLE, 1.25, 0.14);
      break;
  }
  return b.build();
}

/** Open cone (for shadow proxies). */
function cone(b: Builder, y0: number, y1: number, r: number, sides: number, H: number) {
  const base = b.count;
  const c = new THREE.Color(0, 0, 0);
  for (let s = 0; s <= sides; s++) {
    const a = (s / sides) * Math.PI * 2;
    b.v(Math.cos(a) * r, y0, Math.sin(a) * r, Math.cos(a), 0.5, Math.sin(a), c, 0, 0, 0, Math.min(1, (y0 / H) * 0.7 + 0.45));
  }
  const tip = b.v(0, y1, 0, 0, 1, 0, c, 0, 0, 0, Math.min(1, (y1 / H) * 0.7));
  for (let s = 0; s < sides; s++) b.tri(base + s, tip, base + s + 1);
}

/** ~20-60 triangle silhouettes used only for far-cascade shadows. */
export function buildShadowProxy(type: number): THREE.BufferGeometry {
  const b = new Builder();
  const H = TREE_HEIGHTS[type];
  const d: Detail = { tiers: 0.3, seg: 1, trunkSeg: 4, rings: 1 };
  const rng = mulberry32(4242 + type);
  if (type === 0 || type === 3) {
    const wide = type === 0 ? 0.2 : 0.3;
    const yb = H * (type === 0 ? 0.09 : 0.02);
    trunk(b, 0.3 * (type === 0 ? 1 : 0.5), 0.1, -0.4, H * 0.4, 4, BARK, H);
    const n = type === 0 ? 3 : 2;
    for (let k = 0; k < n; k++) {
      const t0 = k / n;
      const y0 = yb + (H - yb) * t0 - (H - yb) * 0.05;
      const r = H * wide * Math.pow(1 - t0, 1.05) + 0.2;
      cone(b, Math.max(0.2, y0), Math.min(H, y0 + (H - yb) * 0.6), r, 7, H);
    }
  } else if (type === 1) {
    trunk(b, 0.32, 0.1, -0.4, H * 0.8, 4, BARK, H);
    tier(b, { y: H * 0.78, R: 3.3, droop: 1.1, lobes: 7, phase: rng() * 6.28, thick: 2.0, needle: PINE_NEEDLE, snow: 0, H, dome: 1.6, lobeDepth: 0.2 }, d, rng);
  } else {
    snag(b, { tiers: 0.4, seg: 1, trunkSeg: 4, rings: 1 }, rng, H);
  }
  return b.build();
}
