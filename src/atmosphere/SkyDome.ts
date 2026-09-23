// The sky dome material: physically based sky (from the sky-view LUT), sun and moon discs, twinkling
// stars and the Milky Way turning around the pole, aurora curtains, and a sun-lit procedural cloud layer.
// The same GLSL renders three variants: the visible dome, the environment capture (no discs/stars,
// snowy ground below the horizon) and a tiny probe that the CPU reads back for ambient colours.
import * as THREE from 'three';
import { ATMO_COMMON, TRANSMITTANCE_LOOKUP } from './AtmosphereLUT';
import { CLOUD_GLSL, FOG_FUNCS_GLSL } from './globals';

export function createSkyUniforms() {
  return {
    uMie: { value: 1.6 },
    uTransLUT: { value: null as THREE.Texture | null },
    uNoise: { value: null as THREE.Texture | null },
    uAurora: { value: null as THREE.Texture | null },
    uAuroraK: { value: 0 },
    uCamAltKm: { value: 0.2 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
    /** Sun disc radiance (rgb) before atmospheric transmittance. */
    uSunDisc: { value: new THREE.Color(60, 60, 60) },
    /** x: sun angular radius, y: moon angular radius, z: moon brightness, w: earthshine */
    uDiscP: { value: new THREE.Vector4(0.0085, 0.0105, 1, 0.02) },
    /** x: star rotation, y: brightness, z: twinkle, w: milky way */
    uStarP: { value: new THREE.Vector4(0, 0, 0.5, 0) },
    uPole: { value: new THREE.Vector3(0, 1, 0) },
    uNightSky: { value: new THREE.Color(0, 0, 0) },
    /** Light reaching the cloud tops (sun + moon), and the ambient light around the clouds. */
    uCloudSun: { value: new THREE.Color(1, 1, 1) },
    uCloudAmb: { value: new THREE.Color(0.3, 0.35, 0.45) },
    uCloudLight: { value: new THREE.Vector3(0, 1, 0) },
    /** x: forward-scatter (silver lining), y: underside darkening, z: diffuse transmission, w: fog distance for the dome (m) */
    uCloudP3: { value: new THREE.Vector4(1, 0.5, 0.35, 5000) },
    /** High cirrus: x coverage, y altitude (m), z streak angle (rad), w density */
    uCirrus: { value: new THREE.Vector4(0.3, 8000, 0.6, 0.35) },
    uCirrusOffset: { value: new THREE.Vector2() },
    /** Light at cirrus altitude (stays lit after sunset). */
    uCirrusSun: { value: new THREE.Color(1, 1, 1) },
    /** Env capture: radiance of the snowy ground below the horizon. */
    uGround: { value: new THREE.Color(0.3, 0.32, 0.36) },
    uTime: { value: 0 },
  };
}
export type SkyUniforms = ReturnType<typeof createSkyUniforms>;

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * vec4( mat3( viewMatrix ) * position, 1.0 );
  gl_Position = p.xyww; // on the far plane
}
`;

export const SKY_GLSL = /* glsl */ `
${ATMO_COMMON}
${TRANSMITTANCE_LOOKUP}
${FOG_FUNCS_GLSL}
${CLOUD_GLSL}
uniform sampler2D uNoise;
uniform sampler2D uAurora;
uniform float uAuroraK;
uniform float uCamAltKm;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uSunDisc;
uniform vec4 uDiscP;
uniform vec4 uStarP;
uniform vec3 uPole;
uniform vec3 uNightSky;
uniform vec3 uCloudSun;
uniform vec3 uCloudAmb;
uniform vec3 uCloudLight;
uniform vec4 uCloudP3;
uniform vec3 uGround;
uniform float uTime;
uniform vec4 uCirrus;
uniform vec2 uCirrusOffset;
uniform vec3 uCirrusSun;

vec3 flHash33( vec3 p ) {
  p = fract( p * vec3( 0.1031, 0.1030, 0.0973 ) );
  p += dot( p, p.yxz + 33.33 );
  return fract( ( p.xxy + p.yxx ) * p.zyx );
}
vec3 rotAxis( vec3 v, vec3 k, float a ) {
  float c = cos( a ), s = sin( a );
  return v * c + cross( k, v ) * s + k * dot( k, v ) * ( 1.0 - c );
}

vec3 skyLut( vec3 d ) {
  return texture2D( flSkyLUT, flSkyLutUv( d, flSkyP.x ) ).rgb * flSkyP.y;
}

