import { describe, expect, it } from 'vitest';
import { EXAMPLE_DEBRIEF, exampleCitations } from './coachExample';
import { bundledEvidence } from './evidence';

describe('coach example debrief (shown when the live coach cannot finish)', () => {
  it('has the three sections the coach writes', () => {
    for (const h of ['What you did', 'What to try next time', 'What the research says']) expect(EXAMPLE_DEBRIEF).toContain(h);
  });

  it('every citation in it resolves to a real source', () => {
    const ids = [...EXAMPLE_DEBRIEF.matchAll(/\[([a-z0-9_]+)\]/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThan(0);
    const cites = exampleCitations(bundledEvidence);
    for (const id of ids) {
      const c = cites.find((x) => x.id === id);
      expect(c, id).toBeTruthy();
      expect(c!.text.length).toBeGreaterThan(10);
      expect(c!.source?.publisher, id).toBeTruthy();
    }
  });

  it('says plainly that it is an example, not their run', () => {
    expect(EXAMPLE_DEBRIEF.toLowerCase()).toContain('example');
  });
});
