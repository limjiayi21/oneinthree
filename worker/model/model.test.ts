import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ManStance, WomanStrategy, WorldContext } from '../../shared/types';
import { blendIntervention, decideBystander, initialBystanderState, interventionPrior, TACTIC_KEYS } from './bystander';
import { EVIDENCE, PARAMS, evidenceKeys, param, paramKeys, val } from './params';
import { Rng } from './rng';
import { REALISTIC_MIX, simulateBystander, simulateWoman, tallyBystander, tallyWoman, type BystanderPolicy, type WomanPolicy } from './simulate';
import {
  DISPOSITIONS,
  REACTION_CLASSES,
  ROW_KEYS,
  WOMAN_STRATEGIES,
  baseRow,
  blendWithReading,
  classDistribution,
  decideWoman,
  dispositionWeights,
  initialWomanState,
  type ReactionClass,
  type WomanState,
} from './woman';

const N = 4000;
const SEED = 20261112;
const sum = (o: Record<string, number | undefined>) => Object.values(o).reduce<number>((s, v) => s + (v ?? 0), 0);
const oneHot = (s: WomanStrategy) => Object.fromEntries(WOMAN_STRATEGIES.map((k) => [k, k === s ? 1 : 0])) as Record<WomanStrategy, number>;
const ctx = (over: Partial<WorldContext> = {}): WorldContext => ({
  elapsed: 40,
  distanceToMan: 1.5,
  progress: 0.4,
  playerSpeed: 1.4,
  facingMan: false,
  manBlocking: false,
  oppositeSidewalk: false,
  ...over,
});

/** Exact first-response reaction shares, averaged over the dispositions. */
function firstResponse(strategy: WomanStrategy): Record<ReactionClass, number> {
  const w = dispositionWeights();
  const m: Record<ReactionClass, number> = { back_off: 0, persist: 0, hostile: 0, intimidate: 0 };
  for (const d of DISPOSITIONS) {
    const c = classDistribution(oneHot(strategy), { disposition: d, exchanges: 0, frustration: 0, stance: 'opening', encounterSeconds: 0, across: false, far: false });
    for (const k of REACTION_CLASSES) m[k] += w[d] * c[k];
  }
  return m;
}

describe('parameter table', () => {
  it('labels every parameter and cites only sources that exist', () => {
    const evidencePopulated = EVIDENCE.modelCalibration.parameters.length > 0;
    for (const key of paramKeys()) {
      const p = param(PARAMS, key);
      expect(Number.isFinite(p.value), key).toBe(true);
      expect(['data', 'inferred', 'assumption'], key).toContain(p.basis);
      expect(p.rationale.length, key).toBeGreaterThan(10);
      for (const s of p.sourceIds) expect(EVIDENCE.sources[s], `${key} cites ${s}`).toBeDefined();
      if (p.origin === 'model') expect(p.basis, `${key}: a model knob may not claim to be data`).toBe('assumption');
      if (p.range) {
        expect(p.range[0], key).toBeLessThanOrEqual(p.value);
        expect(p.range[1], key).toBeGreaterThanOrEqual(p.value);
      }
    }
    if (evidencePopulated) {
      for (const key of evidenceKeys()) expect(param(PARAMS, key).origin, `${key} should be read from evidence.json`).toBe('evidence');
    }
  });

  it('never presents a response -> reaction probability as data', () => {
    for (const s of WOMAN_STRATEGIES) for (const c of REACTION_CLASSES) expect(param(PARAMS, ROW_KEYS[s][c]).basis).not.toBe('data');
  });
});