// One layer of point stars on a 3D cell grid. px = angular size of a pixel.
vec3 starLayer( vec3 d, float N, float seed, float density, float px, float bright, float expo ) {
  vec3 cell = floor( d * N );
  vec3 h = flHash33( cell + seed );
  if ( h.x > density ) return vec3( 0.0 );
  vec3 h2 = flHash33( cell + seed + 17.3 );
  vec3 sp = normalize( cell + 0.2 + 0.6 * h2 );
  float a2 = 2.0 * ( 1.0 - dot( sp, d ) );
  float sz = max( px * 0.55, 0.00009 );
  float I = exp( - a2 / ( sz * sz ) );
  // magnitude distribution: most stars faint, a handful bright
  float mag = pow( h.y, expo ) * 3.2 + 0.02;
  float tw = 1.0 + uStarP.z * 0.6 * sin( uTime * ( 1.7 + h.z * 5.0 ) + h.y * 61.0 ) * sin( uTime * ( 0.9 + h2.x * 3.0 ) + h2.y * 17.0 );
  vec3 tint = mix( vec3( 0.7, 0.8, 1.0 ), vec3( 1.0, 0.82, 0.62 ), smoothstep( 0.25, 0.95, h.z ) );
  return tint * I * mag * tw * bright;
}

vec3 starField( vec3 dir, float px ) {
  vec3 d = rotAxis( dir, uPole, - uStarP.x );
  // Milky Way: a band around a tilted great circle with mottled brightness and dark dust lanes.
  vec3 mwN = normalize( vec3( 0.28, 0.46, 0.84 ) );
  float b = dot( d, mwN );
  vec3 t1 = normalize( cross( mwN, vec3( 0.0, 1.0, 0.0 ) ) );
  vec3 t2 = cross( mwN, t1 );
  float lon = atan( dot( d, t2 ), dot( d, t1 ) );
  vec2 guv = vec2( lon * 0.4774648, b * 1.6 );
  float band = exp( - b * b / 0.028 );
  float core = exp( - b * b / 0.004 ) * ( 0.6 + 0.4 * sin( lon * 1.0 + 0.8 ) );
  float n = texture2D( uNoise, guv * vec2( 1.0, 1.0 ) ).r;
  float n2 = texture2D( uNoise, guv * 2.3 + 0.21 ).a;
  float dust = smoothstep( 0.45, 0.8, texture2D( uNoise, guv * 1.4 + vec2( 0.5, 0.13 ) ).g ) * exp( - b * b / 0.006 );
  vec3 mw = vec3( 0.85, 0.86, 1.0 ) * ( band * ( 0.35 + 0.9 * n * n2 ) + core * 0.8 ) * ( 1.0 - 0.75 * dust );
  vec3 col = mw * uStarP.w;
  float bright = uStarP.y;
  col += starLayer( d, 34.0, 1.0, 0.42, px, bright * 1.8, 7.0 );
  col += starLayer( d, 90.0, 7.0, 0.16 + 0.35 * band, px, bright * 0.55, 5.0 );
  col += starLayer( d, 200.0, 13.0, 0.05 + 0.4 * band, px, bright * 0.22, 3.0 );
  return col;
}

// Moon disc with correct phase from the sun direction, maria and earthshine. Returns rgb + coverage.
vec4 moonDisc( vec3 d, float px ) {
  vec3 md = uMoonDir;
  float r = uDiscP.y;
  float c = dot( d, md );
  if ( c < cos( r * 1.6 ) ) return vec4( 0.0 );
  vec3 right = normalize( cross( md, abs( md.y ) > 0.95 ? vec3( 1.0, 0.0, 0.0 ) : vec3( 0.0, 1.0, 0.0 ) ) );
  vec3 up = cross( right, md );
  vec2 p = vec2( dot( d, right ), dot( d, up ) ) / r;
  float rr = dot( p, p );
  float edge = 1.0 - smoothstep( 1.0 - 1.5 * px / r, 1.0 + 0.5 * px / r, sqrt( rr ) );
  float z = sqrt( max( 1.0 - rr, 0.0 ) );
  vec3 n = p.x * right + p.y * up - z * md;
  float lit = smoothstep( -0.04, 0.12, dot( n, uSunDir ) );
  float m = texture2D( uNoise, p * 0.23 + vec2( 0.31, 0.62 ) ).g;
  float cr = texture2D( uNoise, p * 0.9 + vec2( 0.11, 0.05 ) ).b;
  float albedo = mix( 0.52, 1.0, smoothstep( 0.38, 0.62, m ) ) * ( 0.85 + 0.25 * cr );
  float limb = 0.75 + 0.25 * z;
  vec3 col = vec3( 1.0, 0.97, 0.93 ) * albedo * limb * ( lit * uDiscP.z + uDiscP.w );
  // soft glow around the disc
  float glow = exp( - max( acos( clamp( c, -1.0, 1.0 ) ) - r, 0.0 ) / ( r * 1.5 ) ) * ( 1.0 - edge );
  return vec4( col * edge + vec3( 0.8, 0.85, 1.0 ) * glow * uDiscP.z * 0.02, edge );
}

