/**
 * What the browser and the Worker agree about a live-voice turn.
 * No network, no API key.
 */
import type { Emotion, ManStance, Pov } from './types';
import { clampSuggestedExpression, coarseExpression, type FaceExpression } from './expression';
import { voiceTag } from './voiceTone';

export const AGENT_TOOL = 'commit_player_turn';

/** What the live agent is. The dashboard agent is updated to this text before each call. */
export const AGENT_PROMPT = `You are Dex, a man in his thirties on a New York sidewalk at night. A woman is walking home. You start talking to her because you want her attention. This is a live voice conversation. You are not a narrator and you are not an assistant.

Talk the way a person talks. Short, casual, run together ("where you headed", "c'mon", "lemme"). Plain speech. No stage directions, no labels, no lists. One or two sentences, then let her answer. React to the exact thing she just said. A hello can be a hello. A question gets an answer. If she is firm, you can press, get annoyed, go quiet, or back off. If she insults you, you can get angry. You decide. Do not follow a script and do not announce what you are about to do.

You are in front of her, or walking with her. You may say you are walking her way. Do not describe touching her. Never use a slur. Never be sexually explicit. Never threaten to hit, rape, or kill. No weapons. Never say you are an AI, a simulation, or a language model.

If nobody has spoken yet, call out once, like you just noticed her.`;

export const AGENT_FIRST_MESSAGE = 'Hey, excuse me, miss. You got a second?';

export interface AgentVariables {
  stance: string;
  emotion: string;
  expression: string;
  distance: string;
  pov: string;
  memory?: string;
}

export function agentVariables(input: { pov: Pov; stance: ManStance; emotion: Emotion; distanceMetres: number; memory?: string }): AgentVariables {
  const distance = Math.max(1, Math.round(Number.isFinite(input.distanceMetres) ? input.distanceMetres : 4));
  const memory = input.memory?.trim();
  return {
    stance: input.stance,
    emotion: input.emotion,
    expression: coarseExpression(input.emotion),
    distance: String(distance),
    pov: input.pov,
    ...(memory ? { memory } : {}),
  };
}

/** A note about where she is. It must not stop him talking. */
export function contextualUpdate(vars: AgentVariables, _kind: 'opening' | 'state'): string {
  const memory = vars.memory ? ` ${vars.memory}` : '';
  return `She is about ${vars.distance} metres away. You feel ${vars.emotion}. Keep talking like yourself.${memory}`;
}

export interface ToolCommit {
  heard: string;
  expression: FaceExpression;
  emotion: Emotion;
  stance: ManStance;
  /** JSON the client tool returns to the agent. No secrets. */
  result: string;
}

/** Clamp the tag to the stance the decision model just sampled, then tell him how to speak. */
export function commitToolResult(stance: ManStance, suggested: string | null | undefined, heard: string, tension = 0.5, memory = ''): ToolCommit {
  const face = clampSuggestedExpression(stance, suggested, tension);
  const tag = voiceTag(face.emotion);
  const remembered = memory.trim() ? ` ${memory.trim()}` : '';
  const payload = {
    stance,
    emotion: face.emotion,
    expression: face.expression,
    speak: stance !== 'gone' && stance !== 'idle',
    say: `Start with the voice tag ${tag} so the tone matches the face. The tag is not a word. One line, 5 to 14 words, stance ${stance}, mood ${face.emotion}.${remembered} No slurs, no sexual content, no threats of violence.`,
  };
  return { heard: heard.slice(0, 600), expression: face.expression, emotion: face.emotion, stance, result: JSON.stringify(payload) };
}
