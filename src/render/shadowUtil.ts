// Shadow-only instanced casters. They are hidden from every main-camera pass (including post
// prepasses such as SSAO/normal passes) and each cascade draws only what it needs:
//  - "near" cascades (small extent) draw detailed casters, nearest distance ring first (prefix)
//  - "far" cascades draw cheap proxies for everything within the shadow distance
import type * as THREE from 'three';

/** Cascades wider than this (m) are treated as far cascades. */
export const FAR_CASCADE_EXTENT = 150;
/** Distance rings (m) used to order near casters so small cascades draw only a prefix. */
export const SHADOW_RINGS = [110, 170];

export function cascadeExtent(cam: THREE.Camera): number {
  const o = cam as THREE.OrthographicCamera;
  if (!o.isOrthographicCamera) return Infinity;
  return Math.max(o.right - o.left, o.top - o.bottom) / (o.zoom || 1);
}

/** Ring prefix (0..SHADOW_RINGS.length) a cascade of this extent needs: its size + shadow throw. */
export function ringForExtent(ext: number): number {
  const reach = ext + 45;
  let r = 0;
  while (r < SHADOW_RINGS.length && reach > SHADOW_RINGS[r]) r++;
  return r;
}

export type CascadeClass = 'near' | 'far' | 'all';

/**
 * Make an instanced mesh shadow-only. `userData.ringCounts[r]` = instances within ring prefix r.
 * cls 'near': drawn only in near cascades (prefix by ring); 'far': only in far cascades (all
 * instances); 'all': every cascade (prefix by ring in near ones).
 */
export function shadowOnly(im: THREE.InstancedMesh, cls: CascadeClass = 'all') {
  im.userData.ringCounts = [0, 0, 0];
  im.onBeforeRender = () => {
    im.count = 0;
  };
  im.onBeforeShadow = (_r, _o, _c, shadowCamera) => {
    const rc = im.userData.ringCounts as number[];
    const ext = cascadeExtent(shadowCamera);
    const far = ext >= FAR_CASCADE_EXTENT;
    if (cls === 'near' && far) im.count = 0;
    else if (cls === 'far' && !far) im.count = 0;
    else im.count = far ? rc[rc.length - 1] : rc[ringForExtent(ext)];
  };
}
