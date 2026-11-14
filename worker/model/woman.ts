/**
 * Woman POV decision model: a seeded state machine over ManStance.
 *
 * Pure TypeScript, no network, no clock: everything it needs arrives in the
 * input, and all randomness comes from the Rng passed in.
 *
 *   his disposition (drawn once)  x  how she responded  x  what has built up
 *        -> distribution over reaction classes (back off / keep going / hostile / menace)
 *        -> distribution over the next ManStance
 *        -> optionally blended with Clef's reading of her exact words
 *        -> sample -> action, emotion, proximity, her fear, his tension, and a Rationale
 */
import type {
  ClientEventType,
  ManAction,
  ManDecision,
  ManStance,
  OutcomeKind,
  Rationale,
  WomanStrategy,
  WorldContext,
} from '../../shared/types';
import { addressOf } from './address';
import { gateStance, isClearFirm } from './stanceGate';
import { decideExpression, type ExpressionDecision } from '../../shared/expression';
import { PARAMS, param, val, weakestBasis, type Param, type Params } from './params';
import { Rng, clamp01, normalise, round3 } from './rng';

export type Disposition = 'mild' | 'persistent' | 'volatile';
export type ReactionClass = 'back_off' | 'persist' | 'hostile' | 'intimidate';

export const DISPOSITIONS: Disposition[] = ['mild', 'persistent', 'volatile'];
export const REACTION_CLASSES: ReactionClass[] = ['back_off', 'persist', 'hostile', 'intimidate'];
export const WOMAN_STRATEGIES: WomanStrategy[] = [
  'ignore',
  'polite_deflect',
  'firm_boundary',
  'hostile',
  'excuse',
  'threaten_attention',
  'seek_help',
  'engage',
  'plead',
  'unclear',
];

/** Stances Clef is allowed an opinion about. */
export const REACTION_STANCES: ManStance[] = ['back_off', 'persist', 'guilt', 'follow', 'block', 'hostile', 'intimidate'];

const CLASS_OF: Partial<Record<ManStance, ReactionClass>> = {
  back_off: 'back_off',
  persist: 'persist',
  guilt: 'persist',
  follow: 'persist',
  block: 'persist',
  hostile: 'hostile',
  intimidate: 'intimidate',
};

/** Which parameter supplies each cell of the response -> reaction table. */
export const ROW_KEYS: Record<WomanStrategy, Record<ReactionClass, string>> = {
  ignore: {
    back_off: 'response.ignore.p_back_off',
    persist: 'response.ignore.p_persist_or_follow',
    hostile: 'response.ignore.p_verbal_hostility',
    intimidate: 'model.response.ignore.p_intimidation',
  },
  polite_deflect: {
    back_off: 'model.response.polite_deflection.p_back_off',
    persist: 'response.polite_deflection.p_persist',
    hostile: 'response.polite_deflection.p_verbal_hostility',
    intimidate: 'model.response.polite_deflection.p_intimidation',
  },
  firm_boundary: {
    back_off: 'response.firm_boundary.p_back_off',
    persist: 'model.response.firm_boundary.p_persist',
    hostile: 'response.firm_boundary.p_verbal_hostility',
    intimidate: 'model.response.firm_boundary.p_intimidation',
  },
  hostile: {
    back_off: 'model.response.hostile_insult.p_back_off',
    persist: 'model.response.hostile_insult.p_persist',
    hostile: 'response.hostile_insult.p_verbal_hostility',
    intimidate: 'response.hostile_insult.p_intimidation',
  },
  excuse: {
    back_off: 'model.response.lie_or_excuse.p_back_off',
    persist: 'response.lie_or_excuse.p_persist',
    hostile: 'response.lie_or_excuse.p_verbal_hostility',
    intimidate: 'model.response.lie_or_excuse.p_intimidation',
  },
  threaten_attention: {
    back_off: 'response.threat_police_or_attention.p_back_off',
    persist: 'model.response.threat_police_or_attention.p_persist',
    hostile: 'response.threat_police_or_attention.p_verbal_hostility',
    intimidate: 'model.response.threat_police_or_attention.p_intimidation',
  },
  seek_help: {
    back_off: 'response.seek_refuge.p_back_off',
    persist: 'model.response.seek_refuge.p_persist',
    hostile: 'model.response.seek_refuge.p_verbal_hostility',
    intimidate: 'model.response.seek_refuge.p_intimidation',
  },
  engage: {
    back_off: 'model.response.engage_friendly.p_back_off',
    persist: 'response.engage_friendly.p_persist',
    hostile: 'model.response.engage_friendly.p_verbal_hostility',
    intimidate: 'model.response.engage_friendly.p_intimidation',
  },
  plead: {
    back_off: 'model.response.plead.p_back_off',
    persist: 'model.response.plead.p_persist',
    hostile: 'model.response.plead.p_verbal_hostility',
    intimidate: 'model.response.plead.p_intimidation',
  },
  unclear: {
    back_off: 'model.response.unclear.p_back_off',
    persist: 'model.response.unclear.p_persist',
    hostile: 'model.response.unclear.p_verbal_hostility',
    intimidate: 'model.response.unclear.p_intimidation',
  },
};

