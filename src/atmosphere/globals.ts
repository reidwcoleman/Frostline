// Global shader plumbing for the atmosphere: shared uniforms that every material receives, plus the
// fog and sun-light shader chunk overrides. Imported for its side effects by Sky.ts, which Game.ts
// imports long before the first material is compiled.
//
// Why a prototype hook: built-in materials clone their uniforms from ShaderLib at compile time, so a
// value we update later would never reach them. Every material (built-in or ShaderMaterial) passes its
// uniforms through `onBeforeCompile`, so we wrap that on Material.prototype and splice in *shared*
// uniform objects — one `{ value }` per global, referenced by every program. Materials that define their
// own onBeforeCompile keep working: we call theirs after ours and keep their cache key.
import * as THREE from 'three';

/** A 1x1 placeholder used until the real textures exist (never sampled meaningfully). */
function blankTexture(r = 0, g = 0, b = 0, a = 255): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1);
  t.needsUpdate = true;
  return t;
}

/** Shared uniforms spliced into every compiled material. Update `.value` in place (never replace). */
export const G = {
  /** Sky-view LUT: world azimuth x non-linear elevation, radiance for unit sun illuminance. */
  flSkyLUT: { value: blankTexture(40, 60, 90) as THREE.Texture },
  /** x: horizon dip (rad), y: LUT radiance scale, z: cloud cover 0..1, w: time (s). */
  flSkyP: { value: new THREE.Vector4(0, 1, 0, 0) },
  /** Direction toward the dominant light (sun, or moon at night) — used for fog glow. */
  flLightDir: { value: new THREE.Vector3(0, 1, 0) },
  /** Haze (aerial perspective): x density at sea level (1/m), y scale height (m), z weather fog density (1/m), w max opacity. */
  flFogA: { value: new THREE.Vector4(2.2e-4, 1400, 0, 1) },
  /** Valley fog: x density at base (1/m), y falloff (1/m), z base altitude (m), w colour desaturation toward dense fog. */
  flFogB: { value: new THREE.Vector4(0, 1 / 90, 150, 0) },
  /** x: glow strength, y: glow anisotropy g, z: haze-colour blend toward flFogCloud (overcast), w: sky LUT min elevation (rad). */
  flFogC: { value: new THREE.Vector4(0.6, 0.75, 0, 0.035) },
  /** Colour of dense fog (valley + weather), already lit. */
  flFogDense: { value: new THREE.Color(0.7, 0.75, 0.82) },
  /** Colour of the overcast horizon (replaces the clear-sky LUT colour as cloud cover rises). */
  flFogCloud: { value: new THREE.Color(0.6, 0.63, 0.68) },
  /** Mie glow colour around the light in fog (sun colour x intensity). */
  flFogGlow: { value: new THREE.Color(1, 0.8, 0.6) },

  /** Terrain heightfield shadow (RG = lit-below / lit-above heights), double buffered for crossfades. */
  flTShadowA: { value: blankTexture(0, 0, 0, 255) as THREE.Texture },
  flTShadowB: { value: blankTexture(0, 0, 0, 255) as THREE.Texture },
  /** x: blend A->B, y: world half size (m), z: enabled 0/1, w: min penumbra (m). */
  flTShadowP: { value: new THREE.Vector4(0, 2048, 0, 1.5) },

  /** Tiling cloud noise (RGBA octaves). */
  flCloudTex: { value: blankTexture(128, 128, 128, 128) as THREE.Texture },
  /** x,y: wind offset (m), z: coverage 0..1, w: cloud base altitude (m). */
  flCloudP: { value: new THREE.Vector4(0, 0, 0, 2600) },
  /** x: noise scale (1/m), y: edge sharpness, z: ground shadow strength, w: optical thickness. */
  flCloudP2: { value: new THREE.Vector4(1 / 5200, 2.5, 0.85, 8) },
};

export type GlobalUniforms = typeof G;

// ------------------------------------------------------------------------------------------------
// Material.prototype.onBeforeCompile hook
// ------------------------------------------------------------------------------------------------
type OBC = (shader: THREE.WebGLProgramParametersWithUniforms, renderer: THREE.WebGLRenderer) => void;

const USER = Symbol('flUserOBC');
const WRAP = Symbol('flWrappedOBC');

function inject(shader: THREE.WebGLProgramParametersWithUniforms) {
  const u = shader.uniforms as Record<string, THREE.IUniform>;
  for (const k in G) u[k] = G[k as keyof GlobalUniforms];
}

const baseHook: OBC = function flAtmoInject(shader) {
  inject(shader);
};

