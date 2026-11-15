/**
 * Ground-plane collision primitives: a circle against axis-aligned Rects,
 * other circles and the outer bounds. Positional push-out only; sliding falls
 * out of it because the tangential part of a move is left untouched.
 */

import type { Rect } from '../contracts';

export interface Vec2 {
  x: number;
  z: number;
}

/**
 * Push circle (p, r) out of `rect`. Mutates p. Returns the penetration depth
 * that was resolved (0 = no contact) and writes the push direction to `n`.
 */
export function pushOutOfRect(p: Vec2, r: number, rect: Rect, n?: Vec2): number {
  const cx = p.x < rect.minX ? rect.minX : p.x > rect.maxX ? rect.maxX : p.x;
  const cz = p.z < rect.minZ ? rect.minZ : p.z > rect.maxZ ? rect.maxZ : p.z;
  let dx = p.x - cx;
  let dz = p.z - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= r * r) return 0;

  if (d2 > 1e-12) {
    const d = Math.sqrt(d2);
    const pen = r - d;
    dx /= d;
    dz /= d;
    p.x += dx * pen;
    p.z += dz * pen;
    if (n) {
      n.x = dx;
      n.z = dz;
    }
    return pen;
  }

  // Centre is inside the rect: leave through the nearest face.
  const left = p.x - rect.minX;
  const right = rect.maxX - p.x;
  const back = p.z - rect.minZ;
  const front = rect.maxZ - p.z;
  const m = Math.min(left, right, back, front);
  let nx = 0;
  let nz = 0;
  if (m === left) {
    p.x = rect.minX - r;
    nx = -1;
  } else if (m === right) {
    p.x = rect.maxX + r;
    nx = 1;
  } else if (m === back) {
    p.z = rect.minZ - r;
    nz = -1;
  } else {
    p.z = rect.maxZ + r;
    nz = 1;
  }
  if (n) {
    n.x = nx;
    n.z = nz;
  }
  return m + r;
}

/** Rects no wider or deeper than this are posts (trunks, poles, hydrants, bins), not walls. */
export const POST_MAX_SIDE = 0.8;

export const isPost = (rect: Rect): boolean => rect.maxX - rect.minX <= POST_MAX_SIDE && rect.maxZ - rect.minZ <= POST_MAX_SIDE;

/**
 * Push circle (p, r) out of a small rect treated as a round post, so walking
 * into it slides round it instead of stopping dead against a flat face.
 * (moveX, moveZ) is the step being taken: when it hits the post almost
 * head-on, the push is turned a little sideways (towards whichever side p is
 * already on, else to the right of the move) so there is always a way past.
 * Mutates p; returns the resolved depth.
 */
export function pushOutOfPost(p: Vec2, r: number, rect: Rect, moveX = 0, moveZ = 0): number {
  const cx = (rect.minX + rect.maxX) / 2;
  const cz = (rect.minZ + rect.maxZ) / 2;
  const cr = Math.max(rect.maxX - rect.minX, rect.maxZ - rect.minZ) / 2;
  let dx = p.x - cx;
  let dz = p.z - cz;
  const min = r + cr;
  const d2 = dx * dx + dz * dz;
  if (d2 >= min * min) return 0;
  let d = Math.sqrt(d2);
  const ml = Math.hypot(moveX, moveZ);
  if (d < 1e-6) {
    // Dead centre: back out the way she came.
    dx = ml > 1e-9 ? -moveX / ml : 0;
    dz = ml > 1e-9 ? -moveZ / ml : 1;
    d = 0;
  } else {
    dx /= d;
    dz /= d;
  }
  if (ml > 1e-9) {
    const fx = moveX / ml;
    const fz = moveZ / ml;
    // Head-on: the push is nearly opposite the move. Turn it about 25 degrees to one side.
    if (-(dx * fx + dz * fz) > 0.97) {
      const side = dx * fz - dz * fx; // > 0: p is to the right of the move
      const s = side >= 0 ? 1 : -1;
      const rx = fz * s; // the move's right-hand perpendicular, signed
      const rz = -fx * s;
      dx = dx * 0.9 + rx * 0.42;
      dz = dz * 0.9 + rz * 0.42;
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
    }
  }
  const pen = min - d;
  p.x = cx + dx * min;
  p.z = cz + dz * min;
  return pen;
}

/** How far to one side an obstacle's edge may be for a head-on bump to turn into a slide round it. */
export const EDGE_ASSIST = 0.6;

/**
 * pushOutOfRect, plus corner assist: when the step (moveX, moveZ) runs almost
 * head-on into a flat face and the obstacle's nearer side edge is within
 * EDGE_ASSIST, the blocked step becomes a sideways slide towards that edge, so
 * a bin or a pile of bags in her path does not stop her dead. Walls, whose
 * edges are far away, still stop her. Mutates p; returns the resolved depth.
 */
