/**
 * Street furniture: cars, lamps, trees, hydrants, trash, mailbox, bike rack,
 * traffic signals, signs.
 */

import * as THREE from 'three';
import { chunkOf as chunkKey, type Pen, type UVRect } from './geo';
import { LAMP_ARM, LAMP_H, LAMP_POLE_X, ROAD_Y, SODIUM, rect, type Ctx } from './layout';

const IRON = 0x15171a;

/* ------------------------------------------------------------------- cars */

export type CarType = 'sedan' | 'suv' | 'hatch' | 'van';

interface CarSpec {
  L: number;
  W: number;
  body: (hl: number) => Array<[number, number]>;
  cabin: (hl: number) => Array<[number, number]>;
  wheelZ: number;
  wheelR: number;
  glassSides: boolean;
}

const CARS: Record<CarType, CarSpec> = {
  sedan: {
    L: 4.5,
    W: 1.78,
    body: (h) => [[h - 0.05, 0.3], [h, 0.62], [h - 0.16, 0.8], [h * 0.42, 0.92], [-h * 0.78, 0.96], [-h + 0.05, 0.9], [-h, 0.56], [-h + 0.05, 0.3]],
    cabin: (h) => [[h * 0.42, 0.92], [h * 0.1, 1.42], [-h * 0.45, 1.42], [-h * 0.78, 0.96]],
    wheelZ: 1.36,
    wheelR: 0.32,
    glassSides: true,
  },
  suv: {
    L: 4.7,
    W: 1.88,
    body: (h) => [[h - 0.05, 0.36], [h, 0.76], [h - 0.12, 0.99], [h * 0.5, 1.06], [-h + 0.02, 1.08], [-h, 0.6], [-h + 0.05, 0.36]],
    cabin: (h) => [[h * 0.5, 1.06], [h * 0.24, 1.72], [-h * 0.86, 1.72], [-h + 0.04, 1.08]],
    wheelZ: 1.42,
    wheelR: 0.36,
    glassSides: true,
  },
  hatch: {
    L: 4.0,
    W: 1.72,
    body: (h) => [[h - 0.05, 0.3], [h, 0.62], [h - 0.15, 0.82], [h * 0.45, 0.93], [-h + 0.02, 0.98], [-h, 0.56], [-h + 0.05, 0.3]],
    cabin: (h) => [[h * 0.45, 0.93], [h * 0.08, 1.48], [-h * 0.7, 1.48], [-h + 0.04, 0.98]],
    wheelZ: 1.2,
    wheelR: 0.31,
    glassSides: true,
  },
  van: {
    L: 5.3,
    W: 1.95,
    body: (h) => [[h - 0.05, 0.36], [h, 0.8], [h - 0.22, 1.15], [-h + 0.02, 1.15], [-h, 0.6], [-h + 0.05, 0.36]],
    cabin: (h) => [[h - 0.22, 1.15], [h - 0.85, 2.02], [-h + 0.04, 2.02], [-h + 0.02, 1.15]],
    wheelZ: 1.7,
    wheelR: 0.36,
    glassSides: false,
  },
};

export const carSize = (type: CarType): { L: number; W: number } => ({ L: CARS[type].L, W: CARS[type].W });

/** Extrude a convex side profile ([z, y] points) across the car's width; `colors[i]` overrides the colour of edge i. */
function extrude(pen: Pen, poly: Array<[number, number]>, hw: number, base: number, edgeColors: Record<number, number> = {}): void {
  let cz = 0, cy = 0;
  for (const p of poly) {
    cz += p[0];
    cy += p[1];
  }
  cz /= poly.length;
  cy /= poly.length;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    pen.color(edgeColors[i] ?? base);
    // outward test in 2D
    const nz = b[1] - a[1], ny = -(b[0] - a[0]);
    const out = nz * ((a[0] + b[0]) / 2 - cz) + ny * ((a[1] + b[1]) / 2 - cy) > 0;
    // quad (-hw,a) (hw,a) (hw,b) (-hw,b) has normal (b-a) x ... : pick the winding that faces outward
    if (out) pen.quad(-hw, a[1], a[0], hw, a[1], a[0], hw, b[1], b[0], -hw, b[1], b[0]);
    else pen.quad(hw, a[1], a[0], -hw, a[1], a[0], -hw, b[1], b[0], hw, b[1], b[0]);
  }
  pen.color(base);
  pen.polyZY(poly, hw, 1);
  pen.polyZY(poly, -hw, -1);
}

