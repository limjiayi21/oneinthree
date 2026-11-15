import { describe, expect, it } from 'vitest';
import { KEY_TUTORIAL, KEY_TUTORIAL_STEP, shouldRunKeyTutorial, tutorialSteps } from './keyTutorial';

describe('key tutorial', () => {
  it('covers every movement control, one prompt each', () => {
    const text = KEY_TUTORIAL.join(' | ');
    for (const key of ['Hold W', 'Hold S', 'Hold A', 'Hold D', 'Hold Shift', 'mouse']) expect(text).toContain(key);
    expect(KEY_TUTORIAL).toHaveLength(6);
  });

  it('takes about 2 s per prompt', () => {
    expect(KEY_TUTORIAL_STEP).toBe(2);
  });

  it('?tutorial=0 turns it off and ?tutorial=1 forces it on', () => {
    expect(shouldRunKeyTutorial('woman', '0')).toBe(false);
    expect(shouldRunKeyTutorial('woman', '1')).toBe(true);
  });

  it('runs by default for a part that has not shown it yet', () => {
    expect(shouldRunKeyTutorial('bystander', null)).toBe(true);
  });
});

describe('key tutorial in body mode', () => {
  it('keyboard mode keeps the six key prompts', () => {
    expect(tutorialSteps('analog', false)).toEqual([...KEY_TUTORIAL]);
    expect(tutorialSteps('analog', true)).toEqual([...KEY_TUTORIAL]);
  });

  it('with a paired phone: step to walk, step faster to hurry, then head look and turning', () => {
    expect(tutorialSteps('immersive', true)).toEqual([
      'Step in place to walk forward',
      'Step faster to hurry',
      'Turn your head to look around',
      'Keep your head turned to turn around',
    ]);
  });

  it('without a phone the walking prompts fall back to the keys, the looking ones stay on the head', () => {
    expect(tutorialSteps('immersive', false)).toEqual([
      'Hold W to walk forward',
      'Hold Shift to hurry',
      'Turn your head to look around',
      'Keep your head turned to turn around',
    ]);
  });
});
