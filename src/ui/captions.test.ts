import { describe, expect, it } from 'vitest';
import { AUDIO_CAPTION_HOLD_MS, captionClearAt, captionHoldMs } from './captions';

describe('subtitle timing', () => {
  it('holds a voiced line until the audio ends, not for a text-length guess', () => {
    const text = 'Leave you alone? I asked you a question.';
    expect(captionHoldMs(true, text)).toBe(AUDIO_CAPTION_HOLD_MS);
    expect(captionHoldMs(true, text)).toBeGreaterThan(captionHoldMs(false, text));
    expect(captionClearAt({ hasAudio: true, text, audioEndsAt: 1800, bargeAt: null })).toBe(2150);
  });

  it('drops his subtitle the moment the player talks over him', () => {
    expect(captionClearAt({ hasAudio: true, text: 'Hey.', audioEndsAt: 4000, bargeAt: 900 })).toBe(900);
  });

  it('uses a reading estimate when there is no audio', () => {
    const short = captionHoldMs(false, 'Hey.');
    const longer = captionHoldMs(false, 'You can keep walking. I will walk too, all the way up this block.');
    expect(longer).toBeGreaterThan(short);
    expect(captionClearAt({ hasAudio: false, text: 'Hey.', audioEndsAt: null, bargeAt: null })).toBe(short);
  });
});
