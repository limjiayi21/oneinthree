import { describe, expect, it } from 'vitest';
import { isPost, pushOutOfPost, pushOutOfRect, pushOutOfRectAssisted, type Vec2 } from './collision';
import type { Rect } from '../contracts';

const R = 0.3; // the player's radius
const trunk: Rect = { minX: 5.13, maxX: 5.47, minZ: -14.67, maxZ: -14.33 }; // the first tree, at (5.3, -14.5)

/** Walk forward (-z) in small steps from (x, -10), pushing out of the obstacle after each one. */
function walk(x: number, push: (p: Vec2, mx: number, mz: number) => void, steps = 300, step = 0.05): Vec2 {
  const p = { x, z: -10 };
  for (let i = 0; i < steps; i++) {
    p.z -= step;
    push(p, 0, -step);
  }
  return p;
}

describe('posts (trunks, poles, bins)', () => {
  it('counts small rects as posts and walls as walls', () => {
    expect(isPost(trunk)).toBe(true);
    expect(isPost({ minX: 8.55, maxX: 9.45, minZ: -19.6, maxZ: -18.75 })).toBe(false);
  });

  it('was the bug: a square trunk stops you dead when you walk straight at it', () => {
    const p = walk(5.3, (q) => void pushOutOfRect(q, R, trunk));
    expect(p.z).toBeGreaterThan(-14.4);
  });

  it('slides you round a trunk you walk straight into, dead centre or a little off', () => {
    for (const x of [5.3, 5.31, 5.2, 5.45]) {
      const p = walk(x, (q, mx, mz) => void pushOutOfPost(q, R, trunk, mx, mz));
      expect(p.z).toBeLessThan(-20);
      // and it never leaves you inside the trunk
      expect(Math.hypot(p.x - 5.3, p.z + 14.5)).toBeGreaterThanOrEqual(R + 0.17 - 1e-9);
    }
  });

  it('does not push you sideways when you are not touching it', () => {
    const p = { x: 6.5, z: -14.5 };
    expect(pushOutOfPost(p, R, trunk, 0, -0.05)).toBe(0);
    expect(p).toEqual({ x: 6.5, z: -14.5 });
  });
});

describe('corner assist for bigger obstacles', () => {
  const bags: Rect = { minX: 4.55, maxX: 5.85, minZ: -13.3, maxZ: -11.1 }; // the trash pile at (5.2, -12.2)
  const wall: Rect = { minX: 0, maxX: 10, minZ: -13.3, maxZ: -11.1 };

  it('was the bug: walking from the subway exit into the bags stops you dead', () => {
    const p = walk(5.75, (q) => void pushOutOfRect(q, R, bags));
    expect(p.z).toBeGreaterThan(-11);
  });

  it('slides you round the near edge of the bags', () => {
    const p = walk(5.75, (q, mx, mz) => void pushOutOfRectAssisted(q, R, bags, mx, mz));
    expect(p.z).toBeLessThan(-20);
    expect(p.x).toBeGreaterThanOrEqual(5.85 + R - 1e-9);
  });

  it('still stops you at a wall', () => {
    const p = walk(5.75, (q, mx, mz) => void pushOutOfRectAssisted(q, R, wall, mx, mz));
    expect(p.z).toBeGreaterThan(-11);
    expect(p.x).toBeCloseTo(5.75);
  });
});
