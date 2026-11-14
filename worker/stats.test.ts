/** Playthrough logging: what is extracted from a session, and how rows are counted. No database needed. */
import { describe, expect, it } from 'vitest';
import type { ClientEventType } from '../shared/types';
import type { LogEntry } from './log';
import { aggregate, cleanGuidedChoices, codeMatches, tacticsFromLog } from './stats';

const player = (event: ClientEventType, tactic?: string, text?: string): LogEntry => ({
  kind: 'player',
  t: 0,
  turn: 0,
  event,
  tactic: tactic ?? null,
  text,
});

describe('tacticsFromLog', () => {
  it('keeps tactics in order, collapses immediate repeats, and never reads words', () => {
    const log: LogEntry[] = [
      player('begin'),
      player('speech', 'distract', 'hey, do you know the time?'),
      player('speech', 'distract', 'hello?'),
      player('filming_start', 'document'),
      { kind: 'line', t: 1, turn: 1, speaker: 'man', text: 'Mind your business.', source: 'bank' },
      player('speech', 'delay', 'are you okay?'),
    ];
    const tactics = tacticsFromLog(log);
    expect(tactics).toEqual(['distract', 'document', 'delay']);
    expect(JSON.stringify(tactics)).not.toMatch(/hey|hello|okay|business/i);
  });

  it('is empty when nobody intervened', () => {
    expect(tacticsFromLog([player('begin'), player('scene_timeout')])).toEqual([]);
  });
});

describe('cleanGuidedChoices', () => {
  it('keeps only real moments and the choices that belong to them', () => {
    expect(cleanGuidedChoices({ m1: 'm1_phone', m2: 'm1_watch', m3: 'm3_film', m5: 'm5_blame', m9: 'x', m4: 3 })).toEqual({ m1: 'm1_phone', m3: 'm3_film', m5: 'm5_blame' });
    expect(cleanGuidedChoices(null)).toEqual({});
    expect(cleanGuidedChoices(['m1_phone'])).toEqual({});
  });
});

describe('aggregate', () => {
  const none = { guided_m1: null, guided_m2: null, guided_m3: null, guided_m4: null, guided_m5: null };
  it('counts outcomes, tactics, first tactics, and first choices at all five moments', () => {
    const stats = aggregate([
      {
        tactics: '["distract","delay"]',
        outcome: 'intervened_he_left',
        guided_m1: 'm1_watch',
        guided_m2: 'm2_my_business',
        guided_m3: 'm3_distract',
        guided_m4: 'm4_direct',
        guided_m5: 'm5_delay',
      },
      { tactics: '[]', outcome: 'no_intervention_she_escaped', ...none, guided_m1: 'm1_phone', guided_m2: 'm2_wait_clerk', guided_m3: 'm3_film', guided_m4: 'm4_insult' },
      { tactics: '["direct","direct"]', outcome: null, ...none },
      { tactics: 'not json', outcome: 'intervened_she_safe', ...none },
    ]);
    expect(stats.playthroughs).toBe(4);
    expect(stats.withOutcome).toBe(3);
    expect(stats.outcomes).toEqual({ intervened_he_left: 1, no_intervention_she_escaped: 1, intervened_she_safe: 1 });
    expect(stats.tacticsUsed).toEqual({ distract: 1, delay: 1, direct: 1 });
    expect(stats.firstTactic).toEqual({ distract: 1, none: 2, direct: 1 });
    expect(stats.guidedFirstChoice).toEqual({
      m1: { m1_watch: 1, m1_phone: 1 },
      m2: { m2_my_business: 1, m2_wait_clerk: 1 },
      m3: { m3_distract: 1, m3_film: 1 },
      m4: { m4_direct: 1, m4_insult: 1 },
      m5: { m5_delay: 1 },
    });
    expect(stats.guidedFirstRating).toEqual({
      m1: { best: 1, weaker: 1 },
      m2: { best: 1, weaker: 1 },
      m3: { good: 1, weaker: 1 },
      m4: { best: 1, backfires: 1 },
      m5: { best: 1 },
    });
    expect(stats.guidedCompleted).toBe(1);
  });

  it('skips choice ids left over from the earlier three-moment replay', () => {
    const stats = aggregate([{ tactics: '[]', outcome: 'intervened_he_left', ...none, guided_m1: 'm1_distract', guided_m2: 'm2_delegate', guided_m3: 'm3_delay' }]);
    expect(stats.guidedFirstChoice).toEqual({ m1: {}, m2: {}, m3: {}, m4: {}, m5: {} });
    expect(stats.guidedCompleted).toBe(0);
  });
});

describe('codeMatches', () => {
  it('needs a configured code and an exact match', () => {
    expect(codeMatches('abc', 'abc')).toBe(true);
    expect(codeMatches('abd', 'abc')).toBe(false);
    expect(codeMatches('ab', 'abc')).toBe(false);
    expect(codeMatches(null, 'abc')).toBe(false);
    expect(codeMatches('abc', undefined)).toBe(false);
    expect(codeMatches('', '')).toBe(false);
  });
});
