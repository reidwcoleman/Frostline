// The render pipeline: scene -> N8AO (SSAO) -> bloom + grade (tone map, colour, frost, damage, speed)
// -> SMAA -> screen. Everything is HDR (half float) until the grade. Quality changes rebuild the passes
// (a one-off in the settings menu); nothing recompiles during play.
import * as THREE from 'three';
import { BloomEffect, BlendFunction, Effect, EffectComposer, EffectPass, RenderPass, SMAAEffect, SMAAPreset } from 'postprocessing';

/** One bad pixel (NaN / Inf from a razor-sharp sun glint in half float) would otherwise be blurred
 *  across the whole screen by bloom and flash it black. Scrub those and cap extreme highlights. */
class SanitizeEffect extends Effect {
  constructor() {
    super(
      'Sanitize',
      `void mainImage( const in vec4 inputColor, const in vec2 uv, out vec4 outputColor ) {
        vec3 c = inputColor.rgb;
        bvec3 bad = bvec3( c.r != c.r || c.r > 6.0e4, c.g != c.g || c.g > 6.0e4, c.b != c.b || c.b > 6.0e4 );
        if ( any( bad ) ) c = vec3( 0.0 );
        outputColor = vec4( clamp( c, 0.0, 48.0 ), inputColor.a );
      }`,
      { blendFunction: BlendFunction.SET },
    );
  }
}
import { N8AOPostPass } from 'n8ao';
import type { GameContext, GameState, System } from '../core/types';
import { clamp, damp, lerp, smoothstep } from '../core/math';
import { GradeEffect } from './GradeEffect';
import { createFrostTexture } from './FrostTexture';

export class PostFX implements System {
  readonly name = 'post';
  readonly updateWhen: GameState[] = ['menu', 'playing', 'paused', 'dead'];

  private composer: EffectComposer | null = null;
  private renderPass: RenderPass | null = null;
  private ao: N8AOPostPass | null = null;
  private bloom: BloomEffect | null = null;
  private grade: GradeEffect | null = null;
  private passA: EffectPass | null = null;
  private passB: EffectPass | null = null;
  private frostRT: THREE.WebGLRenderTarget | null = null;

  /** Smoothed overlay states. */
  private frost = 0;
  private damage = 0;
  private speed = 0;
  private adapt = 0;
  private builtQuality = '';
  private ready = false;

  constructor(private ctx: GameContext) {}

  init() {
    const { renderer, events } = this.ctx;
    // Tone mapping and sRGB encoding happen in GradeEffect; the renderer must not do either.
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.frostRT = createFrostTexture(renderer);
    this.build();
    events.on('settings', ({ key }) => {
      if (key === 'quality' && this.ctx.settings.data.quality !== this.builtQuality) this.build();
    });
    events.on('player:damaged', ({ amount }) => {
      this.damage = Math.min(1, this.damage + 0.35 + amount / 40);
    });
    events.on('player:respawned', () => {
      this.frost = 0;
      this.damage = 0;
    });
    this.ready = true;
  }

