// Shared quadruped skeleton layout. Every four-legged species (wolf, deer, hare) uses the same
// 23-bone hierarchy so one procedural rig (QuadRig) can drive them all; species only differ in
// joint positions, proportions and gait parameters.
import * as THREE from 'three';

export const B = {
  body: 0,
  pelvis: 1,
  chest: 2,
  neck: 3,
  head: 4,
  jaw: 5,
  earL: 6,
  earR: 7,
  tail1: 8,
  tail2: 9,
  tail3: 10,
  // legs: [upper, lower, foot] for FL, FR, HL, HR
  leg0: 11,
} as const;
export const BONE_COUNT = 23;
/** Bone index of a leg segment. leg: 0 FL, 1 FR, 2 HL, 3 HR. seg: 0 upper, 1 lower, 2 foot. */
export const legBone = (leg: number, seg: number) => B.leg0 + leg * 3 + seg;

export interface LegJoints {
  hip: THREE.Vector3; // upper joint (shoulder / hip)
  knee: THREE.Vector3; // middle joint (carpus / hock)
  foot: THREE.Vector3; // lowest joint (fetlock / paw), ~ankle height above ground
}

export interface QuadJoints {
  body: THREE.Vector3;
  pelvis: THREE.Vector3;
  chest: THREE.Vector3;
  neck: THREE.Vector3;
  head: THREE.Vector3;
  jaw: THREE.Vector3;
  earL: THREE.Vector3;
  earR: THREE.Vector3;
  tail: [THREE.Vector3, THREE.Vector3, THREE.Vector3];
  legs: [LegJoints, LegJoints, LegJoints, LegJoints];
}

/** Absolute bind position of every bone, indexed like B / legBone. */
export function jointList(j: QuadJoints): THREE.Vector3[] {
  const out: THREE.Vector3[] = new Array(BONE_COUNT);
  out[B.body] = j.body;
  out[B.pelvis] = j.pelvis;
  out[B.chest] = j.chest;
  out[B.neck] = j.neck;
  out[B.head] = j.head;
  out[B.jaw] = j.jaw;
  out[B.earL] = j.earL;
  out[B.earR] = j.earR;
  out[B.tail1] = j.tail[0];
  out[B.tail2] = j.tail[1];
  out[B.tail3] = j.tail[2];
  for (let l = 0; l < 4; l++) {
    out[legBone(l, 0)] = j.legs[l].hip;
    out[legBone(l, 1)] = j.legs[l].knee;
    out[legBone(l, 2)] = j.legs[l].foot;
  }
  return out;
}

/** Parent of each bone (-1 = root). */
export const PARENT: number[] = (() => {
  const p = new Array(BONE_COUNT).fill(-1);
  p[B.pelvis] = B.body;
  p[B.chest] = B.body;
  p[B.neck] = B.chest;
  p[B.head] = B.neck;
  p[B.jaw] = B.head;
  p[B.earL] = B.head;
  p[B.earR] = B.head;
  p[B.tail1] = B.pelvis;
  p[B.tail2] = B.tail1;
  p[B.tail3] = B.tail2;
  for (let l = 0; l < 4; l++) {
    p[legBone(l, 0)] = l < 2 ? B.chest : B.pelvis;
    p[legBone(l, 1)] = legBone(l, 0);
    p[legBone(l, 2)] = legBone(l, 1);
  }
  return p;
})();

/** Build a fresh bone hierarchy in bind pose. Returns bones indexed like B. */
export function makeBones(abs: THREE.Vector3[], parents: number[] = PARENT): THREE.Bone[] {
  const bones: THREE.Bone[] = abs.map(() => new THREE.Bone());
  for (let i = 0; i < abs.length; i++) {
    const p = parents[i];
    bones[i].rotation.order = 'YXZ';
    if (p < 0) bones[i].position.copy(abs[i]);
    else {
      bones[i].position.copy(abs[i]).sub(abs[p]);
      bones[p].add(bones[i]);
    }
  }
  return bones;
}

/** Skin weight helper: blend smoothly between bone a and b as `t` goes 0 -> 1. */
export function blend(a: number, b: number, t: number): number | [number, number, number] {
  if (t <= 0.02) return a;
  if (t >= 0.98) return b;
  return [a, b, t * t * (3 - 2 * t)];
}
