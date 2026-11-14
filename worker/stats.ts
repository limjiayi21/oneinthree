/**
 * Aggregate playthrough logging for the pitch, in Cloudflare D1.
 *
 * One row per Part 2 session. It holds what the player did, never what they
 * said: the session id, a timestamp, the Part 2 free-play tactics in order,
 * the Part 2 outcome, and the first choice id picked at each of the five
 * teaching-replay moments.
 * No transcripts, no spoken or typed words, no audio.
 *
 * Schema: migrations/0001_playthroughs.sql, then 0003_teaching_replay.sql. Logging is best effort: if the
 * DB binding is missing or a write fails, the simulation carries on.
 *
 * Separately, the Part 1 film asks "Out of 100 women in the US, how many have
 * been followed?" and logs each locked-in guess as a bare number in
 * film_guesses (migrations/0004_part1_film.sql), not linked to any session.
 */
import guidedJson from '../content/guided.json';
import type { GuidedData } from '../shared/content';
import type { OutcomeKind } from '../shared/types';
import type { LogEntry } from './log';

const GUIDED = guidedJson as unknown as GuidedData;

/** moment id -> the choice ids it allows. */
const GUIDED_CHOICES: Record<string, Set<string>> = Object.fromEntries(GUIDED.moments.map((m) => [m.id, new Set(m.choices.map((c) => c.id))]));
/** One column per moment in the playthroughs table (migrations/0001 and 0003). content.test checks these match content/guided.json. */
export const GUIDED_MOMENT_IDS = ['m1', 'm2', 'm3', 'm4', 'm5'] as const;
type MomentId = (typeof GUIDED_MOMENT_IDS)[number];

/** choice id -> its rating, for the first-try counts. */
const RATING: Record<string, string> = Object.fromEntries(GUIDED.moments.flatMap((m) => m.choices.map((c) => [c.id, c.rating])));

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
        `INSERT INTO playthroughs (session_id, created_at, updated_at, tactics, outcome, guided_m1, guided_m2, guided_m3, guided_m4, guided_m5)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(session_id) DO UPDATE SET
           updated_at = excluded.updated_at,
           tactics   = COALESCE(excluded.tactics, playthroughs.tactics),
           outcome   = COALESCE(excluded.outcome, playthroughs.outcome),
           guided_m1 = COALESCE(playthroughs.guided_m1, excluded.guided_m1),
           guided_m2 = COALESCE(playthroughs.guided_m2, excluded.guided_m2),
           guided_m3 = COALESCE(playthroughs.guided_m3, excluded.guided_m3),
           guided_m4 = COALESCE(playthroughs.guided_m4, excluded.guided_m4),
           guided_m5 = COALESCE(playthroughs.guided_m5, excluded.guided_m5)`,
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
        g.m4 ?? null,
        g.m5 ?? null,
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
  /** Per guided moment: how often the first pick was best, good, weaker or backfires. */
  guidedFirstRating: Record<string, Record<string, number>>;
  /** Playthroughs that reached the end of the teaching replay (a first choice at all five moments). */
  guidedCompleted: number;
  /** Guesses from the Part 1 film question; null if the film_guesses table is not there yet (migration 0004 not applied). */
  filmGuesses: FilmGuessStats | null;
}

/* ---------------------------------------------------------- Part 1 film guess */

/** The answer shown in the film: ssh2018_followed_34 in content/evidence.json (34% have been physically followed). */
export const FILM_ANSWER = 34;

/** A guess is a whole number from 0 to 100; anything else is dropped. */
export function cleanFilmGuess(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 100 ? raw : null;
}

export async function recordFilmGuess(db: D1Database | undefined, guess: number): Promise<void> {
  if (!db) return;
  try {
    await db.prepare('INSERT INTO film_guesses (created_at, guess) VALUES (?1, ?2)').bind(new Date().toISOString(), guess).run();
  } catch (err) {
    console.warn('[stats] film guess write failed', err instanceof Error ? err.message : err);
  }
}

export interface FilmGuessStats {
  count: number;
  /** Rounded to one decimal place; null with no guesses. */
  mean: number | null;
  median: number | null;
  answer: number;
  /** Guesses below the answer, equal to it, and above it. */
  below: number;
  exact: number;
  above: number;
  /** Counts per band of ten: "0-9", "10-19", ... "90-100". */
  byTen: Record<string, number>;
}

/** Aggregate film guesses. Pure, so it is tested without a database. Out-of-range values are ignored. */
export function aggregateFilmGuesses(raw: unknown[]): FilmGuessStats {
  const guesses = raw.map(cleanFilmGuess).filter((g): g is number => g !== null).sort((a, b) => a - b);
  const byTen: Record<string, number> = {};
  for (let lo = 0; lo <= 90; lo += 10) byTen[lo === 90 ? '90-100' : `${lo}-${lo + 9}`] = 0;
  for (const g of guesses) {
    const lo = Math.min(90, Math.floor(g / 10) * 10);
    bump(byTen, lo === 90 ? '90-100' : `${lo}-${lo + 9}`);
  }
  const n = guesses.length;
  const mid = n >> 1;
  return {
    count: n,
    mean: n ? Math.round((guesses.reduce((a, b) => a + b, 0) / n) * 10) / 10 : null,
    median: n ? (n % 2 ? guesses[mid]! : (guesses[mid - 1]! + guesses[mid]!) / 2) : null,
    answer: FILM_ANSWER,
    below: guesses.filter((g) => g < FILM_ANSWER).length,
    exact: guesses.filter((g) => g === FILM_ANSWER).length,
    above: guesses.filter((g) => g > FILM_ANSWER).length,
    byTen,
  };
}

interface Row {
  tactics: string | null;
  outcome: string | null;
  guided_m1: string | null;
  guided_m2: string | null;
  guided_m3: string | null;
  guided_m4: string | null;
  guided_m5: string | null;
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
    guidedFirstRating: Object.fromEntries(GUIDED_MOMENT_IDS.map((id) => [id, {}])),
    guidedCompleted: 0,
    filmGuesses: null,
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
    // Ids from the earlier three-moment replay are not in the current content and are skipped.
    const raw: Record<MomentId, string | null> = { m1: r.guided_m1, m2: r.guided_m2, m3: r.guided_m3, m4: r.guided_m4, m5: r.guided_m5 };
    const guided: Partial<Record<MomentId, string>> = {};
    for (const id of GUIDED_MOMENT_IDS) {
      const choice = raw[id];
      if (!choice || !GUIDED_CHOICES[id]?.has(choice)) continue;
      guided[id] = choice;
      bump(out.guidedFirstChoice[id]!, choice);
      bump(out.guidedFirstRating[id]!, RATING[choice] ?? 'unknown');
    }
    if (GUIDED_MOMENT_IDS.every((id) => guided[id])) out.guidedCompleted++;
  }
  return out;
}

export async function readStats(db: D1Database): Promise<StatsResponse> {
  const { results } = await db.prepare('SELECT tactics, outcome, guided_m1, guided_m2, guided_m3, guided_m4, guided_m5 FROM playthroughs').all<Row>();
  const out = aggregate(results ?? []);
  try {
    const film = await db.prepare('SELECT guess FROM film_guesses').all<{ guess: number }>();
    out.filmGuesses = aggregateFilmGuesses((film.results ?? []).map((r) => r.guess));
  } catch (err) {
    // Most likely migration 0004 has not been applied yet; the rest of the stats still answer.
    console.warn('[stats] film guesses unavailable', err instanceof Error ? err.message : err);
  }
  return out;
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
