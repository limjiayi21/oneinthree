/**
 * How long a subtitle stays up.
 *
 * A line with audio must not use the text-length estimate: that timer was
 * clearing the caption while the voice was still playing, and leaving it up
 * after a short line. Audio captions are held until playback ends (the caller
 * clears them). The long hold is only a backstop if the audio element never
 * resolves. A caption with no audio uses the estimate.
 */

const READING_MS = (text: string): number => Math.max(1400, Math.min(14000, 400 + text.trim().length * 62));

/** Hold used when we do not yet know the audio's real duration. */
export const AUDIO_CAPTION_HOLD_MS = 120_000;

export function captionHoldMs(hasAudio: boolean, text: string): number {
  if (hasAudio) return AUDIO_CAPTION_HOLD_MS;
  return READING_MS(text);
}

/**
 * When the caption should leave, in milliseconds from when it was shown.
 * `audioEndsAt` / `bargeAt` are offsets from show-time. A barge-in wins:
 * his line comes down the moment the player talks over him.
 */
export function captionClearAt(opts: { hasAudio: boolean; text: string; audioEndsAt: number | null; bargeAt: number | null }): number {
  if (opts.bargeAt !== null && opts.bargeAt >= 0) return opts.bargeAt;
  if (opts.hasAudio && opts.audioEndsAt !== null && opts.audioEndsAt >= 0) return opts.audioEndsAt + 350;
  return captionHoldMs(false, opts.text);
}