let installed = false;
export function installMaterialHook() {
  if (installed) return;
  installed = true;
  Object.defineProperty(THREE.Material.prototype, 'onBeforeCompile', {
    configurable: true,
    get(this: THREE.Material & { [USER]?: OBC; [WRAP]?: OBC }) {
      const user = this[USER];
      if (!user) return baseHook;
      let w = this[WRAP];
      if (!w) {
        w = function (this: unknown, shader, renderer) {
          inject(shader);
          user.call(this, shader, renderer);
        } as OBC;
        // Keep three's default cache key (onBeforeCompile.toString()) distinct per user callback.
        w.toString = () => user.toString();
        this[WRAP] = w;
      }
      return w;
    },
    set(this: THREE.Material & { [USER]?: OBC; [WRAP]?: OBC }, fn: OBC) {
      this[USER] = fn;
      this[WRAP] = undefined;
    },
  });
}

// ------------------------------------------------------------------------------------------------
// Shader chunks
// ------------------------------------------------------------------------------------------------

/** Maps a world direction to the sky-view LUT uv. Shared by fog, sky dome and probes. */
export const SKY_LUT_GLSL = /* glsl */ `
vec2 flSkyLutUv( vec3 dir, float horizonDip ) {
  float az = atan( dir.x, -dir.z ); // 0 = -Z
  float el = asin( clamp( dir.y, -1.0, 1.0 ) ) + horizonDip;
  float v = 0.5 + 0.5 * sign( el ) * sqrt( min( abs( el ) / 1.5707963, 1.0 ) );
  return vec2( az * 0.15915494 + 0.5, v );
}
`;

const FOG_PARS_VERTEX = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFlFogOffset;
#endif
`;

const FOG_VERTEX = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  // World-space vector camera -> vertex (view matrix is rigid: transpose = inverse rotation).
  vFlFogOffset = ( vec4( mvPosition.xyz, 0.0 ) * viewMatrix ).xyz;
#endif
`;

/** Atmospheric fog: exponential-height haze + valley fog + weather fog, lit by the sky. */
export const FOG_FUNCS_GLSL = /* glsl */ `
uniform sampler2D flSkyLUT;
uniform vec4 flSkyP;
#ifndef FL_LIGHTDIR_DECL
#define FL_LIGHTDIR_DECL
uniform vec3 flLightDir;
#endif
uniform vec4 flFogA;
uniform vec4 flFogB;
uniform vec4 flFogC;
uniform vec3 flFogDense;
uniform vec3 flFogCloud;
uniform vec3 flFogGlow;
${SKY_LUT_GLSL}
// Integral of exp(-k * (y0 + t * dy - base)) for t in [0, 1] (per unit length).
float flExpIntegral( float y0, float dy, float k, float base ) {
  float a = exp( - k * ( y0 - base ) );
  float x = k * dy;
  float f = abs( x ) < 1e-3 ? 1.0 - 0.5 * x : ( 1.0 - exp( - x ) ) / x;
  return a * f;
}
float flHG( float c, float g ) {
  float g2 = g * g;
  return ( 1.0 - g2 ) / ( 12.566371 * pow( max( 1.0 + g2 - 2.0 * g * c, 1e-4 ), 1.5 ) );
}
// Colour the haze takes on along direction dir: the sky just above the horizon in that direction.
vec3 flHazeColor( vec3 dir ) {
  vec3 d = normalize( vec3( dir.x, max( dir.y, flFogC.w ), dir.z ) );
  vec3 sky = texture2D( flSkyLUT, flSkyLutUv( d, flSkyP.x ) ).rgb * flSkyP.y;
  return mix( sky, flFogCloud, flFogC.z );
}
// Returns rgb = in-scattered light, a = transmittance, for a segment of length d along dir from the camera.
vec4 flFog( vec3 camPos, vec3 dir, float d ) {
  float dy = dir.y * d;
  float haze = flFogA.x * d * flExpIntegral( camPos.y, dy, 1.0 / flFogA.y, 0.0 );
  float valley = flFogB.x * d * flExpIntegral( camPos.y, dy, flFogB.y, flFogB.z );
  float weather = flFogA.z * d;
  float dense = valley + weather;
  float od = haze + dense;
  float T = exp( - od );
  float cosL = dot( dir, flLightDir );
  vec3 hazeCol = flHazeColor( dir );
  vec3 denseCol = flFogDense;
  // Forward-scattering glow around the sun/moon, strongest in dense fog and low haze.
  vec3 glow = flFogGlow * flHG( cosL, flFogC.y ) * flFogC.x;
  vec3 col = mix( hazeCol, denseCol + glow * 0.6, od > 0.0 ? dense / od : 0.0 ) + glow * ( haze / max( od, 1e-5 ) ) * 0.4;
  float opacity = ( 1.0 - T ) * flFogA.w;
  return vec4( col, 1.0 - opacity );
}
`;

const FOG_PARS_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFlFogOffset;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  ${FOG_FUNCS_GLSL}
#endif
`;

const FOG_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
  {
    float flD = length( vFlFogOffset );
    vec3 flDir = vFlFogOffset / max( flD, 1e-4 );
    vec4 flF = flFog( cameraPosition, flDir, flD );
    gl_FragColor.rgb = gl_FragColor.rgb * flF.a + flF.rgb * ( 1.0 - flF.a );
  }
#endif
`;

