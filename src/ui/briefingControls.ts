/**
 * The controls listed on the screen before each part, for the way the player chose to play:
 * keys with the keyboard, the body's gestures with the body (phone steps, head, hands).
 */
import type { Pov } from '../../shared/types';
import type { PlayMode } from '../contracts';

export interface BriefingControl {
  /** A key, drawn as a key cap (keyboard). */
  key?: string;
  /** An emoji standing for the movement (body). */
  icon?: string;
  label: string;
}

export function briefingControls(pov: Pov, mode: PlayMode): BriefingControl[] {
  const body = mode === 'immersive';
  if (pov === 'woman') {
    return body
      ? [
          { icon: '🚶', label: 'Step in place with your phone to walk (the keys still work)' },
          { icon: '🙂', label: 'Turn your head to look around' },
          { icon: '✊', label: 'Hold up a fist and speak to talk' },
        ]
      : [
          { key: 'W A S D', label: 'Walk' },
          { key: 'Shift', label: 'Hurry' },
          { label: 'Move the mouse to look around' },
          { key: 'Space', label: 'Hold to speak' },
        ];
  }
  return body
    ? [
        { icon: '✊', label: 'Hold up a fist and speak, to either of them' },
        { icon: '🤏', label: 'Pinch to film what is happening' },
        { icon: '🖐️', label: 'Raise an open hand to ask the shopkeeper for help' },
        { label: 'When options appear, do one for real, or let it pass' },
      ]
    : [
        { key: 'Space', label: 'Hold to speak, to either of them' },
        { key: 'F', label: 'Film what is happening' },
        { key: 'E', label: 'Ask the shopkeeper for help' },
        { label: 'When options appear, pick one, or let it pass' },
      ];
}
