// Aurora borealis rendered into a direction map (world azimuth x elevation) that the sky dome and the
// environment probe sample. Curtains are thin vertical sheets ~100-300 km up, folded along the east-west
// axis north of the player. Each altitude slice integrates the curtain's gaussian cross-section
// analytically along the view ray, so thin sheets stay smooth even at grazing angles.
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }
`;

const FRAG = /* glsl */ `
uniform sampler2D uNoise;
uniform float uTime;
uniform vec2 uNorth; // horizontal unit vector toward magnetic north (xz)
uniform float uActivity; // 0..1
varying vec2 vUv;

// The shared noise tiles 4x (R) / 8x (G) per unit; rescale so one unit is roughly one feature.
float n1( float x, float row ) { return texture2D( uNoise, vec2( x * 0.25, row ) ).r; }
float n2( float x, float row ) { return texture2D( uNoise, vec2( x * 0.16, row ) ).g; }
float erfA( float x ) {
  // Winitzki approximation
  float x2 = x * x;
  const float a = 0.147;
  float e = sqrt( 1.0 - exp( - x2 * ( 1.2732395 + a * x2 ) / ( 1.0 + a * x2 ) ) );
  return x < 0.0 ? - e : e;
}
// Across-track position (km north) of curtain k at along-track coordinate a (km).
// lod: 0 = full detail, 1 = the slice spans many ripples, so drop them (they'd alias into bands).
float curtainPos( int k, float a, float t, float lod ) {
  float fk = float( k );
  float base = k == 0 ? 170.0 : ( k == 1 ? 300.0 : 470.0 );
  float fold = ( n1( a * 0.00055 + fk * 0.31 + t * 0.0021, 0.13 + fk * 0.2 ) - 0.5 ) * 260.0;
  float wiggle = ( n2( a * 0.0031 - t * 0.011 + fk * 0.7, 0.57 + fk * 0.1 ) - 0.5 ) * 70.0;
  float ripple = ( n1( a * 0.019 + t * 0.05 + fk * 1.3, 0.83 ) - 0.5 ) * 9.0 * ( 1.0 - lod );
  return base + fold + wiggle + ripple;
}

