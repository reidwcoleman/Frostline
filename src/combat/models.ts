// Procedural weapon models: hatchet, spear, recurve bow (animated limbs + string), torch and
// arrow. Built once, shared by the first-person viewmodels and the world projectiles.
// Conventions: viewmodel tools are built with the grip at the origin and the haft along +Y;
// projectiles (arrow, spear) have the tip at the origin pointing +Z (so Object3D.lookAt aims them).
import * as THREE from 'three';
import { MeshBuilder, loft, smoothRings, col, v3, mottle, type LoftRing } from './geom';

const _c = new THREE.Color();
const ss = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface WeaponMaterials {
  wood: THREE.MeshStandardMaterial;
  steel: THREE.MeshStandardMaterial;
  leather: THREE.MeshStandardMaterial;
  flint: THREE.MeshStandardMaterial;
  cloth: THREE.MeshStandardMaterial;
  feather: THREE.MeshStandardMaterial;
  string: THREE.MeshStandardMaterial;
}

export function createWeaponMaterials(): WeaponMaterials {
  return {
    wood: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0 }),
    steel: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.34, metalness: 0.55 }),
    leather: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 }),
    flint: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.05, flatShading: true }),
    cloth: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, emissive: 0xff5a14, emissiveIntensity: 0 }),
    feather: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, side: THREE.DoubleSide }),
    string: new THREE.MeshStandardMaterial({ color: 0xd9ceb4, roughness: 0.8, metalness: 0 }),
  };
}

/** Wood grain: fine streaks along the given axis + slow colour drift and the odd knot. */
function woodColor(a: number, b: number, along: 'y' | 'z') {
  const light = col(a),
    dark = col(b);
  return (p: THREE.Vector3) => {
    const u = along === 'y' ? p.y : p.z;
    const w1 = along === 'y' ? p.x : p.x;
    const w2 = along === 'y' ? p.z : p.y;
    const streak = Math.sin(w1 * 820 + w2 * 610 + Math.sin(u * 26) * 2.4 + Math.sin(u * 83) * 0.6);
    const g = 0.5 + 0.5 * streak;
    const drift = 0.5 + 0.5 * Math.sin(u * 7.3 + 1.1);
    return _c.copy(dark).lerp(light, 0.25 + g * 0.45 + drift * 0.2).offsetHSL(0, 0, mottle(p, 60) * 0.03);
  };
}

function mesh(g: THREE.BufferGeometry, m: THREE.Material, cast = false) {
  const x = new THREE.Mesh(g, m);
  x.castShadow = cast;
  x.receiveShadow = true;
  return x;
}

