/**
 * Pure rules for turning a push-to-talk recording into a clip, or into a
 * reason to throw it away. Kept separate from MediaRecorder so the failure
 * modes can be tested without a microphone.
 *
 * Root cause this guards against: Chromium can dispatch `stop` before the
 * final `dataavailable` when `start()` was given no timeslice (the whole
 * utterance is that one event). Sealing the clip inside `onstop` and treating
 * "no chunks yet" as silence drops what the player said, and nothing on screen
 * explains it. `absorbRecorderEvent` does not seal on stop; the caller seals
 * only after a later turn, so a chunk that arrives second is kept.
 */
import { MAX_CLIP_BYTES, MAX_CLIP_MS } from '../../shared/audio';

export const MIN_CLIP_MS = 250;
/** Peak below this for the whole clip, when the meter is actually live, means nobody spoke. */
export const SILENCE_PEAK = 0.005;
/** A sample at least this loud proves the analyser is not stuck at zero. */
export const METER_LIVE_PEAK = 0.001;

export { MAX_CLIP_BYTES, MAX_CLIP_MS };

export type DiscardReason = 'short' | 'silent' | 'empty' | 'huge';

export interface ClipFacts {
  durationMs: number;
  bytes: number;
  peak: number;
  /** Level samples taken while the analyser was running. */
  samples: number;
  /**
   * True once this clip produced a non-zero sample. A meter that stays at
   * exact zero (a zero-gain analyser the browser stopped pulling) must not
   * be trusted to call the clip silent: MediaRecorder can still have audio.
   */
  meterLive: boolean;
}

export function discardReason(clip: ClipFacts): DiscardReason | null {
  if (clip.durationMs < MIN_CLIP_MS) return 'short';
  if (clip.bytes <= 0) return 'empty';
  if (clip.bytes > MAX_CLIP_BYTES) return 'huge';
  if (clip.samples >= 3 && clip.meterLive && clip.peak < SILENCE_PEAK) return 'silent';
  return null;
}

export interface RecorderAccum {
  bytes: number;
  stopSeen: boolean;
  sealed: boolean;
}

export function freshAccum(): RecorderAccum {
  return { bytes: 0, stopSeen: false, sealed: false };
}

/** Fold one recorder event. Data after `stop` still counts until `sealRecorder`. */
export function absorbRecorderEvent(state: RecorderAccum, event: 'data' | 'stop', bytes = 0): RecorderAccum {
  if (state.sealed) return state;
  if (event === 'stop') return { ...state, stopSeen: true };
  if (bytes <= 0) return state;
  return { ...state, bytes: state.bytes + bytes };
}

export function sealRecorder(state: RecorderAccum): RecorderAccum {
  return state.sealed ? state : { ...state, sealed: true };
}

/**
 * The old client sealed inside `onstop`. When the browser delivered `stop`
 * first, the following chunk was ignored and the turn was never sent.
 */
export function legacySealOnStop(events: Array<{ type: 'data'; bytes: number } | { type: 'stop' }>): number {
  let bytes = 0;
  let sealed = false;
  for (const event of events) {
    if (event.type === 'stop') sealed = true;
    else if (!sealed) bytes += event.bytes;
  }
  return bytes;
}

/** What the fixed client keeps: every chunk that arrived before seal, including ones after stop. */
export function fixedClipBytes(events: Array<{ type: 'data'; bytes: number } | { type: 'stop' }>): number {
  let state = freshAccum();
  for (const event of events) state = absorbRecorderEvent(state, event.type, event.type === 'data' ? event.bytes : 0);
  state = sealRecorder(state);
  return state.bytes;
}
