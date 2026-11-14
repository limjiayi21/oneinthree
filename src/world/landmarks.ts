/**
 * The places the scene is built around: the subway exit, the alley, the
 * sidewalk shed, the bodega and her front door.
 */

import * as THREE from 'three';
import type { Rect } from '../contracts';
import type { UVRect } from './geo';
import { strips, reveals, type Lot, type Opening } from './facades';
import { ALLEY, HOME, LINE, SHED, SHOP, SUBWAY, rect, type Ctx } from './layout';
import { trashPile } from './props';

const IRON = 0x15171a;
/** Frame for the right-hand building line: local X = world +Z, local Y = up, local Z = out of the wall (world -X). */
const RIGHT = -Math.PI / 2;

/** Sub-rectangle of an atlas region; fractions measured from the region's top-left like canvas coordinates. */
export function sub(r: UVRect, x0: number, y0: number, x1: number, y1: number): UVRect {
  const du = r.u1 - r.u0, dv = r.v1 - r.v0;
  return { u0: r.u0 + du * x0, u1: r.u0 + du * x1, v1: r.v1 - dv * y0, v0: r.v1 - dv * y1 };
}

/* ----------------------------------------------------------------- subway */

export function subwayEntrance(c: Ctx): { metal: Rect[] } {
  const { pen, R } = c;
  const { x0, x1, z0, z1 } = SUBWAY;
  const zc = 2;
  pen.identity().to('matte', zc).worldUV(0, 0).ao(1, 1);

  // stairs going down toward +Z
  const steps = 17, rise = 0.18;
  const run = (z1 - z0 - 0.25) / steps;
  for (let i = 0; i < steps; i++) {
    const yt = -(i + 1) * rise;
    const za = z0 + i * run, zb = za + run;
    const dim = 1 - i * 0.035;
    pen.color(0x34342f, dim).rectXZ(x0, za, x1, zb, yt);
    pen.color(0x20201e, dim).rectXY(x0, yt, x1, yt + rise, za);
    pen.color(0x77755f, dim).rectXZ(x0, zb - 0.05, x1, zb, yt + 0.003);
  }
  pen.color(0x2a2a27, 0.5).rectXZ(x0, z0 + steps * run, x1, z1, -steps * rise);
  // tiled well walls
  pen.color(0x8e8e88);
  for (let y = -4; y < 0; y++) {
    for (let z = z0; z < z1 - 0.01; z += 1.0) {
      const zb = Math.min(z + 1.0, z1);
      const shade = 0.5 + 0.5 * ((y + 4) / 4);
      pen.color(0x8e8e88, shade * shade);
      pen.rectZY(z, y, zb, y + 1, x0, 1, R.subway_tile);
      pen.rectZY(z, y, zb, y + 1, x1, -1, R.subway_tile);
    }
  }
  pen.color(0x55554f).rectXY(x0, -0.95, x1, 0, z1, sub(R.subway_tile, 0, 0, 1, 0.5), true);
  // the lit mezzanine below, seen through the foot of the stairs
  pen.to('lit', zc).rgb(0.1, 0.13, 0.12).ao(1.6, 0.5);
  pen.rectXY(x0, -3.4, x1, -0.95, z1 - 0.01, R.subway_tile, true);
  pen.ao(1, 1).rgb(0.7, 0.85, 0.76).rectXY(x0 + 0.25, -1.16, x1 - 0.25, -1.09, z1 - 0.03, undefined, true);
  c.glow.billboard((x0 + x1) / 2, -2.2, z1 - 0.5, 3.0, 0xbfe6d6, 0.1, 0);

  // kerb round three sides, and the railing
  pen.to('matte', zc).color(0x3a3a37).ao(1, 1);
  pen.boxMin(x0 - 0.12, 0, z0, 0.12, 0.14, z1 - z0 + 0.12);
  pen.boxMin(x1, 0, z0, 0.12, 0.14, z1 - z0 + 0.12);
  pen.boxMin(x0 - 0.12, 0, z1, x1 - x0 + 0.24, 0.14, 0.12);
  const GREEN = 0x13281d;
  pen.color(GREEN);
  const railX = [x0 - 0.06, x1 + 0.06];
  const zEnd = z1 + 0.06;
  for (const rx of railX) {
    for (const y of [0.22, 1.07]) pen.tube(rx, y, z0, rx, y, zEnd, 0.028, 0.028, 5);
    const n = Math.round((zEnd - z0) / 0.15);
    for (let i = 0; i <= n; i++) pen.boxMin(rx - 0.01, 0.14, z0 + ((zEnd - z0) * i) / n - 0.01, 0.02, 0.93, 0.02);
    for (let i = 1; i <= 4; i++) pen.cyl(rx, 0.14, z0 + ((zEnd - z0) * i) / 4, 0.035, 0.035, 0.98, 6, 2);
  }
  for (const y of [0.22, 1.07]) pen.tube(railX[0], y, zEnd, railX[1], y, zEnd, 0.028, 0.028, 5);
  const nb = Math.round((railX[1] - railX[0]) / 0.15);
  for (let i = 1; i < nb; i++) pen.boxMin(railX[0] + ((railX[1] - railX[0]) * i) / nb - 0.01, 0.14, zEnd - 0.01, 0.02, 0.93, 0.02);

  // green globe lamps at the head of the stairs
  const globe = new THREE.SphereGeometry(0.2, 12, 8);
  for (const rx of railX) {
    pen.to('matte', zc).color(GREEN);
    pen.cyl(rx, 0, z0, 0.075, 0.06, 0.5, 8, 2);
    pen.cyl(rx, 0.5, z0, 0.045, 0.04, 2.0, 8, 2);
    pen.cyl(rx, 2.5, z0, 0.09, 0.11, 0.08, 8, 3);
    pen.to('lit', zc).rgb(0.2, 1.1, 0.55);
    pen.push().move(rx, 2.76, z0).geom(globe).pop();
    c.glow.billboard(rx, 2.76, z0, 1.6, 0x35d886, 0.22, 0.3);
    c.colliders.push(rect(rx - 0.1, rx + 0.1, z0 - 0.1, z0 + 0.1));
  }
  globe.dispose();
  c.lights.push({ id: 'subway', x: (x0 + x1) / 2, y: 2.6, z: z0 - 0.25, color: 0xa6e8c6, intensity: 30, distance: 14 });

  // sign on the far railing, readable from both sides
  pen.to('matte', zc).color(0xd8d8d8);
  pen.rectXY(4.72, 1.14, 6.78, 1.53, zEnd + 0.04, R.sign_subway);
  pen.rectXY(4.72, 1.14, 6.78, 1.53, zEnd - 0.04, R.sign_subway, true);

  // steel landing plate and the ventilation grates along the curb
  pen.color(0x9c9c9c).rectXZ(x0 - 0.1, z0 - 1.7, x1 + 0.1, z0, 0.004, R.plate);
  for (let k = 0; k < 4; k++) pen.rectXZ(4.86, -2.5 - (k + 1) * 1.5, 6.06, -2.5 - k * 1.5, 0.004, R.grate);

  c.colliders.push(rect(x0 - 0.14, x1 + 0.14, z0 - 0.08, z1 + 0.14));
  return { metal: [rect(x0 - 0.1, x1 + 0.1, z0 - 1.7, z1), rect(4.86, 6.06, -8.5, -2.5)] };
}

