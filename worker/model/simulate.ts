/**
 * Offline simulation of whole encounters, used by the tests and to produce
 * docs/research/model-simulation.md. No network, no Worker: a scripted
 * "player" follows a policy and the decision model answers.
 *
 * The simulated walk is a stand-in for the 3D street: an exchange takes about
 * nine seconds, home is roughly a minute's walk past him, and being blocked
 * or stopping to talk costs time.
 */
import type { BystanderStrategy, ClientEventType, ManStance, OutcomeKind, SpeechTarget, WomanStrategy, WorldContext } from '../../shared/types';
import { decideBystander, initialBystanderState, type BystanderState } from './bystander';
import { PARAMS, type Params } from './params';
import { Rng } from './rng';
import { decideWoman, drawDisposition, initialWomanState, type Disposition, type WomanState } from './woman';

export type WomanPolicy = WomanStrategy | 'shop' | 'mixed' | 'stand_still';

export interface WomanRun {
  outcome: OutcomeKind;
  disposition: Disposition;
  exchanges: number;
  encounterSeconds: number;
  everHostile: boolean;
  everIntimidate: boolean;
  everFollow: boolean;
  everBlock: boolean;
  heLeft: boolean;
  escalationTurn: number | null;
  firstReaction: ManStance | null;
  stances: ManStance[];
}

/** A plausible mix of what women actually do, used only to draw a per-turn strategy for the 'mixed' policy. */
export const REALISTIC_MIX: Record<WomanStrategy, number> = {
  ignore: 0.4,
  polite_deflect: 0.14,
  firm_boundary: 0.18,
  hostile: 0.08,
  excuse: 0.07,
  threaten_attention: 0.04,
  seek_help: 0.03,
  engage: 0.03,
  plead: 0.02,
  unclear: 0.01,
};

function ctxFor(elapsed: number, distance: number, speed: number, blocking: boolean, progress: number): WorldContext {
  return {
    elapsed,
    distanceToMan: distance,
    progress,
    playerSpeed: speed,
    facingMan: false,
    manBlocking: blocking,
    oppositeSidewalk: false,
  };
}

