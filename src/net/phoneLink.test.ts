// Tests the pure step-rhythm model in phoneLink.ts: stop timeout, pace, calibration, pauses, clock errors, reset.
import { describe, expect, it } from 'vitest';
import { CALIBRATION_STEPS, DEFAULT_NORMAL_MS, STOP_AFTER_MS, createStepRhythm, type StepRhythm } from './phoneLink';

// Phone clock and received clock move together here (received = phone time).
function feed(r: StepRhythm, phoneTimes: number[]): void {
  for (const t of phoneTimes) r.step(t, t);
}

// n step times starting at `start`, `gap` ms apart.
function series(start: number, gap: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => start + i * gap);
}

describe('createStepRhythm', () => {
  it('is stopped with no steps, walks after one step, stops after STOP_AFTER_MS', () => {
    const r = createStepRhythm();
    expect(r.state(0)).toBe('stopped');
    r.step(1000, 1000);
    expect(r.state(1000)).toBe('walking');
    expect(r.state(1000 + STOP_AFTER_MS - 1)).toBe('walking');
    expect(r.state(1000 + STOP_AFTER_MS)).toBe('stopped');
  });

  it('walks at a steady 550 ms rhythm', () => {
    const r = createStepRhythm();
    feed(r, series(0, 550, 6));
    expect(r.state(2750)).toBe('walking');
  });

  it('calibrates from 8 steps, then hurries below 0.75 of normal and recovers', () => {
    const r = createStepRhythm();
    feed(r, series(0, 600, CALIBRATION_STEPS + 1)); // 8 intervals of 600 ms: last step at 4800
    expect(r.normalMs).toBe(600);

    feed(r, series(5200, 400, 3)); // 400 < 0.75 * 600
    expect(r.state(6000)).toBe('hurrying');
    expect(r.normalMs).toBe(600);

    feed(r, series(6600, 600, 3));
    expect(r.state(7800)).toBe('walking');
  });

  it('eases down after a late step instead of stopping, and stops after 2.3 step times', () => {
    const r = createStepRhythm();
    feed(r, series(0, 500, 4)); // pace 500 ms, last step at 1500
    expect(r.drive(1500 + 650)).toBe(1); // full speed up to 1.3 step times
    const dip = r.drive(1500 + 900);
    expect(dip).toBeGreaterThan(0);
    expect(dip).toBeLessThan(1);
    expect(r.state(1500 + 900)).toBe('walking'); // a missed step is a dip, not a stop
    expect(r.state(1500 + 1150)).toBe('stopped'); // 2.3 x 500
  });

  it('running in place: steps well under the normal interval read as running', () => {
    const r = createStepRhythm();
    feed(r, series(0, 600, 9)); // calibrates normal to 600 ms
    feed(r, series(5100, 330, 4)); // 330 ms < 0.62 x 600
    expect(r.state(5100 + 990)).toBe('running');
  });

  it('one double-counted step, or fast steps before calibration, never read as running', () => {
    const r = createStepRhythm();
    feed(r, series(0, 600, 9)); // calibrated at 600 ms
    feed(r, [5400, 5550, 5950, 6250]); // intervals 600, 150 (double count), 400, 300
    expect(r.state(6250)).not.toBe('running');

    const fresh = createStepRhythm();
    feed(fresh, series(0, 330, 5)); // quick from the start: not calibrated yet
    expect(fresh.state(1400)).not.toBe('running');
  });

  it('a very quick (possibly misread) pace still coasts at least MIN_COAST_MS', () => {
    const r = createStepRhythm();
    feed(r, series(0, 280, 4)); // pace 280 ms, last step at 840
    expect(r.state(840 + 600)).not.toBe('stopped'); // a real step 600 ms later keeps her walking
  });

  it('ignores a pause longer than STOP_AFTER_MS for calibration', () => {
    const r = createStepRhythm();
    feed(r, series(0, 600, 5)); // 4 valid intervals, last step at 2400
    feed(r, [5400]); // 3000 ms pause: not a valid interval
    feed(r, series(6000, 600, 3)); // 3 more valid intervals: 7 in total
    expect(r.normalMs).toBe(DEFAULT_NORMAL_MS);
    feed(r, [7800]); // 8th valid interval
    expect(r.normalMs).toBe(600);
  });

  it('ignores a phone clock that goes backwards without throwing', () => {
    const r = createStepRhythm();
    feed(r, series(0, 600, 5)); // 4 valid intervals, last step at 2400
    expect(() => r.step(100, 2450)).not.toThrow(); // phone clock went back
    expect(r.state(2450)).toBe('walking');
    expect(r.normalMs).toBe(DEFAULT_NORMAL_MS);
    feed(r, series(700, 600, 4)); // 4 more valid intervals from the reset point: 8 in total
    expect(r.normalMs).toBe(600);
  });

  it('reset returns to stopped and the default pace', () => {
    const r = createStepRhythm();
    feed(r, series(0, 600, CALIBRATION_STEPS + 1));
    expect(r.normalMs).toBe(600);
    r.reset();
    expect(r.normalMs).toBe(DEFAULT_NORMAL_MS);
    expect(r.state(4800)).toBe('stopped');
  });
});
