/**
 * A turn judge in front of the seeded stance machine.
 *
 * Two providers share one reading. Code, not the provider, decides the beat
 * the trainee sees: a firm boundary plus a bystander makes him back off, and
 * neither provider is allowed to invent a physical escalation. If the provider
 * is unset, slow, or wrong, the seeded decision is what plays.
 *
 * TypeSafe System One (Jev): POST https://api.typesafe.ai/v1/systemone
 *   model jev-1.14.0, Authorization: Bearer. Yes/no questions are `noul`
 *   (there is no predicate type). Choice criteria is a map. Score criteria is
 *   an ordered list whose index is the score.
 *   https://docs.typesafe.ai/api/system-one
 *
 * OpenAI Decisions: POST https://api.openai.com/v1/decisions
 *   model gpt-6-luna, Authorization: Bearer. Predicate, choice, and score
 *   questions are an array. Score levels are ordered objects.
 *   https://developers.openai.com/api/docs/guides/decisions
 */
import type { Emotion, ManAction, ManDecision, ManStance, Pov, WorldContext } from '../shared/types';
import { clampSuggestedExpression } from '../shared/expression';

export const JUDGE_BUDGET_MS = 400;
export const TYPESAFE_MODEL = 'jev-1.14.0';
export const OPENAI_MODEL = 'gpt-6-luna';
export const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';
export const OPENAI_URL = 'https://api.openai.com/v1/decisions';

export type JudgeName = 'typesafe' | 'openai';
export type Tone = 'calm' | 'firm' | 'scared' | 'hostile' | 'joking' | 'silent';

const TONES: Tone[] = ['calm', 'firm', 'scared', 'hostile', 'joking', 'silent'];
const EXPRESSIONS = ['neutral', 'smug', 'annoyed', 'angry', 'nervous', 'scared', 'backing_off'] as const;
export type ProviderExpression = (typeof EXPRESSIONS)[number];

const STANCES: ManStance[] = ['idle', 'opening', 'persist', 'follow', 'block', 'guilt', 'hostile', 'intimidate', 'back_off', 'gone', 'escalate'];

const STANCE_NOTE: Record<ManStance, string> = {
  idle: 'He has not engaged.',
  opening: 'He is calling out for the first time.',
  persist: 'He keeps talking and will not take the hint.',
  follow: 'He trails after her.',
  block: 'He has stepped into her path.',
  guilt: 'He acts wounded and blames her for being rude.',
  hostile: 'He has turned to insults.',
  intimidate: 'He is close, quiet, and menacing. No blow is described.',
  back_off: 'He is giving up.',
  gone: 'He has left.',
  escalate: 'The scene is about to cut away. Do not describe violence.',
};

const EXPRESSION_EMOTION: Record<ProviderExpression, Emotion> = {
  neutral: 'neutral',
  smug: 'smirk',
  annoyed: 'annoyed',
  angry: 'angry',
  nervous: 'worried',
  scared: 'afraid',
  backing_off: 'sheepish',
};

const ACTION_FOR: Record<ManStance, ManAction> = {
  idle: 'stay',
  opening: 'approach',
  persist: 'stay',
  follow: 'follow_behind',
  block: 'block_path',
  guilt: 'stay',
  hostile: 'stay',
  intimidate: 'step_closer',
  back_off: 'back_away',
  gone: 'leave',
  escalate: 'grab',
};

export interface JudgeInput {
  pov: Pov;
  event: string;
  stance: ManStance;
  text: string;
  recent: string[];
  ctx: WorldContext;
}

export interface TurnReading {
  provider: JudgeName;
  firmBoundary: number;
  bystander: number;
  tone: Tone;
  stance: ManStance | null;
  expression: ProviderExpression | null;
  /** 0..1, from the ordered escalation rubric. */
  escalation: number;
}

export interface JudgeEnv {
  DECISION_PROVIDER?: string;
  TYPESAFE_API_KEY?: string;
  OPENAI_API_KEY?: string;
}

export function selectJudge(env: JudgeEnv): JudgeName | null {
  const name = (env.DECISION_PROVIDER ?? '').trim().toLowerCase();
  if (name === 'typesafe' && env.TYPESAFE_API_KEY) return 'typesafe';
  if (name === 'openai' && env.OPENAI_API_KEY) return 'openai';
  return null;
}

export function sceneState(input: JudgeInput): string {
  const recent = input.recent.slice(-4).join(' | ') || '(none)';
  const said = input.text.trim() || '(silence)';
  return [
    'Night street in New York. A woman is walking home. A man she does not know is harassing her. This is a training simulation: nothing graphic is shown.',
    `Point of view: ${input.pov}. Event: ${input.event}.`,
    `His stance now: ${input.stance}. ${STANCE_NOTE[input.stance]}`,
    `Distance: ${Math.round(input.ctx.distanceToMan)} m. Bystander filming: ${Boolean(input.ctx.filming)}. Between them: ${Boolean(input.ctx.betweenThem)}.`,
    `Recent: ${recent}`,
    `The player just said: ${said}`,
  ].join('\n');
}

