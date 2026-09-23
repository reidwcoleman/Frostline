// Physically based sky: Rayleigh + Mie + ozone single scattering with Hillaire's multiple-scattering
// approximation (EGSR 2020, "A Scalable and Production Ready Sky and Atmosphere Rendering Technique").
//  - transmittance LUT (256x64) and multi-scattering LUT (32x32): static, rebuilt only if haze changes
//  - sky-view LUT (256x128, world azimuth x non-linear elevation): rebuilt every frame for sun + moon
// Units inside the shaders are kilometres. Radiance is for a light of unit illuminance.
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { SKY_LUT_GLSL } from './globals';

export const R_GROUND = 6360;
export const R_TOP = 6460;

const RAYLEIGH = [5.802e-3, 13.558e-3, 33.1e-3];
const MIE_SCAT = 3.996e-3;
const MIE_EXT = 4.4e-3;
const OZONE = [0.65e-3, 1.881e-3, 0.085e-3];

export const ATMO_COMMON = /* glsl */ `
#define FL_PI 3.14159265
const float Rg = ${R_GROUND.toFixed(1)};
const float Rt = ${R_TOP.toFixed(1)};
const vec3 RAY_S = vec3(${RAYLEIGH.join(', ')});
const float MIE_S = ${MIE_SCAT};
const float MIE_E = ${MIE_EXT};
const vec3 OZONE_A = vec3(${OZONE.join(', ')});
uniform float uMie; // haze multiplier on Mie density

void scatteringAt( float h, out vec3 rayS, out float mieS, out vec3 ext ) {
  float rd = exp( - max( h, 0.0 ) / 8.0 );
  float md = exp( - max( h, 0.0 ) / 1.2 ) * uMie;
  rayS = RAY_S * rd;
  mieS = MIE_S * md;
  float oz = max( 0.0, 1.0 - abs( h - 25.0 ) / 15.0 );
  ext = rayS + vec3( MIE_E * md ) + OZONE_A * oz;
}
float raySphere( vec3 ro, vec3 rd, float rad ) {
  float b = dot( ro, rd );
  float c = dot( ro, ro ) - rad * rad;
  if ( c > 0.0 && b > 0.0 ) return -1.0;
  float disc = b * b - c;
  if ( disc < 0.0 ) return -1.0;
  if ( disc > b * b ) return -b + sqrt( disc ); // inside
  return -b - sqrt( disc );
}
float phaseRayleigh( float c ) { return 3.0 / ( 16.0 * FL_PI ) * ( 1.0 + c * c ); }
float phaseMie( float c ) {
  const float g = 0.8;
  float g2 = g * g;
  float num = ( 1.0 - g2 ) * ( 1.0 + c * c );
  float den = ( 2.0 + g2 ) * pow( 1.0 + g2 - 2.0 * g * c, 1.5 );
  return 3.0 / ( 8.0 * FL_PI ) * num / den;
}
`;