/* ------------------------------------------------------------------ alley */

export function alley(c: Ctx): { can: { x: number; z: number }; canCollider: Rect } {
  const { pen, R, rng } = c;
  const { z0, z1, depth, gateX } = ALLEY;
  const zc = -20;
  const back = LINE + depth;

  pen.identity().to('sidewalk', zc).worldUV(2.5, 2.5).ao(1, 1);
  pen.color(0x707070).rectXZ(LINE, z1, LINE + 1.2, z0, 0);
  pen.color(0x4a4a4a).rectXZ(LINE + 1.2, z1, back, z0, 0);
  pen.to('brick', zc).worldUV(2.52, 2.4).color(0x5a4a42, 0.45).ao(0.5, 1);
  pen.rectZY(z1, 0, z0, 16, back, -1);
  pen.ao(1, 1).worldUV(0, 0);

  // standing water
  pen.to('puddle', zc).color(0xffffff);
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    pts.push([11.6 + Math.cos(a) * (1.3 + rng() * 0.5), -20.05 + Math.sin(a) * (0.6 + rng() * 0.25)]);
  }
  pen.fanXZ(pts, 0.004);

  // chain-link gate a metre in
  pen.to('matte', zc).color(0x3a3d40);
  for (const z of [z0 - 0.07, (z0 + z1) / 2, z1 + 0.07]) pen.cyl(gateX, 0, z, 0.04, 0.04, 2.32, 6, 2);
  for (const y of [0.2, 1.25, 2.28]) pen.tube(gateX, y, z1 + 0.07, gateX, y, z0 - 0.07, 0.028, 0.028, 5);
  pen.color(0xa0a0a0);
  const gz0 = z1 + 0.09, gz1 = z0 - 0.09;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const za = gz0 + ((gz1 - gz0) * i) / 4, zb = gz0 + ((gz1 - gz0) * (i + 1)) / 4;
      const ya = 0.2 + (2.08 * j) / 4, yb = 0.2 + (2.08 * (j + 1)) / 4;
      pen.rectZY(za, ya, zb, yb, gateX, -1, R.chain);
      pen.rectZY(za, ya, zb, yb, gateX, 1, R.chain);
    }
  }
  pen.color(0x1a1a1a).box(gateX - 0.04, 1.2, (z0 + z1) / 2, 0.06, 0.16, 0.12);

  // what is back there: a dumpster, a downpipe, one dim window
  pen.color(0x15231b).ao(0.7, 1);
  pen.boxMin(12.9, 0.12, z1 + 0.15, 2.0, 1.2, 1.15);
  pen.color(0x0e1712).boxMin(12.85, 1.32, z1 + 0.1, 2.1, 0.07, 1.25);
  pen.color(0x2a2c2e).ao(1, 1);
  pen.cyl(10.9, 0, z0 - 0.09, 0.06, 0.06, 11, 6, 0);
  pen.boxMin(16.2, 0, z0 - 0.5, 0.9, 0.9, 0.45);
  pen.to('lit', zc).rgb(0.2, 0.18, 0.13);
  pen.rectZY(-20.55, 5.3, -19.55, 6.95, back - 0.03, -1, R.win_l1);
  // one cold bulkhead light over a service door at the back: it throws the gate, the can and
  // anything that moves into silhouette from the street
  pen.to('matte', zc).color(0x1c1f22).ao(1, 1);
  pen.rectZY(z1 + 0.5, 0, z1 + 1.5, 2.15, back - 0.02, -1, R.door3);
  pen.box(back - 0.08, 2.5, z1 + 1.0, 0.14, 0.14, 0.3);
  pen.to('lit', zc).rgb(3.4, 4.2, 4.6).box(back - 0.16, 2.47, z1 + 1.0, 0.05, 0.1, 0.24);
  c.glow.billboard(back - 0.2, 2.47, z1 + 1.0, 0.5, 0xcfe4f0, 1.0, 0.1);
  c.glow.billboard(back - 0.2, 2.47, z1 + 1.0, 2.2, 0xa8c8dc, 0.16, 0.2);
  c.lights.push({ id: 'alley', x: back - 1.0, y: 2.3, z: z1 + 1.0, color: 0xbcd6e4, intensity: 55, distance: 22 });

  // bags against the near wall, the can against the far one
  trashPile(c, 8.98, z0 - 0.42, 3, 0.16, 0.14, false);
  c.colliders.push(rect(8.55, 9.45, z0 - 0.85, z0));
  const can = { x: 9.02, z: z1 + 0.5 };
  const canCollider = rect(can.x - 0.32, can.x + 0.32, can.z - 0.32, can.z + 0.32);
  c.colliders.push(canCollider);
  c.colliders.push(rect(gateX - 0.08, back + 2, z1, z0));
  return { can, canCollider };
}

