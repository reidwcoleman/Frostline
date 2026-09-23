// Helpers to extend three.js built-in materials without forking them (keeps shadows, fog,
// tone mapping and whatever global chunk overrides the atmosphere agent installs).
import * as THREE from 'three';

/**
 * Returns `lights_fragment_begin` with hooks around every sun/directional RE_Direct call.
 * `pre` runs with `directLight` (color already shadowed) before the BRDF; `post` runs after.
 * Works on the chunk as it is at compile time, so global overrides (CSM, SunLight) survive.
 */
export function hookedLightsChunk(pre: string, post: string): string {
  const chunk = THREE.ShaderChunk.lights_fragment_begin;
  const call = /RE_Direct\(\s*directLight\s*,[^;]*;/g;
  return chunk.replace(call, (m: string, offset: number) => {
    const before = chunk.slice(0, offset);
    const dir = before.lastIndexOf('getDirectionalLightInfo');
    const sun = before.lastIndexOf('getSunLightInfo');
    const point = before.lastIndexOf('getPointLightInfo');
    const spot = before.lastIndexOf('getSpotLightInfo');
    const isSunLike = Math.max(dir, sun) > Math.max(point, spot);
    return isSunLike ? `{ ${pre} }\n${m}\n{ ${post} }` : m;
  });
}

/** Replace an `#include <chunk>` line; warns (once per chunk) if it is missing. */
export function replaceInclude(src: string, chunk: string, code: string): string {
  const tag = `#include <${chunk}>`;
  if (!src.includes(tag)) {
    console.warn(`[world] shader include <${chunk}> not found`);
    return src;
  }
  return src.replace(tag, code);
}
