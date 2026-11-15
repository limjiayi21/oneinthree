/**
 * Golden run (docs/golden-run.md): one reference playthrough whose levels are
 * held to a script, so it can be rehearsed and polished exactly. The words are
 * still written live from the story; only his level, and when he leaves, are
 * fixed. Turned on per session with `?run=golden`; the normal game never uses it.
 *
 *   his opening ............................ 1 Interested
 *   her responses 1-6 ...................... 1, 1, 2, 2, 3, 4   (friendly -> angry over six exchanges)
 *   then she chooses an ending, at level 4:
 *     A. she heads for the shop  ........... 5 Intimidating (follows, cuts in front) -> she goes in -> took_refuge
 *     B. she insults him or pushes past .... 5 Intimidating (close, low) -> anything else she does -> 6 (cut to black)
 */
import type { ClientEventType, WomanStrategy } from '../../shared/types';

export const GOLDEN_OPENING_LEVEL = 1;
/** His level after each of her first six responses. */
export const GOLDEN_LEVELS = [1, 1, 2, 2, 3, 4];

export type GoldenPath = 'A' | 'B';

/** Moving away from him toward somewhere else: the start of Ending A. */
const MOVING_AWAY: ClientEventType[] = ['crossed_street', 'sped_up', 'walked_past', 'backed_away'];

export interface GoldenInput {
  level: number;
  /** Her responses so far, counting this one. */
  exchanges: number;
  path: GoldenPath | null;
  event: ClientEventType;
  strategy: WomanStrategy;
}

export interface GoldenOutput {
  level: number;
  path: GoldenPath | null;
}

export function goldenNext(i: GoldenInput): GoldenOutput {
  // The climb: fixed levels for the first six responses, never down, never more than +2.
  if (i.exchanges <= GOLDEN_LEVELS.length && i.level < 4) {
    const target = GOLDEN_LEVELS[i.exchanges - 1];
    return { level: Math.min(i.level + 2, Math.max(i.level, target)), path: null };
  }
  const insultOrPush = i.strategy === 'hostile' || i.event === 'pushed_past';
  // Ending B: an insult or a push at 4 brings him in close (5); whatever she does next, he reaches for her (6).
  if (i.path === 'B' && i.level >= 5) return { level: 6, path: 'B' };
  if (insultOrPush && i.level >= 4) return { level: 5, path: 'B' };
  // Ending A: she heads off toward the shop; he comes after her and cuts in front (5) until she gets inside.
  if (i.level >= 4 && (MOVING_AWAY.includes(i.event) || i.path === 'A')) return { level: 5, path: 'A' };
  // Anything else at the top of the climb: he stays angry and keeps at her.
  return { level: Math.max(i.level, 4), path: i.path };
}
