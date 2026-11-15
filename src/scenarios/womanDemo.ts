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
  start: new THREE.Vector3(6.6, 0, -51),
  startYaw: 0,
  /** His spot: leaning on the wall just past the scaffolding. */
  manSpot: new THREE.Vector3(8.08, 0, -65.5),
  /** The trash-can crash plays from behind her, by the wall: this far back (m) and at this x and height. */
  crashBehind: 2.5,
  crashX: 8.3,
  crashY: 1,
  /**
   * The cat bolts out from the wall a few metres ahead of her, across the sidewalk, and under
   * the parked cars at the curb (road surface is at y = -0.08). Her head follows it across.
   */
  catDash: [
    // Crosses in the open between the curbside tree (z -56) and the trash bags (z -63), so nothing hides it.
    new THREE.Vector3(8.35, 0, -59.8),
    new THREE.Vector3(7.4, 0, -59.6),
    new THREE.Vector3(6.2, 0, -59.9),
    new THREE.Vector3(5.0, 0, -60.4),
    new THREE.Vector3(4.0, -0.08, -61.0),
    new THREE.Vector3(3.4, -0.08, -61.7),
  ],
  /**
   * The set path her feet follow while she walks (the head stays free): down the clear lane past the cat
   * and past him, then over to the shop's light and in through the middle of the door.
   */
  path: [
    { x: 6.6, z: -51 },
    { x: 6.6, z: -59 }, // the cat
    { x: 6.6, z: -66 }, // level with him
    { x: 6.8, z: -74 },
    { x: 7.0, z: -78 }, // the shop's light, turning square to the door
    { x: 8.7, z: -78 }, // the doorway
    { x: 9.9, z: -78 }, // inside
  ],
  /** How far across the sidewalk she may step to get round him. */
  pathXRange: [6.1, 8.1] as [number, number], // clear of the curbside trees and trash, and the wall
  /** A calm start: seconds after she can move before her keys thought, and before the crash. */
  keysDelay: 1,
  crashDelay: 4,
  /** If she hurries, the crash comes anyway once she has walked this far (where 4 s at walking pace gets her). */
  crashByZ: -57,
  /** Her startle lands this long after the crash, just as the cat appears (it bolts 0.12 s in). */
  reactAfter: 0.1,
  /** Seconds after the crash before he looks up (and, as she is close by then, engages). */
  noticeDelay: 4,
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
