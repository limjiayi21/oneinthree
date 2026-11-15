/**
 * Bystander POV decision model.
 *
 * The client plays a scripted exchange until this model emits its first
 * decision; from then on it drives the man and the woman. Each intervention is
 * one roll between three results: the harassment stops, he turns on the
 * bystander, or he brushes it off. The odds come from the bystander
 * parameters in the table (Right To Be's 5 Ds), blended modestly with Clef's
 * reading of the bystander's exact words.
 *
 * Pure TypeScript: no network, no clock, all randomness from the Rng passed in.
 */
import type {
  BystanderStrategy,
  ClientEventType,
  Emotion,
  ManDecision,
  ManStance,
  OutcomeKind,
  Rationale,
  SpeechTarget,
  WomanDecision,
  WorldContext,
} from '../../shared/types';
import type { Address } from './address';
import { decideExpression } from './expression';
import { PARAMS, param, val, weakestBasis, type Param, type Params } from './params';
import { Rng, clamp01, normalise, round3 } from './rng';

/** The same face model as the woman-POV scene. Tactic only picks the move; it does not pick a new outcome. */
function moveForTactic(tactic: Tactic): Address {
  if (tactic === 'document') return 'film';
  if (tactic === 'aggressive') return 'hostile';
  if (tactic === 'delegate') return 'help';
  if (tactic === 'distract') return 'polite';
  return 'firm';
}

function manFace(stance: ManStance, move: Address, tension: number, rng: Rng): { emotion: Emotion; emotionIntensity: number } {
  const face = decideExpression({ stance, move, tension, frustration: tension, rng });
  return { emotion: face.emotion, emotionIntensity: face.intensity };
}

export type Tactic = 'distract' | 'direct' | 'aggressive' | 'delegate' | 'document' | 'physical' | 'interruption';
export type InterventionResult = 'stops' | 'turns' | 'continues';

export const BYSTANDER_STRATEGIES: BystanderStrategy[] = ['direct', 'distract', 'delegate', 'delay', 'document', 'none', 'aggressive', 'unclear'];

/** Which parameters set the odds for each tactic. */
export const TACTIC_KEYS: Record<Tactic, { stops: string; turns: string }> = {
  distract: { stops: 'bystander.distract.p_harassment_stops', turns: 'bystander.distract.p_hostility_toward_bystander' },
  direct: { stops: 'bystander.direct.p_harassment_stops', turns: 'bystander.direct.p_hostility_toward_bystander' },
  aggressive: {
    stops: 'model.bystander.aggressive.p_harassment_stops',
    turns: 'model.bystander.aggressive.p_hostility_toward_bystander',
  },
  delegate: { stops: 'bystander.delegate.p_harassment_stops', turns: 'model.bystander.delegate.p_hostility_toward_bystander' },
  document: { stops: 'bystander.document.p_harassment_stops', turns: 'model.bystander.document.p_hostility_toward_bystander' },
  physical: { stops: 'bystander.any_action.p_harassment_stops', turns: 'model.bystander.physical.p_hostility_toward_bystander' },
  interruption: {
    stops: 'model.bystander.interruption.p_harassment_stops',
    turns: 'bystander.distract.p_hostility_toward_bystander',
  },
};

/** A line somebody should say on this beat. `situation` selects the line bank and briefs the writer. */
export interface LineCue {
  speaker: 'man' | 'woman' | 'clerk';
  situation: string;
  /** Pre-rendered script line to play as-is (the shopkeeper's lines). */
  scriptId?: string;
  emotion: Emotion;
  delivery: 'normal' | 'call_out' | 'low' | 'shout';
}

export interface BystanderState {
  phase: 'scripted' | 'dynamic' | 'he_left' | 'ended';
  manStance: ManStance;
  manFocus: 'woman' | 'player';
  /** Where she is: still with him, beside the bystander, on her way out, or out of the scene. */
  womanWith: 'man' | 'player' | 'leaving';
  interventions: number;
  /** Decisions made since the model took over. */
  dynamicTurns: number;
  /** Exchanges he has spent squared up to the bystander. */
  turnedTurns: number;
  /** He brushed off the last intervention and is still at her. */
  shruggedOff: boolean;
  clerkStage: 0 | 1 | 2;
  filming: boolean;
  filmNoticed: boolean;
  lastTactic: Tactic | null;
  tension: number;
  fear: number;
  lastDriver: string | null;
  ended: OutcomeKind | null;
}

