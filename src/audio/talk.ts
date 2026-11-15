/**
 * When the player may talk, and when a hands-free clip should open or close.
 * Push-to-talk stays the default. Hands-free is an extra mode, off until the
 * player turns it on, so a noisy room cannot spend speech-to-text credits.
 */
import { MAX_CLIP_MS } from '../../shared/audio';

export { MAX_CLIP_MS };

/** How a clip was opened: Space held, hands-free voice, or a fist held up to the camera. */
export type TalkOrigin = 'ptt' | 'vad' | 'fist';

/** What a Space keydown should do. Permission denied falls through to typing. */
export function pushToTalkDown(opts: { enabled: boolean; held: boolean; available: boolean }): 'record' | 'type' | 'ignore' {
  if (!opts.enabled || opts.held) return 'ignore';
  return opts.available ? 'record' : 'type';
}

/**
 * Hands-free edges. `loudMs` / `quietMs` are how long the level has stayed
 * past the threshold. Starting takes a short attack so a door slam does not
 * open the mic; stopping takes a longer release so a breath does not cut a word.
 */
export function vadEdge(opts: { holding: boolean; level: number; loudMs: number; quietMs: number }): 'start' | 'stop' | 'hold' {
  const START = 0.2;
  const STOP = 0.08;
  if (!opts.holding) {
    if (opts.level >= START && opts.loudMs >= 180) return 'start';
    return 'hold';
  }
  if (opts.level < STOP && opts.quietMs >= 650) return 'stop';
  return 'hold';
}

/** Starting a clip while he is still talking cuts his audio. That is the barge-in. */
export function bargeOnTalkStart(npcAudible: boolean): boolean {
  return npcAudible;
}

/** Roughly the words of his line she let him get out before she cut in, from how long it had been playing. */
export function heardPortion(line: string, playedSec: number, totalSec: number): string {
  const all = line.trim().split(/\s+/).filter(Boolean);
  if (!all.length || totalSec <= 0) return '';
  const n = Math.max(0, Math.min(all.length, Math.round((playedSec / totalSec) * all.length)));
  return all.slice(0, n).join(' ');
}
