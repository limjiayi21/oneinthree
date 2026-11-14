import { describe, expect, it } from 'vitest';
import { fillerKind, fillerSamples } from './filler';
import { DEMO_SEED, resolveSeed } from '../../shared/demo';

describe('filler', () => {
  it('picks a reaction from the stance and keeps every clip short', () => {
    expect(fillerKind('hostile')).toBe('scoff');
    expect(fillerKind('intimidate')).toBe('scoff');
    expect(fillerKind('back_off')).toBe('sigh');
    expect(fillerKind('persist')).toBe('huh');
    expect(fillerKind(undefined)).toBe('huh');
    for (const kind of ['huh', 'scoff', 'sigh'] as const) {
      const samples = fillerSamples(kind, 8000);
      expect(samples.length / 8000).toBeLessThan(0.6);
      expect(Math.max(...samples.map(Math.abs))).toBeGreaterThan(0.05);
    }
    expect(fillerSamples('sigh').length).toBeGreaterThan(fillerSamples('huh').length);
  });
});

describe('demo seed', () => {
  it('uses the fixed demo seed unless a numeric seed is set', () => {
    expect(resolveSeed({ demo: '1' })).toBe(DEMO_SEED);
    expect(resolveSeed({ demo: 'true' })).toBe(DEMO_SEED);
    expect(resolveSeed({ demo: '1', seed: '7' })).toBe(7);
    expect(resolveSeed({})).toBeUndefined();
    expect(resolveSeed({ seed: 'nope', demo: '1' })).toBe(DEMO_SEED);
  });
});
