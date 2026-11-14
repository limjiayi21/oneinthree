/**
 * Tests for shared/stepDetector.ts on synthetic 60 Hz accelerometer data.
 * Each step is a short raised-cosine bump on z; the noise is a fixed sum of sines (no Math.random).
 */
import { describe, expect, it } from 'vitest';
import { GRAVITY, STEP_MIN_GAP_MS, createStepDetector } from './stepDetector';

const RATE_HZ = 60;
const BUMP_WIDTH_MS = 60;
const BUMP_AMP = 8;

function noise(i: number): number {
  return 0.15 * Math.sin(i * 1.7) + 0.1 * Math.sin(i * 4.3 + 1);
}

/** Feeds `seconds` of samples with a z bump centred on each time in `bumpsMs`; returns how many steps were reported. */
function countSteps(bumpsMs: number[], seconds: number): number {
  const det = createStepDetector();
  let steps = 0;
  const n = Math.round(seconds * RATE_HZ);
  for (let i = 0; i < n; i++) {
    const t = (i * 1000) / RATE_HZ;
    let bump = 0;
    for (const c of bumpsMs) {
      if (Math.abs(t - c) < BUMP_WIDTH_MS / 2) {
        bump += BUMP_AMP * 0.5 * (1 + Math.cos((2 * Math.PI * (t - c)) / BUMP_WIDTH_MS));
      }
    }
    const z = GRAVITY + bump + noise(i);
    if (det.push(0.05 * noise(i + 7), 0.05 * noise(i + 3), z, t)) steps++;
  }
  return steps;
}

describe('step detector', () => {
  it('finds about 20 steps in 10 s of stepping at 2 steps/s, and none when the phone is still', () => {
    const walking = Array.from({ length: 20 }, (_, k) => 250 + k * 500);
    const steps = countSteps(walking, 10);
    expect(steps).toBeGreaterThanOrEqual(19);
    expect(steps).toBeLessThanOrEqual(21);

    expect(countSteps([], 10)).toBe(0);
  });

  it('counts a double bump 100 ms apart as one step, and two bumps closer than STEP_MIN_GAP_MS as one step', () => {
    expect(countSteps([1000, 1100], 3)).toBe(1);

    const close = STEP_MIN_GAP_MS - 50;
    expect(countSteps([1000, 1000 + close], 3)).toBe(1);
    // Control: the same pattern with a gap above the minimum really is two steps.
    expect(countSteps([1000, 1000 + STEP_MIN_GAP_MS + 50], 3)).toBe(2);
  });

  it('returns false and does not throw on non-finite input', () => {
    const det = createStepDetector();
    expect(() => {
      expect(det.push(Number.NaN, 0, GRAVITY, 0)).toBe(false);
      expect(det.push(0, Number.POSITIVE_INFINITY, GRAVITY, 10)).toBe(false);
      expect(det.push(0, 0, GRAVITY, Number.NaN)).toBe(false);
      expect(det.push(0, 0, Number.NEGATIVE_INFINITY, 20)).toBe(false);
    }).not.toThrow();
  });
});
