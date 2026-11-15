/**
 * The controls while she starts walking: a panel listing everything the player can do, for how they chose
 * to play (keys with the keyboard, gestures with the body; the same lists as the briefing, see
 * src/ui/briefingControls.ts). It does not wait for the player; they can already walk while it shows.
 * Once per part per page load; ?tutorial=0 turns it off, ?tutorial=1 shows it every time.
 */
import type { Pov } from '../../shared/types';
import type { SceneKit } from './common';
import type { PlayMode } from '../contracts';
import { briefingControls } from '../ui/briefingControls';
import { showControlsPanel } from '../ui/controlsPanel';

/** Seconds the panel stays up. */
export const CONTROLS_PANEL_SECONDS = 10;

const shown = new Set<Pov>();

export function shouldRunKeyTutorial(pov: Pov, flag: string | null): boolean {
  if (flag === '0') return false;
  if (flag === '1') return true;
  return !shown.has(pov);
}

/**
 * Shows the controls panel. Returns the scene time at which it goes (or now, if it does not show), so
 * other hints can wait until after it.
 */
export function runKeyTutorial(kit: SceneKit, _hud: unknown, pov: Pov, how: { mode?: PlayMode; phoneWalks: boolean }): number {
  const flag = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('tutorial');
  if (!shouldRunKeyTutorial(pov, flag)) return kit.time;
  shown.add(pov);
  showControlsPanel(briefingControls(pov, how.mode ?? 'analog'), CONTROLS_PANEL_SECONDS, pov === 'bystander' ? 'What you can do' : 'Controls');
  return kit.time + CONTROLS_PANEL_SECONDS;
}
