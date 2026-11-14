/**
 * Tenement / brownstone fronts. A row is a list of lots along a straight
 * building line; each lot is drawn in a local frame where +X runs along the
 * facade, +Y is up and +Z points out of the wall toward the street.
 */

import * as THREE from 'three';
import type { Rect } from '../contracts';
import type { Pen, UVRect } from './geo';

export interface Lot {
  u0: number;
  w: number;
  /** storeys above the ground floor */
  floors: number;
  gh: number;
  fh: number;
  tint: number;
  trim: number;
  /** 0 plain coping, 1 bracketed cornice, 2 heavy cornice */
  cornice: 0 | 1 | 2;
  /** what the generator draws at street level ('none' = a landmark builder fills it in) */
  ground: 'door' | 'shutter' | 'plain' | 'none';
  /** stoop height; 0 = door at grade */
  raise: number;
  stoopDepth: number;
  fireEscape: boolean;
  /** probability that a window is lit */
  lit: number;
  lod: 0 | 1;
  entryLight?: boolean;
  /** atlas region for a shop sign band */
  sign?: string;
  signLit?: boolean;
  tower?: boolean;
  /** skip the side walls (corner buildings, whose flank is another lot's front) */
  noParty?: boolean;
  /** windows forced lit: [floor, column, variant] */
  forceLit?: Array<[number, number, number]>;
}

export interface RowEnv {
  pen: Pen;
  R: Record<string, UVRect>;
  rng: () => number;
  colliders: Rect[];
  /** Register a glow billboard at a world position. */
  glow(x: number, y: number, z: number, size: number, color: number, intensity: number): void;
}

export const lotHeight = (l: Lot): number => l.raise + l.gh + l.floors * l.fh + (l.cornice ? 0.95 : 0.6);

// soot-dulled brick: reds and browns pulled well toward grey, plus a few painted fronts
const BRICKS = [0x8c6557, 0x7d5a4e, 0x74574c, 0x93756a, 0x6a5a52, 0x9a8c72, 0x747478, 0x8e8a7e, 0x56615e, 0x7a554c, 0x66483f, 0x82695c];
const TRIMS = [0x8f8876, 0x756f62, 0x4a3b32, 0x5c5850, 0x6b6558];
const IRON = 0x15171a;

const _p = new THREE.Vector3();

/** Split a frontage into lots of plausible widths. */
export function subdivide(length: number, rng: () => number, min = 5.6, max = 8.6): number[] {
  const out: number[] = [];
  let left = length;
  while (left > max + min) {
    const w = min + rng() * (max - min);
    out.push(w);
    left -= w;
  }
  if (left > max) {
    out.push(left / 2, left / 2);
  } else {
    out.push(left);
  }
  return out;
}

export function randomLot(rng: () => number, u0: number, w: number, lod: 0 | 1, over: Partial<Lot> = {}): Lot {
  const floors = 3 + Math.floor(rng() * 2.6);
  const brownstone = rng() < 0.22;
  const lot: Lot = {
    u0,
    w,
    floors: brownstone ? Math.min(floors, 3) : floors,
    gh: 3.3 + rng() * 0.5,
    fh: 2.95 + rng() * 0.25,
    tint: brownstone ? 0x675248 : BRICKS[Math.floor(rng() * BRICKS.length)],
    trim: brownstone ? 0x54433a : TRIMS[Math.floor(rng() * TRIMS.length)],
    cornice: rng() < 0.2 ? 0 : rng() < 0.7 ? 1 : 2,
    ground: rng() < 0.2 ? 'shutter' : 'door',
    raise: 0,
    stoopDepth: 1.1,
    fireEscape: !brownstone && rng() < 0.6,
    lit: 0.04 + rng() * 0.13,
    lod,
    tower: rng() < 0.16,
  };
  return Object.assign(lot, over);
}

export interface Opening {
  c: number;
  hw: number;
  yb: number;
  yt: number;
}

