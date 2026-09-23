// Environment state written by the atmosphere systems (Sky/Weather) and read by everyone else.
import * as THREE from 'three';
import type { WeatherKind } from './types';

export class EnvState {
  /** Unit vector pointing from the ground toward the sun. */
  sunDir = new THREE.Vector3(0.4, 0.6, 0.3).normalize();
  /** Unit vector toward the moon. */
  moonDir = new THREE.Vector3(-0.4, 0.5, -0.3).normalize();
  sunColor = new THREE.Color(1, 0.95, 0.85);
  sunIntensity = 3;
  /** Sky ambient (hemisphere) colours. */
  skyColor = new THREE.Color(0.55, 0.7, 0.9);
  groundColor = new THREE.Color(0.8, 0.82, 0.88);
  fogColor = new THREE.Color(0.75, 0.82, 0.9);
  /** 0 = night, 1 = full day (smooth). */
  daylight = 1;
  /** Air temperature at sea level (°C) from time of day + weather. Survival applies lapse rate. */
  baseTemperature = -4;
  /** Temperature lapse per meter of altitude (°C/m, negative). */
  lapseRate = -0.0065;
  /** Wind velocity in m/s (horizontal). */
  wind = new THREE.Vector3(3, 0, 1);
  /** 0..1 normalised wind strength (1 = blizzard gale). */
  windStrength = 0.2;
  /** 0..1 snowfall intensity. */
  snowfall = 0;
  /** Distance at which things fade into fog (meters). */
  visibility = 4000;
  weather: WeatherKind = 'clear';
  /** Moonlight 0..1 (phase + altitude). */
  moonlight = 0.3;

  /** Air temperature at a given altitude. */
  temperatureAt(y: number): number {
    return this.baseTemperature + y * this.lapseRate;
  }
}