/* ------------------------------------------------------------------- shed */

export function sidewalkShed(c: Ctx): void {
  const { pen, R } = c;
  const { z0, z1, postInner, postOuter, deckY } = SHED;
  const len = z0 - z1;
  const STEEL = 0x4a4e52;
  const bays = 8;
  const zs: number[] = [];
  for (let i = 0; i <= bays; i++) zs.push(z0 - 0.15 - ((len - 0.3) * i) / bays);

  pen.identity().worldUV(0, 0);
  for (const z of zs) {
    pen.to('matte', z);
    for (const x of [postOuter, postInner]) {
      pen.color(0x4b3e2a).ao(1, 1).boxMin(x - 0.16, 0, z - 0.16, 0.32, 0.05, 0.32);
      pen.color(STEEL).ao(0.7, 1).boxMin(x - 0.045, 0.05, z - 0.045, 0.09, deckY - 0.05, 0.09, 'yY');
      c.colliders.push(rect(x - 0.13, x + 0.13, z - 0.13, z + 0.13));
    }
    pen.ao(1, 1).color(0x3c4044).boxMin(4.72, deckY, z - 0.05, LINE - 4.72 - 0.06, 0.16, 0.1);
    // knee braces on the curb side
    pen.color(STEEL);
    if (z < z0 - 1) pen.tube(postOuter, deckY - 0.7, z, postOuter, deckY - 0.1, z + 0.6, 0.02, 0.02, 4);
    if (z > z1 + 1) pen.tube(postOuter, deckY - 0.7, z, postOuter, deckY - 0.1, z - 0.6, 0.02, 0.02, 4);
  }
  // full-height cross bracing in two bays (you cannot step through these)
  for (const b of [1, 6]) {
    const za = zs[b], zb = zs[b + 1];
    pen.to('matte', za).color(STEEL);
    pen.tube(postOuter, 0.12, za, postOuter, deckY - 0.2, zb, 0.02, 0.02, 4);
    pen.tube(postOuter, 0.12, zb, postOuter, deckY - 0.2, za, 0.02, 0.02, 4);
    c.colliders.push(rect(postOuter - 0.15, postOuter + 0.15, za, zb));
  }

  const mid = (z0 + z1) / 2;
  pen.to('matte', mid).ao(1, 1);
  // stringers, joists, deck
  pen.color(0x3c4044);
  pen.boxMin(postOuter - 0.05, deckY - 0.14, z1, 0.1, 0.14, len);
  pen.boxMin(postInner - 0.05, deckY - 0.14, z1, 0.1, 0.14, len);
  pen.color(0x4a3b22);
  for (const x of [5.5, 6.1, 7.1, 7.7]) pen.boxMin(x - 0.025, deckY + 0.02, z1, 0.05, 0.14, len, 'Y');
  pen.color(0x4f4028).boxMin(4.6, deckY + 0.16, z1, LINE - 4.6, 0.06, len);
  // green plywood parapet
  const py0 = deckY + 0.22, py1 = deckY + 1.42;
  const np = 15;
  for (let k = 0; k < np; k++) {
    const za = z1 + (len * k) / np, zb = z1 + (len * (k + 1)) / np;
    pen.color(0xffffff).rectZY(za, py0, zb, py1, 4.6, -1, R.ply_green);
  }
  pen.color(0x12201a).rectZY(z1, py0, z0, py1, 4.64, 1);
  for (let k = 0; k < 3; k++) {
    const xa = 4.6 + ((LINE - 4.6) * k) / 3, xb = 4.6 + ((LINE - 4.6) * (k + 1)) / 3;
    pen.color(0xffffff);
    pen.rectXY(xa, py0, xb, py1, z0, R.ply_green);
    pen.rectXY(xa, py0, xb, py1, z1, R.ply_green, true);
  }
  pen.color(0x101a15).boxMin(4.57, py1, z1, 0.09, 0.05, len);
  pen.color(0x7c7c7c);
  pen.rectZY(-36.3, py0 + 0.25, -35.7, py0 + 1.05, 4.59, -1, R.permit);
  pen.rectZY(-50.4, py0 + 0.25, -49.8, py0 + 1.05, 4.59, -1, R.permit);
  pen.rectXY(5.4, py0 + 0.25, 6.0, py0 + 1.05, z0 + 0.01, R.permit);

  // raw plywood hoarding along the building
  const wallX = LINE - 0.08;
  for (let k = 0; k < np; k++) {
    const za = z1 + (len * k) / np, zb = z1 + (len * (k + 1)) / np;
    pen.to('matte', (za + zb) / 2).color(0xffffff).ao(0.8, 1);
    pen.rectZY(za, 0, zb, 2.44, wallX, -1, R[k === 3 || k === 13 ? 'ply1' : k === 1 || k === 7 || k === 11 ? 'ply2' : 'ply0']);
  }
  pen.to('matte', mid).ao(1, 1);
  pen.color(0x141414).rectZY(z1, 2.44, z0, deckY + 0.16, wallX + 0.02, -1);
  pen.color(0x5b4a30).boxMin(wallX - 0.05, 2.38, z1, 0.05, 0.09, len);
  pen.color(0x5b4a30).boxMin(wallX - 0.05, 0, z1, 0.05, 0.09, len);
  pen.color(0x1f3a2d).rectXY(wallX, 0, LINE, 2.44, z0);
  pen.rectXY(wallX, 0, LINE, 2.44, z1, undefined, true);
  // old posters and a tag, kept clear of the spot where he leans
  pen.to('decal', mid).color(0x9a9a9a);
  pen.rectZY(-46.9, 0.55, -45.4, 2.05, wallX - 0.006, -1, R.poster_wall);
  pen.color(0xffffff).rectZY(-44.6, 0.95, -43.0, 1.75, wallX - 0.006, -1, R.tag1);
  pen.rectZY(-51.3, 0.7, -49.9, 1.4, wallX - 0.006, -1, R.tag0);

  // bare work lights on a conduit: two alive, two dead
  pen.to('matte', mid).color(0x26282a);
  const lx = 6.6;
  pen.boxMin(lx - 0.015, deckY - 0.03, z1 + 0.3, 0.03, 0.03, len - 0.6);
  const bulbs: Array<[number, number]> = [[-36.3, 0], [-40.6, 22], [-45.1, 0], [-49.5, 16]];
  bulbs.forEach(([z, cd], i) => {
    const by = deckY - 0.4;
    pen.to('matte', z).color(0x1c1c1c);
    pen.cyl(lx, deckY - 0.22, z, 0.012, 0.012, 0.2, 4, 0);
    pen.cyl(lx, by + 0.05, z, 0.035, 0.035, 0.1, 6, 3);
    pen.color(0x6f5412);
    for (const [dx, dz] of [[0.075, 0], [-0.075, 0], [0, 0.075], [0, -0.075]]) {
      pen.tube(lx + dx * 0.5, by + 0.06, z + dz * 0.5, lx + dx, by - 0.04, z + dz, 0.006, 0.006, 3);
      pen.tube(lx + dx, by - 0.04, z + dz, lx, by - 0.16, z, 0.006, 0.006, 3);
    }
    if (cd > 0) {
      pen.to('lit', z).rgb(11, 8, 4.2).box(lx, by - 0.03, z, 0.06, 0.09, 0.06);
      c.glow.billboard(lx, by - 0.03, z, 0.55, 0xffc890, 1.6, 0.12);
      c.glow.billboard(lx, by - 0.03, z, 2.6, 0xffb070, 0.26, 0.3);
      c.lights.push({ id: 'shed' + i, x: lx, y: by - 0.06, z, color: 0xffc692, intensity: cd, distance: 12, shadow: true });
    } else {
      pen.to('gloss', z).color(0x4c4a42).box(lx, by - 0.03, z, 0.06, 0.09, 0.06);
    }
  });

  // gloom on the ground under the deck
  pen.to('decal', mid).color(0x000000);
  pen.rectXZ(4.25, z1 - 0.9, LINE, z0 + 0.9, 0.007, R.shade);

  // a couple of cones at the ends
  for (const [x, z] of [[5.35, z0 + 0.45], [5.3, z1 - 0.5]]) {
    pen.to('matte', z).color(0x8a3f16);
    pen.boxMin(x - 0.16, 0, z - 0.16, 0.32, 0.03, 0.32);
    pen.cyl(x, 0.03, z, 0.12, 0.03, 0.52, 8, 2);
    pen.color(0x9a9a92).cyl(x, 0.26, z, 0.075, 0.055, 0.1, 8, 0);
    c.colliders.push(rect(x - 0.17, x + 0.17, z - 0.17, z + 0.17));
  }
}