// Sun-lit cloud layer on a curved shell. rgb = premultiplied radiance, a = transmittance.
vec4 cloudLayer( vec3 d, vec3 camPos ) {
  float cover = flCloudP.z;
  if ( cover < 0.004 || d.y < -0.05 ) return vec4( 0.0, 0.0, 0.0, 1.0 );
  const float RE = 6360000.0;
  float h = max( flCloudP.w - camPos.y, 50.0 );
  float b = RE * d.y;
  float cc = RE * RE - ( RE + h ) * ( RE + h );
  float t = - b + sqrt( max( b * b - cc, 0.0 ) );
  vec2 xz = camPos.xz + d.xz * t;
  float dens = flCloudDensityAt( xz );
  // distant cloud texture would alias: fade detail toward mean coverage
  float far = smoothstep( 25000.0, 110000.0, t );
  dens = mix( dens, clamp( cover * 1.1 - 0.1, 0.0, 1.0 ), far * 0.8 );
  vec3 L = uCloudLight;
  // density toward the light: the lit side of each cloud is where this is thin
  float ld = flCloudDensityAt( xz + L.xz / max( L.y, 0.12 ) * 380.0 );
  // squared density: thin wisps stay translucent, so edges feather instead of cutting out
  float tau = dens * dens * flCloudP2.w * 1.5;
  float alpha = ( 1.0 - exp( - tau ) ) * smoothstep( -0.05, 0.02, d.y );
  if ( alpha < 0.002 ) return vec4( 0.0, 0.0, 0.0, 1.0 );
  float cosT = dot( d, L );
  float Ly = max( L.y, 0.0 );
  float selfShadow = exp( - ld * flCloudP2.w * 0.45 );
  // Body: multiply-scattered sunlight, brighter on the sun-facing side, darker where thick.
  float body = ( 0.25 + 0.75 * selfShadow ) * ( 0.55 + 0.45 * exp( - tau * 0.18 ) );
  // Silver lining: only thin parts forward-scatter strongly (tau * e^-tau peaks at the edges).
  float fwd = min( flHG( cosT, 0.7 ) * 12.566, 8.0 ) * tau * exp( - tau * 1.3 ) * uCloudP3.x;
  vec3 direct = uCloudSun * ( body * 0.3 + fwd * 0.12 );
  // light diffusing through a thick deck from above (overcast underside): multiple scattering
  // whitens it, and a two-stream estimate sets how much gets through.
  vec3 sunN = mix( uCloudSun, vec3( dot( uCloudSun, vec3( 0.2126, 0.7152, 0.0722 ) ) ), 0.75 );
  vec3 diffuse = sunN * ( 0.06 + Ly ) * uCloudP3.z / ( 1.0 + 0.11 * flCloudP2.w * dens );
  vec3 amb = uCloudAmb * ( 1.1 - uCloudP3.y * dens );
  vec3 col = direct + diffuse * smoothstep( 0.3, 0.9, flCloudP.z ) + amb;
  // aerial perspective toward the horizon
  float ap = 1.0 - exp( - t / 55000.0 );
  col = mix( col, skyLut( vec3( d.x, max( d.y, 0.0 ), d.z ) ), ap * 0.85 );
  return vec4( col * alpha, 1.0 - alpha );
}

