// Mountain-scale sun shadows from the heightfield. For every texel of a 1024² map covering the world we
// march toward the light and store the altitude below which a point is fully shadowed (R) and above which
// it is fully lit (G), using the sun disc's angular size (exaggerated for softer penumbrae). Any fragment
// (terrain, trees, cabins, the player) then shades by comparing its own height — so treetops catch the
// last light while the valley floor is already in shadow. Recomputed in strips across frames whenever the
// light moves, and crossfaded, so it never hitches.
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { G } from './globals';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }
`;

const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uHeight;
uniform float uHalf;     // world half size (m)
uniform float uHMax;     // max terrain height (m)
uniform vec3 uL;         // direction toward the light
uniform float uAlpha;    // angular radius used for the penumbra (rad)
varying vec2 vUv;
float H( vec2 xz ) { return texture2D( uHeight, ( xz + uHalf ) / ( 2.0 * uHalf ) ).r; }
void main() {
  vec2 p = vUv * 2.0 * uHalf - uHalf;
  float h0 = H( p );
  vec2 d = normalize( uL.xz + vec2( 1e-6 ) );
  float e = asin( clamp( uL.y, -1.0, 1.0 ) );
  float tLo = tan( clamp( e + uAlpha, -1.4, 1.4 ) ); // top of the disc: needed to be lit at all
  float tHi = tan( clamp( e - uAlpha, -1.4, 1.4 ) ); // bottom of the disc: needed to be fully lit
  float yLo = -1e4, yHi = -1e4;
  float s = 9.0;
  for ( int i = 0; i < 160; i ++ ) {
    vec2 q = p + d * s;
    if ( abs( q.x ) > uHalf || abs( q.y ) > uHalf ) break;
    float hq = H( q );
    yLo = max( yLo, hq - s * tLo );
    yHi = max( yHi, hq - s * tHi );
    // nothing further along can rise above what we already have
    if ( uHMax - s * tHi < yHi && uHMax - s * tLo < yLo ) break;
    s += 5.0 + s * 0.035;
  }
  // Open ground: occluders start 9 m away, so the surface's own slope is left to N.L and the cascades.
  yHi = max( yHi, yLo + 0.01 );
  gl_FragColor = vec4( yLo, yHi, h0, 1.0 );
}
`;

const SIZE = 1024;
const STRIPS = 8;

export class TerrainShadow {
  private targets: THREE.WebGLRenderTarget[];
  private front = 0; // index shown as "B" (current)
  private quad: FullScreenQuad;
  private heightTex: THREE.DataTexture;
  private uniforms = {
    uHeight: { value: null as THREE.Texture | null },
    uHalf: { value: 2048 },
    uHMax: { value: 1500 },
    uL: { value: new THREE.Vector3(0, 1, 0) },
    uAlpha: { value: 0.012 },
  };
  private strip = -1; // -1 idle, else next strip to render
  private pendingDir = new THREE.Vector3();
  private shownDir = new THREE.Vector3(0, -2, 0);
  private blend = 1;
  private timeSince = 0;
  private scissor = new THREE.Vector4();

  constructor(private renderer: THREE.WebGLRenderer, heights: Float32Array, res: number, size: number) {
    const linearFloat = renderer.extensions.has('OES_texture_float_linear');
    let hmax = -Infinity;
    for (let i = 0; i < heights.length; i++) if (heights[i] > hmax) hmax = heights[i];
    this.heightTex = new THREE.DataTexture(heights, res, res, THREE.RedFormat, THREE.FloatType);
    this.heightTex.minFilter = this.heightTex.magFilter = linearFloat ? THREE.LinearFilter : THREE.NearestFilter;
    this.heightTex.wrapS = this.heightTex.wrapT = THREE.ClampToEdgeWrapping;
    this.heightTex.colorSpace = THREE.NoColorSpace;
    this.heightTex.needsUpdate = true;
    this.uniforms.uHeight.value = this.heightTex;
    this.uniforms.uHalf.value = size / 2;
    this.uniforms.uHMax.value = hmax;
    const type = linearFloat ? THREE.FloatType : THREE.HalfFloatType;
    this.targets = [0, 1].map(() => {
      const rt = new THREE.WebGLRenderTarget(SIZE, SIZE, {
        type,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        generateMipmaps: false,
      });
      rt.texture.colorSpace = THREE.NoColorSpace;
      return rt;
    });
    this.quad = new FullScreenQuad(
      new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms, depthTest: false, depthWrite: false }),
    );
    G.flTShadowP.value.y = size / 2;
  }

  /** Blocking full recompute (used at init and after big jumps). */
  computeNow(lightDir: THREE.Vector3) {
    this.uniforms.uL.value.copy(lightDir);
    const target = this.targets[this.front];
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(target);
    this.quad.render(this.renderer);
    this.renderer.setRenderTarget(prev);
    // show the same map in both slots
    this.shownDir.copy(lightDir);
    this.blend = 1;
    this.strip = -1;
    this.bind();
    G.flTShadowP.value.z = 1;
  }

  update(dt: number, lightDir: THREE.Vector3, penumbraRad: number) {
    this.uniforms.uAlpha.value = penumbraRad;
    this.timeSince += dt;
    // crossfade the finished map in
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / 0.9);
      G.flTShadowP.value.x = smooth(this.blend);
    }
    if (this.strip < 0) {
      const ang = this.shownDir.angleTo(lightDir);
      const big = ang > 0.09; // ~5°: light source switched or time jumped
      if (big && this.blend >= 1) {
        this.computeNow(lightDir);
        return;
      }
      if (this.blend >= 1 && (ang > 0.0025 || (this.timeSince > 3 && ang > 0.0005))) {
        this.strip = 0;
        this.pendingDir.copy(lightDir);
        this.timeSince = 0;
      }
    }
    if (this.strip >= 0) {
      const back = 1 - this.front;
      const target = this.targets[back];
      this.uniforms.uL.value.copy(this.pendingDir);
      const r = this.renderer;
      const prev = r.getRenderTarget();
      const h = SIZE / STRIPS;
      this.scissor.set(0, this.strip * h, SIZE, h);
      target.scissor.copy(this.scissor);
      target.scissorTest = true;
      r.setRenderTarget(target);
      this.quad.render(r);
      target.scissorTest = false;
      r.setRenderTarget(prev);
      this.strip++;
      if (this.strip >= STRIPS) {
        this.strip = -1;
        // A = what was shown, B = the new map; fade A->B
        G.flTShadowA.value = this.targets[this.front].texture;
        G.flTShadowB.value = target.texture;
        this.front = back;
        this.shownDir.copy(this.pendingDir);
        this.blend = 0;
        G.flTShadowP.value.x = 0;
      }
    }
  }

  private bind() {
    G.flTShadowA.value = this.targets[this.front].texture;
    G.flTShadowB.value = this.targets[this.front].texture;
    G.flTShadowP.value.x = 1;
  }

  dispose() {
    this.targets.forEach((t) => t.dispose());
    this.heightTex.dispose();
    this.quad.dispose();
  }
}

function smooth(t: number) {
  return t * t * (3 - 2 * t);
}