export const TRANSMITTANCE_LOOKUP = /* glsl */ `
uniform sampler2D uTransLUT;
vec3 transmittanceRM( float r, float mu ) {
  float H = sqrt( Rt * Rt - Rg * Rg );
  float rho = sqrt( max( r * r - Rg * Rg, 0.0 ) );
  float disc = r * r * ( mu * mu - 1.0 ) + Rt * Rt;
  float d = max( 0.0, - r * mu + sqrt( max( disc, 0.0 ) ) );
  float dMin = Rt - r, dMax = rho + H;
  vec2 uv = vec2( ( d - dMin ) / max( dMax - dMin, 1e-4 ), rho / H );
  return texture2D( uTransLUT, uv ).rgb;
}
// Transmittance from pos toward a light, with a soft planet shadow (sun disc size).
vec3 lightTransmittance( vec3 pos, vec3 L ) {
  float r = length( pos );
  float mu = dot( pos / r, L );
  float muH = - sqrt( max( 1.0 - ( Rg / r ) * ( Rg / r ), 0.0 ) );
  float vis = smoothstep( muH - 0.006, muH + 0.004, mu );
  return transmittanceRM( r, mu ) * vis;
}
`;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }
`;

const TRANSMITTANCE_FRAG = /* glsl */ `
${ATMO_COMMON}
varying vec2 vUv;
void main() {
  float H = sqrt( Rt * Rt - Rg * Rg );
  float rho = H * vUv.y;
  float r = sqrt( rho * rho + Rg * Rg );
  float dMin = Rt - r, dMax = rho + H;
  float d = dMin + vUv.x * ( dMax - dMin );
  float mu = d < 1e-4 ? 1.0 : ( H * H - rho * rho - d * d ) / ( 2.0 * r * d );
  mu = clamp( mu, -1.0, 1.0 );
  vec3 pos = vec3( 0.0, r, 0.0 );
  vec3 dir = vec3( sqrt( 1.0 - mu * mu ), mu, 0.0 );
  vec3 od = vec3( 0.0 );
  const int N = 48;
  float dt = d / float( N );
  for ( int i = 0; i < N; i ++ ) {
    vec3 p = pos + dir * ( ( float( i ) + 0.5 ) * dt );
    vec3 rs; float ms; vec3 ext;
    scatteringAt( length( p ) - Rg, rs, ms, ext );
    od += ext * dt;
  }
  gl_FragColor = vec4( exp( - od ), 1.0 );
}
`;

const MULTISCATTER_FRAG = /* glsl */ `
${ATMO_COMMON}
${TRANSMITTANCE_LOOKUP}
uniform float uGroundAlbedo;
varying vec2 vUv;
vec3 sphericalDir( float theta, float phi ) {
  float cp = cos( phi ), sp = sin( phi ), ct = cos( theta ), st = sin( theta );
  return vec3( sp * st, cp, sp * ct );
}
void main() {
  float sunCos = 2.0 * vUv.x - 1.0;
  float sunTheta = acos( clamp( sunCos, -1.0, 1.0 ) );
  float height = mix( Rg + 0.01, Rt - 0.01, vUv.y );
  vec3 pos = vec3( 0.0, height, 0.0 );
  vec3 sunDir = normalize( vec3( 0.0, sunCos, - sin( sunTheta ) ) );
  vec3 lumTotal = vec3( 0.0 ), fms = vec3( 0.0 );
  const int SQ = 8;
  const float INV = 1.0 / float( SQ * SQ );
  for ( int i = 0; i < SQ; i ++ ) {
    for ( int j = 0; j < SQ; j ++ ) {
      float theta = FL_PI * ( float( i ) + 0.5 ) / float( SQ );
      float phi = acos( clamp( 1.0 - 2.0 * ( float( j ) + 0.5 ) / float( SQ ), -1.0, 1.0 ) );
      vec3 rd = sphericalDir( theta, phi );
      float atmoDist = raySphere( pos, rd, Rt );
      float groundDist = raySphere( pos, rd, Rg );
      float tMax = groundDist > 0.0 ? groundDist : atmoDist;
      float c = dot( rd, sunDir );
      float mp = phaseMie( c ), rp = phaseRayleigh( -c );
      vec3 lum = vec3( 0.0 ), lumF = vec3( 0.0 ), tr = vec3( 1.0 );
      float t = 0.0;
      const float STEPS = 20.0;
      for ( float s = 0.0; s < STEPS; s += 1.0 ) {
        float nt = ( ( s + 0.3 ) / STEPS ) * tMax;
        float dt = nt - t; t = nt;
        vec3 p = pos + t * rd;
        vec3 rs; float ms; vec3 ext;
        scatteringAt( length( p ) - Rg, rs, ms, ext );
        vec3 st = exp( - dt * ext );
        vec3 sNoPhase = rs + ms;
        lumF += tr * ( sNoPhase - sNoPhase * st ) / ext;
        vec3 sunT = lightTransmittance( p, sunDir );
        vec3 inS = ( rs * rp + ms * mp ) * sunT;
        lum += tr * ( inS - inS * st ) / ext;
        tr *= st;
      }
      if ( groundDist > 0.0 ) {
        vec3 hp = pos + groundDist * rd;
        if ( dot( pos, sunDir ) > 0.0 ) {
          hp = normalize( hp ) * Rg;
          lum += tr * uGroundAlbedo * lightTransmittance( hp, sunDir ) * max( dot( normalize( hp ), sunDir ), 0.0 ) / FL_PI;
        }
      }
      fms += lumF * INV;
      lumTotal += lum * INV;
    }
  }
  gl_FragColor = vec4( lumTotal / ( 1.0 - fms ), 1.0 );
}
`;

const SKYVIEW_FRAG = /* glsl */ `
${ATMO_COMMON}
${TRANSMITTANCE_LOOKUP}
uniform sampler2D uMSLUT;
uniform float uCamAlt; // km above sea level (= Rg)
uniform float uHorizonDip;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform float uMoonE; // moon illuminance relative to the sun
uniform float uGroundAlbedo;
varying vec2 vUv;
vec3 msAt( vec3 p, vec3 L ) {
  float r = length( p );
  float mu = dot( p / r, L );
  vec2 uv = vec2( mu * 0.5 + 0.5, clamp( ( r - Rg ) / ( Rt - Rg ), 0.0, 1.0 ) );
  return texture2D( uMSLUT, uv ).rgb;
}
void main() {
  float az = ( vUv.x - 0.5 ) * 2.0 * FL_PI;
  float v = vUv.y;
  float el = v < 0.5 ? - pow( 1.0 - 2.0 * v, 2.0 ) : pow( 2.0 * v - 1.0, 2.0 );
  el = el * 0.5 * FL_PI - uHorizonDip;
  float ce = cos( el );
  vec3 rd = vec3( sin( az ) * ce, sin( el ), - cos( az ) * ce );
  vec3 pos = vec3( 0.0, Rg + max( uCamAlt, 0.005 ), 0.0 );
  float atmoDist = raySphere( pos, rd, Rt );
  float groundDist = raySphere( pos, rd, Rg );
  float tMax = groundDist > 0.0 ? groundDist : atmoDist;
  float cS = dot( rd, uSunDir ), cM = dot( rd, uMoonDir );
  float rpS = phaseRayleigh( cS ), mpS = phaseMie( cS );
  float rpM = phaseRayleigh( cM ), mpM = phaseMie( cM );
  vec3 lum = vec3( 0.0 ), tr = vec3( 1.0 );
  float t = 0.0;
  const float STEPS = 30.0;
  for ( float s = 0.0; s < STEPS; s += 1.0 ) {
    // denser samples near the camera where the air is thick
    float f = ( s + 0.3 ) / STEPS;
    float nt = f * f * tMax;
    float dt = nt - t; t = nt;
    vec3 p = pos + t * rd;
    vec3 rs; float ms; vec3 ext;
    scatteringAt( length( p ) - Rg, rs, ms, ext );
    vec3 st = exp( - dt * ext );
    vec3 sunT = lightTransmittance( p, uSunDir );
    vec3 psiS = msAt( p, uSunDir );
    vec3 inS = rs * ( rpS * sunT + psiS ) + ms * ( mpS * sunT + psiS );
    if ( uMoonE > 0.0 ) {
      vec3 moonT = lightTransmittance( p, uMoonDir );
      vec3 psiM = msAt( p, uMoonDir );
      inS += uMoonE * ( rs * ( rpM * moonT + psiM ) + ms * ( mpM * moonT + psiM ) );
    }
    lum += tr * ( inS - inS * st ) / ext;
    tr *= st;
  }
  if ( groundDist > 0.0 ) {
    // light reflected by the (snowy) ground far below the horizon
    vec3 hp = normalize( pos + groundDist * rd ) * Rg;
    vec3 n = normalize( hp );
    vec3 g = lightTransmittance( hp, uSunDir ) * max( dot( n, uSunDir ), 0.0 )
           + uMoonE * lightTransmittance( hp, uMoonDir ) * max( dot( n, uMoonDir ), 0.0 );
    lum += tr * uGroundAlbedo / FL_PI * g;
  }
  gl_FragColor = vec4( lum, 1.0 );
}
`;

function makeTarget(w: number, h: number, wrapS: THREE.Wrapping = THREE.ClampToEdgeWrapping) {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    generateMipmaps: false,
  });
  rt.texture.wrapS = wrapS;
  rt.texture.wrapT = THREE.ClampToEdgeWrapping;
  rt.texture.colorSpace = THREE.NoColorSpace;
  return rt;
}

export class AtmosphereLUT {
  readonly transmittance = makeTarget(256, 64);
  readonly multiScatter = makeTarget(32, 32);
  readonly skyView = makeTarget(256, 128, THREE.RepeatWrapping);
  /** Haze multiplier (Mie density). Changing it rebuilds the static LUTs. */
  mie = 2.2;
  groundAlbedo = 0.7;

  private transQuad: FullScreenQuad;
  private msQuad: FullScreenQuad;
  private skyQuad: FullScreenQuad;
  readonly skyUniforms = {
    uMie: { value: this.mie },
    uTransLUT: { value: this.transmittance.texture },
    uMSLUT: { value: this.multiScatter.texture },
    uCamAlt: { value: 0.2 },
    uHorizonDip: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
    uMoonE: { value: 0 },
    uGroundAlbedo: { value: this.groundAlbedo },
  };
  private staticDirty = true;
  private builtMie = -1;

  constructor(private renderer: THREE.WebGLRenderer) {
    const common = { uMie: this.skyUniforms.uMie, uTransLUT: this.skyUniforms.uTransLUT, uGroundAlbedo: this.skyUniforms.uGroundAlbedo };
    this.transQuad = new FullScreenQuad(
      new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: TRANSMITTANCE_FRAG, uniforms: { uMie: common.uMie }, depthTest: false, depthWrite: false }),
    );
    this.msQuad = new FullScreenQuad(
      new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: MULTISCATTER_FRAG, uniforms: common, depthTest: false, depthWrite: false }),
    );
    this.skyQuad = new FullScreenQuad(
      new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: SKYVIEW_FRAG, uniforms: this.skyUniforms, depthTest: false, depthWrite: false }),
    );
  }

  /** Horizon dip (radians) for a camera at `altM` metres. */
  static horizonDip(altM: number) {
    const r = R_GROUND + Math.max(altM, 5) / 1000;
    return Math.acos(R_GROUND / r);
  }

  update(camAltM: number, sunDir: THREE.Vector3, moonDir: THREE.Vector3, moonE: number) {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    if (this.staticDirty || this.builtMie !== this.mie) {
      this.skyUniforms.uMie.value = this.mie;
      this.skyUniforms.uGroundAlbedo.value = this.groundAlbedo;
      r.setRenderTarget(this.transmittance);
      this.transQuad.render(r);
      r.setRenderTarget(this.multiScatter);
      this.msQuad.render(r);
      this.staticDirty = false;
      this.builtMie = this.mie;
    }
    const u = this.skyUniforms;
    u.uCamAlt.value = Math.max(camAltM, 5) / 1000;
    u.uHorizonDip.value = AtmosphereLUT.horizonDip(camAltM);
    u.uSunDir.value.copy(sunDir);
    u.uMoonDir.value.copy(moonDir);
    u.uMoonE.value = moonE;
    r.setRenderTarget(this.skyView);
    this.skyQuad.render(r);
    r.setRenderTarget(prev);
  }

  dispose() {
    this.transmittance.dispose();
    this.multiScatter.dispose();
    this.skyView.dispose();
    this.transQuad.dispose();
    this.msQuad.dispose();
    this.skyQuad.dispose();
  }
}

// ------------------------------------------------------------------------------------------------
// CPU transmittance (sun/moon light colour at a given altitude). Mirrors the GLSL model.
// ------------------------------------------------------------------------------------------------
const _p = new THREE.Vector3();
/** Transmittance from altitude `altM` (m) toward a direction with vertical component `mu`. Writes rgb. */
export function cpuTransmittance(altM: number, mu: number, mie: number, out: THREE.Color): THREE.Color {
  const r = R_GROUND + Math.max(altM, 1) / 1000;
  const muH = -Math.sqrt(Math.max(1 - (R_GROUND / r) ** 2, 0));
  // Planet shadow, softened like the shader.
  const vis = THREE.MathUtils.smoothstep(mu, muH - 0.006, muH + 0.004);
  if (vis <= 0) return out.setRGB(0, 0, 0);
  const m = Math.max(mu, muH + 0.001);
  const dirX = Math.sqrt(Math.max(1 - m * m, 0)),
    dirY = m;
  // distance to top of atmosphere
  const b = r * dirY;
  const c = r * r - R_TOP * R_TOP;
  const d = -b + Math.sqrt(Math.max(b * b - c, 0));
  const N = 48;
  const dt = d / N;
  let oR = 0,
    oG = 0,
    oB = 0;
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) * dt;
    _p.set(dirX * t, r + dirY * t, 0);
    const h = Math.max(_p.length() - R_GROUND, 0);
    const rd = Math.exp(-h / 8);
    const md = Math.exp(-h / 1.2) * mie;
    const oz = Math.max(0, 1 - Math.abs(h - 25) / 15);
    oR += (RAYLEIGH[0] * rd + MIE_EXT * md + OZONE[0] * oz) * dt;
    oG += (RAYLEIGH[1] * rd + MIE_EXT * md + OZONE[1] * oz) * dt;
    oB += (RAYLEIGH[2] * rd + MIE_EXT * md + OZONE[2] * oz) * dt;
  }
  return out.setRGB(Math.exp(-oR) * vis, Math.exp(-oG) * vis, Math.exp(-oB) * vis);
}

export { SKY_LUT_GLSL };