/* ------------------------------------------------------------------- shop */

export interface ShopInfo {
  /** hinge position of the door leaf */
  hinge: THREE.Vector3;
  leafWidth: number;
  leafHeight: number;
  /** blocks the doorway while the door is closed */
  doorCollider: Rect;
  /** the open leaf itself */
  leafCollider: Rect;
  metal: Rect;
  interior: Rect;
}

export function shop(c: Ctx): ShopInfo {
  const { pen, R } = c;
  const X = LINE;
  const { x1, iz0, iz1, ceil, doorZ, doorHalf } = SHOP;
  const zc = doorZ;
  const dzA = doorZ + doorHalf; // -77.35
  const dzB = doorZ - doorHalf; // -78.65
  const wA0 = SHOP.z0 - 0.45; // -73.95
  const wB1 = SHOP.z1 + 0.45; // -82.05

  /* ---- shopfront ---- */
  pen.identity().to('matte', zc).worldUV(0, 0).ao(0.8, 1);
  pen.color(0x2e1d19);
  pen.boxMin(X - 0.02, 0, wA0, 0.24, 3.6, 0.45);
  pen.boxMin(X - 0.02, 0, SHOP.z1, 0.24, 3.6, 0.45);
  pen.color(0x1b2a23);
  pen.boxMin(X, 0, dzA, 0.2, 0.55, wA0 - dzA);
  pen.boxMin(X, 0, wB1, 0.2, 0.55, dzB - wB1);
  pen.ao(1, 1).color(0x221a17).boxMin(X, 2.6, wB1, 0.2, 1.0, wA0 - wB1);
  pen.color(0x5a5e62);
  for (const z of [wA0, (wA0 + dzA) / 2, dzA, dzB, (dzB + wB1) / 2, wB1]) {
    const door = z === dzA || z === dzB;
    pen.boxMin(X + 0.02, door ? 0 : 0.55, z - 0.035, 0.1, door ? 2.6 : 2.05, 0.07);
  }
  pen.boxMin(X + 0.02, 0.55, dzA, 0.1, 0.05, wA0 - dzA);
  pen.boxMin(X + 0.02, 0.55, wB1, 0.1, 0.05, dzB - wB1);
  pen.boxMin(X + 0.02, 2.55, wB1, 0.1, 0.05, wA0 - wB1);
  pen.boxMin(X + 0.02, 2.2, dzB, 0.1, 0.05, dzA - dzB);
  // threshold
  pen.color(0x6a6c6e).rectXZ(X, dzB, X + 0.2, dzA, 0.003);
  pen.to('glass', zc).color(0xffffff);
  pen.rectZY(dzA, 0.6, wA0, 2.55, X + 0.07, -1);
  pen.rectZY(wB1, 0.6, dzB, 2.55, X + 0.07, -1);
  pen.rectZY(dzB, 2.25, dzA, 2.55, X + 0.07, -1);

  /* ---- interior: unlit materials, so it reads as the brightest place on the block ---- */
  // everything in here is self-lit; K sets how bright the room sits against the street
  const K = 0.36;
  const L = (r: number, g: number, b: number) => pen.to('lit', zc).rgb(r * K, g * K, b * K);
  L(0.85, 0.82, 0.74);
  for (let x = X; x < x1 - 0.01; x += 1.2) {
    for (let z = iz1; z < iz0 - 0.01; z += 1.2) pen.rectXZ(x, z, Math.min(x + 1.2, x1), Math.min(z + 1.2, iz0), 0.002, R.tile);
  }
  L(0.4, 0.4, 0.36).rectXZ(X, iz1, x1, iz0, ceil, undefined, true);
  L(0.5, 0.47, 0.4);
  pen.rectZY(iz1, 0, iz0, ceil, x1, -1);
  pen.rectXY(X, 0, x1, ceil, iz0, undefined, true);
  pen.rectXY(X, 0, x1, ceil, iz1);
  pen.rectZY(iz1, 2.6, iz0, ceil, X + 0.2, 1);
  pen.rectZY(iz1, 0, wB1, 2.6, X + 0.22, 1);
  pen.rectZY(wA0, 0, iz0, 2.6, X + 0.22, 1);
  L(0.32, 0.3, 0.26);
  pen.rectZY(dzA, 0, wA0, 0.55, X + 0.2, 1);
  pen.rectZY(wB1, 0, dzB, 0.55, X + 0.2, 1);

  // shelving along both side walls
  L(0.2, 0.19, 0.17);
  pen.boxMin(X + 1.4, 0, iz0 - 0.32, x1 - 0.7 - (X + 1.4), 2.4, 0.32);
  pen.boxMin(X + 0.9, 0, iz1, x1 - 0.6 - (X + 0.9), 2.4, 0.32);
  L(0.8, 0.78, 0.74);
  pen.rectXY(X + 1.4, 0.12, x1 - 0.7, 2.36, iz0 - 0.325, R.shelves, true);
  pen.rectXY(X + 0.9, 0.12, x1 - 0.6, 2.36, iz1 + 0.325, R.shelves);
  // drinks fridges on the back wall
  L(0.07, 0.08, 0.09).boxMin(x1 - 0.6, 0, -76.35, 0.6, 2.3, 2.5);
  L(1.9, 2.0, 2.05);
  for (let k = 0; k < 3; k++) pen.rectZY(-76.3 + k * 0.8, 0.12, -75.5 + k * 0.8, 2.2, x1 - 0.605, -1, R.fridge);

  // behind the clerk: cigarettes and a back counter
  L(0.2, 0.17, 0.13).boxMin(x1 - 0.45, 0, -79.2, 0.45, 0.95, 2.6);
  L(0.8, 0.8, 0.8).rectZY(-79.2, 1.3, -76.6, 2.5, x1 - 0.02, -1, R.cigs);
  L(0.05, 0.05, 0.06).boxMin(x1 - 0.4, 0.95, -77.3, 0.3, 0.38, 0.3);
  L(4, 0.5, 0.3).boxMin(x1 - 0.41, 1.2, -77.12, 0.012, 0.03, 0.03);
  // back-right shelves
  L(0.2, 0.19, 0.17).boxMin(x1 - 0.32, 0, iz1 + 0.32, 0.32, 2.4, 2.1);
  L(0.9, 0.88, 0.84).rectZY(iz1 + 0.34, 0.12, iz1 + 2.4, 2.36, x1 - 0.325, -1, sub(R.shelves, 0, 0, 0.5, 1));
  // free-standing gondola
  L(0.22, 0.21, 0.19).boxMin(9.7, 0, -81.35, 2.6, 1.45, 0.7);
  L(0.9, 0.88, 0.84);
  pen.rectXY(9.7, 0.08, 12.3, 1.4, -80.645, sub(R.shelves, 0, 0.4, 1, 1));
  pen.rectXY(9.7, 0.08, 12.3, 1.4, -81.355, sub(R.shelves, 0, 0, 1, 0.6), true);
  c.colliders.push(rect(9.65, 12.35, -81.4, -80.6));

  // counter with the clerk's space behind it
  L(0.3, 0.24, 0.17);
  pen.boxMin(11.3, 0, -79.4, 0.6, 1.05, 2.8);
  pen.boxMin(11.9, 0, -79.5, x1 - 11.9, 1.05, 0.25);
  pen.boxMin(11.9, 0, -76.75, x1 - 11.9, 1.05, 0.25);
  L(0.5, 0.42, 0.31).rectXZ(11.25, -79.5, 11.95, -76.5, 1.055);
  L(0.85, 0.85, 0.85).rectZY(-79.4, 0.04, -76.6, 1.0, 11.295, -1, R.counter);
  L(0.05, 0.05, 0.06).boxMin(11.42, 1.055, -77.55, 0.38, 0.3, 0.42);
  L(0.8, 3.0, 1.8).rectZY(-77.47, 1.24, -77.23, 1.31, 11.415, -1);
  L(0.12, 0.12, 0.13).boxMin(11.4, 1.055, -79.25, 0.32, 0.46, 0.5);
  L(0.9, 0.9, 0.9).rectZY(-79.25, 1.08, -78.75, 1.5, 11.395, -1, sub(R.cigs, 0, 0.4, 0.5, 1));
  c.colliders.push(rect(11.3, 11.9, -79.4, -76.6));
  c.colliders.push(rect(11.9, x1, -79.55, -79.2));
  c.colliders.push(rect(11.9, x1, -76.8, -76.45));

  // ATM beside the window, lit sign above it
  L(0.09, 0.09, 0.1).boxMin(8.95, 0, -74.5, 0.56, 1.56, 0.6);
  L(2.2, 2.2, 2.2).rectXY(8.95, 0.04, 9.51, 1.56, -74.505, R.atm, true);
  c.glow.billboard(9.23, 1.2, -74.75, 1.2, 0x5aa2ff, 0.12, 0);
  c.colliders.push(rect(8.9, 9.56, -74.55, iz0));
  // window A: a low display rack, posters, the OPEN neon
  L(0.24, 0.23, 0.2).boxMin(8.8, 0.55, -77.15, 0.34, 0.8, 2.2);
  L(0.7, 0.7, 0.66).rectZY(-77.15, 0.6, -74.95, 1.34, 8.795, -1, sub(R.shelves, 0, 0, 0.62, 0.6));
  L(0.5, 0.5, 0.5);
  pen.rectZY(-77.1, 1.55, -76.5, 2.35, 8.6, -1, R.poster0);
  pen.rectZY(-76.3, 1.45, -75.7, 2.25, 8.6, -1, R.poster2);
  L(4.2, 4.2, 4.2).rectZY(-75.25, 1.72, -74.15, 2.27, 8.62, -1, R.neon_open);
  c.glow.billboard(8.5, 2.0, -74.7, 1.5, 0xff5040, 0.18, 0.35);
  c.colliders.push(rect(8.7, 9.16, -77.2, -74.9));
  // window B: stacked cases, a poster, the ATM sign
  L(0.26, 0.32, 0.46).boxMin(8.8, 0.55, -81.95, 0.42, 0.95, 1.25);
  L(0.46, 0.2, 0.15).boxMin(8.8, 0.55, -80.6, 0.42, 0.62, 0.95);
  L(0.5, 0.5, 0.5).rectZY(-80.3, 1.5, -79.7, 2.3, 8.6, -1, R.poster1);
  L(3.0, 3.0, 3.0).rectZY(-81.95, 1.93, -81.05, 2.3, 8.62, -1, sub(R.atm, 0, 0, 1, 0.172));
  c.glow.billboard(8.5, 2.1, -81.5, 1.1, 0x4a90ff, 0.14, 0.35);
  c.colliders.push(rect(8.7, 9.26, iz1, -79.6));
  // fluorescent tubes
  L(5.5, 6.0, 5.5);
  for (const x of [9.9, 12.0]) {
    for (const z of [-75.5, -78, -80.5]) pen.boxMin(x - 0.11, ceil - 0.07, z - 0.6, 0.22, 0.06, 1.2);
  }

  /* ---- outside: awning, lights, freezer, crates, cellar doors ---- */
  const az0 = SHOP.z0 - 0.1, az1 = SHOP.z1 + 0.1;
  const ax = 7.25, ayLow = 2.72, ayTop = 3.45;
  L(0.75, 0.68, 0.56);
  pen.quad(ax, ayLow, az1, ax, ayLow, az0, X, ayTop, az0, X, ayTop, az1, R.awning);
  L(0.62, 0.56, 0.46);
  pen.quad(ax, ayLow - 0.3, az1, ax, ayLow - 0.3, az0, ax, ayLow, az0, ax, ayLow, az1, R.awning_val);
  pen.to('matte', zc).color(0x7a6a3c);
  pen.quad(ax, ayLow - 0.01, az0, ax, ayLow - 0.01, az1, X, ayTop - 0.01, az1, X, ayTop - 0.01, az0);
  pen.quad(ax + 0.005, ayLow - 0.3, az0, ax + 0.005, ayLow - 0.3, az1, ax + 0.005, ayLow, az1, ax + 0.005, ayLow, az0);
  pen.color(0x6a5a30);
  pen.tri(ax, ayLow, az0, X, ayLow, az0, X, ayTop, az0);
  pen.tri(ax, ayLow, az1, X, ayTop, az1, X, ayLow, az1);
  pen.color(IRON);
  for (const z of [az0, (az0 + az1) / 2, az1]) pen.tube(X, ayLow, z, ax, ayLow, z, 0.018, 0.018, 4);
  pen.tube(ax, ayLow, az1, ax, ayLow, az0, 0.018, 0.018, 4);
  for (const z of [-75.6, -78, -80.4]) {
    pen.to('matte', zc).color(IRON).box(7.85, 3.02, z, 0.16, 0.05, 0.16);
    pen.to('lit', zc).rgb(5, 4, 2.7).box(7.85, 2.985, z, 0.11, 0.03, 0.11);
    c.glow.billboard(7.85, 2.96, z, 0.8, 0xffd9a6, 0.3, 0.15);
  }
  // kept modest: a head in the doorway is barely a metre from this fixture
  c.lights.push({ id: 'shopAwning', x: 7.5, y: 2.85, z: doorZ, color: 0xffd8a4, intensity: 18, distance: 15, shadow: true });
  c.lights.push({ id: 'shopInside', x: 10.3, y: 2.75, z: doorZ, color: 0xfff0d4, intensity: 36, distance: 16 });
  c.glow.flat(6.7, 0.02, -75.6, 6.4, 5.6, 0xffd9a8, 0.3);
  c.glow.flat(6.5, 0.02, doorZ, 5.4, 3.8, 0xffe2b8, 0.36);
  c.glow.flat(6.7, 0.02, -80.4, 6.4, 5.6, 0xffd9a8, 0.3);

  // ice freezer under window B
  pen.to('matte', zc).ao(0.8, 1).color(0x6c7174).boxMin(7.74, 0, -81.75, 0.76, 0.95, 1.6);
  pen.color(0xa8a8a8).rectZY(-81.75, 0.05, -80.15, 0.92, 7.735, -1, R.ice);
  c.colliders.push(rect(7.7, X, -81.8, -80.1));
  // milk crates by the door
  pen.ao(1, 1).color(0x1b2e4c).boxMin(8.13, 0, -77.22, 0.34, 0.29, 0.34);
  pen.color(0x44221e).push().move(8.3, 0.29, -77.05).rot(0, 0.3, 0).boxMin(-0.17, 0, -0.17, 0.34, 0.29, 0.34).pop();
  c.colliders.push(rect(8.08, X, -77.3, -76.8));
  // steel cellar doors in the sidewalk
  const metal = rect(7.3, 8.45, -76.6, -74.8);
  pen.color(0x9a9a9a).rectXZ(metal.minX, metal.minZ, metal.maxX, metal.maxZ, 0.004, R.plate);

  /* ---- walls you cannot walk through ---- */
  c.colliders.push(rect(X, X + 0.26, dzA, SHOP.z0));
  c.colliders.push(rect(X, X + 0.26, SHOP.z1, dzB));
  c.colliders.push(rect(X, 15, iz0, SHOP.z0));
  c.colliders.push(rect(X, 15, SHOP.z1, iz1));
  c.colliders.push(rect(x1, 15, SHOP.z1, SHOP.z0));
  const doorCollider = rect(1000, 1000.01, 1000, 1000.01); // open by default
  const leafCollider = rect(X + 0.26, X + 1.42, dzB - 0.14, dzB + 0.02);
  c.colliders.push(doorCollider, leafCollider);

  return {
    hinge: new THREE.Vector3(X + 0.07, 0.01, dzB + 0.035),
    leafWidth: dzA - dzB - 0.07,
    leafHeight: 2.18,
    doorCollider,
    leafCollider,
    metal,
    interior: rect(X, x1, SHOP.z1, SHOP.z0),
  };
}