/**
 * A parked (or driving) car at (x, y, z), nose toward local +Z rotated by rotY.
 * chunkZ picks the batch; lightsOn swaps the lamps to emissive.
 */
export function drawCar(pen: Pen, R: Record<string, UVRect>, type: CarType, paint: number, x: number, y: number, z: number, rotY: number, lightsOn = false, chunkZ = z): void {
  const S = CARS[type];
  const hl = S.L / 2, hw = S.W / 2;
  const GLASS = 0x05070a;
  pen.push();
  pen.identity().move(x, y, z).rot(0, rotY, 0);
  pen.ao(1, 1).worldUV(0, 0);

  // contact shadow
  pen.toChunk('decal', chunkKey(chunkZ)).color(0x000000);
  pen.rectXZ(-hw - 0.45, -hl - 0.5, hw + 0.45, hl + 0.5, 0.012, R.blob);

  pen.toChunk('gloss', chunkKey(chunkZ));
  const body = S.body(hl);
  extrude(pen, body, hw, paint);
  const cabin = S.cabin(hl);
  const chw = hw - 0.11;
  extrude(pen, cabin, chw, paint, S.glassSides ? { 0: GLASS, 2: GLASS } : { 0: GLASS });
  // side glass: the cabin polygon shrunk toward its centre, split by a pillar
  let cz = 0, cy = 0;
  for (const p of cabin) {
    cz += p[0];
    cy += p[1];
  }
  cz /= cabin.length;
  cy /= cabin.length;
  pen.color(GLASS);
  if (S.glassSides) {
    const g = cabin.map(([pz, py]) => [cz + (pz - cz) * 0.86, cy + (py - cy) * 0.78] as [number, number]);
    pen.polyZY(g, chw + 0.006, 1);
    pen.polyZY(g, -chw - 0.006, -1);
    pen.color(paint);
    pen.boxMin(-chw - 0.012, cy - 0.3, cz - 0.05, chw * 2 + 0.024, 0.62, 0.09, 'yY');
  } else {
    // van: front door glass only
    const a = cabin[0], b = cabin[1];
    const g: Array<[number, number]> = [[a[0] - 0.1, a[1] + 0.1], [b[0] + 0.06, b[1] - 0.12], [b[0] - 0.8, b[1] - 0.12], [b[0] - 0.8, a[1] + 0.1]];
    pen.polyZY(g, chw + 0.006, 1);
    pen.polyZY(g, -chw - 0.006, -1);
  }
  // mirrors
  pen.color(paint);
  pen.box(hw + 0.07, cabin[0][1] + 0.08, cabin[0][0] - 0.25, 0.16, 0.1, 0.07);
  pen.box(-hw - 0.07, cabin[0][1] + 0.08, cabin[0][0] - 0.25, 0.16, 0.1, 0.07);
  // bumpers / trim
  pen.color(0x0b0c0d);
  pen.box(0, 0.42, hl - 0.01, S.W - 0.2, 0.14, 0.06);
  pen.box(0, 0.42, -hl + 0.01, S.W - 0.2, 0.14, 0.06);

  // lamps
  const hy = body[1][1] - 0.02;
  for (const s of [-1, 1]) {
    if (lightsOn) pen.toChunk('lit', chunkKey(chunkZ)).rgb(5, 4.7, 4.0);
    else pen.toChunk('gloss', chunkKey(chunkZ)).color(0x9aa0a4);
    pen.box(s * (hw - 0.3), hy, hl - 0.03, 0.36, 0.13, 0.05);
    if (lightsOn) pen.rgb(2.6, 0.12, 0.08);
    else pen.color(0x4a0c0c);
    pen.box(s * (hw - 0.26), body[body.length - 2][1] + 0.18, -hl + 0.03, 0.4, 0.12, 0.05);
  }
  // plates
  pen.toChunk('matte', chunkKey(chunkZ)).color(lightsOn ? 0xffffff : 0x999999);
  pen.rectXY(-0.16, 0.45, 0.16, 0.6, hl + 0.025, R.plate_car);
  pen.rectXY(-0.16, 0.5, 0.16, 0.65, -hl - 0.025, R.plate_car, true);

  // wheels
  for (const sz of [-1, 1]) {
    for (const sx of [-1, 1]) {
      pen.push();
      pen.move(sx * (hw - 0.01), S.wheelR, sz * S.wheelZ).rot(0, 0, (sx * Math.PI) / 2);
      pen.toChunk('matte', chunkKey(chunkZ)).color(0x070708);
      pen.cyl(0, -0.02, 0, S.wheelR, S.wheelR, 0.24, 12, 1);
      pen.toChunk('gloss', chunkKey(chunkZ)).color(0x3c3f42);
      pen.cyl(0, -0.03, 0, S.wheelR * 0.6, S.wheelR * 0.55, 0.02, 10, 1);
      pen.pop();
    }
  }
  pen.pop();
}

