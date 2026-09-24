// Third-person survivor, built procedurally: a quilted expedition shell (ripstop normal map, sheen),
// hood with a fur ruff, mirrored goggles, fleece neck gaiter and nose; two-segment arms ending in
// gloved fists (a `hand.item` socket carries whatever they hold); insulated pants with gaiters; and a
// real hiking pack — canvas body, hinged lid that opens when you reach into it, front pocket, steel
// bottle, strapped foam pad, shoulder straps, sternum strap and hip belt. Fabric gathers snow on
// upward-facing surfaces while it snows (shared `snowCover` uniform). Every visible part starts on the
// shadow-only material (first person) and Body.setThirdPerson() swaps the real one in.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { GearMaterials } from './Gear';
import { PALETTE } from './Gear';

export interface TpPart {
  mesh: THREE.Mesh;
  mat: THREE.Material;
}

export interface AvatarArm {
  pivot: THREE.Group; // at the shoulder; rotation.x swings the arm (+ = forward)
  elbow: THREE.Group; // rotation.x bends the forearm (+ = forward)
  pole: THREE.Group; // held in the fist; rotation.x tilts it
  hand: THREE.Group; // fist centre; rotation.x turns the grip (wrist)
  item: THREE.Group; // socket in the fist: held tools/props go here (grip axis = local -Z)
}

export interface Avatar {
  torso: THREE.Mesh;
  head: THREE.Mesh;
  pelvis: THREE.Mesh;
  armL: AvatarArm;
  armR: AvatarArm;
  packLid: THREE.Group; // hinge; rotation.x > 0 opens the lid
  parts: TpPart[];
  /** Shared leg geometry (origin at the joint, 1 m along +Y; Body scales/orients them). */
  thighGeo: THREE.BufferGeometry;
  shinGeo: THREE.BufferGeometry;
  kneeGeo: THREE.BufferGeometry;
  gaiterGeo: THREE.BufferGeometry;
  pantsMat: THREE.Material;
  gaiterMat: THREE.Material;
}

/** 0..1 snow settled on the clothing (Body drives it from the weather). */
export const snowCover = { value: 0 };

// ------------------------------------------------------------------ procedural fabric normal maps
function normalFromHeight(size: number, h: (x: number, y: number) => number, strength: number): THREE.DataTexture {
  const hm = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) hm[y * size + x] = h(x, y);
  const data = new Uint8Array(size * size * 4);
  const at = (x: number, y: number) => hm[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const l = Math.hypot(dx, dy, 1);
      const o = (y * size + x) * 4;
      data[o] = ((-dx / l) * 0.5 + 0.5) * 255;
      data[o + 1] = ((-dy / l) * 0.5 + 0.5) * 255;
      data[o + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      data[o + 3] = 255;
    }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}
let rng = 12345;
const rand = () => ((rng = (rng * 16807) % 2147483647) / 2147483647);
function noiseGrid(size: number, cells: number) {
  const g = new Float32Array(cells * cells).map(() => rand());
  return (x: number, y: number) => {
    const fx = (x / size) * cells,
      fy = (y / size) * cells;
    const x0 = Math.floor(fx),
      y0 = Math.floor(fy);
    const tx = fx - x0,
      ty = fy - y0;
    const s = (a: number, b: number) => g[((b % cells) * cells + (a % cells)) % g.length];
    const sx = tx * tx * (3 - 2 * tx),
      sy = ty * ty * (3 - 2 * ty);
    return (s(x0, y0) * (1 - sx) + s(x0 + 1, y0) * sx) * (1 - sy) + (s(x0, y0 + 1) * (1 - sx) + s(x0 + 1, y0 + 1) * sx) * sy;
  };
}
let _ripstop: THREE.DataTexture | null = null;
let _canvas: THREE.DataTexture | null = null;
/** Ripstop nylon: fine plain weave with a raised reinforcement grid and soft crumples. */
function ripstop() {
  if (_ripstop) return _ripstop;
  const S = 256;
  const crumple = noiseGrid(S, 8);
  _ripstop = normalFromHeight(
    S,
    (x, y) => {
      const weave = Math.sin(x * Math.PI * 0.5) * Math.sin(y * Math.PI * 0.5) * 0.15;
      const grid = (x % 32 < 2 ? 0.6 : 0) + (y % 32 < 2 ? 0.6 : 0);
      return weave + grid * 0.5 + crumple(x, y) * 6;
    },
    1.4,
  );
  return _ripstop;
}
/** Heavy canvas / softshell: basket weave and slub. */
function canvasWeave() {
  if (_canvas) return _canvas;
  const S = 256;
  const slub = noiseGrid(S, 32);
  _canvas = normalFromHeight(
    S,
    (x, y) => {
      const u = Math.floor(x / 4),
        v = Math.floor(y / 4);
      const over = (u + v) % 2 === 0;
      const fx = (x % 4) / 4,
        fy = (y % 4) / 4;
      const bump = over ? Math.sin(fx * Math.PI) : Math.sin(fy * Math.PI);
      return bump * 0.8 + slub(x, y) * 1.2;
    },
    1.1,
  );
  return _canvas;
}

