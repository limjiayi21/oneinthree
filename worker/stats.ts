/**
 * Aggregate playthrough logging for the pitch, in Cloudflare D1.
 *
 * One row per Part 2 session. It holds what the player did, never what they
 * said: the session id, a timestamp, the Part 2 free-play tactics in order,
 * the Part 2 outcome, and the first choice picked at each guided moment.
 * No transcripts, no spoken or typed words, no audio.
 *
 * Schema: migrations/0001_playthroughs.sql. Logging is best effort: if the
 * DB binding is missing or a write fails, the simulation carries on.
 */
import guidedJson from '../content/guided.json';
import type { GuidedData } from '../shared/content';
import type { OutcomeKind } from '../shared/types';
import type { LogEntry } from './log';

const GUIDED = guidedJson as unknown as GuidedData;

/** moment id -> the choice ids it allows. */
const GUIDED_CHOICES: Record<string, Set<string>> = Object.fromEntries(GUIDED.moments.map((m) => [m.id, new Set(m.choices.map((c) => c.id))]));
/** The moments with a column in the playthroughs table (migrations/0001_playthroughs.sql). */
export const GUIDED_MOMENT_IDS = GUIDED.moments.map((m) => m.id).filter((id) => ['m1', 'm2', 'm3'].includes(id));

const OUTCOMES: OutcomeKind[] = [
  'he_left',
  'reached_home_alone',
  'reached_home_followed',
  'took_refuge',
  'escalated',
  'intervened_he_left',
  'intervened_she_safe',
  'intervened_escalated',
  'no_intervention_she_escaped',
  'no_intervention_escalated',
  'exited',
];

export const isOutcome = (v: unknown): v is OutcomeKind => typeof v === 'string' && (OUTCOMES as string[]).includes(v);

/**
 * The tactics the decision model resolved for each intervention, in order,
 * with immediate repeats collapsed ("direct, direct, delay" -> "direct, delay").
 * Read from the session log's `tactic` field, so no words are involved.
 */
export function tacticsFromLog(log: LogEntry[]): string[] {
  const out: string[] = [];
  for (const e of log) {
    if (e.kind !== 'player' || !e.tactic) continue;
    if (out[out.length - 1] !== e.tactic) out.push(e.tactic);
  }
  return out;
}

/** Keep only known moment ids and the choice ids that belong to them. */
export function cleanGuidedChoices(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [moment, choice] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof choice === 'string' && GUIDED_CHOICES[moment]?.has(choice)) out[moment] = choice;
  }
  return out;
}

export interface PlaythroughRow {
  sessionId: string;
  createdAt: number;
  tactics?: string[];
  outcome?: OutcomeKind | null;
  guided?: Record<string, string>;
}

/**
 * Insert or update one playthrough. Columns not given keep their stored value,
 * so the outcome (written by the session) and the guided choices (posted by the
 * client afterwards) can arrive in either order.
 */
export async function recordPlaythrough(db: D1Database | undefined, row: PlaythroughRow): Promise<void> {
  if (!db) return;
  const g = row.guided ?? {};
  try {
    await db
      .prepare(
        `INSERT INTO playthroughs (session_id, created_at, updated_at, tactics, outcome, guided_m1, guided_m2, guided_m3)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(session_id) DO UPDATE SET
           updated_at = excluded.updated_at,
           tactics   = COALESCE(excluded.tactics, playthroughs.tactics),
           outcome   = COALESCE(excluded.outcome, playthroughs.outcome),
           guided_m1 = COALESCE(playthroughs.guided_m1, excluded.guided_m1),
           guided_m2 = COALESCE(playthroughs.guided_m2, excluded.guided_m2),
           guided_m3 = COALESCE(playthroughs.guided_m3, excluded.guided_m3)`,
      )
      .bind(
        row.sessionId,
        new Date(row.createdAt).toISOString(),
        new Date().toISOString(),
        row.tactics ? JSON.stringify(row.tactics) : null,
        row.outcome ?? null,
        g.m1 ?? null,
        g.m2 ?? null,
        g.m3 ?? null,
      )
      .run();
  } catch (err) {
    console.warn('[stats] write failed', err instanceof Error ? err.message : err);
  }
}

export interface StatsResponse {
  playthroughs: number;
  /** Part 2 sessions that reached an outcome. */
  withOutcome: number;
  outcomes: Record<string, number>;
  /** How many playthroughs used each tactic at least once. */
  tacticsUsed: Record<string, number>;
  /** The first tactic tried in free play ("none" when there was no intervention). */
  firstTactic: Record<string, number>;
  /** Per guided moment: how often each choice was picked first. */
  guidedFirstChoice: Record<string, Record<string, number>>;
  /** Playthroughs that reached the end of the guided replay. */
  guidedCompleted: number;
}

interface Row {
  tactics: string | null;
  outcome: string | null;
  guided_m1: string | null;
  guided_m2: string | null;
  guided_m3: string | null;
}

const bump = (map: Record<string, number>, key: string) => {
  map[key] = (map[key] ?? 0) + 1;
};

/** Aggregate rows into counts. Pure, so it is tested without a database. */
export function aggregate(rows: Row[]): StatsResponse {
  const out: StatsResponse = {
    playthroughs: rows.length,
    withOutcome: 0,
    outcomes: {},
    tacticsUsed: {},
    firstTactic: {},
    guidedFirstChoice: Object.fromEntries(GUIDED_MOMENT_IDS.map((id) => [id, {}])),
    guidedCompleted: 0,
  };
  for (const r of rows) {
    if (r.outcome) {
      out.withOutcome++;
      bump(out.outcomes, r.outcome);
    }
    let tactics: string[] = [];
    try {
      const parsed: unknown = r.tactics ? JSON.parse(r.tactics) : [];
      if (Array.isArray(parsed)) tactics = parsed.filter((t): t is string => typeof t === 'string');
    } catch {
      /* a damaged row counts as no tactics */
    }
    for (const t of new Set(tactics)) bump(out.tacticsUsed, t);
    if (r.outcome || tactics.length) bump(out.firstTactic, tactics[0] ?? 'none');
    const guided: Record<string, string | null> = { m1: r.guided_m1, m2: r.guided_m2, m3: r.guided_m3 };
    for (const id of GUIDED_MOMENT_IDS) {
      const choice = guided[id];
      if (choice) bump(out.guidedFirstChoice[id]!, choice);
    }
    if (GUIDED_MOMENT_IDS.every((id) => guided[id])) out.guidedCompleted++;
  }
  return out;
}

export async function readStats(db: D1Database): Promise<StatsResponse> {
  const { results } = await db.prepare('SELECT tactics, outcome, guided_m1, guided_m2, guided_m3 FROM playthroughs').all<Row>();
  return aggregate(results ?? []);
}

/** Compare the stats code without leaking how much of it matched through timing. */
export function codeMatches(given: string | null, expected: string | undefined): boolean {
  if (!expected || !given) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
