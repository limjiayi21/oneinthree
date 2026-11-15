import { describe, expect, it } from 'vitest';
import type { WorldContext } from '../../shared/types';
import { decideBystander, initialBystanderState } from './bystander';
import { Rng } from './rng';

const ctx: WorldContext = {
  elapsed: 44,
  distanceToMan: 20,
  distanceToWoman: 20,
  progress: 0.4,
  playerSpeed: 0,
  facingMan: false,
  manBlocking: true,
  oppositeSidewalk: false,
  beat: 'timeout',
};

describe('nobody steps in (Part 2)', () => {
  it('always ends with him grabbing her in the live game', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const out = decideBystander(initialBystanderState(), { event: 'scene_timeout', ctx, inactionEnding: 'physical' }, new Rng(seed));
      expect(out.outcome).toBe('no_intervention_escalated');
      expect(out.man?.action).toBe('grab');
    }
  });

  it('keeps the research rate without the flag (simulations and tests)', () => {
    let grabbed = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const out = decideBystander(initialBystanderState(), { event: 'scene_timeout', ctx }, new Rng(seed));
      if (out.outcome === 'no_intervention_escalated') grabbed++;
    }
    expect(grabbed / 400).toBeLessThan(0.1);
  });
});