export function strips(pen: Pen, u0: number, u1: number, y0: number, y1: number, ops: Opening[]): void {
  let prev = u0;
  for (const o of ops) {
    if (o.c - o.hw > prev + 1e-3) pen.rectXY(prev, y0, o.c - o.hw, y1, 0);
    if (o.yb > y0 + 1e-3) pen.rectXY(o.c - o.hw, y0, o.c + o.hw, o.yb, 0);
    if (o.yt < y1 - 1e-3) pen.rectXY(o.c - o.hw, o.yt, o.c + o.hw, y1, 0);
    prev = o.c + o.hw;
  }
  if (u1 > prev + 1e-3) pen.rectXY(prev, y0, u1, y1, 0);
}

export function reveals(pen: Pen, o: Opening, depth: number, bottom: boolean): void {
  pen.rectZY(-depth, o.yb, 0, o.yt, o.c - o.hw, 1);
  pen.rectZY(-depth, o.yb, 0, o.yt, o.c + o.hw, -1);
  pen.rectXZ(o.c - o.hw, -depth, o.c + o.hw, 0, o.yt, undefined, true);
  if (bottom) pen.rectXZ(o.c - o.hw, -depth, o.c + o.hw, 0, o.yb);
}

function fireEscape(pen: Pen, lot: Lot, base: number, ua: number, ub: number, lod: 0 | 1): void {
  pen.color(IRON).ao(1, 1).worldUV(0, 0);
  const d = 0.95;
  for (let f = 0; f < lot.floors; f++) {
    const y = base + f * lot.fh + 0.3;
    pen.boxMin(ua, y, 0.02, ub - ua, 0.05, d);
    // rails
    for (const ry of [0.5, 1.0]) {
      pen.boxMin(ua, y + ry, d - 0.01, ub - ua, 0.035, 0.035);
      pen.boxMin(ua, y + ry, 0.02, 0.035, 0.035, d);
      pen.boxMin(ub - 0.035, y + ry, 0.02, 0.035, 0.035, d);
    }
    if (lod === 0) {
      const n = Math.round((ub - ua) / 0.24);
      for (let i = 0; i <= n; i++) pen.boxMin(ua + ((ub - ua - 0.02) * i) / n, y, d, 0.02, 1.0, 0.02);
      for (let i = 1; i < 4; i++) {
        pen.boxMin(ua, y, 0.02 + (d * i) / 4, 0.02, 1.0, 0.02);
        pen.boxMin(ub - 0.02, y, 0.02 + (d * i) / 4, 0.02, 1.0, 0.02);
      }
      // brackets
      pen.tube(ua + 0.1, y, d - 0.05, ua + 0.1, y - 0.75, 0.03, 0.022, 0.022, 4);
      pen.tube(ub - 0.1, y, d - 0.05, ub - 0.1, y - 0.75, 0.03, 0.022, 0.022, 4);
    }
    // stair up to the next landing (alternating direction), or the drop ladder at the bottom
    if (f < lot.floors - 1) {
      const dir = f % 2 ? -1 : 1;
      const xs = dir > 0 ? ua + 0.5 : ub - 0.5;
      const xe = dir > 0 ? ub - 0.7 : ua + 0.7;
      for (const nz of [0.3, 0.72]) pen.tube(xs, y + 0.05, nz, xe, y + lot.fh + 0.02, nz, 0.028, 0.028, 4);
      if (lod === 0) {
        for (let s = 1; s < 9; s++) {
          const t = s / 9;
          pen.boxMin(xs + (xe - xs) * t - 0.11, y + 0.05 + lot.fh * t, 0.3, 0.22, 0.025, 0.42);
        }
      }
    }
    if (f === 0) {
      const lx = ub - 0.45;
      pen.boxMin(lx, y - 1.9, d - 0.12, 0.03, 2.9, 0.03);
      pen.boxMin(lx + 0.38, y - 1.9, d - 0.12, 0.03, 2.9, 0.03);
      if (lod === 0) for (let s = 0; s < 9; s++) pen.boxMin(lx, y - 1.8 + s * 0.3, d - 0.12, 0.4, 0.025, 0.025);
    }
  }
}