// Thin high cirrus streaks (8 km): they glow rose and amber long after the sun has left the valley.
vec4 cirrusLayer( vec3 d, vec3 camPos ) {
  if ( uCirrus.x < 0.01 || d.y < -0.02 ) return vec4( 0.0, 0.0, 0.0, 1.0 );
  const float RE = 6360000.0;
  float h = uCirrus.y - camPos.y;
  float b = RE * d.y;
  float cc = RE * RE - ( RE + h ) * ( RE + h );
  float t = - b + sqrt( max( b * b - cc, 0.0 ) );
  vec2 xz = camPos.xz + d.xz * t + uCirrusOffset;
  float ca = cos( uCirrus.z ), sa = sin( uCirrus.z );
  vec2 r = vec2( ca * xz.x + sa * xz.y, - sa * xz.x + ca * xz.y );
  vec2 uv = r * vec2( 1.0 / 26000.0, 1.0 / 7000.0 );
  float n = texture2D( uNoise, uv ).g * 0.65 + texture2D( uNoise, uv * vec2( 3.0, 7.0 ) + 0.3 ).a * 0.35;
  float streak = texture2D( uNoise, uv * vec2( 0.6, 11.0 ) + vec2( 0.5, 0.1 ) ).r;
  float dens = smoothstep( 1.0 - uCirrus.x, 1.0 - uCirrus.x + 0.35, n ) * ( 0.45 + 0.55 * streak );
  dens *= uCirrus.w * smoothstep( -0.02, 0.06, d.y );
  float far = smoothstep( 40000.0, 160000.0, t );
  dens *= 1.0 - far * 0.6;
  float cosT = dot( d, uCloudLight );
  float ph = 0.6 + flHG( cosT, 0.6 ) * 12.566 * 0.5;
  vec3 col = uCirrusSun * ph * 0.28 + uCloudAmb * 0.8;
  float ap = 1.0 - exp( - t / 90000.0 );
  col = mix( col, skyLut( vec3( d.x, max( d.y, 0.0 ), d.z ) ), ap * 0.7 );
  return vec4( col * dens, 1.0 - dens );
}

