import { describe, expect, it } from 'vitest';
import type { Emotion, ManStance } from '../../shared/types';
import { Rng } from './rng';
import { STANCE_EMOTIONS, coarseExpression, decideExpression, type FaceExpression } from './expression';

const ALL: FaceExpression[] = ['neutral', 'smug', 'angry', 'nervous', 'confused', 'defeated'];

describe('expression model', () => {
  it('only wears an emotion the stance allows, and maps it onto a coarse face', () => {
    const rng = new Rng(3);
    const stances: ManStance[] = ['idle', 'opening', 'persist', 'follow', 'block', 'guilt', 'hostile', 'intimidate', 'back_off', 'gone', 'escalate'];
    for (const stance of stances) {
      for (let i = 0; i < 20; i++) {
        const face = decideExpression({ stance, move: 'firm', tension: i / 20, frustration: (i % 5) / 4, rng });
        expect(STANCE_EMOTIONS[stance]).toContain(face.emotion);
        expect(ALL).toContain(face.expression);
        expect(face.expression).toBe(coarseExpression(face.emotion));
        expect(face.intensity).toBeGreaterThanOrEqual(0);
        expect(face.intensity).toBeLessThanOrEqual(1);
      }
    }
  });

  it('refuses a suggestion that would put the wrong face on a threat', () => {
    const rng = new Rng(1);
    const grabbed = decideExpression({ stance: 'escalate', move: 'hostile', tension: 1, frustration: 1, rng, suggested: 'friendly' });
    expect(grabbed.emotion).toBe('angry');
    expect(grabbed.expression).toBe('angry');
    expect(grabbed.intensity).toBe(1);
    const menace = decideExpression({ stance: 'intimidate', move: 'firm', tension: 0.8, frustration: 0.4, rng, suggested: 'sheepish' });
    expect(menace.expression).not.toBe('defeated');
    expect(['angry', 'contempt']).toContain(menace.emotion);
  });

  it('accepts a suggestion inside the allowlist, so the spoken line can steer the face', () => {
    const rng = new Rng(2);
    const face = decideExpression({ stance: 'back_off', move: 'police', tension: 0.3, frustration: 0.2, rng, suggested: 'sheepish' });
    expect(face.emotion).toBe('sheepish');
    expect(face.expression).toBe('defeated');
  });

  it('gets nervous when she threatens attention, and confused when he cannot parse her', () => {
    const nervous = new Set<string>();
    const confused = new Set<string>();
    for (let seed = 0; seed < 24; seed++) {
      nervous.add(decideExpression({ stance: 'persist', move: 'police', tension: 0.4, frustration: 0.2, rng: new Rng(seed) }).expression);
      confused.add(decideExpression({ stance: 'persist', move: 'unclear', tension: 0.3, frustration: 0.1, rng: new Rng(seed) }).expression);
    }
    expect(nervous.has('nervous')).toBe(true);
    expect([...nervous].every((e) => e === 'nervous' || e === 'smug')).toBe(true);
    expect(confused.has('confused')).toBe(true);
    expect([...confused].every((e) => e === 'confused' || e === 'smug')).toBe(true);
    const threat = decideExpression({ stance: 'intimidate', move: 'police', tension: 0.9, frustration: 0.8, rng: new Rng(1), suggested: 'worried' });
    expect(threat.expression).toBe('angry');
  });

  it('covers the six faces the rig can show', () => {
    const samples: Emotion[] = ['neutral', 'smirk', 'angry', 'worried', 'surprised', 'sheepish'];
    const seen = new Set(samples.map(coarseExpression));
    expect([...seen].sort()).toEqual([...ALL].sort());
  });
});
