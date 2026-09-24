// Third-person skier/survivor, built procedurally: a shaped, quilted puffer jacket with collar,
// hem and zip; a hood with a fur ruff, goggles and a face; two-segment arms with elbows, cuffs and
// mittens holding ski poles; insulated pants. Fabric uses MeshPhysicalMaterial sheen (the soft,
// view-dependent glow real nylon and fleece have). Every visible part starts on the shadow-only
// material (first person) and is swapped to its real material by Body.setThirdPerson().
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
  pole: THREE.Group; // held in the mitten; rotation.x tilts it
}

export interface Avatar {
  torso: THREE.Mesh;
  head: THREE.Mesh;
  armL: AvatarArm;
  armR: AvatarArm;
  parts: TpPart[];
  /** Shared leg geometry (origin at the joint, 1 m along +Y; Body scales/orients them). */
  thighGeo: THREE.BufferGeometry;
  shinGeo: THREE.BufferGeometry;
  kneeGeo: THREE.BufferGeometry;
  pantsMat: THREE.Material;
}

const fabric = (color: number, roughness: number, sheen = 0.6) =>
  new THREE.MeshPhysicalMaterial({ color, roughness, metalness: 0, sheen, sheenRoughness: 0.55, sheenColor: new THREE.Color(0.55, 0.6, 0.7) });