const FRUSTRATION_KEY: Record<WomanStrategy, string> = {
  ignore: 'model.dynamics.frustration.ignore',
  polite_deflect: 'model.dynamics.frustration.polite_deflect',
  firm_boundary: 'model.dynamics.frustration.firm_boundary',
  hostile: 'model.dynamics.frustration.hostile',
  excuse: 'model.dynamics.frustration.excuse',
  threaten_attention: 'model.dynamics.frustration.threaten_attention',
  seek_help: 'model.dynamics.frustration.seek_help',
  engage: 'model.dynamics.frustration.engage',
  plead: 'model.dynamics.frustration.plead',
  unclear: 'model.dynamics.frustration.unclear',
};

export interface WomanState {
  disposition: Disposition;
  stance: ManStance;
  /** Decisions made so far; his opening call-out is 1. */
  turn: number;
  /** Responses of hers he has reacted to. */
  exchanges: number;
  /** Clear refusals so far (firm boundary, insult, threat). */
  rejections: number;
  /** Times she has insulted him. */
  insults: number;
  /** 0..1, his accumulated frustration. */
  frustration: number;
  blocks: number;
  hasFollowed: boolean;
  hasBlocked: boolean;
  /** Consecutive decisions spent hostile or menacing. */
  hostileTurns: number;
  /** ctx.elapsed when the encounter began, or null before it has. */
  startedAt: number | null;
  fear: number;
  tension: number;
  /** Parameter that drove the most recent change of stance (for the "he left" rationale). */
  lastDriver: string | null;
  ended: OutcomeKind | null;
}

export interface WomanInput {
  event: ClientEventType;
  ctx: WorldContext;
  /** Her words, when the event is speech. Used to stop a greeting from being treated as a no. */
  text?: string;
  /** Distribution over how she responded (from Clef, or the keyword fallback). Omit for non-speech events. */
  strategyProbs?: Partial<Record<WomanStrategy, number>>;
  /** Extra typed readings of her words, each 0..1. */
  signals?: { tone?: number; insult?: number; police?: number };
  /** Clef's distribution over his most likely immediate reaction, keyed by ManStance. */
  reaction?: Partial<Record<ManStance, number>>;
}

export interface WomanOutput {
  state: WomanState;
  /** null when nothing about him changes (he has already gone, or the event is not for this model). */
  decision: ManDecision | null;
  fear: number;
  tension: number;
  rationale?: Rationale;
  /** The strategy the model acted on, and the distribution it used. */
  strategy: WomanStrategy;
  strategyProbs: Record<WomanStrategy, number>;
  /** Distribution over his next stance that was sampled from (after any blend). */
  stanceProbs: Partial<Record<ManStance, number>>;
  /** The same distribution before Clef's reading was blended in. */
  priorProbs: Partial<Record<ManStance, number>>;
  outcome?: OutcomeKind;
  /** Should he say something on this beat? */
  speak: boolean;
  delivery: 'normal' | 'call_out' | 'low' | 'shout';
  /** Keys of the parameters that mattered most for this decision. */
  drivers: string[];
}

export function drawDisposition(rng: Rng, params: Params = PARAMS): Disposition {
  const volatile = clamp01(val(params, 'man.disposition.hostile_from_start'));
  const persistent = clamp01(val(params, 'man.disposition.persistent_entitled'));
  const mild = Math.max(0, 1 - volatile - persistent);
  return rng.sample<Disposition>({ mild, persistent, volatile });
}

/** Share of men of each disposition in the model (from the research's disposition parameters). */
export function dispositionWeights(params: Params = PARAMS): Record<Disposition, number> {
  const volatile = clamp01(val(params, 'man.disposition.hostile_from_start'));
  const persistent = clamp01(val(params, 'man.disposition.persistent_entitled'));
  return normalise<Disposition>({ mild: Math.max(0, 1 - volatile - persistent), persistent, volatile });
}

export function initialWomanState(disposition: Disposition): WomanState {
  return {
    disposition,
    stance: 'idle',
    turn: 0,
    exchanges: 0,
    rejections: 0,
    insults: 0,
    frustration: 0,
    blocks: 0,
    hasFollowed: false,
    hasBlocked: false,
    hostileTurns: 0,
    startedAt: null,
    fear: 0.15,
    tension: 0.1,
    lastDriver: null,
    ended: null,
  };
}