export interface BystanderInput {
  event: ClientEventType;
  ctx: WorldContext;
  /** Distribution over the 5 Ds for 'speech' (from Clef, or the keyword fallback). */
  strategyProbs?: Partial<Record<BystanderStrategy, number>>;
  target?: SpeechTarget;
  /** Extra typed readings of the bystander's words, each 0..1. */
  signals?: { threat?: number; insult?: number };
  /** Clef's distribution over his immediate reaction. */
  reaction?: Partial<Record<InterventionResult, number>>;
  /**
   * 'physical': when nobody stepped in, the scene always ends with him grabbing her. A training
   * choice made for the live game, to show the cost of doing nothing; the research rate
   * (base.physical_escalation_per_run) still applies everywhere else, simulations and tests included.
   */
  inactionEnding?: 'physical';
}

export interface BystanderOutput {
  state: BystanderState;
  man: ManDecision | null;
  woman: WomanDecision | null;
  fear: number;
  tension: number;
  rationale?: Rationale;
  strategy: BystanderStrategy;
  strategyProbs: Record<BystanderStrategy, number>;
  target: SpeechTarget;
  /** The tactic the model actually resolved (a "delay" said in front of him is a Direct, and so on). */
  tactic: Tactic | 'delay' | null;
  result: InterventionResult | null;
  resultProbs: Partial<Record<InterventionResult, number>>;
  priorProbs: Partial<Record<InterventionResult, number>>;
  lines: LineCue[];
  /** Her inner voice, heard faintly: a bank key, or null. */
  thought: string | null;
  outcome?: OutcomeKind;
  drivers: string[];
}

export function initialBystanderState(): BystanderState {
  return {
    phase: 'scripted',
    manStance: 'persist',
    manFocus: 'woman',
    womanWith: 'man',
    interventions: 0,
    dynamicTurns: 0,
    turnedTurns: 0,
    shruggedOff: false,
    clerkStage: 0,
    filming: false,
    filmNoticed: false,
    lastTactic: null,
    tension: 0.3,
    fear: 0.4,
    lastDriver: null,
    ended: null,
  };
}

/** Events that map straight onto a strategy with no Clef call. */
export function bystanderStrategyForEvent(event: ClientEventType): BystanderStrategy | null {
  switch (event) {
    case 'asked_clerk':
      return 'delegate';
    case 'filming_start':
      return 'document';
    case 'stood_between':
      return 'direct';
    case 'scene_timeout':
    case 'walked_past':
    case 'left_scene':
      return 'none';
    default:
      return null;
  }
}

function complete(partial: Partial<Record<BystanderStrategy, number>> | undefined, fallback: BystanderStrategy): Record<BystanderStrategy, number> {
  const raw: Partial<Record<BystanderStrategy, number>> = {};
  let any = false;
  for (const s of BYSTANDER_STRATEGIES) {
    const v = partial?.[s];
    raw[s] = typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
    if ((raw[s] ?? 0) > 0) any = true;
  }
  if (!any) raw[fallback] = 1;
  return normalise(raw as Record<BystanderStrategy, number>);
}

function argmax<K extends string>(probs: Partial<Record<K, number>>): K {
  let best: K | null = null;
  let bestV = -1;
  for (const [k, v] of Object.entries(probs) as [K, number][]) {
    if (v > bestV) {
      best = k;
      bestV = v;
    }
  }
  return best as K;
}

function rationaleFrom(text: string, list: Param[]): Rationale {
  const sourceIds: string[] = [];
  for (const p of list) for (const s of p.sourceIds) if (!sourceIds.includes(s)) sourceIds.push(s);
  return { text, basis: weakestBasis(list), sourceIds };
}

/** Prior odds of the three results for a tactic. */
export function interventionPrior(tactic: Tactic, repeat: boolean, params: Params = PARAMS): Record<InterventionResult, number> {
  const keys = TACTIC_KEYS[tactic];
  let stops = clamp01(val(params, keys.stops));
  const turns = clamp01(val(params, keys.turns));
  if (repeat) {
    const boost = val(params, 'model.bystander.repeat_boost');
    const odds = (stops / Math.max(1e-6, 1 - stops)) * boost;
    stops = odds / (1 + odds);
  }
  const continues = Math.max(0, 1 - stops - turns);
  return normalise<InterventionResult>({ stops, turns, continues });
}

