// Sky, sun/moon lighting, cascaded shadows, image-based ambient and the global atmosphere uniforms.
//
//  - Sky dome: physically based scattering LUT + sun/moon discs, stars, Milky Way, aurora, clouds.
//  - Sun: one SunLight with N texel-snapped cascades (FrostSunShadow) that becomes moonlight at night.
//  - Mountain shadows (TerrainShadow) and cloud shadows are applied to the sun in every material.
//  - Ambient: a PMREM of the sky (with a lit-snow ground) on scene.environment, refreshed every couple
//    of seconds or on big changes. Use MeshStandardMaterial/MeshPhysicalMaterial to receive it.
//  - Light pool: a fixed set of PointLights (no shader recompiles) for fires, torches and flares.
import * as THREE from 'three';
import { SunLight } from 'three/addons/lights/SunLight.js';
import type { GameContext, GameState, System } from '../core/types';
import { clamp, damp, smoothstep } from '../core/math';
import { G, installChunks, installMaterialHook } from './globals';
import { AtmosphereLUT, cpuTransmittance } from './AtmosphereLUT';
import { computeCelestial, newCelestial } from './Celestial';
import { createCloudNoise } from './CloudNoise';
import { AuroraMap } from './Aurora';
import { FrostSunShadow } from './SunShadow';
import { TerrainShadow } from './TerrainShadow';
import { createProbeMaterial, createSkyMaterial, createSkyMesh, createSkyUniforms, PROBE_WIDTH, type SkyUniforms } from './SkyDome';

installMaterialHook();

/** A pooled point light (fires, torches, flares). Pooling avoids shader recompiles. */
export interface LightHandle {
  light: THREE.PointLight;
  release(): void;
}

export const LIGHT_POOL_SIZE = 6;

/** Sun illuminance above the atmosphere, in three.js light units. */
const SUN_E = 4.6;
/** Full-moon illuminance relative to the sun (art-directed: bright enough to play by). */
const MOON_REL = 0.032;
/** Sun disc radiance cap (keeps bloom tasteful; true radiance would be ~1e5). */
const SUN_DISC = 90;
const SNOW_ALBEDO = 0.8;
const MOON_TINT = new THREE.Color(0.62, 0.74, 1.0);

const _c = new THREE.Color();
const _c2 = new THREE.Color();
const _v = new THREE.Vector3();

export class Sky implements System {
  readonly name = 'sky';
  readonly updateWhen: GameState[] = ['menu', 'playing', 'paused', 'dead'];

  /** The sun (and, at night, moon) light. SunLight = directional light with cascaded shadows. */
  readonly sun: SunLight;
  readonly shadow: FrostSunShadow;
  /** Kept for API compatibility; ambient comes from scene.environment (not added to the scene). */
  readonly hemi = new THREE.HemisphereLight(0xbfd6ff, 0xe8eef8, 0);

  /** Exposure the post stack should apply (scene-referred -> display). */
  exposure = 1;
  /** 0..1 how "golden" the light is (low warm sun) — the grade uses it. */
  golden = 0;
  /** 0..1 night factor for the grade. */
  night = 0;
  /** Current light-source colour & intensity (sun or moon). */
  readonly lightColor = new THREE.Color();
  lightIntensity = 0;
  /** Sky irradiance / π (average sky radiance) from the probe, linear rgb. */
  readonly ambient = new THREE.Color(0.2, 0.25, 0.35);
  /** Sun screen position helper for the post stack (world direction of the dominant light). */
  readonly lightDir = new THREE.Vector3(0, 1, 0);
  /** Compass rotation of the sky so the sunset hangs over the lake as seen from the spawn. */
  skyYaw = 0;

  private pool: THREE.PointLight[] = [];
  private used = new Set<THREE.PointLight>();