// Jacket silhouette (radius, height) from the hem up to the neck, in torso-local metres.
const JACKET: [number, number][] = [
  [0.001, -0.43],
  [0.165, -0.43],
  [0.178, -0.4],
  [0.172, -0.3],
  [0.158, -0.16],
  [0.162, -0.02],
  [0.182, 0.1],
  [0.196, 0.2],
  [0.19, 0.27],
  [0.16, 0.32],
  [0.11, 0.355],
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

  const jacket = fabric(PALETTE.jacket, 0.72, 0.7);
  const jacketDark = fabric(PALETTE.jacketShade, 0.8, 0.5);
  const pants = fabric(0x22252b, 0.86, 0.45);
  const fur = new THREE.MeshPhysicalMaterial({ color: 0x5a5249, roughness: 1, sheen: 0.8, sheenRoughness: 0.9, sheenColor: new THREE.Color(0.7, 0.66, 0.6) });
  const skin = new THREE.MeshStandardMaterial({ color: 0xc9967a, roughness: 0.62 });
  const lens = new THREE.MeshPhysicalMaterial({ color: 0x2a1a10, roughness: 0.08, metalness: 0.7, clearcoat: 1, clearcoatRoughness: 0.05 });
  const strap = new THREE.MeshStandardMaterial({ color: 0x151619, roughness: 0.7 });
  const zip = new THREE.MeshStandardMaterial({ color: 0xb9bfc7, roughness: 0.35, metalness: 0.7 });
  const hoodMat = jacket.clone();
  hoodMat.side = THREE.DoubleSide;

  // ---- torso: lathed puffer jacket, quilting baffles, hem, collar, zip
  // The elliptical chest cross-section is baked into the geometry (not the node's scale) so the
  // arms parented to the torso don't get sheared.
  const ring = (r: number, tube: number, y: number) => {
    const g = new THREE.TorusGeometry(r, tube, 8, 44);
    g.rotateX(Math.PI / 2);
    g.scale(JX, 1, JZ);
    g.translate(0, y, 0);
    return g;
  };
  const torsoGeo = new THREE.LatheGeometry(JACKET.map(([r, y]) => new THREE.Vector2(r, y * SY)), 36);
  torsoGeo.scale(JX, 1, JZ);
  const torso = add(new THREE.Mesh(torsoGeo, m.shadowOnly), jacket);
  torso.name = 'torso';
  for (const y of [-0.26, -0.1, 0.05, 0.19]) torso.add(add(new THREE.Mesh(ring(jacketRadiusAt(y) + 0.002, 0.0055, y * SY), m.shadowOnly), jacketDark));
  torso.add(add(new THREE.Mesh(ring(0.17, 0.016, -0.415 * SY), m.shadowOnly), jacketDark));
  const collarGeo = new THREE.CylinderGeometry(0.082, 0.1, 0.09, 22, 1, true);
  collarGeo.scale(1.05, 1, 0.95);
  const collar = add(new THREE.Mesh(collarGeo, m.shadowOnly), jacketDark);
  collar.position.y = 0.37 * SY + 0.04;
  torso.add(collar);
  const zipper = add(new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.7 * SY, 0.01), m.shadowOnly), zip);
  zipper.position.set(0, 0.0, -0.162 * JZ - 0.004);
  torso.add(zipper);

  // ---- head: face, hood with fur ruff, goggles (head is positioned by Body at the eye)
  const head = add(new THREE.Mesh(new THREE.SphereGeometry(0.105, 24, 18), m.shadowOnly), skin);
  head.name = 'head';
  head.scale.set(0.95, 1.12, 1.02);
  const hood = add(
    new THREE.Mesh(new THREE.SphereGeometry(0.132, 28, 18, Math.PI * 1.5 + 0.95, Math.PI * 2 - 1.9, 0, Math.PI * 0.8), m.shadowOnly),
    hoodMat,
  );
  hood.position.set(0, 0.012, 0.018);
  head.add(hood);
  const ruff = add(new THREE.Mesh(new THREE.TorusGeometry(0.096, 0.03, 10, 30), m.shadowOnly), fur);
  ruff.position.set(0, -0.006, -0.082);
  ruff.scale.set(1, 1.18, 0.9);
  head.add(ruff);
  const gStrap = add(new THREE.Mesh(new THREE.TorusGeometry(0.128, 0.008, 6, 32), m.shadowOnly), strap);
  gStrap.rotation.x = Math.PI / 2;
  gStrap.position.y = 0.028;
  head.add(gStrap);
  const goggles = add(new THREE.Mesh(new RoundedBoxGeometry(0.15, 0.052, 0.035, 3, 0.014), m.shadowOnly), lens);
  goggles.position.set(0, 0.03, -0.098);
  head.add(goggles);

  // ---- arms: shoulder puff -> upper arm -> elbow -> forearm, cuff, mitten -> pole
  const buildArm = (side: -1 | 1): AvatarArm => {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.205, 0.255 * SY, 0);
    const puff = add(new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), m.shadowOnly), jacket);
    pivot.add(puff);
    const upper = add(new THREE.Mesh(new THREE.CapsuleGeometry(0.058, 0.2, 6, 14), m.shadowOnly), jacket);
    upper.position.y = -0.14;
    pivot.add(upper);
    const elbow = new THREE.Group();
    elbow.position.y = -0.28;
    pivot.add(elbow);
    const fore = add(new THREE.Mesh(new THREE.CapsuleGeometry(0.052, 0.19, 6, 14), m.shadowOnly), jacket);
    fore.position.y = -0.12;
    elbow.add(fore);
    const cuff = add(new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.011, 8, 20), m.shadowOnly), jacketDark);
    cuff.rotation.x = Math.PI / 2;
    cuff.position.y = -0.235;
    elbow.add(cuff);
    const mitten = add(new THREE.Mesh(new RoundedBoxGeometry(0.078, 0.105, 0.088, 4, 0.034), m.shadowOnly), m.mitten);
    mitten.position.y = -0.3;
    elbow.add(mitten);
    const thumb = add(new THREE.Mesh(new THREE.CapsuleGeometry(0.018, 0.04, 4, 8), m.shadowOnly), m.mitten);
    thumb.position.set(-side * 0.036, -0.29, -0.03);
    thumb.rotation.set(0.4, 0, side * 0.4);
    elbow.add(thumb);
    // Pole in the fist: grip above the hand, shaft running down along the pole's -Y.
    const pole = new THREE.Group();
    pole.position.y = -0.3;
    elbow.add(pole);
    const grip = add(new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.015, 0.13, 10), m.shadowOnly), m.poleGrip);
    grip.position.y = 0.01;
    pole.add(grip);
    const shaft = add(new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.007, 1.18, 8), m.shadowOnly), m.poleShaft);
    shaft.position.y = -0.62;
    pole.add(shaft);
    const basket = add(new THREE.Mesh(new THREE.TorusGeometry(0.042, 0.006, 6, 18), m.shadowOnly), m.poleGrip);
    basket.rotation.x = Math.PI / 2;
    basket.position.y = -1.08;
    pole.add(basket);
    return { pivot, elbow, pole };
  };
  const armL = buildArm(-1);
  const armR = buildArm(1);
  torso.add(armL.pivot, armR.pivot);

  // ---- legs: insulated pants (Body solves them as two-bone chains each frame)
  const thighGeo = new THREE.CylinderGeometry(0.1, 0.082, 1, 18, 1);
  thighGeo.translate(0, 0.5, 0);
  const shinGeo = new THREE.CylinderGeometry(0.08, 0.07, 1, 18, 1);
  shinGeo.translate(0, 0.5, 0);
  const kneeGeo = new THREE.SphereGeometry(0.078, 16, 12);

  return { torso, head, armL, armR, parts, thighGeo, shinGeo, kneeGeo, pantsMat: pants };
}
