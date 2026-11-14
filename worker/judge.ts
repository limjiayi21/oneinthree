/**
 * A turn judge in front of the seeded stance machine.
 *
 * The default judge is Workers AI (Gemma 4 26B-A4B, 4B active) in JSON schema
 * mode. It needs no extra key. TypeSafe Jev, OpenAI Decisions, and Gemini are
 * optional. Code, not the model, decides the beat the trainee sees: a firm
 * boundary plus a bystander makes him back off, and no provider may invent a
 * physical escalation. A missing key, a bad enum, a failed call, or anything
 * slower than 400 ms keeps the seeded decision.
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
 *
 * Workers AI JSON mode: env.AI.run('@cf/google/gemma-4-26b-a4b-it') with
 * response_format json_schema. Thinking is off. The schema enums are the
 * only legal answers; anything else is discarded.
 * https://developers.cloudflare.com/workers-ai/features/json-mode/
 *
 * Gemini, optional, Google AI Studio: POST
 * .../models/gemini-3.5-flash:generateContent with header x-goog-api-key
 * and generationConfig.responseFormat.text = { mimeType, schema }.
 * https://ai.google.dev/gemini-api/docs/structured-output
 */
import type { Emotion, ManAction, ManDecision, ManStance, Pov, WorldContext } from '../shared/types';
import { clampSuggestedExpression } from '../shared/expression';

export const JUDGE_BUDGET_MS = 400;
export const WORKERS_JUDGE_MODEL = '@cf/google/gemma-4-26b-a4b-it';
export const TYPESAFE_MODEL = 'jev-1.14.0';
export const OPENAI_MODEL = 'gpt-6-luna';
export const GEMINI_MODEL = 'gemini-3.5-flash';
export const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';
export const OPENAI_URL = 'https://api.openai.com/v1/decisions';
export const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

export type JudgeName = 'workers' | 'typesafe' | 'openai' | 'gemini';

/** Enough of the Workers AI binding to run one JSON call. */
export interface AiRunner {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}
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
  GEMINI_API_KEY?: string;
  /** Present on the Worker. The default judge uses it and no other key. */
  AI?: AiRunner;
}

/**
 * Unset means Workers AI when the binding exists, otherwise the seeded model.
 * `seeded` forces the built-in machine even if AI is bound.
 */
export function selectJudge(env: JudgeEnv): JudgeName | null {
  const name = (env.DECISION_PROVIDER ?? '').trim().toLowerCase();
  if (name === 'seeded' || name === 'off' || name === 'none') return null;
  if (name === 'typesafe') return env.TYPESAFE_API_KEY ? 'typesafe' : null;
  if (name === 'openai') return env.OPENAI_API_KEY ? 'openai' : null;
  if (name === 'gemini') return env.GEMINI_API_KEY ? 'gemini' : null;
  if (name === 'workers' || name === '' || name === 'default') return env.AI ? 'workers' : null;
  return null;
}

/** One object, enums only. Shared by Workers AI and Gemini. */
export function judgeSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      firm_boundary: { type: 'boolean', description: 'True if the player just set a firm boundary.' },
      bystander: { type: 'boolean', description: 'True if a bystander just intervened.' },
      tone: { type: 'string', enum: [...TONES], description: 'The player’s tone.' },
      stance: { type: 'string', enum: [...STANCES], description: 'His next stance. Do not pick escalate unless the scene is already cutting away.' },
      expression: { type: 'string', enum: [...EXPRESSIONS], description: 'The face for the line he is about to say.' },
      escalation: { type: 'number', description: 'Heat from 0 (only talking) to 1 (cut away). Do not describe violence.' },
    },
    required: ['firm_boundary', 'bystander', 'tone', 'stance', 'expression', 'escalation'],
  };
}

export function workersInput(input: JudgeInput): Record<string, unknown> {
  return {
    messages: [
      {
        role: 'system',
        content: 'You judge one beat of a street-harassment training simulation. Answer only with the JSON object. Do not describe violence, slurs, or anything sexual.',
      },
      { role: 'user', content: sceneState(input) },
    ],
    temperature: 0,
    max_completion_tokens: 120,
    chat_template_kwargs: { enable_thinking: false },
    response_format: { type: 'json_schema', json_schema: judgeSchema() },
  };
}

