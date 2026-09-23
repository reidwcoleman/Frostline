// Final look: exposure, AgX tone mapping with a punchy look, Firewatch-style split toning (cool shadows,
// warm highlights, stronger at golden hour), night desaturation, whiteout veil, vignette, and the
// gameplay overlays — creeping screen-edge frost when the player is freezing, a red damage pulse, and a
// radial speed blur on fast descents. Outputs display-referred sRGB (the renderer's output colour space
// is linear so nothing re-encodes it; SMAA then works on perceptual values).
import * as THREE from 'three';
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';

const FRAG = /* glsl */ `
uniform float uExposure;
uniform vec4 uLook;     // x: agx power, y: agx saturation, z: s-curve, w: saturation
uniform vec3 uLift;     // shadow tint (display offset)
uniform vec3 uGain;     // highlight tint (multiplier)
uniform vec4 uNightP;   // x: night desat, y: unused, z: vignette, w: whiteout veil
uniform vec3 uWhite;    // whiteout veil colour
uniform float uFrost;   // 0..1
uniform sampler2D uFrostTex;
uniform float uDamage;  // 0..1
uniform float uSpeed;   // 0..1

const mat3 FL_SRGB_TO_2020 = mat3(
  vec3( 0.6274, 0.0691, 0.0164 ),
  vec3( 0.3293, 0.9195, 0.0880 ),
  vec3( 0.0433, 0.0113, 0.8956 )
);
const mat3 FL_2020_TO_SRGB = mat3(
  vec3( 1.6605, - 0.1246, - 0.0182 ),
  vec3( - 0.5876, 1.1329, - 0.1006 ),
  vec3( - 0.0728, - 0.0083, 1.1187 )
);
vec3 flAgxContrast( vec3 x ) {
  vec3 x2 = x * x; vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 flAgx( vec3 color ) {
  const mat3 inset = mat3(
    vec3( 0.856627153315983, 0.137318972929847, 0.11189821299995 ),
    vec3( 0.0951212405381588, 0.761241990602591, 0.0767994186031903 ),
    vec3( 0.0482516061458583, 0.101439036467562, 0.811302368396859 ) );
  const mat3 outset = mat3(
    vec3( 1.1271005818144368, - 0.1413297634984383, - 0.14132976349843826 ),
    vec3( - 0.11060664309660323, 1.157823702216272, - 0.11060664309660294 ),
    vec3( - 0.016493938717834573, - 0.016493938717834257, 1.2519364065950405 ) );
  const float minEv = - 12.47393;
  const float maxEv = 4.026069;
  color = inset * ( FL_SRGB_TO_2020 * color );
  color = clamp( ( log2( max( color, 1e-10 ) ) - minEv ) / ( maxEv - minEv ), 0.0, 1.0 );
  color = flAgxContrast( color );
  // look: power + saturation in the AgX display domain
  float luma = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
  color = pow( max( color, 0.0 ), vec3( uLook.x ) );
  color = luma + uLook.y * ( color - luma );
  color = outset * color;
  color = pow( max( vec3( 0.0 ), color ), vec3( 2.2 ) );
  return clamp( FL_2020_TO_SRGB * color, 0.0, 1.0 );
}
vec3 flEncode( vec3 c ) {
  return mix( c * 12.92, 1.055 * pow( c, vec3( 0.41666 ) ) - 0.055, step( 0.0031308, c ) );
}

void mainImage( const in vec4 inputColor, const in vec2 uv, out vec4 outputColor ) {
  vec3 hdr = inputColor.rgb;
  vec2 c = uv - 0.5;
  vec2 ca = c * vec2( aspect, 1.0 );

  // Speed: radial smear toward the edges (the centre stays sharp so you can steer).
  if ( uSpeed > 0.002 ) {
    float r = length( ca );
    float amt = uSpeed * smoothstep( 0.1, 0.8, r ) * 0.055;
    vec3 acc = hdr;
    for ( int i = 1; i < 8; i ++ ) acc += texture2D( inputBuffer, uv - c * amt * float( i ) ).rgb;
    hdr = acc / 8.0;
  }

  // Frost: the view refracts through ice that creeps in from the edges.
  float fm = 0.0;
  vec4 f = vec4( 0.0 );
  if ( uFrost > 0.002 ) {
    f = texture2D( uFrostTex, vec2( uv.x, ( uv.y - 0.5 ) / aspect + 0.5 ) );
    vec2 e2 = abs( c ) * 2.0;
    float e = pow( pow( e2.x, 4.0 ) + pow( e2.y, 4.0 ), 0.25 );
    float front = e + f.r * 0.62 - ( 1.5 - uFrost * 1.2 );
    fm = smoothstep( 0.0, 0.16, front ) * smoothstep( 0.0, 0.1, uFrost );
    if ( fm > 0.001 ) {
      vec2 off = ( f.gb * 2.0 - 1.0 ) * 0.02 * fm;
      vec3 r0 = texture2D( inputBuffer, uv + off ).rgb;
      vec3 r1 = texture2D( inputBuffer, uv + off * 2.0 + vec2( 0.0025, 0.0 ) ).rgb;
      vec3 r2 = texture2D( inputBuffer, uv + off * 2.0 - vec2( 0.0, 0.0025 ) ).rgb;
      hdr = mix( hdr, ( r0 + r1 + r2 ) / 3.0, fm );
    }
  }

  vec3 col = flEncode( flAgx( hdr * uExposure ) );

  // Split toning: cool lifted shadows, warm highlights.
  float L = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
  col += uLift * ( 1.0 - smoothstep( 0.0, 0.62, L ) );
  col *= mix( vec3( 1.0 ), uGain, smoothstep( 0.25, 0.95, L ) );
  col = clamp( col, 0.0, 1.0 );
  // gentle S-curve and saturation
  col = mix( col, col * col * ( 3.0 - 2.0 * col ), uLook.z );
  L = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
  col = mix( vec3( L ), col, uLook.w );
  // Night vision: dim light loses colour and shifts blue (bright things — fire, aurora — keep theirs).
  col = mix( col, L * vec3( 0.74, 0.88, 1.22 ), uNightP.x * ( 1.0 - smoothstep( 0.12, 0.45, L ) ) );
  // Whiteout: contrast drains into the snow-glare veil.
  col = mix( col, uWhite, uNightP.w );

  if ( fm > 0.001 ) {
    float thick = fm * ( 0.2 + 0.8 * f.r );
    vec3 ice = vec3( 0.84, 0.92, 1.0 ) * ( 0.5 + 0.5 * L );
    col = mix( col, ice, thick * 0.6 );
    col += vec3( 0.95, 0.98, 1.0 ) * f.a * fm * ( 0.55 + 0.45 * sin( time * 2.7 + uv.x * 57.0 + uv.y * 31.0 ) );
  }

  float v = dot( ca, ca );
  col *= 1.0 - uNightP.z * v * 1.25;

  if ( uDamage > 0.001 ) {
    float dv = smoothstep( 0.05, 0.6, v );
    col = mix( col, vec3( 0.52, 0.02, 0.03 ), uDamage * dv * 0.9 );
  }
  outputColor = vec4( clamp( col, 0.0, 1.0 ), inputColor.a );
}
`;

