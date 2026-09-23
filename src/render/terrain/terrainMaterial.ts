// Terrain materials: MeshStandardMaterial extended via onBeforeCompile so the atmosphere's
// lighting, cascaded shadows and fog keep working. Vertex stage = CDLOD geomorph + exact
// Terrain.heightAt(); fragment stage = stylised snow / rock / lake ice / creeks / snow trails.
import * as THREE from 'three';
import { GLSL_HASH, GLSL_TERRAIN_HEIGHT } from '../shaders/common';
import { hookedLightsChunk, replaceInclude } from '../shaders/lighting';
import type { TerrainGPU } from './TerrainGPU';
import { MM_LEVELS } from './TerrainGPU';
import { SNOW_TILE, type WorldTextures } from '../ProceduralTextures';

export interface TerrainUniforms {
  [k: string]: THREE.IUniform;
}

const VERT_PARS = /* glsl */ `
attribute vec4 aPatch; // originX, originZ, spacing, level (grid coords come from position.xz)
uniform vec3 tLodCam;
uniform vec2 tMorph[${MM_LEVELS}];
uniform sampler2D tDataTex;
${GLSL_TERRAIN_HEIGHT}
vec2 tDataUV(vec2 xz) { return (xz + tDims.x + 0.5 * tDims.y) / ((tDims.z + 1.0) * tDims.y); }
vec2 tMirrorSign(vec2 uv) { return 1.0 - 2.0 * mod(floor(uv), 2.0); }
#ifdef T_MAIN
varying vec3 vTWorld;
varying vec2 vTDGrad;
#endif
void terrainVertex(out vec3 pos, out vec3 nrm) {
  float spacing = aPatch.z;
  vec2 grid = position.xz;
  vec2 p = aPatch.xy + grid * spacing;
  vec2 uv0 = tDataUV(p);
  float hApprox = textureLod(tDataTex, uv0, 0.0).r;
  float d = distance(tLodCam, vec3(p.x, hApprox, p.y));
  int lvl = int(aPatch.w + 0.5);
  float k = clamp((d - tMorph[lvl].x) * tMorph[lvl].y, 0.0, 1.0);
  p -= mod(grid, 2.0) * spacing * k;
  // Detail-octave gradients alias once vertices are sparser than ~1/4 wavelength: fade them.
  vec2 fade = vec2(1.0 - smoothstep(4.0, 8.0, spacing), 1.0 - smoothstep(1.5, 3.0, spacing));
  vec2 dg;
  float h = tHeightAt(p, fade, dg);
  pos = vec3(p.x, h, p.y);
  vec2 uv = tDataUV(p);
  vec2 s = textureLod(tDataTex, uv, 0.0).yz * tMirrorSign(uv) + dg;
  nrm = normalize(vec3(-s.x, 1.0, -s.y));
#ifdef T_MAIN
  vTWorld = pos;
  vTDGrad = dg;
#endif
}
`;

