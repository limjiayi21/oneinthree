/**
 * The controls, one at a time: a short prompt per movement control, about 2 s each, at the start of
 * each part. It does not wait for the player; they can already walk while it runs. Played with the
 * body, it teaches the body's controls instead: stepping in place (the phone) and turning the head.
 * Once per part per page load; ?tutorial=0 turns it off, ?tutorial=1 shows it every time.
 */
import type { Pov } from '../../shared/types';
import type { SceneKit } from './common';
import type { Hud, PlayMode } from '../contracts';

/** In order. Each names its key after "Hold", so the HUD draws it as a keycap. */
export const KEY_TUTORIAL = [
  'Hold W to walk forward',
  'Hold S to step back',
  'Hold A to step left',
  'Hold D to step right',
  'Hold Shift to hurry',
  'Move the mouse to look around',
] as const;

/**
 * The prompts for how they are playing. With the body: walking and hurrying come from stepping in
 * place with the phone (the keys if no phone is paired, as they still work then), and looking and
 * turning come from the head (webcam or AirPods). The phone has no stepping back or sideways.
 */
export function tutorialSteps(mode: PlayMode, phoneWalks: boolean): string[] {
  if (mode !== 'immersive') return [...KEY_TUTORIAL];
  return [
    phoneWalks ? 'Step in place to walk forward' : 'Hold W to walk forward',
    phoneWalks ? 'Step faster to hurry' : 'Hold Shift to hurry',
    'Turn your head to look around',
    'Keep your head turned to turn around',
  ];
}

/** Seconds per prompt. */
export const KEY_TUTORIAL_STEP = 2;

const shown = new Set<Pov>();

export function shouldRunKeyTutorial(pov: Pov, flag: string | null): boolean {
  if (flag === '0') return false;
  if (flag === '1') return true;
  return !shown.has(pov);
}

/**
 * Starts the prompts `delay` scene-seconds from now. Returns the scene time at which the last one
 * ends (or now, if it does not run), so other hints can wait until after it.
 */
export function runKeyTutorial(
  kit: SceneKit,
  hud: Pick<Hud, 'hint'>,
  pov: Pov,
  how: { mode?: PlayMode; phoneWalks: boolean },
  delay = 0.4,
): number {
  const flag = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('tutorial');
  if (!shouldRunKeyTutorial(pov, flag)) return kit.time;
  shown.add(pov);
  const steps = tutorialSteps(how.mode ?? 'analog', how.phoneWalks);
  steps.forEach((text, i) => {
    kit.after(delay + i * KEY_TUTORIAL_STEP, () => {
      if (!kit.ended) hud.hint(text, KEY_TUTORIAL_STEP * 1000 - 120);
    });
  });
  return kit.time + delay + steps.length * KEY_TUTORIAL_STEP;
}
