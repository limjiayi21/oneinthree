/**
 * Hand gestures from MediaPipe Hand Landmarker's 21 points (normalized image
 * coordinates). Pure and frame-rate independent, so it can be unit tested.
 *
 *   pinch: thumb tip meets index tip. Fires once; the hand must open again
 *          before the next pinch.
 *   palm:  an open hand, all four fingers straight, held up for a moment.
 *          Fires once until the hand changes.
 *   fist:  all four fingers curled, held for a moment: hold to talk. Fires
 *          'fist' when it starts and 'fistEnd' when the hand opens or leaves
 *          the camera. A fist never counts as a pinch, even with the thumb
 *          tucked against the index, and the open hand that follows a fist
 *          is not taken as a raised palm straight away.
 *
 * Distances are divided by the palm length (wrist to middle knuckle), so they
 * do not depend on how far the hand is from the camera.
 */

export interface HandPoint {
  x: number;
  y: number;
}

export type GestureEvent = 'pinch' | 'palm' | 'fist' | 'fistEnd';

export interface GestureState {
  present: boolean;
  pinching: boolean;
  palm: boolean;
  /** Thumb-index gap over palm length; small = pinching. NaN with no hand. */
  pinchRatio: number;
  /** All four fingers curled right now. */
  fist: boolean;
  /** A fist is being held up (between 'fist' and 'fistEnd'): she is talking. */
  fistHeld: boolean;
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
  /** A curled finger's tip is no farther from the wrist than its middle joint (times this). */
  fingerCurled: 1.0,
  /** Seconds a fist must hold before it starts talking, so a passing fist does not. */
  fistHold: 0.35,
  /** Seconds the hand must stay open before the fist ends, so one flickering frame does not cut her off. */
  fistRelease: 0.15,
  /** Seconds after a fist ends before an open palm can count as asking for help. */
  palmAfterFist: 1.0,
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
  readonly state: GestureState = { present: false, pinching: false, palm: false, pinchRatio: NaN, fist: false, fistHeld: false };
  private fistFor = 0;
  private openFor = 0;
  private sinceFistEnd = Infinity;
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
      if (this.lost > T.lostAfter) {
        if (s.fistHeld) events.push('fistEnd'); // the hand left the camera mid-sentence: send what she said
        this.reset();
      }
      return events;
    }
    this.lost = 0;
    s.present = true;

    const scale = dist(points[WRIST], points[MIDDLE_MCP]);
    if (!(scale > 1e-4)) return events;
    const ratio = dist(points[THUMB_TIP], points[INDEX_TIP]) / scale;
    s.pinchRatio = ratio;
    const wrist = points[WRIST];
    const curled = FINGERS.every(([pip, tip]) => dist(wrist, points[tip]) <= dist(wrist, points[pip]) * T.fingerCurled);
    s.fist = curled;

    /* fist: hold to talk, with a short hold to start and a short grace to end */
    if (!s.fistHeld) {
      this.sinceFistEnd += dt;
      this.fistFor = curled ? this.fistFor + dt : 0;
      if (this.fistFor >= T.fistHold) {
        s.fistHeld = true;
        this.openFor = 0;
        events.push('fist');
      }
    } else {
      this.openFor = curled ? 0 : this.openFor + dt;
      if (this.openFor >= T.fistRelease) {
        s.fistHeld = false;
        this.fistFor = 0;
        this.sinceFistEnd = 0;
        events.push('fistEnd');
      }
    }

    /* pinch, with hysteresis and a short hold; never from a fist */
    if (!s.pinching) {
      this.sinceRelease += dt;
      if (ratio < T.pinchOn && !curled) {
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

    /* open palm: every finger straight, and not pinching; not the hand opening from a fist */
    const straight = FINGERS.every(([pip, tip]) => dist(wrist, points[tip]) > dist(wrist, points[pip]) * T.fingerStraight);
    s.palm = straight && ratio > T.pinchOff;
    if (s.palm && !s.fistHeld && this.sinceFistEnd >= T.palmAfterFist) {
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
    s.fist = false;
    s.fistHeld = false;
    this.fistFor = 0;
    this.openFor = 0;
    this.sinceFistEnd = Infinity;
    this.pinchHeld = 0;
    this.sinceRelease = Infinity;
    this.palmHeld = 0;
    this.palmFired = false;
  }
}