const FRAG_PARS = /* glsl */ `
#define SNOW_TILE ${SNOW_TILE.toFixed(1)}
uniform sampler2D tDataTex;
uniform sampler2D tMaskTex;
uniform sampler2D tNoiseTex;
uniform sampler2D tSnowTex;
uniform sampler2D tRockTex;
uniform sampler2D tTrailTex;
uniform vec4 tDims;
uniform vec4 tTrailRect; // originX, originZ, 1/size, texel (uv)
uniform float tTrailDepth;
uniform float tTime;
uniform float tWindAngle;
uniform float tSparkle;
uniform float tEnvFallback;
uniform vec3 tSkyColor;
uniform vec3 tFogColor;
varying vec3 vTWorld;
varying vec2 vTDGrad;
${GLSL_HASH}
vec2 tDataUV(vec2 xz) { return (xz + tDims.x + 0.5 * tDims.y) / ((tDims.z + 1.0) * tDims.y); }
vec2 tMirrorSign(vec2 uv) { return 1.0 - 2.0 * mod(floor(uv), 2.0); }

// Surface outputs consumed by the lighting hooks.
vec3 tAlbedo;
float tRough;
vec3 tN;
float tAO;
float tGlint;
float tSSS;
float tDist;

// Voronoi edge distance (F2 - F1), ~0 on cell borders.
float tVoronoiEdge(vec2 p) {
  vec2 ip = floor(p);
  vec2 fp = fract(p);
  float d1 = 8.0, d2 = 8.0;
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 r = g + hash22(ip + g) - fp;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  return sqrt(d2) - sqrt(d1);
}

float tTrailH(vec2 uv) {
  vec4 c = texture(tTrailTex, uv);
  return c.g * 0.45 - c.r;
}

void terrainSurface() {
  vec3 P = vTWorld;
  vec3 toCam = cameraPosition - P;
  float dist = length(toCam);
  tDist = dist;
  vec3 V = toCam / max(dist, 1e-4);
  vec2 uv = tDataUV(P.xz);
  vec4 D = texture(tDataTex, uv);
  vec2 slope = D.yz * tMirrorSign(uv) + vTDGrad;
  vec3 Nm = normalize(vec3(-slope.x, 1.0, -slope.y));
  vec4 M = texture(tMaskTex, uv);
  float lake = M.r;
  float flow = M.g;
  float forest = M.b;
  float cav = clamp(D.w / 4.0, -1.0, 1.0);

  vec4 nA = texture(tNoiseTex, P.xz * (1.0 / 173.0));
  vec4 nB = texture(tNoiseTex, P.xz * (1.0 / 41.0) + 0.31);
  vec4 nC = texture(tNoiseTex, P.xz * (1.0 / 7.3) + 0.67);
  vec4 nD = texture(tNoiseTex, P.xz * (1.0 / 1300.0) + 0.13);

  // ---------------- snow: wind-sculpted micro relief
  // Ripples keep one prevailing orientation (rotating around the world origin would smear them);
  // a second, cross-wind set fades in and out with large-scale noise.
  float wa = tWindAngle;
  vec2 cs = vec2(cos(wa), sin(wa));
  mat2 R = mat2(cs.x, -cs.y, cs.y, cs.x);
  vec2 cs2 = vec2(cos(wa + 0.85), sin(wa + 0.85));
  mat2 R2 = mat2(cs2.x, -cs2.y, cs2.y, cs2.x);
  vec2 wxz = R * P.xz;
  vec4 s1 = texture(tSnowTex, wxz / SNOW_TILE);
  vec4 s2 = texture(tSnowTex, (R2 * P.xz) / (SNOW_TILE * 3.3) + vec2(0.37, 0.11));
  vec2 g1 = transpose(R) * ((s1.xy - 0.5) * 4.0);
  vec2 g2 = transpose(R2) * ((s2.xy - 0.5) * 4.0 / 3.3);
  float mixB = smoothstep(0.35, 0.65, nD.g);
  float exposure = clamp(0.5 + 0.9 * max(-cav, 0.0) - forest * 0.7 + (nA.r - 0.5) * 0.8, 0.12, 1.0);
  float microFade = 1.0 - smoothstep(30.0, 140.0, dist);
  vec2 mg = (g1 * (0.9 - 0.5 * mixB) + g2 * (0.6 + 1.2 * mixB)) * exposure * microFade;

  vec3 snowAlb = vec3(0.86, 0.875, 0.9);
  snowAlb *= 0.95 + 0.05 * nB.r + 0.03 * (s1.z - 0.5) * microFade;
  snowAlb *= mix(vec3(1.0), vec3(0.94, 0.965, 1.0), clamp(cav, 0.0, 1.0));
  float snowRough = 0.8 + 0.12 * nC.a - 0.28 * s1.w * exposure * microFade;

  // Forest floor: needle litter and shaded tree wells under the canopy.
  float litter = forest * smoothstep(0.45, 0.75, nC.r * 0.7 + nB.g * 0.5);
  snowAlb = mix(snowAlb, vec3(0.5, 0.46, 0.42), litter * 0.18);

  // Creek beds: faint blue-grey channel, glassy ice in the thalweg.
  float creek = smoothstep(0.68, 0.84, flow) * (1.0 - lake);
  float creekIce = smoothstep(0.86, 0.94, flow + (nC.g - 0.5) * 0.08) * (1.0 - lake);
  snowAlb = mix(snowAlb, snowAlb * vec3(0.84, 0.91, 0.99), creek * 0.55);
  snowAlb = mix(snowAlb, vec3(0.2, 0.3, 0.36), creekIce * 0.7);
  snowRough = mix(snowRough, 0.25, creekIce * 0.8);

  vec2 ss = slope + mg;

  // ---------------- snow trails (ski tracks, footprints) — crisp normal detail + compaction
  float trail = 0.0;
  vec2 tuv = (P.xz - tTrailRect.xy) * tTrailRect.z;
  if (tuv.x > 0.0 && tuv.y > 0.0 && tuv.x < 1.0 && tuv.y < 1.0) {
    float e = tTrailRect.w;
    vec4 c = texture(tTrailTex, tuv);
    float hx = tTrailH(tuv + vec2(e, 0.0)) - tTrailH(tuv - vec2(e, 0.0));
    float hz = tTrailH(tuv + vec2(0.0, e)) - tTrailH(tuv - vec2(0.0, e));
    float worldTexel = 2.0 * e / tTrailRect.z;
    float edgeFade = smoothstep(0.0, 0.08, min(min(tuv.x, tuv.y), min(1.0 - tuv.x, 1.0 - tuv.y)));
    ss += vec2(hx, hz) / worldTexel * tTrailDepth * edgeFade;
    trail = c.r * edgeFade;
    snowAlb = mix(snowAlb, snowAlb * vec3(0.86, 0.9, 0.97), trail);
    snowAlb *= 1.0 + c.g * 0.04 * edgeFade;
    snowRough = mix(snowRough, 0.55, trail);
  }

  vec3 Ns = normalize(vec3(-ss.x, 1.0, -ss.y));

  // ---------------- rock on steep faces (triplanar, strata, snow on ledges)
  // Exposure is decided at large scale so faces read as coherent ribs of rock with snow-filled
  // gullies between them (convex = wind-scoured rock, concave/drainage = snow).
  float steep = 1.0 - Nm.y;
  float ribs = clamp(-cav, -1.0, 1.0);
  float gully = smoothstep(0.5, 0.8, flow);
  float rockNoise = (nB.b - 0.5) * 0.12 + (nA.g - 0.5) * 0.12;
  float rockMask = smoothstep(0.16, 0.25, steep + rockNoise + ribs * 0.2 - gully * 0.1) * (1.0 - lake);
  vec3 rockAlb = vec3(0.07);
  vec3 Nr = Nm;
  float rockSnow = 0.0;
  float rockAO = 1.0;
  if (rockMask > 0.002) {
    vec3 w = pow(abs(Nm), vec3(4.0));
    w /= (w.x + w.y + w.z);
    const float sc = 1.0 / 7.0;
    vec4 rx = texture(tRockTex, P.zy * sc);
    vec4 rz = texture(tRockTex, P.xy * sc + 0.5);
    vec4 ry = texture(tRockTex, P.xz * sc + 0.25);
    vec4 bx = texture(tRockTex, P.zy * (sc * 0.21) + 0.61);
    vec4 bz = texture(tRockTex, P.xy * (sc * 0.21) + 0.17);
    const float amp = 7.0; // texture slopes were encoded for an 8 m tile; we use 7 m
    vec2 gx = (rx.xy - 0.5) * 4.0 * (8.0 / amp) + (bx.xy - 0.5) * 4.0 * 0.21 * 3.0;
    vec2 gz = (rz.xy - 0.5) * 4.0 * (8.0 / amp) + (bz.xy - 0.5) * 4.0 * 0.21 * 3.0;
    vec2 gy = (ry.xy - 0.5) * 4.0;
    vec3 grad = w.x * vec3(0.0, gx.y, gx.x) + w.z * vec3(gz.x, gz.y, 0.0) + w.y * vec3(gy.x, 0.0, gy.y);
    float strataY = (P.y + dot(P.xz, vec2(0.11, 0.06)) + (nB.r - 0.5) * 8.0) / 5.0;
    float band = fract(strataY);
    float bandId = floor(strataY);
    // Ledges are ~5 m apart: fade them before they turn into sub-pixel hatching.
    float ledge = smoothstep(0.84, 0.93, band) * (1.0 - smoothstep(0.96, 1.0, band)) * (1.0 - smoothstep(180.0, 420.0, dist));
    // Step profile: each stratum overhangs slightly -> up-facing lip at its top.
    grad.y += (smoothstep(0.8, 0.95, band) - 0.25) * 0.8;
    float detailFade = 1.0 - smoothstep(60.0, 260.0, dist);
    Nr = normalize(Nm - (grad - dot(grad, Nm) * Nm) * mix(0.35, 0.9, detailFade));
    float h = w.x * (rx.z * 0.6 + bx.z * 0.4) + w.z * (rz.z * 0.6 + bz.z * 0.4) + w.y * ry.z;
    float av = w.x * (rx.w * 0.6 + bx.w * 0.4) + w.z * (rz.w * 0.6 + bz.w * 0.4) + w.y * ry.w;
    float hb = hash12(vec2(bandId, 7.3));
    vec3 cool = vec3(0.062, 0.063, 0.078);
    vec3 warm = vec3(0.098, 0.08, 0.064);
    rockAlb = mix(cool, warm, clamp(hb * 0.7 + (nA.b - 0.5) * 0.6, 0.0, 1.0)) * (0.6 + 0.8 * av) * (0.85 + 0.3 * hash12(vec2(bandId, 1.1)));
    // Lichen / mineral stains, faded out at distance.
    float lichen = smoothstep(0.62, 0.8, nC.b) * (1.0 - smoothstep(40.0, 120.0, dist));
    rockAlb = mix(rockAlb, vec3(0.16, 0.15, 0.1), lichen * 0.3);
    rockAO = 0.55 + 0.45 * h;
    // Snow caught on strata ledges and on the flattest facets; never on overhang-steep rock.
    float flatFacet = smoothstep(0.82, 0.93, Nr.y + (nC.g - 0.5) * 0.12);
    rockSnow = max(ledge * (0.55 + 0.45 * nC.g), flatFacet) * (1.0 - smoothstep(0.42, 0.62, steep));
    // Thin rock at the patch margins gets a dusting instead of a hard edge.
    rockSnow = max(rockSnow, (1.0 - smoothstep(0.35, 0.8, rockMask)) * 0.6);
  }
  float rockF = rockMask * (1.0 - rockSnow);

  vec3 N = normalize(mix(Ns, Nr, rockMask * 0.85));
  vec3 alb = mix(snowAlb, rockAlb, rockF);
  float rough = mix(snowRough, 0.72 + 0.2 * nC.a, rockF);
  float ao = clamp(1.0 - max(cav, 0.0) * 0.28 - forest * 0.3, 0.45, 1.0) * mix(1.0, rockAO, rockF);
  float snowness = 1.0 - rockF;

  // ---------------- frozen lake: black ice, cracks, bubbles, wind-blown drifts
  if (lake > 0.002) {
    float shore = smoothstep(0.3, 0.7, lake + (nC.r - 0.5) * 0.35);
    vec2 par = -V.xz / max(V.y, 0.2);
    float fineFade = 1.0 - smoothstep(25.0, 90.0, dist);
    float lw = 0.02 + dist * 0.0006;
    float crack1 = 1.0 - smoothstep(0.0, lw, tVoronoiEdge(P.xz / 11.0));
    float crack2 = (1.0 - smoothstep(0.0, 0.05, tVoronoiEdge((P.xz + par * 0.25) / 3.1 + 17.0))) * fineFade;
    float crack3 = (1.0 - smoothstep(0.0, 0.06, tVoronoiEdge((P.xz + par * 0.6) / 1.3 + 41.0))) * fineFade;
    vec2 bq = (P.xz + par * 0.45) * 6.0;
    vec2 bi = floor(bq);
    vec2 bf = fract(bq) - 0.5 - (hash22(bi) - 0.5) * 0.6;
    float bub = step(0.8, hash12(bi + 3.1)) * smoothstep(0.1, 0.03, length(bf)) * fineFade;
    vec3 deep = vec3(0.014, 0.04, 0.05) * (0.75 + 0.5 * nA.r + 0.3 * nB.g);
    vec3 ice = deep + vec3(0.32, 0.42, 0.46) * crack3 * 0.18 + vec3(0.45, 0.55, 0.6) * crack2 * 0.3
             + vec3(0.7, 0.8, 0.85) * crack1 * 0.55 + vec3(0.55, 0.62, 0.66) * bub * 0.6;
    // Drifts: long streaks along the wind, thicker near the shore.
    vec2 dq = R * P.xz;
    float streak = texture(tNoiseTex, dq * vec2(1.0 / 90.0, 1.0 / 16.0)).r * 0.7 + texture(tNoiseTex, dq * vec2(1.0 / 30.0, 1.0 / 6.0) + 0.5).g * 0.3;
    float drift = smoothstep(0.5, 0.64, streak + (1.0 - lake) * 0.6 + nA.g * 0.15 - 0.08);
    float dust = smoothstep(0.35, 0.6, streak) * 0.35;
    vec3 iceAlb = mix(ice, snowAlb, max(drift, dust * 0.4));
    float iceRough = mix(0.05 + crack1 * 0.25 + dust * 0.2, snowRough, drift);
    vec3 iceN = normalize(vec3((nC.gb - 0.5) * 0.03, 1.0).xzy);
    iceN = normalize(mix(iceN, Ns, drift));
    alb = mix(alb, iceAlb, shore);
    rough = mix(rough, iceRough, shore);
    N = normalize(mix(N, iceN, shore));
    snowness = mix(snowness, drift, shore);
  }

  tAlbedo = alb;
  tRough = rough;
  tN = N;
  tAO = ao;
  tGlint = snowness * (1.0 - trail * 0.8) * (1.0 - creekIce);
  tSSS = snowness;
}

// Snow glints: tiny mirror facets in world-space cells sized to ~1.5 px at any distance.
float tSparkleTerm(vec3 P, vec3 Nw, vec3 Vw, vec3 Lw, float dist) {
  float cell = max(0.004, dist * 0.0017);
  float lv = log2(cell);
  float l0 = floor(lv);
  float fl = lv - l0;
  vec3 H = normalize(Lw + Vw);
  float s = 0.0;
  for (int k = 0; k < 2; k++) {
    float csz = exp2(l0 + float(k));
    vec3 q = P / csz;
    vec3 c = floor(q);
    vec3 r = hash33(c);
    vec3 f = fract(q) - 0.5 - (r - 0.5) * 0.5;
    float spot = smoothstep(0.28, 0.06, length(f));
    vec3 fn = normalize(Nw * 1.3 + (hash33(c + 7.31) - 0.5) * 2.0);
    float g = pow(max(dot(fn, H), 0.0), 900.0);
    float w = k == 0 ? 1.0 - fl : fl;
    s += spot * g * w * step(0.4, r.x);
  }
  return s;
}
`;

