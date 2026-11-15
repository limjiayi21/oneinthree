import { describe, expect, it } from 'vitest';
import { GestureDetector, GESTURE_TUNING, type HandPoint } from './gestures';

/** A right hand facing the camera, fingers up, in normalized image coordinates. */
function hand(pose: 'open' | 'pinch' | 'fist'): HandPoint[] {
  const p: HandPoint[] = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 }));
  p[0] = { x: 0.5, y: 0.8 }; // wrist
  const xs = [0.44, 0.49, 0.54, 0.59]; // index, middle, ring, pinky
  xs.forEach((x, i) => {
    const base = 5 + i * 4;
    p[base] = { x, y: 0.62 }; // MCP
    p[base + 1] = { x, y: 0.54 }; // PIP
    p[base + 2] = { x, y: pose === 'fist' ? 0.6 : 0.48 }; // DIP
    p[base + 3] = { x, y: pose === 'fist' ? 0.66 : 0.42 }; // tip
  });
  p[1] = { x: 0.46, y: 0.74 };
  p[2] = { x: 0.42, y: 0.69 };
  p[3] = { x: 0.39, y: 0.65 };
  p[4] = { x: 0.37, y: 0.61 }; // thumb tip, away from the index
  if (pose === 'pinch') {
    p[8] = { x: 0.38, y: 0.6 }; // index tip curls onto the thumb tip
    p[7] = { x: 0.41, y: 0.56 };
  }
  return p;
}

const DT = 1 / 30;
function run(d: GestureDetector, frame: HandPoint[] | null, seconds: number) {
  const events: string[] = [];
  for (let t = 0; t < seconds; t += DT) events.push(...d.push(frame, DT));
  return events;
}

describe('GestureDetector', () => {
  it('fires one pinch when the thumb and index tips meet', () => {
    const d = new GestureDetector();
    expect(run(d, hand('open'), 0.3)).toEqual([]);
    expect(run(d, hand('pinch'), 0.5)).toEqual(['pinch']);
    expect(d.state.pinching).toBe(true);
  });

  it('needs the hand to open before pinching again', () => {
    const d = new GestureDetector();
    run(d, hand('open'), 0.2);
    run(d, hand('pinch'), 0.3);
    expect(run(d, hand('pinch'), 1)).toEqual([]);
    run(d, hand('open'), GESTURE_TUNING.pinchCooldown + 0.1);
    expect(run(d, hand('pinch'), 0.3)).toEqual(['pinch']);
  });

  it('ignores a single-frame pinch blip', () => {
    const d = new GestureDetector();
    run(d, hand('open'), 0.2);
    const events = [...d.push(hand('pinch'), DT), ...run(d, hand('open'), 0.2)];
    expect(events).toEqual([]);
  });

  it('fires palm after an open hand is held up, once', () => {
    const d = new GestureDetector();
    const events = run(d, hand('open'), GESTURE_TUNING.palmHold + 0.2);
    expect(events).toEqual(['palm']);
    expect(run(d, hand('open'), 1)).toEqual([]);
  });

  it('does not read a fist as a palm or a pinch (it is its own gesture: hold to talk)', () => {
    const d = new GestureDetector();
    expect(run(d, hand('fist'), 1)).toEqual(['fist']);
    expect(d.state.palm).toBe(false);
    expect(d.state.pinching).toBe(false);
  });

  it('resets when the hand leaves the frame', () => {
    const d = new GestureDetector();
    run(d, hand('pinch'), 0.3);
    run(d, null, 0.5);
    expect(d.state.present).toBe(false);
    expect(d.state.pinching).toBe(false);
  });
});

describe('fist to talk', () => {
  /** A fist with the thumb tucked across, its tip against the curled index. */
  const tucked = (): HandPoint[] => {
    const p = hand('fist');
    p[4] = { ...p[8] };
    return p;
  };

  it('starts once a fist has been held for a moment, and ends when the hand opens', () => {
    const d = new GestureDetector();
    run(d, hand('open'), 0.2);
    expect(run(d, hand('fist'), GESTURE_TUNING.fistHold + 0.2)).toEqual(['fist']);
    expect(d.state.fistHeld).toBe(true);
    // Holding it longer does not fire again.
    expect(run(d, hand('fist'), 2)).toEqual([]);
    expect(run(d, hand('open'), GESTURE_TUNING.fistRelease + 0.1)).toEqual(['fistEnd']);
    expect(d.state.fistHeld).toBe(false);
  });

  it('ignores a fist that only flashes past', () => {
    const d = new GestureDetector();
    run(d, hand('open'), 0.2);
    const events = [...run(d, hand('fist'), GESTURE_TUNING.fistHold / 2), ...run(d, hand('open'), 0.3)];
    expect(events).not.toContain('fist');
    expect(events).not.toContain('fistEnd');
  });

  it('does not end on a one-frame tracking flicker mid-sentence', () => {
    const d = new GestureDetector();
    run(d, hand('fist'), GESTURE_TUNING.fistHold + 0.1);
    const events = [...d.push(hand('open'), DT), ...run(d, hand('fist'), 1)];
    expect(events).toEqual([]);
    expect(d.state.fistHeld).toBe(true);
  });

  it('ends when the hand leaves the camera', () => {
    const d = new GestureDetector();
    run(d, hand('fist'), GESTURE_TUNING.fistHold + 0.1);
    expect(run(d, null, GESTURE_TUNING.lostAfter + 0.1)).toContain('fistEnd');
  });

  it('a fist with the thumb tucked is not a pinch (that would take out the phone)', () => {
    const d = new GestureDetector();
    run(d, hand('open'), 0.2);
    expect(run(d, tucked(), 1)).toEqual(['fist']);
  });

  it('opening the hand after a fist is not taken as a raised palm straight away', () => {
    const d = new GestureDetector();
    run(d, hand('fist'), GESTURE_TUNING.fistHold + 0.1);
    const events = run(d, hand('open'), GESTURE_TUNING.palmHold + 0.3);
    expect(events).toEqual(['fistEnd']);
    // A palm held up well after the fist still counts.
    expect(run(d, hand('open'), GESTURE_TUNING.palmAfterFist + GESTURE_TUNING.palmHold)).toEqual(['palm']);
  });
});
