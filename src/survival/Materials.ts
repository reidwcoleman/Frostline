// Shared, lazily-created materials for everything the survival module draws: cabin logs,
// end grain, planks, chinking, roof snow, stones, hide, spruce boughs, ice, ash.
//
// All of them are MeshStandardMaterial extended through onBeforeCompile so lighting, shadows and
// the atmosphere agent's fog stay consistent. Detail is procedural (no textures): each material gets
// a small GLSL "surface" function that tweaks albedo/roughness and perturbs the normal from a
// procedural height field (derivative bump mapping), plus an optional snow layer driven by the
// per-vertex `aSnow` attribute × how much the surface faces up.
import * as THREE from 'three';

export type MatKind =
  | 'bark' // round logs (walls, sills, purlins, firewood)
  | 'endgrain' // sawn/chopped log ends
  | 'plank' // floorboards, door, shutters, gable boards, roof decking
  | 'chinking' // lime mortar between wall logs
  | 'snow' // roof snow, snow caps
  | 'stone' // hearth stones, loose stones
  | 'hide' // bedroll blanket
  | 'bough' // spruce branches (alpha-tested fronds)
  | 'ice' // icicles
  | 'ash' // fire bed (glows via uGlow)
  | 'charred'; // burnt fire logs

// ---------------------------------------------------------------- GLSL helpers
const NOISE = /* glsl */ `
float fl_hash3(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float fl_noise3(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(fl_hash3(i + vec3(0,0,0)), fl_hash3(i + vec3(1,0,0)), f.x),
                 mix(fl_hash3(i + vec3(0,1,0)), fl_hash3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(fl_hash3(i + vec3(0,0,1)), fl_hash3(i + vec3(1,0,1)), f.x),
                 mix(fl_hash3(i + vec3(0,1,1)), fl_hash3(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fl_fbm3(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * fl_noise3(p); p = p * 2.03 + 11.7; a *= 0.5; }
  return s;
}
// Derivative-based bump: perturb the view-space normal by a procedural height field.
vec3 fl_bump(vec3 surfPos, vec3 n, float h, float strength) {
  vec3 sx = dFdx(surfPos);
  vec3 sy = dFdy(surfPos);
  vec3 r1 = cross(sy, n);
  vec3 r2 = cross(n, sx);
  float det = dot(sx, r1);
  float dbx = dFdx(h) * strength;
  float dby = dFdy(h) * strength;
  vec3 grad = sign(det) * (dbx * r1 + dby * r2);
  return normalize(abs(det) * n - grad);
}
`;

/**
 * Per-kind surface code. Available inputs: vUv (m), vObj (object-space pos), vWPos, vWNrm, vSnow,
 * vColor (vertex colour). Must write: alb (vec3 albedo multiplier), rough (float), h (height for bump),
 * bumpK (bump strength), snowK (0..1 how much snow may settle; multiplied by aSnow and up-facing).
 */