  private build() {
    const { renderer, scene, camera, settings } = this.ctx;
    const q = settings.quality;
    this.dispose();
    this.builtQuality = settings.data.quality;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0, stencilBuffer: false });
    this.renderPass = new RenderPass(scene, camera);
    composer.addPass(this.renderPass);

    if (q.ssao) {
      const ao = new N8AOPostPass(scene, camera, size.x, size.y);
      const c = ao.configuration;
      c.aoRadius = 2.2;
      c.distanceFalloff = 0.6;
      c.intensity = 2.2;
      c.aoSamples = settings.data.quality === 'ultra' ? 16 : 10;
      c.denoiseSamples = 6;
      c.denoiseRadius = 10;
      c.halfRes = settings.data.quality !== 'ultra';
      c.depthAwareUpsampling = true;
      c.gammaCorrection = false;
      c.screenSpaceRadius = false;
      c.color = new THREE.Color(0.02, 0.04, 0.09);
      composer.addPass(ao);
      this.ao = ao;
    }

    composer.addPass(new EffectPass(camera, new SanitizeEffect()));

    this.grade = new GradeEffect(this.frostRT!.texture);
    const effects: (BloomEffect | GradeEffect)[] = [];
    if (q.bloom) {
      this.bloom = new BloomEffect({
        blendFunction: BlendFunction.ADD,
        mipmapBlur: true,
        luminanceThreshold: 1.2,
        luminanceSmoothing: 0.35,
        intensity: 0.55,
        radius: 0.72,
        levels: 7,
      });
      effects.push(this.bloom);
    }
    effects.push(this.grade);
    this.passA = new EffectPass(camera, ...effects);
    composer.addPass(this.passA);
    const smaa = new SMAAEffect({ preset: settings.data.quality === 'low' ? SMAAPreset.MEDIUM : SMAAPreset.HIGH });
    this.passB = new EffectPass(camera, smaa);
    this.passB.dithering = true;
    composer.addPass(this.passB);
    this.composer = composer;
    const w = window.innerWidth,
      h = window.innerHeight;
    composer.setSize(w, h, false);
  }

  resize(w: number, h: number) {
    this.composer?.setSize(w, h, false);
  }

  /** Called by Game every frame after all updates. */
  render(dt: number) {
    const { renderer, scene, camera } = this.ctx;
    if (!this.composer || !this.ready) {
      renderer.render(scene, camera);
      return;
    }
    this.updateUniforms(dt);
    this.composer.render(dt);
  }

  private updateUniforms(dt: number) {
    const { sys, player, settings, game } = this.ctx;
    const sky = sys.sky;
    const wv = sys.weather.visual;
    const g = this.grade!;
    // Eye adaptation: stepping into a cabin, the eye opens up over a couple of seconds.
    const shelter = (this.ctx.sys.survival as unknown as { shelter?: { indoors?: boolean } })?.shelter;
    this.adapt = damp(this.adapt, shelter?.indoors ? 1 : 0, shelter?.indoors ? 1.2 : 2.5, dt);
    const exposure = sky.exposure * 1.12 * (1 + this.adapt * 1.8);
    g.u<number>('uExposure').value = exposure;
    if (this.bloom) {
      // keep the bloom threshold in display terms whatever the exposure
      this.bloom.luminanceMaterial.threshold = 1.35 / exposure;
      this.bloom.intensity = lerp(0.5, 0.35, wv.storm);
    }
    const golden = sky.golden;
    const night = sky.night;
    // Look: a little punch by day, flatter in storms.
    const look = g.u<THREE.Vector4>('uLook').value;
    look.set(lerp(1.18, 1.08, wv.cloudCover), lerp(1.12, 1.0, wv.cloudCover), 0.1 + 0.06 * golden, lerp(1.06, 0.9, wv.storm));
    // Split tone: blue shadows always (the art direction's #9DB4D9 snow in shade), warm highlights by
    // day, amber at golden hour, cold steel under cloud.
    const lift = g.u<THREE.Vector3>('uLift').value;
    lift.set(-0.012 - 0.01 * golden, 0.004, 0.032 + 0.012 * golden - 0.012 * night);
    const gain = g.u<THREE.Vector3>('uGain').value;
    const warm = (1 - night) * (1 - wv.cloudCover * 0.7);
    gain.set(1 + 0.025 * warm + 0.06 * golden, 1 + 0.004 * warm + 0.005 * golden, 1 - 0.035 * warm - 0.07 * golden);
    const np = g.u<THREE.Vector4>('uNightP').value;
    np.x = 0.42 * smoothstep(0.35, 1, night);
    np.z = 0.2 + 0.08 * night;
    np.w = 0.2 * wv.storm;
    const white = g.u<THREE.Vector3>('uWhite').value;
    white.set(0.8, 0.83, 0.87).multiplyScalar(1 - 0.55 * night);

    // Gameplay overlays
    const playing = game.state === 'playing' || game.state === 'paused' || game.state === 'dead';
    const warmth = playing ? player.warmth : 100;
    // Frost creeps in below ~40 warmth, slowly; recedes faster when you warm up.
    const frostTarget = clamp(smoothstep(42, 4, warmth), 0, 1);
    this.frost = damp(this.frost, frostTarget, frostTarget > this.frost ? 0.35 : 0.9, dt);
    g.u<number>('uFrost').value = this.frost < 0.002 ? 0 : this.frost;
    this.damage = Math.max(0, this.damage - dt * 1.6);
    g.u<number>('uDamage').value = this.damage * this.damage;
    const kmh = playing ? Math.hypot(player.velocity.x, player.velocity.y, player.velocity.z) * 3.6 : 0;
    const speedTarget = settings.data.motionBlur ? smoothstep(60, 120, kmh) : 0;
    this.speed = damp(this.speed, speedTarget, 4, dt);
    g.u<number>('uSpeed').value = this.speed < 0.003 ? 0 : this.speed;

    // AO: soften in fog so nearby objects don't get dark halos through a whiteout.
    if (this.ao) this.ao.configuration.intensity = lerp(2.2, 0.6, clamp(wv.weatherFog / 0.02, 0, 1)) * (1 - 0.4 * night);
  }

  dispose() {
    this.composer?.dispose();
    this.composer = null;
    this.ao = null;
    this.bloom = null;
    this.grade = null;
    this.passA = this.passB = null;
    this.renderPass = null;
  }
}