describe('documentation', () => {
  it('writes the full parameter table into docs/DECISION_MODEL.md', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const file = resolve(here, '../../docs/DECISION_MODEL.md');
    if (!existsSync(file)) return;
    const all = paramKeys().map((k) => param(PARAMS, k));
    const count = (list: typeof all, basis: string) => list.filter((p) => p.basis === basis).length;
    const fromEvidence = all.filter((p) => p.origin === 'evidence');
    const own = all.filter((p) => p.origin === 'model');
    const cell = (text: string) => text.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
    const rows = (list: typeof all) =>
      list.map((p) => `| \`${p.key}\` | ${p.value} | ${p.range ? `${p.range[0]} to ${p.range[1]}` : ''} | ${p.basis} | ${cell(p.rationale)} | ${p.sourceIds.join(', ')} |`);
    const lines = [
      `${all.length} parameters: ${count(all, 'data')} data, ${count(all, 'inferred')} inferred, ${count(all, 'assumption')} assumption.`,
      '',
      `Read from content/evidence.json (${fromEvidence.length} of its ${EVIDENCE.modelCalibration.parameters.length} calibration parameters are used by the model): ${count(fromEvidence, 'data')} data, ${count(fromEvidence, 'inferred')} inferred, ${count(fromEvidence, 'assumption')} assumption. The model's own knobs (${own.length}): all assumption.`,
      '',
      '### Parameters read from content/evidence.json',
      '',
      '| Key | Value | Range | Basis | Rationale (from the research) | Sources |',
      '|---|---|---|---|---|---|',
      ...rows(fromEvidence),
      '',
      "### The model's own parameters (all assumptions)",
      '',
      '| Key | Value | Range | Basis | Rationale | Sources |',
      '|---|---|---|---|---|---|',
      ...rows(own),
    ];
    const doc = readFileSync(file, 'utf8');
    const start = '<!-- PARAMS:START -->';
    const end = '<!-- PARAMS:END -->';
    const a = doc.indexOf(start);
    const b = doc.indexOf(end);
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    const next = `${doc.slice(0, a + start.length)}\n${lines.join('\n')}\n${doc.slice(b)}`;
    if (next !== doc) writeFileSync(file, next);
    expect(all.length).toBeGreaterThan(80);
  });
});

