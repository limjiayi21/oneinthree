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

describe('matchSpoken: everyday wording (from a real run that picked nothing)', () => {
  const m1: SpokenChoice[] = [{ index: 0, line: 'Hey, you alright?', tag: 'Check in' }];
  const m2: SpokenChoice[] = [
    { index: 0, line: "Hey! Sorry I'm late, you ready?", tag: 'Distract' },
    { index: 1, line: "Hey! Can you come out here? He won't leave her alone.", tag: 'Delegate' },
  ];
  const m4: SpokenChoice[] = [
    { index: 0, line: 'Hey! Back off. Leave her alone.', tag: 'Direct' },
    { index: 1, line: "I'm calling the police.", tag: 'Delegate' },
    { index: 2, line: 'Back off, creep. You want a problem?', tag: 'Insult, risky' },
  ];

  it('one clearly typical word is enough to check in on her', () => {
    expect(matchSpoken('Are you okay?', m1)).toBe(0);
    expect(matchSpoken('You good?', m1)).toBe(0);
    expect(matchSpoken('Hey are you ok', m1)).toBe(0);
  });

  it('"leave her alone" is telling him, not calling the shopkeeper (whose line also says it)', () => {
    expect(matchSpoken('Leave her alone', m3)).toBe(0);
    expect(matchSpoken('Get away from her', m3)).toBe(0);
  });

  it('pretending to know her is the distraction', () => {
    expect(matchSpoken('Hey there you are', m2)).toBe(0);
  });

  it('a short firm "stop" is telling him directly', () => {
    expect(matchSpoken('Stop it right now', m4)).toBe(0);
    expect(matchSpoken('I am calling the cops', m4)).toBe(1);
    expect(matchSpoken('Back off you creep', m4)).toBe(2);
  });
});
