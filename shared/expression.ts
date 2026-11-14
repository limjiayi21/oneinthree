/**
 * The attacker's face.
 *
 * The stance machine has already decided what he does. This module only
 * chooses how his face looks while he does it. A suggested emotion (from the
 * line writer, or the live-voice agent) is accepted only when it is in the
 * allowlist for that stance, so a model cannot put a smile on a grab or a
 * defeated face on a threat. Shared so the browser can clamp an agent tag
 * without importing the Worker.
 */
import type { Emotion, ManStance } from './types';

export type FaceExpression = 'neutral' | 'smug' | 'angry' | 'nervous' | 'confused' | 'defeated';

export interface ExpressionDecision {
  expression: FaceExpression;
  emotion: Emotion;
  /** 0..1, already clamped. The rig eases toward this; callers should not snap. */
  intensity: number;
}

export interface ExpressionInput {
  stance: ManStance;
  /** A woman strategy, a bystander tactic, or an Address such as 'firm' or 'police'. */
  move: string;
  /** 0..1 how volatile he is right now. */
  tension: number;
  /** 0..1 accumulated frustration. */
  frustration: number;
  rng: { pick<T>(items: readonly T[]): T };
  /** Ignored unless it is an allowed Emotion for this stance. */
  suggested?: string | null;
}

/** Emotions the face is allowed to wear in each stance. Escalate is only anger. */
export const STANCE_EMOTIONS: Record<ManStance, readonly Emotion[]> = {
  idle: ['neutral'],
  opening: ['friendly', 'smirk'],
  persist: ['smirk', 'friendly', 'leer', 'surprised', 'worried'],
  follow: ['smirk', 'leer', 'neutral', 'surprised'],
  block: ['smirk', 'annoyed', 'surprised'],
  guilt: ['annoyed', 'contempt', 'worried'],
  hostile: ['angry', 'contempt', 'mocking'],
  intimidate: ['angry', 'contempt'],
  back_off: ['sheepish', 'annoyed', 'contempt', 'smirk', 'worried'],
  gone: ['neutral', 'sheepish'],
  escalate: ['angry'],
};

const COARSE: Record<Emotion, FaceExpression> = {
  neutral: 'neutral',
  friendly: 'smug',
  smirk: 'smug',
  leer: 'smug',
  mocking: 'smug',
  annoyed: 'angry',
  angry: 'angry',
  contempt: 'angry',
  sheepish: 'defeated',
  surprised: 'confused',
  afraid: 'nervous',
  worried: 'nervous',
  relieved: 'nervous',
  determined: 'angry',
};

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

function isEmotion(value: string | null | undefined): value is Emotion {
  return !!value && value in COARSE;
}

function bias(stance: ManStance, move: string, frustration: number): Emotion[] {
  if (stance === 'escalate') return ['angry'];
  if (stance === 'intimidate') return ['angry', 'contempt'];
  if (stance === 'hostile') return move === 'hostile' ? ['angry', 'angry', 'contempt'] : ['angry', 'mocking', 'contempt'];
  if (stance === 'back_off') {
    if (move === 'police' || move === 'help' || move === 'film' || move === 'plead') return ['sheepish', 'worried'];
    if (frustration > 0.3) return ['contempt', 'annoyed'];
    return ['sheepish', 'annoyed', 'smirk'];
  }
  if (stance === 'guilt') return move === 'police' || move === 'film' ? ['worried', 'annoyed'] : ['annoyed', 'contempt'];
  if (stance === 'block') {
    if (move === 'unclear') return ['surprised', 'annoyed'];
    return frustration > 0.35 ? ['annoyed', 'smirk'] : ['smirk', 'smirk', 'annoyed'];
  }
  if (stance === 'persist' || stance === 'opening') {
    if (move === 'unclear') return ['surprised', 'smirk'];
    if (move === 'police' || move === 'film') return ['worried', 'smirk'];
    if (move === 'engage') return ['friendly', 'leer'];
    if (move === 'firm') return ['smirk', 'leer'];
    return ['friendly', 'smirk'];
  }
  if (stance === 'follow') return move === 'unclear' ? ['surprised', 'neutral'] : ['smirk', 'leer', 'neutral'];
  if (stance === 'gone') return ['neutral', 'sheepish'];
  return ['neutral'];
}

export function coarseExpression(emotion: Emotion): FaceExpression {
  return COARSE[emotion];
}

const STABLE_RNG: ExpressionInput['rng'] = { pick: (items) => items[0] };

/**
 * The agent's expression tag, kept only when this stance allows it.
 * Otherwise the first legal emotion for the stance. Does not draw from the
 * session seed, so a live-voice tag cannot reshuffle the decision model.
 */
export function clampSuggestedExpression(stance: ManStance, suggested: string | null | undefined, tension = 0.5, frustration = 0.2): ExpressionDecision {
  return decideExpression({
    stance,
    move: 'unclear',
    tension,
    frustration,
    rng: STABLE_RNG,
    suggested: suggested ?? null,
  });
}

export function decideExpression(input: ExpressionInput): ExpressionDecision {
  const allowed = STANCE_EMOTIONS[input.stance] ?? STANCE_EMOTIONS.idle;
  const suggested = isEmotion(input.suggested) && allowed.includes(input.suggested) ? input.suggested : null;
  const pool = (suggested ? [suggested] : bias(input.stance, input.move, input.frustration)).filter((e) => allowed.includes(e));
  const emotion = pool.length ? input.rng.pick(pool) : allowed[0];
  let intensity = input.stance === 'escalate' ? 1 : clamp01(0.4 + 0.55 * clamp01(input.tension));
  if (emotion === 'angry' || emotion === 'contempt') intensity = Math.min(1, intensity + 0.12);
  if (emotion === 'sheepish') intensity = Math.max(0.45, intensity);
  if (input.stance === 'idle' || input.stance === 'gone') intensity = Math.min(intensity, 0.45);
  return { expression: COARSE[emotion], emotion, intensity: Math.round(intensity * 1000) / 1000 };
}