// =============================================================================== HATCHET
export function buildHatchet(M: WeaponMaterials): THREE.Group {
  const g = new THREE.Group();
  g.name = 'hatchet';
  // Haft: gentle S-curve, oval section, flared knob.
  const haft: LoftRing[] = smoothRings(
    [
      { p: v3(0, -0.095, 0.004), rx: 0.013, ry: 0.017 },
      { p: v3(0, -0.085, 0.003), rx: 0.0165, ry: 0.021 },
      { p: v3(0, -0.06, 0.0), rx: 0.0125, ry: 0.016 },
      { p: v3(0, 0.05, -0.004), rx: 0.0118, ry: 0.0155 },
      { p: v3(0, 0.18, 0.002), rx: 0.0112, ry: 0.0145 },
      { p: v3(0, 0.3, 0.006), rx: 0.0122, ry: 0.016 },
      { p: v3(0, 0.345, 0.006), rx: 0.0118, ry: 0.015 },
    ],
    22,
  );
  const wb = new MeshBuilder().add(loft(haft, 12, { up: v3(0, 0, -1) }), { color: woodColor(0xa7764a, 0x5e3b22, 'y') });
  g.add(mesh(wb.build(false), M.wood));

  // Leather grip wrap: a helix of flat bands.
  const lb = new MeshBuilder();
  for (let i = 0; i < 9; i++) {
    const y = -0.07 + i * 0.016;
    const t = new THREE.TorusGeometry(0.0158, 0.0034, 5, 16);
    t.rotateX(Math.PI / 2 + 0.22);
    t.scale(1, 1, 1.28);
    t.translate(0, y, -0.001);
    lb.add(t, { color: (p) => _c.set(0x3e2718).offsetHSL(0, 0, mottle(p, 90) * 0.04) });
  }
  g.add(mesh(lb.build(false), M.leather));

  // Steel head: extruded bearded profile, thickness tapered toward the edge. Blade faces -Z.
  const s = new THREE.Shape();
  const P: [number, number][] = [
    [-0.034, 0.024],
    [-0.038, -0.018],
    [-0.022, -0.028],
    [0.02, -0.027],
    [0.048, -0.036],
    [0.078, -0.06],
    [0.105, -0.07],
    [0.117, -0.05],
    [0.122, -0.015],
    [0.121, 0.015],
    [0.114, 0.038],
    [0.1, 0.044],
    [0.07, 0.032],
    [0.03, 0.028],
    [-0.02, 0.03],
  ];
  s.moveTo(P[0][0], P[0][1]);
  for (let i = 1; i < P.length; i++) s.lineTo(P[i][0], P[i][1]);
  s.closePath();
  const head = new THREE.ExtrudeGeometry(s, { depth: 0.024, bevelEnabled: true, bevelThickness: 0.003, bevelSize: 0.0025, bevelSegments: 2, curveSegments: 4 });
  head.translate(0, 0, -0.012);
  // Taper the cheeks toward the bit.
  const pa = head.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pa.count; i++) {
    const u = pa.getX(i);
    const k = 1 - ss(0.02, 0.118, u) * 0.86;
    pa.setZ(i, pa.getZ(i) * k);
  }
  head.computeVertexNormals();
  // Profile x -> -Z (forward), extrusion z -> X (thickness), y stays.
  head.applyMatrix4(new THREE.Matrix4().makeBasis(v3(0, 0, -1), v3(0, 1, 0), v3(1, 0, 0)));
  head.translate(0, 0.305, 0.004);
  const steelDark = col(0x33373d),
    steelMid = col(0x5c626a),
    edge = col(0xf2f4f6),
    bevel = col(0x9aa1a9);
  const hb = new MeshBuilder().add(head, {
    color: (p, n) => {
      const u = -(p.z - 0.004); // forward distance from the haft
      _c.copy(steelDark).lerp(steelMid, ss(0.3, 0.95, Math.abs(n.x)) * 0.5);
      // Blackened forge scale around the eye, a ground bevel, then the polished edge.
      _c.lerp(col(0x24262a), ss(0.01, -0.03, u) * 0.8);
      _c.lerp(bevel, ss(0.07, 0.085, u) * 0.8);
      _c.lerp(edge, ss(0.1, 0.112, u));
      return _c.offsetHSL(0, 0, mottle(p, 140) * 0.04);
    },
  });
  g.add(mesh(hb.build(false), M.steel));
  // Wedge at the top of the eye.
  const wedge = new MeshBuilder().add(new THREE.BoxGeometry(0.006, 0.006, 0.03).translate(0, 0.348, 0.003), { color: col(0x5a3a22) });
  g.add(mesh(wedge.build(false), M.wood));
  return g;
}