const PAINTS = [0x0c0d10, 0x1a1c20, 0x3a3d42, 0x55585c, 0x14203a, 0x3a1214, 0x24302a, 0x6f706c, 0x2a2622, 0x1c2a3c];

export interface ParkedCar {
  x: number;
  z: number;
  type: CarType;
  /** +1 if the nose points toward +Z, -1 toward -Z */
  nose: 1 | -1;
}

/** Parked cars along one curb; pushes colliders and returns what it placed. */
export function parkedCars(c: Ctx, side: 1 | -1, zFrom: number, zTo: number, gaps: Array<[number, number]>, collide = true): ParkedCar[] {
  const placed: ParkedCar[] = [];
  const { pen, R, rng } = c;
  const x = side * 3.52;
  let z = zFrom;
  while (z > zTo + 4) {
    const roll = rng();
    const type: CarType = roll < 0.5 ? 'sedan' : roll < 0.75 ? 'suv' : roll < 0.92 ? 'hatch' : 'van';
    const { L, W } = carSize(type);
    const zc = z - L / 2;
    const blocked = gaps.some(([a, b]) => zc - L / 2 < Math.max(a, b) && zc + L / 2 > Math.min(a, b));
    if (blocked || rng() < 0.07) {
      z -= blocked ? 1.2 : 5.5;
      continue;
    }
    const paint = type === 'van' ? 0x7d7f7c : PAINTS[Math.floor(rng() * PAINTS.length)];
    // parked facing the direction of travel on that side
    const rot = side > 0 ? Math.PI : 0;
    const jitter = (rng() - 0.5) * 0.16;
    const cx = x + jitter - side * (W - 1.78) * 0.5;
    drawCar(pen, R, type, paint, cx, ROAD_Y, zc, rot + (rng() - 0.5) * 0.03);
    if (collide) c.colliders.push(rect(cx - W / 2 - 0.05, cx + W / 2 + 0.05, zc - L / 2 - 0.05, zc + L / 2 + 0.05));
    placed.push({ x: cx, z: zc, type, nose: side > 0 ? -1 : 1 });
    z -= L + 0.7 + rng() * 0.8;
  }
  return placed;
}

/* ------------------------------------------------------------------ lamps */

export interface LampHandle {
  z: number;
  halo: number;
  core: number;
  pool: number;
  lightIndex: number;
  flicker: boolean;
}