const SURFACE: Record<MatKind, string> = {
  bark: /* glsl */ `
    // Round cabin logs: long fibres along u, bark fissures, weathered silver patches and knots.
    vec2 q = vUv;
    float fib = fl_noise3(vec3(q.x * 1.3, q.y * 26.0, 0.0));
    float fis = fl_noise3(vec3(q.x * 2.2, q.y * 9.0, 3.1));
    float fissure = smoothstep(0.62, 0.78, fis);
    float patchN = fl_fbm3(vec3(q.x * 0.9, q.y * 2.6, 7.0));
    float weathered = smoothstep(0.42, 0.62, patchN);
    float knot = smoothstep(0.86, 0.95, fl_noise3(vec3(q.x * 1.7, q.y * 3.5, 19.0)));
    alb = mix(vec3(1.0), vec3(1.28, 1.2, 1.1), weathered * 0.8);
    alb *= 0.78 + 0.34 * fib;
    alb *= 1.0 - fissure * 0.55;
    alb *= 1.0 - knot * 0.45;
    rough = 0.82 + fissure * 0.12;
    h = fib * 0.35 - fissure * 1.0 - knot * 0.5;
    bumpK = 0.006;
    snowK = 1.0;
  `,
  endgrain: /* glsl */ `
    // Sawn log end: growth rings around the centre (uv = local disc coords in m), radial checks.
    float r = length(vUv);
    float ang = atan(vUv.y, vUv.x);
    float wob = fl_noise3(vec3(vUv * 9.0, 1.0)) * 0.012;
    float rings = sin((r + wob) * 190.0) * 0.5 + 0.5;
    float crack = smoothstep(0.93, 0.99, fl_noise3(vec3(ang * 3.0, r * 1.5, 5.0))) * smoothstep(0.02, 0.06, r);
    float heart = 1.0 - smoothstep(0.0, 0.05, r);
    alb = vec3(1.0) * (0.86 + 0.16 * rings);
    alb *= 1.0 - crack * 0.6;
    alb = mix(alb, alb * vec3(0.8, 0.62, 0.45), heart * 0.7);
    rough = 0.9;
    h = rings * 0.3 - crack;
    bumpK = 0.0015;
    snowK = 0.6;
  `,
  plank: /* glsl */ `
    // Split/sawn planks: grain along u, a few darker knots, per-plank tint via vertex colour.
    float g1 = fl_noise3(vec3(vUv.x * 0.7, vUv.y * 38.0, 2.0));
    float g2 = fl_noise3(vec3(vUv.x * 3.0, vUv.y * 90.0, 4.0));
    float knot = smoothstep(0.88, 0.96, fl_noise3(vec3(vUv.x * 2.1, vUv.y * 6.0, 13.0)));
    alb = vec3(0.82 + 0.22 * g1) * (0.92 + 0.1 * g2);
    alb *= 1.0 - knot * 0.5;
    rough = 0.78;
    h = g1 * 0.6 + g2 * 0.3 - knot;
    bumpK = 0.0012;
    snowK = 1.0;
  `,
  chinking: /* glsl */ `
    float n = fl_fbm3(vObj * 14.0);
    alb = vec3(0.86 + 0.18 * n);
    rough = 0.95;
    h = n;
    bumpK = 0.004;
    snowK = 0.0;
  `,
  snow: /* glsl */ `
    // Soft wind-packed snow with faint sastrugi ripples and cold blue in the shadows (from lighting).
    float n = fl_fbm3(vWPos * vec3(1.6, 1.6, 1.6));
    float fine = fl_noise3(vWPos * 14.0);
    alb = vec3(0.97 + 0.05 * n);
    rough = 0.8 + 0.12 * fine;
    h = n * 1.0 + fine * 0.15;
    bumpK = 0.03;
    snowK = 0.0;
  `,
  stone: /* glsl */ `
    float n = fl_fbm3(vObj * 5.0 + vColor.r * 10.0);
    float speck = step(0.82, fl_noise3(vObj * 38.0));
    float lichen = smoothstep(0.62, 0.75, fl_noise3(vObj * 3.0 + 7.0));
    alb = vec3(0.76 + 0.38 * n) * (1.0 - speck * 0.25);
    alb = mix(alb, alb * vec3(1.15, 1.1, 0.8), lichen * 0.5);
    rough = 0.88;
    h = n + speck * 0.2;
    bumpK = 0.015;
    snowK = 1.0;
  `,
  hide: /* glsl */ `
    // Tanned hide with a fur side: soft streaky fur along u, darker spine stripe.
    float fur = fl_noise3(vec3(vUv.x * 30.0, vUv.y * 90.0, 1.0));
    float fur2 = fl_noise3(vec3(vUv.x * 7.0, vUv.y * 18.0, 9.0));
    float sd = (vUv.y - 0.5) * 7.0; // (pow() of a negative base is undefined in GLSL)
    float stripe = exp(-sd * sd);
    alb = vec3(0.8 + 0.35 * fur2) * (0.85 + 0.2 * fur);
    alb *= 1.0 - stripe * 0.35;
    rough = 0.97;
    h = fur * 0.5 + fur2 * 0.5;
    bumpK = 0.004;
    snowK = 0.8;
  `,
  bough: /* glsl */ `
    float n = fl_noise3(vWPos * 3.0);
    alb = vec3(0.8 + 0.4 * n);
    rough = 0.9;
    h = 0.0;
    bumpK = 0.0;
    snowK = 1.0;
  `,
  ice: /* glsl */ `
    float n = fl_noise3(vObj * 20.0);
    alb = vec3(0.9 + 0.1 * n);
    rough = 0.08 + 0.1 * n;
    h = n;
    bumpK = 0.001;
    snowK = 0.0;
  `,
  ash: /* glsl */ `
    // Ash & charcoal; glowing coals pulse with uGlow (set per fire).
    float n = fl_fbm3(vObj * 9.0);
    float coal = smoothstep(0.52, 0.7, fl_noise3(vObj * 16.0 + vec3(0.0, uTime * 0.05, 0.0)));
    float r = length(vObj.xz);
    alb = vec3(0.55 + 0.6 * n);
    rough = 0.97;
    h = n;
    bumpK = 0.004;
    snowK = 0.0;
    float pulse = 0.65 + 0.35 * fl_noise3(vec3(vObj.xz * 6.0, uTime * 0.9));
    glow = vec3(1.0, 0.32, 0.06) * coal * pulse * uGlow * (1.0 - smoothstep(0.25, 0.6, r)) * 3.5;
  `,
  charred: /* glsl */ `
    // Burnt firewood: black crackled char; embers glow where aSnow ("heat") is high.
    float cr = fl_noise3(vec3(vUv.x * 14.0, vUv.y * 22.0, 3.0));
    float cells = smoothstep(0.35, 0.5, abs(fl_noise3(vec3(vUv.x * 9.0, vUv.y * 9.0, 1.0)) - 0.5) * 2.0);
    alb = vec3(0.7 + 0.4 * cr);
    rough = 0.9;
    h = cr - cells;
    bumpK = 0.004;
    snowK = 0.0;
    float heat = vSnow; // charred logs reuse aSnow as "heat" (they never hold snow)
    glow = vec3(1.0, 0.28, 0.04) * (1.0 - cells) * heat * uGlow * 2.2 * (0.7 + 0.3 * fl_noise3(vec3(vUv * 5.0, uTime)));
  `,
};

