import { describe, expect, it } from 'vitest';
import { MAX_CLIP_BYTES } from '../../shared/audio';
import { discardReason, fixedClipBytes, legacySealOnStop } from './clip';

describe('push-to-talk clip assembly', () => {
  it('drops the utterance when stop is sealed before the only chunk (the mic bug)', () => {
    const events = [{ type: 'stop' as const }, { type: 'data' as const, bytes: 8400 }];
    expect(legacySealOnStop(events)).toBe(0);
  });

  it('keeps a chunk that arrives after stop', () => {
    const events = [{ type: 'stop' as const }, { type: 'data' as const, bytes: 8400 }];
    expect(fixedClipBytes(events)).toBe(8400);
  });

  it('keeps timeslice chunks that arrived before stop even if the tail is missing', () => {
    const events = [
      { type: 'data' as const, bytes: 2000 },
      { type: 'data' as const, bytes: 2000 },
      { type: 'stop' as const },
    ];
    expect(fixedClipBytes(events)).toBe(4000);
  });

  it('does not call a clip silent when the meter never left zero', () => {
    expect(discardReason({ durationMs: 1200, bytes: 9000, peak: 0, samples: 40, meterLive: false })).toBeNull();
  });

  it('does call a clip silent when the meter is live and the peak is a room tone', () => {
    expect(discardReason({ durationMs: 1200, bytes: 9000, peak: 0.002, samples: 40, meterLive: true })).toBe('silent');
  });

  it('rejects a clip over the byte cap and a tap that is too short', () => {
    expect(discardReason({ durationMs: 100, bytes: 400, peak: 0.2, samples: 4, meterLive: true })).toBe('short');
    expect(discardReason({ durationMs: 2000, bytes: MAX_CLIP_BYTES + 1, peak: 0.2, samples: 10, meterLive: true })).toBe('huge');
    expect(discardReason({ durationMs: 800, bytes: 0, peak: 0.2, samples: 10, meterLive: true })).toBe('empty');
  });
});