export function streetLamp(c: Ctx, z: number, side: 1 | -1, color: number, flicker: boolean, real = true): LampHandle {
  const { pen } = c;
  const x = side * LAMP_POLE_X;
  const hx = x - side * LAMP_ARM;
  pen.identity().to('matte', z).color(0x23262a).ao(0.7, 1).worldUV(0, 0);
  pen.cyl(x, 0, z, 0.16, 0.13, 0.9, 8, 2);
  pen.ao(1, 1);
  pen.cyl(x, 0.9, z, 0.09, 0.06, LAMP_H - 1.0, 8, 0);
  // arm: three segments curving out over the road
  const ay = LAMP_H - 0.1;
  pen.tube(x, ay, z, x - side * 0.6, ay + 0.34, z, 0.05, 0.045, 6);
  pen.tube(x - side * 0.6, ay + 0.34, z, x - side * 1.4, ay + 0.42, z, 0.045, 0.04, 6);
  pen.tube(x - side * 1.4, ay + 0.42, z, hx + side * 0.3, ay + 0.3, z, 0.04, 0.04, 6);
  // cobra head
  pen.box(hx, ay + 0.24, z, 0.78, 0.13, 0.3);
  const led = flicker || color !== SODIUM;
  pen.to('lit', z);
  if (!flicker) {
    if (led) pen.rgb(5.2, 6.0, 7.2);
    else pen.rgb(7.5, 4.0, 1.3);
    pen.rectXZ(hx - 0.3, z - 0.11, hx + 0.3, z + 0.11, ay + 0.17, undefined, true);
  }
  const halo = c.glow.billboard(hx, ay + 0.1, z, 3.4, color, 0.5, 0.5);
  const core = c.glow.billboard(hx, ay + 0.12, z, 0.75, color, flicker ? 3.2 : 1.4, 0.45);
  const pool = c.glow.flat(hx + side * 0.6, 0.02, z, 17, 17, color, 0.035);
  let lightIndex = -1;
  if (real) {
    lightIndex = c.lights.length;
    c.lights.push({ id: 'lamp' + z, x: hx, y: ay + 0.05, z, color, intensity: led ? 250 : 290, distance: 40, flicker, shadow: true });
  }
  c.colliders.push(rect(x - 0.18, x + 0.18, z - 0.18, z + 0.18));
  return { z, halo, core, pool, lightIndex, flicker };
}

/* ------------------------------------------------------------------ trees */

const _dir = new THREE.Vector3();
const _tmp = new THREE.Vector3();

function branch(pen: Pen, rng: () => number, px: number, py: number, pz: number, dx: number, dy: number, dz: number, len: number, r: number, depth: number): void {
  const ex = px + dx * len, ey = py + dy * len, ez = pz + dz * len;
  pen.tube(px, py, pz, ex, ey, ez, r, r * 0.68, depth > 2 ? 5 : 4);
  if (depth <= 0) return;
  const kids = depth > 1 ? 2 + (rng() < 0.55 ? 1 : 0) : 2;
  for (let i = 0; i < kids; i++) {
    _dir.set(dx + (rng() - 0.5) * 1.25, dy * 0.75 + 0.28 + rng() * 0.3, dz + (rng() - 0.5) * 1.25).normalize();
    const d = _dir.clone();
    branch(pen, rng, ex, ey, ez, d.x, d.y, d.z, len * (0.62 + rng() * 0.2), r * 0.62, depth - 1);
  }
}

export function tree(c: Ctx, x: number, z: number, collide = true): void {
  const { pen, rng } = c;
  pen.identity().to('matte', z).worldUV(0, 0).ao(1, 1);
  // pit
  pen.color(0x2b251e).rectXZ(x - 0.5, z - 0.75, x + 0.5, z + 0.75, 0.004);
  pen.color(0x3a3a38);
  pen.boxMin(x - 0.56, 0, z - 0.81, 1.12, 0.05, 0.06);
  pen.boxMin(x - 0.56, 0, z + 0.75, 1.12, 0.05, 0.06);
  pen.boxMin(x - 0.56, 0, z - 0.75, 0.06, 0.05, 1.5);
  pen.boxMin(x + 0.5, 0, z - 0.75, 0.06, 0.05, 1.5);
  pen.color(0x1b1713);
  const lean = (rng() - 0.5) * 0.12;
  _tmp.set(lean, 1, (rng() - 0.5) * 0.1).normalize();
  branch(pen, rng, x, 0, z, _tmp.x, _tmp.y, _tmp.z, 2.5 + rng() * 0.6, 0.13, 4);
  if (collide) c.colliders.push(rect(x - 0.17, x + 0.17, z - 0.17, z + 0.17));
}

