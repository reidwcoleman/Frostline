// Every movement / skiing / camera number in one place so feel can be tuned without hunting.
// Units: meters, seconds, m/s, m/s², radians. Accelerations quoted in "g" are multiplied by GRAVITY.
import { DEG } from '../core/math';

export const GRAVITY = 9.81;

export const WALK = {
  speed: 1.8,
  sprintSpeed: 4.6,
  crouchSpeed: 1.0,
  /** Speed multiplier in untracked powder (packed = ice, rock, structures, boulders). */
  deepSnow: 0.85,
  accel: 9, // m/s² toward the wanted velocity on snow
  decel: 11,
  iceAccel: 1.4, // ice: low traction, momentum carries
  iceDecel: 0.8,
  airAccel: 1.4,
  jumpSpeed: 4.3, // ~0.95 m hop
  /** Steepest grade you can walk up. */
  maxClimb: 46 * DEG,
  /** Beyond this the snow won't hold you: you slide. */
  slideAngle: 50 * DEG,
  slideFriction: 0.28,
  sprintDrain: 12, // stamina / s
  sprintResume: 15, // stamina needed to start sprinting again after running dry
  stepUp: 0.45, // max ledge you walk onto (foundations, rocks)
  snapDown: 0.45,
  /** Stride length = base + perSpeed * speed (meters per footstep). */
  strideBase: 0.55,
  strideSpeed: 0.2,
  fallDamageSpeed: 10, // impact speed (m/s into the ground) where fall damage starts (~5 m drop)
  fallDamagePer: 7,
} as const;

export const SKI = {
  /** Along-ski kinetic friction coefficients by surface. */
  mu: { snow: 0.026, ice: 0.01, rock: 0.3, wood: 0.1 } as Record<string, number>,
  /** Static friction when stopped (a waxed ski starts to glide at ~4°). */
  muStatic: 0.055,
  /** Lateral edge grip, in g, when fully edged. Above it the skis skid. */
  grip: { snow: 2.2, ice: 0.9, rock: 1.3, wood: 1.2 } as Record<string, number>,
  /** Sliding (skid) friction as a fraction of the grip limit. */
  skidFactor: 0.62,
  /** Along-ski braking while skidding, as a fraction of the skid friction × sin(skid angle). */
  skidAlongBrake: 0.6,
  /** Grip lost to chatter at very high speed (fraction at `chatterSpeed[1]`). */
  chatter: 0.3,
  chatterSpeed: [34, 58] as const,
  /** Quadratic air drag k (per meter): a = -k |v| v. 0.5·ρ·CdA/m with CdA≈0.6 m², m≈80 kg. */
  drag: 0.0024,
  tuckDrag: 0.44, // tuck removes over half the drag
  crouchDrag: 0.85,
  tuckGrip: 0.78, // weight back in a tuck: less edge
  /** Edge boost from A/D when it agrees with the turn. */
  edgeBoost: 1.3,
  /** Steering: skis turn toward the look yaw. */
  steerGain: 11, // 1/s proportional gain
  pivotRate: [7.2, 5.0] as const, // rad/s at low / high speed (how fast you can throw the skis)
  /** Look offset (rad) where you start over-rotating (skid) instead of carving cleanly. */
  overdrive: [0.5, 1.25] as const,
  keySteer: 0.6, // rad of extra steer target from A/D
  airSpin: 3.4, // rad/s heading change in the air
  airControl: 1.3, // m/s² lateral air nudge
  /** Snowplow: extra braking decel = base + perSpeed·v, capped. */
  plowBase: 2.3,
  plowPerSpeed: 0.12,
  plowMax: 5.2,
  plowHoldSlope: 20 * DEG,
  /** Pole push / skating on the flat. */
  poleAccel: 4.2, // peak push accel
  poleMaxSpeed: 9, // pushes fade out approaching this speed
  poleCycle: 0.95, // seconds per push stride
  skateDrain: 7,
  /** Herringbone / side-step climbing. */
  climbSpeed: 2.6,
  climbMax: 44 * DEG,
  climbStartGrade: 7 * DEG,
  climbDrain: 5,
  /** Ollie: hold jump to charge (s), release to pop along the normal. */
  chargeTime: 0.55,
  popMin: 2.1,
  popMax: 4.0,
  popCost: 3, // stamina
  /** Extra downward accel a skier can "absorb" with the legs before leaving the ground. */
  absorb: 0.7 * GRAVITY,
  launchLookahead: 0.12, // s
  launchGap: 0.1, // m predicted clearance that counts as a launch
  /** Landing impact thresholds (m/s into the surface). */
  landSoft: 4.2,
  landHard: 7.0,
  landCrash: 10.0,
  landHardDamage: 4.5, // per m/s above landHard
  /** Sideways landing: speed and misalignment that catch an edge. */
  catchEdgeSpeed: 8,
  catchEdgeAngle: 58 * DEG,
  /** Obstacle impacts (m/s into the obstacle). */
  crashImpact: 25 / 3.6, // > ~25 km/h into a tree/boulder/wall = crash
  bumpImpact: 2.5,
  crashDamageFrom: 5,
  crashDamagePer: 3.4,
  /** Crash tumble. */
  crashTime: 1.5,
  crashMaxTime: 4,
  getUpSpeed: 2.5,
  bodyMu: 0.55,
  bodyDrag: 0.006,
  toggleTime: 0.8,
  toggleMaxSpeed: 3.5,
  trackSpacing: 0.2,
} as const;

export const EYE = {
  stand: 1.68,
  crouch: 1.05,
  ski: 1.6,
  skiCrouch: 1.32,
  tuck: 1.16,
  charge: 1.24,
  crashed: 0.45,
  dead: 0.22,
} as const;

export const CAM = {
  sensitivity: 0.0022, // rad per mouse pixel at sensitivity 1
  pitchLimit: 1.52,
  fovKick: 12, // degrees at top speed
  fovKickSpeed: [7, 36] as const, // m/s where the kick starts / maxes
  roll: 9 * DEG, // lean into carves
  bobWalk: 0.032,
  bobSprint: 0.06,
  dipStiffness: 95,
  dipDamping: 11,
  maxShakeRot: 2.6 * DEG,
  maxShakePos: 0.045,
  tpDistance: 4.2, // third-person chase distance (m)
  tpHeight: 1.15, // extra height above the eye the chase cam sits at (m)
} as const;