describe('transition rows', () => {
  it('every researched row sums to 1 and its raw shares are close to 1 before normalising', () => {
    for (const s of WOMAN_STRATEGIES) {
      expect(sum(baseRow(s))).toBeCloseTo(1, 9);
      const raw = REACTION_CLASSES.reduce((t, c) => t + val(PARAMS, ROW_KEYS[s][c]), 0);
      expect(raw, s).toBeGreaterThan(0.9);
      expect(raw, s).toBeLessThan(1.1);
    }
  });

  it('every reaction-class distribution sums to 1 whatever has built up', () => {
    for (const s of WOMAN_STRATEGIES)
      for (const d of DISPOSITIONS)
        for (const stance of ['opening', 'persist', 'block', 'hostile', 'intimidate'] as ManStance[])
          for (const frustration of [0, 0.5, 1])
            for (const exchanges of [0, 1, 4])
              for (const seconds of [0, 90, 300]) {
                const c = classDistribution(oneHot(s), { disposition: d, exchanges, frustration, stance, encounterSeconds: seconds, across: seconds > 100, far: false });
                expect(sum(c)).toBeCloseTo(1, 9);
                for (const k of REACTION_CLASSES) expect(c[k]).toBeGreaterThanOrEqual(0);
              }
  });

  it('every next-stance distribution the model samples from sums to 1', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 3000; i++) {
      const state: WomanState = {
        ...initialWomanState(rng.pick(DISPOSITIONS)),
        stance: rng.pick<ManStance>(['opening', 'persist', 'follow', 'block', 'guilt', 'hostile', 'intimidate']),
        turn: 1 + Math.floor(rng.next() * 8),
        exchanges: Math.floor(rng.next() * 8),
        insults: Math.floor(rng.next() * 3),
        frustration: rng.next(),
        blocks: Math.floor(rng.next() * 3),
        startedAt: 10,
      };
      const strategy = rng.pick(WOMAN_STRATEGIES);
      const reading = rng.chance(0.5) ? { back_off: rng.next(), persist: rng.next(), guilt: rng.next(), follow: rng.next(), block: rng.next(), hostile: rng.next(), intimidate: rng.next() } : undefined;
      const out = decideWoman(state, { event: 'speech', ctx: ctx({ elapsed: 10 + rng.next() * 150, distanceToMan: 0.8 + rng.next() * 8, playerSpeed: rng.next() * 2.5, oppositeSidewalk: rng.chance(0.2) }), strategyProbs: { [strategy]: 0.7, unclear: 0.3 }, reaction: reading }, rng);
      expect(sum(out.stanceProbs)).toBeGreaterThan(0.99);
      expect(sum(out.stanceProbs)).toBeLessThan(1.01);
      expect(sum(out.priorProbs)).toBeGreaterThan(0.99);
      expect(sum(out.priorProbs)).toBeLessThan(1.01);
      expect(out.decision).not.toBeNull();
      expect(out.rationale?.text.length).toBeGreaterThan(10);
    }
  });

  it("her first response: the disposition-weighted reaction shares sit inside every researched range", () => {
    for (const s of WOMAN_STRATEGIES) {
      const m = firstResponse(s);
      for (const c of REACTION_CLASSES) {
        const p = param(PARAMS, ROW_KEYS[s][c]);
        if (p.origin !== 'evidence' || !p.range) continue;
        expect(m[c], `${p.key} = ${m[c].toFixed(3)}`).toBeGreaterThanOrEqual(p.range[0]);
        expect(m[c], `${p.key} = ${m[c].toFixed(3)}`).toBeLessThanOrEqual(p.range[1]);
      }
    }
  });

  it('keeps the orderings the research does support', () => {
    const hostility = (s: WomanStrategy) => firstResponse(s).hostile + firstResponse(s).intimidate;
    for (const s of WOMAN_STRATEGIES) if (s !== 'hostile') expect(hostility('hostile'), `insults vs ${s}`).toBeGreaterThan(hostility(s));
    for (const s of WOMAN_STRATEGIES) if (s !== 'engage') expect(firstResponse('engage').persist, `engage vs ${s}`).toBeGreaterThan(firstResponse(s).persist);
    for (const s of WOMAN_STRATEGIES) if (s !== 'seek_help') expect(firstResponse('seek_help').back_off, `refuge vs ${s}`).toBeGreaterThan(firstResponse(s).back_off);
    expect(hostility('firm_boundary')).toBeGreaterThan(hostility('polite_deflect'));
  });
});

