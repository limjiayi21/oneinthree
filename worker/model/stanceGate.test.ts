import { describe, expect, it } from 'vitest';
import type { WorldContext } from '../../shared/types';
import { DEMO_SEED } from '../../shared/demo';
import { composeBeat } from '../judge';
import { groundedLine, lineAcknowledges } from './address';
import { heuristicWomanRead } from '../read';
import { Rng } from './rng';
import { decideWoman, initialWomanState, type Disposition } from './woman';
import { gateStance, isClearFirm, isEngagedUtterance } from './stanceGate';

const ctx = (over: Partial<WorldContext> = {}): WorldContext => ({
  elapsed: 20,
  distanceToMan: 2,
  progress: 0.3,
  playerSpeed: 1.1,
  facingMan: true,
  manBlocking: false,
  oppositeSidewalk: false,
  ...over,
});

function firstReply(text: string, seed: number, disposition: Disposition = 'persistent') {
  const rng = new Rng(seed);
  let state = initialWomanState(disposition);
  const opened = decideWoman(state, { event: 'begin', ctx: ctx({ elapsed: 4 }) }, rng);
  state = opened.state;
  const read = heuristicWomanRead(text);
  const out = decideWoman(state, { event: 'speech', ctx: ctx(), text, strategyProbs: read.strategyProbs, signals: read.signals }, rng);
  const line = groundedLine({ stance: out.decision?.stance ?? 'persist', move: 'engage', text, rng });
  return { out, line, strategy: read.strategy };
}

describe('greetings are not a boundary', () => {
  it('classifies hello, hi, what, um, and sorry as engagement', () => {
    for (const text of ['hello', 'hi', 'what?', 'um', 'sorry']) {
      expect(isEngagedUtterance(text), text).toBe(true);
      expect(isClearFirm(text), text).toBe(false);
      expect(heuristicWomanRead(text).strategy, text).toBe('engage');
    }
    expect(heuristicWomanRead('Leave me alone.').strategy).toBe('firm_boundary');
    expect(heuristicWomanRead('I am calling the police.').strategy).toBe('threaten_attention');
  });

  it('does not retreat on the first reply to a greeting, for any disposition or the demo seed', () => {
    const dispositions: Disposition[] = ['mild', 'persistent', 'volatile'];
    for (const text of ['hello', 'hi', 'what?', 'sorry', 'um']) {
      for (const disposition of dispositions) {
        for (let seed = 1; seed <= 12; seed++) {
          const { out, line } = firstReply(text, seed, disposition);
          expect(out.decision?.stance, `${text} ${disposition} ${seed}`).not.toBe('back_off');
          expect(out.decision?.stance).not.toBe('gone');
          expect(line ?? '', text).not.toMatch(/your loss/i);
        }
      }
      const demo = firstReply(text, DEMO_SEED, 'persistent');
      expect(demo.out.decision?.stance, text).not.toBe('back_off');
    }
  });

  it('a judge that says back off on hello is ignored; a timeout keeps the seeded engaged stance', () => {
    const seeded = { stance: 'persist' as const, emotion: 'smirk' as const, emotionIntensity: 0.6, action: 'stay' as const, tension: 0.2 };
    const jumped = composeBeat(
      seeded,
      { provider: 'workers', firmBoundary: 1, bystander: 1, tone: 'firm', stance: 'back_off', expression: 'backing_off', escalation: 0.2 },
      { bystanderIntervened: false, text: 'hello', fromStance: 'opening', turn: 1, rejections: 0 },
    );
    expect(jumped.stance).toBe('persist');
    expect(jumped.stance).not.toBe('back_off');

    const timedOut = composeBeat(seeded, null, { bystanderIntervened: false, text: 'hello', fromStance: 'opening', turn: 1, rejections: 0 });
    expect(timedOut.stance).toBe('persist');
    expect(gateStance('opening', 'back_off', { text: 'hello', turn: 1, rejections: 0, bystander: false, seekingHelp: false, clearFirm: false, insult: false })).toBe('persist');
  });

  it('the first clear no is defensive, and a second one can end it', () => {
    const base = { turn: 2, bystander: false, seekingHelp: false, insult: false, clearFirm: true, text: 'Leave me alone.' };
    expect(gateStance('persist', 'back_off', { ...base, rejections: 0 })).toBe('guilt');
    expect(gateStance('persist', 'back_off', { ...base, rejections: 1 })).toBe('back_off');

    const rng = new Rng(3);
    let state = decideWoman(initialWomanState('persistent'), { event: 'begin', ctx: ctx() }, rng).state;
    const once = decideWoman(state, { event: 'speech', ctx: ctx(), text: 'Leave me alone.', strategyProbs: { firm_boundary: 1 } }, rng);
    expect(once.decision?.stance).toBe('guilt');
    let left = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const r = new Rng(seed);
      let s = decideWoman(initialWomanState('persistent'), { event: 'begin', ctx: ctx() }, r).state;
      s = decideWoman(s, { event: 'speech', ctx: ctx(), text: 'Leave me alone.', strategyProbs: { firm_boundary: 1 } }, r).state;
      const second = decideWoman(s, { event: 'speech', ctx: ctx({ elapsed: 30 }), text: 'I said leave me alone.', strategyProbs: { firm_boundary: 1 } }, r);
      if (second.decision?.stance === 'back_off') left += 1;
    }
    expect(left).toBeGreaterThan(0);
  });

  it('a greeting line uses her word and is not the leaving line', () => {
    const { line } = firstReply('hello', 4);
    expect(line).toBeTruthy();
    expect(lineAcknowledges(line!, 'hello')).toBe(true);
    expect(line).not.toMatch(/your loss/i);
  });
});
