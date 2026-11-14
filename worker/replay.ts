/**
 * The end-of-run replay: only the moments that change the scene, each with
 * the short tip from data/harassment_research.json. No new numbers.
 */
import type { ManAction, ManStance, Pov } from '../shared/types';
import type { LogEntry } from './log';
import { HARASSMENT_RESEARCH, type ResearchClaim } from './research';

export type ReplayKind = 'boundary' | 'escalation' | 'filming' | 'gesture' | 'bystander';

export interface ReplayMoment {
  t: number;
  kind: ReplayKind;
  label: string;
  text: string;
  tip: string;
  sourceUrl: string;
  sourceTitle: string;
}

const ESCALATION: ManStance[] = ['hostile', 'intimidate', 'escalate'];

const GESTURE: Partial<Record<ManAction, string>> = {
  follow_behind: 'He follows.',
  block_path: 'He steps into the path.',
  lean_in: 'He leans in close.',
  step_closer: 'He steps in closer.',
  grab: 'He reaches out. The scene stops before anything is shown.',
  turn_on_bystander: 'He turns toward the bystander.',
};

const FIVE: Record<string, string> = {
  distract: 'distract',
  delegate: 'delegate',
  document: 'document',
  delay: 'delay',
  direct: 'direct',
  aggressive: 'direct',
};

function tip(key: string): ResearchClaim {
  const claim = HARASSMENT_RESEARCH.replayTips[key] ?? HARASSMENT_RESEARCH.replayTips.gesture;
  return claim;
}

function moment(t: number, kind: ReplayKind, label: string, text: string, tipKey: string): ReplayMoment {
  const claim = tip(tipKey);
  const source = HARASSMENT_RESEARCH.sources[claim.sourceIds[0]];
  return {
    t: Math.round(t * 10) / 10,
    kind,
    label,
    text,
    tip: claim.text,
    sourceUrl: source?.url ?? '',
    sourceTitle: source?.title ?? '',
  };
}

/** Key moments only, in time order. Repeated identical gestures are kept once until the action changes. */
export function buildReplay(log: LogEntry[], pov: Pov): ReplayMoment[] {
  const out: ReplayMoment[] = [];
  let lastStance: ManStance | null = null;
  let lastGesture: ManAction | null = null;
  for (const e of log) {
    if (e.kind === 'player') {
      if (e.event === 'pushed_past' || e.strategy === 'firm_boundary') {
        out.push(moment(e.t, 'boundary', 'Boundary', e.text ? `"${e.text}"` : 'A firm no.', 'boundary'));
      } else if (e.event === 'filming_start') {
        out.push(moment(e.t, 'filming', 'Filming', 'Filming started.', 'filming'));
      } else if (e.event === 'stood_between') {
        out.push(moment(e.t, 'bystander', 'Direct', 'Stepped between them.', 'direct'));
      } else if (e.event === 'asked_clerk') {
        out.push(moment(e.t, 'bystander', 'Delegate', 'Asked the shopkeeper for help.', 'delegate'));
      } else if (e.event === 'speech' && e.strategy && FIVE[e.strategy]) {
        const key = FIVE[e.strategy];
        const label = key.charAt(0).toUpperCase() + key.slice(1);
        out.push(moment(e.t, 'bystander', label, e.text ? `"${e.text}"` : label, key));
      }
    } else if (e.kind === 'decision') {
      const stance = e.man.stance;
      if (ESCALATION.includes(stance) && stance !== lastStance) {
        const label = stance === 'escalate' ? 'Escalation' : stance === 'intimidate' ? 'Menace' : 'Insult';
        out.push(moment(e.t, 'escalation', label, pov === 'bystander' ? 'He turns hostile toward someone on the street.' : 'He turns hostile.', 'escalation'));
      }
      lastStance = stance;
      const gesture = GESTURE[e.man.action];
      if (gesture && e.man.action !== lastGesture) {
        out.push(moment(e.t, 'gesture', 'Gesture', gesture, 'gesture'));
        lastGesture = e.man.action;
      } else if (!gesture) {
        lastGesture = null;
      }
    }
  }
  return out;
}