describe('determinism and bounds', () => {
  it('replays exactly under a fixed seed', () => {
    for (const policy of ['mixed', 'hostile', 'engage'] as WomanPolicy[]) {
      for (let i = 0; i < 50; i++) expect(simulateWoman(policy, 1000 + i)).toEqual(simulateWoman(policy, 1000 + i));
    }
    for (let i = 0; i < 50; i++) expect(simulateBystander('aggressive', 500 + i)).toEqual(simulateBystander('aggressive', 500 + i));
    const a = Array.from({ length: 40 }, (_, i) => simulateWoman('mixed', i).stances.join('>'));
    expect(new Set(a).size).toBeGreaterThan(5);
  });

  it('always opens with a call-out', () => {
    for (let i = 0; i < 300; i++) {
      const r = simulateWoman('mixed', 9000 + i);
      expect(r.stances[0]).toBe('opening');
    }
    const out = decideWoman(initialWomanState('persistent'), { event: 'begin', ctx: ctx() }, new Rng(1));
    expect(out.decision?.stance).toBe('opening');
    expect(out.delivery).toBe('call_out');
    expect(out.speak).toBe(true);
  });

  it('cannot become physical before the minimum turn, whatever she does', () => {
    const minTurn = val(PARAMS, 'model.escalation.min_turn');
    expect(minTurn).toBeGreaterThanOrEqual(4);
    const rng = new Rng(99);
    for (let i = 0; i < 4000; i++) {
      // the worst case: a volatile man who is already hostile, has been insulted, and is right next to her
      const state: WomanState = { ...initialWomanState('volatile'), stance: rng.pick<ManStance>(['hostile', 'intimidate', 'opening', 'persist']), turn: 1 + Math.floor(rng.next() * (minTurn - 2)), exchanges: 1, insults: 3, frustration: 1, startedAt: 0 };
      const out = decideWoman(state, { event: 'speech', ctx: ctx({ distanceToMan: 0.7 }), strategyProbs: { hostile: 1 }, signals: { insult: 1, tone: 1 }, reaction: { hostile: 0.5, intimidate: 0.5 } }, rng);
      expect(out.stanceProbs.escalate ?? 0).toBe(0);
      expect(out.decision?.stance).not.toBe('escalate');
    }
    for (const policy of ['mixed', 'hostile', 'firm_boundary'] as WomanPolicy[]) {
      const t = tallyWoman(policy, 3000, 4242);
      if (t.earliestEscalationTurn !== null) expect(t.earliestEscalationTurn).toBeGreaterThanOrEqual(minTurn);
    }
  });

  it('only a man who is already hostile can become physical, and never from across the street at full odds', () => {
    const rng = new Rng(5);
    for (let i = 0; i < 500; i++) {
      const calm: WomanState = { ...initialWomanState('volatile'), stance: 'persist', turn: 9, exchanges: 8, insults: 3, frustration: 1, startedAt: 0 };
      expect(decideWoman(calm, { event: 'speech', ctx: ctx(), strategyProbs: { hostile: 1 } }, rng).stanceProbs.escalate ?? 0).toBe(0);
    }
    const hot: WomanState = { ...initialWomanState('volatile'), stance: 'intimidate', turn: 9, exchanges: 8, insults: 3, frustration: 1, startedAt: 0 };
    const near = decideWoman(hot, { event: 'speech', ctx: ctx({ distanceToMan: 0.8 }), strategyProbs: { hostile: 1 } }, new Rng(1)).priorProbs.escalate ?? 0;
    const far = decideWoman(hot, { event: 'speech', ctx: ctx({ distanceToMan: 12, oppositeSidewalk: true }), strategyProbs: { hostile: 1 } }, new Rng(1)).priorProbs.escalate ?? 0;
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThanOrEqual(val(PARAMS, 'model.escalation.cap'));
    expect(far).toBeLessThan(near);
  });

  it('every session ends: he gives up by the time limit even if she never moves', () => {
    const limit = val(PARAMS, 'model.session.max_seconds');
    for (const policy of ['stand_still', 'engage', 'mixed', 'hostile'] as WomanPolicy[]) {
      const t = tallyWoman(policy, 2000, 31337);
      expect(t.outcomes.exited ?? 0, policy).toBe(0);
      expect(t.maxSeconds, policy).toBeLessThanOrEqual(limit + 15);
    }
    for (const policy of ['distract', 'direct', 'aggressive', 'delegate', 'film_close', 'stand_between', 'nothing'] as BystanderPolicy[]) {
      const t = tallyBystander(policy, 2000, 31337);
      expect(t.outcomes.exited ?? 0, policy).toBe(0);
      expect(t.maxTurns, policy).toBeLessThanOrEqual(12);
    }
  });

  it('the scene-ending places resolve as the client expects', () => {
    const base: WomanState = { ...initialWomanState('persistent'), stance: 'follow', turn: 4, exchanges: 3, startedAt: 0 };
    expect(decideWoman(base, { event: 'reached_home', ctx: ctx({ distanceToMan: 3 }) }, new Rng(1)).outcome).toBe('reached_home_followed');
    expect(decideWoman(base, { event: 'reached_home', ctx: ctx({ distanceToMan: 40 }) }, new Rng(1)).outcome).toBe('reached_home_alone');
    expect(decideWoman({ ...base, stance: 'gone' }, { event: 'reached_home', ctx: ctx({ distanceToMan: 99 }) }, new Rng(1)).outcome).toBe('reached_home_alone');
    expect(decideWoman(base, { event: 'entered_shop', ctx: ctx() }, new Rng(1)).outcome).toBe('took_refuge');
    // giving up: a parting line, then gone on the next beat, and no outcome for either
    const leaving = decideWoman({ ...base, stance: 'back_off' }, { event: 'silence', ctx: ctx() }, new Rng(1));
    expect(leaving.decision?.stance).toBe('gone');
    expect(leaving.decision?.action).toBe('leave');
    expect(leaving.outcome).toBeUndefined();
    expect(leaving.speak).toBe(false);
    expect(decideWoman(leaving.state, { event: 'silence', ctx: ctx() }, new Rng(1)).decision).toBeNull();
  });
});

