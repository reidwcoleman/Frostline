// Far trees: camera-facing billboards baked from the real tree meshes (render-to-texture), so
// colour and snow match exactly. Four elevation frames per species (trees are ~rotationally
// symmetric, so azimuth doesn't matter) + a baked view-space normal atlas so impostors are lit
// by the live sun/sky. One static instanced draw for every tree in the world; the vertex shader
// hides the ones in mesh range (dithered crossfade complementary with the mesh LODs).
import * as THREE from 'three';
import type { World } from '../../core/World';
import { TREE_HEIGHTS, TREE_TYPES } from './TreeModels';
import { GLSL_DITHER, type TreeShared } from './treeMaterial';
import { replaceInclude } from '../shaders/lighting';

export const IMP_ELEVATIONS = [0, 22, 45, 78]; // degrees
const CELL_W = 160;
const CELL_H = 320;

export interface ImpostorFrame {
  /** Billboard half-width, half-height (m, at scale 1) and centre height. */
  hw: number;
  hh: number;
  cy: number;
}

export class TreeImpostors {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshStandardMaterial;
  private albedo!: THREE.Texture;
  private normals!: THREE.Texture;
  private inst: THREE.InstancedBufferAttribute;
  private readonly uniforms: { [k: string]: THREE.IUniform };
  /** frames[type][elev] */
  frames: ImpostorFrame[][] = [];

