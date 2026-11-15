/**
 * The demo's set path: while she walks, her feet follow a fixed line down the street (start, past the cat,
 * past him, to the shop) whatever way she is looking. The player only chooses whether she walks; the head
 * stays free. If someone stands on the line just ahead, she steps around them. Pure, so it is unit tested.
 */
import { yawOf } from '../player/mathx';

export interface P2 {
  x: number;
  z: number;
}

/** How far ahead along the line (m) she aims: far enough to round corners smoothly. */
export const LOOKAHEAD = 1.2;
/**
 * Someone between these distances (m) ahead and this close to her line of travel is in the way, until she
 * is past them. Someone far enough to the side that the two bodies pass is not: she walks on.
 */
export const AVOID_NEAR = -0.6; // a little behind her still counts, until she is past him
export const AVOID_AHEAD = 2.6;
export const AVOID_WIDTH = 0.7;
/** How far to the side (m) she passes someone in the way. */
export const PASS_OFFSET = 1.0;

export class SetPath {
  private seg = 0;
  constructor(
    private readonly points: readonly P2[],
    /** Where she may step across the sidewalk to get round someone: [min x, max x]. */
    private readonly xRange: readonly [number, number],
  ) {}

  /** The closest point on the line from the current segment on (it never goes back). */
  private project(p: P2): { seg: number; t: number; x: number; z: number } {
    let best = { seg: this.seg, t: 0, x: this.points[this.seg]!.x, z: this.points[this.seg]!.z, d: Infinity };
    for (let i = this.seg; i < this.points.length - 1; i++) {
      const a = this.points[i]!;
      const b = this.points[i + 1]!;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2));
      const x = a.x + dx * t;
      const z = a.z + dz * t;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < best.d - 1e-6) best = { seg: i, t, x, z, d };
      // Only look a couple of segments ahead, so a later stretch that passes close by is not taken early.
      if (i > this.seg + 1) break;
    }
    return best;
  }

  /** The point `dist` metres further along the line from a projected point. */
  private along(seg: number, t: number, dist: number): P2 {
    let i = seg;
    let a = this.points[i]!;
    let b = this.points[i + 1] ?? a;
    let x = a.x + (b.x - a.x) * t;
    let z = a.z + (b.z - a.z) * t;
    let left = dist;
    while (left > 0 && i < this.points.length - 1) {
      b = this.points[i + 1]!;
      const d = Math.hypot(b.x - x, b.z - z);
      if (d >= left) {
        x += ((b.x - x) / d) * left;
        z += ((b.z - z) / d) * left;
        return { x, z };
      }
      left -= d;
      x = b.x;
      z = b.z;
      i += 1;
      a = b;
    }
    return { x, z };
  }

  /** True once she has reached the end of the line. */
  done(p: P2): boolean {
    const end = this.points[this.points.length - 1]!;
    return this.seg >= this.points.length - 2 && Math.hypot(p.x - end.x, p.z - end.z) < 0.35;
  }

  /**
   * The yaw her feet should walk at from `p`, or null at the end of the line. `obstacle` is someone
   * she should step around if they stand on the line just ahead.
   */
  heading(p: P2, obstacle?: P2 | null): number | null {
    const pr = this.project(p);
    this.seg = pr.seg;
    if (this.done(p)) return null;
    const aim = this.along(pr.seg, pr.t, LOOKAHEAD);
    let tx = aim.x;
    let tz = aim.z;
    if (obstacle) {
      // The line's direction here (u), a sideways direction across it (n), and where the obstacle is.
      const fx = aim.x - pr.x;
      const fz = aim.z - pr.z;
      const fl = Math.hypot(fx, fz) || 1;
      const ux = fx / fl;
      const uz = fz / fl;
      const nx = -uz;
      const nz = ux;
      const ox = obstacle.x - p.x;
      const oz = obstacle.z - p.z;
      const ahead = ox * ux + oz * uz;
      const side = ox * nx + oz * nz;
      if (ahead > AVOID_NEAR && ahead < AVOID_AHEAD && Math.abs(side) < AVOID_WIDTH) {
        // Pass on the side away from him, unless that runs out of sidewalk; aim just past him.
        let s = side > 0 ? -1 : 1;
        const passAt = (k: number): P2 => ({ x: obstacle.x + nx * k * PASS_OFFSET + ux * 1.0, z: obstacle.z + nz * k * PASS_OFFSET + uz * 1.0 });
        const fits = (q: P2) => q.x >= this.xRange[0] && q.x <= this.xRange[1];
        if (!fits(passAt(s))) s = -s;
        const q = passAt(s);
        tx = Math.max(this.xRange[0], Math.min(this.xRange[1], q.x));
        tz = q.z;
      }
    }
    return yawOf(tx - p.x, tz - p.z);
  }
}
