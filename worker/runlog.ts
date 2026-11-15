/**
 * Finished runs and coach use, in MongoDB, and the aggregations /api/stats
 * shows from them.
 *
 * Same rule as worker/stats.ts: what the player did, never what they said.
 * No transcripts, no typed or spoken words, no audio, no debrief text. Only
 * the outcome, the length, the game's own labels for each action (e.g.
 * "Distract", "Firm boundary"), which of the 5 Ds were used, and for the
 * coach: which research it cited and how the grounding check went.
 *
 *   runs         one document per session (_id = session id), upserted when its summary is read
 *   coach_runs   one document per coach debrief or answer
 *
 * Every write is best effort and runs after the response (ctx.waitUntil).
 */
import type { Db } from 'mongodb';
import type { FiveDResult, Pov, SummaryData } from '../shared/types';
import type { CheckSummary } from '../shared/coach';

export interface RunDoc {
  _id: string;
  pov: Pov;
  outcome: string;
  durationSec: number;
  /** Number of things the player said or did that the game recorded. */
  actions: number;
  /** The game's label for each of them, in order (no words). */
  labels: string[];
  /** Part 2 only: which of the 5 Ds the game saw. */
  fiveDs?: Partial<Record<FiveDResult['key'], boolean>>;
  statIds: string[];
  at: Date;
}

export interface CoachRunDoc {
  session: string;
  kind: 'debrief' | 'answer';
  ok: boolean;
  model: string;
  embedModel: string;
  /** How each research search was answered (atlas / semantic / keyword). */
  searches: Record<string, number>;
  cited: string[];
  checked?: CheckSummary;
  ms: number;
  at: Date;
}

/** The anonymous record of one finished part. */
export function runDoc(sessionId: string, s: SummaryData, at = new Date()): RunDoc {
  const mine = s.timeline.filter((e) => e.actor === 'you');
  return {
    _id: sessionId,
    pov: s.pov,
    outcome: s.outcome.kind,
    durationSec: Math.round(s.durationSec),
    actions: mine.length,
    labels: mine.map((e) => e.label).filter((l): l is string => Boolean(l)),
    ...(s.fiveDs ? { fiveDs: Object.fromEntries(s.fiveDs.map((d) => [d.key, d.used])) } : {}),
    statIds: s.statIds,
    at,
  };
}

export async function saveRun(db: Db, doc: RunDoc): Promise<void> {
  const { _id, ...rest } = doc;
  await db.collection<RunDoc>('runs').replaceOne({ _id }, rest, { upsert: true });
}

export async function saveCoachRun(db: Db, doc: CoachRunDoc): Promise<void> {
  await db.collection<CoachRunDoc>('coach_runs').insertOne(doc);
}

/* ------------------------------------------------------------------ aggregations */

export interface RunInsights {
  runs: number;
  /** Per part: how many runs, average length, and the outcomes. */
  byPov: { pov: Pov; runs: number; avgSec: number; outcomes: Record<string, number> }[];
  /** Part 2: share of runs in which each of the 5 Ds was used (0..1). */
  fiveDsUsed: Record<string, number>;
  /** Part 2: outcome counts for runs that used each D, to see which approaches end well. */
  outcomeByD: Record<string, Record<string, number>>;
  /** The game's labels for player actions, most common first. */
  topLabels: { label: string; n: number }[];
  coach: { debriefs: number; answers: number; avgMs: number; revisedShare: number; topCited: { id: string; n: number }[]; searches: Record<string, number> };
}

const D_KEYS: FiveDResult['key'][] = ['distract', 'delegate', 'document', 'delay', 'direct'];

