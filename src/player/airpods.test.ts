import { describe, expect, it } from 'vitest';
import { attitudeToGaze, isAirPodsLabel, AIRPODS_TUNING } from './airpods';
import { DEG } from './mathx';

describe('isAirPodsLabel', () => {
  it('recognises AirPods by name', () => {
    expect(isAirPodsLabel('Glenn’s AirPods Pro')).toBe(true);
    expect(isAirPodsLabel('AirPods Max (Bluetooth)')).toBe(true);
    expect(isAirPodsLabel('MacBook Pro Microphone')).toBe(false);
  });
});

describe('attitudeToGaze', () => {
  const centre = { yaw: 0.3, pitch: -0.1 };

  it('is centred at the calibrated pose', () => {
    const g = attitudeToGaze({ yaw: 0.3, pitch: -0.1 }, centre);
    expect(g.x).toBeCloseTo(0, 9);
    expect(g.y).toBeCloseTo(0, 9);
  });

  it('reads turning left (yaw up) as looking left, a full turn range as 1', () => {
    const g = attitudeToGaze({ yaw: 0.3 + AIRPODS_TUNING.turnRange, pitch: -0.1 }, centre);
    expect(g.x).toBeCloseTo(-1, 6);
  });

  it('reads tilting up as looking up', () => {
    const g = attitudeToGaze({ yaw: 0.3, pitch: -0.1 + AIRPODS_TUNING.tiltRange / 2 }, centre);
    expect(g.y).toBeCloseTo(0.5, 6);
  });

  it('handles yaw wrapping past ±180°', () => {
    const g = attitudeToGaze({ yaw: -179 * DEG, pitch: 0 }, { yaw: 179 * DEG, pitch: 0 });
    expect(g.x).toBeCloseTo(-(2 * DEG) / AIRPODS_TUNING.turnRange, 6); // 2° further left, not 358° right
  });

  it('can flip an axis when a headset reports the other way', () => {
    const g = attitudeToGaze({ yaw: 0.3 + 0.1, pitch: 0 }, centre, { flipX: true });
    expect(g.x).toBeGreaterThan(0);
  });
});
