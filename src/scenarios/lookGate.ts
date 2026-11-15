/**
 * The start of Part 1: she can look around straight away but only walks once she has looked left and
 * right (or after a short safety timeout, so it can never stall). And the words beside the arrow.
 * Pure, so it is unit tested.
 */
import { DEG, wrapAngle } from '../player/mathx';

/** How far (radians) the view has to turn from where it started to count as a look that way. */
export const LOOK_TURN = 25 * DEG;
/** Seconds after which walking unlocks anyway. */
export const LOOK_GATE_TIMEOUT = 6;

export class LookGate {
  private left = false;
  private right = false;
  constructor(private readonly startYaw: number) {}

  /** Feed the view's yaw (radians; it grows turning left). */
  update(viewYaw: number): { left: boolean; right: boolean; done: boolean } {
    const d = wrapAngle(viewYaw - this.startYaw);
    if (d >= LOOK_TURN) this.left = true;
    if (this.left && d <= -LOOK_TURN) this.right = true; // left first, then right
    return { left: this.left, right: this.right, done: this.left && this.right };
  }

  /** What to ask for next. */
  get next(): 'left' | 'right' | 'walk' {
    return !this.left ? 'left' : !this.right ? 'right' : 'walk';
  }
}

/** Words for the arrow when she is facing away: '' while roughly facing it. relYaw > 0 = target to her left. */
export function turnHint(relYaw: number): string {
  const r = wrapAngle(relYaw);
  const off = Math.abs(r);
  if (off < 45 * DEG) return '';
  if (off >= 150 * DEG) return 'Turn around';
  return r > 0 ? 'Turn left' : 'Turn right';
}
