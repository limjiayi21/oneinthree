import { describe, expect, it } from 'vitest';
import type { GestureEvent } from '../player/gestures';
import { bindHandActions } from './handActions';

/** Fakes for just what bindHandActions touches. */
function setup(viewPitch: number) {
  let emit: (g: GestureEvent) => void = () => {};
  const keys: string[] = [];
  const deps = {
    hands: { active: true, onGesture: (cb: (g: GestureEvent) => void) => ((emit = cb), () => {}), setHint: () => {} },
    engine: { onUpdate: () => () => {} },
  };
  const player = { inputEnabled: true, isLocked: true, viewPitch };
  const kit = { ended: false, paused: false, onKey: (code: string) => keys.push(code) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bindHandActions(deps as any, player as any, kit as any, {
    pinch: { key: 'KeyF', hint: () => null },
    palm: { key: 'KeyE', hint: () => null },
  });
  return { emit: (g: GestureEvent) => emit(g), keys };
}

describe('hand actions', () => {
  it('a pinch takes out the phone wherever she is looking', () => {
    for (const pitch of [0, 0.3, -0.2, -0.8]) {
      const { emit, keys } = setup(pitch);
      emit('pinch');
      expect(keys).toEqual(['KeyF']);
    }
  });

  it('an open palm asks for help wherever she is looking', () => {
    for (const pitch of [0, -0.8]) {
      const { emit, keys } = setup(pitch);
      emit('palm');
      expect(keys).toEqual(['KeyE']);
    }
  });

  it('a fist does neither (it is for talking)', () => {
    const { emit, keys } = setup(0);
    emit('fist');
    emit('fistEnd');
    expect(keys).toEqual([]);
  });
});