export function simulateWoman(policy: WomanPolicy, seed: number, params: Params = PARAMS): WomanRun {
  const rng = new Rng(seed);
  const player = new Rng(seed ^ 0x9e3779b9);
  const disposition = drawDisposition(rng, params);
  let state: WomanState = initialWomanState(disposition);

  const t0 = 30;
  let t = t0;
  // seconds of walking between him and her front door
  const walkHome = policy === 'stand_still' ? Infinity : 50 + player.next() * 35;
  let walked = 0;
  let distance = 6;
  const run: WomanRun = {
    outcome: 'exited',
    disposition,
    exchanges: 0,
    encounterSeconds: 0,
    everHostile: false,
    everIntimidate: false,
    everFollow: false,
    everBlock: false,
    heLeft: false,
    escalationTurn: null,
    firstReaction: null,
    stances: [],
  };
  const shopAt = 2 + Math.floor(player.next() * 2);

  const step = (event: ClientEventType, strategy: WomanStrategy | null, speed: number) => {
    const out = decideWoman(
      state,
      {
        event,
        ctx: ctxFor(t, distance, speed, state.stance === 'block', Math.min(1, walked / (Number.isFinite(walkHome) ? walkHome : 1e9))),
        strategyProbs: strategy ? ({ [strategy]: 1 } as Partial<Record<WomanStrategy, number>>) : undefined,
      },
      rng,
      params,
    );
    state = out.state;
    if (out.decision) {
      run.stances.push(out.decision.stance);
      distance = out.decision.stance === 'gone' ? 99 : out.decision.proximity;
      if (out.decision.stance === 'hostile') run.everHostile = true;
      if (out.decision.stance === 'intimidate') run.everIntimidate = true;
      if (out.decision.stance === 'follow') run.everFollow = true;
      if (out.decision.stance === 'block') run.everBlock = true;
      if (out.decision.stance === 'gone') run.heLeft = true;
      if (out.decision.stance === 'escalate') run.escalationTurn = state.turn;
    }
    return out;
  };

  step('begin', null, 1.4);
  for (let guard = 0; guard < 80; guard++) {
    // one exchange: his line, then her answer or her silence
    const blocked = state.stance === 'block';
    const dt = 7.5 + player.next() * 3;
    t += dt;
    let strategy: WomanStrategy;
    if (policy === 'mixed') strategy = player.sample(REALISTIC_MIX);
    else if (policy === 'shop') strategy = 'ignore';
    else if (policy === 'stand_still') strategy = 'ignore';
    else strategy = policy;
    const stops = strategy === 'engage' || policy === 'stand_still';
    const speed = blocked || stops ? 0.1 : 1.4;
    if (!blocked && !stops) walked += dt;
    else if (strategy === 'engage') walked += dt * 0.4;

    if (state.stance === 'gone') {
      // he has left; she walks the rest of the way
      run.outcome = decideWoman(state, { event: 'reached_home', ctx: ctxFor(t, 99, 1.4, false, 1) }, rng, params).outcome ?? 'reached_home_alone';
      break;
    }
    if (policy === 'shop' && run.exchanges + 1 >= shopAt) {
      run.outcome = step('entered_shop', null, 1.4).outcome ?? 'took_refuge';
      break;
    }
    if (walked >= walkHome) {
      run.outcome = step('reached_home', null, 1.4).outcome ?? 'reached_home_followed';
      break;
    }
    const silent = strategy === 'ignore';
    const out = step(silent ? 'silence' : 'speech', silent ? null : strategy, speed);
    if (out.decision && out.decision.stance !== 'gone') {
      run.exchanges += 1;
      if (run.firstReaction === null) run.firstReaction = out.decision.stance;
    }
    if (out.outcome) {
      run.outcome = out.outcome;
      break;
    }
    if (policy === 'stand_still' && (state.stance as ManStance) === 'gone') {
      run.outcome = 'he_left';
      break;
    }
  }
  run.encounterSeconds = t - t0;
  return run;
}

export interface Tally {
  n: number;
  outcomes: Partial<Record<OutcomeKind, number>>;
  /** Share of runs in which he ever turned verbally hostile / menacing / followed / blocked. */
  everHostile: number;
  everIntimidate: number;
  everFollowOrBlock: number;
  /** Share of runs with no following, no blocking and no physical contact. */
  verbalOnly: number;
  heLeft: number;
  escalated: number;
  meanExchanges: number;
  meanSeconds: number;
  maxSeconds: number;
  earliestEscalationTurn: number | null;
}

export function tallyWoman(policy: WomanPolicy, n: number, seed: number, params: Params = PARAMS): Tally {
  const t: Tally = {
    n,
    outcomes: {},
    everHostile: 0,
    everIntimidate: 0,
    everFollowOrBlock: 0,
    verbalOnly: 0,
    heLeft: 0,
    escalated: 0,
    meanExchanges: 0,
    meanSeconds: 0,
    maxSeconds: 0,
    earliestEscalationTurn: null,
  };
  for (let i = 0; i < n; i++) {
    const r = simulateWoman(policy, (seed + i * 7919) >>> 0, params);
    t.outcomes[r.outcome] = (t.outcomes[r.outcome] ?? 0) + 1 / n;
    if (r.everHostile) t.everHostile += 1 / n;
    if (r.everIntimidate) t.everIntimidate += 1 / n;
    if (r.everFollow || r.everBlock) t.everFollowOrBlock += 1 / n;
    if (!r.everFollow && !r.everBlock && r.outcome !== 'escalated') t.verbalOnly += 1 / n;
    if (r.heLeft) t.heLeft += 1 / n;
    if (r.outcome === 'escalated') t.escalated += 1 / n;
    t.meanExchanges += r.exchanges / n;
    t.meanSeconds += r.encounterSeconds / n;
    t.maxSeconds = Math.max(t.maxSeconds, r.encounterSeconds);
    if (r.escalationTurn !== null) t.earliestEscalationTurn = Math.min(t.earliestEscalationTurn ?? Infinity, r.escalationTurn);
  }
  return t;
}