// =============================================================================== SPEAR
/** Spear: tip at the origin pointing +Z, shaft extending to z = -1.8. */
export function buildSpear(M: WeaponMaterials): THREE.Group {
  const g = new THREE.Group();
  g.name = 'spear';
  const L = 1.8;
  const shaft: LoftRing[] = smoothRings(
    [
      { p: v3(0, 0, -0.13), rx: 0.0125, ry: 0.0125 },
      { p: v3(0, 0, -0.4), rx: 0.0155, ry: 0.0155 },
      { p: v3(0.002, 0, -1.0), rx: 0.0172, ry: 0.0172 },
      { p: v3(0, 0.001, -1.5), rx: 0.0165, ry: 0.0165 },
      { p: v3(0, 0, -L), rx: 0.0135, ry: 0.0135 },
    ],
    20,
  );
  const wb = new MeshBuilder().add(loft(shaft, 9), { color: woodColor(0xa07c55, 0x5c3f27, 'z') });
  g.add(mesh(wb.build(false), M.wood, true));

  // Knapped flint point: leaf-shaped, faceted, slightly irregular.
  const tip: LoftRing[] = [
    { p: v3(0, 0, -0.19), rx: 0.012, ry: 0.007 },
    { p: v3(0, 0, -0.165), rx: 0.026, ry: 0.011 },
    { p: v3(0, 0, -0.115), rx: 0.035, ry: 0.0125 },
    { p: v3(0, 0, -0.06), rx: 0.029, ry: 0.0105 },
    { p: v3(0, 0, -0.018), rx: 0.013, ry: 0.006 },
    { p: v3(0, 0, 0.0), rx: 0.002, ry: 0.0015 },
  ];
  const tg = loft(tip, 6);
  const tp = tg.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < tp.count; i++) {
    const z = tp.getZ(i);
    const j = Math.sin(i * 12.9898) * 0.0022 * ss(-0.005, -0.04, z);
    tp.setX(i, tp.getX(i) + j);
  }
  const fb = new MeshBuilder().add(tg, { flat: true, color: (p) => _c.set(0x464b56).lerp(col(0x6f7482), 0.5 + 0.5 * Math.sin(p.x * 400 + p.z * 300)).offsetHSL(0, 0, mottle(p, 200) * 0.05) });
  g.add(mesh(fb.build(false), M.flint, true));

  // Cord lashing over the socket.
  const cb = new MeshBuilder();
  for (let i = 0; i < 8; i++) {
    const z = -0.182 - i * 0.009;
    const t = new THREE.TorusGeometry(0.0142, 0.0028, 5, 14);
    t.rotateY(0.25 * (i % 2 ? 1 : -1));
    t.translate(0, 0, z);
    cb.add(t, { color: (p) => _c.set(0xbfa37a).offsetHSL(0, 0, mottle(p, 120) * 0.05) });
  }
  // Leather thong hanging from the lashing, with a grey-and-white feather tied on.
  const thong = loft(
    [
      { p: v3(0.013, -0.006, -0.245), rx: 0.0025, ry: 0.0025 },
      { p: v3(0.02, -0.035, -0.26), rx: 0.0022, ry: 0.0022 },
      { p: v3(0.022, -0.07, -0.275), rx: 0.002, ry: 0.002 },
    ],
    4,
  );
  cb.add(thong, { color: col(0x3b2616) });
  g.add(mesh(cb.build(false), M.leather, true));
  const feat = new MeshBuilder();
  const vane = new THREE.BufferGeometry();
  vane.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0.012, -0.03, 0, 0, -0.085, 0, 0.012, -0.03, 0, 0.008, -0.07, 0, 0, -0.085, 0, 0, 0, 0, 0, -0.085, 0, -0.01, -0.035, 0, -0.01, -0.035, 0, 0, -0.085, 0, -0.006, -0.07, 0], 3));
  vane.computeVertexNormals();
  vane.rotateY(0.6);
  vane.translate(0.022, -0.07, -0.275);
  feat.add(vane, { color: (p) => _c.set(0xe8e4dc).lerp(col(0x3a3a3e), ss(-0.13, -0.155, p.y)) });
  g.add(mesh(feat.build(false), M.feather, true));
  return g;
}

