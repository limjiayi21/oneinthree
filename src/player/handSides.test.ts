import { describe, expect, it } from 'vitest';
import { gestureAllowed, mergeHands, sideFromLabel } from './hands';
import type { GestureState } from './gestures';

const none: GestureState = { present: false, pinching: false, palm: false, pinchRatio: NaN, fist: false, fistHeld: false };

describe('which hand is which', () => {
  it("the camera model's labels assume a mirrored image, so its 'Left' is the player's right hand", () => {
    expect(sideFromLabel('Left', false)).toBe('right');
    expect(sideFromLabel('Right', false)).toBe('left');
  });

  it('?handswap=1 flips it for a camera that reports the other way', () => {
    expect(sideFromLabel('Left', true)).toBe('left');
    expect(sideFromLabel('Right', true)).toBe('right');
  });

  it('an unknown label is ignored', () => {
    expect(sideFromLabel(undefined, false)).toBeNull();
  });
});

describe('what each hand is for', () => {
  it('the left hand pinches for the phone; the right hand holds a fist to talk', () => {
    expect(gestureAllowed('left', 'pinch')).toBe(true);
    expect(gestureAllowed('right', 'pinch')).toBe(false);
    expect(gestureAllowed('right', 'fist')).toBe(true);
    expect(gestureAllowed('right', 'fistEnd')).toBe(true);
    expect(gestureAllowed('left', 'fist')).toBe(false);
    expect(gestureAllowed('left', 'fistEnd')).toBe(false);
  });

  it('an open palm asks for help with either hand', () => {
    expect(gestureAllowed('left', 'palm')).toBe(true);
    expect(gestureAllowed('right', 'palm')).toBe(true);
  });

  it('the badge shows the right fist and the left pinch, not the other way round', () => {
    const fist: GestureState = { ...none, present: true, fist: true, fistHeld: true };
    const pinch: GestureState = { ...none, present: true, pinching: true };
    expect(mergeHands(none, fist).fist).toBe(true); // right fist
    expect(mergeHands(fist, none).fist).toBe(false); // a left fist does not talk
    expect(mergeHands(pinch, none).pinching).toBe(true); // left pinch
    expect(mergeHands(none, pinch).pinching).toBe(false); // a right pinch does not take out the phone
    expect(mergeHands(none, none).present).toBe(false);
  });
});