void main() {
  float az = ( vUv.x - 0.5 ) * 6.2831853;
  float el = vUv.y * 1.5707963;
  float se = max( sin( el ), 0.0 ), ce = cos( el );
  vec2 dxz = vec2( sin( az ), - cos( az ) );
  vec2 east = vec2( - uNorth.y, uNorth.x );
  float dAcross = dot( dxz, uNorth );
  float dAlong = dot( dxz, east );
  float t = uTime;
  vec3 col = vec3( 0.0 );
  const float R = 6371.0;
  const int N = 40;
  const float H0 = 92.0, H1 = 330.0;
  float dh = ( H1 - H0 ) / float( N );
  float jitter = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
  float tanE = se / max( ce, 1e-3 );
  float sPrev = R * ( - tanE + sqrt( tanE * tanE + 2.0 * H0 / R ) );
  for ( int i = 0; i < N; i ++ ) {
    float h = H0 + ( float( i ) + 1.0 ) * dh;
    // horizontal distance at which the ray reaches altitude h (with earth curvature)
    float s = R * ( - tanE + sqrt( tanE * tanE + 2.0 * h / R ) );
    float ds = s - sPrev;
    float sm = sPrev + ds * ( 0.5 + ( jitter - 0.5 ) * 0.9 );
    float hm = h - dh * 0.5;
    float along = sm * dAlong;
    float acr0 = sPrev * dAcross, acr1 = s * dAcross;
    sPrev = s;
    // brightness patches drifting along the oval + slow global surges
    float bright = smoothstep( 0.25, 0.85, n2( along * 0.0012 + t * 0.004, 0.31 ) );
    // how much along-track distance this slice covers: fine structure averages out beyond ~10 km
    float lod = smoothstep( 3.0, 16.0, ds * abs( dAlong ) );
    for ( int k = 0; k < 3; k ++ ) {
      float fk = float( k );
      float strength = k == 0 ? 1.0 : ( k == 1 ? 0.75 : 0.5 );
      float c = curtainPos( k, along, t, lod );
      float w = 5.0 + 3.0 * n1( along * 0.004 + fk, 0.44 );
      // integral of exp(-(x-c)^2/w^2) over the slice's across-track span, per unit along-ray length
      float span = acr1 - acr0;
      float I;
      if ( abs( span ) < 0.2 * w ) {
        float x = 0.5 * ( acr0 + acr1 ) - c;
        I = exp( - x * x / ( w * w ) ) * ds;
      } else {
        I = 0.8862269 * w * abs( erfA( ( acr1 - c ) / w ) - erfA( ( acr0 - c ) / w ) ) / abs( span ) * ds;
      }
      if ( I < 1e-4 ) continue;
      // lower edge and vertical profile
      float hb = 98.0 + 14.0 * n2( along * 0.0045 + fk * 0.9 + t * 0.003, 0.71 );
      float prof = smoothstep( hb - 4.0, hb + 5.0, hm ) * exp( - max( hm - hb, 0.0 ) / ( 38.0 + 30.0 * fk ) );
      // vertical ray structure: fine striations along the curtain that shimmer
      float rays = n1( along * 0.09 + t * 0.12 + fk * 3.1, 0.23 ) * n2( along * 0.031 - t * 0.07, 0.91 + fk * 0.03 );
      rays = mix( 0.25 + 1.6 * rays * rays, 0.7, lod );
      float e = I * prof * rays * strength * ( 0.35 + 0.95 * bright );
      // emission colour by altitude: green oxygen line, red/magenta above, violet nitrogen fringe below
      float up = smoothstep( 135.0, 230.0, hm );
      vec3 green = vec3( 0.1, 1.0, 0.36 );
      vec3 red = vec3( 0.9, 0.08, 0.38 );
      vec3 c3 = mix( green, red, up );
      float q = ( hm - hb ) / 5.0;
      c3 += vec3( 0.55, 0.18, 0.9 ) * exp( - q * q ) * 0.55;
      col += c3 * e;
    }
  }
  // fade into the horizon (long, thick air path) and overall activity
  col *= smoothstep( 0.0, 0.07, el ) * uActivity * 0.034;
  gl_FragColor = vec4( col, 1.0 );
}
`;

const _cc = new THREE.Color();

export class AuroraMap {
  readonly target = new THREE.WebGLRenderTarget(768, 192, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    generateMipmaps: false,
  });
  private quad: FullScreenQuad;
  readonly uniforms = {
    uNoise: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uNorth: { value: new THREE.Vector2(0, -1) },
    uActivity: { value: 1 },
  };
  private cleared = false;
  private frame = 0;

  constructor(private renderer: THREE.WebGLRenderer, noise: THREE.Texture) {
    this.target.texture.wrapS = THREE.RepeatWrapping;
    this.target.texture.colorSpace = THREE.NoColorSpace;
    this.uniforms.uNoise.value = noise;
    this.quad = new FullScreenQuad(
      new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms, depthTest: false, depthWrite: false }),
    );
  }

  /** Re-render when visible. Aurora moves slowly, so every other frame is plenty. */
  update(time: number, activity: number, north: THREE.Vector3) {
    const r = this.renderer;
    if (activity <= 0.001) {
      if (!this.cleared) {
        const prev = r.getRenderTarget();
        r.getClearColor(_cc);
        const a = r.getClearAlpha();
        r.setRenderTarget(this.target);
        r.setClearColor(0x000000, 1);
        r.clear(true, false, false);
        r.setClearColor(_cc, a);
        r.setRenderTarget(prev);
        this.cleared = true;
      }
      return;
    }
    this.cleared = false;
    if (this.frame++ % 2 !== 0) return;
    this.uniforms.uTime.value = time;
    this.uniforms.uActivity.value = activity;
    this.uniforms.uNorth.value.set(north.x, north.z).normalize();
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.target);
    this.quad.render(r);
    r.setRenderTarget(prev);
  }

  dispose() {
    this.target.dispose();
    this.quad.dispose();
  }
}