// ------------------------------------------------------------------ snow-gathering fabric
function snowy<T extends THREE.MeshStandardMaterial>(mat: T, amount = 1): T {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uSnowCover = snowCover;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uSnowCover;')
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          vec3 wN = normalize( ( vec4( normal, 0.0 ) * viewMatrix ).xyz );
          float grain = fract( sin( dot( floor( gl_FragCoord.xy * 0.5 ), vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
          float k = smoothstep( 0.25, 0.8, wN.y + grain * 0.18 - 0.09 ) * uSnowCover * ${amount.toFixed(2)};
          diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.92, 0.95, 1.0 ), k );
          roughnessFactor = mix( roughnessFactor, 0.85, k );
        }`,
      );
  };
  mat.customProgramCacheKey = () => 'fl-gear-snow-' + amount.toFixed(2);
  return mat;
}

const fabric = (color: number, roughness: number, sheen: number, normal: THREE.Texture | null, repeat: [number, number], nScale = 0.5) => {
  const m = new THREE.MeshPhysicalMaterial({ color, roughness, metalness: 0, sheen, sheenRoughness: 0.5, sheenColor: new THREE.Color(0.6, 0.62, 0.68) });
  if (normal) {
    const n = normal.clone();
    n.repeat.set(repeat[0], repeat[1]);
    n.needsUpdate = true;
    m.normalMap = n;
    m.normalScale.set(nScale, nScale);
  }
  return snowy(m);
};

// Jacket silhouette (radius, height) from the hem up to the neck, in torso-local metres.
const JACKET: [number, number][] = [
  [0.001, -0.43],
  [0.166, -0.43],
  [0.18, -0.4],
  [0.174, -0.3],
  [0.16, -0.16],
  [0.164, -0.02],
  [0.184, 0.1],
  [0.198, 0.2],
  [0.192, 0.27],
  [0.162, 0.32],
  [0.112, 0.355],
  [0.07, 0.37],
  [0.001, 0.37],
];
const JX = 1.15; // chest is wider than deep
const SY = 0.8; // jacket height scale (keeps shoulders ~25 cm under the eye)
const JZ = 0.8;

function jacketRadiusAt(y: number) {
  for (let i = 1; i < JACKET.length; i++) {
    const [r1, y1] = JACKET[i];
    const [r0, y0] = JACKET[i - 1];
    if (y <= y1 && y >= y0) return r0 + ((r1 - r0) * (y - y0)) / (y1 - y0 || 1);
  }
  return 0.16;
}

export function buildAvatar(m: GearMaterials): Avatar {
  const parts: TpPart[] = [];
  const add = <T extends THREE.Mesh>(mesh: T, mat: THREE.Material): T => {
    mesh.material = m.shadowOnly;
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    parts.push({ mesh, mat });
    return mesh;
  };
  const M = (geo: THREE.BufferGeometry, mat: THREE.Material) => add(new THREE.Mesh(geo, m.shadowOnly), mat);

  const rip = ripstop();
  const weave = canvasWeave();
  const jacket = fabric(PALETTE.jacket, 0.58, 0.55, rip, [5, 4], 0.45);
  const jacketDark = fabric(PALETTE.jacketShade, 0.7, 0.4, rip, [5, 4], 0.3);
  const pants = fabric(0x2a2d33, 0.82, 0.4, weave, [3, 6], 0.55);
  const gaiter = fabric(0x17181b, 0.55, 0.3, rip, [3, 3], 0.3);
  const fleece = fabric(0x3a3f47, 0.95, 0.9, weave, [4, 2], 0.8);
  const packCanvas = fabric(0x55563a, 0.9, 0.35, weave, [2, 3], 0.4);
  const packDark = fabric(0x393a28, 0.92, 0.3, weave, [2, 2], 0.35);
  const webbing = snowy(new THREE.MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.8 }), 0.6);
  const leather = snowy(new THREE.MeshStandardMaterial({ color: 0x5a3a24, roughness: 0.62 }), 0.5);
  const foam = snowy(new THREE.MeshStandardMaterial({ color: 0x2f6a8a, roughness: 0.95 }), 1);
  const steel = new THREE.MeshStandardMaterial({ color: 0xaab2bb, roughness: 0.28, metalness: 0.9 });
  const fur = new THREE.MeshPhysicalMaterial({ color: 0x6a6054, roughness: 1, sheen: 0.9, sheenRoughness: 0.9, sheenColor: new THREE.Color(0.75, 0.7, 0.62) });
  const skin = new THREE.MeshPhysicalMaterial({ color: 0xc28a6c, roughness: 0.55, sheen: 0.4, sheenRoughness: 0.6, sheenColor: new THREE.Color(0.9, 0.35, 0.3) });
  const lens = new THREE.MeshPhysicalMaterial({ color: 0xe0782a, roughness: 0.05, metalness: 0.85, clearcoat: 1, clearcoatRoughness: 0.03, iridescence: 0.6, iridescenceIOR: 1.6 });
  const frame = new THREE.MeshStandardMaterial({ color: 0x0f1012, roughness: 0.5 });
  const glove = snowy(new THREE.MeshPhysicalMaterial({ color: 0x3b2c22, roughness: 0.55, sheen: 0.3, sheenColor: new THREE.Color(0.5, 0.4, 0.3) }), 0.5);
  const zip = new THREE.MeshStandardMaterial({ color: 0x1a1b1d, roughness: 0.35, metalness: 0.4 });
  const hoodMat = jacket.clone();
  hoodMat.side = THREE.DoubleSide;

  // ---- torso: lathed shell, quilting baffles, hem, collar, zip, chest pockets, hip belt
  // The elliptical chest cross-section is baked into the geometry (not the node's scale) so the
  // arms parented to the torso don't get sheared.
  const ring = (r: number, tube: number, y: number, seg = 44) => {
    const g = new THREE.TorusGeometry(r, tube, 8, seg);
    g.rotateX(Math.PI / 2);
    g.scale(JX, 1, JZ);
    g.translate(0, y, 0);
    return g;
  };
  const torsoGeo = new THREE.LatheGeometry(JACKET.map(([r, y]) => new THREE.Vector2(r, y * SY)), 40);
  torsoGeo.scale(JX, 1, JZ);
  const torso = M(torsoGeo, jacket);
  torso.name = 'torso';
  for (const y of [-0.26, -0.12, 0.02, 0.15]) torso.add(M(ring(jacketRadiusAt(y) + 0.002, 0.006, y * SY), jacketDark));
  torso.add(M(ring(0.172, 0.017, -0.415 * SY), jacketDark));
  const collarGeo = new THREE.CylinderGeometry(0.084, 0.102, 0.1, 24, 1, true);
  collarGeo.scale(1.05, 1, 0.95);
  const collar = M(collarGeo, jacketDark);
  collar.position.y = 0.37 * SY + 0.045;
  torso.add(collar);
  const zipper = M(new THREE.BoxGeometry(0.014, 0.74 * SY, 0.01), zip);
  zipper.position.set(0, 0.0, -0.164 * JZ - 0.004);
  torso.add(zipper);
  for (const s of [-1, 1]) {
    const flap = M(new RoundedBoxGeometry(0.1, 0.035, 0.02, 2, 0.008), jacketDark);
    flap.position.set(s * 0.085, 0.13 * SY, -0.19 * JZ);
    flap.rotation.y = s * 0.28;
    torso.add(flap);
    const pocket = M(new RoundedBoxGeometry(0.1, 0.12, 0.02, 2, 0.01), jacket);
    pocket.position.set(s * 0.085, 0.07 * SY, -0.186 * JZ);
    pocket.rotation.set(-0.08, s * 0.28, 0);
    torso.add(pocket);
  }

  // ---- pelvis (Body places it at the hips): bridges the jacket hem and the legs
  const pelvisGeo = new THREE.CapsuleGeometry(0.1, 0.13, 6, 16);
  pelvisGeo.rotateZ(Math.PI / 2);
  pelvisGeo.scale(1, 1, 0.85);
  const pelvis = M(pelvisGeo, pants);
  pelvis.name = 'pelvis';

  // ---- head: face, nose, neck gaiter, hood with fur ruff, mirrored goggles
  const head = M(new THREE.SphereGeometry(0.105, 28, 20), skin);
  head.name = 'head';
  head.scale.set(0.95, 1.12, 1.02);
  const nose = M(new THREE.SphereGeometry(0.022, 10, 8), skin);
  nose.scale.set(0.8, 1.1, 1.1);
  nose.position.set(0, -0.012, -0.1);
  head.add(nose);
  // Gaiter: the lower half of the face, pulled up to just under the nose.
  const gaiterFace = M(new THREE.SphereGeometry(0.112, 26, 12, 0, Math.PI * 2, Math.PI * 0.56, Math.PI * 0.44), fleece);
  gaiterFace.scale.set(1.02, 1, 1.04);
  head.add(gaiterFace);
  const hood = M(new THREE.SphereGeometry(0.134, 30, 20, Math.PI * 1.5 + 0.95, Math.PI * 2 - 1.9, 0, Math.PI * 0.8), hoodMat);
  hood.position.set(0, 0.012, 0.018);
  head.add(hood);
  // Fur ruff: a torus of chunky tufts around the hood opening.
  const ruff = M(new THREE.TorusGeometry(0.098, 0.028, 10, 36), fur);
  ruff.position.set(0, -0.004, -0.084);
  ruff.scale.set(1, 1.2, 0.9);
  head.add(ruff);
  const tuftGeo = new THREE.ConeGeometry(0.014, 0.045, 5);
  for (let i = 0; i < 22; i++) {
    const a = (i / 22) * Math.PI * 2;
    const t = M(tuftGeo, fur);
    const r = 0.118;
    t.position.set(Math.cos(a) * r, Math.sin(a) * r * 1.2 - 0.004, -0.086);
    t.rotation.set(0, 0, a - Math.PI / 2 + (rand() - 0.5) * 0.5);
    ruff.parent!.add(t);
  }
  // Goggles: curved lens band with a frame and strap.
  const lensGeo = new THREE.CylinderGeometry(0.113, 0.113, 0.05, 28, 1, true, Math.PI - 1.05, 2.1);
  const goggle = M(lensGeo, lens);
  goggle.position.set(0, 0.03, 0.0);
  head.add(goggle);
  const frameGeo = new THREE.CylinderGeometry(0.111, 0.111, 0.062, 28, 1, true, Math.PI - 1.12, 2.24);
  const gFrame = M(frameGeo, frame);
  gFrame.position.set(0, 0.03, 0.001);
  gFrame.scale.set(1.01, 1, 1.01);
  head.add(gFrame);
  const gStrap = M(new THREE.TorusGeometry(0.132, 0.01, 6, 36), webbing);
  gStrap.rotation.x = Math.PI / 2;
  gStrap.position.y = 0.03;
  head.add(gStrap);

  // ---- arms: shoulder puff -> upper arm -> elbow -> forearm, cuff, gloved fist -> pole / item
  const fingerGeo = new THREE.CapsuleGeometry(0.0125, 0.03, 4, 8);
  const buildArm = (side: -1 | 1): AvatarArm => {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.205, 0.255 * SY, 0);
    pivot.add(M(new THREE.SphereGeometry(0.072, 18, 12), jacket));
    const upper = M(new THREE.CapsuleGeometry(0.06, 0.2, 6, 16), jacket);
    upper.position.y = -0.14;
    pivot.add(upper);
    const baffle = M(new THREE.TorusGeometry(0.061, 0.005, 6, 20), jacketDark);
    baffle.rotation.x = Math.PI / 2;
    baffle.position.y = -0.13;
    pivot.add(baffle);
    const elbow = new THREE.Group();
    elbow.position.y = -0.28;
    pivot.add(elbow);
    elbow.add(M(new THREE.SphereGeometry(0.056, 14, 10), jacket));
    const fore = M(new THREE.CapsuleGeometry(0.053, 0.19, 6, 16), jacket);
    fore.position.y = -0.12;
    elbow.add(fore);
    const cuff = M(new THREE.CylinderGeometry(0.052, 0.056, 0.05, 18), gaiter);
    cuff.position.y = -0.235;
    elbow.add(cuff);
    // Fist (grip axis = local Z): palm, four curled fingers, thumb over them, gauntlet.
    const hand = new THREE.Group();
    hand.position.y = -0.3;
    elbow.add(hand);
    const palm = M(new RoundedBoxGeometry(0.07, 0.085, 0.085, 3, 0.026), glove);
    palm.position.set(side * 0.012, 0.012, 0);
    hand.add(palm);
    for (let f = 0; f < 4; f++) {
      const fg = M(fingerGeo, glove);
      fg.rotation.x = Math.PI / 2;
      fg.position.set(-side * 0.022, -0.012, -0.031 + f * 0.021);
      hand.add(fg);
    }
    const thumb = M(new THREE.CapsuleGeometry(0.014, 0.036, 4, 8), glove);
    thumb.position.set(-side * 0.008, 0.012, -0.046);
    thumb.rotation.set(0.3, 0, side * 1.1);
    hand.add(thumb);
    const gauntlet = M(new THREE.CylinderGeometry(0.058, 0.05, 0.07, 16, 1, true), glove);
    gauntlet.position.y = 0.06;
    hand.add(gauntlet);
    const item = new THREE.Group();
    item.name = 'hand-item';
    hand.add(item);
    // Pole in the fist: grip above the hand, shaft running down along the pole's -Y.
    const pole = new THREE.Group();
    pole.position.y = -0.3;
    elbow.add(pole);
    const grip = M(new THREE.CylinderGeometry(0.018, 0.015, 0.13, 12), m.poleGrip);
    grip.position.y = 0.01;
    pole.add(grip);
    const shaft = M(new THREE.CylinderGeometry(0.009, 0.007, 1.18, 8), m.poleShaft);
    shaft.position.y = -0.62;
    pole.add(shaft);
    const basket = M(new THREE.TorusGeometry(0.042, 0.006, 6, 18), m.poleGrip);
    basket.rotation.x = Math.PI / 2;
    basket.position.y = -1.08;
    pole.add(basket);
    return { pivot, elbow, pole, hand, item };
  };
  const armL = buildArm(-1);
  const armR = buildArm(1);
  torso.add(armL.pivot, armR.pivot);

  // ---- pack: rides on the back (torso local +Z is behind you)
  const pack = new THREE.Group();
  pack.name = 'pack';
  pack.position.set(0, 0.0, 0.245);
  pack.rotation.x = -0.06;
  torso.add(pack);
  const bodyP = M(new RoundedBoxGeometry(0.3, 0.5, 0.2, 4, 0.06), packCanvas);
  pack.add(bodyP);
  const front = M(new RoundedBoxGeometry(0.22, 0.2, 0.06, 3, 0.025), packDark);
  front.position.set(0, -0.1, 0.11);
  pack.add(front);
  const pZip = M(new THREE.BoxGeometry(0.2, 0.008, 0.008), zip);
  pZip.position.set(0, -0.02, 0.142);
  pack.add(pZip);
  for (const s of [-1, 1]) {
    // compression straps + side pockets
    for (const y of [-0.12, 0.08]) {
      const st = M(new THREE.BoxGeometry(0.012, 0.03, 0.2), webbing);
      st.position.set(s * 0.153, y, 0);
      pack.add(st);
    }
    const side = M(new RoundedBoxGeometry(0.05, 0.16, 0.12, 2, 0.02), packDark);
    side.position.set(s * 0.16, -0.16, 0.0);
    pack.add(side);
  }
  const bottle = M(new THREE.CylinderGeometry(0.034, 0.034, 0.2, 16), steel);
  bottle.position.set(0.175, -0.1, 0.0);
  pack.add(bottle);
  const cap = M(new THREE.CylinderGeometry(0.02, 0.024, 0.03, 12), webbing);
  cap.position.set(0.175, 0.015, 0.0);
  pack.add(cap);
  const pad = M(new THREE.CylinderGeometry(0.075, 0.075, 0.36, 20), foam);
  pad.rotation.z = Math.PI / 2;
  pad.position.set(0, -0.31, 0.02);
  pack.add(pad);
  for (const s of [-1, 1]) {
    const ps = M(new THREE.TorusGeometry(0.078, 0.007, 6, 20), webbing);
    ps.rotation.y = Math.PI / 2;
    ps.position.set(s * 0.11, -0.31, 0.02);
    pack.add(ps);
  }
  // Lid on a hinge at the back-top edge; Body opens it when a hand goes in.
  const packLid = new THREE.Group();
  packLid.position.set(0, 0.235, 0.1);
  pack.add(packLid);
  const lid = M(new RoundedBoxGeometry(0.31, 0.08, 0.23, 3, 0.035), packDark);
  lid.position.set(0, 0.03, -0.1);
  packLid.add(lid);
  const lidStrap = M(new THREE.BoxGeometry(0.03, 0.012, 0.25), webbing);
  lidStrap.position.set(0.07, 0.068, -0.1);
  packLid.add(lidStrap);
  const lidStrap2 = lidStrap.clone();
  parts.push({ mesh: lidStrap2, mat: webbing });
  lidStrap2.position.x = -0.07;
  packLid.add(lidStrap2);
  // Inside of the pack, seen when the lid lifts.
  const inner = M(new THREE.BoxGeometry(0.24, 0.02, 0.15), new THREE.MeshStandardMaterial({ color: 0x14140e, roughness: 1 }));
  inner.position.set(0, 0.245, 0);
  pack.add(inner);

  // Shoulder straps over the shoulders and down the chest (torso space), sternum strap, hip belt.
  for (const s of [-1, 1]) {
    const x = s * 0.1;
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(x, 0.2, 0.2),
      new THREE.Vector3(x * 1.05, 0.29, 0.08),
      new THREE.Vector3(x * 1.1, 0.305, -0.03),
      new THREE.Vector3(x * 1.1, 0.24, -0.15),
      new THREE.Vector3(x * 1.05, 0.1, -0.172),
      new THREE.Vector3(x, -0.08, -0.155),
      new THREE.Vector3(x * 1.3, -0.2, -0.13),
    ]);
    const strapGeo = new THREE.TubeGeometry(curve, 24, 0.018, 6, false);
    strapGeo.scale(1, 1, 1);
    const strap = M(strapGeo, packDark);
    strap.scale.set(1, 1, 1);
    torso.add(strap);
  }
  const sternum = M(new THREE.BoxGeometry(0.2, 0.014, 0.012), webbing);
  sternum.position.set(0, 0.15, -0.178);
  torso.add(sternum);
  const sBuckle = M(new RoundedBoxGeometry(0.035, 0.022, 0.012, 2, 0.004), webbing);
  sBuckle.position.set(0, 0.15, -0.186);
  torso.add(sBuckle);
  const belt = M(ring(jacketRadiusAt(-0.37) + 0.016, 0.022, -0.3, 40), packDark);
  torso.add(belt);
  const bBuckle = M(new RoundedBoxGeometry(0.05, 0.035, 0.016, 2, 0.006), webbing);
  bBuckle.position.set(0, -0.3, -0.172 * JZ - 0.02);
  torso.add(bBuckle);
  // Belt knife sheath on the hip.
  const sheath = M(new RoundedBoxGeometry(0.035, 0.16, 0.02, 2, 0.01), leather);
  sheath.position.set(0.2, -0.36, -0.02);
  sheath.rotation.z = 0.2;
  torso.add(sheath);

  // ---- legs: insulated pants with gaiters (Body solves them as two-bone chains each frame)
  const thighGeo = new THREE.CylinderGeometry(0.105, 0.084, 1, 20, 1);
  thighGeo.translate(0, 0.5, 0);
  const shinGeo = new THREE.CylinderGeometry(0.082, 0.07, 1, 20, 1);
  shinGeo.translate(0, 0.5, 0);
  const kneeGeo = new THREE.SphereGeometry(0.08, 16, 12);
  // Gaiter over the lower shin (shin space: 0..1 along the leg, from the ankle up).
  const gaiterGeo = new THREE.CylinderGeometry(0.08, 0.086, 0.5, 20, 1);
  gaiterGeo.translate(0, 0.25, 0);

  return { torso, head, pelvis, armL, armR, packLid, parts, thighGeo, shinGeo, kneeGeo, gaiterGeo, pantsMat: pants, gaiterMat: gaiter };
}
