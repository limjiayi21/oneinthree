/**
 * The block's fixed geometry: dimensions, named points and zones.
 * See the coordinate system at the top of src/contracts.ts.
 */

import * as THREE from 'three';
import type { Rect, WorldPoint, WorldZone } from '../contracts';
import type { Pen, UVRect } from './geo';
import type { GlowSystem } from './fx';

/** Everything a builder needs: where to draw, and where to register colliders, glows and lights. */
export interface Ctx {
  pen: Pen;
  R: Record<string, UVRect>;
  rng: () => number;
  colliders: Rect[];
  glow: GlowSystem;
  lights: LightSite[];
}

export const ROAD_HALF = 4.5; // road: x in [-4.5, 4.5]
export const LINE = 8.5; // building line: x = +-8.5
export const BLOCK_NEAR = 8; // block: z in [8, -140]
export const BLOCK_FAR = -140;
/** The building fronts stop 4 m short of each block end: that strip is the cross street's sidewalk. */
export const FRONT_NEAR = 4;
export const FRONT_FAR = -136;
/** Road surface sits a curb below the sidewalks (which are at y = 0, where everyone's feet are). */
export const ROAD_Y = -0.08;
/** Cross-street roadway width beyond each block end. */
export const CROSS_ROAD = 9;
export const CROSS_WALK = 4;

/** Landmarks along the right-hand (player's) side. */
export const ALLEY = { z0: -18.75, z1: -21.25, depth: 12, gateX: 9.55 };
export const SHED = { z0: -34, z1: -52, postInner: 8.22, postOuter: 4.95, deckY: 3.0 };
export const SHOP = {
  z0: -73.5,
  z1: -82.5,
  doorZ: -78,
  doorHalf: 0.65,
  // interior room
  x0: 8.7,
  x1: 13.3,
  iz0: -73.8,
  iz1: -82.2,
  ceil: 3.0,
};
export const HOME = { z0: -124.2, z1: -131.8, doorZ: -128, doorHalf: 0.55, stoopHalf: 0.9, stoopX: 6.9, landingY: 0.2 };
export const SUBWAY = { x0: 4.95, x1: 6.55, z0: 0.55, z1: 5.2 };

export const rect = (xa: number, xb: number, za: number, zb: number): Rect => ({
  minX: Math.min(xa, xb),
  maxX: Math.max(xa, xb),
  minZ: Math.min(za, zb),
  maxZ: Math.max(za, zb),
});

export const inRect = (r: Rect, x: number, z: number): boolean => x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ;

export const BOUNDS: Rect = rect(-12.5, 14, BLOCK_FAR, BLOCK_NEAR);

/**
 * Where the player may walk in the two playable scenes: the street from just
 * behind the start to just past home (both sidewalks and the road, so crossing
 * stays a choice), plus the shop and the home stoop. Not the cross streets,
 * the alley, or back the way she came. First rect = the main stretch.
 */
export function walkCorridor(startZ: number): Rect[] {
  return [
    rect(-LINE, LINE, HOME.z1 - 1.5, startZ + 1.5),
    // Side pockets start 1 m inside the building line so they overlap the street by
    // more than a body's width: she must be able to step from one into the other.
    shopPocket(),
    rect(LINE - 1, 9.0, HOME.doorZ - (HOME.stoopHalf + 0.6), HOME.doorZ + (HOME.stoopHalf + 0.6)), // the stoop and door
  ];
}

/** The shop interior as a corridor pocket, overlapping the sidewalk by 1 m so the door is passable. */
export function shopPocket(): Rect {
  return rect(LINE - 1, SHOP.x1, SHOP.iz1, SHOP.iz0);
}

const v = (x: number, z: number) => new THREE.Vector3(x, 0, z);

export function makePoints(): Record<WorldPoint, THREE.Vector3> {
  return {
    subwayExit: v(5.75, -0.7),
    bystanderSpawn: v(5.75, -0.7),
    alleyMouth: v(7.7, -20),
    alleySource: v(9.25, -20.45),
    harasserSpot: v(8.08, -40),
    shopDoor: v(8.0, SHOP.doorZ),
    shopInside: v(9.9, SHOP.doorZ),
    clerkSpot: v(12.4, SHOP.doorZ),
    homeDoor: v(8.2, HOME.doorZ),
    homeStoop: v(6.4, HOME.doorZ),
    farCorner: v(10.6, -138.2),
    nearCorner: v(10.6, 6.2),
    womanStartBystander: v(6.5, -22.5),
    passerbyA0: v(-6.35, -112),
    passerbyA1: v(-6.35, 5.5),
    passerbyB0: v(-7.05, 5.5),
    passerbyB1: v(-7.05, -137),
  };
}

export function makeZones(): Record<WorldZone, Rect> {
  return {
    alleyTrigger: rect(ROAD_HALF, LINE, -17.2, -18.6),
    noticeTrigger: rect(-LINE, LINE, -29.5, -31),
    shopEntrance: rect(8.9, 11.25, SHOP.doorZ + 1.5, SHOP.doorZ - 1.5),
    homeEntrance: rect(7.45, 8.6, HOME.doorZ + 0.85, HOME.doorZ - 0.85),
    road: rect(-ROAD_HALF, ROAD_HALF, BLOCK_FAR, BLOCK_NEAR),
    leftSidewalk: rect(-LINE, -ROAD_HALF, BLOCK_FAR, BLOCK_NEAR),
    rightSidewalk: rect(ROAD_HALF, LINE, BLOCK_FAR, BLOCK_NEAR),
  };
}

/** Light sources that exist in the scene. Real lights, glows and ground pools are all built from this. */
export interface LightSite {
  id: string;
  x: number;
  y: number;
  z: number;
  color: number;
  /** candela */
  intensity: number;
  distance: number;
  /** street lamps flicker flag */
  flicker?: boolean;
  /** Allowed to become the one shadow-casting light when the camera is near. */
  shadow?: boolean;
}

export const SODIUM = 0xffb06a;
export const LED = 0xcfe0ff;

/** Street lamps: every ~25 m, alternating sides. side 1 = right (+x). */
export const LAMPS: Array<{ z: number; side: 1 | -1; color: number; flicker?: boolean }> = [
  { z: -8, side: 1, color: SODIUM },
  { z: -33, side: -1, color: LED, flicker: true },
  { z: -60, side: 1, color: SODIUM },
  { z: -86, side: -1, color: SODIUM },
  { z: -110, side: 1, color: SODIUM },
  { z: -134, side: -1, color: LED },
];
export const LAMP_ARM = 2.0; // head overhangs the road by this much from the pole
export const LAMP_POLE_X = 4.95;
export const LAMP_H = 7.6;