// =============================================================================== ARROW
/** Arrow: tip at the origin pointing +Z, nock at z = -0.74. */
export function buildArrow(M: WeaponMaterials): THREE.Group {
  const g = new THREE.Group();
  g.name = 'arrow';
  const L = 0.74;
  const shaft = new MeshBuilder().add(
    loft([
      { p: v3(0, 0, -0.03), rx: 0.0042, ry: 0.0042 },
      { p: v3(0, 0, -L + 0.01), rx: 0.0045, ry: 0.0045 },
    ], 6),
    { color: (p) => _c.set(0xd9c7a0).lerp(col(0x2b2320), ss(-L + 0.03, -L + 0.012, p.z)) },
  );
  g.add(mesh(shaft.build(false), M.wood, true));
  const tip = loft([
    { p: v3(0, 0, -0.04), rx: 0.0055, ry: 0.003 },
    { p: v3(0, 0, -0.025), rx: 0.0095, ry: 0.0035 },
    { p: v3(0, 0, 0), rx: 0.0008, ry: 0.0006 },
  ], 5);
  g.add(mesh(new MeshBuilder().add(tip, { flat: true, color: col(0x4b505a) }).build(false), M.flint, true));
  // Three fletching vanes, one red cock feather.
  const fb = new MeshBuilder();
  for (let k = 0; k < 3; k++) {
    const vane = new THREE.BufferGeometry();
    const z0 = -L + 0.035,
      z1 = -L + 0.13;
    vane.setAttribute('position', new THREE.Float32BufferAttribute([0.004, 0, z0, 0.016, 0, z0 + 0.012, 0.004, 0, z1, 0.016, 0, z0 + 0.012, 0.009, 0, z1 - 0.02, 0.004, 0, z1], 3));
    vane.computeVertexNormals();
    vane.rotateZ((k / 3) * Math.PI * 2 + Math.PI / 2);
    fb.add(vane, { color: k === 0 ? col(0xa8332a) : col(0xe6e0d4) });
  }
  g.add(mesh(fb.build(false), M.feather));
  return g;
}

// =============================================================================== BOW
export interface BowRig {
  root: THREE.Group;
  upper: THREE.Group;
  lower: THREE.Group;
  stringTop: THREE.Mesh;
  stringBot: THREE.Mesh;
  arrow: THREE.Group;
  /** Tip positions in bow space at rest (upper). */
  tipY: number;
  tipZ: number;
  /** Set draw 0..1 and update string/limbs. `vib` adds a vibration offset for the release. */
  setDraw(draw: number, vib: number, showArrow: boolean): void;
  /** Current nock z (bow space). */
  nockZ(): number;
}

