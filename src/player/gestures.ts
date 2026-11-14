/**
 * Hand gestures from MediaPipe Hand Landmarker's 21 points (normalized image
 * coordinates). Pure and frame-rate independent, so it can be unit tested.
 *
 *   pinch: thumb tip meets index tip. Fires once; the hand must open again
 *          before the next pinch.
 *   palm:  an open hand, all four fingers straight, held up for a moment.
 *          Fires once until the hand changes.
 *
 * Distances are divided by the palm length (wrist to middle knuckle), so they
 * do not depend on how far the hand is from the camera.
 */

export interface HandPoint {
  x: number;
  y: number;
}

export type GestureEvent = 'pinch' | 'palm';

export interface GestureState {
  present: boolean;
  pinching: boolean;
  palm: boolean;
  /** Thumb-index gap over palm length; small = pinching. NaN with no hand. */
  pinchRatio: number;
}

export const GESTURE_TUNING = {
  /** Thumb-index gap (over palm length) that counts as a pinch... */
  pinchOn: 0.3,
  /** ...and the gap the hand must open past before the next pinch. */
  pinchOff: 0.5,
  /** Seconds a pinch must hold, so a passing blip does not fire. */
  pinchHold: 0.07,
  pinchCooldown: 0.35,
  /** A straight finger's tip is this much farther from the wrist than its middle joint. */
  fingerStraight: 1.18,
  palmHold: 0.45,
  /** Seconds the hand may vanish before the gesture state resets. */
  lostAfter: 0.25,
} as const;

const T = GESTURE_TUNING;

const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
/** [middle joint (PIP), tip] for index, middle, ring and pinky. */
const FINGERS: ReadonlyArray<readonly [number, number]> = [
  [6, 8],
  [10, 12],
  [14, 16],
  [18, 20],
];

const dist = (a: HandPoint, b: HandPoint): number => Math.hypot(a.x - b.x, a.y - b.y);

export class GestureDetector {
  readonly state: GestureState = { present: false, pinching: false, palm: false, pinchRatio: NaN };
  private pinchHeld = 0;
  private sinceRelease = Infinity;
  private palmHeld = 0;
  private palmFired = false;
  private lost = Infinity;

  push(points: readonly HandPoint[] | null, dt: number): GestureEvent[] {
    const events: GestureEvent[] = [];
    const s = this.state;

    if (!points || points.length < 21) {
      this.lost += dt;
      if (this.lost > T.lostAfter) this.reset();
      return events;
    }
    this.lost = 0;
    s.present = true;

    const scale = dist(points[WRIST], points[MIDDLE_MCP]);
    if (!(scale > 1e-4)) return events;
    const ratio = dist(points[THUMB_TIP], points[INDEX_TIP]) / scale;
    s.pinchRatio = ratio;

    /* pinch, with hysteresis and a short hold */
    if (!s.pinching) {
      this.sinceRelease += dt;
      if (ratio < T.pinchOn) {
        this.pinchHeld += dt;
        if (this.pinchHeld >= T.pinchHold && this.sinceRelease >= T.pinchCooldown) {
          s.pinching = true;
          events.push('pinch');
        }
      } else this.pinchHeld = 0;
    } else if (ratio > T.pinchOff) {
      s.pinching = false;
      this.pinchHeld = 0;
      this.sinceRelease = 0;
    }

    /* open palm: every finger straight, and not pinching */
    const wrist = points[WRIST];
    const straight = FINGERS.every(([pip, tip]) => dist(wrist, points[tip]) > dist(wrist, points[pip]) * T.fingerStraight);
    s.palm = straight && ratio > T.pinchOff;
    if (s.palm) {
      this.palmHeld += dt;
      if (!this.palmFired && this.palmHeld >= T.palmHold) {
        this.palmFired = true;
        events.push('palm');
      }
    } else {
      this.palmHeld = 0;
      this.palmFired = false;
    }
    return events;
  }

  reset(): void {
    const s = this.state;
    s.present = false;
    s.pinching = false;
    s.palm = false;
    s.pinchRatio = NaN;
    this.pinchHeld = 0;
    this.sinceRelease = Infinity;
    this.palmHeld = 0;
    this.palmFired = false;
  }
}