  constructor(
    private renderer: THREE.WebGLRenderer,
    private world: World,
    shared: TreeShared,
    geometries: THREE.BufferGeometry[],
    bakeMaterial: (normals: boolean) => THREE.Material,
  ) {
    this.bake(geometries, bakeMaterial);
    const frameData: THREE.Vector4[] = [];
    for (let t = 0; t < TREE_TYPES; t++)
      for (let e = 0; e < IMP_ELEVATIONS.length; e++) {
        const f = this.frames[t][e];
        frameData.push(new THREE.Vector4(f.hw, f.hh, f.cy, 0));
      }
    this.uniforms = {
      uImpAlbedo: { value: this.albedo },
      uImpNormal: { value: this.normals },
      uImpFrames: { value: frameData },
      uImpRange: { value: new THREE.Vector4(300, 330, 2400, 2600) },
      uTime: shared.uTime,
      uWind: shared.uWind,
    };

    // Quad: corners in [-1,1]^2.
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const n = world.treeCount;
    this.inst = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, n) * 4), 4);
    g.setAttribute('aTree', this.inst); // x, y, z, scale * (alive ? 1 : 0) ; type packed below
    const types = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, n)), 1);
    for (let i = 0; i < n; i++) types.array[i] = world.treeType[i];
    g.setAttribute('aType', types);
    g.instanceCount = n;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.rebuild();

    this.material = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, alphaTest: 0.5, side: THREE.DoubleSide });
    this.material.name = 'tree-impostor';
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      let vs = shader.vertexShader;
      vs = vs.replace('#include <common>', `#include <common>\n${IMP_VERT_PARS}`);
      vs = replaceInclude(vs, 'beginnormal_vertex', 'vec3 objectNormal = vec3(0.0, 0.0, 1.0);');
      vs = replaceInclude(vs, 'begin_vertex', IMP_VERT_BEGIN);
      vs = replaceInclude(vs, 'project_vertex', 'vec4 mvPosition = viewMatrix * vec4(transformed, 1.0);\ngl_Position = projectionMatrix * mvPosition;');
      vs = replaceInclude(vs, 'worldpos_vertex', 'vec4 worldPosition = vec4(transformed, 1.0);');
      shader.vertexShader = vs;
      let fs = shader.fragmentShader;
      fs = fs.replace('#include <common>', `#include <common>\n${IMP_FRAG_PARS}`);
      fs = replaceInclude(fs, 'map_fragment', IMP_FRAG_MAP);
      fs = replaceInclude(fs, 'alphatest_fragment', 'if (diffuseColor.a < 0.5) discard;');
      fs = replaceInclude(fs, 'normal_fragment_begin', 'float faceDirection = 1.0;\nvec3 normal = impN;\nvec3 nonPerturbedNormal = normal;');
      fs = replaceInclude(fs, 'normal_fragment_maps', '');
      shader.fragmentShader = fs;
    };
    this.material.customProgramCacheKey = () => 'frostline-impostor-1';

    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.name = 'tree-impostors';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.matrixAutoUpdate = false;
  }

  /** Visible distance band: fade in over [a, b], fade out over [c, d]. */
  setRange(a: number, b: number, c: number, d: number) {
    (this.uniforms.uImpRange.value as THREE.Vector4).set(a, b, c, d);
  }

  /** Re-upload positions / alive flags (new game, load). */
  rebuild() {
    const w = this.world;
    const a = this.inst.array as Float32Array;
    for (let i = 0; i < w.treeCount; i++) {
      a[i * 4] = w.treeX[i];
      a[i * 4 + 1] = w.treeY[i];
      a[i * 4 + 2] = w.treeZ[i];
      a[i * 4 + 3] = w.treeAlive[i] ? w.treeScale[i] : 0;
    }
    this.inst.clearUpdateRanges();
    this.inst.needsUpdate = true;
  }

  hide(i: number) {
    const a = this.inst.array as Float32Array;
    a[i * 4 + 3] = 0;
    this.inst.addUpdateRange(i * 4 + 3, 1);
    this.inst.needsUpdate = true;
  }

  private bake(geometries: THREE.BufferGeometry[], bakeMaterial: (normals: boolean) => THREE.Material) {
    const r = this.renderer;
    const W = CELL_W * IMP_ELEVATIONS.length,
      H = CELL_H * TREE_TYPES;
    const make = () => {
      const rt = new THREE.WebGLRenderTarget(W, H, { depthBuffer: true, type: THREE.UnsignedByteType });
      rt.texture.colorSpace = THREE.NoColorSpace;
      return rt;
    };
    const rtA = make(),
      rtN = make();
    const scene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
    const matA = bakeMaterial(false),
      matN = bakeMaterial(true);
    const mesh = new THREE.Mesh(geometries[0], matA);
    scene.add(mesh);
    const prevTarget = r.getRenderTarget();
    const prevClear = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    const prevTone = r.toneMapping;
    const prevAuto = r.autoClear;
    r.toneMapping = THREE.NoToneMapping;
    r.autoClear = false;
    r.setClearColor(0x000000, 0);
    for (const rt of [rtA, rtN]) {
      r.setRenderTarget(rt);
      r.clear(true, true, false);
    }
    for (let t = 0; t < TREE_TYPES; t++) {
      const geo = geometries[t];
      geo.computeBoundingBox();
      const bb = geo.boundingBox!;
      const R = Math.max(-bb.min.x, bb.max.x, -bb.min.z, bb.max.z) * 1.02;
      const top = bb.max.y * 1.01;
      const bottom = 0;
      this.frames[t] = [];
      mesh.geometry = geo;
      for (let e = 0; e < IMP_ELEVATIONS.length; e++) {
        const el = (IMP_ELEVATIONS[e] * Math.PI) / 180;
        // Orthographic extents of the tree's bounding cylinder seen from this elevation.
        const hh = ((top - bottom) * Math.cos(el) + 2 * R * Math.sin(el)) / 2;
        const hw = R;
        const cy = (top + bottom) / 2;
        this.frames[t][e] = { hw, hh, cy };
        cam.left = -hw;
        cam.right = hw;
        cam.top = hh;
        cam.bottom = -hh;
        cam.updateProjectionMatrix();
        const dist = 100;
        cam.position.set(0, cy + Math.sin(el) * dist, Math.cos(el) * dist);
        cam.up.set(0, 1, 0);
        cam.lookAt(0, cy, 0);
        cam.updateMatrixWorld();
        for (const [rt, mat] of [
          [rtA, matA],
          [rtN, matN],
        ] as const) {
          mesh.material = mat;
          // Viewport/scissor are copied from the target when it is bound: set them first.
          rt.viewport.set(e * CELL_W, (TREE_TYPES - 1 - t) * CELL_H, CELL_W, CELL_H);
          rt.scissor.copy(rt.viewport);
          rt.scissorTest = true;
          r.setRenderTarget(null);
          r.setRenderTarget(rt);
          r.render(scene, cam);
        }
      }
    }
    // Read back, dilate colour into transparent texels (no dark fringes in mips), upload.
    // The albedo bake shader already wrote sRGB-encoded bytes (see TREE_BAKE in treeMaterial).
    const read = (rt: THREE.WebGLRenderTarget) => {
      const px = new Uint8Array(W * H * 4);
      rt.scissorTest = false;
      rt.viewport.set(0, 0, W, H);
      r.readRenderTargetPixels(rt, 0, 0, W, H, px);
      return px;
    };
    const pa = read(rtA),
      pn = read(rtN);
    dilate(pa, W, H, 6);
    dilate(pn, W, H, 6);
    this.albedo = toTexture(pa, W, H, THREE.SRGBColorSpace);
    this.normals = toTexture(pn, W, H, THREE.NoColorSpace);
    r.setRenderTarget(prevTarget);
    r.setClearColor(prevClear, prevAlpha);
    r.toneMapping = prevTone;
    r.autoClear = prevAuto;
    rtA.dispose();
    rtN.dispose();
    (matA as THREE.Material).dispose();
    (matN as THREE.Material).dispose();
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.albedo.dispose();
    this.normals.dispose();
  }
}