describe("blending in Clef's reading", () => {
  it('moves the odds toward the reading, but only inside the band the research allows, and never touches escalation', () => {
    const prior: Partial<Record<ManStance, number>> = { back_off: 0.4, persist: 0.1, guilt: 0.05, follow: 0.05, block: 0.03, hostile: 0.27, intimidate: 0.02, escalate: 0.08 };
    const towardsHostile = blendWithReading(prior, { hostile: 0.9, back_off: 0.02, persist: 0.02, guilt: 0.02, follow: 0.02, block: 0.01, intimidate: 0.01 }, 'firm_boundary');
    expect(sum(towardsHostile)).toBeCloseTo(1, 6);
    expect(towardsHostile.escalate).toBeCloseTo(0.08, 9);
    expect(towardsHostile.hostile!).toBeGreaterThan(prior.hostile!);
    expect(towardsHostile.back_off!).toBeLessThan(prior.back_off!);
    // response.firm_boundary.p_verbal_hostility: value 0.30, range 0.15..0.40 -> at most x1.33 (plus renormalisation slack)
    const p = param(PARAMS, 'response.firm_boundary.p_verbal_hostility');
    const hi = p.range ? p.range[1] / p.value : 1.4;
    expect(towardsHostile.hostile! / prior.hostile!).toBeLessThanOrEqual(hi * 1.12);
    expect(blendWithReading(prior, undefined, 'firm_boundary')).toEqual(prior);
  });

  it('holds bystander odds inside their researched ranges', () => {
    const prior = interventionPrior('direct', false);
    const post = blendIntervention(prior, { stops: 0.02, turns: 0.96, continues: 0.02 }, 'direct');
    expect(sum(post)).toBeCloseTo(1, 9);
    const turns = param(PARAMS, TACTIC_KEYS.direct.turns);
    expect(post.turns).toBeGreaterThan(prior.turns);
    expect(post.turns).toBeLessThanOrEqual((turns.range?.[1] ?? 0.4) * 1.12);
  });
});

