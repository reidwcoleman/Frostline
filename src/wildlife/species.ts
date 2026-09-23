// Per-species tuning: gait parameters, hit colliders and stats.
import * as THREE from 'three';
import type { GaitParams } from './QuadRig';
import type { ColliderSpec } from './Animal';
import { B } from './skeleton';

export const WOLF_GAIT: GaitParams = {
  walkMax: 1.7,
  trotMax: 5.2,
  fMin: 1.3,
  fMax: 3.1,
  fScale: 4,
  liftF: 0.1,
  liftH: 0.085,
  reach: 0.4,
  bobWalk: 0.012,
  bobTrot: 0.026,
  bobGallop: 0.055,
  flex: 0.13,
  neckDown: 0.95,
  headDown: 0.55,
};

export const DEER_GAIT: GaitParams = {
  walkMax: 1.8,
  trotMax: 4.6,
  fMin: 1.05,
  fMax: 2.6,
  fScale: 4.5,
  liftF: 0.17,
  liftH: 0.13,
  reach: 0.62,
  bobWalk: 0.014,
  bobTrot: 0.03,
  bobGallop: 0.09,
  flex: 0.16,
  neckDown: 1.35,
  headDown: 0.45,
};

export const HARE_GAIT: GaitParams = {
  walkMax: 0.4,
  trotMax: 1.2,
  fMin: 2.2,
  fMax: 3.8,
  fScale: 3,
  liftF: 0.04,
  liftH: 0.05,
  reach: 0.22,
  bobWalk: 0.01,
  bobTrot: 0.02,
  bobGallop: 0.03,
  flex: 0.25,
  neckDown: 0.55,
  headDown: 0.35,
  bound: true,
  hop: 0.14,
};

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export const WOLF_COLLIDERS: ColliderSpec[] = [
  { bone: B.pelvis, offset: v(0, -0.02, 0.02), radius: 0.2, tag: 'body' },
  { bone: B.chest, offset: v(0, -0.03, -0.02), radius: 0.23, tag: 'body' },
  { bone: B.head, offset: v(0, 0, 0.1), radius: 0.13, tag: 'head' },
];
export const DEER_COLLIDERS: ColliderSpec[] = [
  { bone: B.pelvis, offset: v(0, -0.03, 0), radius: 0.25, tag: 'body' },
  { bone: B.chest, offset: v(0, -0.04, -0.12), radius: 0.28, tag: 'body' },
  { bone: B.neck, offset: v(0, 0.16, 0.06), radius: 0.12, tag: 'body' },
  { bone: B.head, offset: v(0, 0, 0.12), radius: 0.13, tag: 'head' },
];
export const HARE_COLLIDERS: ColliderSpec[] = [
  { bone: B.body, offset: v(0, 0, 0), radius: 0.15, tag: 'body' },
  { bone: B.head, offset: v(0, 0, 0.02), radius: 0.08, tag: 'head' },
];