/** prior x likelihood^w, with "stops" and "turns" held inside the bands their researched ranges allow. */
export function blendIntervention(
  prior: Record<InterventionResult, number>,
  reading: Partial<Record<InterventionResult, number>> | undefined,
  tactic: Tactic,
  params: Params = PARAMS,
): Record<InterventionResult, number> {
  if (!reading) return prior;
  const w = val(params, 'model.blend.clef_weight');
  const floor = val(params, 'model.blend.likelihood_floor');
  const band = val(params, 'model.blend.default_band');
  const total = (['stops', 'turns', 'continues'] as InterventionResult[]).reduce((s, k) => s + Math.max(0, reading[k] ?? 0), 0);
  if (total <= 0 || w <= 0) return prior;
  const post = normalise<InterventionResult>({
    stops: prior.stops * Math.pow(Math.max(floor, Math.max(0, reading.stops ?? 0) / total), w),
    turns: prior.turns * Math.pow(Math.max(floor, Math.max(0, reading.turns ?? 0) / total), w),
    continues: prior.continues * Math.pow(Math.max(floor, Math.max(0, reading.continues ?? 0) / total), w),
  });
  let bounded = { ...post };
  const limits = (key: string | null): [number, number] => {
    if (!key) return [1 - band, 1 + band];
    const p = param(params, key);
    if (p.range && p.value > 0) return [Math.min(1, p.range[0] / p.value), Math.max(1, p.range[1] / p.value)];
    return [1 - band, 1 + band];
  };
  const keyFor: Record<InterventionResult, string | null> = { stops: TACTIC_KEYS[tactic].stops, turns: TACTIC_KEYS[tactic].turns, continues: null };
  for (let pass = 0; pass < 3; pass++) {
    for (const k of ['stops', 'turns', 'continues'] as InterventionResult[]) {
      const [lo, hi] = limits(keyFor[k]);
      bounded[k] = Math.min(prior[k] * hi, Math.max(prior[k] * lo, bounded[k]));
    }
    bounded = normalise(bounded);
  }
  return bounded;
}

const STOPS_TEXT: Record<Tactic, string> = {
  distract:
    'The interruption broke his momentum and he let it go: joining her takes away the one thing most incidents have in common, a woman on her own.',
  direct: 'Told plainly to stop by someone watching, he backed off: harassment is more likely to end when a bystander confronts it.',
  aggressive: 'Faced with open hostility he decided it was not worth it and backed off, though this is the tactic most likely to go the other way.',
  delegate: 'With the shopkeeper at his door he gave it up: someone with standing in the space was now watching.',
  document: 'He noticed the phone pointed at him and gave it up: men who do this tend to rely on going unnoticed.',
  physical: 'With someone standing between them he lost his line to her and gave it up.',
  interruption: 'Being interrupted at all was enough to break his momentum.',
};

const TURNS_TEXT: Record<Tactic, string> = {
  distract: 'He took the interruption personally and turned on the bystander, which is unusual for an indirect tactic.',
  direct: 'Called out in front of her, he turned on the bystander instead: the known risk of Direct.',
  aggressive: 'Threatened or insulted, he squared up to the bystander: confrontation in kind is the likeliest way to redirect his anger.',
  delegate: 'He ignored the shopkeeper and turned on the bystander who fetched him.',
  document: 'He saw the phone pointed at him and came at the person holding it.',
  physical: 'He took someone stepping in front of him as a challenge and squared up to them.',
  interruption: 'He took the interruption as a challenge and turned on the bystander.',
};

const CONTINUES_TEXT: Record<Tactic, string> = {
  distract: 'He brushed the interruption off and stayed where he was, but it gave her an opening.',
  direct: 'He brushed it off and told the bystander to mind their own business; one sentence does not always land.',
  aggressive: 'He shrugged off the challenge and kept his attention on her.',
  delegate: 'He ignored the shopkeeper for now.',
  document: 'He glanced at the phone and carried on: filming by itself rarely stops it.',
  physical: 'He stepped around the bystander and kept at her.',
  interruption: 'He glanced over and carried on.',
};

function quiet(state: BystanderState, strategy: BystanderStrategy, probs?: Record<BystanderStrategy, number>, target: SpeechTarget = 'nobody'): BystanderOutput {
  return {
    state,
    man: null,
    woman: null,
    fear: state.fear,
    tension: state.tension,
    strategy,
    strategyProbs: probs ?? complete(undefined, strategy),
    target,
    tactic: null,
    result: null,
    resultProbs: {},
    priorProbs: {},
    lines: [],
    thought: null,
    drivers: [],
  };
}

function noticeChance(distance: number, params: Params): number {
  if (distance < 4) return val(params, 'model.bystander.document.p_notice_near');
  if (distance < 9) return val(params, 'model.bystander.document.p_notice_mid');
  return val(params, 'model.bystander.document.p_notice_far');
}

export function decideBystander(state0: BystanderState, input: BystanderInput, rng: Rng, params: Params = PARAMS): BystanderOutput {
  const out = decide(state0, input, rng, params);
  // Fear and tension always reflect the state the model ended the beat in.
  return { ...out, fear: round3(out.state.fear), tension: round3(out.state.tension) };
}