export function pushOutOfRectAssisted(p: Vec2, r: number, rect: Rect, moveX = 0, moveZ = 0): number {
  const n: Vec2 = { x: 0, z: 0 };
  const pen = pushOutOfRect(p, r, rect, n);
  const ml = Math.hypot(moveX, moveZ);
  if (pen <= 0 || ml < 1e-9) return pen;
  if (-(n.x * moveX + n.z * moveZ) / ml < 0.97) return pen; // glancing: plain sliding already works
  // Distance to slip past each side edge, along the face.
  let lo: number;
  let hi: number;
  if (Math.abs(n.z) >= Math.abs(n.x)) {
    lo = p.x - (rect.minX - r); // shift needed towards -x
    hi = rect.maxX + r - p.x; // towards +x
  } else {
    lo = p.z - (rect.minZ - r);
    hi = rect.maxZ + r - p.z;
  }
  const need = Math.min(lo, hi);
  if (need > EDGE_ASSIST || need <= 0) return pen;
  const shift = Math.min(need, ml * 0.9) * (hi <= lo ? 1 : -1);
  if (Math.abs(n.z) >= Math.abs(n.x)) p.x += shift;
  else p.z += shift;
  return pen;
}

/**
 * Push circle (p, r) out of circle (cx, cz, cr). Mutates p. Returns the
 * resolved penetration depth; `n` receives the unit normal from the other
 * circle toward p.
 */
export function pushOutOfCircle(p: Vec2, r: number, cx: number, cz: number, cr: number, n?: Vec2, fallbackX = 0, fallbackZ = 1): number {
  let dx = p.x - cx;
  let dz = p.z - cz;
  const min = r + cr;
  const d2 = dx * dx + dz * dz;
  if (d2 >= min * min) return 0;
  let d = Math.sqrt(d2);
  if (d < 1e-6) {
    // Exactly coincident: pick the caller's preferred way out.
    const fl = Math.hypot(fallbackX, fallbackZ) || 1;
    dx = fallbackX / fl;
    dz = fallbackZ / fl;
    d = 0;
  } else {
    dx /= d;
    dz /= d;
  }
  const pen = min - d;
  p.x += dx * pen;
  p.z += dz * pen;
  if (n) {
    n.x = dx;
    n.z = dz;
  }
  return pen;
}

/** How deep circle (x, z, r) sits inside circle (cx, cz, cr); 0 when apart. */
export function circlePenetration(x: number, z: number, r: number, cx: number, cz: number, cr: number): number {
  const d = Math.hypot(x - cx, z - cz);
  return Math.max(0, r + cr - d);
}

/** Keep a circle inside `bounds`. Returns true if it had to be moved. */
export function clampToBounds(p: Vec2, r: number, bounds: Rect): boolean {
  let moved = false;
  const minX = bounds.minX + r;
  const maxX = bounds.maxX - r;
  const minZ = bounds.minZ + r;
  const maxZ = bounds.maxZ - r;
  if (p.x < minX) {
    p.x = minX;
    moved = true;
  } else if (p.x > maxX) {
    p.x = maxX;
    moved = true;
  }
  if (p.z < minZ) {
    p.z = minZ;
    moved = true;
  } else if (p.z > maxZ) {
    p.z = maxZ;
    moved = true;
  }
  return moved;
}

export type CorridorEdge = 'back' | 'ahead' | 'side';

/**
 * Keep a circle inside the union of `rects` (the walkable route). rects[0] is
 * the main stretch of street; the rest are side pockets (the shop, the stoop).
 * Returns null when nothing moved, else which edge of the route stopped it:
 * 'back' (behind the start, larger z), 'ahead' (past the end) or 'side'.
 */
export function clampToCorridor(p: Vec2, r: number, rects: readonly Rect[]): CorridorEdge | null {
  if (!rects.length) return null;
  const inside = (b: Rect) => p.x >= b.minX + r && p.x <= b.maxX - r && p.z >= b.minZ + r && p.z <= b.maxZ - r;
  if (rects.some(inside)) return null;
  let bestX = p.x;
  let bestZ = p.z;
  let bestD = Infinity;
  for (const b of rects) {
    const x = Math.min(Math.max(p.x, b.minX + r), b.maxX - r);
    const z = Math.min(Math.max(p.z, b.minZ + r), b.maxZ - r);
    const d = (x - p.x) ** 2 + (z - p.z) ** 2;
    if (d < bestD) {
      bestD = d;
      bestX = x;
      bestZ = z;
    }
  }
  const main = rects[0];
  const edge: CorridorEdge = p.z > main.maxZ - r ? 'back' : p.z < main.minZ + r ? 'ahead' : 'side';
  p.x = bestX;
  p.z = bestZ;
  return edge;
}

