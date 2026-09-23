// Sun and moon positions for a high-latitude late-winter sky.
// Sunrise ~06:30, sunset ~19:00, noon sun ~34° high: low enough for long shadows all day.
import * as THREE from 'three';
import { DAWN, DUSK } from '../core/Clock';

const LATITUDE = 58 * THREE.MathUtils.DEG2RAD;
const SOLAR_NOON = (DAWN + DUSK) / 2; // 12.75
// Declination that puts the geometric sunrise at DAWN: cos(H0) = -tan(L) tan(δ).
const H0 = ((SOLAR_NOON - DAWN) / 12) * Math.PI;
const DECLINATION = Math.atan(-Math.cos(H0) / Math.tan(LATITUDE));
/** Synodic month in game days. */
const LUNAR_MONTH = 29.53;
/** Moon phase angle at day 1, 00:00 (0 = new, π = full). Waxing gibbous: a bright moon on night one. */
const PHASE0 = 0.72 * Math.PI;

const _tmp = new THREE.Vector3();

/**
 * Direction toward a body with hour angle `H` and declination `dec`, in world space.
 * +X = east, -Z = north before `yaw` rotation. `yaw` spins the whole sky around the vertical
 * so that compass directions can be aligned with the map's landmarks.
 */
export function bodyDirection(H: number, dec: number, yaw: number, out: THREE.Vector3): THREE.Vector3 {
  const sl = Math.sin(LATITUDE),
    cl = Math.cos(LATITUDE);
  const up = sl * Math.sin(dec) + cl * Math.cos(dec) * Math.cos(H);
  const east = -Math.cos(dec) * Math.sin(H);
  const north = cl * Math.sin(dec) - sl * Math.cos(dec) * Math.cos(H);
  // world: x = east, z = -north, then rotate about Y
  const x = east,
    z = -north;
  const c = Math.cos(yaw),
    s = Math.sin(yaw);
  return out.set(x * c + z * s, up, -x * s + z * c).normalize();
}

export interface CelestialState {
  sunDir: THREE.Vector3;
  moonDir: THREE.Vector3;
  /** Phase angle sun-moon (0 new .. π full .. 2π). */
  moonPhase: number;
  /** Illuminated fraction 0..1. */
  moonIllum: number;
  /** Sidereal rotation angle for the star field (radians). */
  starAngle: number;
  /** Celestial pole direction (for star rotation). */
  pole: THREE.Vector3;
}

export function computeCelestial(hour: number, day: number, yaw: number, out: CelestialState): CelestialState {
  const H = ((hour - SOLAR_NOON) / 12) * Math.PI;
  bodyDirection(H, DECLINATION, yaw, out.sunDir);
  const days = day - 1 + hour / 24;
  const phase = (PHASE0 + (days / LUNAR_MONTH) * Math.PI * 2) % (Math.PI * 2);
  out.moonPhase = phase;
  out.moonIllum = 0.5 * (1 - Math.cos(phase));
  // The moon lags the sun by its phase angle; its declination wobbles a little month to month.
  const moonDec = DECLINATION + 0.09 * Math.sin(days * 0.23 + 1.3);
  bodyDirection(H - phase, moonDec, yaw, out.moonDir);
  // Stars turn once per sidereal day (~23.93 h) around the pole.
  out.starAngle = ((days * 24) / 23.934) * Math.PI * 2;
  // Pole: altitude = latitude, toward north.
  const c = Math.cos(yaw),
    s = Math.sin(yaw);
  _tmp.set(0, Math.sin(LATITUDE), -Math.cos(LATITUDE)); // north is -Z before yaw
  out.pole.set(_tmp.x * c + _tmp.z * s, _tmp.y, -_tmp.x * s + _tmp.z * c).normalize();
  return out;
}

export function newCelestial(): CelestialState {
  return {
    sunDir: new THREE.Vector3(0, 1, 0),
    moonDir: new THREE.Vector3(0, -1, 0),
    moonPhase: PHASE0,
    moonIllum: 0.5,
    starAngle: 0,
    pole: new THREE.Vector3(0, 1, 0),
  };
}
