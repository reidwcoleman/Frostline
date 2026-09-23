// Tree material: MeshStandardMaterial + onBeforeCompile.
//  - wind sway applied in object space (so shadows and shadow receivers see the same motion)
//  - snow resting on bough tops (aSnow capacity x world up-facing x per-tree variation)
//  - per-tree tint, dithered crossfade between LODs (complementary with the impostors)
import * as THREE from 'three';
import { replaceInclude } from '../shaders/lighting';

export interface TreeShared {
  uTime: THREE.IUniform<number>;
  /** xy = wind direction (unit), z = strength 0..1, w = gustiness */
  uWind: THREE.IUniform<THREE.Vector4>;
  /** Global snow load multiplier (weather). */
  uSnowCover: THREE.IUniform<number>;
  uNoiseTex: THREE.IUniform<THREE.Texture>;
}

/** Interleaved-gradient-noise dither, shared by trees and impostors so crossfades are complementary. */
export const GLSL_DITHER = /* glsl */ `
float treeDither(vec2 fc) { return fract(52.9829189 * fract(dot(fc, vec2(0.06711056, 0.00583715)))); }
`;

/** World-space sway offset for a point with bend weight w on a tree rooted at `origin`. */
export const GLSL_SWAY = /* glsl */ `
uniform float uTime;
uniform vec4 uWind;
vec3 treeSwayOffset(vec3 origin, float w, float scale) {
  float ph = dot(origin.xz, vec2(0.137, 0.171));
  float ws = uWind.z;
  float gust = 0.55 + 0.45 * sin(uTime * 0.61 + ph * 0.37) * sin(uTime * 0.23 + ph * 1.3);
  float bend = ws * (0.35 + 0.65 * gust);
  float osc = sin(uTime * (1.1 + 0.25 * fract(ph)) + ph) * (0.15 + 0.85 * ws);
  float flutter = sin(uTime * 4.7 + ph * 5.0 + w * 9.0) * (0.02 + 0.08 * ws);
  float amp = w * w * scale;
  vec2 d = uWind.xy;
  vec2 off = d * (bend * 0.55 + osc * 0.12) * amp + vec2(-d.y, d.x) * osc * 0.05 * amp;
  return vec3(off.x, -abs(bend) * 0.08 * amp, off.y) + vec3(flutter, flutter * 0.5, -flutter) * w * 0.35;
}
`;

const VERT_PARS = /* glsl */ `
attribute float aSnow;
attribute float aSway;
uniform vec4 uLodRange; // fade-in start/end, fade-out start/end (meters)
${GLSL_SWAY}
#ifdef TREE_MAIN
varying vec3 vWN;
varying vec3 vObj;
varying float vSnowCap;
varying vec3 vTint;
flat varying float vFadeIn;
flat varying float vFadeOut;
varying float vTreeH;
#endif
float treeHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
`;

const VERT_BEGIN = /* glsl */ `
vec3 transformed = vec3(position);
mat4 tM = modelMatrix;
#ifdef USE_INSTANCING
tM = modelMatrix * instanceMatrix;
#endif
vec3 tOrigin = tM[3].xyz;
float tScale = length(tM[0].xyz);
transformed += inverse(mat3(tM)) * treeSwayOffset(tOrigin, aSway, tScale);
#ifdef TREE_MAIN
vWN = normalize(mat3(tM) * objectNormal);
vObj = position;
float th = treeHash(tOrigin.xz);
float th2 = treeHash(tOrigin.zx + 17.0);
vTint = mix(vec3(0.85, 1.0, 0.9), vec3(1.2, 1.08, 0.85), th) * (0.85 + 0.3 * th2);
vSnowCap = aSnow * (0.65 + 0.6 * treeHash(tOrigin.xz + 3.3));
#ifdef TREE_BAKE
vTint = vec3(1.0);
vSnowCap = aSnow * 0.95;
#endif
vTreeH = position.y;
float td = distance(cameraPosition, tOrigin);
vFadeIn = uLodRange.y > uLodRange.x ? smoothstep(uLodRange.x, uLodRange.y, td) : 1.0;
vFadeOut = uLodRange.w > uLodRange.z ? 1.0 - smoothstep(uLodRange.z, uLodRange.w, td) : 1.0;
#endif
`;

const FRAG_PARS = /* glsl */ `
uniform sampler2D uNoiseTex;
uniform float uSnowCover;
varying vec3 vWN;
varying vec3 vObj;
varying float vSnowCap;
varying vec3 vTint;
flat varying float vFadeIn;
flat varying float vFadeOut;
varying float vTreeH;
float tSnowF;
${GLSL_DITHER}
`;

