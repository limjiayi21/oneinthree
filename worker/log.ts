/** The per-session record the summary is built from. One row per thing that happened. */
import type {
  ClientEventType,
  ManDecision,
  OutcomeKind,
  Pov,
  Rationale,
  SpeechSource,
  SpeechTarget,
  Strategy,
  WomanDecision,
} from '../shared/types';

export type LogEntry =
  | {
      kind: 'player';
      t: number;
      turn: number;
      event: ClientEventType;
      text?: string;
      strategy?: Strategy;
      target?: SpeechTarget;
      confidence?: number;
      /** How the strategy was arrived at. */
      source?: 'clef' | 'heuristic' | 'event';
      /** Bystander POV: the tactic the model resolved, and what came of it. */
      tactic?: string | null;
      result?: string | null;
      /** Speech only: how the words arrived (exact transcript is `text`). */
      via?: SpeechSource;
      /** Speech only: she talked over this line of his; `heard` is roughly what he got out. */
      interrupted?: { line: string; heard: string };
    }
  | {
      kind: 'decision';
      t: number;
      turn: number;
      man: ManDecision;
      woman?: WomanDecision;
      fear: number;
      tension: number;
      rationale?: Rationale;
      /** Keys of the parameters that drove this decision. */
      drivers: string[];
    }
  | { kind: 'line'; t: number; turn: number; speaker: 'man' | 'woman' | 'clerk'; text: string; source: 'llm' | 'bank' | 'script' }
  | { kind: 'thought'; t: number; turn: number; text: string }
  | { kind: 'outcome'; t: number; turn: number; outcome: OutcomeKind };

export interface SessionMeta {
  id: string;
  pov: Pov;
  seed: number;
  createdAt: number;
  /** Woman POV: the disposition drawn for this session's man. */
  disposition?: string;
  /** 'golden' for the scripted reference playthrough; absent for a normal game. */
  run?: 'golden';
}