/** The researched reaction shares for one response, re-normalised to sum to 1. */
export function baseRow(strategy: WomanStrategy, params: Params = PARAMS): Record<ReactionClass, number> {
  const keys = ROW_KEYS[strategy];
  return normalise<ReactionClass>({
    back_off: val(params, keys.back_off),
    persist: val(params, keys.persist),
    hostile: val(params, keys.hostile),
    intimidate: val(params, keys.intimidate),
  });
}

export interface ClassContext {
  disposition: Disposition;
  exchanges: number;
  frustration: number;
  stance: ManStance;
  encounterSeconds: number;
  across: boolean;
  far: boolean;
}

/**
 * Reaction-class distribution for a response distribution, a disposition and
 * the state that has built up. With exchanges = 0, frustration = 0 and
 * time = 0 this is the "first response" table the tests check against the
 * researched ranges.
 */
export function classDistribution(
  strategyProbs: Record<WomanStrategy, number>,
  c: ClassContext,
  params: Params = PARAMS,
): Record<ReactionClass, number> {
  const mix: Record<ReactionClass, number> = { back_off: 0, persist: 0, hostile: 0, intimidate: 0 };
  for (const s of WOMAN_STRATEGIES) {
    const w = strategyProbs[s] ?? 0;
    if (w <= 0) continue;
    const row = baseRow(s, params);
    for (const k of REACTION_CLASSES) mix[k] += w * row[k];
  }
  const d = c.disposition;
  const wasHostile = c.stance === 'hostile' || c.stance === 'intimidate';
  const heat = 1 + val(params, 'model.dynamics.frustration_gain') * clamp01(c.frustration);
  const soft = Math.max(1, val(params, 'model.session.soft_seconds'));
  const fatigue = 1 + val(params, 'model.dynamics.fatigue_gain') * Math.pow(Math.max(0, c.encounterSeconds) / soft, 2);
  const pushiness =
    c.exchanges === 0
      ? val(params, 'model.scenario.pushiness_first_response')
      : c.exchanges === 1
        ? val(params, 'model.scenario.pushiness_second_response')
        : 1;

  const odds: Record<ReactionClass, number> = {
    back_off:
      mix.back_off *
      val(params, `model.disposition.${d}.back_off`) *
      pushiness *
      fatigue *
      (wasHostile ? val(params, 'model.dynamics.hostile_inertia_back_off') : 1) *
      (c.across ? val(params, 'model.dynamics.distance_back_off') : 1),
    persist:
      mix.persist *
      val(params, `model.disposition.${d}.persist`) *
      (wasHostile ? val(params, 'model.dynamics.hostile_inertia_persist') : 1),
    hostile:
      mix.hostile *
      val(params, `model.disposition.${d}.hostile`) *
      heat *
      (wasHostile ? val(params, 'model.dynamics.hostile_inertia_hostile') : 1),
    intimidate:
      mix.intimidate *
      val(params, `model.disposition.${d}.intimidate`) *
      heat *
      (c.exchanges < 2 ? val(params, 'model.dynamics.early_intimidation') : 1) *
      (c.far || c.across ? val(params, 'model.dynamics.far_factor') : 1),
  };
  return normalise(odds);
}

/** Map a non-speech event straight onto a response strategy (no Clef call needed). */
export function strategyForEvent(event: ClientEventType): WomanStrategy | null {
  switch (event) {
    case 'silence':
    case 'sped_up':
    case 'crossed_street':
    case 'backed_away':
    case 'stopped':
      return 'ignore';
    case 'pushed_past':
      return 'firm_boundary';
    case 'entered_shop':
      return 'seek_help';
    default:
      return null;
  }
}

const HER_PHRASE: Record<WomanStrategy, string> = {
  ignore: 'she said nothing',
  polite_deflect: 'a polite no',
  firm_boundary: 'a clear, firm no',
  hostile: 'being insulted',
  excuse: 'her excuse',
  threaten_attention: 'her threat to call for help',
  seek_help: 'she turned to other people',
  engage: 'a friendly answer',
  plead: 'her pleading',
  unclear: 'words he could not make sense of',
};

function herPhrase(event: ClientEventType, strategy: WomanStrategy): string {
  switch (event) {
    case 'sped_up':
      return 'she walked faster';
    case 'crossed_street':
      return 'she crossed the street';
    case 'pushed_past':
      return 'she pushed past him';
    case 'backed_away':
      return 'she backed away';
    case 'stopped':
      return 'she stopped';
    default:
      return HER_PHRASE[strategy];
  }
}

function rationaleText(stance: ManStance, phrase: string): string {
  const after = /^she /.test(phrase) ? `When ${phrase}` : `After ${phrase}`;
  switch (stance) {
    case 'back_off':
      return `${after}, he gave up with a parting remark, which is how most of these encounters end.`;
    case 'persist':
      return `${after}, he kept talking: he treats anything short of her leaving as an opening.`;
    case 'guilt':
      return `${after}, he turned it back on her, as if she were the one being rude.`;
    case 'follow':
      return `${after}, he fell in behind her instead of letting it go.`;
    case 'block':
      return `${after}, he stepped into her path to make her deal with him.`;
    case 'hostile':
      return `${after}, he took it as disrespect and switched to insults.`;
    case 'intimidate':
      return `${after}, he closed the distance and dropped his voice to frighten her.`;
    default:
      return `${after}, he changed tack.`;
  }
}

