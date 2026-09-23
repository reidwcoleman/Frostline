// Procedural window-frost pattern for the cold screen effect, generated once on the GPU.
// R: frost thickness, G/B: surface slope (for refraction), A: ice-crystal sparkle mask.
// Fern-like dendrites come from domain-warped ridged noise; flat ice plates from Voronoi cells, each
// filled with feathery needles at its own angle.
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec2 uTexel;
float hash12( vec2 p ) { vec3 p3 = fract( vec3( p.xyx ) * 0.1031 ); p3 += dot( p3, p3.yzx + 33.33 ); return fract( ( p3.x + p3.y ) * p3.z ); }
vec2 hash22( vec2 p ) { vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) ); p3 += dot( p3, p3.yzx + 33.33 ); return fract( ( p3.xx + p3.yz ) * p3.zy ); }
float vnoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( hash12( i ), hash12( i + vec2( 1, 0 ) ), u.x ), mix( hash12( i + vec2( 0, 1 ) ), hash12( i + vec2( 1, 1 ) ), u.x ), u.y );
}
float fbm( vec2 p ) {
  float s = 0.0, a = 0.5;
  mat2 r = mat2( 0.8, 0.6, -0.6, 0.8 );
  for ( int i = 0; i < 5; i ++ ) { s += a * vnoise( p ); p = r * p * 2.03; a *= 0.5; }
  return s;
}
float ridged( vec2 p ) {
  float s = 0.0, a = 0.55;
  mat2 r = mat2( 0.8, 0.6, -0.6, 0.8 );
  for ( int i = 0; i < 6; i ++ ) {
    float n = 1.0 - abs( vnoise( p ) * 2.0 - 1.0 );
    s += n * n * n * a;
    p = r * p * 2.17;
    a *= 0.52;
  }
  return s;
}
// x: F1, y: F2, z: cell id
vec3 voronoi( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  float f1 = 8.0, f2 = 8.0; float id = 0.0;
  for ( int y = -1; y <= 1; y ++ ) for ( int x = -1; x <= 1; x ++ ) {
    vec2 g = vec2( float( x ), float( y ) );
    vec2 o = hash22( i + g );
    float d = length( g + o - f );
    if ( d < f1 ) { f2 = f1; f1 = d; id = hash12( i + g + 7.7 ); } else if ( d < f2 ) f2 = d;
  }
  return vec3( f1, f2, id );
}
float frostH( vec2 uv ) {
  vec2 p = uv * 6.0;
  vec2 w = vec2( fbm( p * 0.6 ), fbm( p * 0.6 + 5.2 ) );
  float fern = ridged( p * 1.2 + w * 2.4 );
  vec3 v = voronoi( p * 2.6 + w * 1.3 );
  float plate = 1.0 - smoothstep( 0.0, 0.05, v.y - v.x );
  float ang = v.z * 6.2831;
  vec2 dir = vec2( cos( ang ), sin( ang ) );
  float feathers = pow( abs( sin( dot( p * 58.0, dir ) + v.z * 40.0 ) ), 14.0 ) * smoothstep( 0.02, 0.25, v.y - v.x );
  float grain = fbm( p * 22.0 );
  return clamp( fern * 0.62 + plate * 0.28 + feathers * 0.22 + grain * 0.12, 0.0, 1.0 );
}
void main() {
  float h = frostH( vUv );
  float hx = frostH( vUv + vec2( uTexel.x, 0.0 ) );
  float hy = frostH( vUv + vec2( 0.0, uTexel.y ) );
  vec2 n = vec2( h - hx, h - hy ) * 18.0;
  float sp = step( 0.992, hash12( floor( vUv * 1400.0 ) ) ) * smoothstep( 0.35, 0.7, h );
  gl_FragColor = vec4( h, clamp( n * 0.5 + 0.5, 0.0, 1.0 ), sp );
}
`;

export function createFrostTexture(renderer: THREE.WebGLRenderer, size = 2048): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(size, size, {
    type: THREE.UnsignedByteType,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: true,
    depthBuffer: false,
  });
  rt.texture.colorSpace = THREE.NoColorSpace;
  rt.texture.wrapS = rt.texture.wrapT = THREE.MirroredRepeatWrapping;
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: { uTexel: { value: new THREE.Vector2(1 / size, 1 / size) } },
    depthTest: false,
    depthWrite: false,
  });
  const quad = new FullScreenQuad(mat);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  quad.render(renderer);
  renderer.setRenderTarget(prev);
  quad.dispose();
  mat.dispose();
  return rt;
}