/** Recurve bow held vertically, grip at the origin, archer toward +Z, arrow flies toward -Z. */
export function buildBow(M: WeaponMaterials): BowRig {
  const root = new THREE.Group();
  root.name = 'bow';
  const limbRings = (sign: 1 | -1): LoftRing[] => {
    const pts: [number, number, number, number][] = [
      // y, z, width, thickness
      [0.08, 0.004, 0.034, 0.02],
      [0.18, 0.018, 0.034, 0.016],
      [0.3, 0.05, 0.03, 0.013],
      [0.42, 0.098, 0.024, 0.011],
      [0.52, 0.142, 0.019, 0.009],
      [0.585, 0.162, 0.015, 0.008],
      [0.62, 0.155, 0.012, 0.0075],
      [0.64, 0.135, 0.009, 0.007],
    ];
    return smoothRings(
      pts.map(([y, z, w, t]) => ({ p: v3(0, y * sign, z), rx: w / 2, ry: t / 2 })),
      20,
    );
  };
  const woodC = woodColor(0x8c5a34, 0x5a3520, 'y');
  const mkLimb = (sign: 1 | -1) => {
    const grp = new THREE.Group();
    // Limb pivots at the end of the riser so it can flex.
    const pivot = v3(0, 0.1 * sign, 0.006);
    grp.position.copy(pivot);
    const mb = new MeshBuilder().add(loft(limbRings(sign), 8, { up: v3(0, 0, 1) }), {
      color: (p) => woodC(p).lerp(col(0xe8dcc4), ss(0.6, 0.64, Math.abs(p.y)) * 0.8),
    });
    const geo = mb.build(false);
    geo.translate(-pivot.x, -pivot.y, -pivot.z);
    grp.add(mesh(geo, M.wood));
    return grp;
  };
  const upper = mkLimb(1),
    lower = mkLimb(-1);
  root.add(upper, lower);
  // Riser + leather grip.
  const riser = smoothRings(
    [
      { p: v3(0, -0.13, 0.0), rx: 0.017, ry: 0.012 },
      { p: v3(0, -0.06, -0.004), rx: 0.019, ry: 0.024 },
      { p: v3(0, 0.0, -0.006), rx: 0.02, ry: 0.027 },
      { p: v3(0, 0.06, -0.004), rx: 0.019, ry: 0.024 },
      { p: v3(0, 0.13, 0.0), rx: 0.017, ry: 0.012 },
    ],
    12,
  );
  root.add(mesh(new MeshBuilder().add(loft(riser, 10, { up: v3(0, 0, 1) }), { color: woodC }).build(false), M.wood));
  const lb = new MeshBuilder();
  for (let i = 0; i < 7; i++) {
    const t = new THREE.TorusGeometry(0.0215, 0.0036, 5, 14);
    t.rotateX(Math.PI / 2 + 0.25);
    t.scale(1, 1, 1.25);
    t.translate(0, -0.05 + i * 0.016, -0.006);
    lb.add(t, { color: (p) => _c.set(0x4a2e1c).offsetHSL(0, 0, mottle(p, 90) * 0.04) });
  }
  root.add(mesh(lb.build(false), M.leather));
  // String: two thin cylinders re-aimed every frame.
  const sg = new THREE.CylinderGeometry(0.0017, 0.0017, 1, 4, 1);
  sg.translate(0, 0.5, 0);
  const stringTop = new THREE.Mesh(sg, M.string);
  const stringBot = new THREE.Mesh(sg, M.string);
  root.add(stringTop, stringBot);
  const arrow = buildArrow(M);
  arrow.rotation.y = Math.PI; // point toward -Z
  root.add(arrow);

  const tipY = 0.6,
    tipZ = 0.158;
  const top = new THREE.Vector3(),
    bot = new THREE.Vector3(),
    nock = new THREE.Vector3(),
    tmp = new THREE.Vector3();
  const aim = (m: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3) => {
    tmp.subVectors(b, a);
    const len = tmp.length();
    m.position.copy(a);
    m.scale.set(1, len, 1);
    m.quaternion.setFromUnitVectors(UPV, tmp.divideScalar(len));
  };
  const rig: BowRig = {
    root,
    upper,
    lower,
    stringTop,
    stringBot,
    arrow,
    tipY,
    tipZ,
    setDraw(draw: number, vib: number, showArrow: boolean) {
      const flex = draw * 0.2 + vib * 0.05;
      upper.rotation.x = flex;
      lower.rotation.x = -flex;
      // Tip positions follow the limb rotation about their pivots.
      const ty = tipY - 0.1,
        tz = tipZ - 0.006;
      const c = Math.cos(flex),
        s = Math.sin(flex);
      top.set(0, 0.1 + ty * c - tz * s, 0.006 + ty * s + tz * c);
      bot.set(0, -top.y, top.z);
      nock.set(0, 0, top.z + draw * MAX_DRAW + vib * 0.03);
      aim(stringTop, nock, top);
      aim(stringBot, nock, bot);
      arrow.visible = showArrow;
      // Arrow rests on the shelf (just left of the riser) with its nock on the string.
      arrow.position.set(-0.012, 0.004, nock.z - 0.74);
    },
    nockZ() {
      return nock.z;
    },
  };
  rig.setDraw(0, 0, true);
  return rig;
}
const UPV = new THREE.Vector3(0, 1, 0);
/** Draw length (m of string travel) at full draw: kept short so the nock stays in front of the eye. */
const MAX_DRAW = 0.27;

