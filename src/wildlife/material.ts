// One shared material for every animal (vertex coloured, skinned). MeshPhysicalMaterial for its
// sheen lobe (the soft, view-dependent glow real fur has), plus an onBeforeCompile patch for:
//  (1) night eyeshine driven by a per-vertex mask + a global uniform,
//  (2) fur: fine strand streaks (albedo + a bump-mapped normal) laid along the body in rest-pose
//      object space so they stay glued to the animal while it moves, faded out with distance,
//  (3) countershading: darker along the back, paler on the belly, as real coats are,
//  (4) a soft fur rim so dark coats keep a readable silhouette against snow and dusk skies,
//  (5) snow settling on upward-facing fur while it's snowing.
import * as THREE from 'three';

export interface AnimalMaterial {
  material: THREE.MeshPhysicalMaterial;
  /** 0..1 eyeshine strength (set from darkness each frame). */
  glow: { value: number };
  /** Rim light colour/intensity (sky tint * daylight). */
  rim: { value: THREE.Color };
  /** 0..1 snow dusting on backs (from snowfall). */
  snow: { value: number };
}

export function createAnimalMaterial(): AnimalMaterial {
  const glow = { value: 0 };
  const rim = { value: new THREE.Color(0.25, 0.3, 0.36) };
  const snow = { value: 0 };
  const material = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.88,
    metalness: 0,
    sheen: 0.32,
    sheenRoughness: 0.75,
    sheenColor: new THREE.Color(0.8, 0.7, 0.58),
  });
  material.onBeforeCompile = (sh) => {
    sh.uniforms.uGlow = glow;
    sh.uniforms.uRim = rim;
    sh.uniforms.uSnow = snow;
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float aGlow;\nvarying float vGlow;\nvarying vec3 vFurPos;\nvarying vec3 vFurNrm;',
      )
      // Rest-pose object space: stable under skinning, so the coat pattern never swims.
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;\nvFurPos = position;\nvFurNrm = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        [
          '#include <common>',
          'uniform float uGlow;',
          'uniform vec3 uRim;',
          'uniform float uSnow;',
          'varying float vGlow;',
          'varying vec3 vFurPos;',
          'varying vec3 vFurNrm;',
          'float furHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }',
          'float furNoise(vec3 x) {',
          '  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);',
          '  return mix(mix(mix(furHash(i), furHash(i + vec3(1,0,0)), f.x), mix(furHash(i + vec3(0,1,0)), furHash(i + vec3(1,1,0)), f.x), f.y),',
          '             mix(mix(furHash(i + vec3(0,0,1)), furHash(i + vec3(1,0,1)), f.x), mix(furHash(i + vec3(0,1,1)), furHash(i + vec3(1,1,1)), f.x), f.y), f.z);',
          '}',
          // Strands run along the body (object Z) and droop down the flanks: stretch the noise that way.
          'float furStrands(vec3 p) { return furNoise(p * vec3(95.0, 70.0, 16.0)) * 0.65 + furNoise(p * vec3(210.0, 160.0, 34.0)) * 0.35; }',
        ].join('\n'),
      )
      .replace(
        '#include <color_fragment>',
        [
          '#include <color_fragment>',
          '{',
          '  float furFade = 1.0 - smoothstep(3.0, 12.0, length(vViewPosition));',
          '  float s = furStrands(vFurPos);',
          '  float coat = furNoise(vFurPos * vec3(7.0, 7.0, 3.0));',
          '  diffuseColor.rgb *= 0.92 + 0.16 * coat;',
          '  diffuseColor.rgb *= mix(1.0, 0.95 + 0.08 * s, furFade);',
          // Countershading: back darker, belly paler.
          '  float up = normalize(vFurNrm).y;',
          '  diffuseColor.rgb *= mix(1.07, 0.9, smoothstep(-0.4, 0.8, up));',
          // Snow settling on the back and head in snowfall.
          '  float settle = uSnow * smoothstep(0.35, 0.85, up) * smoothstep(0.35, 0.7, furNoise(vFurPos * 28.0));',
          '  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.88, 0.92), settle);',
          '}',
        ].join('\n'),
      )
      .replace(
        '#include <normal_fragment_maps>',
        [
          '#include <normal_fragment_maps>',
          '{',
          // Bump the shading normal with the strand field (screen-space derivatives), near only.
          '  float furFade = 1.0 - smoothstep(2.0, 9.0, length(vViewPosition));',
          '  if (furFade > 0.0) {',
          '    float h = furStrands(vFurPos);',
          '    vec3 dpx = dFdx(-vViewPosition), dpy = dFdy(-vViewPosition);',
          '    float dhx = dFdx(h), dhy = dFdy(h);',
          '    vec3 r1 = cross(dpy, normal), r2 = cross(normal, dpx);',
          '    float det = dot(dpx, r1);',
          '    vec3 grad = sign(det) * (dhx * r1 + dhy * r2);',
          '    normal = normalize(abs(det) * normal - grad * 0.018 * furFade);',
          '  }',
          '}',
        ].join('\n'),
      )
      .replace(
        '#include <emissivemap_fragment>',
        ['#include <emissivemap_fragment>', 'totalEmissiveRadiance += vec3(1.0, 0.82, 0.42) * vGlow * uGlow * 2.5;'].join('\n'),
      )
      .replace(
        '#include <opaque_fragment>',
        [
          '{',
          '  float fres = 1.0 - saturate(dot(normalize(vViewPosition), normal));',
          '  outgoingLight += uRim * diffuseColor.rgb * pow(fres, 2.5);',
          '}',
          '#include <opaque_fragment>',
        ].join('\n'),
      );
  };
  material.customProgramCacheKey = () => 'frostline-animal-v3';
  return { material, glow, rim, snow };
}