const STANCE_TENSION: Record<ManStance, number> = {
  idle: 0.05,
  opening: 0.12,
  persist: 0.18,
  follow: 0.28,
  block: 0.38,
  guilt: 0.25,
  hostile: 0.62,
  intimidate: 0.78,
  back_off: 0.2,
  gone: 0,
  escalate: 1,
};

const STANCE_FEAR: Record<ManStance, number> = {
  idle: 0.2,
  opening: 0.36,
  persist: 0.46,
  follow: 0.64,
  block: 0.72,
  guilt: 0.48,
  hostile: 0.78,
  intimidate: 0.92,
  back_off: 0.42,
  gone: 0.3,
  escalate: 1,
};

/** Face for a stance the machine already chose. The suggestion slot stays empty here; the line does not get a vote. */
function pickEmotion(stance: ManStance, strategy: WomanStrategy, state: WomanState, rng: Rng): ExpressionDecision {
  return decideExpression({
    stance,
    move: addressOf(strategy, ''),
    tension: state.tension,
    frustration: state.frustration,
    rng,
  });
}

interface Physical {
  moving: boolean;
  hurrying: boolean;
  stopped: boolean;
  across: boolean;
  far: boolean;
  evading: boolean;
  distance: number;
}

function physical(event: ClientEventType, ctx: WorldContext): Physical {
  const speed = Number.isFinite(ctx.playerSpeed) ? ctx.playerSpeed : 0;
  const distance = Number.isFinite(ctx.distanceToMan) ? ctx.distanceToMan : 99;
  const hurrying = speed > 2.0 || event === 'sped_up';
  return {
    moving: speed > 0.5 || event === 'sped_up' || event === 'crossed_street',
    hurrying,
    stopped: speed < 0.3 && event !== 'sped_up' && event !== 'crossed_street' && event !== 'pushed_past',
    across: Boolean(ctx.oppositeSidewalk),
    far: distance > 6,
    evading: hurrying || event === 'crossed_street' || event === 'backed_away' || event === 'pushed_past',
    distance,
  };
}

function actionFor(stance: ManStance, ph: Physical, rng: Rng): { action: ManAction; proximity: number; delivery: WomanOutput['delivery'] } {
  switch (stance) {
    case 'opening':
      return ph.across || ph.distance > 9
        ? { action: 'stay', proximity: 3, delivery: 'call_out' }
        : { action: 'approach', proximity: 2.2, delivery: 'call_out' };
    case 'persist':
      if (ph.moving) return { action: 'walk_alongside', proximity: 1.3, delivery: ph.distance > 5 ? 'call_out' : 'normal' };
      return { action: ph.distance > 2.6 ? 'approach' : 'stay', proximity: 1.5, delivery: ph.distance > 5 ? 'call_out' : 'normal' };
    case 'guilt':
      if (ph.moving) return { action: 'walk_alongside', proximity: 1.4, delivery: ph.distance > 5 ? 'call_out' : 'normal' };
      return { action: ph.distance > 3 ? 'approach' : 'stay', proximity: 1.6, delivery: ph.distance > 5 ? 'call_out' : 'normal' };
    case 'follow':
      if (ph.hurrying || ph.evading) return { action: 'run_after', proximity: 1.4, delivery: 'shout' };
      if (ph.distance > 5) return { action: 'stalk', proximity: 3.4, delivery: 'low' };
      return { action: 'follow_behind', proximity: 2.2, delivery: ph.distance > 4 ? 'call_out' : 'normal' };
    case 'block':
      return { action: 'block_path', proximity: 1.1, delivery: 'normal' };
    case 'hostile':
      if (ph.distance > 2.4 || ph.hurrying) return { action: 'run_after', proximity: 1.3, delivery: 'shout' };
      return { action: 'block_path', proximity: 1.0, delivery: 'normal' };
    case 'intimidate':
      if (ph.distance > 1.8) return { action: 'run_after', proximity: 1.0, delivery: 'low' };
      return { action: 'pull_arm', proximity: 0.7, delivery: 'low' };
    case 'back_off':
      return { action: 'back_away', proximity: 3, delivery: ph.far || ph.hurrying ? 'shout' : 'normal' };
    case 'gone':
      return { action: 'leave', proximity: 3, delivery: 'normal' };
    case 'escalate':
      return { action: 'grab', proximity: 0.6, delivery: 'shout' };
    default:
      return { action: 'stay', proximity: 2.5, delivery: 'normal' };
  }
}

