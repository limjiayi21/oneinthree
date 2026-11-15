/**
 * Maps webcam hand gestures onto a scene's existing key actions, so a gesture
 * and its key always do exactly the same thing.
 *
 *   pinch              -> pinch.key (e.g. F: take out / put away the phone)
 *   open palm held up  -> palm.key  (e.g. E: ask for help)
 *
 * Wherever the player is looking: the two gestures are different enough not to
 * need it. (A fist is neither: it is for talking, see SceneKit.)
 * Gestures only count while the player could press the key: not paused, not
 * in a cutscene, scene not over. Hints show only while hands are tracked.
 */

import type { PlayerController } from '../player/player';
import type { SceneDeps, SceneKit } from './common';

interface GestureAction {
  key: string;
  /** Hint while the action is available, or null to hide it. */
  hint: () => string | null;
}

export interface HandActionMap {
  pinch?: GestureAction;
  palm?: GestureAction;
}

export function bindHandActions(deps: SceneDeps, player: PlayerController, kit: SceneKit, map: HandActionMap): () => void {
  const hands = deps.hands;
  if (!hands) return () => {};

  const live = () => !kit.ended && !kit.paused && player.inputEnabled && player.isLocked;

  const offGesture = hands.onGesture((g) => {
    if (!live()) return;
    if (g === 'pinch' && map.pinch) kit.onKey(map.pinch.key);
    else if (g === 'palm' && map.palm) kit.onKey(map.palm.key);
  });

  const offUpdate = deps.engine.onUpdate(() => {
    if (!hands.active || !live()) {
      hands.setHint(null);
      return;
    }
    // The palm's hint only shows where it applies (by the shop); otherwise the pinch's, if it has one.
    hands.setHint(map.palm?.hint() ?? map.pinch?.hint() ?? null);
  });

  return () => {
    offGesture();
    offUpdate();
    hands.setHint(null);
  };
}
