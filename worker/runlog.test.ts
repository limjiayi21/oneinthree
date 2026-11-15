import { describe, expect, it } from 'vitest';
import type { SummaryData } from '../shared/types';
import { runDoc } from './runlog';

const summary: SummaryData = {
  pov: 'bystander',
  outcome: { kind: 'intervened_he_left', title: 'You stepped in, and he left.', body: 'b' },
  durationSec: 41.6,
  timeline: [
    { t: 1, actor: 'man', text: 'Where you headed, gorgeous?' },
    { t: 9, actor: 'you', text: 'Hey Sarah, we are going to miss the bus', label: 'Distract (to her)' },
    { t: 12, actor: 'woman', text: 'Oh, yes, hi!' },
    { t: 18, actor: 'you', text: 'Are you okay?' },
  ],
  insights: [],
  statIds: ['loreal_helped_25'],
  fiveDs: [
    { key: 'distract', used: true, moments: ['Hey Sarah, we are going to miss the bus'], feedback: 'f' },
    { key: 'direct', used: false, moments: [], feedback: 'f' },
  ],
  modelNotes: [],
};

describe('MongoDB run record', () => {
  it('keeps what the player did and none of the words', () => {
    const doc = runDoc('abc12345', summary, new Date(0));
    expect(doc).toEqual({
      _id: 'abc12345',
      pov: 'bystander',
      outcome: 'intervened_he_left',
      durationSec: 42,
      actions: 2,
      labels: ['Distract (to her)'],
      fiveDs: { distract: true, direct: false },
      statIds: ['loreal_helped_25'],
      at: new Date(0),
    });
    const stored = JSON.stringify(doc);
    for (const e of summary.timeline) expect(stored).not.toContain(e.text);
  });

  it('has no 5 Ds for Part 1', () => {
    expect(runDoc('abc12345', { ...summary, pov: 'woman', fiveDs: undefined }).fiveDs).toBeUndefined();
  });
});
