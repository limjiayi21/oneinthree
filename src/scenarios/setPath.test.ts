import { describe, expect, it } from 'vitest';
import { forwardX, forwardZ } from '../player/mathx';
import { SetPath, type P2 } from './setPath';
import { DEMO } from './womanDemo';

/** Walks the path from `start` at 1.4 m/s, 30 steps a second, optionally past someone standing still. */
function walk(path: SetPath, start: P2, obstacle: P2 | null = null, maxSteps = 3000) {
  const p = { ...start };
  let closest = Infinity;
  const trail: P2[] = [];
  for (let i = 0; i < maxSteps; i++) {
    const y = path.heading(p, obstacle);
    if (y === null) return { reached: true, p, closest, trail };
    p.x += forwardX(y) * (1.4 / 30);
    p.z += forwardZ(y) * (1.4 / 30);
    if (obstacle) closest = Math.min(closest, Math.hypot(p.x - obstacle.x, p.z - obstacle.z));
    trail.push({ ...p });
  }
  return { reached: false, p, closest, trail };
}

describe('the demo set path', () => {
  it('takes her from the start, down the street, and into the shop', () => {
    const r = walk(new SetPath(DEMO.path, DEMO.pathXRange), DEMO.path[0]!);
    expect(r.reached).toBe(true);
    const end = DEMO.path[DEMO.path.length - 1]!;
    expect(Math.hypot(r.p.x - end.x, r.p.z - end.z)).toBeLessThan(0.4);
    // It goes through the middle of the doorway (z of the door) on the way in.
    const atDoor = r.trail.find((q) => q.x > 8.5)!;
    expect(Math.abs(atDoor.z - -78)).toBeLessThan(0.3);
  });

  it('only ever moves forward along the street (never doubles back)', () => {
    const r = walk(new SetPath(DEMO.path, DEMO.pathXRange), DEMO.path[0]!);
    for (let i = 1; i < r.trail.length; i++) expect(r.trail[i]!.z).toBeLessThanOrEqual(r.trail[i - 1]!.z + 1e-6);
  });

  it('gets back on the line from wherever she starts', () => {
    const r = walk(new SetPath(DEMO.path, DEMO.pathXRange), { x: 7.9, z: -53 });
    expect(r.reached).toBe(true);
  });

  it('steps round someone standing on the line, keeping clear of him', () => {
    const him = { x: 6.6, z: -62 };
    const r = walk(new SetPath(DEMO.path, DEMO.pathXRange), DEMO.path[0]!, him);
    expect(r.reached).toBe(true);
    expect(r.closest).toBeGreaterThan(0.6); // two bodies of radius ~0.3 never overlap
    // and stays on the sidewalk while doing it
    for (const q of r.trail) {
      if (q.z > -76) expect(q.x).toBeGreaterThanOrEqual(DEMO.pathXRange[0] - 0.05);
    }
  });
});
