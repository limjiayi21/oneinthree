/**
 * The player's run, as the coach sees it: built from the summaries the game
 * already makes for each session (worker/summary.ts). Numbered moments, so the
 * coach and its helpers can refer to "moment 3" and look it up.
 */
import type { SummaryData, TimelineEntry } from '../../shared/types';

export interface RunMoment {
  n: number;
  /** Seconds into the scene. */
  t: number;
  /** What happened just before: his or her last line, or the event. */
  before: string[];
  /** What the player said or did. */
  you: string;
  /** How the game read it (e.g. "Direct", "Firm boundary"). */
  label?: string;
  /** What followed, up to the player's next action. */
  after: string[];
  /** Why he reacted that way, from the decision model. */
  why?: string;
}

export interface RunPart {
  part: 'Part 1: her walk home (you were her)' | 'Part 2: the bystander (you saw it happen)';
  outcome: { title: string; body: string };
  durationSec: number;
  moments: RunMoment[];
  /** Part 2 only: which of the 5 Ds the game saw, and what it said about each. */
  fiveDs?: { d: string; used: boolean; what: string[]; feedback: string }[];
}

const SPEAKER: Record<TimelineEntry['actor'], string> = { you: 'You', man: 'Him', woman: 'Her', clerk: 'Shopkeeper', thought: 'Her thought', event: 'Event' };

const line = (e: TimelineEntry): string => `${SPEAKER[e.actor]}: ${e.text}${e.label ? ` (${e.label})` : ''}`;

export function toRunPart(summary: SummaryData): RunPart {
  const moments: RunMoment[] = [];
  let pending: string[] = [];
  let current: RunMoment | null = null;
  for (const e of summary.timeline) {
    if (e.actor === 'you') {
      if (current) moments.push(current);
      current = { n: moments.length + 1, t: Math.round(e.t), before: pending.slice(-3), you: e.text, label: e.label, after: [] };
      pending = [];
      continue;
    }
    if (current) {
      current.after.push(line(e));
      if (!current.why && e.actor === 'man' && e.rationale?.text) current.why = e.rationale.text;
    }
    pending.push(line(e));
  }
  if (current) moments.push(current);
  for (const m of moments) m.after = m.after.slice(0, 4);
  return {
    part: summary.pov === 'woman' ? 'Part 1: her walk home (you were her)' : 'Part 2: the bystander (you saw it happen)',
    outcome: { title: summary.outcome.title, body: summary.outcome.body },
    durationSec: Math.round(summary.durationSec),
    moments,
    fiveDs: summary.fiveDs?.map((f) => ({ d: f.key, used: f.used, what: f.moments, feedback: f.feedback })),
  };
}

/** A compact text overview for the coach's first look: outcome, the 5 Ds, one line per moment. */
export function overview(parts: RunPart[]): string {
  return parts
    .map((p) => {
      const ds = p.fiveDs ? `\n5 Ds: ${p.fiveDs.map((f) => `${f.d} ${f.used ? 'used' : 'not used'}`).join(', ')}` : '';
      const ms = p.moments.length ? p.moments.map((m) => `  ${m.n}. (${m.t}s) ${m.you}${m.label ? ` [${m.label}]` : ''}`).join('\n') : '  (the player did not speak or act in a way the game recorded)';
      return `${p.part}\nOutcome: ${p.outcome.title} ${p.outcome.body}\nLength: ${p.durationSec}s${ds}\nMoments:\n${ms}`;
    })
    .join('\n\n');
}

export function momentDetail(parts: RunPart[], part: 1 | 2, n: number): string {
  const p = parts.find((x) => (part === 1 ? x.part.startsWith('Part 1') : x.part.startsWith('Part 2')));
  const m = p?.moments.find((x) => x.n === n);
  if (!p || !m) return `No moment ${n} in Part ${part}.`;
  return [
    `${p.part}, moment ${m.n} at ${m.t}s`,
    m.before.length ? `Just before:\n${m.before.map((l) => `  ${l}`).join('\n')}` : 'Just before: (start of the scene)',
    `You: ${m.you}${m.label ? ` (read as: ${m.label})` : ''}`,
    m.after.length ? `What followed:\n${m.after.map((l) => `  ${l}`).join('\n')}` : 'What followed: (nothing recorded)',
    m.why ? `Why he reacted that way (from the game's model): ${m.why}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