// Base albedo colours (sRGB) and options per kind.
interface KindOpts {
  color: number;
  roughness: number;
  side?: THREE.Side;
  alphaTest?: number;
  map?: () => THREE.Texture;
  transparent?: boolean;
  opacity?: number;
}

const KIND: Record<MatKind, KindOpts> = {
  bark: { color: 0x7a5a40, roughness: 0.85 },
  endgrain: { color: 0xc49a6c, roughness: 0.9 },
  plank: { color: 0x8a6a4c, roughness: 0.8 },
  chinking: { color: 0xafa38e, roughness: 0.95 },
  snow: { color: 0xeef2f7, roughness: 0.85 },
  stone: { color: 0x6e6a66, roughness: 0.9 },
  hide: { color: 0x7a5234, roughness: 0.97, side: THREE.DoubleSide },
  bough: { color: 0x2c4a3a, roughness: 0.9, side: THREE.DoubleSide, alphaTest: 0.5, map: () => boughTexture() },
  ice: { color: 0xd8ecf8, roughness: 0.1, transparent: true, opacity: 0.82 },
  ash: { color: 0x3a3532, roughness: 0.97 },
  charred: { color: 0x2b2420, roughness: 0.9 },
};

// Snow colour mixed onto up-facing surfaces (linear-ish; matches the roof snow).
const SNOW_RGB = 'vec3(0.86, 0.89, 0.93)';

/** Shared time uniform (fires animate ash glow). Survival ticks it. */
export const matTime = { value: 0 };

/**
 * Up to 4 building interiors (see Structures.updateInteriors). Fragments of our materials inside a
 * roofed, walled volume get most of their sky ambient removed, so cabins are dark and cosy and the
 * fire actually lights the room. Per building, 3 × vec4:
 *   (originX, originZ, cos(yaw), sin(yaw)), (x0, x1, z0, z1) local wall lines,
 *   (floorY, eaveUndersideY, ridgeAlongX ? 1 : 0, enclosure 0..1)
 */
export const MAX_INTERIORS = 4;
export const interiorUniforms = {
  uBld: { value: Array.from({ length: MAX_INTERIORS * 3 }, () => new THREE.Vector4()) },
  uBldN: { value: 0 },
};
const ROOF_TAN = Math.tan((36 * Math.PI) / 180).toFixed(5);

const cache = new Map<string, THREE.MeshStandardMaterial>();

/**
 * Get the shared material of a kind. `variant` gives a separate instance (e.g. per-fire ash so
 * each fire can glow independently); variants share the compiled program.
 */