export function geminiBody(input: JudgeInput): Record<string, unknown> {
  return {
    contents: [{ role: 'user', parts: [{ text: sceneState(input) }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 200,
      responseFormat: { text: { mimeType: 'application/json', schema: judgeSchema() } },
    },
  };
}

/** Pull the JSON object out of the shapes Workers AI actually returns. */
export function workersPayload(result: unknown): unknown {
  if (!result || typeof result !== 'object') return null;
  const row = result as { response?: unknown; choices?: Array<{ message?: { content?: unknown } }> };
  if (row.response && typeof row.response === 'object') return row.response;
  if (typeof row.response === 'string') return parseJsonObject(row.response);
  const content = row.choices?.[0]?.message?.content;
  if (content && typeof content === 'object') return content;
  if (typeof content === 'string') return parseJsonObject(content);
  if ('stance' in row && 'tone' in row) return row;
  return null;
}

export function geminiPayload(result: unknown): unknown {
  const parts = (result as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> } | null)?.candidates?.[0]?.content?.parts;
  const text = parts?.map((p) => p.text ?? '').join('') ?? '';
  return parseJsonObject(text);
}

function parseJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Reject a reading whose enums are not in the allowed sets. */
export function parseStructured(body: unknown): Omit<TurnReading, 'provider'> | null {
  if (!body || typeof body !== 'object') return null;
  const row = body as Record<string, unknown>;
  const tone = asTone(row.tone);
  const stance = asStance(row.stance);
  const expression = asExpression(row.expression);
  if (typeof row.tone === 'string' && tone === 'silent' && row.tone !== 'silent') return null;
  if (!stance || !expression) return null;
  if (typeof row.tone !== 'string' || !(TONES as string[]).includes(row.tone)) return null;
  const firm = row.firm_boundary;
  const by = row.bystander;
  const firmBoundary = typeof firm === 'boolean' ? (firm ? 1 : 0) : clamp01(Number(firm));
  const bystander = typeof by === 'boolean' ? (by ? 1 : 0) : clamp01(Number(by));
  const escalation = clamp01(Number(row.escalation));
  return { firmBoundary, bystander, tone, stance, expression, escalation };
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

async function postJson(
  url: string,
  apiKey: string,
  body: unknown,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
  auth: { authorization?: boolean; apiKeyHeader?: string } = {},
): Promise<unknown> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth.apiKeyHeader) headers[auth.apiKeyHeader] = apiKey;
  else headers.authorization = `Bearer ${apiKey}`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`${res.status}`);
  }
  return res.json();
}

function withBudget<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Null means “use the seeded beat”. Never throws. */
export async function judgeTurn(env: JudgeEnv, input: JudgeInput, fetchImpl: typeof fetch = fetch): Promise<TurnReading | null> {
  const name = selectJudge(env);
  if (!name) return null;
  try {
    const parsed = await withBudget(runProvider(name, env, input, fetchImpl), JUDGE_BUDGET_MS);
    return parsed ? { ...parsed, provider: name } : null;
  } catch {
    return null;
  }
}

async function runProvider(name: JudgeName, env: JudgeEnv, input: JudgeInput, fetchImpl: typeof fetch): Promise<Omit<TurnReading, 'provider'> | null> {
  if (name === 'workers') {
    const result = await env.AI!.run(WORKERS_JUDGE_MODEL, workersInput(input));
    return parseStructured(workersPayload(result));
  }
  if (name === 'gemini') {
    const signal = AbortSignal.timeout(JUDGE_BUDGET_MS);
    const json = await postJson(GEMINI_URL, env.GEMINI_API_KEY!, geminiBody(input), signal, fetchImpl, { authorization: false, apiKeyHeader: 'x-goog-api-key' });
    return parseStructured(geminiPayload(json));
  }
  const signal = AbortSignal.timeout(JUDGE_BUDGET_MS);
  if (name === 'typesafe') {
    const json = await postJson(TYPESAFE_URL, env.TYPESAFE_API_KEY!, typesafeBody(input), signal, fetchImpl);
    return parseTypesafe(json);
  }
  const json = await postJson(OPENAI_URL, env.OPENAI_API_KEY!, openaiBody(input), signal, fetchImpl);
  return parseOpenai(json);
}
