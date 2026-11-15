/**
 * Part 1 in demo mode (?demo=1): a short, guided walk. She starts mid-block on
 * her own sidewalk, meets him a few seconds in, and the shop is the end of her
 * street. The set path (start, past him, into the shop) takes under 20 s.
 */
import * as THREE from 'three';
import type { Rect } from '../contracts';
import { LINE, ROAD_HALF, SHOP, rect, shopPocket } from '../world/layout';

export const DEMO = {
  /**
   * Her start: right sidewalk, mid-block, facing down the street (yaw 0, like the subway exit).
   * x = 6.6 is the clear lane between the curbside trees and trash (x ~ 5.3) and the wall.
   */
  start: new THREE.Vector3(6.6, 0, -54),
  startYaw: 0,
  /** His spot: leaning on the wall just past the scaffolding. */
  manSpot: new THREE.Vector3(8.08, 0, -65.5),
  /** The trash-can crash plays from just ahead on her right (the real alley is behind her). */
  crashSource: new THREE.Vector3(8.3, 1, -63),
  /**
   * The cat bolts out from the wall where the crash is, across the sidewalk a couple of metres
   * ahead of her, and under the parked cars at the curb (road surface is at y = -0.08).
   */
  catDash: [
    new THREE.Vector3(8.35, 0, -63.2),
    new THREE.Vector3(7.4, 0, -63.0),
    new THREE.Vector3(6.2, 0, -63.4),
    new THREE.Vector3(5.0, 0, -64.3),
    new THREE.Vector3(4.0, -0.08, -65.4),
    new THREE.Vector3(3.5, -0.08, -66.6),
  ],
  /** A calm start: seconds after she can move before her keys thought, and before the crash. */
  keysDelay: 1,
  crashDelay: 4,
  /** If she hurries, the crash comes anyway once she has walked this far (where 4 s at walking pace gets her). */
  crashByZ: -60,
  /** Seconds after the crash before he looks up. */
  noticeDelay: 2,
  /** Seconds after the encounter begins before the "shop is still open" nudge. */
  nudgeAfter: 15,
};

/** Her sidewalk from just behind her start to the shop's far wall, plus the shop. No road, no way home. */
export function demoCorridor(): Rect[] {
  return [rect(ROAD_HALF, LINE, SHOP.iz1, DEMO.start.z + 1.5), shopPocket()];
}

const SHOP_DOOR = { x: 8.0, z: SHOP.doorZ };
const SHOP_INSIDE = { x: 9.9, z: SHOP.doorZ };

/** Straight-line time from her start to the shop door and inside, at the given speed. */
export function setPathSeconds(walkSpeed: number): number {
  const leg = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(b.x - a.x, b.z - a.z);
  return (leg(DEMO.start, SHOP_DOOR) + leg(SHOP_DOOR, SHOP_INSIDE)) / walkSpeed;
}