function toTexture(px: Uint8Array, W: number, H: number, cs: THREE.ColorSpace) {
  const t = new THREE.DataTexture(px, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = cs;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

/** Push opaque texel colours outward into transparent ones (alpha untouched). */
function dilate(px: Uint8Array, W: number, H: number, passes: number) {
  const src = new Uint8Array(px.length);
  for (let p = 0; p < passes; p++) {
    src.set(px);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        if (src[o + 3] > 8) continue;
        let r = 0,
          g = 0,
          b = 0,
          n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx,
              yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            const q = (yy * W + xx) * 4;
            if (src[q + 3] > 8 || (p > 0 && (src[q] | src[q + 1] | src[q + 2]) > 0)) {
              r += src[q];
              g += src[q + 1];
              b += src[q + 2];
              n++;
            }
          }
        if (n) {
          px[o] = r / n;
          px[o + 1] = g / n;
          px[o + 2] = b / n;
        }
      }
  }
}

const IMP_VERT_PARS = /* glsl */ `
attribute vec4 aTree;
attribute float aType;
uniform vec4 uImpFrames[${TREE_TYPES * IMP_ELEVATIONS.length}];
uniform vec4 uImpRange;
uniform float uTime;
uniform vec4 uWind;
varying vec2 vImpUv0;
varying vec2 vImpUv1;
varying float vImpBlend;
flat varying float vImpFade;
varying vec3 vImpWorld;
`;