  private cel = newCelestial();
  private lut!: AtmosphereLUT;
  private aurora!: AuroraMap;
  private terrainShadow: TerrainShadow | null = null;
  private noise!: THREE.DataTexture;
  private skyU!: SkyUniforms;
  private dome!: THREE.Mesh;
  // environment capture
  private envScene = new THREE.Scene();
  private cubeRT!: THREE.WebGLCubeRenderTarget;
  private cubeCam!: THREE.CubeCamera;
  private pmrem!: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private envTimer = 0;
  private envSunDir = new THREE.Vector3(0, -2, 0);
  private envCover = -1;
  // probe
  private probeRT!: THREE.WebGLRenderTarget;
  private probeMesh!: THREE.Mesh;
  private probeScene = new THREE.Scene();
  private probeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private probeBuf = new Float32Array(PROBE_WIDTH * 4);
  private probeBusy = false;
  private probeTimer = 0;
  private probeValid = false;
  private probe = Array.from({ length: PROBE_WIDTH }, () => new THREE.Color());
  private exposureTarget = 1;
  private firstFrame = true;
  /** Frames left during which exposure snaps instead of adapting (waits for probe readbacks). */
  private snapExposure = 3;
  private lightIsMoon = false;

  constructor(private ctx: GameContext) {
    const q = ctx.settings.quality;
    installChunks(q.shadowCascades);
    ctx.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.sun = new SunLight(0xffffff, 3);
    this.shadow = new FrostSunShadow(q.shadowCascades);
    this.sun.shadow = this.shadow as unknown as typeof this.sun.shadow;
    this.sun.castShadow = true;
    this.sun.name = 'sun';
    this.applyShadowQuality();
    ctx.scene.add(this.sun);

    for (let i = 0; i < LIGHT_POOL_SIZE; i++) {
      const l = new THREE.PointLight(0xff9a50, 0, 18, 2);
      l.castShadow = false;
      l.name = 'poolLight' + i;
      this.pool.push(l);
      ctx.scene.add(l);
    }
    // Keep the scene's fog present forever (toggling it would recompile every material).
    ctx.scene.fog = new THREE.Fog(0xcfdcea, 1, 5000);
    ctx.scene.background = null;

    ctx.events.on('settings', ({ key }) => {
      if (key === 'quality') this.applyShadowQuality();
    });
  }

  /** Borrow a point light from the fixed pool (null if exhausted). Set colour/intensity/distance/position yourself. */
  acquireLight(): LightHandle | null {
    const light = this.pool.find((l) => !this.used.has(l));
    if (!light) return null;
    this.used.add(light);
    light.visible = true;
    let released = false;
    return {
      light,
      release: () => {
        if (released) return;
        released = true;
        light.intensity = 0;
        light.visible = true;
        this.used.delete(light);
      },
    };
  }

  /** Tiling RGBA noise shared by sky effects (clouds, aurora, spindrift). */
  get noiseTexture(): THREE.Texture | null {
    return this.noise ?? null;
  }

  /** Number of free pool lights. */
  get freeLights() {
    return LIGHT_POOL_SIZE - this.used.size;
  }

  private applyShadowQuality() {
    const q = this.ctx.settings.quality;
    const size = Math.min(q.shadowMapSize, Math.floor(16384 / this.shadow.cascades), 4096);
    if (this.shadow.mapSize.x !== size) {
      this.shadow.mapSize.set(size, size);
      if (this.shadow.map) {
        this.shadow.map.dispose();
        this.shadow.map = null;
      }
    }
    this.shadow.distance = q.shadowDistance;
    this.shadow.bias = -0.0004;
    this.shadow.normalBias = 0.035;
    this.shadow.radius = 2.2;
    this.shadow.camera.near = 1;
  }

