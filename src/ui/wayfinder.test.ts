import { describe, expect, it } from 'vitest';
import { DEG } from '../player/mathx';
import { wayfinderLevel } from './wayfinder';

describe('wayfinderLevel', () => {
  it('is subtle when she faces the target and walks toward it', () => {
    expect(wayfinderLevel(0, 1.4)).toBeLessThan(0.25);
    expect(wayfinderLevel(20 * DEG, 1.2)).toBeLessThan(0.25);
  });

  it('is subtle when she stands still facing the right way', () => {
    expect(wayfinderLevel(0, 0)).toBeLessThan(0.25);
  });

  it('grows as she turns away from the target', () => {
    const side = wayfinderLevel(90 * DEG, 0);
    expect(side).toBeGreaterThan(wayfinderLevel(0, 0));
    expect(side).toBeLessThan(wayfinderLevel(180 * DEG, 0));
  });

  it('is full when she faces the wrong way', () => {
    expect(wayfinderLevel(180 * DEG, 0)).toBeGreaterThan(0.9);
    expect(wayfinderLevel(-160 * DEG, 0)).toBeGreaterThan(0.9);
  });

  it('is obvious when she moves away from the target even while facing it (walking backwards)', () => {
    expect(wayfinderLevel(0, -1.0)).toBeGreaterThan(0.7);
  });

  it('stays within 0..1', () => {
    for (const a of [-200, -90, 0, 45, 180, 400]) for (const v of [-3, -1, 0, 1, 3]) {
      const l = wayfinderLevel(a * DEG, v);
      expect(l).toBeGreaterThanOrEqual(0);
      expect(l).toBeLessThanOrEqual(1);
    }
  });
});
