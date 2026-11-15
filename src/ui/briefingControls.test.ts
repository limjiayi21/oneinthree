import { describe, expect, it } from 'vitest';
import { briefingControls } from './briefingControls';

const text = (pov: 'woman' | 'bystander', mode: 'analog' | 'immersive') =>
  briefingControls(pov, mode).map((c) => `${c.key ?? c.icon ?? ''} ${c.label}`).join(' | ');

describe('controls shown before each part', () => {
  it('keyboard: keys for walking, looking, hurrying and speaking in Part 1', () => {
    const t = text('woman', 'analog');
    for (const k of ['W A S D', 'Shift', 'Space']) expect(t).toContain(k);
    expect(t).toMatch(/mouse/i);
  });

  it('keyboard: Part 2 keeps its keys (speak, film, shopkeeper)', () => {
    const t = text('bystander', 'analog');
    for (const k of ['Space', 'F', 'E']) expect(t).toContain(k);
  });

  it('with the body: no keyboard keys, the body controls instead (Part 1)', () => {
    const c = briefingControls('woman', 'immersive');
    expect(c.every((x) => !x.key)).toBe(true);
    const t = text('woman', 'immersive');
    expect(t).toMatch(/step in place/i);
    expect(t).toMatch(/turn your head/i);
    expect(t).toMatch(/fist/i);
  });

  it('with the body: fist to speak, pinch to film, open hand for the shopkeeper (Part 2)', () => {
    const c = briefingControls('bystander', 'immersive');
    expect(c.every((x) => !x.key)).toBe(true);
    const t = text('bystander', 'immersive');
    expect(t).toMatch(/fist/i);
    expect(t).toMatch(/pinch/i);
    expect(t).toMatch(/open hand/i);
    expect(t).toMatch(/for real/i);
  });
});
