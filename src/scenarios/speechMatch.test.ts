import { describe, expect, it } from 'vitest';
import { matchSpoken, type SpokenChoice } from './speechMatch';

// The options of the moment with two spoken lines and a call for help ("She can't get past him").
const m3: SpokenChoice[] = [
  { index: 0, line: 'Leave her alone, man.', tag: 'Direct' },
  { index: 1, line: "Excuse me, which way's the subway?", tag: 'Distract' },
  { index: 2, line: "Hey! Can you come out here? He won't leave her alone.", tag: 'Delegate' },
];
const m2: SpokenChoice[] = [{ index: 0, line: "Hey! Sorry I'm late, you ready?", tag: 'Distract' }];
const m5: SpokenChoice[] = [
  { index: 0, line: 'Are you okay? Want me to walk with you?', tag: 'Delay' },
  { index: 1, line: 'Do you want me to call someone?', tag: 'Delay' },
];

describe('matchSpoken', () => {
  it('picks the option that was actually said, not the first one', () => {
    expect(matchSpoken("Excuse me, which way's the subway?", m3)).toBe(1);
    expect(matchSpoken('Leave her alone, man.', m3)).toBe(0);
  });

  it('copes with the speech-to-text wording and punctuation', () => {
    expect(matchSpoken('excuse me which way is the subway', m3)).toBe(1);
    expect(matchSpoken('hey sorry im late are you ready', m2)).toBe(0);
  });

  it('accepts a paraphrase in the spirit of the option', () => {
    expect(matchSpoken('Back off, leave her be', m3)).toBe(0);
    expect(matchSpoken("Where's the train station?", m3)).toBe(1);
    expect(matchSpoken('Can you call someone for you?', m5)).toBe(1);
    expect(matchSpoken('You alright? I can walk you home', m5)).toBe(0);
  });

  it('calling to the shopkeeper is the Delegate option', () => {
    expect(matchSpoken('Hey can you come out here and help', m3)).toBe(2);
  });

  it('picks nothing when what was said fits none of the options', () => {
    expect(matchSpoken('I like your shoes', m3)).toBe(-1);
    expect(matchSpoken('', m3)).toBe(-1);
    expect(matchSpoken('um', m5)).toBe(-1);
  });
});
