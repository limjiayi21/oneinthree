import { describe, expect, it } from 'vitest';
import type { WomanStrategy, WorldContext } from '../../shared/types';
import { LEVELS, MAX_LEVEL, STEPS, applyStep, stepDistribution, type LadderContext, type Step } from './ladder';
import { PARAMS, param, val } from './params';
import { Rng } from './rng';
import { simulateWoman } from './simulate';
import { WOMAN_STRATEGIES, decideWoman, drawDisposition, initialWomanState, type Disposition, type WomanState } from './woman';

const DISPOSITIONS: Disposition[] = ['mild', 'persistent', 'volatile'];
const ctx = (over: Partial<WorldContext> = {}): WorldContext => ({
  elapsed: 40,
  distanceToMan: 2,
  progress: 0.3,
  playerSpeed: 1.2,
  facingMan: true,
  manBlocking: false,
  oppositeSidewalk: false,
  ...over,
});
const lctx = (level: number, disposition: Disposition, over: Partial<LadderContext> = {}): LadderContext => ({
  level,
  disposition,
  turn: 6,
  encounterSeconds: 30,
  distant: false,
  ...over,
});
const rise = (p: Record<Step, number>) => p.up + p.jump;

describe('ladder rows', () => {
  it('every row is a full set of five labelled parameters that sums to 1', () => {
    for (const s of WOMAN_STRATEGIES) {
      let sum = 0;
      for (const step of STEPS) {
        const p = param(PARAMS, `model.ladder.${s}.${step}`);
        expect(p.basis, p.key).toBe('assumption');
        expect(p.rationale.length, p.key).toBeGreaterThan(40);
        sum += p.value;
      }
      expect(sum, s).toBeCloseTo(1, 6);
    }
  });

  it('every step distribution sums to 1, whatever the level, disposition, distance or time', () => {
    for (const s of WOMAN_STRATEGIES)
      for (const d of DISPOSITIONS)
        for (let level = 0; level < MAX_LEVEL; level++)
          for (const distant of [false, true])
            for (const encounterSeconds of [0, 90, 200]) {
              const p = stepDistribution({ [s]: 1 }, lctx(level, d, { distant, encounterSeconds }), PARAMS);
              const total = STEPS.reduce((a, k) => a + p[k], 0);
              expect(total, `${s} ${d} ${level}`).toBeCloseTo(1, 9);
              for (const k of STEPS) expect(p[k]).toBeGreaterThanOrEqual(0);
              if (level === 0) expect(p.down).toBe(0);
            }
  });

  it('a step is never more than two levels up or one down, and the level stays within 0..6', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 20000; i++) {
      const level = Math.floor(rng.next() * MAX_LEVEL);
      const step = rng.pick<Step>(STEPS);
      const next = applyStep(level, step);
      expect(next - level).toBeLessThanOrEqual(2);
      expect(next - level).toBeGreaterThanOrEqual(-1);
      expect(next).toBeGreaterThanOrEqual(0);
      expect(next).toBeLessThanOrEqual(MAX_LEVEL);
    }
    for (let seed = 0; seed < 3000; seed++) {
      const run = simulateWoman('mixed', 100 + seed);
      for (let i = 1; i < run.levels.length; i++) expect(run.levels[i] - run.levels[i - 1]).toBeLessThanOrEqual(2);
    }
  });

  it('a friendly or unclear answer never makes him jump two levels, for any disposition or level', () => {
    for (const d of DISPOSITIONS)
      for (let level = 0; level < MAX_LEVEL; level++) {
        expect(stepDistribution({ engage: 1 }, lctx(level, d), PARAMS).jump).toBe(0);
        expect(stepDistribution({ unclear: 1 }, lctx(level, d), PARAMS).jump).toBe(0);
      }
  });

  it('keeps the orderings the research supports, at every level and for every disposition', () => {
    for (const d of DISPOSITIONS)
      for (let level = 0; level < MAX_LEVEL - 1; level++) {
        const p = (s: WomanStrategy) => stepDistribution({ [s]: 1 }, lctx(level, d), PARAMS);
        // an insult is the riskiest answer (ssh_assertive, stratmoen_2018_pt)
        expect(p('hostile').jump, `${d} ${level}`).toBeGreaterThan(p('firm_boundary').jump);
        expect(rise(p('hostile'))).toBeGreaterThan(rise(p('firm_boundary')));
        // a clear refusal provokes more than a soft one (woerner_2018), and a friendly answer least
        expect(p('firm_boundary').jump).toBeGreaterThan(p('polite_deflect').jump);
        expect(rise(p('polite_deflect'))).toBeGreaterThan(rise(p('engage')));
        // turning to others or threatening attention is likeliest to end it (fleetwood_2019, ssh_2014)
        expect(p('seek_help').leave).toBeGreaterThan(p('threaten_attention').leave);
        expect(p('threaten_attention').leave).toBeGreaterThan(p('firm_boundary').leave);
        // a friendly answer almost never ends it (psypost_walton_2021)
        expect(p('engage').leave).toBeLessThan(p('ignore').leave);
      }
  });

  it('his disposition nudges the odds in the right direction without overturning the row', () => {
    for (const s of WOMAN_STRATEGIES)
      for (let level = 1; level < 4; level++) {
        const mild = stepDistribution({ [s]: 1 }, lctx(level, 'mild'), PARAMS);
        const vol = stepDistribution({ [s]: 1 }, lctx(level, 'volatile'), PARAMS);
        expect(rise(vol), s).toBeGreaterThanOrEqual(rise(mild));
        expect(mild.leave, s).toBeGreaterThanOrEqual(vol.leave);
      }
  });

  it('an unsure reading blends the rows instead of picking an extreme', () => {
    const half = stepDistribution({ hostile: 0.5, engage: 0.5 }, lctx(2, 'persistent'), PARAMS);
    const hostile = stepDistribution({ hostile: 1 }, lctx(2, 'persistent'), PARAMS);
    const engage = stepDistribution({ engage: 1 }, lctx(2, 'persistent'), PARAMS);
    expect(rise(half)).toBeLessThan(rise(hostile));
    expect(rise(half)).toBeGreaterThan(rise(engage));
  });
});