export function mat(kind: MatKind, variant?: string): THREE.MeshStandardMaterial {
  const key = variant ? `${kind}:${variant}` : kind;
  let m = cache.get(key);
  if (m) return m;
  m = createMaterial(kind);
  cache.set(key, m);
  return m;
}

/** Dispose a per-object material variant (e.g. a removed fire's ash). */
export function releaseMat(kind: MatKind, variant: string) {
  const key = `${kind}:${variant}`;
  const m = cache.get(key);
  if (!m) return;
  cache.delete(key);
  m.dispose();
}

function createMaterial(kind: MatKind): THREE.MeshStandardMaterial {
  const o = KIND[kind];
  const m = new THREE.MeshStandardMaterial({
    color: o.color,
    roughness: o.roughness,
    metalness: 0,
    vertexColors: true,
    side: o.side ?? THREE.FrontSide,
    alphaTest: o.alphaTest ?? 0,
    transparent: o.transparent ?? false,
    opacity: o.opacity ?? 1,
    map: o.map ? o.map() : null,
  });
  const glow = { value: 0 };
  m.userData.glow = glow;
  const surface = SURFACE[kind];
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = matTime;
    shader.uniforms.uGlow = glow;
    shader.uniforms.uBld = interiorUniforms.uBld;
    shader.uniforms.uBldN = interiorUniforms.uBldN;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        attribute float aSnow;
        varying float vSnow;
        varying vec2 vUvM;
        varying vec3 vObj;
        varying vec3 vWPos;
        varying vec3 vWNrm;`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        vSnow = aSnow;
        vUvM = uv;
        vObj = position;
        mat4 flModel = modelMatrix;
        #ifdef USE_INSTANCING
          flModel = modelMatrix * instanceMatrix;
        #endif
        vWPos = (flModel * vec4(position, 1.0)).xyz;
        vWNrm = normalize(mat3(flModel) * normal);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        uniform float uTime;
        uniform float uGlow;
        uniform vec4 uBld[${MAX_INTERIORS * 3}];
        uniform int uBldN;
        varying float vSnow;
        varying vec2 vUvM;
        varying vec3 vObj;
        varying vec3 vWPos;
        varying vec3 vWNrm;
        ${NOISE}
        vec3 flAlb; float flRough; float flH; float flBumpK; float flSnow; vec3 flGlow; float flInt;
        // 0..1: how deep inside an enclosed building this fragment is (ambient occlusion for interiors).
        float flInterior(vec3 p) {
          float k = 0.0;
          for (int i = 0; i < ${MAX_INTERIORS}; i++) {
            if (i >= uBldN) break;
            vec4 a = uBld[i * 3], b = uBld[i * 3 + 1], c = uBld[i * 3 + 2];
            vec2 d = p.xz - a.xy;
            float lx = d.x * a.z - d.y * a.w;
            float lz = d.x * a.w + d.y * a.z;
            const float m = 0.015; // just inside the wall centre lines: outer faces stay outdoors
            if (lx < b.x + m || lx > b.y - m || lz < b.z + m || lz > b.w - m || p.y < c.x - 0.6) continue;
            float s = c.z > 0.5 ? lz : lx;
            float s0 = c.z > 0.5 ? b.z : b.x;
            float s1 = c.z > 0.5 ? b.w : b.y;
            float top = c.y + (0.5 * (s1 - s0) - abs(s - 0.5 * (s0 + s1))) * ${ROOF_TAN} + 0.03;
            if (p.y > top) continue;
            // Soften right at the walls so light still pools a little near windows/doors.
            float edge = min(min(lx - b.x, b.y - lx), min(lz - b.z, b.w - lz));
            k = max(k, c.w * (0.75 + 0.25 * smoothstep(0.0, 0.8, edge)));
          }
          return k;
        }
        void flSurface(vec3 vColor3) {
          vec2 vUv = vUvM;
          vec3 vColor = vColor3;
          vec3 alb = vec3(1.0); float rough = 0.8; float h = 0.0; float bumpK = 0.0; float snowK = 0.0; vec3 glow = vec3(0.0);
          ${surface}
          flAlb = alb; flRough = rough; flH = h; flBumpK = bumpK; flGlow = glow;
          // Snow settles on up-facing surfaces, broken up by noise so edges look windblown.
          float up = normalize(vWNrm).y * (gl_FrontFacing ? 1.0 : -1.0);
          float sn = fl_noise3(vWPos * 2.3) * 0.35 + fl_noise3(vWPos * 9.0) * 0.12;
          flSnow = snowK * vSnow * smoothstep(0.32, 0.62, up + sn - 0.12);
          flInt = uBldN > 0 ? flInterior(vWPos) : 0.0;
          flSnow *= 1.0 - flInt;
        }`,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        #ifdef USE_COLOR
          flSurface(vColor.rgb);
        #else
          flSurface(vec3(1.0));
        #endif
        diffuseColor.rgb *= flAlb;
        diffuseColor.rgb = mix(diffuseColor.rgb, ${SNOW_RGB}, flSnow);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `#include <roughnessmap_fragment>
        roughnessFactor = mix(flRough, 0.82, flSnow);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
        if (flBumpK > 0.0) normal = fl_bump(-vViewPosition, normal, flH, flBumpK * (1.0 - flSnow * 0.7) * (1.0 - smoothstep(12.0, 45.0, length(vViewPosition))));`,
      )
      .replace(
        '#include <lights_fragment_end>',
        /* glsl */ `{
          float flOcc = mix(1.0, 0.16, flInt);
          #if defined( RE_IndirectDiffuse )
            irradiance *= flOcc;
            iblIrradiance *= flOcc;
          #endif
          #if defined( RE_IndirectSpecular )
            radiance *= flOcc;
          #endif
        }
        #include <lights_fragment_end>`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
        totalEmissiveRadiance += flGlow;`,
      );
  };
  m.customProgramCacheKey = () => 'fl-surface-' + kind;
  return m;
}

// ---------------------------------------------------------------- textures
let _bough: THREE.Texture | null = null;
/** Spruce frond: a central stem with dense needles, drawn on a canvas (alpha-tested). */
export function boughTexture(): THREE.Texture {
  if (_bough) return _bough;
  const W = 128,
    H = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, W, H);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // Needles: short strokes angled forward along the stem, getting shorter toward the tip.
  const drawBranch = (x0: number, y0: number, x1: number, y1: number, w: number, needle: number) => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const ux = (x1 - x0) / len,
      uy = (y1 - y0) / len;
    g.strokeStyle = '#5a4a38';
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.stroke();
    for (let t = 0; t < len; t += 1.6) {
      const f = t / len;
      const nl = needle * (1 - f * 0.6) * (0.75 + rnd() * 0.5);
      const px = x0 + ux * t,
        py = y0 + uy * t;
      for (const side of [-1, 1]) {
        const a = Math.atan2(uy, ux) + side * (0.95 + rnd() * 0.35);
        const shade = 150 + Math.floor(rnd() * 80);
        g.strokeStyle = `rgb(${shade * 0.55 | 0},${shade | 0},${shade * 0.72 | 0})`;
        g.lineWidth = 1.3;
        g.beginPath();
        g.moveTo(px, py);
        g.lineTo(px + Math.cos(a) * nl, py + Math.sin(a) * nl);
        g.stroke();
      }
    }
  };
  // Main stem from bottom to top, with side branchlets.
  drawBranch(W / 2, H - 4, W / 2 + 3, 6, 3, 13);
  for (let i = 0; i < 9; i++) {
    const y = H - 30 - i * 24;
    const len = 44 - i * 3.5;
    drawBranch(W / 2, y, W / 2 - len * 0.9, y - len * 0.7, 1.6, 9);
    drawBranch(W / 2, y - 10, W / 2 + len * 0.9, y - 10 - len * 0.7, 1.6, 9);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  _bough = tex;
  return tex;
}

// ---------------------------------------------------------------- ghost material
/** Translucent placement ghost: fresnel rim + faint scanlines, tinted valid/invalid. */
export function createGhostMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0x7dffb0) },
      uTime: matTime,
    },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying vec3 vW;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vW = wp.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        vV = cameraPosition - wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uTime;
      varying vec3 vN; varying vec3 vV; varying vec3 vW;
      void main() {
        vec3 n = normalize(vN);
        float f = 1.0 - abs(dot(n, normalize(vV)));
        float rim = pow(f, 2.0);
        float scan = smoothstep(0.4, 0.5, fract(vW.y * 6.0 - uTime * 0.6)) * 0.12;
        float a = 0.16 + rim * 0.55 + scan;
        gl_FragColor = vec4(uColor * (0.55 + rim * 0.9), a);
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
}