/* ------------------------------------------------------------ small props */

export function hydrant(c: Ctx, x: number, z: number): void {
  const { pen } = c;
  pen.identity().to('gloss', z).worldUV(0, 0).ao(0.8, 1);
  pen.color(0x16171a);
  pen.cyl(x, 0, z, 0.16, 0.16, 0.05, 10, 2);
  pen.cyl(x, 0.05, z, 0.11, 0.105, 0.5, 10, 0);
  pen.color(0x70757a).ao(1, 1);
  pen.cyl(x, 0.55, z, 0.125, 0.125, 0.05, 10, 3);
  pen.cyl(x, 0.6, z, 0.11, 0.04, 0.13, 10, 2);
  pen.cyl(x, 0.73, z, 0.03, 0.03, 0.05, 6, 2);
  pen.color(0x16171a);
  pen.tube(x - 0.19, 0.4, z, x + 0.19, 0.4, z, 0.05, 0.05, 8, 3);
  pen.tube(x, 0.36, z, x, 0.36, z + (x > 0 ? -0.2 : 0.2), 0.065, 0.065, 8, 3);
  c.colliders.push(rect(x - 0.2, x + 0.2, z - 0.2, z + 0.2));
}

let bagGeos: THREE.BufferGeometry[] | null = null;
function bagGeometries(rng: () => number): THREE.BufferGeometry[] {
  if (bagGeos) return bagGeos;
  bagGeos = [];
  for (let k = 0; k < 4; k++) {
    const g = new THREE.IcosahedronGeometry(1, 1);
    const p = g.getAttribute('position');
    // jitter by direction so duplicated vertices stay welded
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const n = Math.sin(x * 12.3 + k * 7.1) * Math.cos(y * 9.7 + k * 3.3) * Math.sin(z * 11.1 + k);
      const s = 1 + n * 0.16 + (y < -0.3 ? 0.12 : 0) - (y > 0.6 ? 0.14 : 0);
      p.setXYZ(i, x * s, Math.max(y * s, -0.62), z * s);
    }
    g.computeVertexNormals();
    bagGeos.push(g);
  }
  void rng;
  return bagGeos;
}

/** A heap of rubbish bags. Returns the collider it added. */
export function trashPile(c: Ctx, x: number, z: number, count: number, spreadX = 0.5, spreadZ = 1.0, collide = true): void {
  const { pen, rng } = c;
  const geos = bagGeometries(rng);
  pen.identity().to('gloss', z).worldUV(0, 0).ao(1, 1);
  for (let i = 0; i < count; i++) {
    const s = 0.3 + rng() * 0.14;
    const bx = x + (rng() - 0.5) * 2 * spreadX;
    const bz = z + (rng() - 0.5) * 2 * spreadZ;
    const up = i > 3 && rng() < 0.5 ? 0.3 + rng() * 0.12 : 0;
    const roll = rng();
    pen.color(roll < 0.78 ? 0x09090a : roll < 0.9 ? 0x6b6d6a : 0x1c2a3a);
    pen.push();
    pen.move(bx, s * 0.6 + up, bz).rot(0, rng() * 6.28, (rng() - 0.5) * 0.3).scale(s * 1.15, s, s * 1.05);
    pen.geom(geos[Math.floor(rng() * geos.length)]);
    pen.pop();
    // knot
    pen.cyl(bx, s * 1.45 + up, bz, 0.05, 0.02, 0.1, 5, 0);
  }
  // a damp stain around the heap
  pen.to('decal', z).color(0x000000);
  pen.rectXZ(x - spreadX - 0.7, z - spreadZ - 0.7, x + spreadX + 0.7, z + spreadZ + 0.7, 0.006, c.R.stain0);
  if (collide) c.colliders.push(rect(x - spreadX - 0.3, x + spreadX + 0.3, z - spreadZ - 0.3, z + spreadZ + 0.3));
}

