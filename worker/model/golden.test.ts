import { describe, expect, it } from 'vitest';
import type { ClientEventType, WomanStrategy, WorldContext } from '../../shared/types';
import { GOLDEN_LEVELS } from './golden';
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

/** The climb as written in docs/golden-run.md: hi, heading home, no thanks, (silence), leave me alone, I said leave me alone. */
const CLIMB: Array<{ event: ClientEventType; strategy?: WomanStrategy }> = [
  { event: 'speech', strategy: 'engage' },
  { event: 'speech', strategy: 'engage' },
  { event: 'speech', strategy: 'polite_deflect' },
  { event: 'silence' },
  { event: 'speech', strategy: 'firm_boundary' },
  { event: 'speech', strategy: 'firm_boundary' },
];

function play(seed: number, beats: Array<{ event: ClientEventType; strategy?: WomanStrategy; ctx?: Partial<WorldContext> }>) {
  const rng = new Rng(seed);
  let state: WomanState = initialWomanState(seed % 3 === 0 ? 'mild' : seed % 3 === 1 ? 'persistent' : 'volatile', { golden: true });
  const open = decideWoman(state, { event: 'begin', ctx: ctx() }, rng);
  state = open.state;
  const outs = [open];
  let t = 40;
  for (const b of beats) {
    t += 9;
    const out = decideWoman(state, { event: b.event, ctx: ctx({ elapsed: t, ...b.ctx }), strategyProbs: b.strategy ? { [b.strategy]: 1 } : undefined }, rng);
    state = out.state;
    outs.push(out);
    if (out.outcome) break;
  }
  return outs;
}

describe('golden run (docs/golden-run.md)', () => {
  it('opens at level 1 and climbs 1, 1, 2, 2, 3, 4 over six responses, for every man, without ever leaving', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const outs = play(seed, CLIMB);
      expect(outs[0].level, `seed ${seed}`).toBe(1);
      expect(outs.slice(1).map((o) => o.level), `seed ${seed}`).toEqual(GOLDEN_LEVELS);
      for (const o of outs) expect(o.decision?.stance).not.toBe('back_off');
    }
  });

  it('holds the climb whatever she actually says (the script, not the odds)', () => {
    const odd: Array<{ event: ClientEventType; strategy?: WomanStrategy }> = ['threaten_attention', 'excuse', 'engage', 'plead', 'polite_deflect', 'unclear'].map((s) => ({ event: 'speech', strategy: s as WomanStrategy }));
    for (let seed = 1; seed <= 100; seed++) expect(play(seed, odd).slice(1).map((o) => o.level)).toEqual(GOLDEN_LEVELS);
  });

  it('Ending A: she heads for the shop, he comes after her at 5, and going inside ends it with her safe', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const outs = play(seed, [...CLIMB, { event: 'crossed_street', ctx: { playerSpeed: 2.2 } }, { event: 'entered_shop' }]);
      const a1 = outs[CLIMB.length + 1];
      expect(a1.level).toBe(5);
      expect(['follow', 'block']).toContain(a1.decision?.stance);
      expect(outs[outs.length - 1].outcome).toBe('took_refuge');
    }
  });

  it('Ending B: an insult brings him in close at 5, and pushing past him ends in the cut to black', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const outs = play(seed, [...CLIMB, { event: 'speech', strategy: 'hostile' }, { event: 'pushed_past', ctx: { distanceToMan: 0.8 } }]);
      const b1 = outs[CLIMB.length + 1];
      const b2 = outs[CLIMB.length + 2];
      expect(b1.level).toBe(5);
      expect(b2.level).toBe(6);
      expect(b2.decision?.stance).toBe('escalate');
      expect(b2.outcome).toBe('escalated');
    }
  });

  it('never moves more than two levels in one beat', () => {
    const outs = play(7, [...CLIMB, { event: 'speech', strategy: 'hostile' }, { event: 'speech', strategy: 'hostile' }]);
    for (let i = 1; i < outs.length; i++) expect(outs[i].level - outs[i - 1].level).toBeLessThanOrEqual(2);
  });

  it('is off unless asked for: a normal session is not golden', () => {
    expect(initialWomanState('mild').golden).toBeUndefined();
  });
});