const IMP_VERT_BEGIN = /* glsl */ `
vec3 transformed;
{
  float scale = aTree.w;
  vec3 base = aTree.xyz;
  int type = int(aType + 0.5);
  vec3 toCam = cameraPosition - (base + vec3(0.0, ${(TREE_HEIGHTS[0] / 2).toFixed(2)} * scale, 0.0));
  float dist = distance(cameraPosition, base);
  float fin = smoothstep(uImpRange.x, uImpRange.y, dist);
  float fout = 1.0 - smoothstep(uImpRange.z, uImpRange.w, dist);
  vImpFade = fin * fout;
  if (scale <= 0.0 || vImpFade <= 0.0) {
    transformed = vec3(0.0, -1e5, 0.0);
  } else {
    vec3 V = normalize(toCam);
    float elev = degrees(asin(clamp(V.y, 0.0, 1.0)));
    // Pick the two bracketing bake elevations.
    float e0 = ${IMP_ELEVATIONS[0]}.0, e1 = ${IMP_ELEVATIONS[1]}.0, e2 = ${IMP_ELEVATIONS[2]}.0, e3 = ${IMP_ELEVATIONS[3]}.0;
    int i0; float bl;
    if (elev < e1) { i0 = 0; bl = (elev - e0) / (e1 - e0); }
    else if (elev < e2) { i0 = 1; bl = (elev - e1) / (e2 - e1); }
    else { i0 = 2; bl = clamp((elev - e2) / (e3 - e2), 0.0, 1.0); }
    vImpBlend = bl;
    vec4 f0 = uImpFrames[type * ${IMP_ELEVATIONS.length} + i0];
    vec4 f1 = uImpFrames[type * ${IMP_ELEVATIONS.length} + i0 + 1];
    vec4 f = mix(f0, f1, bl);
    // Camera-facing frame with world-up projected onto the view plane (matches the bake camera).
    vec3 fwd = -V;
    vec3 right = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)) + vec3(1e-5, 0.0, 0.0));
    vec3 up = cross(right, fwd);
    vec3 center = base + vec3(0.0, f.z * scale, 0.0);
    // Gentle sway at the top of far trees.
    float sw = (position.y * 0.5 + 0.5);
    center.xz += uWind.xy * uWind.z * sw * sw * 0.25 * scale * sin(uTime * 0.9 + dot(base.xz, vec2(0.13, 0.17)));
    transformed = center + right * position.x * f.x * scale + up * position.y * f.y * scale;
    // Atlas uvs: columns = elevations, rows = types (row 0 at the top).
    vec2 cellUv = position.xy * 0.5 + 0.5;
    float cw = 1.0 / ${IMP_ELEVATIONS.length}.0, ch = 1.0 / ${TREE_TYPES}.0;
    float row = float(${TREE_TYPES - 1} - type);
    // Each frame's quad covers that frame's bake extents; rescale uv so the blended quad maps both.
    vec2 s0 = f.xy / f0.xy, s1 = f.xy / f1.xy;
    vec2 c0 = (cellUv - 0.5) * s0 + 0.5 + vec2(0.0, (f.z - f0.z) / (2.0 * f0.y));
    vec2 c1 = (cellUv - 0.5) * s1 + 0.5 + vec2(0.0, (f.z - f1.z) / (2.0 * f1.y));
    vImpUv0 = vec2((float(i0) + clamp(c0.x, 0.0, 1.0)) * cw, (row + clamp(c0.y, 0.0, 1.0)) * ch);
    vImpUv1 = vec2((float(i0 + 1) + clamp(c1.x, 0.0, 1.0)) * cw, (row + clamp(c1.y, 0.0, 1.0)) * ch);
    vImpWorld = transformed;
  }
}
`;

const IMP_FRAG_PARS = /* glsl */ `
uniform sampler2D uImpAlbedo;
uniform sampler2D uImpNormal;
varying vec2 vImpUv0;
varying vec2 vImpUv1;
varying float vImpBlend;
flat varying float vImpFade;
varying vec3 vImpWorld;
vec3 impN;
${GLSL_DITHER}
`;

const IMP_FRAG_MAP = /* glsl */ `
{
  float dth = treeDither(gl_FragCoord.xy);
  if ((1.0 - dth) >= vImpFade) discard;
  vec4 a0 = texture(uImpAlbedo, vImpUv0);
  vec4 a1 = texture(uImpAlbedo, vImpUv1);
  vec4 a = mix(a0, a1, vImpBlend);
  // Keep coverage in the mips so distant forests don't thin out.
  float lod = max(0.0, 0.5 * log2(max(dot(dFdx(vImpUv0 * 512.0), dFdx(vImpUv0 * 512.0)), dot(dFdy(vImpUv0 * 1024.0), dFdy(vImpUv0 * 1024.0)))));
  a.a *= 1.0 + lod * 0.3;
  diffuseColor = vec4(a.rgb, a.a);
  vec3 n0 = texture(uImpNormal, vImpUv0).xyz * 2.0 - 1.0;
  vec3 n1 = texture(uImpNormal, vImpUv1).xyz * 2.0 - 1.0;
  impN = normalize(mix(n0, n1, vImpBlend) + vec3(0.0, 0.0, 0.001));
}
`;