describe('level 6 (physical) is rare and never early', () => {
  it('cannot be reached from below level 4, or before the minimum turn', () => {
    const minTurn = val(PARAMS, 'model.escalation.min_turn');
    for (const s of WOMAN_STRATEGIES)
      for (const d of DISPOSITIONS) {
        for (let level = 0; level < 4; level++) {
          const p = stepDistribution({ [s]: 1 }, lctx(level, d), PARAMS);
          // from 3, a jump lands on 5 at most
          expect(Math.max(...STEPS.filter((k) => p[k] > 0 && k !== 'leave').map((k) => applyStep(level, k)))).toBeLessThan(MAX_LEVEL);
        }
        const early = stepDistribution({ [s]: 1 }, lctx(5, d, { turn: minTurn - 2 }), PARAMS);
        expect(early.up, `${s} ${d}`).toBe(0);
      }
  });

  it('an insult is far likelier than anything else to push him over', () => {
    const insult = stepDistribution({ hostile: 1 }, lctx(5, 'persistent'), PARAMS).up;
    for (const s of WOMAN_STRATEGIES) if (s !== 'hostile') expect(stepDistribution({ [s]: 1 }, lctx(5, 'persistent'), PARAMS).up, s).toBeLessThan(insult);
  });
});

describe('the reported bug: "Hello" after his opening line', () => {
  /** His opening call-out, then she says hello (Clef reads it as friendly). */
  function helloOnce(seed: number): { state: WomanState; out: ReturnType<typeof decideWoman> } {
    const rng = new Rng(seed);
    let state = initialWomanState(drawDisposition(rng));
    state = decideWoman(state, { event: 'begin', ctx: ctx() }, rng).state;
    const out = decideWoman(state, { event: 'speech', ctx: ctx(), strategyProbs: { engage: 1 } }, rng);
    return { state, out };
  }

  it('he never walks away, turns hostile or jumps two levels', () => {
    let left = 0;
    for (let seed = 1; seed <= 10000; seed++) {
      const { state, out } = helloOnce(seed);
      expect(out.decision?.stance, `seed ${seed}`).not.toBe('hostile');
      expect(out.decision?.stance).not.toBe('intimidate');
      expect(out.decision?.stance).not.toBe('escalate');
      expect(out.level - state.level, `seed ${seed}`).toBeLessThanOrEqual(1);
      expect(out.level).toBeLessThanOrEqual(2);
      if (out.decision?.stance === 'back_off') left++;
    }
    // "rarely": a friendly answer almost never ends it (psypost_walton_2021)
    expect(left / 10000).toBeLessThan(0.05);
  });

  it('even when Clef is unsure (half friendly, half polite brush-off) he does not jump or turn hostile', () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const rng = new Rng(seed);
      let state = initialWomanState(drawDisposition(rng));
      state = decideWoman(state, { event: 'begin', ctx: ctx() }, rng).state;
      const out = decideWoman(state, { event: 'speech', ctx: ctx(), strategyProbs: { engage: 0.5, polite_deflect: 0.5 } }, rng);
      expect(out.decision?.stance).not.toBe('hostile');
      expect(out.level - state.level).toBeLessThanOrEqual(1);
    }
  });
});