const FRAG_COLOR = /* glsl */ `
{
  float dth = treeDither(gl_FragCoord.xy);
  if (vFadeIn < 0.999 && (1.0 - dth) >= vFadeIn) discard;
  if (vFadeOut < 0.999 && dth >= vFadeOut) discard;
  bool foliage = vUv.y <= 1.001;
  float fu = fract(vUv.x);
  float across = min(fu, 1.0 - fu); // 0 on the branch spine .. 0.5 between branches
#ifdef TREE_FRINGE
  // Serrated needle tips on bough edges (near trees only; fades once sub-pixel).
  if (foliage) {
    float tooth = abs(fract(vUv.x * 6.0 + vObj.y * 0.37) - 0.5) * 2.0;
    float fw = fwidth(vUv.y);
    float depth = 0.16 * (1.0 - smoothstep(0.02, 0.06, fw));
    if (vUv.y > 1.0 - depth * (0.35 + 0.65 * tooth)) discard;
  }
#endif
  vec3 wn = normalize(vWN);
  vec4 nz = texture(uNoiseTex, vObj.xz * 0.35 + vObj.y * 0.13);
  vec4 nz2 = texture(uNoiseTex, vec2(vUv.x * 0.21, vUv.y * 0.9 + vObj.y * 0.05));
  vec3 base = vColor.rgb * vTint;
  if (foliage) {
    // Herringbone needles fanning off each branch spine; faded where they would alias.
    float f = vUv.y * 46.0 + across * 30.0;
    float needles = sin(f * 3.14159);
    float aa = 1.0 - smoothstep(0.35, 0.8, fwidth(f));
    base *= 0.82 + 0.3 * needles * aa + 0.3 * nz2.a;
    base *= 0.9 + 0.25 * smoothstep(0.35, 0.0, across) ; // branch spines slightly lighter
  } else {
    // Bark: vertical furrows.
    float furrow = texture(uNoiseTex, vec2(vUv.x * 2.0, vObj.y * 0.08)).a;
    base *= 0.7 + 0.6 * furrow;
  }
  float up = smoothstep(0.05, 0.6, wn.y);
  // Snow rides the branch spines (lobe centres, integer u) and thins toward the tips.
  float spine = 1.0 - 2.0 * across;
  float load = foliage ? spine * (1.0 - 0.45 * vUv.y) + (1.0 - vUv.y) * 0.35 + (nz.g - 0.5) * 0.7 : 0.7 + (nz.g - 0.5) * 0.6;
  float cap = vSnowCap * uSnowCover * up * smoothstep(0.25, 0.75, load);
  float sn = smoothstep(0.3, 0.5, cap);
  tSnowF = sn;
  // Snow clumps: soft-edged, slightly shadowed toward their rims.
  vec3 snowCol = vec3(0.82, 0.84, 0.88) * (0.9 + 0.1 * nz.b) * mix(0.82, 1.0, smoothstep(0.3, 0.8, cap));
  diffuseColor.rgb = mix(base, snowCol, sn);
}
`;

export interface TreeMaterialOptions {
  shared: TreeShared;
  lodRange: THREE.Vector4;
  key: string;
  /** Impostor bake: output unlit albedo, or view-space normals. */
  bake?: 'albedo' | 'normal';
  /** Serrated needle fringes (near LOD only). */
  fringe?: boolean;
}

export function createTreeMaterial(o: TreeMaterialOptions): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, side: THREE.FrontSide });
  m.name = 'tree-' + o.key;
  const uLodRange = { value: o.lodRange };
  m.userData.lodRange = o.lodRange;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, o.shared, { uLodRange });
    let vs = shader.vertexShader;
    vs = vs.replace('#include <common>', `#include <common>\n#define TREE_MAIN\n${VERT_PARS}`);
    vs = replaceInclude(vs, 'begin_vertex', VERT_BEGIN);
    shader.vertexShader = vs;
    let fs = shader.fragmentShader;
    fs = fs.replace('#include <common>', `#include <common>\n${FRAG_PARS}`);
    fs = replaceInclude(fs, 'color_fragment', FRAG_COLOR);
    fs = replaceInclude(fs, 'roughnessmap_fragment', 'float roughnessFactor = mix(0.88, 0.72, tSnowF);');
    // 8-bit bake target: store sRGB-encoded albedo so dark needles keep precision.
    if (o.bake === 'albedo') fs = replaceInclude(fs, 'opaque_fragment', 'gl_FragColor = vec4(sRGBTransferOETF(vec4(diffuseColor.rgb, 1.0)).rgb, 1.0);');
    if (o.bake === 'normal') fs = replaceInclude(fs, 'opaque_fragment', 'gl_FragColor = vec4(normal * 0.5 + 0.5, 1.0);');
    shader.fragmentShader = fs;
  };
  // Uniform values differ per material, the program is shared.
  const key = 'frostline-tree-2' + (o.bake ?? '') + (o.fringe ? '-fringe' : '');
  m.customProgramCacheKey = () => key;
  if (o.bake) m.defines = { ...(m.defines ?? {}), TREE_BAKE: '' };
  if (o.fringe) m.defines = { ...(m.defines ?? {}), TREE_FRINGE: '' };
  // vUv must exist: force the uv varying on.
  m.defines = { ...(m.defines ?? {}), USE_UV: '' };
  return m;
}

/** Shadow depth material with identical sway. */
export function createTreeDepthMaterial(shared: TreeShared): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial();
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared, { uLodRange: { value: new THREE.Vector4() } });
    let vs = shader.vertexShader;
    vs = vs.replace('#include <common>', `#include <common>\n${VERT_PARS}`);
    vs = replaceInclude(vs, 'begin_vertex', VERT_BEGIN);
    shader.vertexShader = vs;
  };
  m.customProgramCacheKey = () => 'frostline-tree-depth-1';
  return m;
}