const TONE_CRITERIA: Record<Tone, string> = {
  calm: 'Even, unruffled, or friendly.',
  firm: 'A clear boundary without insulting him.',
  scared: 'Frightened, pleading, or shaky.',
  hostile: 'Insults him or swears at him.',
  joking: 'Laughs it off or teases.',
  silent: 'No real words, or only a filler sound.',
};

const EXPRESSION_CRITERIA: Record<ProviderExpression, string> = {
  neutral: 'A blank, ordinary face.',
  smug: 'Cocky, pleased with himself.',
  annoyed: 'Irritated, not yet shouting.',
  angry: 'Openly angry. No violence.',
  nervous: 'Unsure, caught off guard.',
  scared: 'He is the one who is rattled.',
  backing_off: 'Giving up, face saving, leaving.',
};

export function typesafeBody(input: JudgeInput): Record<string, unknown> {
  return {
    model: TYPESAFE_MODEL,
    state: sceneState(input),
    questions: {
      firm_boundary: { type: 'noul', instructions: 'Did the player just set a firm boundary: tell him to stop, leave her alone, or back off, without merely chatting?' },
      bystander: { type: 'noul', instructions: 'Did a bystander just intervene: speak up, film, step between them, or fetch the shopkeeper?' },
      tone: { type: 'choice', instructions: 'What is the player’s tone on this turn?', criteria: TONE_CRITERIA },
      stance: { type: 'choice', instructions: 'Which stance should the man take next? Do not pick escalate unless he was already menacing and is about to be cut away from.', criteria: STANCE_NOTE },
      expression: { type: 'choice', instructions: 'Which face matches the line he is about to say?', criteria: EXPRESSION_CRITERIA },
      escalation: {
        type: 'score',
        instructions: 'How heated is this beat? The top of the scale is the moment the simulation would cut to black, not a description of violence.',
        criteria: ['He is only talking.', 'He is pressing and ignoring a no.', 'He is insulting her.', 'He is close and menacing.', 'The scene should cut away.'],
      },
    },
  };
}

export function openaiBody(input: JudgeInput): Record<string, unknown> {
  const choice = (name: string, instructions: string, criteria: Record<string, string>) => ({
    type: 'choice',
    name,
    instructions,
    choices: Object.entries(criteria).map(([value, description]) => ({ value, description })),
  });
  return {
    model: OPENAI_MODEL,
    input: sceneState(input),
    questions: [
      { type: 'predicate', name: 'firm_boundary', instructions: 'The player just set a firm boundary: told him to stop, leave her alone, or back off.' },
      { type: 'predicate', name: 'bystander', instructions: 'A bystander just intervened: spoke up, filmed, stepped between them, or fetched the shopkeeper.' },
      choice('tone', 'What is the player’s tone on this turn?', TONE_CRITERIA),
      choice('stance', 'Which stance should the man take next? Do not pick escalate unless the scene is already about to cut away.', STANCE_NOTE),
      choice('expression', 'Which face matches the line he is about to say?', EXPRESSION_CRITERIA),
      {
        type: 'score',
        name: 'escalation',
        instructions: 'How heated is this beat, from talk up to the moment the simulation cuts to black?',
        levels: [
          { label: 'talk', description: 'He is only talking.' },
          { label: 'pressing', description: 'He is pressing and ignoring a no.' },
          { label: 'insulting', description: 'He is insulting her.' },
          { label: 'menacing', description: 'He is close and menacing.' },
          { label: 'cut', description: 'The scene should cut away. Do not describe violence.' },
        ],
      },
    ],
  };
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
}

function asStance(value: unknown): ManStance | null {
  return typeof value === 'string' && (STANCES as string[]).includes(value) ? (value as ManStance) : null;
}

function asTone(value: unknown): Tone {
  return typeof value === 'string' && (TONES as string[]).includes(value) ? (value as Tone) : 'silent';
}

function asExpression(value: unknown): ProviderExpression | null {
  return typeof value === 'string' && (EXPRESSIONS as readonly string[]).includes(value) ? (value as ProviderExpression) : null;
}