// Full sky radiance along d. mode: 0 = view, 1 = env capture, 2 = probe (no stars/discs)
vec3 skyRadiance( vec3 d, int mode, float px ) {
  vec3 camPos = cameraPosition;
  vec3 col = skyLut( d );
  col += uNightSky * smoothstep( -0.25, 0.3, d.y );
  float above = smoothstep( -0.03, 0.01, d.y );
  vec3 T = transmittanceRM( Rg + uCamAltKm, max( d.y, 0.0 ) ) * above;
  if ( mode == 0 && uStarP.y > 0.0 ) col += starField( d, px ) * T;
  if ( uAuroraK > 0.0 && d.y > 0.0 ) {
    float az = atan( d.x, - d.z );
    float el = asin( clamp( d.y, 0.0, 1.0 ) );
    col += texture2D( uAurora, vec2( az * 0.15915494 + 0.5, el / 1.5707963 ) ).rgb * uAuroraK * T;
  }
  if ( mode == 0 ) {
    vec4 m = moonDisc( d, px );
    col = mix( col, skyLut( d ) + uNightSky + m.rgb * T, m.a );
    col += m.rgb * T * ( 1.0 - m.a );
    // sun disc with limb darkening
    float cs = dot( d, uSunDir );
    float ang = sqrt( max( 2.0 * ( 1.0 - cs ), 0.0 ) );
    float rs = ang / uDiscP.x;
    if ( rs < 1.3 ) {
      float edge = 1.0 - smoothstep( 1.0 - px / uDiscP.x, 1.0 + px / uDiscP.x, rs );
      float mu = sqrt( max( 1.0 - rs * rs, 0.0 ) );
      float limb = 1.0 - 0.6 * ( 1.0 - pow( mu, 0.5 ) );
      col += uSunDisc * T * limb * edge;
    }
  }
  vec4 ci = cirrusLayer( d, camPos );
  col = col * ci.a + ci.rgb;
  vec4 cl = cloudLayer( d, camPos );
  col = col * cl.a + cl.rgb;
  if ( mode == 1 && d.y < 0.0 ) {
    // snowy ground seen from the capture point, fading into the horizon haze
    vec3 horizon = col;
    float k = smoothstep( 0.0, 0.18, - d.y );
    col = mix( horizon, uGround, k );
  } else if ( mode == 0 && d.y < 0.0 ) {
    // below the horizon (past the world edge): distant snowfields dissolving into haze
    col = mix( col, skyLut( vec3( d.x, 0.02, d.z ) ), smoothstep( 0.0, 0.1, - d.y ) * 0.7 );
  }
  return col;
}
`;

const FRAG = /* glsl */ `
${SKY_GLSL}
varying vec3 vDir;
void main() {
  vec3 d = normalize( vDir );
  #ifdef SKY_ENV
    vec3 col = skyRadiance( d, 1, 0.0 );
  #else
    float px = length( fwidth( d ) );
    vec3 col = skyRadiance( d, 0, px );
  #endif
  // the same haze + weather fog the terrain gets at the far plane, so ridges melt into the sky
  vec4 f = flFog( cameraPosition, d, uCloudP3.w );
  col = col * f.a + f.rgb * ( 1.0 - f.a );
  gl_FragColor = vec4( col, 1.0 );
}
`;

export function createSkyMaterial(uniforms: SkyUniforms, env: boolean): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    name: env ? 'SkyEnv' : 'SkyDome',
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
    defines: env ? { SKY_ENV: 1 } : {},
  });
  return m;
}

export function createSkyMesh(material: THREE.ShaderMaterial): THREE.Mesh {
  const geo = new THREE.IcosahedronGeometry(1, 5);
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10000; // after every opaque so early-z rejects hidden sky
  mesh.matrixAutoUpdate = false;
  mesh.name = 'sky';
  return mesh;
}

// ------------------------------------------------------------------------------------------------
// Probe: a few averaged sky radiances the CPU reads back (ambient colours, fog, exposure).
// ------------------------------------------------------------------------------------------------
export const PROBE_WIDTH = 8;
const PROBE_FRAG = /* glsl */ `
${SKY_GLSL}
uniform vec3 uProbeCam;
varying vec2 vUv;
vec3 fib( int i, int n ) {
  // Fibonacci points on the upper hemisphere, cosine-distributed
  float fi = float( i ) + 0.5;
  float u = fi / float( n );
  float r = sqrt( u );
  float phi = fi * 2.3999632;
  return vec3( r * cos( phi ), sqrt( max( 1.0 - u, 0.0 ) ), r * sin( phi ) );
}
void main() {
  int px = int( floor( vUv.x * ${PROBE_WIDTH}.0 ) );
  vec3 sum = vec3( 0.0 );
  vec3 Lh = normalize( vec3( flLightDir.x, 0.0, flLightDir.z ) + vec3( 1e-5 ) );
  if ( px == 0 ) {
    // cosine-weighted average of the upper hemisphere (irradiance / pi)
    for ( int i = 0; i < 64; i ++ ) sum += skyRadiance( fib( i, 64 ), 2, 0.0 );
    sum /= 64.0;
  } else if ( px == 1 ) {
    // horizon ring average
    for ( int i = 0; i < 16; i ++ ) {
      float a = float( i ) / 16.0 * 6.2831853;
      sum += skyRadiance( normalize( vec3( cos( a ), 0.05, sin( a ) ) ), 2, 0.0 );
    }
    sum /= 16.0;
  } else if ( px == 2 ) {
    sum = skyRadiance( vec3( 0.0, 1.0, 0.0 ), 2, 0.0 );
  } else if ( px == 3 ) {
    sum = skyRadiance( normalize( Lh + vec3( 0.0, 0.05, 0.0 ) ), 2, 0.0 );
  } else if ( px == 4 ) {
    sum = skyRadiance( normalize( - Lh + vec3( 0.0, 0.05, 0.0 ) ), 2, 0.0 );
  } else if ( px == 5 ) {
    // clear-sky (LUT only) horizon average, for the haze colour
    for ( int i = 0; i < 16; i ++ ) {
      float a = float( i ) / 16.0 * 6.2831853;
      sum += skyLut( normalize( vec3( cos( a ), 0.05, sin( a ) ) ) );
    }
    sum /= 16.0;
  } else if ( px == 6 ) {
    // clear-sky (LUT only) cosine-weighted hemisphere: lights the clouds without feeding back on them
    for ( int i = 0; i < 32; i ++ ) sum += skyLut( fib( i, 32 ) );
    sum /= 32.0;
  }
  gl_FragColor = vec4( sum, 1.0 );
}
`;
const PROBE_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }
`;

export function createProbeMaterial(uniforms: SkyUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'SkyProbe',
    uniforms,
    vertexShader: PROBE_VERT,
    fragmentShader: PROBE_FRAG,
    depthTest: false,
    depthWrite: false,
  });
}