function decide(state0: BystanderState, input: BystanderInput, rng: Rng, params: Params): BystanderOutput {
  const state: BystanderState = { ...state0 };
  const { event, ctx } = input;
  if (state.ended || state.phase === 'ended') return quiet(state, 'none');

  const distanceToMan = Number.isFinite(ctx.distanceToMan) ? ctx.distanceToMan : 99;
  const distanceToWoman = Number.isFinite(ctx.distanceToWoman ?? NaN) ? (ctx.distanceToWoman as number) : 99;
  const near = Math.min(distanceToMan, distanceToWoman) < 6;
  const lateBeat = ctx.beat === 'hostile' || ctx.beat === 'pleads' || ctx.beat === 'timeout';

  const finish = (out: BystanderOutput, outcome: OutcomeKind): BystanderOutput => {
    state.ended = outcome;
    state.phase = 'ended';
    return { ...out, state, outcome };
  };

  /* ---- bookkeeping events that are not interventions --------------------- */
  if (event === 'filming_stop') {
    state.filming = false;
    return quiet(state, 'none');
  }
  if (event === 'approached' || event === 'walked_past' || event === 'left_scene' || event === 'beat' || event === 'begin') {
    return quiet(state, 'none');
  }

  /* ---- nobody intervened -------------------------------------------------- */
  if (event === 'scene_timeout') {
    if (state.phase !== 'scripted') {
      return finish(quiet(state, 'none'), state.manStance === 'gone' ? 'intervened_he_left' : 'intervened_she_safe');
    }
    const p = param(params, 'base.physical_escalation_per_run');
    const worse = param(params, 'bystander.nothing.target_distress_increase');
    const forced = input.inactionEnding === 'physical';
    if (forced || rng.chance(clamp01(p.value))) {
      state.manStance = 'escalate';
      state.tension = 1;
      state.fear = 1;
      const out = quiet(state, 'none');
      const grabbed = manFace('escalate', 'hostile', 1, rng);
      out.man = { stance: 'escalate', action: 'grab', emotion: grabbed.emotion, emotionIntensity: grabbed.emotionIntensity, proximity: 0.6 };
      out.woman = { emotion: 'afraid', action: 'freeze' };
      out.rationale = rationaleFrom(
        forced
          ? 'Nobody stepped in, and he grabbed her. This simulation always ends that way when no one acts, to show what silence can cost. In real life this is rarer: most incidents stay verbal, and it is never her fault.'
          : 'Nobody stepped in and his anger tipped over into grabbing at her: rare, and it came from his temper, not from anything she or anyone chose.',
        [p],
      );
      out.drivers = [p.key];
      out.resultProbs = { continues: round3(1 - p.value) };
      return finish({ ...out, fear: 1, tension: 1 }, 'no_intervention_escalated');
    }
    state.fear = clamp01(state.fear + worse.value);
    const out = quiet(state, 'none');
    out.rationale = rationaleFrom(
      'Nobody stepped in. She got away by herself, as most women do, and the people who watched and did nothing made it worse for her.',
      [worse],
    );
    out.drivers = [worse.key];
    return finish({ ...out, fear: state.fear }, 'no_intervention_she_escaped');
  }

  /* ---- he has gone: one chance to check on her ---------------------------- */
  if (state.phase === 'he_left') {
    if (event === 'speech') {
      const relief = param(params, 'bystander.delay.target_distress_reduction');
      const probs = complete({ delay: 1 }, 'delay');
      state.fear = clamp01(state.fear * (1 - relief.value));
      state.tension = 0.05;
      const out = quiet(state, 'delay', probs, 'woman');
      out.tactic = 'delay';
      out.woman = { emotion: 'relieved', action: 'stop' };
      out.lines = [{ speaker: 'woman', situation: 'b_woman_thanks', emotion: 'relieved', delivery: 'normal' }];
      out.rationale = rationaleFrom(
        'Checking on her after he had gone could not change what he did, but it changes how she is left feeling.',
        [relief],
      );
      out.drivers = [relief.key];
      return finish({ ...out, fear: state.fear, tension: state.tension }, 'intervened_he_left');
    }
    if (event === 'silence') {
      const out = quiet(state, 'none');
      out.woman = { emotion: 'relieved', action: 'hurry_home' };
      return finish(out, 'intervened_he_left');
    }
    return quiet(state, 'none');
  }

  /* ---- read the intervention --------------------------------------------- */
  let strategyProbs = complete(event === 'speech' ? input.strategyProbs : undefined, bystanderStrategyForEvent(event) ?? 'none');
  if (event === 'speech') {
    // An explicit threat or insult makes a Direct an aggressive one.
    const heat = Math.max(clamp01(input.signals?.threat ?? 0), clamp01(input.signals?.insult ?? 0));
    if (heat > 0.6 && strategyProbs.aggressive < heat * 0.6) {
      strategyProbs = normalise({ ...strategyProbs, aggressive: heat * 0.6 * (1 + strategyProbs.aggressive) });
    }
  }
  let strategy = argmax(strategyProbs);
  const target: SpeechTarget = input.target ?? (event === 'asked_clerk' ? 'clerk' : ctx.lookingAt ?? 'nobody');

  let tactic: Tactic | null = null;
  if (event === 'speech') {
    if (strategy === 'delay') {
      // He is still here, so asking her if she is okay happens in front of him: that is a Direct.
      strategy = 'direct';
      strategyProbs = normalise({ ...strategyProbs, direct: strategyProbs.direct + strategyProbs.delay, delay: 0 });
    }
    if (strategy === 'direct' || strategy === 'distract' || strategy === 'aggressive' || strategy === 'delegate' || strategy === 'document') {
      tactic = strategy;
    } else if (near || state.phase === 'dynamic') {
      tactic = 'interruption';
    }
  } else if (event === 'asked_clerk') {
    tactic = 'delegate';
  } else if (event === 'stood_between') {
    tactic = 'physical';
  } else if (event === 'filming_start') {
    state.filming = true;
    if (!state.filmNoticed && state.manStance !== 'back_off' && rng.chance(noticeChance(distanceToMan, params))) {
      state.filmNoticed = true;
      tactic = 'document';
    }
  }

  /* ---- a beat with no new intervention ----------------------------------- */
  if (tactic === null) {
    if (event !== 'silence' && event !== 'speech') return quiet(state, strategy, strategyProbs, target);
    if (state.phase === 'scripted') return quiet(state, strategy, strategyProbs, target);
    return settle(state, strategy, strategyProbs, target, false, rng, params, finish);
  }

  /* ---- he was already leaving --------------------------------------------- */
  if (state.manStance === 'back_off') {
    const reengage = param(params, 'model.dynamics.reengage_after_insult');
    if (tactic === 'aggressive' && state.dynamicTurns < 6 && rng.chance(reengage.value)) {
      state.manStance = 'hostile';
      state.manFocus = 'player';
      state.turnedTurns += 1;
      state.dynamicTurns += 1;
      state.interventions += 1;
      state.lastTactic = tactic;
      state.tension = 0.85;
      const out = quiet(state, strategy, strategyProbs, target);
      out.tactic = tactic;
      out.result = 'turns';
      const turned = manFace('hostile', 'firm', state.tension, rng);
      out.man = { stance: 'hostile', action: 'turn_on_bystander', emotion: turned.emotion, emotionIntensity: turned.emotionIntensity, proximity: 1.3 };
      out.lines = [{ speaker: 'man', situation: 'b_man_turn', emotion: turned.emotion, delivery: 'normal' }];
      out.rationale = rationaleFrom('He was already leaving, heard the insult and came back at the bystander.', [reengage]);
      out.drivers = [reengage.key];
      return { ...out, tension: state.tension };
    }
    return settle(state, strategy, strategyProbs, target, event === 'speech' && target !== 'man' && target !== 'clerk', rng, params, finish);
  }

  /* ---- he is squared up to the bystander ---------------------------------- */
  if (state.manFocus === 'player' && state.turnedTurns > 0) {
    return squareUp(state, strategy, strategyProbs, target, tactic === 'aggressive', rng, params, finish);
  }

  /* ---- roll the intervention ---------------------------------------------- */
  const prior = interventionPrior(tactic, state.interventions > 0, params);
  const post = blendIntervention(prior, event === 'speech' ? input.reaction : undefined, tactic, params);
  const result = rng.sample<InterventionResult>(post);

  state.phase = 'dynamic';
  state.interventions += 1;
  state.dynamicTurns += 1;
  state.lastTactic = tactic;
  const keys = TACTIC_KEYS[tactic];
  const lines: LineCue[] = [];
  let man: ManDecision;
  let woman: WomanDecision;
  let thought: string | null = null;
  let rationale: Rationale;
  let drivers: string[];
  const toHer = target === 'woman' || (target === 'nobody' && tactic === 'distract');

  if (tactic === 'delegate') {
    if (state.clerkStage === 0) lines.push({ speaker: 'clerk', situation: 'c_ask', scriptId: 'c_ask', emotion: 'worried', delivery: 'normal' });
    lines.push({ speaker: 'clerk', situation: 'c_help_1', scriptId: 'c_help_1', emotion: 'determined', delivery: 'call_out' });
    state.clerkStage = 1;
  }

  if (result === 'stops') {
    const p = param(params, keys.stops);
    state.manStance = 'back_off';
    state.shruggedOff = false;
    state.tension = 0.3;
    state.fear = clamp01(state.fear - 0.15);
    const face = manFace('back_off', moveForTactic(tactic), state.tension, rng);
    const emotion = face.emotion;
    man = { stance: 'back_off', action: 'back_away', emotion, emotionIntensity: face.emotionIntensity, proximity: 3 };
    if (toHer && (tactic === 'distract' || tactic === 'direct')) {
      lines.push({
        speaker: 'woman',
        situation: tactic === 'distract' ? 'b_woman_play_along' : 'b_woman_answer_ok',
        emotion: tactic === 'distract' ? 'relieved' : 'afraid',
        delivery: 'normal',
      });
      woman = { emotion: tactic === 'distract' ? 'relieved' : 'worried', action: 'move_to_player' };
      state.womanWith = 'player';
    } else {
      woman = { emotion: 'worried', action: 'step_back' };
    }
    lines.push({
      speaker: 'man',
      situation: tactic === 'delegate' ? 'b_man_clerk_leave' : tactic === 'document' ? 'b_man_filmed_leave' : tactic === 'distract' || tactic === 'interruption' ? 'b_man_thrown' : 'b_man_defensive_leave',
      emotion,
      delivery: 'normal',
    });
    thought = 'b_thought_relief';
    rationale = rationaleFrom(STOPS_TEXT[tactic], [p]);
    drivers = [p.key];
  } else if (result === 'turns') {
    const p = param(params, keys.turns);
    state.manStance = 'hostile';
    state.manFocus = 'player';
    state.turnedTurns = 1;
    state.shruggedOff = false;
    state.tension = 0.85;
    const turned = manFace('hostile', moveForTactic(tactic), state.tension, rng);
    man = { stance: 'hostile', action: 'turn_on_bystander', emotion: turned.emotion, emotionIntensity: turned.emotionIntensity, proximity: 1.3 };
    lines.push({ speaker: 'man', situation: tactic === 'document' ? 'b_man_filmed' : 'b_man_turn', emotion: turned.emotion, delivery: 'normal' });
    if (rng.chance(val(params, 'model.bystander.she_slips_away'))) {
      woman = { emotion: 'afraid', action: 'hurry_home' };
      state.womanWith = 'leaving';
    } else {
      woman = { emotion: 'afraid', action: 'step_back' };
    }
    thought = 'b_thought_tense';
    rationale = rationaleFrom(TURNS_TEXT[tactic], [p]);
    drivers = [p.key];
  } else {
    const stopsP = param(params, keys.stops);
    state.manStance = lateBeat ? 'hostile' : 'persist';
    state.shruggedOff = true;
    state.tension = lateBeat ? 0.6 : 0.45;
    const stayed = manFace(state.manStance, moveForTactic(tactic), state.tension, rng);
    man = { stance: state.manStance, action: 'stay', emotion: stayed.emotion, emotionIntensity: stayed.emotionIntensity, proximity: 1.2 };
    if (toHer && (tactic === 'distract' || tactic === 'direct')) {
      lines.push({
        speaker: 'woman',
        situation: tactic === 'distract' ? 'b_woman_play_along' : 'b_woman_answer_ok',
        emotion: tactic === 'distract' ? 'worried' : 'afraid',
        delivery: 'normal',
      });
      woman = { emotion: 'worried', action: 'move_to_player' };
      state.womanWith = 'player';
    } else {
      woman = { emotion: 'afraid', action: 'step_back' };
    }
    lines.push({ speaker: 'man', situation: tactic === 'document' ? 'b_man_filmed' : 'b_man_dismiss', emotion: stayed.emotion, delivery: 'normal' });
    thought = 'b_thought_tense';
    rationale = rationaleFrom(CONTINUES_TEXT[tactic], [stopsP]);
    drivers = [stopsP.key];
  }
  state.lastDriver = drivers[0] ?? null;

  return {
    state,
    man,
    woman,
    fear: round3(state.fear),
    tension: round3(state.tension),
    rationale,
    strategy,
    strategyProbs,
    target,
    tactic,
    result,
    resultProbs: { stops: round3(post.stops), turns: round3(post.turns), continues: round3(post.continues) },
    priorProbs: { stops: round3(prior.stops), turns: round3(prior.turns), continues: round3(prior.continues) },
    lines,
    thought,
    drivers,
  };
}

