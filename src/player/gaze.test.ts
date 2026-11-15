import { describe, expect, it } from 'vitest';
import { DEG } from './mathx';
import { GazeFilter, gazeFromFace, gazeToLook, GAZE_TUNING, type FacePoint } from './gaze';

/** A frontal face in normalized image coordinates (unmirrored camera image). */
function face(opts: { noseDx?: number; noseDy?: number } = {}): FacePoint[] {
  const pts: FacePoint[] = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  pts[234] = { x: 0.4, y: 0.5 }; // subject's right cheek edge: image left
  pts[454] = { x: 0.6, y: 0.5 }; // subject's left cheek edge: image right
  pts[33] = { x: 0.44, y: 0.45 }; // right eye outer corner
  pts[263] = { x: 0.56, y: 0.45 }; // left eye outer corner
  pts[152] = { x: 0.5, y: 0.65 }; // chin
  pts[1] = { x: 0.5 + (opts.noseDx ?? 0), y: 0.52 + (opts.noseDy ?? 0) }; // nose tip
  return pts;
}

describe('gazeFromFace', () => {
  it('reads a head turn to the subject\'s right as positive x', () => {
    // turning right moves the nose toward the image's left edge
    expect(gazeFromFace(face({ noseDx: -0.03 }))!.x).toBeGreaterThan(gazeFromFace(face())!.x);
  });

  it('reads tilting the head up as positive y', () => {
    expect(gazeFromFace(face({ noseDy: -0.03 }))!.y).toBeGreaterThan(gazeFromFace(face())!.y);
  });

  it('scales up and down separately from left and right', () => {
    const base = gazeFromFace(face({ noseDx: -0.03, noseDy: -0.03 }), 1, 1)!;
    const tall = gazeFromFace(face({ noseDx: -0.03, noseDy: -0.03 }), 1, 2)!;
    expect(tall.x).toBeCloseTo(base.x, 9);
    expect(tall.y).toBeCloseTo(base.y * 2, 9);
  });

  it('returns null for a face too small to trust', () => {
    const pts = face();
    pts[234] = { x: 0.499, y: 0.5 };
    pts[454] = { x: 0.501, y: 0.5 };
    expect(gazeFromFace(pts)).toBeNull();
  });
});

describe('GazeFilter', () => {
  it('centres on the calibration pose', () => {
    const f = new GazeFilter();
    f.beginCalibration();
    for (let i = 0; i < 20; i++) f.push({ x: 0.3, y: -0.2}, 1 / 30);
    f.endCalibration();
    for (let i = 0; i < 60; i++) f.push({ x: 0.3, y: -0.2}, 1 / 30);
    const g = f.value()!;
    expect(Math.abs(g.x)).toBeLessThan(1e-6);
    expect(Math.abs(g.y)).toBeLessThan(1e-6);
  });

  it('rides out a dropped frame but forgets the gaze when the face is lost', () => {
    const f = new GazeFilter();
    f.push({ x: 0.5, y: 0}, 1 / 30);
    f.push(null, 1 / 30);
    expect(f.value()).not.toBeNull();
    for (let i = 0; i < 12; i++) f.push(null, 1 / 30);
    expect(f.value()).toBeNull();
  });
});

describe('gazeToLook', () => {
  it('does nothing inside the dead zone', () => {
    const look = gazeToLook({ x: GAZE_TUNING.deadZone * 0.9, y: -GAZE_TUNING.deadZoneY * 0.9 });
    expect(look.yawOffset).toBe(0);
    expect(look.pitchOffset).toBe(0);
    expect(look.yawRate).toBe(0);
  });

  it('turns the view right (negative yaw) when looking right', () => {
    const look = gazeToLook({ x: 0.5, y: 0 });
    expect(look.yawOffset).toBeLessThan(0);
    expect(look.yawOffset).toBeGreaterThan(-GAZE_TUNING.maxGlanceYaw);
    expect(look.yawRate).toBe(0); // not yet at the edge
  });

  it('keeps turning while the gaze rests at the edge', () => {
    const left = gazeToLook({ x: -1, y: 0 });
    expect(left.yawOffset).toBeCloseTo(GAZE_TUNING.maxGlanceYaw, 6);
    expect(left.yawRate).toBeCloseTo(GAZE_TUNING.maxTurnRate, 6);
  });

  it('tilts the view up when looking up, within limits', () => {
    const look = gazeToLook({ x: 0, y: 3 });
    expect(look.pitchOffset).toBeCloseTo(GAZE_TUNING.maxGlancePitchUp, 6);
    expect(GAZE_TUNING.maxGlancePitchUp).toBeLessThan(45 * DEG);
  });

  it('a full downward look reaches the furthest glance down', () => {
    // (The phone no longer needs looking down: a pinch anywhere takes it out.)
    expect(gazeToLook({ x: 0, y: -1 }).pitchOffset).toBeCloseTo(-GAZE_TUNING.maxGlancePitchDown, 6);
  });
});
