// Falling snow around the camera. A box of flakes (fixed in world space, so they stream past as
// you move) simulated on the CPU and drawn as one THREE.Points with the built-in PointsMaterial —
// which gets the global atmospheric fog and colour pipeline like every other material. Density
// follows ctx.env.snowfall (a draw-range of the pool, no reallocations); storms add bigger, faster,
// wind-driven flakes.
import * as THREE from 'three';
import type { GameContext } from '../core/types';
import { clamp, damp, lerp, smoothstep } from '../core/math';

const MAX = 16000;
const BOX = 30; // metres, box edge around the camera
const HALF = BOX / 2;
const _col = new THREE.Color();

function flakeTexture(): THREE.Texture {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.85)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class SnowParticles {
  private points: THREE.Points;
  private mat: THREE.PointsMaterial;
  private pos: Float32Array;
  private seed: Float32Array;
  private count = MAX;
  private placed = false;
  private tw = { value: 0 };
  private tTime = { value: 0 };
  private dust = 0;

  constructor(private ctx: GameContext) {
    this.pos = new Float32Array(MAX * 3);
    this.seed = new Float32Array(MAX);
    for (let i = 0; i < MAX; i++) {
      this.seed[i] = Math.random();
      this.pos[i * 3] = (Math.random() - 0.5) * BOX;
      this.pos[i * 3 + 1] = (Math.random() - 0.5) * BOX;
      this.pos[i * 3 + 2] = (Math.random() - 0.5) * BOX;
    }
    const geo = new THREE.BufferGeometry();
    const attr = new THREE.BufferAttribute(this.pos, 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', attr);
    geo.setDrawRange(0, 0);
    this.mat = new THREE.PointsMaterial({
      size: 0.07,
      sizeAttenuation: true,
      map: flakeTexture(),
      transparent: true,
      depthWrite: false,
      opacity: 0.95,
      fog: true,
    });
    // Twinkle (diamond dust): each crystal flashes as it tumbles through the sun.
    this.mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTw = this.tw;
      sh.uniforms.uTime = this.tTime;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTw;\nuniform float uTime;')
        .replace(
          '#include <fog_vertex>',
          `#include <fog_vertex>
          // A flake right against the lens would balloon into a blurry disc: cap the size
          // (tiny for glittering dust crystals).
          gl_PointSize = min( gl_PointSize, mix( 26.0, 4.0, uTw ) );
          {
            float h = fract( sin( float( gl_VertexID ) * 12.9898 ) * 43758.5453 );
            float spark = pow( max( sin( uTime * ( 1.5 + h * 4.0 ) + h * 60.0 ), 0.0 ), 14.0 );
            gl_PointSize *= mix( 1.0, 0.45 + 2.6 * spark, uTw );
          }`,
        );
    };
    this.mat.customProgramCacheKey = () => 'fl-snowpts-1';
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 20;
    this.points.name = 'snowfall';
    ctx.scene.add(this.points);
    this.applyQuality();
    ctx.events.on('settings', ({ key }) => {
      if (key === 'quality') this.applyQuality();
    });
  }

  applyQuality() {
    this.count = Math.min(MAX, this.ctx.settings.quality.snowParticles);
  }

  update(dt: number) {
    const { camera, env, sys } = this.ctx;
    const snow = env.snowfall;
    // Diamond dust: clear, bright and bitterly cold -> ice crystals hang glittering in the air.
    const clear = 1 - sys.weather.visual.cloudCover;
    const temp = env.temperatureAt(camera.position.y);
    const wantDust = clamp(1 - snow * 6, 0, 1) * smoothstep(0.45, 0.85, clear) * smoothstep(0.25, 0.6, env.daylight) * smoothstep(-3, -10, temp);
    this.dust = damp(this.dust, wantDust, 0.3, dt);
    this.tTime.value = this.ctx.time;
    this.points.visible = snow > 0.005 || this.dust > 0.02;
    if (!this.points.visible) return;
    const cam = camera.position;
    const p = this.pos;
    if (!this.placed) {
      // First frame: centre the box on the camera.
      for (let i = 0; i < MAX; i++) {
        p[i * 3] += cam.x;
        p[i * 3 + 1] += cam.y;
        p[i * 3 + 2] += cam.z;
      }
      this.placed = true;
    }
    const storm = sys.weather.visual.storm;
    const dm = this.dust * (1 - smoothstep(0.05, 0.25, snow)); // dust mode weight
    this.tw.value = dm;
    const active = Math.max(Math.floor(this.count * clamp(Math.pow(snow, 0.7) * 0.92 + storm * 0.08, 0, 1)), Math.floor(this.count * 0.15 * dm));
    const fall = lerp(1.0 + 0.7 * snow + storm * 1.2, 0.12, dm);
    const wx = env.wind.x,
      wz = env.wind.z;
    const t = this.ctx.time;
    for (let i = 0; i < active; i++) {
      const s = this.seed[i];
      const k = 0.75 + 0.5 * s; // speed class: small flakes drift, big ones fall
      const o = i * 3;
      // fall + wind + a little flutter
      p[o] += (wx * k + Math.sin(t * (1.1 + s) + s * 61) * 0.4) * dt;
      p[o + 1] -= fall * k * dt;
      p[o + 2] += (wz * k + Math.cos(t * (0.9 + s * 0.7) + s * 80) * 0.4) * dt;
      // wrap around the camera so the box always surrounds you
      let d = p[o] - cam.x;
      if (d > HALF) p[o] -= BOX;
      else if (d < -HALF) p[o] += BOX;
      d = p[o + 1] - cam.y;
      if (d > HALF) p[o + 1] -= BOX;
      else if (d < -HALF) p[o + 1] += BOX;
      d = p[o + 2] - cam.z;
      if (d > HALF) p[o + 2] -= BOX;
      else if (d < -HALF) p[o + 2] += BOX;
    }
    const geo = this.points.geometry;
    geo.setDrawRange(0, active);
    const attr = geo.getAttribute('position') as THREE.BufferAttribute;
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, active * 3);
    attr.needsUpdate = true;

    // Real flakes clump to 1-3 cm; at game scale they need to read clearly. Storms: bigger clumps.
    this.mat.size = lerp(0.06 + 0.035 * snow + 0.03 * storm, 0.022, dm);
    // Bright ice: lit by sky + sun, but always clearly lighter than an overcast sky so snowfall reads.
    const sky = sys.sky;
    _col.copy(sky.ambient).multiplyScalar(2.2).add(
      new THREE.Color().copy(sky.lightColor).multiplyScalar(sky.lightIntensity * Math.max(sky.lightDir.y, 0.15) * 0.35 * (1 - sys.weather.visual.cloudCover * 0.8)),
    );
    const lum = 0.2126 * _col.r + 0.7152 * _col.g + 0.0722 * _col.b;
    const floor = 0.95 * Math.max(0.3, env.daylight);
    if (lum < floor) _col.multiplyScalar(floor / Math.max(lum, 1e-3));
    this.mat.color.copy(_col);
    this.mat.opacity = lerp(0.75 + 0.2 * smoothstep(0, 0.6, snow), 1, dm);
    if (dm > 0.01) this.mat.color.lerp(_col.setRGB(1.6, 1.55, 1.45), dm * 0.7);
  }
}