function completeProbs(partial: Partial<Record<WomanStrategy, number>> | undefined, fallback: WomanStrategy): Record<WomanStrategy, number> {
  const raw: Partial<Record<WomanStrategy, number>> = {};
  let any = false;
  for (const s of WOMAN_STRATEGIES) {
    const v = partial?.[s];
    raw[s] = typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
    if ((raw[s] ?? 0) > 0) any = true;
  }
  if (!any) raw[fallback] = 1;
  return normalise(raw as Record<WomanStrategy, number>);
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

/**
 * Blend the evidence-based prior with Clef's reading: prior x likelihood^w,
 * renormalised, with each reaction class held inside the band its researched
 * range allows. Escalation is never Clef's call: its probability is fixed by
 * the prior.
 */
export function blendWithReading(
  prior: Partial<Record<ManStance, number>>,
  reading: Partial<Record<ManStance, number>> | undefined,
  dominant: WomanStrategy,
  params: Params = PARAMS,
): Partial<Record<ManStance, number>> {
  if (!reading) return prior;
  const w = val(params, 'model.blend.clef_weight');
  const floor = val(params, 'model.blend.likelihood_floor');
  const band = val(params, 'model.blend.default_band');
  const fixed = prior.escalate ?? 0;
  const open = REACTION_STANCES.filter((s) => (prior[s] ?? 0) > 0);
  if (!open.length || w <= 0) return prior;

  const openMass = open.reduce((s, k) => s + (prior[k] ?? 0), 0);
  const readingTotal = open.reduce((s, k) => s + Math.max(0, reading[k] ?? 0), 0);
  if (readingTotal <= 0) return prior;

  // posterior over the open stances
  const post: Partial<Record<ManStance, number>> = {};
  for (const k of open) {
    const like = Math.max(floor, Math.max(0, reading[k] ?? 0) / readingTotal);
    post[k] = (prior[k] ?? 0) * Math.pow(like, w);
  }
  const postN = normalise(post as Record<ManStance, number>);

  // class totals before and after, as shares of the open mass
  const priorClass: Record<ReactionClass, number> = { back_off: 0, persist: 0, hostile: 0, intimidate: 0 };
  const postClass: Record<ReactionClass, number> = { back_off: 0, persist: 0, hostile: 0, intimidate: 0 };
  for (const k of open) {
    const c = CLASS_OF[k] as ReactionClass;
    priorClass[c] += (prior[k] ?? 0) / openMass;
    postClass[c] += postN[k];
  }

  // hold each class inside the band its parameter's range allows
  let bounded: Record<ReactionClass, number> = { ...postClass };
  for (let pass = 0; pass < 3; pass++) {
    for (const c of REACTION_CLASSES) {
      if (priorClass[c] <= 0) {
        bounded[c] = 0;
        continue;
      }
      const p = param(params, ROW_KEYS[dominant][c]);
      let lo = 1 - band;
      let hi = 1 + band;
      if (p.range && p.value > 0) {
        lo = Math.min(1, p.range[0] / p.value);
        hi = Math.max(1, p.range[1] / p.value);
      }
      bounded[c] = Math.min(priorClass[c] * hi, Math.max(priorClass[c] * lo, bounded[c]));
    }
    bounded = normalise(bounded);
  }

  const out: Partial<Record<ManStance, number>> = {};
  if (fixed > 0) out.escalate = fixed;
  for (const k of open) {
    const c = CLASS_OF[k] as ReactionClass;
    const within = postClass[c] > 0 ? postN[k] / postClass[c] : 0;
    out[k] = bounded[c] * within * openMass;
  }
  return out;
}

function noChange(state: WomanState, strategy: WomanStrategy = 'unclear'): WomanOutput {
  return {
    state,
    decision: null,
    fear: state.fear,
    tension: state.tension,
    strategy,
    strategyProbs: completeProbs(undefined, strategy),
    stanceProbs: {},
    priorProbs: {},
    speak: false,
    delivery: 'normal',
    drivers: [],
  };
}

function rationaleFrom(text: string, list: Param[]): Rationale {
  const sourceIds: string[] = [];
  for (const p of list) for (const s of p.sourceIds) if (!sourceIds.includes(s)) sourceIds.push(s);
  return { text, basis: weakestBasis(list), sourceIds };
}

/** How far behind he has to be for her to get indoors unseen. */
export const FAR_BEHIND_METRES = 14;

export function decideWoman(state0: WomanState, input: WomanInput, rng: Rng, params: Params = PARAMS): WomanOutput {
  const state: WomanState = { ...state0 };
  const { event, ctx } = input;
  if (state.ended) return noChange(state);

  const ph = physical(event, ctx);
  const elapsed = Number.isFinite(ctx.elapsed) ? ctx.elapsed : 0;

  /* ---- scene-ending places ------------------------------------------------ */
  if (event === 'reached_home') {
    const alone = state.stance === 'idle' || state.stance === 'gone' || state.stance === 'back_off' || ph.distance > FAR_BEHIND_METRES;
    state.ended = alone ? 'reached_home_alone' : 'reached_home_followed';
    state.fear = alone ? Math.min(state.fear, 0.25) : Math.max(state.fear, 0.8);
    return { ...noChange(state, 'ignore'), fear: state.fear, outcome: state.ended };
  }
  if (event === 'entered_shop') {
    const p = param(params, 'response.seek_refuge.p_back_off');
    state.ended = 'took_refuge';
    const present = state.stance !== 'idle' && state.stance !== 'gone';
    state.fear = Math.min(state.fear, 0.5);
    state.tension = Math.min(state.tension, 0.3);
    const out = noChange(state, 'seek_help');
    if (present) {
      state.stance = 'back_off';
      out.decision = { stance: 'back_off', action: 'stay', emotion: 'annoyed', emotionIntensity: 0.5, proximity: 4 };
      out.rationale = rationaleFrom(
        'When she went into the shop he hung back: reaching other people is the most reliable way these encounters end.',
        [p],
      );
      out.drivers = [p.key];
    }
    return { ...out, state, fear: state.fear, tension: state.tension, outcome: 'took_refuge' };
  }

  /* ---- the opening call-out ------------------------------------------------ */
  if (state.stance === 'idle') {
    if (event !== 'begin' && event !== 'speech' && strategyForEvent(event) === null) return noChange(state);
    state.stance = 'opening';
    state.turn = 1;
    state.startedAt = elapsed;
    state.fear = Math.max(state.fear, STANCE_FEAR.opening);
    state.tension = STANCE_TENSION.opening;
    const { action, proximity, delivery } = actionFor('opening', ph, rng);
    const face = pickEmotion('opening', 'ignore', state, rng);
    const wants = param(params, 'man.disposition.wants_friendly_response');
    return {
      state,
      decision: { stance: 'opening', action, emotion: face.emotion, emotionIntensity: face.intensity, proximity },
      fear: state.fear,
      tension: state.tension,
      rationale: rationaleFrom(
        'He opens by calling out to her as if it were a compliment: most men who do this say they are hoping for a smile or a conversation.',
        [wants],
      ),
      strategy: 'ignore',
      strategyProbs: completeProbs(undefined, 'ignore'),
      stanceProbs: { opening: 1 },
      priorProbs: { opening: 1 },
      speak: true,
      delivery,
      drivers: [wants.key],
    };
  }
  if (event === 'begin') return noChange(state);

  /* ---- he has already left ------------------------------------------------ */
  if (state.stance === 'gone' || state.stance === 'escalate') return noChange(state);

  /* ---- how she responded -------------------------------------------------- */
  const eventStrategy = strategyForEvent(event);
  if (event !== 'speech' && eventStrategy === null) return noChange(state);
  const strategyProbs = completeProbs(event === 'speech' ? input.strategyProbs : undefined, eventStrategy ?? 'unclear');
  const strategy = argmax(strategyProbs);
  const insultSignal = clamp01(input.signals?.insult ?? 0);
  const insulted = strategyProbs.hostile >= 0.5 || (insultSignal >= 0.6 && strategyProbs.hostile >= 0.2);
  const encounterSeconds = Math.max(0, elapsed - (state.startedAt ?? elapsed));

  /* ---- he had given up: does he keep walking? ----------------------------- */
  if (state.stance === 'back_off') {
    const reengage = param(params, 'model.dynamics.reengage_after_insult');
    const scale = state.disposition === 'mild' ? 0.5 : 1;
    if (insulted && !ph.across && rng.chance(reengage.value * scale)) {
      state.stance = 'hostile';
      state.turn += 1;
      state.exchanges += 1;
      state.insults += 1;
      state.rejections += 1;
      state.hostileTurns = 1;
      state.frustration = clamp01(state.frustration + val(params, FRUSTRATION_KEY.hostile));
      state.tension = clamp01(STANCE_TENSION.hostile + 0.4 * state.frustration);
      state.fear = clamp01(Math.max(state.fear, STANCE_FEAR.hostile));
      state.lastDriver = reengage.key;
      const face = pickEmotion('hostile', strategy, state, rng);
      return {
        state,
        decision: { stance: 'hostile', action: 'stay', emotion: face.emotion, emotionIntensity: face.intensity, proximity: 3 },
        fear: state.fear,
        tension: state.tension,
        rationale: rationaleFrom('He was walking away, heard the insult and turned back to throw one of his own.', [reengage]),
        strategy,
        strategyProbs,
        stanceProbs: { hostile: round3(reengage.value * scale), gone: round3(1 - reengage.value * scale) },
        priorProbs: { hostile: round3(reengage.value * scale), gone: round3(1 - reengage.value * scale) },
        speak: true,
        delivery: 'shout',
        drivers: [reengage.key],
      };
    }
    state.stance = 'gone';
    state.turn += 1;
    state.hostileTurns = 0;
    state.tension = 0;
    state.fear = Math.min(state.fear, 0.4);
    const driver = state.lastDriver ? params.get(state.lastDriver) : undefined;
    return {
      state,
      decision: { stance: 'gone', action: 'leave', emotion: 'neutral', emotionIntensity: 0.3, proximity: 3 },
      fear: state.fear,
      tension: 0,
      rationale: rationaleFrom('He has given up and is walking back the way she came.', driver ? [driver] : []),
      strategy,
      strategyProbs,
      stanceProbs: { gone: 1 },
      priorProbs: { gone: 1 },
      speak: false,
      delivery: 'normal',
      drivers: driver ? [driver.key] : [],
    };
  }

  /* ---- the reaction ------------------------------------------------------- */
  const maxSeconds = val(params, 'model.session.max_seconds');
  const forced = encounterSeconds >= maxSeconds || state.turn >= 40;

  const cls = classDistribution(
    strategyProbs,
    {
      disposition: state.disposition,
      exchanges: state.exchanges,
      frustration: state.frustration,
      stance: state.stance,
      encounterSeconds,
      across: ph.across,
      far: ph.far,
    },
    params,
  );

  // how "keeps going" looks this time
  const pEngage = strategyProbs.engage;
  const pRefusal = strategyProbs.polite_deflect + strategyProbs.firm_boundary;
  const followBase = val(params, 'base.incident_involves_following');
  const blockBase = val(params, 'model.persist.share_block');
  const guiltBase = val(params, 'model.persist.share_guilt');
  const canBlock =
    state.blocks < val(params, 'model.persist.block_max') && state.stance !== 'block' && !ph.across && ph.distance < 7 && event !== 'pushed_past';
  const sub = normalise<'persist' | 'guilt' | 'follow' | 'block'>({
    follow:
      followBase *
      (ph.moving || ph.evading ? val(params, 'model.persist.moving_follow_boost') : 1) *
      (ph.stopped ? 0.2 : 1) *
      (1 - 0.6 * pEngage),
    block: canBlock
      ? blockBase * (ph.evading ? val(params, 'model.persist.evade_block_boost') : 1) * (ph.stopped ? 0.3 : 1) * (1 - 0.7 * pEngage) * (state.exchanges < 1 ? 0.5 : 1)
      : 0,
    guilt: guiltBase * (1 + (val(params, 'model.persist.refusal_guilt_boost') - 1) * pRefusal) * (1 - 0.85 * pEngage),
    persist:
      Math.max(0.05, 1 - followBase - blockBase - guiltBase) *
      (1 + (val(params, 'model.persist.engage_talk_boost') - 1) * pEngage) *
      (ph.stopped ? 1.3 : 1) *
      (ph.across ? 0.6 : 1),
  });

  let prior: Partial<Record<ManStance, number>> = {
    back_off: cls.back_off,
    persist: cls.persist * sub.persist,
    guilt: cls.persist * sub.guilt,
    follow: cls.persist * sub.follow,
    block: cls.persist * sub.block,
    hostile: cls.hostile,
    intimidate: cls.intimidate,
  };

  // physical escalation: rare, never early, only from a man who is already hostile
  const wasHostile = state.stance === 'hostile' || state.stance === 'intimidate';
  let pEscalate = 0;
  if (wasHostile && state.turn + 1 >= val(params, 'model.escalation.min_turn')) {
    const dispFactor =
      state.disposition === 'volatile'
        ? val(params, 'model.escalation.volatile_factor')
        : state.disposition === 'mild'
          ? val(params, 'model.escalation.mild_factor')
          : 1;
    pEscalate = Math.min(
      val(params, 'model.escalation.cap'),
      val(params, 'model.escalation.hazard') *
        dispFactor *
        (1 + val(params, 'model.escalation.insult_gain') * Math.min(3, state.insults + (insulted ? 1 : 0))) *
        (state.stance === 'intimidate' ? val(params, 'model.escalation.intimidate_factor') : 1) *
        (ph.across || ph.distance > 4 ? val(params, 'model.dynamics.far_factor') : 1),
    );
  }
  if (forced) {
    prior = { back_off: 1 };
    pEscalate = 0;
  } else if (pEscalate > 0) {
    for (const k of Object.keys(prior) as ManStance[]) prior[k] = (prior[k] ?? 0) * (1 - pEscalate);
    prior.escalate = pEscalate;
  }

  const posterior = forced ? prior : blendWithReading(prior, event === 'speech' ? input.reaction : undefined, strategy, params);
  const sampled = rng.sample<ManStance>(posterior as Record<ManStance, number>);
  const next = forced
    ? sampled
    : gateStance(state.stance, sampled, {
        text: input.text ?? '',
        turn: state.turn,
        rejections: state.rejections,
        bystander: false,
        seekingHelp: strategy === 'seek_help' || strategy === 'threaten_attention',
        clearFirm: isClearFirm(input.text ?? ''),
        insult: strategy === 'hostile',
      });

  /* ---- bookkeeping -------------------------------------------------------- */
  let gain = 0;
  for (const s of WOMAN_STRATEGIES) gain += strategyProbs[s] * val(params, FRUSTRATION_KEY[s]);
  if (state.disposition === 'volatile') gain *= 1.3;
  state.frustration = clamp01(state.frustration + gain);
  state.exchanges += 1;
  state.turn += 1;
  if (strategyProbs.firm_boundary + strategyProbs.hostile + strategyProbs.threaten_attention >= 0.5) state.rejections += 1;
  if (insulted) state.insults += 1;
  if (next === 'follow') state.hasFollowed = true;
  if (next === 'block') {
    state.hasBlocked = true;
    state.blocks += 1;
  }
  state.hostileTurns = next === 'hostile' || next === 'intimidate' ? state.hostileTurns + 1 : 0;
  state.stance = next;

  const { action, proximity, delivery } = actionFor(next, ph, rng);
  state.tension = next === 'escalate' ? 1 : clamp01(STANCE_TENSION[next] + 0.4 * state.frustration);
  const face = pickEmotion(next, strategy, state, rng);
  const closeBonus = ph.distance < 1.6 && next !== 'back_off' ? 0.06 : 0;
  const wear = Math.min(0.12, 0.025 * state.exchanges) + (state.hasFollowed ? 0.04 : 0);
  state.fear =
    next === 'escalate'
      ? 1
      : next === 'back_off'
        ? clamp01(Math.max(STANCE_FEAR.back_off, state.fear - 0.2))
        : clamp01(Math.max(state.fear - 0.08, STANCE_FEAR[next] + closeBonus + wear));

  /* ---- why --------------------------------------------------------------- */
  let rationale: Rationale;
  let drivers: string[];
  if (next === 'escalate') {
    const list = [param(params, 'base.physical_escalation_per_run'), param(params, 'model.escalation.hazard')];
    if (state.insults > 0) list.push(param(params, 'model.escalation.insult_gain'));
    rationale = rationaleFrom(
      'His anger tipped over into grabbing at her: this is rare, and it came from his temper, not from anything she chose.',
      list,
    );
    drivers = list.map((p) => p.key);
    state.ended = 'escalated';
  } else if (forced) {
    const p = param(params, 'model.session.max_seconds');
    rationale = rationaleFrom('He ran out of steam: after this long with nothing to show for it, he gave up.', [p]);
    drivers = [p.key];
  } else {
    const c = CLASS_OF[next] as ReactionClass;
    const cell = param(params, ROW_KEYS[strategy][c]);
    const list: Param[] = [cell];
    drivers = [cell.key];
    if (next === 'follow') {
      list.push(param(params, 'base.incident_involves_following'));
      drivers.push('base.incident_involves_following');
    } else if (next === 'block') {
      list.push(param(params, 'model.persist.share_block'));
      drivers.push('model.persist.share_block');
    } else if (next === 'guilt') {
      drivers.push('model.persist.share_guilt');
    }
    const dispKey = `model.disposition.${state.disposition}.${c}`;
    drivers.push(dispKey);
    if ((c === 'hostile' || c === 'intimidate') && state.frustration - gain > 0.2) drivers.push('model.dynamics.frustration_gain');
    if (c === 'back_off' && state.exchanges === 1) drivers.push('model.scenario.pushiness_first_response');
    rationale = rationaleFrom(rationaleText(next, herPhrase(event, strategy)), list);
  }
  state.lastDriver = drivers[0] ?? null;

  const followSilent = next === 'follow' && event !== 'speech' && rng.chance(val(params, 'model.persist.follow_silent'));

  return {
    state,
    decision: {
      stance: next,
      action,
      emotion: face.emotion,
      emotionIntensity: face.intensity,
      proximity,
    },
    fear: round3(state.fear),
    tension: round3(state.tension),
    rationale,
    strategy,
    strategyProbs,
    stanceProbs: roundProbs(posterior),
    priorProbs: roundProbs(prior),
    outcome: next === 'escalate' ? 'escalated' : undefined,
    speak: !followSilent,
    delivery,
    drivers,
  };
}

function roundProbs(p: Partial<Record<ManStance, number>>): Partial<Record<ManStance, number>> {
  const out: Partial<Record<ManStance, number>> = {};
  for (const [k, v] of Object.entries(p) as [ManStance, number][]) if (v > 0) out[k] = round3(v);
  return out;
}