export function mailbox(c: Ctx, x: number, z: number): void {
  const { pen } = c;
  pen.identity().to('gloss', z).worldUV(0, 0).ao(0.8, 1).color(0x1a2c4e);
  for (const [dx, dz] of [[-0.2, -0.22], [0.2, -0.22], [-0.2, 0.22], [0.2, 0.22]]) pen.boxMin(x + dx - 0.03, 0, z + dz - 0.03, 0.06, 0.2, 0.06);
  pen.boxMin(x - 0.26, 0.2, z - 0.28, 0.52, 0.82, 0.56, 'Y');
  pen.ao(1, 1);
  // rounded top: half cylinder across x
  pen.push();
  pen.move(x - 0.26, 1.02, z).rot(0, 0, -Math.PI / 2);
  pen.cyl(0, 0, 0, 0.28, 0.28, 0.52, 12, 3);
  pen.pop();
  pen.color(0x0f1a30).box(x - 0.265, 1.0, z, 0.02, 0.1, 0.36);
  c.colliders.push(rect(x - 0.3, x + 0.3, z - 0.32, z + 0.32));
}

let wheelGeo: THREE.BufferGeometry | null = null;

export function bikeRack(c: Ctx, x: number, z: number): void {
  const { pen } = c;
  pen.identity().to('gloss', z).worldUV(0, 0).ao(1, 1).color(0x2a2d30);
  // inverted-U rack
  pen.tube(x, 0, z - 0.3, x, 0.82, z - 0.3, 0.025, 0.025, 6);
  pen.tube(x, 0, z + 0.3, x, 0.82, z + 0.3, 0.025, 0.025, 6);
  pen.tube(x, 0.82, z - 0.3, x, 0.82, z + 0.3, 0.025, 0.025, 6);
  // bike leaning on it
  if (!wheelGeo) wheelGeo = new THREE.TorusGeometry(0.33, 0.02, 5, 16);
  pen.push();
  pen.move(x + 0.14, 0, z + 0.02).rot(0, 0, -0.13);
  for (const wz of [-0.52, 0.52]) {
    pen.push();
    pen.move(0, 0.35, wz).rot(0, Math.PI / 2, 0);
    pen.color(0x08080a).geom(wheelGeo);
    pen.pop();
  }
  pen.color(0x39424a);
  const t = (a: number[], b: number[], r = 0.016) => pen.tube(a[0], a[1], a[2], b[0], b[1], b[2], r, r, 5);
  const rear = [0, 0.35, 0.52], front = [0, 0.35, -0.52], bb = [0, 0.3, 0.1], seat = [0, 0.82, 0.22], head = [0, 0.8, -0.36];
  t(rear, bb);
  t(bb, seat);
  t(rear, seat, 0.012);
  t(seat, head);
  t(bb, head);
  t(head, front);
  t(head, [0, 0.96, -0.4]);
  pen.tube(-0.24, 0.96, -0.4, 0.24, 0.96, -0.4, 0.014, 0.014, 5);
  pen.color(0x0b0b0c).box(0, 0.9, 0.24, 0.12, 0.05, 0.24);
  t(seat, [0, 0.88, 0.24]);
  pen.pop();
  c.colliders.push(rect(x - 0.3, x + 0.42, z - 0.95, z + 0.95));
}

/** Thin post with a regulation sign near the curb. */
export function signPost(c: Ctx, x: number, z: number, region: string, w: number, h: number, faceZ: 1 | -1, y = 2.25): void {
  const { pen, R } = c;
  pen.identity().to('matte', z).worldUV(0, 0).ao(1, 1).color(0x34373a);
  pen.cyl(x, 0, z, 0.03, 0.03, y + h + 0.1, 6, 2);
  pen.color(0xb0b0b0);
  pen.rectXY(x - w / 2, y, x + w / 2, y + h, z + faceZ * 0.035, R[region], faceZ < 0);
  pen.color(0x2a2c2e);
  pen.rectXY(x - w / 2, y, x + w / 2, y + h, z - faceZ * 0.001 + faceZ * 0.03, undefined, faceZ > 0);
  c.colliders.push(rect(x - 0.1, x + 0.1, z - 0.1, z + 0.1));
}

