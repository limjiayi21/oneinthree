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
import { decideExpression, type ExpressionDecision } from './expression';
import { PARAMS, param, val, weakestBasis, type Param, type Params } from './params';
import { Rng, clamp01, normalise, round3 } from './rng';
import { LEVELS, MAX_LEVEL, applyStep, ladderKey, openingLevel, stanceForLevel, stepDistribution, type Step } from './ladder';
import { GOLDEN_OPENING_LEVEL, goldenNext, type GoldenPath } from './golden';

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
  /** His escalation ladder level, 0 (calm) to 6 (threatening). See worker/model/ladder.ts. */
  level: number;
  peakLevel: number;
  /** Golden run (worker/model/golden.ts): levels held to the reference script. */
  golden?: boolean;
  goldenPath?: GoldenPath | null;
}

export interface WomanInput {
  event: ClientEventType;
  ctx: WorldContext;
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
  /** His ladder level after this decision, and before it. */
  level: number;
  levelFrom: number;
  /** The ladder step taken and the distribution it was drawn from (reactions to her only). */
  step?: Step;
  stepProbs?: Record<Step, number>;
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

export function initialWomanState(disposition: Disposition, opts: { golden?: boolean } = {}): WomanState {
  return {
    ...(opts.golden ? { golden: true, goldenPath: null } : {}),
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
    level: 0,
    peakLevel: 0,
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
      return { action: 'follow_behind', proximity: 2.8, delivery: ph.distance > 4 ? 'call_out' : 'normal' };
    case 'block':
      return { action: 'block_path', proximity: 1.1, delivery: 'normal' };
    case 'hostile':
      // Angry and far away: he comes after her (shouting as he goes) rather than standing and yelling across the street.
      if (ph.far || ph.across) return { action: ph.moving ? 'follow_behind' : 'approach', proximity: 2.4, delivery: 'shout' };
      if (ph.hurrying) return { action: 'follow_behind', proximity: 2.4, delivery: 'shout' };
      return { action: rng.chance(0.35) ? 'step_closer' : 'stay', proximity: 1.4, delivery: 'normal' };
    case 'intimidate':
      return { action: rng.chance(0.5) ? 'lean_in' : 'step_closer', proximity: 0.8, delivery: 'low' };
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
    level: state.level,
    levelFrom: state.level,
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
      out.decision = { stance: 'back_off', action: 'stay', emotion: 'annoyed', emotionIntensity: 0.5, proximity: 4, level: state.level };
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
    state.level = state.golden ? GOLDEN_OPENING_LEVEL : openingLevel(state.disposition);
    state.peakLevel = state.level;
    state.fear = Math.max(state.fear, STANCE_FEAR.opening);
    state.tension = STANCE_TENSION.opening;
    const { action, proximity, delivery } = actionFor('opening', ph, rng);
    const face = pickEmotion('opening', 'ignore', state, rng);
    const wants = param(params, 'man.disposition.wants_friendly_response');
    return {
      state,
      decision: { stance: 'opening', action, emotion: face.emotion, emotionIntensity: face.intensity, proximity, level: state.level },
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
      level: state.level,
      levelFrom: 0,
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
      // Turning back is an ordinary two-level jump from where he was, never more.
      const levelFrom = state.level;
      state.level = Math.min(MAX_LEVEL - 1, state.level + 2);
      state.stance = state.level >= 4 ? 'hostile' : 'guilt';
      state.peakLevel = Math.max(state.peakLevel, state.level);
      state.turn += 1;
      state.exchanges += 1;
      state.insults += 1;
      state.rejections += 1;
      state.hostileTurns = 1;
      state.frustration = clamp01(state.frustration + val(params, FRUSTRATION_KEY.hostile));
      state.tension = clamp01(state.level / MAX_LEVEL);
      state.fear = clamp01(Math.max(state.fear, LEVEL_FEAR[state.level]));
      state.lastDriver = reengage.key;
      const face = pickEmotion(state.stance, strategy, state, rng);
      return {
        state,
        decision: { stance: state.stance, action: 'stay', emotion: face.emotion, emotionIntensity: face.intensity, proximity: 3, level: state.level },
        fear: state.fear,
        tension: state.tension,
        rationale: rationaleFrom(`He was walking away, heard the insult and turned back to throw one of his own (level ${levelFrom} → ${state.level}).`, [reengage]),
        strategy,
        strategyProbs,
        stanceProbs: { hostile: round3(reengage.value * scale), gone: round3(1 - reengage.value * scale) },
        priorProbs: { hostile: round3(reengage.value * scale), gone: round3(1 - reengage.value * scale) },
        speak: true,
        delivery: 'shout',
        drivers: [reengage.key],
        level: state.level,
        levelFrom,
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
      decision: { stance: 'gone', action: 'leave', emotion: 'neutral', emotionIntensity: 0.3, proximity: 3, level: state.level },
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
      level: state.level,
      levelFrom: state.level,
    };
  }

  /* ---- the reaction: one step on his escalation ladder -------------------- */
  const maxSeconds = val(params, 'model.session.max_seconds');
  // The golden run is rehearsed at the player's pace: no time limit.
  const forced = !state.golden && (encounterSeconds >= maxSeconds || state.turn >= 40);
  const levelFrom = state.level;

  const stepProbs: Record<Step, number> = forced
    ? { down: 0, stay: 0, up: 0, jump: 0, leave: 1 }
    : stepDistribution(
        strategyProbs,
        { level: state.level, disposition: state.disposition, turn: state.turn, encounterSeconds, distant: ph.across || ph.far, exchanges: state.exchanges },
        params,
      );
  let step = rng.sample<Step>(stepProbs);
  let level = applyStep(state.level, step);
  if (state.golden) {
    // Held to the script: he never leaves on his own, and the level comes from docs/golden-run.md.
    const g = goldenNext({ level: state.level, exchanges: state.exchanges + 1, path: state.goldenPath ?? null, event, strategy });
    state.goldenPath = g.path;
    level = g.level;
    const delta = level - state.level;
    step = delta >= 2 ? 'jump' : delta === 1 ? 'up' : delta < 0 ? 'down' : 'stay';
  }
  // Carrying on after she has said no is, by definition, at least level 2 ("pushy: ignores the hint"),
  // whatever the step: a man who keeps chatting after "leave me alone" is not calm. Still never more than +2.
  const refused = refusalShare(strategyProbs) > 0.5;
  const floored = !state.golden && refused && step !== 'leave' && level < REFUSAL_FLOOR;
  if (floored) level = Math.min(REFUSAL_FLOOR, levelFrom + 2);
  const canBlock =
    state.blocks < val(params, 'model.persist.block_max') && state.stance !== 'block' && !ph.across && ph.distance < 7 && event !== 'pushed_past';
  const next: ManStance = step === 'leave' ? 'back_off' : stanceForLevel(level, ph, canBlock);

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
  state.level = level;
  state.peakLevel = Math.max(state.peakLevel, level);

  const { action, proximity, delivery } = actionFor(next, ph, rng);
  state.tension = next === 'escalate' ? 1 : next === 'back_off' ? STANCE_TENSION.back_off : clamp01(level / MAX_LEVEL);
  let face = pickEmotion(next, strategy, state, rng);
  // After she says no and he carries on (or walks off), his face shows that he minded: not a smile.
  if ((refused || (next === 'back_off' && levelFrom >= 3)) && next !== 'escalate' && ['friendly', 'smirk', 'leer', 'neutral', 'sheepish'].includes(face.emotion)) {
    face = { ...face, emotion: 'annoyed', intensity: Math.max(face.intensity, 0.45 + 0.08 * level) };
  }
  const closeBonus = ph.distance < 1.6 && next !== 'back_off' ? 0.06 : 0;
  const wear = Math.min(0.12, 0.025 * state.exchanges) + (state.hasFollowed ? 0.04 : 0);
  state.fear =
    next === 'escalate'
      ? 1
      : next === 'back_off'
        ? clamp01(Math.max(STANCE_FEAR.back_off, state.fear - 0.2))
        : clamp01(Math.max(state.fear - 0.08, LEVEL_FEAR[level] + closeBonus + wear));

  /* ---- why --------------------------------------------------------------- */
  let rationale: Rationale;
  let drivers: string[];
  if (next === 'escalate') {
    const list = [param(params, 'base.physical_escalation_per_run'), param(params, 'model.ladder.cross_to_threat')];
    rationale = rationaleFrom(
      'His anger tipped over into reaching for her: this is rare, and it came from his temper, not from anything she chose.',
      list,
    );
    drivers = list.map((p) => p.key);
    state.ended = 'escalated';
  } else if (forced) {
    const p = param(params, 'model.session.max_seconds');
    rationale = rationaleFrom('He ran out of steam: after this long with nothing to show for it, he gave up.', [p]);
    drivers = [p.key];
  } else {
    const row = param(params, ladderKey(strategy, step));
    const list: Param[] = [row];
    drivers = [row.key, `model.ladder.disposition.${state.disposition}.${step === 'stay' ? 'up' : step}`];
    if (next === 'follow') {
      list.push(param(params, 'base.incident_involves_following'));
      drivers.push('base.incident_involves_following');
    } else if (next === 'block') {
      list.push(param(params, 'base.incident_involves_path_interference'));
      drivers.push('base.incident_involves_path_interference');
    }
    rationale = rationaleFrom(
      floored
        ? `After ${herPhrase(event, strategy)}, he ignored her no and kept going: that alone makes him pushy (level ${levelFrom} → ${level}).`
        : ladderText(step, herPhrase(event, strategy), levelFrom, level),
      list,
    );
  }
  state.lastDriver = drivers[0] ?? null;

  const followSilent = next === 'follow' && event !== 'speech' && rng.chance(val(params, 'model.persist.follow_silent'));
  const stanceProbs: Partial<Record<ManStance, number>> = {};
  for (const st of ['down', 'stay', 'up', 'jump', 'leave'] as Step[]) {
    if (!stepProbs[st]) continue;
    const k = st === 'leave' ? 'back_off' : stanceForLevel(applyStep(levelFrom, st), ph, canBlock);
    stanceProbs[k] = (stanceProbs[k] ?? 0) + stepProbs[st];
  }

  return {
    state,
    decision: {
      stance: next,
      action,
      emotion: face.emotion,
      emotionIntensity: face.intensity,
      proximity,
      level,
    },
    fear: round3(state.fear),
    tension: round3(state.tension),
    rationale,
    strategy,
    strategyProbs,
    stanceProbs: roundProbs(stanceProbs),
    priorProbs: roundProbs(stanceProbs),
    outcome: next === 'escalate' ? 'escalated' : undefined,
    speak: !followSilent,
    delivery,
    drivers,
    level,
    levelFrom,
    step,
    stepProbs: roundStep(stepProbs),
  };
}

/** Ignoring a no is level 2 by the ladder's own definition. */
const REFUSAL_FLOOR = 2;

/** How sure the reading is that she refused him (in any way, from polite to insulting). */
function refusalShare(p: Record<WomanStrategy, number>): number {
  return p.polite_deflect + p.firm_boundary + p.hostile + p.excuse + p.threaten_attention + p.seek_help + p.plead;
}

/** Her fear at each of his levels (before closeness and wear are added). */
const LEVEL_FEAR = [0.3, 0.4, 0.5, 0.58, 0.74, 0.88, 1];

/** One plain sentence for the debrief: what she did, what he did, and where that left him on the ladder. */
export function ladderText(step: Step, phrase: string, from: number, to: number): string {
  const where = step === 'leave' ? '' : ` (${LEVELS[from].name.toLowerCase()} → ${LEVELS[to].name.toLowerCase()}, level ${from} → ${to})`;
  switch (step) {
    case 'leave':
      return `After ${phrase}, he gave up and turned away.`;
    case 'down':
      return `After ${phrase}, he eased off a little${where}.`;
    case 'stay':
      return `After ${phrase}, he kept on as he was${where}.`;
    case 'up':
      return `After ${phrase}, he pushed harder${where}.`;
    case 'jump':
      return `After ${phrase}, he was set off and jumped two levels${where}.`;
  }
}

function roundStep(p: Record<Step, number>): Record<Step, number> {
  return { down: round3(p.down), stay: round3(p.stay), up: round3(p.up), jump: round3(p.jump), leave: round3(p.leave) };
}

function roundProbs(p: Partial<Record<ManStance, number>>): Partial<Record<ManStance, number>> {
  const out: Partial<Record<ManStance, number>> = {};
  for (const [k, v] of Object.entries(p) as [ManStance, number][]) if (v > 0) out[k] = round3(v);
  return out;
}
