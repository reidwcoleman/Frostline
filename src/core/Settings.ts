// Player settings, persisted to localStorage. Quality presets map to concrete knobs
// in QUALITY so every renderer reads the same numbers.
import type { EventBus } from './Events';

export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';

export interface SettingsData {
  quality: QualityLevel;
  renderScale: number; // 0.5..1, multiplied into the pixel ratio
  fov: number; // degrees, 60..100
  sensitivity: number; // 0.1..3
  invertY: boolean;
  masterVolume: number; // 0..1
  musicVolume: number;
  sfxVolume: number;
  ambienceVolume: number;
  cameraShake: number; // 0..1
  headBob: boolean;
  motionBlur: boolean;
  showFps: boolean;
  fullscreen: boolean;
  units: 'metric' | 'imperial';
}

export const DEFAULT_SETTINGS: SettingsData = {
  quality: 'high',
  renderScale: 1,
  fov: 78,
  sensitivity: 1,
  invertY: false,
  masterVolume: 0.9,
  musicVolume: 0.6,
  sfxVolume: 1,
  ambienceVolume: 0.9,
  cameraShake: 1,
  headBob: true,
  motionBlur: true,
  showFps: false,
  fullscreen: true,
  units: 'metric',
};

export interface QualityProfile {
  pixelRatioCap: number;
  shadowMapSize: number;
  shadowCascades: number;
  shadowDistance: number; // meters
  viewDistance: number; // meters, far plane / fog end
  terrainDetail: number; // LOD bias multiplier (1 = default, higher = more detail)
  treeDrawDistance: number; // full-mesh trees (beyond: impostors)
  impostorDistance: number; // max distance for any tree
  vegetationDensity: number; // 0..1 fraction of small props / shrubs drawn
  ssao: boolean;
  bloom: boolean;
  volumetricFog: boolean;
  snowParticles: number; // max particles
  snowTrailRes: number; // snow deformation texture size
}

export const QUALITY: Record<QualityLevel, QualityProfile> = {
  low: { pixelRatioCap: 1, shadowMapSize: 1024, shadowCascades: 2, shadowDistance: 120, viewDistance: 2600, terrainDetail: 0.6, treeDrawDistance: 140, impostorDistance: 1200, vegetationDensity: 0.35, ssao: false, bloom: false, volumetricFog: false, snowParticles: 3000, snowTrailRes: 512 },
  medium: { pixelRatioCap: 1.25, shadowMapSize: 2048, shadowCascades: 3, shadowDistance: 200, viewDistance: 3600, terrainDetail: 0.85, treeDrawDistance: 220, impostorDistance: 1800, vegetationDensity: 0.6, ssao: true, bloom: true, volumetricFog: false, snowParticles: 6000, snowTrailRes: 1024 },
  high: { pixelRatioCap: 1.5, shadowMapSize: 2048, shadowCascades: 3, shadowDistance: 300, viewDistance: 5000, terrainDetail: 1, treeDrawDistance: 320, impostorDistance: 2600, vegetationDensity: 0.85, ssao: true, bloom: true, volumetricFog: true, snowParticles: 10000, snowTrailRes: 1024 },
  ultra: { pixelRatioCap: 2, shadowMapSize: 4096, shadowCascades: 4, shadowDistance: 450, viewDistance: 6000, terrainDetail: 1.35, treeDrawDistance: 480, impostorDistance: 3400, vegetationDensity: 1, ssao: true, bloom: true, volumetricFog: true, snowParticles: 16000, snowTrailRes: 2048 },
};

const KEY = 'frostline.settings.v1';

export class Settings {
  data: SettingsData;

  constructor(private events: EventBus) {
    this.data = { ...DEFAULT_SETTINGS };
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) Object.assign(this.data, JSON.parse(raw));
    } catch {
      /* ignore corrupt settings */
    }
  }

  get quality(): QualityProfile {
    return QUALITY[this.data.quality];
  }

  set<K extends keyof SettingsData>(key: K, value: SettingsData[K]) {
    if (this.data[key] === value) return;
    this.data[key] = value;
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* storage may be unavailable */
    }
    this.events.emit('settings', { key });
  }

  reset() {
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof SettingsData)[]) this.set(k, DEFAULT_SETTINGS[k] as never);
  }
}