const PRE_DIRECT = /* glsl */ ``;

const POST_DIRECT = /* glsl */ `
  float ndlT = dot(geometryNormal, directLight.direction);
  // Soft wrap + cool subsurface scatter: snow never has a hard terminator.
  float wrapT = max(0.0, (ndlT + 0.4) / 1.4);
  float extraT = max(0.0, wrapT - max(ndlT, 0.0));
  reflectedLight.directDiffuse += directLight.color * tAlbedo * extraT * vec3(0.45, 0.68, 1.0) * 0.55 * tSSS * RECIPROCAL_PI;
  if (tGlint > 0.01 && ndlT > 0.0) {
    vec3 Lw = normalize((vec4(directLight.direction, 0.0) * viewMatrix).xyz);
    vec3 Vw = normalize(cameraPosition - vTWorld);
    float sp = tSparkleTerm(vTWorld, tN, Vw, Lw, tDist);
    reflectedLight.directSpecular += directLight.color * sp * tSparkle * tGlint * smoothstep(0.0, 0.2, ndlT);
  }
`;

export interface TerrainMaterials {
  material: THREE.MeshStandardMaterial;
  depthMaterial: THREE.MeshDepthMaterial;
  collapseMaterial: THREE.ShaderMaterial;
  uniforms: TerrainUniforms;
}