export function parseTypesafe(body: unknown): Omit<TurnReading, 'provider'> | null {
  const answers = (body as { answers?: Record<string, Record<string, unknown>> } | null)?.answers;
  if (!answers) return null;
  const firm = answers.firm_boundary;
  const by = answers.bystander;
  const tone = answers.tone;
  const stance = answers.stance;
  const expression = answers.expression;
  const escalation = answers.escalation;
  if (!firm || !tone || !stance || !expression || !escalation) return null;
  return {
    firmBoundary: clamp01(Number(firm.noul)),
    bystander: clamp01(Number(by?.noul ?? 0)),
    tone: asTone(tone.choice),
    stance: asStance(stance.choice),
    expression: asExpression(expression.choice),
    escalation: clamp01(Number(escalation.score) / 4),
  };
}

export function parseOpenai(body: unknown): Omit<TurnReading, 'provider'> | null {
  const answers = (body as { answers?: Array<Record<string, unknown>> } | null)?.answers;
  if (!Array.isArray(answers)) return null;
  const byName = new Map(answers.map((a) => [String(a.name), a]));
  const firm = byName.get('firm_boundary');
  const by = byName.get('bystander');
  const tone = byName.get('tone');
  const stance = byName.get('stance');
  const expression = byName.get('expression');
  const escalation = byName.get('escalation');
  if (!firm || !tone || !stance || !expression || !escalation) return null;
  return {
    firmBoundary: clamp01(Number(firm.probability)),
    bystander: clamp01(Number(by?.probability ?? 0)),
    tone: asTone(tone.choice),
    stance: asStance(stance.choice),
    expression: asExpression(expression.choice),
    escalation: clamp01(Number(escalation.score) / 4),
  };
}

export interface SeededBeat {
  stance: ManStance;
  emotion: Emotion;
  emotionIntensity: number;
  action: ManAction;
  tension: number;
}

export interface ComposedBeat extends SeededBeat {
  /** Set when a training rule replaced the provider’s stance. */
  rule: string | null;
  provider: JudgeName | 'seeded';
}

/**
 * The provider may suggest. These rules are what the trainee actually gets.
 * A firm boundary together with a bystander makes him leave. Physical
 * escalation is kept only when the seeded model had already reached it.
 */
export function composeBeat(seeded: SeededBeat, reading: TurnReading | null, scene: { bystanderIntervened: boolean }): ComposedBeat {
  if (!reading) return { ...seeded, rule: null, provider: 'seeded' };
  let stance = reading.stance ?? seeded.stance;
  let rule: string | null = null;
  const firm = reading.firmBoundary >= 0.55 || reading.tone === 'firm';
  const bystander = scene.bystanderIntervened || reading.bystander >= 0.55;
  if (firm && bystander && stance !== 'gone') {
    stance = 'back_off';
    rule = 'A firm boundary with a bystander makes him back off.';
  }
  if (stance === 'escalate' && seeded.stance !== 'escalate') {
    stance = seeded.stance === 'intimidate' || seeded.stance === 'hostile' ? seeded.stance : 'hostile';
    rule = 'The provider does not get to choose a physical escalation.';
  }
  if (reading.tone === 'silent' && !firm && stance === 'escalate') {
    stance = seeded.stance;
  }
  const suggested = reading.expression ? EXPRESSION_EMOTION[reading.expression] : null;
  const face = clampSuggestedExpression(stance, suggested, Math.max(seeded.tension, reading.escalation));
  const stanceChanged = stance !== seeded.stance;
  return {
    stance,
    emotion: face.emotion,
    emotionIntensity: face.intensity,
    action: stanceChanged ? ACTION_FOR[stance] : seeded.action,
    tension: clamp01(Math.max(seeded.tension, reading.escalation)),
    rule,
    provider: reading.provider,
  };
}

export function applyToDecision(decision: ManDecision, beat: ComposedBeat): ManDecision {
  return { ...decision, stance: beat.stance, emotion: beat.emotion, emotionIntensity: beat.emotionIntensity, action: beat.action };
}

async function postJson(url: string, apiKey: string, body: unknown, signal: AbortSignal, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`${res.status}`);
  }
  return res.json();
}

/** Null means “use the seeded beat”. Never throws. */
export async function judgeTurn(env: JudgeEnv, input: JudgeInput, fetchImpl: typeof fetch = fetch): Promise<TurnReading | null> {
  const name = selectJudge(env);
  if (!name) return null;
  const key = name === 'typesafe' ? env.TYPESAFE_API_KEY! : env.OPENAI_API_KEY!;
  const url = name === 'typesafe' ? TYPESAFE_URL : OPENAI_URL;
  const body = name === 'typesafe' ? typesafeBody(input) : openaiBody(input);
  const signal = AbortSignal.timeout(JUDGE_BUDGET_MS);
  try {
    const json = await postJson(url, key, body, signal, fetchImpl);
    const parsed = name === 'typesafe' ? parseTypesafe(json) : parseOpenai(json);
    return parsed ? { ...parsed, provider: name } : null;
  } catch {
    return null;
  }
}
