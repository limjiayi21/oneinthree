import { describe, expect, it } from 'vitest';
import { clampToCorridor } from '../player/collision';
import { PLAYER_TUNING } from '../player/player';
import { LINE, ROAD_HALF, SHOP } from '../world/layout';
import { DEMO, demoCorridor, setPathSeconds } from './womanDemo';

const R = 0.3;
const corridor = demoCorridor();

function at(x: number, z: number) {
  const p = { x, z };
  const edge = clampToCorridor(p, R, corridor);
  return { p, edge };
}

describe('Part 1 demo staging', () => {
  it('the set path takes under 20 s at walking speed', () => {
    expect(setPathSeconds(PLAYER_TUNING.walkSpeed)).toBeLessThan(20);
  });

  it('leaves her alone on her sidewalk between start and shop', () => {
    expect(at(6, -54).edge).toBeNull();
    expect(at(7.5, -64).edge).toBeNull();
    expect(at(5, -78).edge).toBeNull();
  });

  it('lets her step from the sidewalk through the door into the shop', () => {
    expect(at(LINE - 0.4, SHOP.doorZ).edge).toBeNull();
    expect(at(LINE + 0.4, SHOP.doorZ).edge).toBeNull();
    expect(at((SHOP.x0 + SHOP.x1) / 2, SHOP.doorZ).edge).toBeNull();
  });

  it('keeps her off the road', () => {
    const { p, edge } = at(0, -64);
    expect(edge).toBe('side');
    expect(p.x).toBeGreaterThanOrEqual(ROAD_HALF + R - 1e-9);
  });

  it('stops her going back', () => {
    const { p, edge } = at(6, -45);
    expect(edge).toBe('back');
    expect(p.z).toBeLessThanOrEqual(DEMO.start.z + 1.5);
  });

  it('stops her going past the shop toward home', () => {
    const { p, edge } = at(6, -100);
    expect(edge).toBe('ahead');
    expect(p.z).toBeGreaterThanOrEqual(SHOP.iz1 + R - 1e-9);
  });

  it('starts her and the man inside the corridor, him ahead of her', () => {
    expect(at(DEMO.start.x, DEMO.start.z).edge).toBeNull();
    expect(DEMO.manSpot.z).toBeLessThan(DEMO.start.z);
    expect(DEMO.start.z - DEMO.manSpot.z).toBeGreaterThan(6.5 + 4);
  });
});