export function createTerrainMaterials(
  gpu: TerrainGPU,
  tex: WorldTextures,
  trail: TerrainUniforms,
  morph: THREE.Vector2[],
  shadowMorph: THREE.Vector2[],
): TerrainMaterials {
  const uniforms: TerrainUniforms = {
    ...gpu.uniforms,
    tLodCam: { value: new THREE.Vector3() },
    tMorph: { value: morph },
    tNoiseTex: { value: tex.noise },
    tSnowTex: { value: tex.snow },
    tRockTex: { value: tex.rock },
    tTime: { value: 0 },
    tWindAngle: { value: 0.6 },
    tSparkle: { value: 60 },
    tEnvFallback: { value: 1 },
    tSkyColor: { value: new THREE.Color(0.5, 0.65, 0.85) },
    tFogColor: { value: new THREE.Color(0.75, 0.8, 0.88) },
    ...trail,
  };

  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0 });
  material.name = 'terrain';
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    let vs = shader.vertexShader;
    vs = vs.replace('#include <common>', `#include <common>\n#define T_MAIN\n${VERT_PARS}`);
    vs = replaceInclude(vs, 'beginnormal_vertex', 'vec3 tPos; vec3 objectNormal; terrainVertex(tPos, objectNormal);');
    vs = replaceInclude(vs, 'begin_vertex', 'vec3 transformed = tPos;');
    shader.vertexShader = vs;

    let fs = shader.fragmentShader;
    fs = fs.replace('#include <common>', `#include <common>\n${FRAG_PARS}`);
    fs = replaceInclude(fs, 'map_fragment', 'terrainSurface();\ndiffuseColor.rgb = tAlbedo;');
    fs = replaceInclude(fs, 'roughnessmap_fragment', 'float roughnessFactor = tRough;');
    fs = replaceInclude(
      fs,
      'normal_fragment_begin',
      'float faceDirection = 1.0;\nvec3 normal = normalize((viewMatrix * vec4(tN, 0.0)).xyz);\nvec3 nonPerturbedNormal = normal;',
    );
    fs = replaceInclude(fs, 'normal_fragment_maps', '');
    fs = replaceInclude(fs, 'lights_fragment_begin', hookedLightsChunk(PRE_DIRECT, POST_DIRECT));
    fs = replaceInclude(
      fs,
      'aomap_fragment',
      /* glsl */ `
      reflectedLight.indirectDiffuse *= tAO;
      reflectedLight.indirectSpecular *= tAO;
      if (tEnvFallback > 0.5) {
        // No environment map yet: reflect a simple sky gradient so ice still reads as glossy.
        vec3 Vw = normalize(cameraPosition - vTWorld);
        vec3 Rw = reflect(-Vw, tN);
        vec3 sky = mix(tFogColor, tSkyColor, smoothstep(-0.05, 0.5, Rw.y));
        float fr = 0.02 + 0.98 * pow(1.0 - max(dot(tN, Vw), 0.0), 5.0);
        reflectedLight.indirectSpecular += sky * fr * pow(1.0 - tRough, 3.0) * tAO;
      }`,
    );
    shader.fragmentShader = fs;
  };
  material.customProgramCacheKey = () => 'frostline-terrain-1';

  const depthMaterial = new THREE.MeshDepthMaterial();
  const depthUniforms = { ...uniforms, tMorph: { value: shadowMorph } };
  depthMaterial.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, depthUniforms);
    let vs = shader.vertexShader;
    vs = vs.replace('#include <common>', `#include <common>\n${VERT_PARS}`);
    vs = replaceInclude(vs, 'begin_vertex', 'vec3 transformed; vec3 tNrmUnused; terrainVertex(transformed, tNrmUnused);');
    shader.vertexShader = vs;
  };
  depthMaterial.customProgramCacheKey = () => 'frostline-terrain-depth-1';

  // Main-pass material for the shadow-only mesh: emits no fragments at all.
  const collapseMaterial = new THREE.ShaderMaterial({
    vertexShader: 'void main() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }',
    fragmentShader: 'void main() { discard; }',
    depthWrite: false,
    depthTest: false,
    colorWrite: false,
  });

  return { material, depthMaterial, collapseMaterial, uniforms };
}
