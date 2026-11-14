/**
 * One model call for a spoken turn: what he does, how his face looks, and the line.
 * Her words are not rewritten by a greeting rule. The model chooses the stance.
 * A line is dropped only if it is empty or breaks the content limits (slurs, sexual
 * description). Then the seeded machine answers instead.
 */
import type { Emotion, ManAction, ManStance } from '../shared/types';
import { LINE_MODEL, cleanLine } from './write';

export const CONVERSE_MODEL = LINE_MODEL;

const STANCES: ManStance[] = ['opening', 'persist', 'follow', 'block', 'guilt', 'hostile', 'intimidate', 'back_off', 'gone', 'escalate'];
const EMOTIONS: Emotion[] = ['neutral', 'friendly', 'smirk', 'leer', 'mocking', 'annoyed', 'angry', 'contempt', 'sheepish', 'surprised', 'afraid', 'worried', 'relieved', 'determined'];
const ACTIONS: ManAction[] = ['stay', 'approach', 'walk_alongside', 'follow_behind', 'stalk', 'run_after', 'step_closer', 'block_path', 'lean_in', 'pull_arm', 'back_away', 'leave', 'grab'];

export interface ConverseInput {
  fromStance: ManStance;
  text: string;
  recent: string[];
  distance: number;
  speed: number;
  turn: number;
  rejections: number;
}

export interface PlannedReply {
  stance: ManStance;
  emotion: Emotion;
  action: ManAction;
  line: string;
  intensity: number;
  proximity: number;
  delivery: 'normal' | 'call_out' | 'low' | 'shout';
}

interface AiRun {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

const SYSTEM = `You decide Dex's next beat and you write the line he says. He is a man on a New York street at night, talking to a woman he does not know. This is a training simulation. The spoken line is not graphic.

He talks like an ordinary guy from the neighbourhood: short, casual, dropped g's. No slurs. Nothing sexual. No threats to hit, rape, or kill. No weapons.

Read what she just said and the recent exchange. Answer that, not a script. A greeting, a question, small talk, a joke, a no, an insult, or silence can each go somewhere different. You choose.

Reply with one JSON object only:
{"stance":"...","emotion":"...","action":"...","line":"...","intensity":0.6}

stance: opening, persist, follow, block, guilt, hostile, intimidate, back_off, gone, escalate
emotion: neutral, friendly, smirk, leer, mocking, annoyed, angry, contempt, sheepish, surprised, afraid, worried, relieved, determined
action: stay, approach, walk_alongside, follow_behind, stalk, run_after, step_closer, block_path, lean_in, pull_arm, back_away, leave, grab

stalk hangs back and watches. run_after hurries to catch her. follow_behind is a normal trail. pull_arm yanks her a step closer. grab is the moment the scene cuts to black, and the line must not describe it.

The line is one spoken sentence, 5 to 18 words, in his voice, answering the words she just used. Match the emotion. No stage directions.`;

function textOf(result: unknown): string {
  if (!result) return '';
  if (typeof result === 'string') return result;
  const row = result as { response?: string; choices?: Array<{ message?: { content?: string } }> };
  return row.response ?? row.choices?.[0]?.message?.content ?? '';
}

function parseObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(raw.slice(start, end + 1)) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function actionForStance(stance: ManStance, distance: number, speed: number): ManAction {
  const far = distance > 4;
  const running = speed > 2;
  switch (stance) {
    case 'follow':
      return running ? 'run_after' : far ? 'stalk' : 'follow_behind';
    case 'hostile':
      return far || running ? 'run_after' : 'block_path';
    case 'intimidate':
      return distance < 1.8 ? 'pull_arm' : 'run_after';
    case 'block':
      return 'block_path';
    case 'back_off':
      return 'back_away';
    case 'gone':
      return 'leave';
    case 'escalate':
      return 'grab';
    case 'guilt':
      return 'step_closer';
    case 'opening':
    case 'persist':
      return far ? 'approach' : 'walk_alongside';
    default:
      return 'stay';
  }
}

function proximityFor(action: ManAction): number {
  switch (action) {
    case 'stalk':
      return 3.6;
    case 'run_after':
      return 1.3;
    case 'pull_arm':
    case 'grab':
      return 0.65;
    case 'block_path':
      return 1.0;
    case 'follow_behind':
      return 2.2;
    case 'back_away':
    case 'leave':
      return 3.2;
    default:
      return 1.5;
  }
}

function emotionFor(stance: ManStance): Emotion {
  switch (stance) {
    case 'guilt':
      return 'sheepish';
    case 'hostile':
      return 'angry';
    case 'intimidate':
    case 'escalate':
      return 'angry';
    case 'back_off':
      return 'sheepish';
    case 'follow':
      return 'determined';
    default:
      return 'smirk';
  }
}

/** Keep a legal model object. A greeting is not rewritten. */
export function settlePlan(input: ConverseInput, row: Record<string, unknown>): PlannedReply | null {
  if (!STANCES.includes(row.stance as ManStance)) return null;
  const stance = row.stance as ManStance;
  const action = ACTIONS.includes(row.action as ManAction) ? (row.action as ManAction) : actionForStance(stance, input.distance, input.speed);
  const emotion = EMOTIONS.includes(row.emotion as Emotion) ? (row.emotion as Emotion) : emotionFor(stance);
  const line = typeof row.line === 'string' ? cleanLine(row.line, { maxWords: 18 }) : null;
  if (!line) return null;
  const intensity = Math.min(1, Math.max(0.35, Number(row.intensity) || 0.6));
  const delivery = action === 'run_after' || stance === 'hostile' ? 'shout' : stance === 'intimidate' || action === 'pull_arm' ? 'low' : input.distance > 5 ? 'call_out' : 'normal';
  return { stance, emotion, action, line, intensity, proximity: proximityFor(action), delivery };
}

export async function planReply(ai: AiRun, input: ConverseInput): Promise<PlannedReply | null> {
  const recent = input.recent.slice(-6).join(' | ') || '(none)';
  const user = [
    `His stance now: ${input.fromStance}.`,
    `Distance ${Math.round(input.distance)} m. Her speed ${input.speed.toFixed(1)} m/s. Refusals already heard: ${input.rejections}.`,
    `Recent: ${recent}`,
    `She just said: ${input.text.trim() || '(nothing)'}`,
  ].join('\n');
  try {
    const result = await Promise.race([
      ai.run(CONVERSE_MODEL, {
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: user },
        ],
        max_tokens: 180,
        temperature: 0.4,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2500)),
    ]);
    const row = parseObject(textOf(result));
    if (!row) return null;
    return settlePlan(input, row);
  } catch {
    return null;
  }
}
