/**
 * What the browser and the Worker agree about a live-voice turn.
 * No network, no API key.
 */
import type { Emotion, ManStance, Pov } from './types';
import { clampSuggestedExpression, coarseExpression, type FaceExpression } from './expression';

export const AGENT_TOOL = 'commit_player_turn';

export interface AgentVariables {
  stance: string;
  emotion: string;
  expression: string;
  distance: string;
  pov: string;
}

export function agentVariables(input: { pov: Pov; stance: ManStance; emotion: Emotion; distanceMetres: number }): AgentVariables {
  const distance = Math.max(1, Math.round(Number.isFinite(input.distanceMetres) ? input.distanceMetres : 4));
  return {
    stance: input.stance,
    emotion: input.emotion,
    expression: coarseExpression(input.emotion),
    distance: String(distance),
    pov: input.pov,
  };
}

/** Non-interrupting memory. STATE updates must not make him speak a second time. */
export function contextualUpdate(vars: AgentVariables, kind: 'opening' | 'state'): string {
  const common = `Stance is ${vars.stance}. Mood is ${vars.emotion} (${vars.expression}). Distance ${vars.distance} metres. POV ${vars.pov}.`;
  if (kind === 'opening') {
    return `OPENING. ${common} Call out once, one short line, in that mood. Do not call the tool yet. Do not decide to follow, block, or touch her.`;
  }
  return `STATE. ${common} Do not speak because of this update. Use it on the next reply, after ${AGENT_TOOL}.`;
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
export function commitToolResult(stance: ManStance, suggested: string | null | undefined, heard: string, tension = 0.5): ToolCommit {
  const face = clampSuggestedExpression(stance, suggested, tension);
  const payload = {
    stance,
    emotion: face.emotion,
    expression: face.expression,
    speak: stance !== 'gone' && stance !== 'idle',
    say: `One line, 5 to 14 words, stance ${stance}, mood ${face.emotion}. No slurs, no sexual content, no threats of violence.`,
  };
  return { heard: heard.slice(0, 600), expression: face.expression, emotion: face.emotion, stance, result: JSON.stringify(payload) };
}