type Finish = (out: BystanderOutput, outcome: OutcomeKind) => BystanderOutput;

/**
 * A beat after the model has taken over in which the bystander does nothing
 * new (silence, or words that are not an intervention): let what was set in
 * motion play out.
 */
function settle(
  state: BystanderState,
  strategy: BystanderStrategy,
  strategyProbs: Record<BystanderStrategy, number>,
  target: SpeechTarget,
  spokeToHer: boolean,
  rng: Rng,
  params: Params,
  finish: Finish,
): BystanderOutput {
  state.dynamicTurns += 1;
  const out = quiet(state, strategy, strategyProbs, target);
  const driver = state.lastDriver ? params.get(state.lastDriver) : undefined;

  // He was leaving: now he goes.
  if (state.manStance === 'back_off') {
    state.manStance = 'gone';
    state.manFocus = 'woman';
    state.tension = 0.05;
    state.fear = clamp01(state.fear - 0.15);
    const gone = manFace('gone', 'silence', 0.1, rng);
    out.man = { stance: 'gone', action: 'leave', emotion: gone.emotion, emotionIntensity: gone.emotionIntensity, proximity: 3 };
    out.rationale = rationaleFrom('He has given up and is walking away.', driver ? [driver] : []);
    out.drivers = driver ? [driver.key] : [];
    if (state.womanWith === 'leaving') {
      return finish({ ...out, fear: state.fear, tension: state.tension }, 'intervened_she_safe');
    }
    if (spokeToHer) {
      const relief = param(params, 'bystander.delay.target_distress_reduction');
      state.fear = clamp01(state.fear * (1 - relief.value));
      out.strategy = 'delay';
      out.strategyProbs = complete({ delay: 1 }, 'delay');
      out.tactic = 'delay';
      out.woman = { emotion: 'relieved', action: 'stop' };
      out.lines = [{ speaker: 'woman', situation: 'b_woman_thanks', emotion: 'relieved', delivery: 'normal' }];
      out.drivers = [...out.drivers, relief.key];
      return finish({ ...out, fear: state.fear, tension: state.tension }, 'intervened_he_left');
    }
    state.phase = 'he_left';
    out.woman = { emotion: 'relieved', action: 'stop' };
    return { ...out, state, fear: round3(state.fear), tension: state.tension };
  }

  // He is squared up to the bystander.
  if (state.manFocus === 'player' && state.turnedTurns > 0) {
    return squareUp(state, strategy, strategyProbs, target, false, rng, params, finish, true);
  }

  // The shopkeeper is at his door and the man has not moved: the second warning.
  if (state.clerkStage === 1) {
    const p = param(params, 'model.bystander.clerk_second_warning.p_harassment_stops');
    state.clerkStage = 2;
    out.lines = [{ speaker: 'clerk', situation: 'c_help_2', scriptId: 'c_help_2', emotion: 'determined', delivery: 'call_out' }];
    out.drivers = [p.key];
    if (rng.chance(clamp01(p.value))) {
      state.manStance = 'back_off';
      state.shruggedOff = false;
      state.tension = 0.3;
      state.lastDriver = p.key;
      const backed = manFace('back_off', 'help', state.tension, rng);
      out.man = { stance: 'back_off', action: 'back_away', emotion: backed.emotion, emotionIntensity: backed.emotionIntensity, proximity: 3 };
      out.woman = { emotion: 'worried', action: 'step_back' };
      out.lines.push({ speaker: 'man', situation: 'b_man_clerk_leave', emotion: backed.emotion, delivery: 'normal' });
      out.rationale = rationaleFrom('Told the police were being called, he gave it up.', [p]);
      return { ...out, state, tension: state.tension };
    }
    const stayed = manFace(state.manStance, 'help', state.tension, rng);
    out.man = { stance: state.manStance, action: 'stay', emotion: stayed.emotion, emotionIntensity: stayed.emotionIntensity, proximity: 1.6 };
    out.woman = { emotion: 'worried', action: 'enter_shop' };
    state.womanWith = 'leaving';
    out.rationale = rationaleFrom('He stood his ground, but with the shopkeeper watching she had somewhere to go.', [p]);
    return { ...out, state };
  }

  // He brushed the intervention off. She takes the opening it gave her.
  const any = param(params, 'bystander.any_action.p_harassment_stops');
  state.manStance = 'back_off';
  state.tension = 0.35;
  state.fear = clamp01(state.fear - 0.1);
  out.woman = { emotion: 'worried', action: state.womanWith === 'leaving' && state.clerkStage === 2 ? 'enter_shop' : 'hurry_home' };
  if (state.womanWith === 'player') {
    out.lines = [{ speaker: 'woman', situation: 'b_woman_leaving', emotion: 'worried', delivery: 'normal' }];
  }
  state.womanWith = 'leaving';
  const shouted = manFace('back_off', 'hostile', state.tension, rng);
  out.man = { stance: 'back_off', action: 'stay', emotion: shouted.emotion, emotionIntensity: shouted.emotionIntensity, proximity: 3 };
  out.lines.push({ speaker: 'man', situation: 'b_man_shout_after', emotion: shouted.emotion, delivery: 'shout' });
  out.rationale = rationaleFrom(
    'He never backed down, but the interruption gave her the opening to get away: an intervention does not have to win the argument to work.',
    [any],
  );
  out.drivers = [any.key];
  return finish({ ...out, fear: round3(state.fear), tension: state.tension }, 'intervened_she_safe');
}