/* ------------------------------------------------------------------- home */

export interface HomeInfo {
  hinge: THREE.Vector3;
  leafWidth: number;
  leafHeight: number;
}

export function home(c: Ctx, lot: Lot): HomeInfo {
  const { pen, R } = c;
  const { z0, z1, doorZ, doorHalf, stoopHalf, stoopX, landingY } = HOME;
  const zc = doorZ;
  const TRIM = 0x8a8272;
  const STONE = 0x6e6052;
  const doorTop = landingY + 2.2;
  const openTop = doorTop + 0.36;

  /* ---- ground-floor wall, in the wall's own frame ---- */
  pen.frame(LINE, 0, 0, RIGHT);
  const winA: Opening = { c: -130.4, hw: 0.5, yb: 1.15, yt: 2.9 };
  const door: Opening = { c: doorZ, hw: doorHalf, yb: landingY, yt: openTop };
  const winB: Opening = { c: -125.6, hw: 0.5, yb: 1.15, yt: 2.9 };
  pen.to('brick', zc).worldUV(2.52, 2.4).color(lot.tint).ao(0.7, 1);
  strips(pen, z1, z0, 0, lot.gh, [winA, door, winB]);
  pen.color(lot.tint, 0.62).ao(1, 1);
  reveals(pen, winA, 0.13, false);
  reveals(pen, winB, 0.13, false);
  pen.to('matte', zc).worldUV(0, 0).color(TRIM, 0.8);
  reveals(pen, door, 0.3, false);
  // windows: one dark, one with someone still up
  pen.to('gloss', zc).color(0xffffff).rectXY(winA.c - 0.5, winA.yb, winA.c + 0.5, winA.yt, -0.13, R.win_d1);
  pen.to('lit', zc).rgb(0.5, 0.5, 0.5).rectXY(winB.c - 0.5, winB.yb, winB.c + 0.5, winB.yt, -0.13, R.win_l0);
  pen.to('matte', zc).color(TRIM).ao(1, 1);
  for (const o of [winA, winB]) {
    pen.boxMin(o.c - 0.58, o.yb - 0.1, -0.02, 1.16, 0.1, 0.14);
    pen.boxMin(o.c - 0.6, o.yt, -0.01, 1.2, 0.24, 0.07);
    pen.color(IRON);
    for (let k = 1; k < 5; k++) pen.boxMin(o.c - 0.5 + k * 0.2 - 0.012, o.yb, -0.05, 0.024, o.yt - o.yb, 0.024);
    pen.boxMin(o.c - 0.5, o.yb + 0.3, -0.05, 1.0, 0.024, 0.024);
    pen.boxMin(o.c - 0.5, o.yt - 0.35, -0.05, 1.0, 0.024, 0.024);
    pen.color(TRIM);
  }
  pen.boxMin(z1, lot.gh - 0.16, 0, z0 - z1, 0.16, 0.07, 'z');
  // base course either side of the stoop
  pen.color(STONE, 0.8).ao(0.6, 1);
  pen.boxMin(z1, 0, 0, doorZ - stoopHalf - 0.28 - z1, 0.5, 0.06, 'zy');
  pen.boxMin(doorZ + stoopHalf + 0.28, 0, 0, z0 - (doorZ + stoopHalf + 0.28), 0.5, 0.06, 'zy');
  // door surround
  pen.color(TRIM).ao(0.8, 1);
  pen.boxMin(doorZ - doorHalf - 0.24, landingY, 0, 0.24, openTop - landingY, 0.1, 'z');
  pen.boxMin(doorZ + doorHalf, landingY, 0, 0.24, openTop - landingY, 0.1, 'z');
  pen.ao(1, 1);
  pen.boxMin(doorZ - 0.98, openTop, 0, 1.96, 0.3, 0.3, 'z');
  pen.boxMin(doorZ - 1.08, openTop + 0.3, 0, 2.16, 0.08, 0.38, 'z');
  // transom with the house number, lit from the hall
  pen.to('lit', zc).rgb(0.85, 0.85, 0.85);
  pen.rectXY(doorZ - doorHalf, doorTop, doorZ + doorHalf, openTop, -0.3, R.transom_home);
  pen.to('matte', zc).color(0x1a110b).boxMin(doorZ - doorHalf, doorTop - 0.03, -0.3, doorHalf * 2, 0.06, 0.06);
  // intercom
  pen.color(0xd0d0d0).rectXY(doorZ + doorHalf + 0.36, 1.3, doorZ + doorHalf + 0.52, 1.62, 0.012, R.intercom);
  c.glow.billboard(LINE - 0.03, 1.318, doorZ + doorHalf + 0.495, 0.1, 0xff3020, 0.8, 0.02);
  // lantern over the door
  const ly = openTop + 0.64;
  pen.color(IRON);
  pen.boxMin(doorZ - 0.02, ly + 0.2, 0, 0.04, 0.04, 0.34);
  pen.boxMin(doorZ - 0.11, ly + 0.14, 0.2, 0.22, 0.04, 0.22);
  pen.boxMin(doorZ - 0.11, ly - 0.2, 0.2, 0.22, 0.03, 0.22);
  for (const [du, dn] of [[-0.11, 0.2], [0.09, 0.2], [-0.11, 0.4], [0.09, 0.4]]) pen.boxMin(doorZ + du, ly - 0.2, dn, 0.02, 0.34, 0.02);
  pen.to('lit', zc).rgb(5, 3.5, 1.8).box(doorZ, ly - 0.02, 0.31, 0.12, 0.2, 0.12);
  pen.identity();
  c.glow.billboard(LINE - 0.31, ly - 0.02, doorZ, 0.5, 0xffc88a, 0.8, 0.15);
  c.glow.billboard(LINE - 0.31, ly - 0.02, doorZ, 2.4, 0xffb46a, 0.2, 0.3);
  c.glow.flat(6.6, 0.02, doorZ, 4.6, 4.6, 0xffc88a, 0.13);
  c.lights.push({ id: 'home', x: LINE - 0.95, y: ly - 0.25, z: doorZ, color: 0xffc98f, intensity: 21, distance: 12, shadow: true });

  /* ---- the stoop: two low steps you can actually walk up ---- */
  pen.to('matte', zc).worldUV(0, 0).color(STONE).ao(0.75, 1);
  const za = doorZ - stoopHalf, zb = doorZ + stoopHalf;
  pen.boxMin(stoopX, 0, za, 0.34, landingY / 2, zb - za, 'y');
  pen.boxMin(stoopX + 0.34, 0, za, LINE + 0.3 - stoopX - 0.34, landingY, zb - za, 'y');
  pen.color(0x8d8474).ao(1, 1);
  pen.rectXZ(stoopX, za, stoopX + 0.05, zb, landingY / 2 + 0.002);
  pen.rectXZ(stoopX + 0.34, za, stoopX + 0.39, zb, landingY + 0.002);
  for (const s of [-1, 1]) {
    const w0 = s < 0 ? za - 0.28 : zb;
    pen.color(STONE).ao(0.7, 1);
    pen.boxMin(stoopX + 0.8, 0, w0, LINE - stoopX - 0.8, 0.78, 0.28, 'y');
    pen.boxMin(stoopX, 0, w0, 0.8, 0.5, 0.28, 'y');
    pen.boxMin(stoopX - 0.04, 0, w0 - 0.03, 0.34, 0.92, 0.34, 'y');
    pen.color(0x8d8474).ao(1, 1).boxMin(stoopX - 0.08, 0.92, w0 - 0.07, 0.42, 0.07, 0.42);
    pen.color(IRON);
    const rz = w0 + 0.14;
    pen.tube(stoopX + 0.13, 1.32, rz, LINE - 0.04, 1.5, rz, 0.022, 0.022, 5);
    pen.boxMin(stoopX + 0.12, 0.99, rz - 0.01, 0.02, 0.34, 0.02);
    for (let k = 1; k <= 5; k++) {
      const x = stoopX + 0.13 + ((LINE - 0.1 - stoopX - 0.13) * k) / 5;
      const base = x < stoopX + 0.8 ? 0.5 : 0.78;
      pen.boxMin(x - 0.01, base, rz - 0.01, 0.02, 1.32 + ((1.5 - 1.32) * k) / 5 - base, 0.02);
    }
    c.colliders.push(rect(stoopX - 0.06, LINE, w0 - 0.03, w0 + 0.31));
  }
  // two bins by the stoop
  pen.to('gloss', zc).ao(0.8, 1);
  for (const [z, col] of [[zb + 0.72, 0x15231b], [zb + 1.3, 0x17181a]] as Array<[number, number]>) {
    pen.color(col).cyl(8.12, 0, z, 0.23, 0.27, 0.82, 10, 2);
    pen.cyl(8.12, 0.82, z, 0.29, 0.26, 0.07, 10, 2);
  }
  c.colliders.push(rect(7.8, LINE, zb + 0.4, zb + 1.62));

  /* ---- the hallway behind the door ---- */
  const hx0 = LINE + 0.3, hx1 = LINE + 2.9;
  const hz0 = doorZ - 0.95, hz1 = doorZ + 0.95;
  pen.to('lit', zc).ao(1, 1);
  pen.rgb(0.22, 0.2, 0.17);
  pen.rectXZ(hx0, hz0, hx0 + 1.3, hz1, landingY + 0.002, R.tile);
  pen.rectXZ(hx0 + 1.3, hz0, hx1, hz1, landingY + 0.002, R.tile);
  pen.rgb(0.2, 0.145, 0.075);
  pen.rectXY(hx0, landingY, hx1, 3.0, hz1, undefined, true);
  pen.rectXY(hx0, landingY, hx1, 3.0, hz0);
  pen.rgb(0.16, 0.115, 0.06).rectZY(hz0, landingY, hz1, 3.0, hx1, -1);
  pen.rgb(0.12, 0.1, 0.075).rectXZ(hx0, hz0, hx1, hz1, 3.0, undefined, true);
  pen.rgb(0.55, 0.5, 0.42).rectZY(doorZ - 0.5, landingY, doorZ + 0.5, landingY + 2.15, hx1 - 0.01, -1, sub(R.door1, 0, 0.19, 1, 1));
  pen.rgb(0.3, 0.27, 0.2).rectXY(hx0 + 0.5, 1.15, hx0 + 1.7, 1.65, hz0 + 0.01, sub(R.cigs, 0, 0, 0.5, 0.42));
  pen.rgb(4.5, 3.3, 1.7).box((hx0 + hx1) / 2, 2.94, doorZ, 0.3, 0.08, 0.3);

  return {
    hinge: new THREE.Vector3(LINE + 0.3, landingY + 0.005, doorZ - doorHalf),
    leafWidth: doorHalf * 2,
    leafHeight: 2.2 - 0.035,
  };
}
