/**
 * His escalation ladder, 0 (calm, friendly) to 6 (threatening; the scene ends).
 *
 * Each time she responds, he takes one step: down one level, stay, up one,
 * up two (never more), or he leaves. The odds of each step come from one row
 * per kind of response (her words as Clef reads them, or what she did), are
 * nudged by his disposition, by how high he already is and by how long this
 * has gone on, and every row cites the research behind its direction.
 *
 * Honest limits, also printed in docs/DECISION_MODEL.md: no study measures how
 * a street harasser reacts, step by step, to a particular response. What the
 * research does give is the direction of each effect (a friendly answer
 * prolongs it, an insult is the riskiest answer, about a third of men react
 * aggressively to a clear sexual refusal in the lab, ignoring sometimes angers)
 * and how incidents end overall (most stay verbal; following, blocking and
 * contact are minorities). The row magnitudes are assumptions, tuned so the
 * Monte Carlo outcome rates land inside those researched ranges (see
 * worker/model/model.test.ts and docs/research/model-simulation.md).
 */
import type { ManStance, WomanStrategy } from '../../shared/types';
import { val, type Params } from './params';
import { clamp01 } from './rng';

export const MAX_LEVEL = 6;

export { LEVELS, type LevelInfo } from '../../shared/levels';

export type Step = 'down' | 'stay' | 'up' | 'jump' | 'leave';
export const STEPS: Step[] = ['down', 'stay', 'up', 'jump', 'leave'];
/** Level change for each step ('leave' ends the ladder). */
export const STEP_DELTA: Record<Exclude<Step, 'leave'>, number> = { down: -1, stay: 0, up: 1, jump: 2 };

export const ladderKey = (strategy: WomanStrategy, step: Step): string => `model.ladder.${strategy}.${step}`;

export interface LadderContext {
  level: number;
  disposition: 'mild' | 'persistent' | 'volatile';
  /** Decisions so far (his opening is 1). Level 6 is never reached before model.escalation.min_turn. */
  turn: number;
  encounterSeconds: number;
  /** She is across the street or far away: harder for him to escalate, easier to drop it. */
  distant: boolean;
  /** Responses of hers he has already reacted to. The longer it goes on without him getting what he wants, the more he pushes. */
  exchanges?: number;
}

/**
 * The step distribution for one response. `strategyProbs` is Clef's reading
 * (or a certain event); the rows are blended by it, so an unsure reading
 * gives a blended, less extreme reaction rather than a coin flip between rows.
 */
