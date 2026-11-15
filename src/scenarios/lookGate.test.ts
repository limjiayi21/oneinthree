import { describe, expect, it } from 'vitest';
import { DEG } from '../player/mathx';
import { LookGate, turnHint } from './lookGate';

describe('look left and right before walking', () => {
  it('needs both a look left and a look right', () => {
    const g = new LookGate(0);
    expect(g.update(10 * DEG)).toEqual({ left: false, right: false, done: false });
    expect(g.update(30 * DEG)).toEqual({ left: true, right: false, done: false }); // yaw grows turning left
    expect(g.update(0)).toEqual({ left: true, right: false, done: false });
    expect(g.update(-30 * DEG)).toEqual({ left: true, right: true, done: true });
  });

  it('works whichever way she faces at the start, across the ±180° seam', () => {
    const g = new LookGate(175 * DEG);
    g.update(-155 * DEG); // 30° further left, through the seam
    expect(g.update(145 * DEG).done).toBe(true); // 30° right of the start
  });
});

describe('words beside the arrow', () => {
  it('nothing while she is roughly facing the right way', () => {
    expect(turnHint(0)).toBe('');
    expect(turnHint(30 * DEG)).toBe('');
  });
  it('turn left / right toward it, turn around when it is behind her', () => {
    expect(turnHint(90 * DEG)).toBe('Turn left'); // the target is to her left
    expect(turnHint(-90 * DEG)).toBe('Turn right');
    expect(turnHint(170 * DEG)).toBe('Turn around');
    expect(turnHint(-170 * DEG)).toBe('Turn around');
  });
});