// =============================================================================== TORCH
export interface TorchModel {
  root: THREE.Group;
  /** Local position of the flame base. */
  flameAnchor: THREE.Object3D;
  /** Emissive ember cap (glow driven by the flame flicker). */
  emberMat: THREE.MeshStandardMaterial;
}

export function buildTorch(M: WeaponMaterials): TorchModel {
  const root = new THREE.Group();
  root.name = 'torch';
  const stick = smoothRings(
    [
      { p: v3(0, -0.2, 0), rx: 0.014, ry: 0.014 },
      { p: v3(0.002, 0.05, 0), rx: 0.017, ry: 0.016 },
      { p: v3(0, 0.3, 0.002), rx: 0.019, ry: 0.019 },
    ],
    10,
  );
  root.add(mesh(new MeshBuilder().add(loft(stick, 9), { color: woodColor(0x8d6a48, 0x5b412b, 'y') }).build(false), M.wood));
  // Cloth-wrapped head: a lumpy wad with a few wound strips, charred toward the top.
  const clothMat = M.cloth;
  const prof: THREE.Vector2[] = [];
  const P: [number, number][] = [
    [0.019, 0.235],
    [0.03, 0.25],
    [0.039, 0.275],
    [0.043, 0.31],
    [0.042, 0.35],
    [0.038, 0.38],
    [0.03, 0.4],
    [0.014, 0.412],
    [0.0, 0.415],
  ];
  for (const [r, y] of P) prof.push(new THREE.Vector2(r, y));
  const wad = new THREE.LatheGeometry(prof, 14);
  const wp = wad.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < wp.count; i++) {
    const x = wp.getX(i),
      y = wp.getY(i),
      z = wp.getZ(i);
    const a = Math.atan2(z, x);
    const k = 1 + Math.sin(a * 3 + y * 60) * 0.07 + Math.sin(a * 7 - y * 110) * 0.04;
    wp.setXYZ(i, x * k, y, z * k);
  }
  wad.computeVertexNormals();
  const clothCol = (p: THREE.Vector3) => {
    const burnt = ss(0.3, 0.405, p.y);
    return _c.set(0xa58f6c).lerp(col(0x6b5840), 0.35 + 0.35 * Math.sin(p.y * 180 + Math.atan2(p.z, p.x) * 2)).lerp(col(0x17120f), burnt).offsetHSL(0, 0, mottle(p, 120) * 0.05);
  };
  const hb = new MeshBuilder().add(wad, { color: clothCol });
  for (let i = 0; i < 5; i++) {
    const y = 0.25 + i * 0.03;
    const r = 0.04 - Math.abs(i - 2) * 0.003;
    const t = new THREE.TorusGeometry(r, 0.0055, 5, 18);
    t.rotateX(Math.PI / 2 + 0.3 * (i % 2 ? 1 : -1));
    t.translate(0, y, 0);
    hb.add(t, { color: clothCol });
  }
  root.add(mesh(hb.build(false), clothMat));
  // Glowing embers where the flame eats the cloth.
  const emberMat = new THREE.MeshStandardMaterial({ color: 0x140a06, roughness: 1, emissive: 0xff4a10, emissiveIntensity: 1 });
  const cap = new THREE.SphereGeometry(0.033, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  cap.scale(1, 0.55, 1);
  cap.translate(0, 0.395, 0);
  root.add(mesh(cap, emberMat));
  const flameAnchor = new THREE.Object3D();
  flameAnchor.position.set(0, 0.4, 0);
  root.add(flameAnchor);
  return { root, flameAnchor, emberMat };
}
