import { describe, expect, it } from 'vitest';
import { emptyMemory, memoryBlock, noteTurn } from './memory';
import { womanUserPrompt } from './write';

describe('conversation memory', () => {
  it('keeps a fact from an earlier turn in the next prompt', () => {
    let memory = emptyMemory();
    memory = noteTurn(memory, 'player', 'My boyfriend is waiting. Leave me alone.');
    memory = noteTurn(memory, 'him', 'I was only being friendly.');
    memory = noteTurn(memory, 'player', 'I said stop following me.');
    expect(memory.facts.join(' ')).toMatch(/boyfriend/);
    expect(memory.facts.join(' ')).toMatch(/firm boundary/);
    expect(memory.facts.join(' ')).toMatch(/only being friendly/);
    expect(memory.summary).toMatch(/PLAYER:.*boyfriend/i);
    expect(memory.summary).toMatch(/HIM:/);

    const prompt = womanUserPrompt({
      stance: 'persist',
      emotion: 'annoyed',
      event: 'speech',
      herWords: 'Stop following me.',
      strategy: 'firm_boundary',
      ctx: { elapsed: 40, distanceToMan: 2, progress: 0.4, playerSpeed: 1.2, facingMan: true, manBlocking: false, oppositeSidewalk: false },
      action: 'stay',
      recent: [],
      avoidLines: [],
      avoidThoughts: [],
      dice: [0.1, 0.2],
      memory,
    });
    expect(prompt).toMatch(/do not contradict/i);
    expect(prompt).toMatch(/boyfriend/);
    expect(prompt).toMatch(/only being friendly/);
    expect(prompt).toMatch(/Stop following me/);
    expect(memoryBlock(emptyMemory())).toBe('');
  });

  it('does not drop the boyfriend fact on a later turn that never mentions him', () => {
    let memory = noteTurn(emptyMemory(), 'player', 'My name is Mara and my boyfriend is waiting.');
    memory = noteTurn(memory, 'him', 'Where you headed?');
    memory = noteTurn(memory, 'player', 'I am going home.');
    expect(memory.facts.join(' ')).toMatch(/boyfriend/);
    expect(memory.facts.join(' ')).toMatch(/name is Mara/);
    expect(memory.facts.join(' ')).toMatch(/going home/);
    expect(memory.summary.split('\n').length).toBeLessThanOrEqual(4);
  });
});