/** He has turned on the bystander: bluster and leave, keep squaring up, or (rarely, never at once) become physical. */
function squareUp(
  state: BystanderState,
  strategy: BystanderStrategy,
  strategyProbs: Record<BystanderStrategy, number>,
  target: SpeechTarget,
  provoked: boolean,
  rng: Rng,
  params: Params,
  finish: Finish,
  counted = false,
): BystanderOutput {
  if (!counted) state.dynamicTurns += 1;
  if (strategy === 'direct' || strategy === 'aggressive' || strategy === 'distract') state.interventions += 1;
  const out = quiet(state, strategy, strategyProbs, target);
  out.tactic = provoked ? 'aggressive' : null;

  const backP = param(params, 'model.bystander.turned.p_back_off');
  const escP = param(params, provoked ? 'model.bystander.turned.p_escalates_if_provoked' : 'model.bystander.turned.p_escalates');
  // Never physical in the first couple of exchanges, and he runs out of steam after a few.
  const canEscalate = state.dynamicTurns >= 3 && state.turnedTurns >= 2;
  const mustLeave = state.turnedTurns >= 4 || state.dynamicTurns >= 8;
  const pEsc = canEscalate && !mustLeave ? clamp01(escP.value) : 0;
  const pBack = mustLeave ? 1 : clamp01(backP.value * (provoked ? 0.7 : 1));
  const probs = normalise<InterventionResult>({ stops: pBack * (1 - pEsc), turns: pEsc, continues: Math.max(0, (1 - pBack) * (1 - pEsc)) });
  const result = rng.sample<InterventionResult>(probs);
  out.resultProbs = { stops: round3(probs.stops), turns: round3(probs.turns), continues: round3(probs.continues) };
  out.priorProbs = out.resultProbs;

  // She uses the time he spends on the bystander.
  if (state.womanWith !== 'leaving' && rng.chance(val(params, 'model.bystander.she_slips_away'))) {
    out.woman = { emotion: 'afraid', action: 'hurry_home' };
    state.womanWith = 'leaving';
  }

  if (result === 'turns') {
    state.manStance = 'escalate';
    state.tension = 1;
    const grabbed = manFace('escalate', 'hostile', 1, rng);
    out.man = { stance: 'escalate', action: 'grab', emotion: grabbed.emotion, emotionIntensity: grabbed.emotionIntensity, proximity: 0.6 };
    out.lines = [{ speaker: 'man', situation: 'b_man_escalate', emotion: grabbed.emotion, delivery: 'shout' }];
    out.result = 'turns';
    const risk = param(params, 'bystander.direct.p_hostility_toward_bystander');
    out.rationale = rationaleFrom(
      'His anger at being challenged tipped over and he went for the bystander: rare, and the reason guidance says to keep Direct short and not argue.',
      [escP, risk],
    );
    out.drivers = [escP.key, risk.key];
    return finish({ ...out, tension: 1 }, 'intervened_escalated');
  }
  if (result === 'stops') {
    state.manStance = 'back_off';
    state.tension = 0.4;
    state.lastDriver = backP.key;
    const leaving = manFace('back_off', 'hostile', state.tension, rng);
    out.man = { stance: 'back_off', action: 'back_away', emotion: leaving.emotion, emotionIntensity: leaving.emotionIntensity, proximity: 3 };
    out.lines = [{ speaker: 'man', situation: 'b_man_bluster_leave', emotion: leaving.emotion, delivery: 'normal' }];
    out.result = 'stops';
    out.rationale = rationaleFrom('He blustered, found nobody backing down, and decided it was not worth it.', [backP]);
    out.drivers = [backP.key];
    return { ...out, state, tension: state.tension };
  }
  state.turnedTurns += 1;
  state.tension = 0.9;
  const squared = manFace('intimidate', provoked ? 'hostile' : 'firm', state.tension, rng);
  out.man = { stance: 'intimidate', action: 'step_closer', emotion: squared.emotion, emotionIntensity: squared.emotionIntensity, proximity: 1.0 };
  state.manStance = 'intimidate';
  out.lines = [{ speaker: 'man', situation: 'b_man_squareup', emotion: squared.emotion, delivery: 'low' }];
  out.result = 'continues';
  out.rationale = rationaleFrom(
    provoked ? 'Pushed again, he stepped closer: arguing with him keeps his attention and his anger on the bystander.' : 'He is still squared up to the bystander, working out whether to push it.',
    [backP],
  );
  out.drivers = [backP.key];
  return { ...out, state, tension: state.tension };
}
