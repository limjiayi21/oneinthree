import { describe, expect, it } from 'vitest';
import { askedIn, emptyStory, factsIn, nextWant, noteHer, noteHim, storyBrief } from './story';

describe('what he asked', () => {
  it('recognises the usual asks in his own words', () => {
    expect(askedIn("What's your name, miss?")).toContain('name');
    expect(askedIn('Where you headed, sweetheart?')).toContain('where');
    expect(askedIn('Lemme walk with you.')).toContain('walk_with');
    expect(askedIn('Gimme your number.')).toContain('number');
    expect(askedIn("I'll walk you home, it's late.")).toContain('walk_home');
    expect(askedIn('Come grab a drink with me.')).toContain('come_with');
    expect(askedIn('C\'mon, smile for me.')).toContain('smile');
    expect(askedIn('You got a boyfriend or what?')).toContain('partner');
    expect(askedIn('Nice night, huh?')).toEqual([]);
  });
});

describe('what she said', () => {
  it('picks up her name, a partner and where she is going', () => {
    expect(factsIn('My name is Sarah.').name).toBe('Sarah');
    expect(factsIn("I'm Jess.").name).toBe('Jess');
    expect(factsIn('call me priya').name).toBe('Priya');
    expect(factsIn('I have a boyfriend.').partner).toBe('boyfriend');
    expect(factsIn("I'm married.").partner).toBe('married');
    expect(factsIn("I'm heading home.").destination).toBe('home');
    expect(factsIn("I'm going to my sister's place.").destination).toBe("to my sister's place");
  });

  it('does not mistake how she feels for her name', () => {
    for (const t of ["I'm tired.", "I'm fine, thanks.", "I'm good.", "I'm just heading home.", "I'm late.", "I'm calling the police."]) expect(factsIn(t).name, t).toBeUndefined();
  });
});

describe('the story', () => {
  it('remembers across turns and never forgets an answer', () => {
    let s = emptyStory();
    s = noteHim(s, "Hey sweetheart, what's your name?");
    s = noteHer(s, 'My name is Sarah.');
    s = noteHim(s, 'Where you headed, Sarah?');
    s = noteHer(s, 'Home.');
    s = noteHer(s, "I'm heading home.");
    expect(s.facts.name).toBe('Sarah');
    expect(s.facts.destination).toBe('home');
    expect(s.asked).toEqual(['name', 'where']);
    expect(s.lines).toHaveLength(5);
    const brief = storyBrief(s, 1);
    expect(brief).toContain('her name is Sarah');
    expect(brief).toContain('her name, where she is going');
    expect(brief).toContain('Do not ask any of these again');
  });

  it('wants a little more each time, and something else once he is angry', () => {
    let s = emptyStory();
    expect(nextWant(s, 1)).toBe('her name');
    s = noteHim(s, "What's your name?");
    expect(nextWant(s, 1)).toBe('where she is going');
    s = noteHer(s, "I'm going home.");
    expect(nextWant(s, 1)).toBe('to walk along with her');
    s = noteHim(s, "I'll walk with you.");
    expect(nextWant(s, 2)).toBe('her number');
    expect(nextWant(s, 4)).toMatch(/respect/);
  });

  it('keeps the whole encounter, not just the last few lines', () => {
    let s = emptyStory();
    for (let i = 0; i < 30; i++) s = noteHer(s, `line ${i}`);
    expect(s.lines).toHaveLength(30);
    expect(s.lines[0]).toBe('HER: line 0');
  });
});
