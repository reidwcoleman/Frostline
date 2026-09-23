// Dev-only studio for iterating on animal + weapon models without booting the whole game.
// http://127.0.0.1:5317/src/wildlife/dev/viewer.html?view=animals&gait=trot&phase=0.3&az=90&el=8&dist=9
import * as THREE from 'three';
import { buildWolf, buildDeer, buildHare } from '../models';
import { buildPtarmigan, buildRaven, BIRD_PARENT } from '../Birds';
import { QuadRig, type GaitParams } from '../QuadRig';
import { WOLF_GAIT, DEER_GAIT, HARE_GAIT } from '../species';
import { createAnimalMaterial } from '../material';
import { makeBones } from '../skeleton';
import type { Terrain } from '../../core/Terrain';
import { buildArrow, buildBow, buildHatchet, buildSpear, buildTorch, createWeaponMaterials } from '../../combat/models';

const P = new URLSearchParams(location.search);
const num = (k: string, d: number) => (P.has(k) ? Number(P.get(k)) : d);
const view = P.get('view') ?? 'animals';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.setSize(innerWidth, innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = num('exp', 1.0);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const night = P.get('night') === '1';
const scene = new THREE.Scene();
scene.background = new THREE.Color(night ? 0x0b1424 : 0xa9c2dc);
scene.fog = new THREE.Fog(scene.background as THREE.Color, 30, 160);
const camera = new THREE.PerspectiveCamera(num('fov', 40), innerWidth / innerHeight, 0.05, 500);

const sun = new THREE.DirectionalLight(night ? 0x8fa6d8 : 0xfff1dc, night ? 0.35 : 3.0);
sun.position.set(-6, 10, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.left = sc.bottom = -12;
sc.right = sc.top = 12;
sun.shadow.bias = -0.0004;
scene.add(sun);
scene.add(new THREE.HemisphereLight(night ? 0x223355 : 0xbcd4ff, night ? 0x111a28 : 0xe6ecf5, night ? 0.25 : 1.1));
const slope = num('slope', 0);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400, 1, 1), new THREE.MeshStandardMaterial({ color: 0xe4e9f0, roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2;
ground.rotation.y = Math.atan(slope);
ground.receiveShadow = true;
scene.add(ground);
const terrain = { heightAt: (_x: number, z: number) => z * slope } as unknown as Terrain;

const am = createAnimalMaterial();
am.glow.value = night ? 0.55 : 0;
am.rim.value.set(0.12, 0.15, 0.2);

const gaitSpeed: Record<string, number> = { idle: 0, walk: 1.2, trot: 3.6, gallop: 10, run: 10 };
const gaitName = P.get('gait') ?? 'idle';
const pose = P.get('pose') ?? '';
const phase = num('phase', 0.25);

function posedRig(model: { geometry: THREE.BufferGeometry; joints: import('../skeleton').QuadJoints }, gp: GaitParams, x: number, z: number, heading: number, speedMul = 1, ph = phase) {
  const rig = new QuadRig(model.geometry, am.material, model.joints, gp, 1);
  const pos = new THREE.Vector3(x, terrain.heightAt(x, z), z);
  rig.speed = (P.has('speed') ? num('speed', 0) : gaitSpeed[gaitName] ?? 0) * speedMul;
  if (pose === 'graze') rig.graze = 1;
  if (pose === 'alert') rig.headUp = 0.4;
  if (pose === 'howl') {
    rig.headUp = 1.6;
    rig.jawOpen = 0.7;
  }
  if (pose === 'crouch') {
    rig.crouch = 0.65;
    rig.earsBack = 0.5;
    rig.jawOpen = 0.3;
  }
  if (pose === 'leap') {
    rig.leap = 1;
    rig.air = 0.4;
    rig.jawOpen = 0.9;
    rig.earsBack = 1;
  }
  if (pose === 'rear') rig.rear = 1;
  if (pose === 'tail') rig.tailUp = 1;
  for (let i = 0; i < 40; i++) rig.update(0.05, pos, heading, terrain, true);
  rig.phase = ph;
  rig.update(0.0001, pos, heading, terrain, true);
  if (pose === 'dead') {
    rig.dead = 0.999;
    rig.deadRoll = 1.5;
    rig.lieHeight = 0.16;
    rig.update(0.016, pos, heading, terrain, true);
    rig.dead = 1;
    rig.poseDead(3);
  }
  scene.add(rig.mesh);
  return rig;
}

function bird(model: { geometry: THREE.BufferGeometry; joints: THREE.Vector3[] }, x: number, y: number, z: number, flap: number) {
  const bones = makeBones(model.joints, BIRD_PARENT);
  const mesh = new THREE.SkinnedMesh(model.geometry, am.material);
  mesh.add(bones[0]);
  mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones));
  mesh.castShadow = true;
  mesh.position.set(x, y, z);
  mesh.rotation.y = Math.PI / 2;
  const s = Math.sin(flap * Math.PI * 2);
  bones[2].rotation.z = s * 0.9;
  bones[3].rotation.z = s * 0.5;
  bones[4].rotation.z = -s * 0.9;
  bones[5].rotation.z = -s * 0.5;
  scene.add(mesh);
}

const heading = num('heading', 90) * (Math.PI / 180);
if (view === 'animals') {
  posedRig(buildWolf(0), WOLF_GAIT, -3.2, 0, heading);
  posedRig(buildWolf(1), WOLF_GAIT, -1.2, 1.5, heading);
  posedRig(buildDeer(false), DEER_GAIT, 1.0, 0, heading);
  posedRig(buildDeer(true), DEER_GAIT, 3.6, 1.2, heading);
  posedRig(buildHare(), HARE_GAIT, -1.6, -1.6, heading, 0.5);
  bird(buildPtarmigan(), 0.6, 0, -1.8, 0.8);
  bird(buildRaven(), 1.8, 1.4, -1.6, num('flap', 0.25));
} else if (view === 'wolf' || view === 'deer' || view === 'hare' || view === 'buck') {
  const m = view === 'wolf' ? buildWolf((num('variant', 0) as 0 | 1)) : view === 'hare' ? buildHare() : buildDeer(view === 'buck');
  const gp = view === 'wolf' ? WOLF_GAIT : view === 'hare' ? HARE_GAIT : DEER_GAIT;
  const n = num('n', 1);
  for (let i = 0; i < n; i++) posedRig(m, gp, (i - (n - 1) / 2) * num('spacing', 2.2), 0, heading, 1, P.has('phases') ? phase + i / n : phase);
} else if (view === 'birds') {
  bird(buildPtarmigan(), -0.6, 0, 0, num('flap', 0.25));
  bird(buildRaven(), 0.8, 0.6, 0, num('flap', 0.25));
} else if (view === 'weapons') {
  const M = createWeaponMaterials();
  const h = buildHatchet(M);
  h.position.set(-0.7, 0.9, 0);
  h.rotation.set(0, num('wy', 1.2), 0);
  h.scale.setScalar(2.2);
  const s = buildSpear(M);
  s.position.set(0.9, 1.2, 0);
  s.rotation.set(0, -Math.PI / 2, 0);
  const b = buildBow(M);
  b.setDraw(num('draw', 0), 0, true);
  b.root.position.set(0.1, 1.0, 0);
  b.root.rotation.y = -Math.PI / 2;
  b.root.scale.setScalar(1.3);
  const t = buildTorch(M);
  t.root.position.set(-1.3, 0.8, 0);
  t.root.scale.setScalar(2);
  const a = buildArrow(M);
  a.position.set(0.9, 0.6, 0);
  a.rotation.y = -Math.PI / 2;
  a.scale.setScalar(2);
  scene.add(h, s, b.root, t.root, a);
  for (const o of [h, s, b.root, t.root, a]) o.traverse((m) => ((m as THREE.Mesh).isMesh ? ((m as THREE.Mesh).castShadow = true) : null));
}

const az = num('az', 0) * (Math.PI / 180),
  el = num('el', 10) * (Math.PI / 180),
  dist = num('dist', 9);
const target = new THREE.Vector3(num('tx', 0), num('ty', 0.7), num('tz', 0));
camera.position.set(target.x + Math.sin(az) * Math.cos(el) * dist, target.y + Math.sin(el) * dist, target.z + Math.cos(az) * Math.cos(el) * dist);
camera.lookAt(target);
renderer.render(scene, camera);
(window as unknown as { __frostline: unknown }).__frostline = { ready: true, frames: 999, state: 'viewer', fps: 60 };