describe('carrying on after a no', () => {
  it('is never "calm" or "interested": if he does not leave, he is at least pushy, and still never more than +2', () => {
    for (const s of ['polite_deflect', 'firm_boundary', 'hostile', 'excuse', 'threaten_attention', 'plead'] as WomanStrategy[])
      for (let seed = 1; seed <= 1500; seed++) {
        const rng = new Rng(seed);
        let state = initialWomanState(drawDisposition(rng));
        state = decideWoman(state, { event: 'begin', ctx: ctx() }, rng).state;
        const out = decideWoman(state, { event: 'speech', ctx: ctx(), strategyProbs: { [s]: 1 } }, rng);
        expect(out.level - state.level, `${s} ${seed}`).toBeLessThanOrEqual(2);
        if (out.decision?.stance !== 'back_off') expect(out.level, `${s} ${seed}`).toBeGreaterThanOrEqual(2);
      }
  });
});

describe('once he is worked up', () => {
  it('he is less likely to just walk off the higher he is, whatever she says', () => {
    for (const st of ['polite_deflect', 'firm_boundary', 'excuse', 'plead', 'engage'] as WomanStrategy[])
      for (const d of DISPOSITIONS) {
        const at = (level: number) => stepDistribution({ [st]: 1 }, lctx(level, d, { encounterSeconds: 90 }), PARAMS).leave;
        expect(at(3), `${st} ${d}`).toBeLessThan(at(2));
        expect(at(4), `${st} ${d}`).toBeLessThan(at(3));
      }
  });
});

describe('his face after a no', () => {
  it('is never friendly or smirking when she has just refused him', () => {
    for (const st of ['firm_boundary', 'polite_deflect', 'hostile'] as WomanStrategy[])
      for (let seed = 1; seed <= 800; seed++) {
        const rng = new Rng(seed);
        let state = initialWomanState(drawDisposition(rng));
        state = decideWoman(state, { event: 'begin', ctx: ctx() }, rng).state;
        const out = decideWoman(state, { event: 'speech', ctx: ctx(), strategyProbs: { [st]: 1 } }, rng);
        expect(['friendly', 'smirk', 'leer', 'sheepish'], `${st} ${seed}`).not.toContain(out.decision?.emotion);
      }
  });
});

describe('he wants more as it goes on', () => {
  it('a friendly answer pushes him a little more with every exchange, but never two levels at once', () => {
    const early = stepDistribution({ engage: 1 }, lctx(1, 'persistent', { exchanges: 0 }), PARAMS);
    const late = stepDistribution({ engage: 1 }, lctx(1, 'persistent', { exchanges: 10 }), PARAMS);
    expect(late.up).toBeGreaterThan(early.up);
    expect(late.jump).toBe(0);
    expect(late.leave).toBeCloseTo(early.leave, 9);
  });

  it('a long friendly chat drifts into pressure in a good share of runs, and rarely into anger', () => {
    let pushy = 0;
    let angry = 0;
    const n = 3000;
    for (let seed = 0; seed < n; seed++) {
      const run = simulateWoman('engage', 5000 + seed);
      if (run.peakLevel >= 2) pushy++;
      if (run.peakLevel >= 4) angry++;
    }
    expect(pushy / n).toBeGreaterThan(0.35);
    expect(angry / n).toBeLessThan(0.2);
  });
});

describe('every level has a name and a direction for the line writer', () => {
  it('covers 0..6', () => {
    expect(LEVELS.map((l) => l.level)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    for (const l of LEVELS) expect(l.direction.length).toBeGreaterThan(20);
  });
});
