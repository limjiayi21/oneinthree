import { describe, expect, it } from 'vitest';
import { emptyStory, noteHer, noteHim, storyBrief } from './story';
import { WOMAN_SYSTEM, womanUserPrompt } from './write';

describe('the line writer gets the whole story', () => {
  it('includes what he knows, what he asked, what he wants, and the full encounter', () => {
    let s = emptyStory();
    s = noteHim(s, "Hey sweetheart, what's your name?");
    s = noteHer(s, 'My name is Sarah.');
    for (let i = 0; i < 8; i++) {
      s = noteHim(s, `filler line ${i}`);
      s = noteHer(s, `reply ${i}`);
    }
    const prompt = womanUserPrompt({
      stance: 'persist',
      level: 2,
      emotion: 'smirk',
      event: 'speech',
      herWords: 'Why are you following me?',
      strategy: 'firm_boundary',
      ctx: { elapsed: 60, distanceToMan: 1.5, progress: 0.4, playerSpeed: 1.2, facingMan: true, manBlocking: false, oppositeSidewalk: false },
      action: 'walk_alongside',
      recent: s.lines,
      memory: storyBrief(s, 2),
      avoidLines: [],
      avoidThoughts: [],
      dice: [0.1, 0.2],
    });
    expect(prompt).toContain('her name is Sarah');
    expect(prompt).toContain('HE HAS ALREADY ASKED ABOUT: her name');
    expect(prompt).toContain('WHAT HE WANTS NOW');
    expect(prompt).toContain('HIS LEVEL: 2 of 6');
    expect(prompt).toContain('SHE JUST SAID: "Why are you following me?"');
    // more than the old five lines of history
    expect(prompt).toContain('filler line 2');
    expect(WOMAN_SYSTEM).toMatch(/if she asked him something, he answers it/);
    expect(WOMAN_SYSTEM).toMatch(/never asks something he already asked/);
  });

  it('when she says no, his line has to react to the no, with irritation, and a departure is a sour parting shot', () => {
    const base = {
      emotion: 'annoyed' as const,
      event: 'speech',
      ctx: { elapsed: 60, distanceToMan: 1.5, progress: 0.4, playerSpeed: 1.2, facingMan: true, manBlocking: false, oppositeSidewalk: false },
      action: 'walk_alongside',
      recent: [],
      avoidLines: [],
      avoidThoughts: [],
      dice: [0.3, 0.2] as [number, number],
    };
    const stays = womanUserPrompt({ ...base, stance: 'persist', level: 2, herWords: 'Get away from me.', strategy: 'firm_boundary' });
    expect(stays).toContain('That was a no');
    expect(stays).toMatch(/relax|problem|scoffs|mockingly|does not have to be like that/);
    const leaves = womanUserPrompt({ ...base, stance: 'back_off', level: 2, herWords: 'Go away, please.', strategy: 'firm_boundary' });
    expect(leaves).toMatch(/sourly|rude|stuck up|not even worth it|manners/);
    const friendly = womanUserPrompt({ ...base, stance: 'persist', level: 1, herWords: 'Hi.', strategy: 'engage' });
    expect(friendly).not.toContain('That was a no');
  });

  it('leaving once he is worked up (level 3+) is always a sour exit, even after a friendly-sounding line', () => {
    const prompt = womanUserPrompt({
      stance: 'back_off', level: 4, emotion: 'annoyed', event: 'speech', herWords: "I'm going home now.", strategy: 'engage',
      ctx: { elapsed: 90, distanceToMan: 1.5, progress: 0.6, playerSpeed: 1.2, facingMan: true, manBlocking: false, oppositeSidewalk: false },
      action: 'back_away', recent: [], avoidLines: [], avoidThoughts: [], dice: [0.5, 0.2],
    });
    expect(prompt).toMatch(/sourly|rude|stuck up|not even worth it|manners/);
  });
});