export class GradeEffect extends Effect {
  constructor(frost: THREE.Texture) {
    super('GradeEffect', FRAG, {
      attributes: EffectAttribute.CONVOLUTION,
      blendFunction: BlendFunction.SET,
      uniforms: new Map<string, THREE.Uniform>([
        ['uExposure', new THREE.Uniform(1)],
        ['uLook', new THREE.Uniform(new THREE.Vector4(1.2, 1.12, 0.12, 1.05))],
        ['uLift', new THREE.Uniform(new THREE.Vector3(-0.01, 0.005, 0.03))],
        ['uGain', new THREE.Uniform(new THREE.Vector3(1.03, 1.0, 0.96))],
        ['uNightP', new THREE.Uniform(new THREE.Vector4(0, 0, 0.18, 0))],
        ['uWhite', new THREE.Uniform(new THREE.Vector3(0.85, 0.87, 0.9))],
        ['uFrost', new THREE.Uniform(0)],
        ['uFrostTex', new THREE.Uniform(frost)],
        ['uDamage', new THREE.Uniform(0)],
        ['uSpeed', new THREE.Uniform(0)],
      ]),
    });
  }

  u<T = unknown>(name: string): THREE.Uniform<T> {
    return this.uniforms.get(name) as THREE.Uniform<T>;
  }
}
