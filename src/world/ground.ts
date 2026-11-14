/**
 * Road, sidewalks, curbs, paint, puddles and stains.
 */

import { BLOCK_FAR, BLOCK_NEAR, CROSS_ROAD, CROSS_WALK, LINE, ROAD_HALF, ROAD_Y, SUBWAY, type Ctx } from './layout';

const CUTS = [110, BLOCK_NEAR, -22, -52, -82, -112, BLOCK_FAR, -250];
const CURB_W = 0.22;
const SIDE = 64; // how far the cross streets run to each side
const GRANITE = 0x8a8880;

/** Call fn for each piece of [zHi, zLo] split at the chunk boundaries. */
function alongZ(zHi: number, zLo: number, fn: (za: number, zb: number) => void): void {
  for (let i = 0; i < CUTS.length - 1; i++) {
    const a = Math.min(zHi, CUTS[i]), b = Math.max(zLo, CUTS[i + 1]);
    if (a > b + 1e-6) fn(a, b);
  }
}

export function ground(c: Ctx): void {
  const { pen, R, rng } = c;
  pen.identity().ao(1, 1);

  const nearRoad = BLOCK_NEAR + CROSS_ROAD; // 17
  const farRoad = BLOCK_FAR - CROSS_ROAD; // -149
  const nearLine = nearRoad + CROSS_WALK; // 21
  const farLine = farRoad - CROSS_WALK; // -153

  /* ---- asphalt ---- */
  const road = (x0: number, x1: number, zHi: number, zLo: number) =>
    alongZ(zHi, zLo, (za, zb) => {
      pen.to('asphalt', (za + zb) / 2).worldUV(8, 8).color(0xffffff);
      pen.rectXZ(x0, zb, x1, za, ROAD_Y);
    });
  road(-ROAD_HALF, ROAD_HALF, 110, -250);
  road(ROAD_HALF, SIDE, nearRoad, BLOCK_NEAR);
  road(-SIDE, -ROAD_HALF, nearRoad, BLOCK_NEAR);
  road(ROAD_HALF, SIDE, BLOCK_FAR, farRoad);
  road(-SIDE, -ROAD_HALF, BLOCK_FAR, farRoad);

  /* ---- sidewalks ---- */
  const slab = (x0: number, x1: number, zHi: number, zLo: number, tint = 0xffffff) =>
    alongZ(zHi, zLo, (za, zb) => {
      pen.to('sidewalk', (za + zb) / 2).worldUV(2.5, 2.5).color(tint);
      pen.rectXZ(x0, zb, x1, za, 0);
    });
  /** Curb along Z at x; `face` is the side the road is on. */
  const curbX = (x: number, zHi: number, zLo: number, face: 1 | -1) =>
    alongZ(zHi, zLo, (za, zb) => {
      pen.to('matte', (za + zb) / 2).worldUV(0, 0).color(GRANITE);
      pen.rectXZ(Math.min(x, x - face * CURB_W), zb, Math.max(x, x - face * CURB_W), za, 0);
      pen.color(GRANITE, 0.7).rectZY(zb, ROAD_Y, za, 0, x, face);
    });
  /** Curb along X at z. */
  const curbZ = (z: number, x0: number, x1: number, face: 1 | -1) => {
    pen.to('matte', z).worldUV(0, 0).color(GRANITE);
    pen.rectXZ(x0, Math.min(z, z - face * CURB_W), x1, Math.max(z, z - face * CURB_W), 0);
    pen.color(GRANITE, 0.7).rectXY(x0, ROAD_Y, x1, 0, z, undefined, face < 0);
  };

  const in0 = ROAD_HALF + CURB_W; // inner edge of the slabs
  const zN = BLOCK_NEAR - CURB_W, zF = BLOCK_FAR + CURB_W;
  for (const s of [1, -1] as const) {
    const xa = s > 0 ? in0 : -LINE, xb = s > 0 ? LINE : -in0;
    if (s > 0) {
      // right-hand strip, with the subway stairwell cut out
      slab(xa, xb, zN, SUBWAY.z1);
      slab(xa, SUBWAY.x0, SUBWAY.z1, SUBWAY.z0);
      slab(SUBWAY.x1, xb, SUBWAY.z1, SUBWAY.z0);
      slab(xa, xb, SUBWAY.z0, zF);
    } else {
      slab(xa, xb, zN, zF);
    }
    curbX(s * ROAD_HALF, BLOCK_NEAR, BLOCK_FAR, -s as 1 | -1);
    // corner pads: the cross streets' near sidewalks
    const pa = s > 0 ? LINE : -SIDE, pb = s > 0 ? SIDE : -LINE;
    slab(pa, pb, zN, 4);
    slab(pa, pb, -136, zF);
    const ca = s > 0 ? ROAD_HALF : -SIDE, cb = s > 0 ? SIDE : -ROAD_HALF;
    curbZ(BLOCK_NEAR, ca, cb, 1);
    curbZ(BLOCK_FAR, ca, cb, -1);
    // far side of each cross street and the next blocks beyond
    slab(ca + (s > 0 ? CURB_W : 0), cb - (s > 0 ? 0 : CURB_W), nearLine, nearRoad + CURB_W);
    slab(ca + (s > 0 ? CURB_W : 0), cb - (s > 0 ? 0 : CURB_W), farRoad - CURB_W, farLine);
    curbZ(nearRoad, ca, cb, -1);
    curbZ(farRoad, ca, cb, 1);
    slab(xa, xb, 110, nearLine);
    slab(xa, xb, farLine, -250);
    curbX(s * ROAD_HALF, 110, nearRoad, -s as 1 | -1);
    curbX(s * ROAD_HALF, farRoad, -250, -s as 1 | -1);
  }

  /* ---- paint and ironwork on the road ---- */
  const py = ROAD_Y + 0.006;
  const bars = (z0: number, z1: number) => {
    pen.to('decal', (z0 + z1) / 2).worldUV(0, 0).color(0xd8d8d0);
    for (let x = -3.95; x < 4.2; x += 0.88) pen.rectXZ(x - 0.25, z0, x + 0.25, z1, py, R.xwalk);
  };
  bars(4.7, 7.7);
  bars(-139.7, -136.7);
  const barsAcross = (xa: number, xb: number, zHi: number, zLo: number) => {
    pen.to('decal', (zHi + zLo) / 2).worldUV(0, 0).color(0xd8d8d0);
    for (let z = zHi - 0.6; z > zLo + 0.3; z -= 0.88) {
      pen.quad(xa, py, z - 0.25, xa, py, z + 0.25, xb, py, z + 0.25, xb, py, z - 0.25, R.xwalk);
    }
  };
  for (const s of [1, -1]) {
    barsAcross(s > 0 ? 5.0 : -8.0, s > 0 ? 8.0 : -5.0, nearRoad, BLOCK_NEAR);
    barsAcross(s > 0 ? 5.0 : -8.0, s > 0 ? 8.0 : -5.0, BLOCK_FAR, farRoad);
  }
  for (const [x, z] of [[0.7, -12], [-0.8, -64], [0.4, -98], [1.1, -124], [-0.5, 30], [0.6, -165]]) {
    pen.to('decal', z).color(0xffffff).rectXZ(x - 0.42, z - 0.42, x + 0.42, z + 0.42, py + 0.002, R.manhole);
  }
  // oil and damp
  for (let k = 0; k < 46; k++) {
    const z = 6 - rng() * 144;
    const onRoad = rng() < 0.55;
    const x = onRoad ? (rng() - 0.5) * 8.4 : (rng() < 0.5 ? 1 : -1) * (4.9 + rng() * 3.3);
    const sx = 0.8 + rng() * 2.2, sz = 0.8 + rng() * 2.6;
    pen.to('decal', z).color(0x000000);
    pen.rectXZ(x - sx, z - sz, x + sx, z + sz, (onRoad ? ROAD_Y : 0) + 0.0055, R[rng() < 0.5 ? 'stain0' : 'stain1']);
  }

  /* ---- standing water ---- */
  const puddle = (x: number, z: number, rx: number, rz: number, y: number) => {
    const pts: Array<[number, number]> = [];
    const n = 18;
    const p1 = rng() * 6.28, p2 = rng() * 6.28, a2 = 0.1 + rng() * 0.12, a3 = 0.05 + rng() * 0.08;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const k = 0.85 + a2 * Math.sin(a * 2 + p1) + a3 * Math.sin(a * 3 + p2);
      pts.push([x + Math.cos(a) * rx * k, z + Math.sin(a) * rz * k]);
    }
    pen.to('puddle', z).worldUV(0, 0).color(0xffffff).fanXZ(pts, y);
  };
  // gutters
  for (const s of [1, -1]) {
    let z = 2;
    while (z > -136) {
      const len = 2 + rng() * 5;
      if (rng() < 0.62) puddle(s * (ROAD_HALF - 0.32), z - len / 2, 0.3, len / 2, ROAD_Y + 0.004);
      z -= len + rng() * 3;
    }
  }
  for (let k = 0; k < 12; k++) puddle((rng() - 0.5) * 4.6, 2 - rng() * 138, 0.5 + rng() * 0.9, 0.7 + rng() * 1.6, ROAD_Y + 0.004);
  const fixed: Array<[number, number, number, number]> = [
    [6.9, -3.6, 0.6, 0.9],
    [6.3, -15.5, 0.55, 0.8],
    [7.4, -26.5, 0.5, 0.7],
    [6.4, -44.2, 0.7, 1.2],
    [5.6, -55.5, 0.5, 0.9],
    [6.2, -76.2, 0.6, 0.8],
    [5.5, -79.6, 0.5, 1.0],
    [7.0, -93.5, 0.6, 0.9],
    [6.0, -113, 0.7, 1.0],
    [5.6, -125.6, 0.55, 0.9],
    [-6.6, -22, 0.7, 1.1],
    [-6.0, -61, 0.6, 1.0],
    [-7.0, -90, 0.6, 0.9],
    [-6.2, -118, 0.7, 1.2],
  ];
  for (const [x, z, rx, rz] of fixed) puddle(x, z, rx, rz, 0.004);
}
