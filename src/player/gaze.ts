/**
 * Pure maths for webcam head look (see eyes.ts for the camera side).
 *
 *   face landmarks --gazeFromFace--> raw head direction
 *   raw gaze --GazeFilter (calibrate, smooth)--> gaze, about -1..1 per axis
 *   gaze --gazeToLook--> glance offsets + edge turn rate for the player
 *
 * Gaze axes are from the player's point of view: +x = looking to their right,
 * +y = looking up. Landmarks are MediaPipe Face Landmarker indices in the
 * unmirrored camera image.
 *
 * Only the head counts: turning or tilting your head moves the view, while
 * your eyes stay free to look anywhere on the screen.
 */

import { DEG, clamp, damp, smoothstep } from './mathx';

export interface FacePoint {
  x: number;
  y: number;
}

export interface RawGaze {
  x: number;
  y: number;
}

export interface Gaze {
  x: number;
  y: number;
}

export interface EyeLook {
  /** Added to the view yaw, radians (+ = left, the project's yaw convention). */
  yawOffset: number;
  /** Added to the view pitch, radians (+ = up). */
  pitchOffset: number;
  /** Body turn while the gaze rests near an edge, rad/s (+ = left). */
  yawRate: number;
}

export const GAZE_TUNING = {
  /** Head turn: nose offset from the face centre, as a share of face width. */
  headXGain: 3.6,
  /** Head pitch: change in nose height between the eye line and the chin. */
  headYGain: 9,
  /** Smoothing rate, 1/s. Higher follows faster but jitters more. */
  smoothRate: 9,
  /** Seconds without a face before the gaze is dropped. */
  lostAfter: 0.3,
  /** Faces narrower than this share of the frame are too noisy to use. */
  minFaceWidth: 0.06,
  deadZone: 0.18,
  /** Vertical dead zone: smaller, since up/down movements are smaller than left/right. */
  deadZoneY: 0.13,
  /** Share of the live range past which the body starts turning. */
  edge: 0.7,
  maxGlanceYaw: 50 * DEG,
  maxGlancePitchUp: 24 * DEG,
  /** Looking down goes further: down at the hands and phone. */
  maxGlancePitchDown: 55 * DEG,
  maxTurnRate: 85 * DEG,
} as const;

const T = GAZE_TUNING;

// MediaPipe face mesh indices
const NOSE_TIP = 1;
const FACE_RIGHT = 234; // subject's right edge (image left)
const FACE_LEFT = 454; // subject's left edge (image right)
const EYE_RIGHT_OUTER = 33;
const EYE_LEFT_OUTER = 263;
const CHIN = 152;

/** Raw, uncalibrated head direction from one frame, or null when the face is unusable. */
export function gazeFromFace(points: readonly FacePoint[], sensitivity = 1, sensitivityY = sensitivity): RawGaze | null {
  const nose = points[NOSE_TIP];
  const fr = points[FACE_RIGHT];
  const fl = points[FACE_LEFT];
  const er = points[EYE_RIGHT_OUTER];
  const el = points[EYE_LEFT_OUTER];
  const chin = points[CHIN];
  if (!nose || !fr || !fl || !er || !el || !chin) return null;

  const width = fl.x - fr.x;
  if (!(width > T.minFaceWidth)) return null;
  const eyeY = (er.y + el.y) / 2;
  const height = chin.y - eyeY;
  if (!(height > 0)) return null;

  // Turning right moves the nose toward the image's left edge.
  const headX = -(nose.x - (fr.x + fl.x) / 2) / width;
  // Looking up lifts the nose toward the eye line.
  const headY = -(nose.y - eyeY) / height;

  return {
    x: headX * T.headXGain * sensitivity,
    y: headY * T.headYGain * sensitivityY,
  };
}

/** Calibration (a neutral pose) plus smoothing, frame-rate independent. */
export class GazeFilter {
  private cx = 0;
  private cy = 0;
  private x = 0;
  private y = 0;
  private has = false;
  private lost = Infinity;
  private calibrating = false;
  private sumX = 0;
  private sumY = 0;
  private count = 0;

  beginCalibration(): void {
    this.calibrating = true;
    this.sumX = this.sumY = this.count = 0;
  }

  /** Ends calibration; false when no face was seen, keeping the old centre. */
  endCalibration(): boolean {
    this.calibrating = false;
    if (this.count === 0) return false;
    this.cx = this.sumX / this.count;
    this.cy = this.sumY / this.count;
    this.has = false; // restart smoothing from the new centre
    return true;
  }

  get isCalibrating(): boolean {
    return this.calibrating;
  }

  push(raw: RawGaze | null, dt: number): void {
    if (!raw) {
      this.lost += dt;
      if (this.lost > T.lostAfter) this.has = false;
      return;
    }
    this.lost = 0;
    if (this.calibrating) {
      this.sumX += raw.x;
      this.sumY += raw.y;
      this.count++;
    }
    const gx = raw.x - this.cx;
    const gy = raw.y - this.cy;
    if (!this.has) {
      this.x = gx;
      this.y = gy;
      this.has = true;
      return;
    }
    this.x = damp(this.x, gx, T.smoothRate, dt);
    this.y = damp(this.y, gy, T.smoothRate, dt);
  }

  /** Calibrated, smoothed gaze, or null with no face (and during calibration). */
  value(): Gaze | null {
    if (!this.has || this.calibrating || this.lost > T.lostAfter) return null;
    return { x: this.x, y: this.y };
  }
}

/** -1..1 past the dead zone, 0 inside it. */
function shaped(v: number, dead: number): number {
  const a = Math.abs(v);
  if (a <= dead) return 0;
  return Math.sign(v) * clamp((a - dead) / (1 - dead), 0, 1);
}

/**
 * Head direction -> view. Turning off-centre turns her head (a glance the
 * body does not follow); holding a turn near the left or right edge also
 * turns the body, so the player can look all the way round.
 */
export function gazeToLook(g: Gaze): EyeLook {
  const sx = shaped(g.x, T.deadZone);
  const sy = shaped(g.y, T.deadZoneY);
  const edge = smoothstep((Math.abs(sx) - T.edge) / (1 - T.edge));
  return {
    yawOffset: sx === 0 ? 0 : -sx * T.maxGlanceYaw,
    pitchOffset: sy === 0 ? 0 : sy * (sy > 0 ? T.maxGlancePitchUp : T.maxGlancePitchDown),
    yawRate: edge === 0 ? 0 : -Math.sign(sx) * edge * T.maxTurnRate,
  };
}
