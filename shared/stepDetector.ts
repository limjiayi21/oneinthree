/**
 * Step detector: pure function of accelerometer samples, no DOM or browser APIs,
 * so it can be tested with sample data and compiled under both tsconfigs.
 * Method: magnitude of accelerationIncludingGravity minus gravity, exponentially
 * smoothed; a step fires when the smoothed signal rises through the threshold,
 * at least STEP_MIN_GAP_MS after the previous step, and only after the signal
 * has dropped below the lower re-arm level (so one bounce never counts twice).
 * NOTE: every constant below is a first guess and needs tuning on real phones.
 */

/** Standard gravity, m/s^2. */
export const GRAVITY = 9.81;
/** Smoothed (magnitude - gravity) must rise through this to count as a step, m/s^2. */
export const STEP_THRESHOLD = 1.2; // 1.5 missed soft pocket steps; 1.0 also counted the phone shifting in the pocket
/** After a step the smoothed signal must fall below this before the next can fire, m/s^2. */
export const STEP_REARM_LEVEL = 0.35;
/** Minimum time between two steps, ms. */
export const STEP_MIN_GAP_MS = 250;
/** Smoothing factor for the exponential moving average, 0..1 (higher = less smoothing). */
export const SMOOTHING_ALPHA = 0.35;

export interface StepDetector {
  /** Feed one sample (m/s^2, timestamp in ms). Returns true exactly when a new step is detected. */
  push(x: number, y: number, z: number, tMs: number): boolean;
  /** Forget all state. */
  reset(): void;
}

export function createStepDetector(): StepDetector {
  let smoothed = 0;
  let primed = false;
  let armed = true;
  let lastStepMs = -Infinity;

  return {
    push(x, y, z, tMs) {
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !Number.isFinite(tMs)) {
        return false;
      }
      const dev = Math.abs(Math.sqrt(x * x + y * y + z * z) - GRAVITY);
      if (!primed) {
        smoothed = dev;
        primed = true;
      } else {
        smoothed += SMOOTHING_ALPHA * (dev - smoothed);
      }

      if (smoothed < STEP_REARM_LEVEL) armed = true;
      if (armed && smoothed >= STEP_THRESHOLD) {
        // Any crossing disarms, even one blocked by the gap: otherwise that bump's tail fires once the gap clears.
        armed = false;
        if (tMs - lastStepMs < STEP_MIN_GAP_MS) return false;
        lastStepMs = tMs;
        return true;
      }
      return false;
    },
    reset() {
      smoothed = 0;
      primed = false;
      armed = true;
      lastStepMs = -Infinity;
    },
  };
}
