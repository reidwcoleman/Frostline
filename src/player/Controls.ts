// One frame of player intent. Filled from the real Input, or from a scripted autopilot for testing
// (`fl.ctx.sys.player.autopilot = { forward: true, tuck: true, steerYaw: 1.2 }`).

export interface Controls {
  /** Strafe right (+) / left (-), -1..1. */
  moveX: number;
  /** Forward (+) / back (-), -1..1. */
  moveY: number;
  jump: boolean;
  jumpPressed: boolean;
  jumpReleased: boolean;
  sprint: boolean;
  crouch: boolean;
  freelook: boolean;
  toggleSkis: boolean;
  /** Absolute yaw the skis steer toward (radians). */
  steerYaw: number;
}

export function makeControls(): Controls {
  return { moveX: 0, moveY: 0, jump: false, jumpPressed: false, jumpReleased: false, sprint: false, crouch: false, freelook: false, toggleSkis: false, steerYaw: 0 };
}

export function clearControls(c: Controls) {
  c.moveX = c.moveY = 0;
  c.jump = c.jumpPressed = c.jumpReleased = false;
  c.sprint = c.crouch = c.freelook = c.toggleSkis = false;
}

/** Scripted virtual input. Any omitted field is "not pressed". */
export interface Autopilot {
  forward?: boolean;
  back?: boolean;
  left?: boolean;
  right?: boolean;
  jump?: boolean;
  /** Tuck on skis / sprint on foot. */
  tuck?: boolean;
  sprint?: boolean;
  crouch?: boolean;
  freelook?: boolean;
  /** Absolute steer / look yaw in radians (also turns the camera). */
  steerYaw?: number;
  /** Look yaw relative to the current ski heading (radians, + = left). Overrides steerYaw. */
  steerOffset?: number;
  /** Pitch to hold the camera at (radians). */
  pitch?: number;
  /** Fire toggleSkis once. */
  toggleSkis?: boolean;
}
