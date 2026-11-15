import { describe, expect, it } from 'vitest';
import type { GestureState } from './gestures';
import { handIcon } from './hands';

const base: GestureState = { present: true, pinching: false, palm: false, pinchRatio: 1, fist: false, fistHeld: false };

describe('hand status icon', () => {
  it('shows a clenched fist when a fist is detected', () => {
    expect(handIcon({ ...base, fist: true })).toBe('✊');
    expect(handIcon({ ...base, fist: true, fistHeld: true })).toBe('✊');
  });

  it('still shows the pinch, the open palm, and a plain hand', () => {
    expect(handIcon({ ...base, pinching: true })).toBe('🤏');
    expect(handIcon({ ...base, palm: true })).toBe('🖐️');
    expect(handIcon(base)).toBe('✋');
    expect(handIcon({ ...base, present: false })).toBe('✋');
  });
});
