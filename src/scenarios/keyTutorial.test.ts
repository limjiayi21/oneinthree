import { describe, expect, it } from 'vitest';
import { CONTROLS_PANEL_SECONDS, shouldRunKeyTutorial } from './keyTutorial';

describe('controls panel while walking', () => {
  it('?tutorial=0 turns it off and ?tutorial=1 forces it on', () => {
    expect(shouldRunKeyTutorial('woman', '0')).toBe(false);
    expect(shouldRunKeyTutorial('woman', '1')).toBe(true);
  });

  it('runs by default for a part that has not shown it yet', () => {
    expect(shouldRunKeyTutorial('bystander', null)).toBe(true);
  });

  it('stays up long enough to read', () => {
    expect(CONTROLS_PANEL_SECONDS).toBeGreaterThanOrEqual(8);
  });
});