describe('Monte Carlo: outcome rates stay inside the calibrated ranges', () => {
  const policies: WomanPolicy[] = ['mixed', 'ignore', 'polite_deflect', 'firm_boundary', 'hostile', 'excuse', 'threaten_attention', 'engage', 'plead', 'shop', 'stand_still'];
  const woman = Object.fromEntries(policies.map((p) => [p, tallyWoman(p, N, SEED)])) as Record<WomanPolicy, ReturnType<typeof tallyWoman>>;
  const bPolicies: BystanderPolicy[] = ['nothing', 'distract', 'direct', 'direct_then_checks_in', 'aggressive', 'delegate', 'film_close', 'stand_between'];
  const bystander = Object.fromEntries(bPolicies.map((p) => [p, tallyBystander(p, N, SEED)])) as Record<BystanderPolicy, ReturnType<typeof tallyBystander>>;
  const escalation = param(PARAMS, 'base.physical_escalation_per_run');
  const [escLo, escHi] = escalation.range ?? [0, 0.05];

  it('physical escalation is rare: inside the researched range for a realistic mix of responses', () => {
    expect(woman.mixed.escalated).toBeGreaterThanOrEqual(escLo);
    expect(woman.mixed.escalated).toBeLessThanOrEqual(escHi);
    expect(woman.mixed.escalated).toBeGreaterThan(0.002); // it has to be possible, or the uncertainty is fake
    // a population of players each sticking to one response, weighted by how often women use it
    let weighted = 0;
    for (const s of WOMAN_STRATEGIES) weighted += REALISTIC_MIX[s] * (s === 'seek_help' ? woman.shop.escalated : s === 'unclear' ? woman.mixed.escalated : woman[s].escalated);
    expect(weighted).toBeLessThanOrEqual(escHi);
    for (const p of policies) if (p !== 'hostile') expect(woman[p].escalated, p).toBeLessThanOrEqual(escHi);
  });

  it('sustained insults are the riskiest response, and still mostly do not end in violence', () => {
    for (const p of ['ignore', 'polite_deflect', 'firm_boundary', 'excuse', 'threaten_attention', 'engage', 'plead'] as WomanPolicy[]) {
      expect(woman.hostile.escalated, `hostile vs ${p}`).toBeGreaterThan(woman[p].escalated);
      expect(woman.hostile.everHostile, `hostile vs ${p}`).toBeGreaterThan(woman[p].everHostile);
    }
    expect(woman.hostile.escalated).toBeLessThanOrEqual(0.09);
    expect(woman.firm_boundary.everHostile).toBeGreaterThan(woman.polite_deflect.everHostile);
  });

  it('no response reliably works, and none reliably fails', () => {
    for (const p of ['ignore', 'polite_deflect', 'firm_boundary', 'hostile', 'excuse', 'threaten_attention', 'engage', 'plead'] as WomanPolicy[]) {
      expect(woman[p].heLeft, p).toBeLessThan(0.97);
      expect(woman[p].heLeft, p).toBeGreaterThan(0.5);
      expect(woman[p].everHostile, p).toBeGreaterThan(0.1);
    }
  });

  it('giving up with a parting remark is the commonest ending; friendly answers prolong it; the shop ends it', () => {
    expect(woman.mixed.outcomes.reached_home_alone ?? 0).toBeGreaterThan(0.6);
    expect(woman.mixed.heLeft).toBeGreaterThan(0.6);
    for (const p of policies) if (p !== 'engage' && p !== 'stand_still') expect(woman.engage.meanExchanges, p).toBeGreaterThan(woman[p].meanExchanges);
    expect(woman.shop.outcomes.took_refuge ?? 0).toBeGreaterThan(0.6);
    expect(woman.shop.escalated).toBe(0);
  });

  it('following and blocking are common but not the rule: most encounters stay verbal', () => {
    expect(woman.mixed.everFollowOrBlock).toBeGreaterThan(0.15);
    // self-selected incident archives give an upper bound for interference with her movement
    expect(woman.mixed.everFollowOrBlock).toBeLessThan(val(PARAMS, 'base.incident_involves_path_interference') + 0.05);
    const verbal = param(PARAMS, 'base.encounter_stays_verbal_only');
    const [lo, hi] = verbal.range ?? [0.55, 0.85];
    expect(woman.mixed.verbalOnly).toBeGreaterThanOrEqual(lo);
    expect(woman.mixed.verbalOnly).toBeLessThanOrEqual(hi);
  });

  it('bystander: first reactions match the researched odds for each tactic', () => {
    const check = (policy: BystanderPolicy, tactic: keyof typeof TACTIC_KEYS) => {
      const stops = param(PARAMS, TACTIC_KEYS[tactic].stops);
      const turns = param(PARAMS, TACTIC_KEYS[tactic].turns);
      const t = bystander[policy];
      const acted = 1 - t.first.none;
      expect(t.first.stops / acted, `${policy} stops`).toBeGreaterThanOrEqual((stops.range?.[0] ?? stops.value - 0.15) - 0.02);
      expect(t.first.stops / acted, `${policy} stops`).toBeLessThanOrEqual((stops.range?.[1] ?? stops.value + 0.15) + 0.02);
      expect(t.first.turns / acted, `${policy} turns`).toBeGreaterThanOrEqual((turns.range?.[0] ?? turns.value - 0.15) - 0.02);
      expect(t.first.turns / acted, `${policy} turns`).toBeLessThanOrEqual((turns.range?.[1] ?? turns.value + 0.15) + 0.02);
    };
    check('distract', 'distract');
    check('direct', 'direct');
    check('aggressive', 'aggressive');
    check('delegate', 'delegate');
    check('film_close', 'document');
    check('stand_between', 'physical');
  });

  it('bystander: indirect tactics are low-risk, Direct is riskier, aggression is riskiest, and harm stays rare', () => {
    expect(bystander.distract.turned).toBeLessThan(bystander.direct.turned);
    expect(bystander.delegate.turned).toBeLessThan(bystander.direct.turned);
    expect(bystander.direct.turned).toBeLessThan(bystander.aggressive.turned);
    const esc = (p: BystanderPolicy) => bystander[p].outcomes.intervened_escalated ?? 0;
    expect(esc('distract')).toBeLessThanOrEqual(0.01);
    expect(esc('delegate')).toBeLessThanOrEqual(0.01);
    expect(esc('direct')).toBeLessThanOrEqual(0.02);
    expect(esc('aggressive')).toBeGreaterThan(esc('direct'));
    expect(esc('aggressive')).toBeLessThanOrEqual(0.1);
    const none = bystander.nothing.outcomes.no_intervention_escalated ?? 0;
    expect(none).toBeGreaterThanOrEqual(escLo);
    expect(none).toBeLessThanOrEqual(escHi);
    expect(bystander.nothing.outcomes.no_intervention_she_escaped ?? 0).toBeGreaterThan(0.9);
    // every intervention that registers ends with her away from him
    for (const p of ['distract', 'direct', 'delegate', 'stand_between'] as BystanderPolicy[]) {
      const o = bystander[p].outcomes;
      expect((o.intervened_he_left ?? 0) + (o.intervened_she_safe ?? 0), p).toBeGreaterThan(0.97);
    }
  });

  it('bystander: cannot turn physical in the first couple of exchanges, and Delay only exists after he has gone', () => {
    const rng = new Rng(3);
    for (let i = 0; i < 2000; i++) {
      let state = initialBystanderState();
      const c = { ...ctx({ distanceToMan: 2 }), distanceToWoman: 2, lookingAt: 'man' as const, beat: 'hostile' };
      const first = decideBystander(state, { event: 'speech', ctx: c, strategyProbs: { aggressive: 1 }, target: 'man', signals: { threat: 1, insult: 1 } }, rng);
      expect(first.outcome).toBeUndefined();
      state = first.state;
      const second = decideBystander(state, { event: 'speech', ctx: c, strategyProbs: { aggressive: 1 }, target: 'man', signals: { threat: 1, insult: 1 } }, rng);
      expect(second.outcome).not.toBe('intervened_escalated');
    }
    const early = decideBystander(initialBystanderState(), { event: 'speech', ctx: { ...ctx(), distanceToWoman: 2, lookingAt: 'woman', beat: 'deflect' }, strategyProbs: { delay: 1 }, target: 'woman' }, new Rng(2));
    expect(early.strategy).toBe('direct');
    expect(early.man).not.toBeNull();
  });

  it('writes the simulation table', () => {
    const pct = (v: number | undefined) => `${((v ?? 0) * 100).toFixed(1)}%`;
    const lines: string[] = [];
    lines.push('# Decision model: Monte Carlo simulation');
    lines.push('');
    lines.push(`Generated by \`npm test\` (worker/model/model.test.ts): ${N} simulated encounters per policy, seed ${SEED}, no network. The simulated player repeats one kind of response on every exchange ("mixed" draws a new one each time from a realistic spread); the walk home takes 50 to 85 seconds past him, one exchange about nine seconds. Evidence table read from content/evidence.json with ${EVIDENCE.modelCalibration.parameters.length} calibration parameters.`);
    lines.push('');
    lines.push('Every "she did X, he did Y" probability behind these numbers is an assumption: no study measures how street harassers react to specific responses. The tests assert the rates stay inside the ranges the research gives; they do not make the rates true.');
    lines.push('');
    lines.push("## Part 1: her walk home");
    lines.push('');
    lines.push('| Her response (every exchange) | He gave up, home alone | Home, still followed | Took refuge | Physical escalation | He turned verbally hostile | Close-range menace | Followed or blocked | Stayed verbal only | Exchanges (mean) | Encounter seconds (mean / max) |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const p of policies) {
      const t = woman[p];
      const alone = (t.outcomes.reached_home_alone ?? 0) + (t.outcomes.he_left ?? 0);
      lines.push(`| ${p} | ${pct(alone)} | ${pct(t.outcomes.reached_home_followed)} | ${pct(t.outcomes.took_refuge)} | ${pct(t.escalated)} | ${pct(t.everHostile)} | ${pct(t.everIntimidate)} | ${pct(t.everFollowOrBlock)} | ${pct(t.verbalOnly)} | ${t.meanExchanges.toFixed(1)} | ${t.meanSeconds.toFixed(0)} / ${t.maxSeconds.toFixed(0)} |`);
    }
    lines.push('');
    lines.push(`"shop" = says nothing, then walks into the shop after two or three exchanges. "stand_still" = never moves and never speaks (tests the time limit). Physical escalation for the realistic mix must stay inside ${escLo}..${escHi} (base.physical_escalation_per_run, basis: ${escalation.basis}); "stayed verbal only" (no following, blocking or contact) must stay inside the range of base.encounter_stays_verbal_only.`);
    lines.push('');
    lines.push('### Her first response: reaction shares against the researched ranges');
    lines.push('');
    lines.push('Exact (not sampled): the disposition-weighted distribution of his reaction to her first response.');
    lines.push('');
    lines.push('| Her first response | Gives up | Keeps going | Verbal hostility | Menace |');
    lines.push('|---|---|---|---|---|');
    for (const s of WOMAN_STRATEGIES) {
      const m = firstResponse(s);
      const cell = (c: ReactionClass) => {
        const p = param(PARAMS, ROW_KEYS[s][c]);
        return p.origin === 'evidence' && p.range ? `${pct(m[c])} (range ${p.range[0]}..${p.range[1]})` : pct(m[c]);
      };
      lines.push(`| ${s} | ${cell('back_off')} | ${cell('persist')} | ${cell('hostile')} | ${cell('intimidate')} |`);
    }
    lines.push('');
    lines.push('## Part 2: the bystander');
    lines.push('');
    lines.push('| What the bystander does | He left | She got away | Escalated at bystander | Nobody intervened: she escaped | Nobody intervened: escalated | First reaction: stops / turns on bystander / brushes off | He ever turned on the bystander |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const p of bPolicies) {
      const t = bystander[p];
      const o = t.outcomes;
      const acted = 1 - t.first.none;
      const first = acted > 0 ? `${pct(t.first.stops / acted)} / ${pct(t.first.turns / acted)} / ${pct(t.first.continues / acted)}` : 'n/a';
      lines.push(`| ${p} | ${pct(o.intervened_he_left)} | ${pct(o.intervened_she_safe)} | ${pct(o.intervened_escalated)} | ${pct(o.no_intervention_she_escaped)} | ${pct(o.no_intervention_escalated)} | ${first} | ${pct(t.turned)} |`);
    }
    lines.push('');
    lines.push('"aggressive" keeps threatening or insulting him on every exchange. "film_close" raises a phone three metres away and does nothing else: he does not always notice, and when he does not the scripted scene runs to its end. "direct_then_checks_in" speaks to her after he has gone (Delay).');
    lines.push('');
    const here = dirname(fileURLToPath(import.meta.url));
    const file = resolve(here, '../../docs/research/model-simulation.md');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, lines.join('\n'));
    expect(lines.length).toBeGreaterThan(20);
  });
});