export async function readInsights(db: Db): Promise<RunInsights> {
  const runs = db.collection<RunDoc>('runs');
  const coach = db.collection<CoachRunDoc>('coach_runs');

  const [byPovRaw, fiveDsRaw, outcomeByDRaw, labelsRaw, coachRaw, citedRaw, searchesRaw] = await Promise.all([
    runs
      .aggregate<{ _id: { pov: Pov; outcome: string }; n: number; sec: number }>([
        { $group: { _id: { pov: '$pov', outcome: '$outcome' }, n: { $sum: 1 }, sec: { $sum: '$durationSec' } } },
      ])
      .toArray(),
    runs
      .aggregate<Record<string, number>>([
        { $match: { pov: 'bystander' } },
        { $group: { _id: null, total: { $sum: 1 }, ...Object.fromEntries(D_KEYS.map((d) => [d, { $sum: { $cond: [{ $eq: [`$fiveDs.${d}`, true] }, 1, 0] } }])) } },
      ])
      .toArray(),
    runs
      .aggregate<{ _id: { d: string; outcome: string }; n: number }>([
        { $match: { pov: 'bystander' } },
        { $project: { outcome: 1, ds: { $objectToArray: { $ifNull: ['$fiveDs', {}] } } } },
        { $unwind: '$ds' },
        { $match: { 'ds.v': true } },
        { $group: { _id: { d: '$ds.k', outcome: '$outcome' }, n: { $sum: 1 } } },
      ])
      .toArray(),
    runs
      .aggregate<{ _id: string; n: number }>([{ $unwind: '$labels' }, { $group: { _id: '$labels', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 10 }])
      .toArray(),
    coach
      .aggregate<{ _id: string; n: number; ms: number; revised: number }>([
        { $match: { ok: true } },
        { $group: { _id: '$kind', n: { $sum: 1 }, ms: { $sum: '$ms' }, revised: { $sum: { $cond: [{ $gt: [{ $add: [{ $ifNull: ['$checked.revisions', 0] }, { $ifNull: ['$checked.removed', 0] }] }, 0] }, 1, 0] } } } },
      ])
      .toArray(),
    coach
      .aggregate<{ _id: string; n: number }>([{ $unwind: '$cited' }, { $group: { _id: '$cited', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 10 }])
      .toArray(),
    coach
      .aggregate<{ _id: string; n: number }>([{ $project: { s: { $objectToArray: '$searches' } } }, { $unwind: '$s' }, { $group: { _id: '$s.k', n: { $sum: '$s.v' } } }])
      .toArray(),
  ]);

  const povs = new Map<Pov, { runs: number; sec: number; outcomes: Record<string, number> }>();
  for (const r of byPovRaw) {
    const p = povs.get(r._id.pov) ?? { runs: 0, sec: 0, outcomes: {} };
    p.runs += r.n;
    p.sec += r.sec;
    p.outcomes[r._id.outcome] = r.n;
    povs.set(r._id.pov, p);
  }
  const f = fiveDsRaw[0];
  const outcomeByD: Record<string, Record<string, number>> = {};
  for (const r of outcomeByDRaw) (outcomeByD[r._id.d] ??= {})[r._id.outcome] = r.n;
  const kinds = Object.fromEntries(coachRaw.map((r) => [r._id, r]));
  const coachN = coachRaw.reduce((n, r) => n + r.n, 0);

  return {
    runs: [...povs.values()].reduce((n, p) => n + p.runs, 0),
    byPov: [...povs.entries()].map(([pov, p]) => ({ pov, runs: p.runs, avgSec: Math.round(p.sec / Math.max(1, p.runs)), outcomes: p.outcomes })),
    fiveDsUsed: f?.total ? Object.fromEntries(D_KEYS.map((d) => [d, Math.round((f[d] / f.total) * 100) / 100])) : {},
    outcomeByD,
    topLabels: labelsRaw.map((r) => ({ label: r._id, n: r.n })),
    coach: {
      debriefs: kinds.debrief?.n ?? 0,
      answers: kinds.answer?.n ?? 0,
      avgMs: Math.round(coachRaw.reduce((n, r) => n + r.ms, 0) / Math.max(1, coachN)),
      revisedShare: Math.round((coachRaw.reduce((n, r) => n + r.revised, 0) / Math.max(1, coachN)) * 100) / 100,
      topCited: citedRaw.map((r) => ({ id: r._id, n: r.n })),
      searches: Object.fromEntries(searchesRaw.map((r) => [r._id, r.n])),
    },
  };
}
