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
