import { describe, expect, it } from 'vitest';
import type { ClientEventType, WomanStrategy, WorldContext } from '../../shared/types';
import { Rng } from './rng';
import { decideWoman, initialWomanState, type WomanState } from './woman';

const ctx = (over: Partial<WorldContext> = {}): WorldContext => ({
  elapsed: 40,
  distanceToMan: 1.6,
  progress: 0.3,
  playerSpeed: 1.2,
  facingMan: true,
  manBlocking: false,
  oppositeSidewalk: false,
  ...over,
});

const MIXED: Array<{ event: ClientEventType; strategy?: WomanStrategy }> = [
  { event: 'speech', strategy: 'polite_deflect' },
  { event: 'silence' },
  { event: 'speech', strategy: 'firm_boundary' },
  { event: 'speech', strategy: 'engage' },
  { event: 'speech', strategy: 'excuse' },
];

function play(seed: number, demo: boolean, beats = MIXED) {
  const rng = new Rng(seed);
  let state: WomanState = initialWomanState(seed % 3 === 0 ? 'mild' : seed % 3 === 1 ? 'persistent' : 'volatile', { demo });
  const open = decideWoman(state, { event: 'begin', ctx: ctx() }, rng);
  state = open.state;
  const outs = [open];
  let t = 40;
  for (const b of beats) {
    t += 5;
    const out = decideWoman(state, { event: b.event, ctx: ctx({ elapsed: t }), strategyProbs: b.strategy ? { [b.strategy]: 1 } : undefined }, rng);
    state = out.state;
    outs.push(out);
    if (out.outcome) break;
  }
  return outs;
}

describe('demo: he gets aggressive quickly', () => {
  it('opens pushy (level 2), not calm', () => {
    for (let seed = 1; seed <= 200; seed++) expect(play(seed, true)[0].level, `seed ${seed}`).toBe(2);
  });

  it('climbs at every response, whatever she says, up to 5 and no further', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const levels = play(seed, true).map((o) => o.level ?? 0);
      for (let i = 1; i < levels.length; i++) {
        expect(levels[i]!, `seed ${seed} step ${i}`).toBeGreaterThanOrEqual(Math.min(5, levels[i - 1]! + 1));
        expect(levels[i]!, `seed ${seed} step ${i}`).toBeLessThanOrEqual(5);
      }
    }
  });

  it('never walks off or grabs her, so the demo can end at the shop', () => {
    for (let seed = 1; seed <= 300; seed++) {
      for (const o of play(seed, true)) {
        expect(o.decision?.stance, `seed ${seed}`).not.toBe('back_off');
        expect(o.decision?.stance, `seed ${seed}`).not.toBe('escalate');
        expect(o.outcome, `seed ${seed}`).toBeUndefined();
      }
    }
  });

  it('blocks her path once he is at 4 or above (when a block is allowed)', () => {
    let blocks = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const outs = play(seed, true);
      const firstHigh = outs.findIndex((o) => (o.level ?? 0) >= 4);
      if (firstHigh >= 0 && outs[firstHigh]!.decision?.action === 'block_path') blocks++;
    }
    expect(blocks).toBeGreaterThan(90);
  });

  it('the full version is unchanged: without demo he can still open calm and walk off', () => {
    const opens = new Set<number>();
    let leaves = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const outs = play(seed, false);
      opens.add(outs[0].level ?? -1);
      if (outs.some((o) => o.decision?.stance === 'back_off')) leaves++;
    }
    expect([...opens].sort()).toEqual([0, 1]);
    expect(leaves).toBeGreaterThan(0);
  });
});
