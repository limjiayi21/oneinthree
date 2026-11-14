import { describe, expect, it } from 'vitest';
import { settlePlan } from './converse';

const base = {
  fromStance: 'opening' as const,
  recent: [],
  distance: 2,
  speed: 1,
  turn: 1,
  rejections: 0,
};

describe('conversation plan', () => {
  it('keeps the model reply on a greeting, including a cold one', () => {
    const plan = settlePlan(
      { ...base, text: 'hello' },
      { stance: 'hostile', emotion: 'annoyed', action: 'step_closer', line: 'Hello is all I get from you?', intensity: 0.7 },
    );
    expect(plan?.stance).toBe('hostile');
    expect(plan?.emotion).toBe('annoyed');
    expect(plan?.action).toBe('step_closer');
    expect(plan?.line).toMatch(/Hello is all I get from you\?/);
  });

  it('keeps a decision to leave when that is what the model chose', () => {
    const plan = settlePlan(
      { ...base, text: 'Leave me alone.' },
      { stance: 'back_off', emotion: 'sheepish', action: 'leave', line: 'Fine. Leave me alone, then.', intensity: 0.4 },
    );
    expect(plan?.stance).toBe('back_off');
    expect(plan?.action).toBe('leave');
  });

  it('keeps a chase when he is already following and she is hurrying', () => {
    const plan = settlePlan(
      { ...base, fromStance: 'follow', text: 'I said leave me alone.', distance: 6, speed: 2.4, turn: 3, rejections: 1 },
      { stance: 'follow', emotion: 'determined', action: 'run_after', line: 'Leave me alone? I can keep up.', intensity: 0.7 },
    );
    expect(plan?.stance).toBe('follow');
    expect(plan?.action).toBe('run_after');
  });
});