export function stepDistribution(
  strategyProbs: Partial<Record<WomanStrategy, number>>,
  ctx: LadderContext,
  params: Params,
): Record<Step, number> {
  const p: Record<Step, number> = { down: 0, stay: 0, up: 0, jump: 0, leave: 0 };
  let mass = 0;
  for (const [s, w] of Object.entries(strategyProbs) as [WomanStrategy, number][]) {
    if (!w || w <= 0) continue;
    mass += w;
    for (const step of STEPS) p[step] += w * val(params, ladderKey(s, step));
  }
  if (mass <= 0) return { down: 0, stay: 1, up: 0, jump: 0, leave: 0 };
  for (const step of STEPS) p[step] /= mass;

  // A friendly or unclear answer never makes him jump two levels, whatever his disposition; if it is even
  // half likely that she was being friendly, he does not jump either (a misheard "hello" must not set him off).
  const friendly = (strategyProbs.engage ?? 0) + (strategyProbs.unclear ?? 0);
  p.jump *= clamp01(1 - 2 * friendly);

  // His disposition nudges the row; it never decides it.
  const d = ctx.disposition;
  const mul = (step: Step, key: string) => (p[step] *= val(params, key));
  mul('up', `model.ladder.disposition.${d}.up`);
  mul('jump', `model.ladder.disposition.${d}.jump`);
  mul('down', `model.ladder.disposition.${d}.down`);
  mul('leave', `model.ladder.disposition.${d}.leave`);

  // He wants more as it goes on (her name, then her number, then to walk her home): with every exchange
  // that does not get it, more of "he carries on as he was" becomes "he pushes harder", even when she is
  // friendly or polite. Never a two-level jump on its own.
  const soft = ['engage', 'unclear', 'polite_deflect', 'excuse', 'plead'] as WomanStrategy[];
  const softShare = soft.reduce((a, s) => a + (strategyProbs[s] ?? 0), 0) / mass;
  const pressure =
    softShare * val(params, 'model.ladder.pressure_gain') * Math.min(1, Math.max(0, ctx.exchanges ?? 0) / val(params, 'model.ladder.pressure_exchanges'));
  if (ctx.level < 3 && pressure > 0) {
    const moved = p.stay * pressure;
    p.stay -= moved;
    p.up += moved;
  }

  // Once he is angry he is slower to calm down.
  if (ctx.level >= 4) p.down *= val(params, 'model.ladder.angry_calm_factor');
  // The more worked up he is, the less likely he simply walks off: from level 3 he feels slighted and wants to come out on top.
  if (ctx.level >= 3) p.leave *= Math.pow(val(params, 'model.ladder.invested_leave_factor'), ctx.level - 2);
  // He gets tired of it: the longer it drags on, the likelier he drops it (grows with the square of time).
  const softSeconds = val(params, 'model.session.soft_seconds');
  const t = Math.min(1, Math.max(0, ctx.encounterSeconds) / softSeconds);
  p.leave *= 1 + (val(params, 'model.dynamics.fatigue_gain') - 1) * t * t;
  if (ctx.distant) {
    p.up *= val(params, 'model.dynamics.far_factor');
    p.jump *= val(params, 'model.dynamics.far_factor');
    p.leave *= 1.5;
  }

  // Edges of the ladder.
  if (ctx.level <= 0) {
    p.stay += p.down;
    p.down = 0;
  }
  if (ctx.level >= MAX_LEVEL - 1) {
    p.up += p.jump;
    p.jump = 0;
  }

  // Level 6 (physical) is rare and never early: only from 4 or 5, only after the minimum turn,
  // and only a fraction of the steps that would land there do; the rest hold at 5.
  const landsOn6 = (step: Step) => ctx.level + STEP_DELTA[step as Exclude<Step, 'leave'>] >= MAX_LEVEL;
  const insult = clamp01(strategyProbs.hostile ?? 0);
  const crossFactor = insult + (1 - insult) * val(params, 'model.ladder.cross_non_insult_factor');
  const cross =
    ctx.level >= 4 && ctx.turn + 1 >= val(params, 'model.escalation.min_turn') ? val(params, 'model.ladder.cross_to_threat') * crossFactor : 0;
  for (const step of ['up', 'jump'] as const) {
    if (!landsOn6(step)) continue;
    const held = p[step] * (1 - cross);
    p[step] -= held;
    // Held back from 6: a jump becomes a single step to 5, a step from 5 stays at 5.
    if (step === 'jump' && ctx.level === 4) p.up += held;
    else p.stay += held;
  }

  let total = 0;
  for (const step of STEPS) total += Math.max(0, p[step]);
  const out = { down: 0, stay: 0, up: 0, jump: 0, leave: 0 } as Record<Step, number>;
  for (const step of STEPS) out[step] = Math.max(0, p[step]) / total;
  return out;
}

export function applyStep(level: number, step: Step): number {
  if (step === 'leave') return level;
  return Math.max(0, Math.min(MAX_LEVEL, level + STEP_DELTA[step]));
}

/** The opening level: a mild man starts calm, the others already pushy enough to call out. */
export function openingLevel(disposition: LadderContext['disposition']): number {
  return disposition === 'mild' ? 0 : 1;
}

export interface Body {
  moving: boolean;
  evading: boolean;
  stopped: boolean;
  across: boolean;
  distance: number;
}

/** What he does with his body at a level: drives the animation and which kind of line is written. */
export function stanceForLevel(level: number, body: Body, canBlock: boolean): ManStance {
  if (level >= MAX_LEVEL) return 'escalate';
  if (level === 5) {
    if (canBlock && !body.across && body.distance < 7) return 'block';
    if (body.moving || body.evading || body.distance > 3) return 'follow';
    return 'intimidate';
  }
  if (level === 4) return 'hostile';
  if (level === 3) return 'guilt';
  if (level === 2 && (body.moving || body.evading) && body.distance > 2.5) return 'follow';
  return 'persist';
}
