/**
 * Maps webcam hand gestures onto a scene's existing key actions, so a gesture
 * and its key always do exactly the same thing.
 *
 *   look down + pinch  -> lookDownPinch.key (e.g. F: take out the phone)
 *   open palm held up  -> palm.key (e.g. E: ask for help)
 *
 * Gestures only count while the player could press the key: not paused, not
 * in a cutscene, scene not over. Hints show only while hands are tracked.
 */

import { DEG } from '../player/mathx';
import type { PlayerController } from '../player/player';
import type { SceneDeps, SceneKit } from './common';

/** Looking this far below the horizon counts as looking down at your hands. */
export const LOOK_DOWN_PITCH = -28 * DEG;

interface GestureAction {
  key: string;
  /** Hint while the action is available, or null to hide it. */
  hint: () => string | null;
}

export interface HandActionMap {
  lookDownPinch?: GestureAction;
  palm?: GestureAction;
}

export function bindHandActions(deps: SceneDeps, player: PlayerController, kit: SceneKit, map: HandActionMap): () => void {
  const hands = deps.hands;
  if (!hands) return () => {};

  const live = () => !kit.ended && !kit.paused && player.inputEnabled && player.isLocked;
  const lookingDown = () => player.viewPitch < LOOK_DOWN_PITCH;

  const offGesture = hands.onGesture((g) => {
    if (!live()) return;
    if (g === 'pinch' && map.lookDownPinch && lookingDown()) kit.onKey(map.lookDownPinch.key);
    else if (g === 'palm' && map.palm && !lookingDown()) kit.onKey(map.palm.key);
  });

  const offUpdate = deps.engine.onUpdate(() => {
    if (!hands.active || !live()) {
      hands.setHint(null);
      return;
    }
    if (lookingDown()) hands.setHint(map.lookDownPinch?.hint() ?? null);
    else hands.setHint(map.palm?.hint() ?? null);
  });

  return () => {
    offGesture();
    offUpdate();
    hands.setHint(null);
  };
}
