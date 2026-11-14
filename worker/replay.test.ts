import { describe, expect, it } from 'vitest';
import type { ManDecision, ManStance } from '../shared/types';
import type { LogEntry } from './log';
import { buildReplay } from './replay';
import { HARASSMENT_RESEARCH } from './research';
import { buildSummary } from './summary';

const man = (stance: ManStance, action: ManDecision['action']): ManDecision => ({
  stance,
  action,
  emotion: 'annoyed',
  emotionIntensity: 0.5,
  proximity: 1.2,
});

describe('replay', () => {
  it('keeps the key moments and attaches the cited tip, with no extra statistic', () => {
    const log: LogEntry[] = [
      { kind: 'player', t: 4, turn: 1, event: 'speech', text: 'Leave me alone.', strategy: 'firm_boundary' },
      { kind: 'decision', t: 5, turn: 1, man: man('guilt', 'stay'), fear: 0.3, tension: 0.3, drivers: [] },
      { kind: 'decision', t: 12, turn: 2, man: man('hostile', 'stay'), fear: 0.5, tension: 0.6, drivers: [] },
      { kind: 'decision', t: 13, turn: 2, man: man('intimidate', 'lean_in'), fear: 0.7, tension: 0.8, drivers: [] },
      { kind: 'player', t: 20, turn: 3, event: 'filming_start' },
      { kind: 'player', t: 22, turn: 3, event: 'speech', text: 'Leave her alone.', strategy: 'direct', target: 'man' },
      { kind: 'player', t: 30, turn: 4, event: 'speech', text: 'Hey, do you know the way to the train?', strategy: 'distract', target: 'woman' },
      { kind: 'line', t: 6, turn: 1, speaker: 'man', text: 'I was only saying hello.', source: 'bank' },
    ];
    const replay = buildReplay(log, 'bystander');
    expect(replay.map((m) => m.kind)).toEqual(['boundary', 'escalation', 'escalation', 'gesture', 'filming', 'bystander', 'bystander']);
    expect(replay[0].text).toMatch(/Leave me alone/);
    expect(replay[0].tip).toBe(HARASSMENT_RESEARCH.replayTips.boundary.text);
    expect(replay[3].text).toMatch(/leans in/);
    expect(replay[3].tip).toBe(HARASSMENT_RESEARCH.replayTips.gesture.text);
    expect(replay[4].tip).toMatch(/someone else is already helping/);
    expect(replay[5].label).toBe('Direct');
    expect(replay[5].tip).toBe(HARASSMENT_RESEARCH.replayTips.direct.text);
    expect(replay[6].label).toBe('Distract');
    for (const row of replay) {
      expect(row.sourceUrl).toMatch(/^https:\/\//);
      expect(row.tip).not.toMatch(/\b(rape|pussy|kill you|nigger)\b/i);
    }
    const summary = buildSummary({ id: 'r', pov: 'bystander', seed: 1, createdAt: 0 }, log, 'intervened_he_left');
    expect(summary.replay).toEqual(replay);
    expect(buildReplay([], 'woman')).toEqual([]);
  });

  it('does not repeat a gesture while he holds the same one', () => {
    const log: LogEntry[] = [
      { kind: 'decision', t: 1, turn: 1, man: man('follow', 'follow_behind'), fear: 0.2, tension: 0.2, drivers: [] },
      { kind: 'decision', t: 4, turn: 2, man: man('follow', 'follow_behind'), fear: 0.2, tension: 0.3, drivers: [] },
    ];
    const replay = buildReplay(log, 'woman');
    expect(replay.filter((m) => m.kind === 'gesture')).toHaveLength(1);
  });
});
