// The player's shared state. The PlayerController (src/player) drives movement;
// Survival (src/survival) drives vitals; everyone else reads.
import * as THREE from 'three';
import type { EventBus } from './Events';
import type { DamageCause, DevParams } from './types';
import type { SurfaceKind } from './Terrain';
import { clamp } from './math';

export type MoveMode = 'walk' | 'ski' | 'air' | 'crashed' | 'dead';

export class PlayerState {
  /** Feet position. */
  position = new THREE.Vector3();
  velocity = new THREE.Vector3();
  /** Look direction (radians). yaw 0 looks toward -Z, positive yaw turns left (three.js convention). */
  yaw = 0;
  pitch = 0;
  /** Heading of the skis / body (radians, same convention as yaw). */
  heading = 0;
  eyeHeight = 1.68;
  radius = 0.35;
  height = 1.8;

  mode: MoveMode = 'walk';
  onSkis = false;
  grounded = true;
  /** Time spent airborne in the current jump (s). */
  airTime = 0;
  surface: SurfaceKind = 'snow';
  crouching = false;
  sprinting = false;
  /** Tucked ski stance (fast, low drag). */
  tucking = false;
  /** Carving amount -1..1 (left..right), for camera lean + audio. */
  carve = 0;
  aiming = false;

  // Vitals, 0..100
  health = 100;
  warmth = 100;
  satiety = 100;
  stamina = 100;
  /** °C felt by the player right now (after wind chill, shelter, fire). Survival writes. */
  feltTemperature = -5;
  /** 0..1 how sheltered from wind/snow (Survival writes). */
  shelter = 0;
  /** 0..1 proximity to warmth (fire/torch). */
  nearFire = 0;
  indoors = false;

  alive = true;
  lastDamageTime = -999;
  lastDamageCause: DamageCause = 'unknown';
  respawnPoint: THREE.Vector3 | null = null;
  /** Session statistics for the death screen / achievements. */
  stats = { distanceSkied: 0, topSpeed: 0, treesFelled: 0, kills: 0, longestAir: 0, daysSurvived: 0, highestAltitude: 0 };

  constructor(private events: EventBus, private dev: DevParams) {}

  get eyePosition(): THREE.Vector3 {
    return new THREE.Vector3(this.position.x, this.position.y + (this.crouching ? this.eyeHeight * 0.62 : this.eyeHeight), this.position.z);
  }

  /** Horizontal speed in m/s. */
  get speed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  /** Forward look vector. */
  lookDir(out = new THREE.Vector3()): THREE.Vector3 {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  damage(amount: number, cause: DamageCause, from?: THREE.Vector3) {
    if (!this.alive || amount <= 0 || this.dev.god) return;
    this.health = clamp(this.health - amount, 0, 100);
    this.lastDamageTime = performance.now() / 1000;
    this.lastDamageCause = cause;
    this.events.emit('player:damaged', { amount, cause, from });
    if (this.health <= 0) this.die(cause);
  }

  heal(amount: number) {
    if (!this.alive || amount <= 0) return;
    this.health = clamp(this.health + amount, 0, 100);
    this.events.emit('player:healed', { amount });
  }

  die(cause: DamageCause) {
    if (!this.alive) return;
    this.alive = false;
    this.mode = 'dead';
    this.health = 0;
    this.events.emit('player:died', { cause });
  }

  applyImpulse(v: THREE.Vector3) {
    this.velocity.add(v);
  }

  teleport(x: number, y: number, z: number) {
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
  }

  reset() {
    this.velocity.set(0, 0, 0);
    this.mode = 'walk';
    this.onSkis = false;
    this.grounded = true;
    this.airTime = 0;
    this.crouching = this.sprinting = this.tucking = this.aiming = false;
    this.carve = 0;
    this.health = this.warmth = this.satiety = this.stamina = 100;
    this.shelter = this.nearFire = 0;
    this.indoors = false;
    this.alive = true;
    this.respawnPoint = null;
    this.stats = { distanceSkied: 0, topSpeed: 0, treesFelled: 0, kills: 0, longestAir: 0, daysSurvived: 0, highestAltitude: 0 };
  }

  serialize() {
    const p = this.position;
    return {
      pos: [p.x, p.y, p.z],
      yaw: this.yaw,
      pitch: this.pitch,
      heading: this.heading,
      onSkis: this.onSkis,
      health: this.health,
      warmth: this.warmth,
      satiety: this.satiety,
      stamina: this.stamina,
      respawn: this.respawnPoint ? this.respawnPoint.toArray() : null,
      stats: this.stats,
    };
  }

  deserialize(d: ReturnType<PlayerState['serialize']>) {
    this.reset();
    this.position.fromArray(d.pos);
    this.yaw = d.yaw;
    this.pitch = d.pitch;
    this.heading = d.heading;
    this.onSkis = d.onSkis;
    this.mode = d.onSkis ? 'ski' : 'walk';
    this.health = d.health;
    this.warmth = d.warmth;
    this.satiety = d.satiety;
    this.stamina = d.stamina;
    this.respawnPoint = d.respawn ? new THREE.Vector3().fromArray(d.respawn) : null;
    this.stats = { ...this.stats, ...d.stats };
  }
}
