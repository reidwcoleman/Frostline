// One shared material for every animal (vertex coloured, skinned). A tiny onBeforeCompile
// patch adds (1) night eyeshine driven by a per-vertex mask + a global uniform, and (2) a soft
// fur rim so dark coats keep a readable silhouette against snow and dusk skies.
import * as THREE from 'three';

export interface AnimalMaterial {
  material: THREE.MeshStandardMaterial;
  /** 0..1 eyeshine strength (set from darkness each frame). */
  glow: { value: number };
  /** Rim light colour/intensity (sky tint * daylight). */
  rim: { value: THREE.Color };
}

export function createAnimalMaterial(): AnimalMaterial {
  const glow = { value: 0 };
  const rim = { value: new THREE.Color(0.25, 0.3, 0.36) };
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0 });
  material.onBeforeCompile = (sh) => {
    sh.uniforms.uGlow = glow;
    sh.uniforms.uRim = rim;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aGlow;\nvarying float vGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uGlow;\nuniform vec3 uRim;\nvarying float vGlow;')
      .replace(
        '#include <emissivemap_fragment>',
        [
          '#include <emissivemap_fragment>',
          'totalEmissiveRadiance += vec3(1.0, 0.82, 0.42) * vGlow * uGlow * 2.5;',
        ].join('\n'),
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
  material.customProgramCacheKey = () => 'frostline-animal-v1';
  return { material, glow, rim };
}