function waterTower(pen: Pen, u: number, y: number, n: number): void {
  pen.color(0x1d1a18).ao(1, 1).worldUV(0, 0);
  for (const [dx, dz] of [[-0.9, -0.9], [0.9, -0.9], [-0.9, 0.9], [0.9, 0.9]]) {
    pen.tube(u + dx, y, n + dz, u + dx * 0.9, y + 2.3, n + dz * 0.9, 0.06, 0.06, 4);
  }
  pen.box(u, y + 2.35, n, 2.3, 0.1, 2.3);
  pen.color(0x2c2520);
  pen.cyl(u, y + 2.4, n, 1.3, 1.3, 2.4, 10, 0);
  pen.color(0x221d19);
  pen.cyl(u, y + 4.8, n, 1.42, 0.05, 0.75, 10, 0);
}

function building(env: RowEnv, lot: Lot): void {
  const { pen, R, rng } = env;
  const { u0, w, lod } = lot;
  const u1 = u0 + w;
  const H = lotHeight(lot);
  const base = lot.raise + lot.gh;
  const nW = Math.max(2, Math.round((w - 0.7) / 1.9));
  const ww = Math.min(1.05, w / nW - 0.72);
  const hw = ww / 2;
  const centres: number[] = [];
  for (let i = 0; i < nW; i++) centres.push(u0 + (w * (i + 0.5)) / nW);
  const wh = lot.fh - 1.42;
  const sill = 0.78;
  const depth = 0.13;

  _p.set(u0 + w / 2, 0, 0).applyMatrix4(pen.m);
  const wz = _p.z;
  const brick = () => pen.to('brick', wz).worldUV(2.52, 2.4);
  const matte = () => pen.to('trim', wz).worldUV(0, 0).ao(1, 1);

  /* ---- openings ---- */
  const upper: Opening[][] = [];
  for (let f = 0; f < lot.floors; f++) {
    const yb = base + f * lot.fh + sill;
    upper.push(centres.map((c) => ({ c, hw, yb, yt: yb + wh })));
  }
  const ground: Opening[] = [];
  let door: Opening | null = null;
  const shutters: Opening[] = [];
  const gwins: Opening[] = [];
  if (lot.ground === 'door') {
    const dcol = rng() < 0.5 ? 0 : nW - 1;
    for (let i = 0; i < nW; i++) {
      const c = centres[i];
      if (i === dcol) {
        door = { c, hw: 0.6, yb: lot.raise, yt: lot.raise + 2.5 };
        ground.push(door);
      } else {
        const o = { c, hw, yb: lot.raise + 0.95, yt: lot.raise + 0.95 + Math.min(1.75, lot.gh - 1.5) };
        gwins.push(o);
        ground.push(o);
      }
    }
  } else if (lot.ground === 'shutter') {
    door = { c: u0 + 0.9, hw: 0.5, yb: 0, yt: 2.4 };
    ground.push(door);
    const sa = u0 + 1.75, sb = u1 - 0.45;
    const n = sb - sa > 4.2 ? 2 : 1;
    const each = (sb - sa - (n - 1) * 0.35) / n;
    for (let i = 0; i < n; i++) {
      const o = { c: sa + each / 2 + i * (each + 0.35), hw: each / 2, yb: 0, yt: 2.65 };
      shutters.push(o);
      ground.push(o);
    }
  }

  /* ---- brick ---- */
  brick().color(lot.tint);
  if (lod === 1) {
    pen.ao(0.8, 1).rectXY(u0, 0, u1, H, 0);
  } else {
    if (lot.ground !== 'none') {
      pen.ao(0.7, 1);
      strips(pen, u0, u1, 0, base, ground);
    }
    pen.ao(1, 1);
    for (let f = 0; f < lot.floors; f++) strips(pen, u0, u1, base + f * lot.fh, base + (f + 1) * lot.fh, upper[f]);
    pen.rectXY(u0, base + lot.floors * lot.fh, u1, H, 0);
    // reveals, a touch darker
    pen.color(lot.tint, 0.62);
    for (const row of upper) for (const o of row) reveals(pen, o, depth, false);
    for (const o of gwins) reveals(pen, o, depth, false);
    if (door) reveals(pen, door, 0.24, false);
    for (const o of shutters) reveals(pen, o, 0.1, false);
  }
  // party walls (seen above lower neighbours and down the alley)
  if (!lot.noParty) {
    pen.color(lot.tint, 0.5).ao(0.6, 1);
    pen.rectZY(-12, 0, 0, H, u0, -1);
    pen.rectZY(-12, 0, 0, H, u1, 1);
  }
  pen.ao(1, 1);

  /* ---- windows ---- */
  const winDepth = lod === 1 ? -0.012 : depth;
  for (let f = 0; f < lot.floors; f++) {
    upper[f].forEach((o, i) => {
      const forced = lot.forceLit?.find((e) => e[0] === f && e[1] === i);
      const lit = forced !== undefined || rng() < lot.lit;
      if (lit) {
        const pick = Math.floor(rng() * 7.12);
        const v = forced ? forced[2] : pick >= 7 ? 5 : [0, 1, 2, 3, 4, 6, 7][pick];
        const m = 0.5 + rng() * 0.75;
        pen.to('lit', wz).worldUV(0, 0).rgb(m, m, m);
        pen.rectXY(o.c - o.hw, o.yb, o.c + o.hw, o.yt, -winDepth, R['win_l' + v]);
      } else {
        pen.to('gloss', wz).worldUV(0, 0).color(0xffffff);
        pen.rectXY(o.c - o.hw, o.yb, o.c + o.hw, o.yt, -winDepth, R['win_d' + Math.floor(rng() * 6)]);
      }
    });
  }
  for (const o of gwins) {
    pen.to('gloss', wz).worldUV(0, 0).color(0xffffff);
    pen.rectXY(o.c - o.hw, o.yb, o.c + o.hw, o.yt, -winDepth, R['win_d' + (rng() < 0.5 ? 1 : 2)]);
  }

  /* ---- trim ---- */
  matte().color(lot.trim);
  const heavy = lot.cornice === 2;
  for (const row of upper) {
    for (const o of row) {
      if (lod === 0) {
        pen.boxMin(o.c - o.hw - 0.08, o.yb - 0.1, -0.02, ww + 0.16, 0.1, 0.13);
        pen.boxMin(o.c - o.hw - 0.1, o.yt, -0.01, ww + 0.2, heavy ? 0.3 : 0.2, heavy ? 0.1 : 0.05);
        if (heavy) pen.boxMin(o.c - o.hw - 0.16, o.yt + 0.3, -0.01, ww + 0.32, 0.07, 0.17);
      } else {
        pen.boxMin(o.c - o.hw - 0.08, o.yb - 0.1, 0, ww + 0.16, 0.1, 0.08, 'zxXy');
        pen.boxMin(o.c - o.hw - 0.1, o.yt, 0, ww + 0.2, 0.2, 0.04, 'zxXY');
      }
    }
  }
  if (lod === 0) {
    for (const o of gwins) {
      pen.boxMin(o.c - o.hw - 0.08, o.yb - 0.1, -0.02, ww + 0.16, 0.1, 0.13);
      pen.boxMin(o.c - o.hw - 0.1, o.yt, -0.01, ww + 0.2, 0.22, 0.06);
      // window bars
      pen.color(IRON);
      for (let k = 1; k < 5; k++) pen.boxMin(o.c - o.hw + (ww * k) / 5 - 0.012, o.yb, -0.05, 0.024, o.yt - o.yb, 0.024);
      pen.boxMin(o.c - o.hw, o.yb + 0.25, -0.05, ww, 0.024, 0.024);
      pen.boxMin(o.c - o.hw, o.yt - 0.3, -0.05, ww, 0.024, 0.024);
      pen.color(lot.trim);
    }
  }
  // band between ground floor and the storeys above
  if (lot.ground !== 'none') pen.boxMin(u0, base - 0.16, 0, w, 0.16, 0.07, 'z');

  // cornice / coping
  const dark = lot.cornice ? 0.55 : 0.8;
  pen.color(lot.trim, dark);
  if (lot.cornice === 0) {
    pen.boxMin(u0, H - 0.12, -0.3, w, 0.12, 0.38);
  } else {
    const out = heavy ? 0.52 : 0.38;
    pen.boxMin(u0 - 0.04, H - 0.5, -0.1, w + 0.08, 0.4, out + 0.1);
    pen.boxMin(u0, H - 0.1, -0.3, w, 0.1, out + 0.34);
    pen.boxMin(u0, H - 0.82, 0, w, 0.32, 0.13, 'z');
    if (lod === 0) {
      const n = Math.max(3, Math.round(w / 0.62));
      for (let i = 0; i <= n; i++) pen.boxMin(u0 + ((w - 0.1) * i) / n, H - 0.98, 0, 0.1, 0.48, out * 0.72, 'z');
    }
  }
  // roof
  pen.color(0x0c0d0e).rectXZ(u0, -12, u1, 0, H - 0.45);
  if (lot.tower) waterTower(pen, u0 + w / 2, H - 0.45, -5);

  /* ---- ground floor details ---- */
  if (door !== null) {
    const d: Opening = door;
    const doorRegion = lot.ground === 'shutter' ? R.door3 : R['door' + Math.floor(rng() * 3)];
    matte().color(0xffffff).ao(0.75, 1);
    pen.rectXY(d.c - d.hw, d.yb, d.c + d.hw, d.yt, lod === 1 ? 0.012 : -0.24, doorRegion);
    pen.ao(1, 1).color(lot.trim, 0.7);
    if (lod === 0) pen.rectXZ(d.c - d.hw, -0.24, d.c + d.hw, 0, d.yb + 0.004);
    if (lot.ground === 'door' && lod === 0) {
      pen.color(lot.trim);
      pen.boxMin(d.c - d.hw - 0.17, d.yb, 0, 0.17, d.yt - d.yb, 0.08, 'z');
      pen.boxMin(d.c + d.hw, d.yb, 0, 0.17, d.yt - d.yb, 0.08, 'z');
      pen.boxMin(d.c - d.hw - 0.3, d.yt, 0, d.hw * 2 + 0.6, 0.26, 0.24, 'z');
    }
    if (lot.entryLight) {
      pen.to('lit', wz).worldUV(0, 0).rgb(3.2, 2.2, 1.1);
      pen.box(d.c, d.yt + 0.52, 0.16, 0.16, 0.2, 0.16);
      matte().color(IRON);
      pen.box(d.c, d.yt + 0.64, 0.1, 0.06, 0.05, 0.2);
      _p.set(d.c, d.yt + 0.5, 0.2).applyMatrix4(pen.m);
      env.glow(_p.x, _p.y, _p.z, 1.5, 0xffb46a, 0.5);
    }
  }
  for (const o of shutters) {
    matte().color(0xffffff).ao(0.8, 1);
    pen.rectXY(o.c - o.hw, o.yb, o.c + o.hw, o.yt, lod === 1 ? 0.012 : -0.1, R['shutter' + (rng() < 0.5 ? 0 : 1)]);
  }
  pen.ao(1, 1);
  if (lot.ground === 'shutter') {
    const sa = u0 + 1.55, sb = u1 - 0.25;
    matte().color(0x1c1b1a);
    pen.boxMin(sa, 2.72, 0, sb - sa, 0.62, 0.1, 'z');
    if (lot.sign) {
      const sw = Math.min(sb - sa - 0.2, 5.6);
      if (lot.signLit) pen.to('lit', wz).worldUV(0, 0).rgb(0.5, 0.56, 0.6);
      else pen.color(0xffffff);
      pen.rectXY((sa + sb) / 2 - sw / 2, 2.78, (sa + sb) / 2 + sw / 2, 3.28, 0.105, R[lot.sign]);
    }
  }

  // plinth
  if (lot.ground !== 'none' && lod === 0) {
    matte().color(lot.trim, 0.72).ao(0.6, 1);
    const ph = Math.max(0.42, lot.raise);
    const cuts: Array<[number, number]> = [];
    if (door) {
      const d: Opening = door;
      const half = lot.raise > 0 ? d.hw + 0.5 : d.hw + 0.17;
      cuts.push([d.c - half, d.c + half]);
    }
    for (const o of shutters) cuts.push([o.c - o.hw, o.c + o.hw]);
    cuts.sort((a, b) => a[0] - b[0]);
    let prev = u0;
    for (const [a, b] of cuts) {
      if (a > prev + 0.05) pen.boxMin(prev, 0, 0, a - prev, ph, 0.05, 'zy');
      prev = b;
    }
    if (u1 > prev + 0.05) pen.boxMin(prev, 0, 0, u1 - prev, ph, 0.05, 'zy');
    pen.ao(1, 1);
  }

  // stoop
  if (lot.raise > 0 && door) {
    const d: Opening = door;
    const sw = d.hw * 2 + 0.5;
    const D = lot.stoopDepth;
    const n = Math.max(2, Math.round(lot.raise / 0.18));
    const rise = lot.raise / n;
    const run = (D - 0.24) / n;
    matte().color(lot.trim, 0.8).ao(0.7, 1);
    for (let i = 0; i < n; i++) pen.boxMin(d.c - sw / 2, 0, 0, sw, lot.raise - i * rise, 0.24 + (i + 1) * run, 'zy');
    pen.color(lot.trim, 0.9);
    for (const s of [-1, 1]) {
      const x = s < 0 ? d.c - sw / 2 - 0.2 : d.c + sw / 2;
      pen.boxMin(x, 0, 0, 0.2, lot.raise + 0.28, D * 0.5, 'zy');
      pen.boxMin(x, 0, D * 0.5, 0.2, lot.raise * 0.45 + 0.28, D * 0.5 - 0.2, 'zy');
      pen.boxMin(x - 0.03, 0, D - 0.24, 0.26, lot.raise * 0.45 + 0.6, 0.26, 'y');
      pen.color(IRON).ao(1, 1);
      pen.tube(x + 0.1, lot.raise + 1.15, 0.05, x + 0.1, lot.raise * 0.45 + 1.15, D - 0.12, 0.022, 0.022, 4);
      for (let k = 0; k < 4; k++) {
        const t = k / 3;
        const by = lot.raise * (1 - 0.55 * t) + 0.28;
        pen.boxMin(x + 0.09, by, 0.06 + t * (D - 0.26), 0.02, 0.87, 0.02);
      }
      pen.color(lot.trim, 0.9).ao(0.7, 1);
    }
    pen.ao(1, 1);
    // collider in world space
    const a = _p.set(d.c - sw / 2 - 0.2, 0, 0).applyMatrix4(pen.m).clone();
    const b = _p.set(d.c + sw / 2 + 0.2, 0, D).applyMatrix4(pen.m).clone();
    env.colliders.push({ minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minZ: Math.min(a.z, b.z), maxZ: Math.max(a.z, b.z) });
  }

  /* ---- fire escape, AC units ---- */
  if (lot.fireEscape && nW >= 2) {
    const fc = rng() < 0.5 ? 0 : nW - 2;
    matte();
    fireEscape(pen, lot, base, centres[fc] - hw - 0.35, centres[fc + 1] + hw + 0.35, lod);
  }
  if (lod === 0) {
    matte();
    for (const row of upper) {
      for (const o of row) {
        if (rng() < 0.09) {
          pen.color(0x6f7072).boxMin(o.c - 0.31, o.yb, -0.05, 0.62, 0.4, 0.45);
          pen.color(0x2a2b2c).boxMin(o.c - 0.27, o.yb + 0.05, 0.4, 0.54, 0.3, 0.01);
        }
      }
    }
  }
}

/** Draw a row of lots along a building line. rotY maps local +X (along the row) and +Z (out of the wall). */
export function buildRow(env: RowEnv, ox: number, oz: number, rotY: number, lots: Lot[]): void {
  env.pen.frame(ox, 0, oz, rotY);
  for (const lot of lots) building(env, lot);
  env.pen.identity().ao(1, 1).worldUV(0, 0);
}

/** Random lots filling [0, length]. */
export function randomRow(rng: () => number, length: number, lod: 0 | 1, over: Partial<Lot> = {}): Lot[] {
  const lots: Lot[] = [];
  let u = 0;
  for (const w of subdivide(length, rng)) {
    lots.push(randomLot(rng, u, w, lod, over));
    u += w;
  }
  return lots;
}