/* ------------------------------------------------------------------ bystander */

export type BystanderPolicy =
  | 'nothing'
  | 'distract'
  | 'direct'
  | 'direct_then_checks_in'
  | 'aggressive'
  | 'delegate'
  | 'film_close'
  | 'stand_between';

export interface BystanderRun {
  outcome: OutcomeKind;
  turns: number;
  firstResult: 'stops' | 'turns' | 'continues' | null;
  everTurned: boolean;
}

export function simulateBystander(policy: BystanderPolicy, seed: number, params: Params = PARAMS): BystanderRun {
  const rng = new Rng(seed);
  let state: BystanderState = initialBystanderState();
  let t = 20;
  const ctx = (): WorldContext => ({
    elapsed: t,
    distanceToMan: 3,
    distanceToWoman: 3,
    progress: 0.4,
    playerSpeed: 0,
    facingMan: true,
    manBlocking: false,
    oppositeSidewalk: false,
    lookingAt: 'man',
    filming: policy === 'film_close',
    betweenThem: policy === 'stand_between',
    beat: 'blocks',
  });
  const run: BystanderRun = { outcome: 'exited', turns: 0, firstResult: null, everTurned: false };

  const send = (event: ClientEventType, strategy?: BystanderStrategy, target?: SpeechTarget) => {
    const out = decideBystander(
      state,
      { event, ctx: ctx(), strategyProbs: strategy ? ({ [strategy]: 1 } as Partial<Record<BystanderStrategy, number>>) : undefined, target },
      rng,
      params,
    );
    state = out.state;
    run.turns += 1;
    if (out.result && run.firstResult === null && out.tactic) run.firstResult = out.result;
    if (out.man?.action === 'turn_on_bystander') run.everTurned = true;
    if (out.outcome) run.outcome = out.outcome;
    return out;
  };

  let first;
  switch (policy) {
    case 'nothing':
      t = 44;
      send('scene_timeout');
      return run;
    case 'distract':
      first = send('speech', 'distract', 'woman');
      break;
    case 'direct':
    case 'direct_then_checks_in':
      first = send('speech', 'direct', 'man');
      break;
    case 'aggressive':
      first = send('speech', 'aggressive', 'man');
      break;
    case 'delegate':
      first = send('asked_clerk');
      break;
    case 'film_close':
      first = send('filming_start');
      break;
    case 'stand_between':
      first = send('stood_between');
      break;
  }
  if (!first.man && !first.outcome) {
    // nothing happened (for example he did not notice the phone): the scripted scene runs out
    t = 44;
    send('scene_timeout');
    return run;
  }
  for (let guard = 0; guard < 20 && !state.ended; guard++) {
    t += 7;
    if (policy === 'aggressive' && state.phase !== 'he_left') send('speech', 'aggressive', 'man');
    else if (policy === 'direct_then_checks_in' && state.phase === 'he_left') send('speech', 'delay', 'woman');
    else send('silence');
  }
  return run;
}

export function tallyBystander(policy: BystanderPolicy, n: number, seed: number, params: Params = PARAMS) {
  const outcomes: Partial<Record<OutcomeKind, number>> = {};
  const first: Record<string, number> = { stops: 0, turns: 0, continues: 0, none: 0 };
  let turned = 0;
  let maxTurns = 0;
  for (let i = 0; i < n; i++) {
    const r = simulateBystander(policy, (seed + i * 104729) >>> 0, params);
    outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1 / n;
    first[r.firstResult ?? 'none'] += 1 / n;
    if (r.everTurned) turned += 1 / n;
    maxTurns = Math.max(maxTurns, r.turns);
  }
  return { n, outcomes, first, turned, maxTurns };
}