  init() {
    const { renderer, scene, terrain } = this.ctx;
    this.noise = createCloudNoise(11);
    G.flCloudTex.value = this.noise;
    this.lut = new AtmosphereLUT(renderer);
    this.aurora = new AuroraMap(renderer, this.noise);

    // Face the sunset toward the lake from the spawn (a gorgeous first evening).
    if (terrain?.data) {
      const [sx, sz] = terrain.data.spawn;
      const [lx, lz] = terrain.data.lakeCenter;
      const dx = lx - sx,
        dz = lz - sz;
      if (Math.hypot(dx, dz) > 1) {
        // unrotated sunset azimuth is due west (-X); rotate west onto the spawn->lake direction
        const target = Math.atan2(dx, dz); // angle of (dx,dz) measured from +Z toward +X
        const west = Math.atan2(-1, 0);
        this.skyYaw = target - west;
      }
      this.terrainShadow = new TerrainShadow(renderer, terrain.heights, terrain.res, terrain.size);
    }

    this.skyU = createSkyUniforms();
    this.skyU.uTransLUT.value = this.lut.transmittance.texture;
    this.skyU.uNoise.value = this.noise;
    this.skyU.uAurora.value = this.aurora.target.texture;
    this.skyU.uMie.value = this.lut.mie;
    G.flSkyLUT.value = this.lut.skyView.texture;

    this.dome = createSkyMesh(createSkyMaterial(this.skyU, false));
    scene.add(this.dome);

    // Environment capture: sky with a snowy ground, prefiltered for PBR.
    const envMesh = createSkyMesh(createSkyMaterial(this.skyU, true));
    this.envScene.add(envMesh);
    this.cubeRT = new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType, generateMipmaps: false });
    this.cubeCam = new THREE.CubeCamera(0.05, 10, this.cubeRT);
    this.envScene.add(this.cubeCam);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileCubemapShader();

    // Probe (8x1 float) read back asynchronously for ambient colours and exposure.
    this.probeRT = new THREE.WebGLRenderTarget(PROBE_WIDTH, 1, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
    tri.setAttribute('uv', new THREE.Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
    this.probeMesh = new THREE.Mesh(tri, createProbeMaterial(this.skyU));
    this.probeMesh.frustumCulled = false;
    this.probeScene.add(this.probeMesh);

    this.update(0);
    this.captureEnv();
  }

  reset() {
    this.snap();
  }

  /** Converge everything immediately (after time jumps such as sleeping, loading or dev teleports). */
  snap() {
    this.firstFrame = true;
    this.snapExposure = 3;
    this.probeTimer = 0;
  }

  // ----------------------------------------------------------------------------------------------
  update(dt: number) {
    const { env, clock, camera, renderer } = this.ctx;
    const w = this.ctx.sys.weather;
    const vis = w.visual;
    const time = this.ctx.time;
    const cel = computeCelestial(clock.time, clock.day, this.skyYaw, this.cel);
    const sunDir = cel.sunDir,
      moonDir = cel.moonDir;
    const camAlt = camera.position.y;
    const mie = this.lut.mie;
    const cover = vis.cloudCover;

    // --- light sources -------------------------------------------------------------------------
    const sunT = cpuTransmittance(camAlt, sunDir.y, mie, _c);
    const sunLum = (sunT.r + sunT.g + sunT.b) / 3;
    const moonUp = smoothstep(-0.03, 0.08, moonDir.y);
    const moonE = MOON_REL * Math.pow(cel.moonIllum, 1.3);
    const sunElev = Math.asin(clamp(sunDir.y, -1, 1));
    // The single shadowed light follows the sun by day and the moon by night; the handover happens in
    // deep twilight where both are ~0, so nothing pops.
    const useMoon = sunElev < -0.075 && moonDir.y > 0.02 && moonE > 0.002;
    this.lightIsMoon = useMoon;
    // Cloud cover dims direct light globally (local cloud shadows add patches on top).
    const cloudDim = 1 - smoothstep(0.55, 1.0, cover) * 0.97;
    if (useMoon) {
      const mT = cpuTransmittance(camAlt, moonDir.y, mie, _c2);
      const k = smoothstep(-0.075, -0.13, sunElev) * moonUp;
      this.lightColor.copy(MOON_TINT).multiply(mT);
      this.lightIntensity = SUN_E * moonE * k * cloudDim;
      this.lightDir.copy(moonDir);
    } else {
      this.lightColor.copy(sunT);
      // Art direction: low sun reads amber (#FFB36B), not just "less blue".
      const warm = smoothstep(0.35, 0.04, sunDir.y) * (1 - cover * 0.8);
      this.lightColor.multiply(_c2.setRGB(1, 1 - 0.1 * warm, 1 - 0.28 * warm));
      this.lightIntensity = SUN_E * smoothstep(-0.02, 0.03, sunDir.y) * cloudDim;
      this.lightDir.copy(sunDir);
    }
    const li = Math.max(this.lightColor.r, this.lightColor.g, this.lightColor.b, 1e-4);
    this.sun.color.copy(this.lightColor).multiplyScalar(1 / li);
    this.sun.intensity = this.lightIntensity * li;
    this.sun.position.copy(this.lightDir);
    this.sun.updateMatrixWorld();

    // --- env state for other systems -----------------------------------------------------------
    env.sunDir.copy(sunDir);
    env.moonDir.copy(moonDir);
    env.sunColor.copy(sunT).multiplyScalar(1 / Math.max(sunT.r, sunT.g, sunT.b, 1e-4));
    env.sunIntensity = useMoon ? 0 : this.lightIntensity * li;
    env.daylight = smoothstep(-0.11, 0.14, sunDir.y);
    env.moonlight = clamp(cel.moonIllum * moonUp * (1 - env.daylight), 0, 1);
    this.night = 1 - smoothstep(-0.2, 0.02, sunDir.y);
    this.golden = smoothstep(0.42, 0.06, sunDir.y) * smoothstep(-0.05, 0.03, sunDir.y) * (1 - cover * 0.8);

    // --- atmosphere LUT + aurora ---------------------------------------------------------------
    this.lut.update(camAlt, sunDir, moonDir, moonE * moonUp);
    G.flSkyP.value.set(AtmosphereLUT.horizonDip(camAlt), SUN_E, cover, time);
    G.flLightDir.value.copy(this.lightDir);
    const auroraK = vis.aurora * (1 - smoothstep(0.1, 0.5, cover)) * smoothstep(-0.12, -0.22, sunDir.y);
    this.aurora.update(time, auroraK, cel.pole);

    // --- sky uniforms ---------------------------------------------------------------------------
    const u = this.skyU;
    u.uTime.value = time;
    u.uCamAltKm.value = Math.max(camAlt, 5) / 1000;
    u.uSunDir.value.copy(sunDir);
    u.uMoonDir.value.copy(moonDir);
    u.uSunDisc.value.setRGB(SUN_DISC, SUN_DISC * 0.98, SUN_DISC * 0.95).multiplyScalar(1 - smoothstep(0.6, 0.95, cover));
    u.uDiscP.value.z = 1.2 * (0.4 + 0.6 * this.night) * (1 - smoothstep(0.7, 1, cover));
    u.uDiscP.value.w = 0.015 * this.night;
    u.uAuroraK.value = auroraK * 1.0;
    const starVis = smoothstep(-0.05, -0.2, sunDir.y) * (1 - smoothstep(0.25, 0.8, cover));
    u.uStarP.value.set(cel.starAngle, 0.22 * starVis, 0.6, 0.05 * starVis * (1 - cel.moonIllum * 0.6));
    u.uPole.value.copy(cel.pole);
    u.uNightSky.value.setRGB(0.0012, 0.0019, 0.0042).multiplyScalar(1 - env.daylight);
    // light at the cloud tops: sun (reddened at dawn/dusk) + moon
    const cloudAlt = vis.cloudAltitude;
    const cs = cpuTransmittance(cloudAlt, sunDir.y, mie, _c);
    u.uCloudSun.value.copy(cs).multiplyScalar(SUN_E * smoothstep(-0.06, 0.02, sunDir.y));
    const cm = cpuTransmittance(cloudAlt, moonDir.y, mie, _c2);
    u.uCloudSun.value.add(cm.multiply(MOON_TINT).multiplyScalar(SUN_E * moonE * moonUp));
    u.uCloudLight.value.copy(sunDir.y > -0.06 || !useMoon ? sunDir : moonDir);
    // Clouds are lit by the clear sky around them (LUT-only probe: no feedback through the clouds).
    u.uCloudAmb.value.copy(this.probeValid ? this.probe[6] : this.ambient).multiplyScalar(1 - 0.5 * cover);
    u.uCloudP3.value.set(1.0 - cover * 0.6, 0.35 + 0.35 * cover, 0.2, this.ctx.camera.far * 0.95);

    // Cloud layer globals (the same field drives the ground cloud shadows)
    G.flCloudP.value.set(vis.cloudOffset.x, vis.cloudOffset.y, cover, cloudAlt);
    G.flCloudP2.value.set(1 / 5200, 1.0 + cover * 0.4, 0.9, vis.cloudThickness);
    // High cirrus (8 km): lit long after sunset
    u.uCirrus.value.set(vis.cirrus * (1 - smoothstep(0.7, 1.0, cover)), 8000, vis.cirrusAngle, 0.42);
    u.uCirrusOffset.value.set(vis.cloudOffset.x * 1.6, vis.cloudOffset.y * 1.6);
    const ct = cpuTransmittance(8000, sunDir.y, mie, _c);
    u.uCirrusSun.value.copy(ct).multiplyScalar(SUN_E * smoothstep(-0.09, 0.0, sunDir.y));

    // --- fog -----------------------------------------------------------------------------------
    this.updateFog(dt, vis);

    // --- probe & exposure ----------------------------------------------------------------------
    this.probeTimer -= dt;
    if (this.probeTimer <= 0 && !this.probeBusy) {
      this.probeTimer = 0.2;
      this.runProbe();
    }
    this.updateExposure(dt);

    // --- mountain shadows --------------------------------------------------------------------------
    if (this.terrainShadow) {
      if (this.firstFrame) this.terrainShadow.computeNow(this.lightDir);
      else this.terrainShadow.update(dt, this.lightDir, 0.011);
    }

    // --- environment map -------------------------------------------------------------------------
    this.envTimer -= dt;
    const moved = this.envSunDir.angleTo(sunDir) > 0.02 || Math.abs(this.envCover - cover) > 0.04;
    if (this.envTimer <= 0 || moved || this.firstFrame) {
      this.captureEnv();
    }

    // keep the dome centred (it renders at infinity, but the capture camera needs a position)
    this.dome.position.copy(camera.position);
    this.dome.updateMatrix();
    this.firstFrame = false;
    renderer.setRenderTarget(null);
  }

  private updateFog(dt: number, vis: import('./Weather').WeatherVisual) {
    const { env } = this.ctx;
    const amb = this.ambient;
    // Aerial perspective: stronger in the low valleys, softer on the summits.
    const haze = 2.6e-4 * vis.hazeMul;
    G.flFogA.value.set(haze, 1300, vis.weatherFog, 1);
    G.flFogB.value.set(vis.valleyFog, 1 / 70, this.ctx.terrain?.lakeLevel ?? 150, 0);
    // Dense fog is lit like a white diffuser: sky irradiance + a share of the direct light.
    const direct = this.lightIntensity * Math.max(this.lightDir.y, 0) * (1 - vis.cloudCover * 0.9);
    _c.copy(amb).multiplyScalar(Math.PI);
    _c2.copy(this.lightColor).multiplyScalar(direct);
    _c.add(_c2).multiplyScalar(0.72 / Math.PI);
    G.flFogDense.value.copy(_c);
    // Overcast horizon colour from the probe (sky + clouds at the horizon)
    if (this.probeValid) G.flFogCloud.value.copy(this.probe[1]);
    G.flFogC.value.set(0.55 * (1 - vis.cloudCover * 0.7), 0.72, Math.pow(vis.cloudCover, 1.4), 0.09);
    G.flFogGlow.value.copy(this.lightColor).multiplyScalar(this.lightIntensity * 0.12);
    // CPU mirrors for other systems
    env.fogColor.copy(this.probeValid ? this.probe[1] : G.flFogDense.value);
    env.skyColor.copy(amb);
    env.groundColor.copy(amb).multiplyScalar(SNOW_ALBEDO).add(_c2.copy(this.lightColor).multiplyScalar((direct * SNOW_ALBEDO) / Math.PI));
    const fog = this.ctx.scene.fog as THREE.Fog;
    fog.color.copy(env.fogColor);
    fog.far = this.ctx.camera.far;
    void dt;
  }

  private runProbe() {
    const r = this.ctx.renderer;
    this.probeCam.position.copy(this.ctx.camera.position);
    this.probeCam.updateMatrixWorld();
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.probeRT);
    r.render(this.probeScene, this.probeCam);
    r.setRenderTarget(prev);
    this.probeBusy = true;
    r.readRenderTargetPixelsAsync(this.probeRT, 0, 0, PROBE_WIDTH, 1, this.probeBuf)
      .then(() => {
        const b = this.probeBuf;
        for (let i = 0; i < PROBE_WIDTH; i++) {
          const v = [b[i * 4], b[i * 4 + 1], b[i * 4 + 2]];
          if (v.every(Number.isFinite)) this.probe[i].setRGB(v[0], v[1], v[2]);
        }
        this.probeValid = true;
        if (this.snapExposure > 0) this.snapExposure--;
      })
      .catch(() => {})
      .finally(() => {
        this.probeBusy = false;
      });
  }

  private updateExposure(dt: number) {
    const w = this.ctx.sys.weather.visual;
    if (this.probeValid) this.ambient.copy(this.probe[0]);
    // Art-directed eye adaptation: bright noon, richer golden hour, moody twilight, readable night.
    // Moonlight is not compensated, so moonless nights really are darker.
    const el = (Math.asin(clamp(this.ctx.env.sunDir.y, -1, 1)) * 180) / Math.PI;
    let e = curve(el, EXPOSURE_CURVE);
    // Cloud decks darken the world; adapt part of the way.
    e *= 1 + 0.38 * w.cloudCover + 0.22 * w.storm;
    this.exposureTarget = clamp(e, 0.5, 9);
    if (this.firstFrame || this.snapExposure > 0 || !Number.isFinite(this.exposure)) this.exposure = this.exposureTarget;
    else this.exposure = damp(this.exposure, this.exposureTarget, 1.2, dt);
  }

  private captureEnv() {
    const { renderer, camera } = this.ctx;
    const u = this.skyU;
    // ground seen by the capture: lit snow
    const direct = this.lightIntensity * Math.max(this.lightDir.y, 0) * (1 - this.ctx.sys.weather.visual.cloudCover * 0.9) * 0.75;
    u.uGround.value.copy(this.ambient).multiplyScalar(Math.PI).add(_c2.copy(this.lightColor).multiplyScalar(direct)).multiplyScalar(SNOW_ALBEDO / Math.PI);
    this.cubeCam.position.copy(camera.position);
    this.cubeCam.updateMatrixWorld();
    const prevTarget = renderer.getRenderTarget();
    const fog = this.ctx.scene.fog;
    this.cubeCam.update(renderer, this.envScene);
    this.envRT = this.pmrem.fromCubemap(this.cubeRT.texture, this.envRT);
    this.ctx.scene.environment = this.envRT.texture;
    this.ctx.scene.fog = fog;
    renderer.setRenderTarget(prevTarget);
    this.envTimer = 2.0;
    this.envSunDir.copy(this.ctx.env.sunDir);
    this.envCover = this.ctx.sys.weather.visual.cloudCover;
  }

  /** Terrain-scale shadow factor texture etc. are global; nothing to resize. */
  resize() {}
}

/** [sun elevation°, exposure] */
const EXPOSURE_CURVE: [number, number][] = [
  [-90, 5.8],
  [-14, 5.8],
  [-9, 5.2],
  [-5, 4.6],
  [-2, 3.8],
  [1, 2.9],
  [4, 2.1],
  [9, 1.45],
  [16, 1.15],
  [26, 1.0],
  [90, 1.0],
];

function curve(x: number, pts: [number, number][]) {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const [x0, y0] = pts[i - 1],
        [x1, y1] = pts[i];
      const t = (x - x0) / (x1 - x0);
      // interpolate in log space: exposure is multiplicative
      return Math.exp(Math.log(y0) + (Math.log(y1) - Math.log(y0)) * t * t * (3 - 2 * t));
    }
  }
  return pts[pts.length - 1][1];
}

function lum(c: THREE.Color) {
  return c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
}
void _v;
