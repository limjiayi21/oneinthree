import { describe, expect, it } from 'vitest';
import { clampToCorridor } from './collision';
import { walkCorridor, LINE, HOME, SHOP, ROAD_HALF } from '../world/layout';

const START_Z = -0.7;
const R = 0.3;
const corridor = walkCorridor(START_Z);

function at(x: number, z: number) {
  const p = { x, z };
  const edge = clampToCorridor(p, R, corridor);
  return { p, edge };
}

describe('walkCorridor + clampToCorridor', () => {
  it('leaves the player alone anywhere along the route: either sidewalk or the road', () => {
    expect(at(6, -40).edge).toBeNull(); // right sidewalk
    expect(at(-6, -60).edge).toBeNull(); // left sidewalk, after crossing
    expect(at(0, -90).edge).toBeNull(); // middle of the road
  });

  it('keeps the shop interior and the home stoop reachable', () => {
    expect(at((SHOP.x0 + SHOP.x1) / 2, SHOP.doorZ).edge).toBeNull();
    expect(at(8.4, HOME.doorZ).edge).toBeNull();
  });

  it('stops the player walking away from home, and says so', () => {
    const { p, edge } = at(5.75, START_Z + 6);
    expect(edge).toBe('back');
    expect(p.z).toBeLessThanOrEqual(START_Z + 1.5);
  });

  it('stops the player past home', () => {
    const { p, edge } = at(6, HOME.z1 - 8);
    expect(edge).toBe('ahead');
    expect(p.z).toBeGreaterThanOrEqual(HOME.z1 - 1.5 - R - 1e-9);
  });

  it('keeps the player out of the alley and the cross streets', () => {
    const alley = at(LINE + 3, -20);
    expect(alley.edge).toBe('side');
    expect(alley.p.x).toBeLessThanOrEqual(LINE);
    const farSide = at(-(LINE + 2), -50);
    expect(farSide.edge).toBe('side');
    expect(farSide.p.x).toBeGreaterThanOrEqual(-LINE);
  });

  it('moves an out-of-bounds point to the nearest allowed spot', () => {
    const { p } = at(ROAD_HALF, START_Z + 4);
    expect(p.x).toBeCloseTo(ROAD_HALF, 6);
  });

  it('lets her step from the street through the shop door: every pocket overlaps the street by more than a body', () => {
    const [street, ...pockets] = corridor;
    for (const pk of pockets) expect(street.maxX - R - (pk.minX + R)).toBeGreaterThan(0.05);
    // walking in from the sidewalk at the door, a step at a time, never gets stuck
    const p = { x: 7.4, z: SHOP.doorZ };
    for (let i = 0; i < 40; i++) {
      p.x += 0.1;
      clampToCorridor(p, R, corridor);
    }
    expect(p.x).toBeGreaterThan(10);
  });
});

