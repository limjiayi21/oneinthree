import { describe, expect, it } from 'vitest';
import { MAX_CLIP_MS, bargeOnTalkStart, pushToTalkDown, vadEdge } from './talk';

describe('talk control', () => {
  it('sends a player with no microphone to the typed fallback', () => {
    expect(pushToTalkDown({ enabled: true, held: false, available: false })).toBe('type');
    expect(pushToTalkDown({ enabled: true, held: false, available: true })).toBe('record');
    expect(pushToTalkDown({ enabled: false, held: false, available: true })).toBe('ignore');
    expect(pushToTalkDown({ enabled: true, held: true, available: true })).toBe('ignore');
  });

  it('opens hands-free only after a short attack and closes after a pause', () => {
    expect(vadEdge({ holding: false, level: 0.4, loudMs: 100, quietMs: 0 })).toBe('hold');
    expect(vadEdge({ holding: false, level: 0.4, loudMs: 200, quietMs: 0 })).toBe('start');
    expect(vadEdge({ holding: true, level: 0.01, loudMs: 0, quietMs: 400 })).toBe('hold');
    expect(vadEdge({ holding: true, level: 0.01, loudMs: 0, quietMs: 700 })).toBe('stop');
  });

  it('cuts NPC audio when the player starts talking over it', () => {
    expect(bargeOnTalkStart(true)).toBe(true);
    expect(bargeOnTalkStart(false)).toBe(false);
  });

  it('caps a clip at about eight seconds', () => {
    expect(MAX_CLIP_MS).toBeLessThanOrEqual(8000);
    expect(MAX_CLIP_MS).toBeGreaterThanOrEqual(7000);
  });
});
