import { describe, expect, it } from 'vitest';
import { fiveCardModels, parsePercent, pickGuessStat, GUESS_QUESTIONS } from './debriefCards';
import type { FiveDResult } from '../../shared/types';

describe('parsePercent', () => {
  it('reads percentages and "1 in N"', () => {
    expect(parsePercent('65%')).toBe(65);
    expect(parsePercent('1 in 5')).toBe(20);
    expect(parsePercent('Only 1 in 10')).toBe(10);
    expect(parsePercent('More than 1 in 3')).toBe(33);
  });
  it('refuses headlines that are not a share', () => {
    expect(parsePercent('840 million')).toBeNull();
    expect(parsePercent('About half')).toBeNull();
    expect(parsePercent('120%')).toBeNull();
  });
});

describe('pickGuessStat', () => {
  const stats = new Map([
    ['ssh2014_65', { id: 'ssh2014_65', headline: '65%', text: 'of women…', sourceId: 's' }],
    ['ssh2014_repeat_86', { id: 'ssh2014_repeat_86', headline: '86%', text: 'of US women…', sourceId: 's' }],
  ]);
  const lookup = (id: string) => stats.get(id) ?? null;

  it('prefers a curated stat the debrief already cites', () => {
    expect(pickGuessStat(['ssh2014_repeat_86'], lookup)?.stat.id).toBe('ssh2014_repeat_86');
  });
  it('falls back to the first curated stat that exists', () => {
    expect(pickGuessStat([], lookup)?.stat.id).toBe(GUESS_QUESTIONS[0].statId);
  });
  it('gives up when no curated stat resolves to a share', () => {
    expect(pickGuessStat([], () => null)).toBeNull();
  });
});

describe('fiveCardModels', () => {
  const lines = {
    distract: { name: 'Distract', line: 'Talk to her as if you know her.' },
    delegate: { name: 'Delegate', line: 'Get someone else to step in.' },
    document: { name: 'Document', line: 'Film once someone is helping.' },
    delay: { name: 'Delay', line: 'Check in with her afterwards.' },
    direct: { name: 'Direct', line: 'One short, calm sentence to him.' },
  };

  it('always returns all five in order, used ones face-up with your words', () => {
    const results: FiveDResult[] = [
      { key: 'delegate', used: true, moments: ['Can you call someone? That guy won’t leave her alone.'], feedback: 'Good.' },
      { key: 'direct', used: false, moments: [], feedback: '' },
    ];
    const cards = fiveCardModels(results, lines);
    expect(cards.map((c) => c.key)).toEqual(['distract', 'delegate', 'document', 'delay', 'direct']);
    const delegate = cards[1];
    expect(delegate.used).toBe(true);
    expect(delegate.quote).toContain('Can you call someone');
    expect(cards[0].used).toBe(false);
    expect(cards[0].example).toBe(lines.distract.line);
  });

  it('shows spoken words once, not inside a second pair of quotes', () => {
    const [card] = fiveCardModels([{ key: 'distract', used: true, moments: ['"Hey! Sorry, do you know which way the F train is?"'], feedback: '' }], lines);
    expect(card.quote).toBe('Hey! Sorry, do you know which way the F train is?');
    expect(card.spoken).toBe(true);
    const [curly] = fiveCardModels([{ key: 'distract', used: true, moments: ['“Leave her alone.”'], feedback: '' }], lines);
    expect(curly.quote).toBe('Leave her alone.');
  });

  it('an action is not shown as if it were said', () => {
    const cards = fiveCardModels([{ key: 'delegate', used: true, moments: ['You asked the shopkeeper to step in.'], feedback: '' }], lines);
    expect(cards[1].quote).toBe('You asked the shopkeeper to step in.');
    expect(cards[1].spoken).toBe(false);
  });

  it('shortens a long quote', () => {
    const long = 'word '.repeat(60).trim();
    const [card] = fiveCardModels([{ key: 'distract', used: true, moments: [long], feedback: '' }], lines);
    expect(card.quote!.length).toBeLessThanOrEqual(121);
    expect(card.quote!.endsWith('…')).toBe(true);
  });

  it('falls back to the feedback when a used tactic has no quoted moment', () => {
    const [card] = fiveCardModels([{ key: 'distract', used: true, moments: [], feedback: 'You struck up a conversation with her. That gave her a reason to stop.' }], lines);
    expect(card.quote).toBeNull();
    expect(card.note).toBe('You struck up a conversation with her.');
  });
});