/* -------------------------------------------------------- traffic signals */

export interface SignalHandle {
  /** glow ids: [red, yellow, green] cores, the halo, the road pool, the pedestrian lamp */
  cores: [number, number, number];
  halo: number;
  pool: number;
  ped: number;
  offset: number;
}

/**
 * Mast-arm signal at a corner. poleX/poleZ is the pole; the head hangs over the road at headX
 * and faces faceZ (toward the inside of the block).
 */
export function trafficSignal(c: Ctx, poleX: number, poleZ: number, headX: number, faceZ: 1 | -1, pedX: number, offset: number): SignalHandle {
  const { pen, R } = c;
  const z = poleZ;
  pen.identity().to('matte', z).worldUV(0, 0).ao(0.7, 1).color(0x24272a);
  pen.cyl(poleX, 0, z, 0.17, 0.14, 1.0, 8, 2);
  pen.ao(1, 1);
  pen.cyl(poleX, 1.0, z, 0.1, 0.08, 5.6, 8, 2);
  pen.tube(poleX, 6.2, z, headX, 6.45, z, 0.07, 0.05, 6, 2);
  pen.tube(poleX, 4.9, z, poleX + (headX - poleX) * 0.45, 6.33, z, 0.03, 0.03, 4);
  // street-name blades
  pen.color(0xb8b8b8);
  pen.rectXY(poleX - 0.55, 3.5, poleX + 0.55, 3.74, z + 0.12, R.sign_street0);
  pen.rectXY(poleX - 0.55, 3.5, poleX + 0.55, 3.74, z - 0.12, R.sign_street0, true);
  pen.rectZY(z - 0.55, 3.78, z + 0.55, 4.02, poleX + 0.12, 1, R.sign_street1);
  pen.rectZY(z - 0.55, 3.78, z + 0.55, 4.02, poleX - 0.12, -1, R.sign_street1);
  // head
  const hy = 5.75;
  pen.color(0x4a3c14);
  pen.box(headX, hy, z, 0.36, 1.08, 0.26);
  pen.tube(headX, hy + 0.54, z, headX, 6.42, z, 0.03, 0.03, 4);
  pen.color(0x0a0a0a);
  const fz = z + faceZ * 0.131;
  for (const dy of [0.34, 0, -0.34]) {
    pen.rectXY(headX - 0.12, hy + dy - 0.12, headX + 0.12, hy + dy + 0.12, fz, undefined, faceZ < 0);
    pen.box(headX, hy + dy + 0.14, z + faceZ * 0.22, 0.28, 0.02, 0.2);
  }
  const gz = z + faceZ * 0.14;
  const cores: [number, number, number] = [
    c.glow.billboard(headX, hy + 0.34, gz, 0.42, 0xff2a1a, 0, 0.02),
    c.glow.billboard(headX, hy, gz, 0.42, 0xffb020, 0, 0.02),
    c.glow.billboard(headX, hy - 0.34, gz, 0.42, 0x30ff9a, 0, 0.02),
  ];
  const halo = c.glow.billboard(headX, hy, gz + faceZ * 0.1, 3.2, 0xffffff, 0, 0.2);
  const pool = c.glow.flat(headX, ROAD_Y + 0.02, z + faceZ * 2.5, 13, 13, 0xffffff, 0);
  // pedestrian head on its own short post
  pen.to('matte', z).color(0x24272a);
  pen.cyl(pedX, 0, z, 0.06, 0.05, 2.9, 6, 2);
  pen.color(0x16171a).box(pedX, 2.65, z, 0.36, 0.4, 0.2);
  const ped = c.glow.billboard(pedX, 2.65, z + faceZ * 0.12, 0.34, 0xff7a1a, 0, 0.02);
  c.colliders.push(rect(poleX - 0.2, poleX + 0.2, z - 0.2, z + 0.2));
  if (Math.abs(pedX - poleX) > 0.3) c.colliders.push(rect(pedX - 0.1, pedX + 0.1, z - 0.1, z + 0.1));
  return { cores, halo, pool, ped, offset };
}