/** Procedural cloud layer density (shared by the sky dome and the ground cloud shadows). */
export const CLOUD_GLSL = /* glsl */ `
#ifndef FL_CLOUD_DECL
#define FL_CLOUD_DECL
uniform sampler2D flCloudTex;
uniform vec4 flCloudP;
uniform vec4 flCloudP2;
float flCloudDensityAt( vec2 xz ) {
  vec2 p = ( xz + flCloudP.xy ) * flCloudP2.x;
  // domain-warped base shape + billowy erosion at the edges
  vec4 w = texture2D( flCloudTex, p * 0.5 + vec2( 0.13, 0.77 ) );
  vec2 q = p + ( w.rg - 0.5 ) * 0.22;
  vec4 n0 = texture2D( flCloudTex, q );
  float base = n0.r * 0.72 + n0.g * 0.28;
  float c = flCloudP.z;
  // coverage 0 -> nothing, 1 -> solid deck; soft shoulders for sparse fair-weather clouds
  float lo = mix( 0.78, -0.2, c );
  float d = smoothstep( lo, lo + mix( 0.3, 0.55, c ), base );
  // billowy erosion of the thin edges only (keeps cores solid, edges soft and lumpy)
  vec4 n1 = texture2D( flCloudTex, q * 2.7 + vec2( 0.37, 0.71 ) );
  d = clamp( d - ( 1.0 - d ) * ( 1.0 - d ) * ( 1.0 - n1.b ) * 0.45, 0.0, 1.0 );
  d *= d * ( 3.0 - 2.0 * d );
  return clamp( d * flCloudP2.y, 0.0, 1.0 );
}
#endif
`;

/** Large-scale sun occlusion: terrain heightfield shadow + moving cloud shadows. */
export const SUN_OCCLUSION_GLSL = /* glsl */ `
uniform sampler2D flTShadowA;
uniform sampler2D flTShadowB;
uniform vec4 flTShadowP;
#ifndef FL_LIGHTDIR_DECL
#define FL_LIGHTDIR_DECL
uniform vec3 flLightDir;
#endif
${CLOUD_GLSL}
float flSunOcclusion( vec3 wp ) {
  float s = 1.0;
  if ( flTShadowP.z > 0.5 ) {
    vec2 uv = ( wp.xz + flTShadowP.y ) / ( 2.0 * flTShadowP.y );
    if ( uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0 ) {
      vec2 a = texture2D( flTShadowA, uv ).rg;
      vec2 b = texture2D( flTShadowB, uv ).rg;
      vec2 lh = mix( a, b, flTShadowP.x );
      float pen = flTShadowP.w;
      s = smoothstep( lh.x - pen, lh.y + pen, wp.y );
    }
  }
  if ( flCloudP.z > 0.01 && flLightDir.y > 0.02 ) {
    vec2 cp = wp.xz + flLightDir.xz / flLightDir.y * ( flCloudP.w - wp.y );
    float cd = flCloudDensityAt( cp );
    s *= mix( 1.0, exp( - cd * flCloudP2.w ), flCloudP2.z );
  }
  return s;
}
`;

let chunksInstalled = false;
/** Override three's fog chunks and hook terrain/cloud occlusion into the sun light. */
export function installChunks(sunCascades: number) {
  if (chunksInstalled) return;
  chunksInstalled = true;
  const SC = THREE.ShaderChunk as unknown as Record<string, string>;
  SC.fog_pars_vertex = FOG_PARS_VERTEX;
  SC.fog_vertex = FOG_VERTEX;
  SC.fog_pars_fragment = FOG_PARS_FRAGMENT;
  SC.fog_fragment = FOG_FRAGMENT;

  // Cascade count for the SunLight shadow atlas (must match FrostSunShadow).
  SC.shadowmap_pars_fragment = SC.shadowmap_pars_fragment.replace(
    '#define SUN_LIGHT_CASCADES 2',
    `#define SUN_LIGHT_CASCADES ${sunCascades}`,
  );
  // Terrain + cloud occlusion for the sun light, declared next to the sun shadow uniforms.
  SC.shadowmap_pars_fragment = SC.shadowmap_pars_fragment.replace(
    '#if NUM_SUN_LIGHT_SHADOWS > 0',
    `#if NUM_SUN_LIGHT_SHADOWS > 0\n${SUN_OCCLUSION_GLSL}`,
  );
  const sunShadowLine =
    'directLight.color *= ( directLight.visible && receiveShadow ) ? getSunShadow( sunShadowMap[ i ], sunLightShadow, UNROLLED_LOOP_INDEX ) : 1.0;';
  if (!SC.lights_fragment_begin.includes(sunShadowLine)) {
    console.warn('[atmosphere] lights_fragment_begin changed; terrain shadows disabled');
  } else {
    SC.lights_fragment_begin = SC.lights_fragment_begin.replace(
      sunShadowLine,
      sunShadowLine + '\n\t\tdirectLight.color *= flSunOcclusion( vSunShadowWorldPosition.xyz );',
    );
  }
}
