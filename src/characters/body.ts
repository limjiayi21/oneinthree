/**
 * Skeleton + skinned body mesh (torso, clothes, limbs, hands, shoes, bag).
 *
 * Everything is built in the bind pose: standing, arms straight down, every
 * bone with identity rotation, so a bone's local axes equal the character's
 * axes (X = character's left, Y = up, Z = forward). The whole body is ONE
 * skinned mesh with vertex colours, i.e. one draw call.
 */
import * as THREE from 'three';
import type { HumanOptions } from '../contracts';
import { GeoBuilder, loft, box, ellipsoid, tubePath, type BW, type Ring, type V3 } from './geo';
import { lerp, smoothstep, clamp } from './util';

export const B = {
  hips: 0,
  spine: 1,
  chest: 2,
  neck: 3,
  head: 4,
  clavL: 5,
  upperArmL: 6,
  foreArmL: 7,
  handL: 8,
  fingL1: 9,
  fingL2: 10,
  indexL1: 11,
  indexL2: 12,
  thumbL1: 13,
  thumbL2: 14,
  clavR: 15,
  upperArmR: 16,
  foreArmR: 17,
  handR: 18,
  fingR1: 19,
  fingR2: 20,
  indexR1: 21,
  indexR2: 22,
  thumbR1: 23,
  thumbR2: 24,
  upperLegL: 25,
  lowerLegL: 26,
  footL: 27,
  toeL: 28,
  upperLegR: 29,
  lowerLegR: 30,
  footR: 31,
  toeR: 32,
  bag: 33,
} as const;
export const BONE_COUNT = 34;

export interface Dims {
  man: boolean;
  /** Total height, metres. */
  H: number;
  /** H / 1.85: every "reference man" length is multiplied by this. */
  K: number;
  headScale: number;
  hips: THREE.Vector3;
  spine: THREE.Vector3;
  chest: THREE.Vector3;
  neck: THREE.Vector3;
  head: THREE.Vector3;
  /** Left side; mirror x for the right. */
  clav: THREE.Vector3;
  shoulder: THREE.Vector3;
  upperArm: number;
  foreArm: number;
  hand: number;
  hip: THREE.Vector3;
  thigh: number;
  shin: number;
  ankleH: number;
  ballZ: number;
  heelZ: number;
  bagPivot: THREE.Vector3;
  /** Which side carries the tote (+1 = character's left). */
  bagSide: 1 | -1;
}

export function computeDims(opts: HumanOptions): Dims {
  const man = opts.build === 'man';
  const H = opts.height ?? (man ? 1.85 : 1.66);
  const K = H / 1.85;
  const headScale = K * (man ? 1.08 : 1.1);
  const shoulderX = (man ? 0.105 : 0.094) * H;
  const hipX = (man ? 0.05 : 0.052) * H;
  const ankleH = 0.0486 * H;
  const leg = 0.24 * H;
  return {
    man,
    H,
    K,
    headScale,
    hips: new THREE.Vector3(0, 0.545 * H, 0),
    spine: new THREE.Vector3(0, 0.6 * H, -0.008 * K),
    chest: new THREE.Vector3(0, 0.7 * H, -0.012 * K),
    neck: new THREE.Vector3(0, 0.845 * H, -0.022 * K),
    head: new THREE.Vector3(0, H - 0.15 * headScale, -0.004 * K),
    clav: new THREE.Vector3(0.02 * K, 0.79 * H, 0.03 * K),
    shoulder: new THREE.Vector3(shoulderX, 0.8 * H, -0.012 * K),
    upperArm: 0.172 * H,
    foreArm: 0.146 * H,
    hand: 0.105 * H,
    hip: new THREE.Vector3(hipX, ankleH + 2 * leg, 0),
    thigh: leg,
    shin: leg,
    ankleH,
    ballZ: 0.135 * K,
    heelZ: -0.07 * K,
    bagPivot: new THREE.Vector3(shoulderX * 0.78, 0.8 * H + 0.062 * K, -0.012 * K),
    bagSide: 1,
  };
}

/** [yFrac, rx, rz, centreZ] of the bare torso at reference scale. */
const TORSO_MAN: ReadonlyArray<readonly [number, number, number, number]> = [
  [0.4703, 0.1, 0.078, -0.008],
  [0.4892, 0.158, 0.1, -0.008],
  [0.5189, 0.17, 0.113, -0.01],
  [0.5568, 0.164, 0.11, -0.004],
  [0.5892, 0.156, 0.104, 0.0],
  [0.627, 0.156, 0.104, 0.002],
  [0.6757, 0.166, 0.11, 0.004],
  [0.7243, 0.184, 0.122, 0.006],
  [0.7676, 0.196, 0.128, 0.006],
  [0.8, 0.2, 0.116, 0.0],
  [0.8216, 0.196, 0.1, -0.008],
  [0.8368, 0.134, 0.08, -0.014],
  [0.8486, 0.066, 0.062, -0.018],
];
const TORSO_WOMAN: ReadonlyArray<readonly [number, number, number, number]> = [
  [0.4703, 0.1, 0.08, -0.008],
  [0.4892, 0.168, 0.108, -0.01],
  [0.5189, 0.186, 0.126, -0.013],
  [0.5568, 0.168, 0.112, -0.004],
  [0.5892, 0.143, 0.098, 0.0],
  [0.627, 0.136, 0.095, 0.002],
  [0.6757, 0.145, 0.105, 0.006],
  [0.7243, 0.156, 0.119, 0.013],
  [0.7676, 0.163, 0.112, 0.006],
  [0.8, 0.168, 0.1, 0.0],
  [0.8216, 0.163, 0.088, -0.006],
  [0.8368, 0.11, 0.07, -0.012],
  [0.8486, 0.058, 0.056, -0.016],
];

export interface BodyColors {
  skin: THREE.Color;
  top: THREE.Color;
  inner: THREE.Color;
  bottom: THREE.Color;
  shoes: THREE.Color;
  sole: THREE.Color;
  bag: THREE.Color;
  strap: THREE.Color;
  hair: THREE.Color;
}

export interface BodyBuild {
  bones: THREE.Bone[];
  geometry: THREE.BufferGeometry;
}

const shade = (c: THREE.Color, f: number): THREE.Color => c.clone().multiplyScalar(f);

export function buildSkeleton(d: Dims): THREE.Bone[] {
  const bones: THREE.Bone[] = [];
  const world: THREE.Vector3[] = [];
  const add = (index: number, name: string, parent: number, p: THREE.Vector3): void => {
    const bone = new THREE.Bone();
    bone.name = name;
    bones[index] = bone;
    world[index] = p.clone();
    if (parent >= 0) {
      bone.position.copy(p).sub(world[parent]);
      bones[parent].add(bone);
    } else {
      bone.position.copy(p);
    }
  };
  const K = d.K;
  add(B.hips, 'hips', -1, d.hips);
  add(B.spine, 'spine', B.hips, d.spine);
  add(B.chest, 'chest', B.spine, d.chest);
  add(B.neck, 'neck', B.chest, d.neck);
  add(B.head, 'head', B.neck, d.head);
  for (const side of [1, -1] as const) {
    const o = side === 1 ? 0 : 10;
    const tag = side === 1 ? 'L' : 'R';
    const m = (v: THREE.Vector3): THREE.Vector3 => new THREE.Vector3(v.x * side, v.y, v.z);
    const sh = m(d.shoulder);
    const el = sh.clone().add(new THREE.Vector3(0, -d.upperArm, 0));
    const wr = el.clone().add(new THREE.Vector3(0, -d.foreArm, 0));
    add(B.clavL + o, 'clav' + tag, B.chest, m(d.clav));
    add(B.upperArmL + o, 'upperArm' + tag, B.clavL + o, sh);
    add(B.foreArmL + o, 'foreArm' + tag, B.upperArmL + o, el);
    add(B.handL + o, 'hand' + tag, B.foreArmL + o, wr);
    add(B.fingL1 + o, 'fing1' + tag, B.handL + o, new THREE.Vector3(wr.x, wr.y - 0.098 * K, wr.z - 0.008 * K));
    add(B.fingL2 + o, 'fing2' + tag, B.fingL1 + o, new THREE.Vector3(wr.x, wr.y - 0.14 * K, wr.z - 0.008 * K));
    add(B.indexL1 + o, 'index1' + tag, B.handL + o, new THREE.Vector3(wr.x, wr.y - 0.098 * K, wr.z + 0.03 * K));
    add(B.indexL2 + o, 'index2' + tag, B.indexL1 + o, new THREE.Vector3(wr.x, wr.y - 0.138 * K, wr.z + 0.03 * K));
    const t1 = new THREE.Vector3(wr.x - side * 0.004 * K, wr.y - 0.03 * K, wr.z + 0.03 * K);
    const td = thumbDir(side);
    add(B.thumbL1 + o, 'thumb1' + tag, B.handL + o, t1);
    add(B.thumbL2 + o, 'thumb2' + tag, B.thumbL1 + o, t1.clone().addScaledVector(td, 0.038 * K));
  }
  for (const side of [1, -1] as const) {
    const o = side === 1 ? 0 : 4;
    const tag = side === 1 ? 'L' : 'R';
    const hip = new THREE.Vector3(d.hip.x * side, d.hip.y, d.hip.z);
    const knee = hip.clone().add(new THREE.Vector3(0, -d.thigh, 0));
    const ankle = knee.clone().add(new THREE.Vector3(0, -d.shin, 0));
    add(B.upperLegL + o, 'upperLeg' + tag, B.hips, hip);
    add(B.lowerLegL + o, 'lowerLeg' + tag, B.upperLegL + o, knee);
    add(B.footL + o, 'foot' + tag, B.lowerLegL + o, ankle);
    add(B.toeL + o, 'toe' + tag, B.footL + o, new THREE.Vector3(ankle.x, 0.022 * K, d.ballZ));
  }
  add(B.bag, 'bag', B.chest, new THREE.Vector3(d.bagPivot.x * d.bagSide, d.bagPivot.y, d.bagPivot.z));
  return bones;
}

export function thumbDir(side: number): THREE.Vector3 {
  return new THREE.Vector3(-0.3 * side, -0.62, 0.72).normalize();
}

export function buildBody(opts: HumanOptions, d: Dims, col: BodyColors): THREE.BufferGeometry {
  const b = new GeoBuilder(true);
  const { K, H, man } = d;
  const style = opts.topStyle ?? (man ? 'hoodie' : 'coat');
  const table = man ? TORSO_MAN : TORSO_WOMAN;
  const armG = man ? 1.07 : 0.8;
  const neckR = (man ? 0.06 : 0.047) * K;

  const torsoAt = (yf: number): { rx: number; rz: number; cz: number } => {
    const t = table;
    if (yf <= t[0][0]) return { rx: t[0][1] * K, rz: t[0][2] * K, cz: t[0][3] * K };
    for (let i = 1; i < t.length; i++) {
      if (yf <= t[i][0]) {
        const f = (yf - t[i - 1][0]) / (t[i][0] - t[i - 1][0]);
        return {
          rx: lerp(t[i - 1][1], t[i][1], f) * K,
          rz: lerp(t[i - 1][2], t[i][2], f) * K,
          cz: lerp(t[i - 1][3], t[i][3], f) * K,
        };
      }
    }
    const l = t[t.length - 1];
    return { rx: l[1] * K, rz: l[2] * K, cz: l[3] * K };
  };

  /** Skin weights for anything wrapped round the trunk. */
  const torsoW = (x: number, y: number, _z: number): BW => {
    const yf = y / H;
    const t1 = smoothstep(0.53, 0.605, yf);
    const t2 = smoothstep(0.638, 0.724, yf);
    const cl = smoothstep(0.045 * H, 0.092 * H, Math.abs(x)) * smoothstep(0.765, 0.8, yf) * 0.65;
    const wc = t1 * t2;
    return [
      [B.hips, 1 - t1],
      [B.spine, t1 * (1 - t2)],
      [B.chest, wc * (1 - cl)],
      [x >= 0 ? B.clavL : B.clavR, wc * cl],
    ];
  };

  const nTorso = (yf: number): number => lerp(2.7, 2.0, smoothstep(0.795, 0.85, yf));

  const torsoRing = (yf: number, ease: number, c: Ring['col'], boxy = 0, w: Ring['w'] = torsoW, dz = 0): Ring => {
    const t = torsoAt(yf);
    let rx = t.rx;
    let rz = t.rz;
    if (boxy > 0 && yf < 0.77) {
      const ch = torsoAt(0.7676);
      rx = Math.max(rx, ch.rx * boxy);
      rz = Math.max(rz, ch.rz * boxy * 0.96);
    }
    return { c: [0, yf * H, t.cz + dz], rx: rx + ease, rz: rz + ease, col: c, w, n: nTorso(yf) };
  };

  /* ---------------------------------------------------------------- pelvis */
  {
    const c = col.bottom;
    const ys = [0.4703, 0.4892, 0.5189, 0.5568, 0.5892, 0.612];
    const rings = ys.map((yf) => torsoRing(yf, yf > 0.53 ? -0.006 * K : 0.003 * K, c));
    loft(b, rings, { segs: 16, capStart: true, capEnd: true });
  }

  /* ------------------------------------------------------------------ legs */
  for (const side of [1, -1] as const) {
    const o = side === 1 ? 0 : 4;
    const up = B.upperLegL + o;
    const lo = B.lowerLegL + o;
    const x = d.hip.x * side;
    const lg = man ? 1 : 0.88; // lower-leg girth
    const tg = man ? 1 : 0.97; // thigh girth
    const kneeY = d.hip.y - d.thigh;
    const c = col.bottom;
    // [y, rx, rz, cz, weights]
    const rows: Array<[number, number, number, number, BW]> = [
      [0.99 * K, 0.086 * tg, 0.1 * tg, -0.002, [[B.hips, 0.7], [up, 0.3]]],
      [0.93 * K, 0.091 * tg, 0.106 * tg, -0.002, [[B.hips, 0.4], [up, 0.6]]],
      [0.86 * K, 0.088 * tg, 0.1 * tg, -0.002, [[up, 1]]],
      [0.76 * K, 0.08 * tg, 0.088 * tg, 0, [[up, 1]]],
      [0.64 * K, 0.07 * lg, 0.075 * lg, 0, [[up, 1]]],
      [kneeY + 0.05 * K, 0.064 * lg, 0.069 * lg, 0.002, [[up, 0.8], [lo, 0.2]]],
      [kneeY, 0.062 * lg, 0.067 * lg, 0.003, [[up, 0.5], [lo, 0.5]]],
      [kneeY - 0.045 * K, 0.06 * lg, 0.065 * lg, 0, [[up, 0.2], [lo, 0.8]]],
      [0.42 * K, 0.061 * lg, 0.067 * lg, -0.007, [[lo, 1]]],
      [0.3 * K, 0.054 * lg, 0.058 * lg, -0.004, [[lo, 1]]],
      [0.18 * K, 0.05 * lg, 0.053 * lg, 0, [[lo, 1]]],
      [0.108 * K, 0.052 * lg, 0.057 * lg, 0.002, [[lo, 1]]],
      [0.104 * K, 0.036 * lg, 0.04 * lg, 0.002, [[lo, 1]]],
    ];
    const rings: Ring[] = rows.map(([y, rx, rz, cz, w], i) => ({
      c: [x, y, cz * K],
      rx: rx * K,
      rz: rz * K,
      col: i >= rows.length - 2 ? shade(c, 0.8) : c,
      w,
    }));
    loft(b, rings, { segs: 10, capStart: true, capEnd: true });

    /* shoe */
    const foot = B.footL + o;
    const toe = B.toeL + o;
    const fs = man ? 1 : 0.9;
    const shoe: Array<[number, number, number, number]> = [
      // z, half-width, y0, y1
      [-0.082, 0.02, 0.014, 0.06],
      [-0.07, 0.034, 0.012, 0.086],
      [-0.035, 0.043, 0.012, 0.114],
      [0.01, 0.046, 0.012, 0.114],
      [0.045, 0.047, 0.012, 0.096],
      [0.09, 0.049, 0.012, 0.07],
      [0.135, 0.051, 0.012, 0.054],
      [0.18, 0.046, 0.012, 0.045],
      [0.208, 0.034, 0.012, 0.037],
      [0.22, 0.016, 0.014, 0.03],
    ];
    const fw = (z: number): BW => {
      const t = smoothstep(0.1, 0.17, z / (K * fs));
      return [
        [foot, 1 - t],
        [toe, t],
      ];
    };
    const upper: Ring[] = shoe.map(([z, hw, y0, y1]) => ({
      c: [x, ((y0 + y1) / 2) * K * fs, z * K * fs],
      rx: hw * K * fs,
      rz: ((y1 - y0) / 2) * K * fs,
      u: [1, 0, 0],
      v: [0, 1, 0],
      col: col.shoes,
      w: fw(z * K * fs),
      n: 3,
    }));
    loft(b, upper, { segs: 10, capStart: true, capEnd: true });
    const sole: Ring[] = shoe.map(([z, hw]) => ({
      c: [x, 0.011 * K, z * K * fs * 1.01],
      rx: (hw + 0.004) * K * fs,
      rz: 0.011 * K,
      u: [1, 0, 0],
      v: [0, 1, 0],
      col: col.sole,
      w: fw(z * K * fs),
      n: 4,
    }));
    loft(b, sole, { segs: 10, capStart: true, capEnd: true });
  }

  /* ----------------------------------------------------------------- torso */
  const TORSO_YS = [0.5189, 0.5568, 0.5892, 0.627, 0.6757, 0.7243, 0.7676, 0.8, 0.8216, 0.8368];
  const neckZ = torsoAt(0.8486).cz;

  /** Closed garment tube from a hem up to a collar round the neck. */
  const garment = (ease: number, hemF: number, c: THREE.Color, boxy: number, collar: 'crew' | 'thick'): void => {
    const rings: Ring[] = [];
    const dark = shade(c, 0.72);
    rings.push(torsoRing(hemF + 0.004, -0.004 * K, dark, boxy));
    rings.push(torsoRing(hemF, ease * 0.8, dark, boxy));
    rings.push(torsoRing(hemF + 0.016, ease, c, boxy));
    for (const yf of TORSO_YS) if (yf > hemF + 0.03) rings.push(torsoRing(yf, ease, c, boxy));
    if (collar === 'crew') {
      rings.push({ c: [0, 0.8486 * H, neckZ], rx: neckR + 0.016 * K, rz: neckR + 0.014 * K, col: c, w: torsoW });
      rings.push({ c: [0, 0.8486 * H + 0.006 * K, neckZ], rx: neckR + 0.01 * K, rz: neckR + 0.009 * K, col: dark, w: torsoW });
      rings.push({ c: [0, 0.8486 * H + 0.003 * K, neckZ], rx: neckR - 0.004 * K, rz: neckR - 0.004 * K, col: dark, w: torsoW });
    } else {
      rings.push({ c: [0, 0.8486 * H, neckZ], rx: neckR + 0.03 * K, rz: neckR + 0.028 * K, col: c, w: torsoW });
      rings.push({ c: [0, 0.8486 * H + 0.022 * K, neckZ], rx: neckR + 0.022 * K, rz: neckR + 0.02 * K, col: c, w: torsoW });
      rings.push({ c: [0, 0.8486 * H + 0.02 * K, neckZ], rx: neckR - 0.004 * K, rz: neckR - 0.004 * K, col: dark, w: torsoW });
    }
    loft(b, rings, { segs: 16 });
  };

  /** Open-fronted shell (jacket, coat). `gap` is the half-opening angle per height fraction. */
  const shell = (ease: number, hemF: number, c: THREE.Color, collarH: number, gapAt: (yf: number) => number, flare: number): void => {
    const dark = shade(c, 0.7);
    const legW = (x: number, y: number, z: number): BW => {
      const yf = y / H;
      if (yf > 0.52) return torsoW(x, y, z);
      const t = 0.62 * smoothstep(0.5, 0.36, yf);
      const s = 0.5 + 0.5 * clamp(x / (0.05 * K), -1, 1);
      return [
        [B.hips, 1 - t],
        [B.upperLegL, t * s],
        [B.upperLegR, t * (1 - s)],
      ];
    };
    const ys: number[] = [];
    if (hemF < 0.5) {
      for (let yf = hemF; yf < 0.5; yf += 0.045) ys.push(yf);
    } else ys.push(hemF);
    for (const yf of TORSO_YS) if (yf > ys[ys.length - 1] + 0.02) ys.push(yf);
    const hipR = torsoAt(0.5189);
    type GapRing = Ring & { gap: number };
    const ringAt = (yf: number, e: number, cc: THREE.Color): GapRing => {
      if (yf < 0.5189) {
        const fl = flare * (0.5189 - yf) * H;
        return { c: [0, yf * H, hipR.cz], rx: hipR.rx + e + fl, rz: hipR.rz + e + fl, col: cc, w: legW, n: 2.6, gap: gapAt(yf) };
      }
      return { ...torsoRing(yf, e, cc, 0, legW), gap: gapAt(yf) };
    };
    // Each ring has its own opening angle, so emit vertices by hand rather than through loft().
    const segs = 18;
    const rows: number[][] = [];
    const emit = (r: GapRing): void => {
      const gap = r.gap;
      const a0 = Math.PI / 2 + gap;
      const a1 = Math.PI / 2 + Math.PI * 2 - gap;
      const e = 2 / (r.n ?? 2);
      const row: number[] = [];
      for (let i = 0; i <= segs; i++) {
        const th = a0 + ((a1 - a0) * i) / segs;
        const m = i === 0 || i === segs ? 1 - (0.012 * K) / Math.max(r.rx, 0.05) : 1;
        const cs = Math.cos(th);
        const sn = Math.sin(th);
        const x = r.c[0] + Math.sign(cs) * Math.pow(Math.abs(cs), e) * r.rx * m;
        const z = r.c[2] + Math.sign(sn) * Math.pow(Math.abs(sn), e) * r.rz * m;
        const cc = r.col as THREE.Color;
        row.push(b.v(x, r.c[1], z, i === 0 || i === segs ? shade(cc, 0.8) : cc, legW(x, r.c[1], z)));
      }
      rows.push(row);
    };
    emit(ringAt(ys[0] + 0.003, ease - 0.014 * K, dark));
    emit(ringAt(ys[0], ease, dark));
    for (let i = 1; i < ys.length; i++) emit(ringAt(ys[i], ease, c));
    // collar: stands up round the neck, then folds back down inside
    const top = 0.8486;
    const colRing = (y: number, r: number, cc: THREE.Color): GapRing => ({
      c: [0, y, neckZ],
      rx: r,
      rz: r * 0.96,
      col: cc,
      w: torsoW,
      gap: gapAt(0.86),
    });
    emit(colRing(top * H + 0.004 * K, neckR + 0.026 * K, c));
    emit(colRing(top * H + collarH, neckR + 0.03 * K, c));
    emit(colRing(top * H + collarH, neckR + 0.02 * K, dark));
    emit(colRing(top * H - 0.004 * K, neckR + 0.012 * K, dark));
    // rings travel upward -> flipped winding
    for (let k = 0; k < rows.length - 1; k++) {
      for (let i = 0; i < segs; i++) b.quad(rows[k][i], rows[k][i + 1], rows[k + 1][i + 1], rows[k + 1][i], true);
    }
  };

  const tee = 0.008 * K;
  let sleeve: 'long' | 'short' = 'long';
  let sleeveEase = 0.012 * K;
  let sleeveCol = col.top;
  if (style === 'tee') {
    garment(tee, man ? 0.522 : 0.505, col.top, 0, 'crew');
    sleeve = 'short';
    sleeveEase = 0.009 * K;
  } else if (style === 'apron') {
    garment(tee, 0.522, col.inner, 0, 'crew');
    sleeve = 'short';
    sleeveEase = 0.009 * K;
    sleeveCol = col.inner;
  } else if (style === 'hoodie') {
    garment(0.018 * K, man ? 0.508 : 0.496, col.top, 0.93, 'thick');
    sleeveEase = 0.016 * K;
  } else if (style === 'jacket') {
    garment(0.005 * K, 0.5, col.inner, 0, 'crew');
    shell(0.022 * K, man ? 0.528 : 0.505, col.top, 0.028 * K, (yf) => lerp(0.2, 0.62, smoothstep(0.6, 0.84, yf)), 0);
    sleeveEase = 0.016 * K;
  } else {
    garment(0.005 * K, 0.5, col.inner, 0, 'crew');
    shell(0.024 * K, man ? 0.34 : 0.32, col.top, 0.03 * K, (yf) => lerp(0.13, 0.6, smoothstep(0.62, 0.84, yf)), 0.1);
    sleeveEase = 0.017 * K;
  }

  /* ------------------------------------------------------------------ neck */
  {
    const c = col.skin;
    const y0 = d.neck.y;
    const y1 = d.head.y;
    const z0 = d.neck.z;
    const z1 = d.head.z - 0.01 * d.headScale;
    const nr = neckR;
    const rings: Ring[] = [
      { c: [0, y0 - 0.03 * K, z0], rx: nr * 1.12, rz: nr * 1.08, col: c, w: [[B.chest, 1]] },
      { c: [0, y0 + 0.012 * K, lerp(z0, z1, 0.15)], rx: nr * 0.98, rz: nr * 0.98, col: c, w: [[B.chest, 0.5], [B.neck, 0.5]] },
      { c: [0, lerp(y0, y1, 0.5), lerp(z0, z1, 0.5)], rx: nr * 0.93, rz: nr * 0.95, col: c, w: [[B.neck, 1]] },
      { c: [0, y1 - 0.025 * K, lerp(z0, z1, 0.85)], rx: nr * 0.93, rz: nr * 0.96, col: c, w: [[B.neck, 0.5], [B.head, 0.5]] },
      { c: [0, y1 + 0.03 * d.headScale, z1], rx: nr * 0.9, rz: nr * 0.92, col: c, w: [[B.head, 1]] },
    ];
    loft(b, rings, { segs: 12, capStart: true, capEnd: true });
  }

  /* ------------------------------------------------------------------ arms */
  for (const side of [1, -1] as const) {
    const o = side === 1 ? 0 : 10;
    const clav = B.clavL + o;
    const up = B.upperArmL + o;
    const fo = B.foreArmL + o;
    const hand = B.handL + o;
    const sx = d.shoulder.x * side;
    const sy = d.shoulder.y;
    const sz = d.shoulder.z;
    const ey = sy - d.upperArm;
    const wy = ey - d.foreArm;
    const g = armG * K;
    // [y, radius, weights]
    const rows: Array<[number, number, BW]> = [
      [sy + 0.046 * K, 0.014 * g, [[up, 0.5], [clav, 0.5]]],
      [sy + 0.036 * K, 0.034 * g, [[up, 0.55], [clav, 0.45]]],
      [sy + 0.016 * K, 0.048 * g, [[up, 0.7], [clav, 0.3]]],
      [sy - 0.012 * K, 0.054 * g, [[up, 0.85], [clav, 0.15]]],
      [sy - 0.06 * K, 0.052 * g, [[up, 1]]],
      [sy - 0.15 * K, 0.046 * g, [[up, 1]]],
      [sy - 0.25 * K, 0.042 * g, [[up, 1]]],
      [ey + 0.035 * K, 0.04 * g, [[up, 0.8], [fo, 0.2]]],
      [ey, 0.039 * g, [[up, 0.5], [fo, 0.5]]],
      [ey - 0.035 * K, 0.041 * g, [[up, 0.2], [fo, 0.8]]],
      [ey - 0.09 * K, 0.042 * g, [[fo, 1]]],
      [ey - 0.18 * K, 0.035 * g, [[fo, 1]]],
      [wy + 0.03 * K, 0.029 * g, [[fo, 1]]],
    ];
    const rAt = (y: number): number => {
      for (let i = 1; i < rows.length; i++) {
        if (y >= rows[i][0]) {
          const f = (y - rows[i][0]) / (rows[i - 1][0] - rows[i][0]);
          return lerp(rows[i][1], rows[i - 1][1], f);
        }
      }
      return rows[rows.length - 1][1];
    };
    const mk = (y: number, r: number, c: THREE.Color, w: BW): Ring => ({ c: [sx, y, sz], rx: r, rz: r * 1.04, col: c, w });
    const dark = shade(sleeveCol, 0.72);
    if (sleeve === 'long') {
      const rings: Ring[] = rows.map(([y, r, w], i) => mk(y, r + (i === 0 ? 0 : sleeveEase), sleeveCol, w));
      rings.push(mk(wy + 0.012 * K, 0.03 * g + sleeveEase * 0.8, sleeveCol, [[fo, 1]]));
      rings.push(mk(wy + 0.008 * K, 0.03 * g + sleeveEase * 0.6, dark, [[fo, 1]]));
      rings.push(mk(wy + 0.012 * K, 0.022 * g, dark, [[fo, 1]]));
      loft(b, rings, { segs: 10, capStart: true });
    } else {
      const hemY = sy - 0.17 * K;
      const rings: Ring[] = [];
      for (const [y, r, w] of rows) if (y > hemY + 0.02 * K) rings.push(mk(y, r + (rings.length === 0 ? 0 : sleeveEase), sleeveCol, w));
      rings.push(mk(hemY, rAt(hemY) + sleeveEase * 1.2, sleeveCol, [[up, 1]]));
      rings.push(mk(hemY - 0.003 * K, rAt(hemY) + sleeveEase, dark, [[up, 1]]));
      rings.push(mk(hemY + 0.004 * K, rAt(hemY) - 0.003 * K, dark, [[up, 1]]));
      loft(b, rings, { segs: 10, capStart: true });
      const skin: Ring[] = [mk(hemY + 0.03 * K, rAt(hemY + 0.03 * K) * 0.98, col.skin, [[up, 1]])];
      for (const [y, r, w] of rows) if (y < hemY) skin.push(mk(y, r, col.skin, w));
      loft(b, skin, { segs: 10, capStart: true });
    }

    /* hand: fingers point down, palm faces the thigh, thumb forward */
    const hc = col.skin;
    const hw: BW = [[hand, 1]];
    const palm: Ring[] = [
      { c: [sx, wy + 0.035 * K, sz], rx: 0.024 * g, rz: 0.028 * g, col: hc, w: [[fo, 1]] },
      { c: [sx, wy, sz], rx: 0.021 * K, rz: 0.028 * K, col: hc, w: [[fo, 0.5], [hand, 0.5]] },
      { c: [sx, wy - 0.022 * K, sz + 0.002 * K], rx: 0.0165 * K, rz: 0.037 * K, col: hc, w: hw, n: 2.6 },
      { c: [sx, wy - 0.06 * K, sz + 0.001 * K], rx: 0.0145 * K, rz: 0.043 * K, col: hc, w: hw, n: 2.8 },
      { c: [sx, wy - 0.1 * K, sz], rx: 0.0125 * K, rz: 0.042 * K, col: hc, w: hw, n: 3 },
    ];
    loft(b, palm, { segs: 10, capStart: true, capEnd: true });
    // four fingers: [z offset, knuckle y, length, radius, bone1, bone2, mid-joint y]
    const f1 = B.fingL1 + o;
    const f2 = B.fingL2 + o;
    const i1 = B.indexL1 + o;
    const i2 = B.indexL2 + o;
    const fingers: Array<[number, number, number, number, number, number, number]> = [
      [0.03, -0.096, 0.074, 0.0088, i1, i2, -0.138],
      [0.0095, -0.099, 0.082, 0.009, f1, f2, -0.14],
      [-0.0105, -0.097, 0.076, 0.0085, f1, f2, -0.14],
      [-0.0295, -0.091, 0.06, 0.0075, f1, f2, -0.14],
    ];
    for (const [fz, ky, len, r, b1, b2, my] of fingers) {
      const z = sz + fz * K;
      const top = wy + (ky + 0.012) * K;
      const mid = wy + my * K;
      const tip = wy + (ky - len) * K;
      const rr = r * K;
      const rings: Ring[] = [
        { c: [sx, top, z], rx: rr, rz: rr, col: hc, w: [[hand, 0.6], [b1, 0.4]] },
        { c: [sx, wy + ky * K - 0.004 * K, z], rx: rr, rz: rr, col: hc, w: [[b1, 1]] },
        { c: [sx, mid + 0.008 * K, z], rx: rr * 0.97, rz: rr * 0.97, col: hc, w: [[b1, 0.85], [b2, 0.15]] },
        { c: [sx, mid - 0.008 * K, z], rx: rr * 0.95, rz: rr * 0.95, col: hc, w: [[b1, 0.15], [b2, 0.85]] },
        { c: [sx, tip + 0.01 * K, z], rx: rr * 0.86, rz: rr * 0.86, col: hc, w: [[b2, 1]] },
        { c: [sx, tip + 0.002 * K, z], rx: rr * 0.55, rz: rr * 0.55, col: hc, w: [[b2, 1]] },
      ];
      loft(b, rings, { segs: 6, capEnd: true });
    }
    // thumb
    {
      const t1 = B.thumbL1 + o;
      const t2 = B.thumbL2 + o;
      const td = thumbDir(side);
      const base = new THREE.Vector3(sx - side * 0.004 * K, wy - 0.03 * K, sz + 0.03 * K);
      const at = (t: number): V3 => [base.x + td.x * t * K, base.y + td.y * t * K, base.z + td.z * t * K];
      const pts: V3[] = [at(-0.014), at(0.006), at(0.032), at(0.044), at(0.064), at(0.072)];
      const rs = [0.011, 0.0115, 0.0105, 0.01, 0.009, 0.0055].map((r) => r * K);
      const ws: BW[] = [
        [[hand, 1]],
        [[hand, 0.3], [t1, 0.7]],
        [[t1, 0.8], [t2, 0.2]],
        [[t1, 0.2], [t2, 0.8]],
        [[t2, 1]],
        [[t2, 1]],
      ];
      let k = 0;
      const first = b.count;
      tubePath(b, pts, rs, rs, hc, [[hand, 1]], 6, true, [side, 0, 0]);
      // per-ring weights: 6 verts per ring, then two cap centres
      for (let ring = 0; ring < pts.length; ring++) {
        for (let i = 0; i < 6; i++) {
          setWeights(b, first + k, ws[ring]);
          k++;
        }
      }
      setWeights(b, first + k, ws[0]);
      setWeights(b, first + k + 1, ws[ws.length - 1]);
    }
  }

  /* ---------------------------------------------------------- style details */
  const hood = style === 'hoodie' || opts.hairStyle === 'hood_down';
  if (hood) {
    const c = col.top;
    const cw: BW = [[B.chest, 1]];
    const cy = 0.8486 * H + 0.012 * K;
    const rings: Ring[] = [];
    const n = 14;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const back = 0.5 - 0.5 * Math.sin(a); // 0 at the front, 1 at the back
      const R = neckR + lerp(0.022, 0.034, back) * K;
      const rr = lerp(0.016, 0.04, back * back) * K;
      rings.push({
        c: [Math.cos(a) * R * 1.05, cy - 0.022 * K * (1 - back) + 0.01 * K * back, neckZ + Math.sin(a) * R - 0.018 * K * back],
        rx: rr,
        rz: rr * lerp(1, 1.25, back),
        u: [Math.cos(a), 0, Math.sin(a)],
        v: [0, 1, 0],
        col: back > 0.6 ? shade(c, 0.9) : c,
        w: cw,
      });
    }
    loft(b, rings, { segs: 8, flip: false });
    // the hood itself, slumped between the shoulder blades
    const from = b.count;
    ellipsoid(b, [0, 0, 0], 0.105 * K, 0.1 * K, 0.04 * K, shade(c, 0.94), cw, 10, 6);
    const back = torsoAt(0.8);
    b.transform(
      from,
      new THREE.Matrix4()
        .makeTranslation(0, 0.8 * H, back.cz - back.rz - 0.03 * K)
        .multiply(new THREE.Matrix4().makeRotationX(0.22)),
    );
    if (style === 'hoodie') {
      // drawstrings
      const front = torsoAt(0.77);
      const sc = new THREE.Color(0x8d8a82);
      for (const s of [1, -1]) {
        const pts: V3[] = [
          [s * 0.03 * K, cy - 0.012 * K, neckZ + neckR + 0.036 * K],
          [s * 0.034 * K, 0.815 * H, front.cz + front.rz * 0.93 + 0.022 * K],
          [s * 0.036 * K, (s > 0 ? 0.752 : 0.765) * H, front.cz + front.rz + 0.021 * K],
        ];
        tubePath(b, pts, 0.0032 * K, 0.0032 * K, sc, cw, 5, true, [1, 0, 0]);
      }
    }
  }

  if (style === 'apron') {
    const c = col.top;
    const dark = shade(c, 0.75);
    const e = tee + 0.009 * K;
    const hipR = torsoAt(0.5189);
    const legW = (x: number, y: number, z: number): BW => {
      const yf = y / H;
      if (yf > 0.52) return torsoW(x, y, z);
      const t = 0.7 * smoothstep(0.5, 0.36, yf);
      const s = 0.5 + 0.5 * clamp(x / (0.05 * K), -1, 1);
      return [
        [B.hips, 1 - t],
        [B.upperLegL, t * s],
        [B.upperLegR, t * (1 - s)],
      ];
    };
    const panel = (ys: number[], half: number): void => {
      const rings: Ring[] = ys.map((yf, i) => {
        const cc = i === 0 || i === ys.length - 1 ? dark : c;
        if (yf < 0.5189) return { c: [0, yf * H, hipR.cz], rx: hipR.rx + e + 0.014 * K, rz: hipR.rz + e + 0.008 * K + (0.5189 - yf) * H * 0.04, col: cc, w: legW, n: 2.6 };
        return torsoRing(yf, e + 0.014 * K * smoothstep(0.6, 0.53, yf), cc, 0, legW);
      });
      loft(b, rings, { segs: 8, arc: [Math.PI / 2 - half, Math.PI / 2 + half], flip: true });
    };
    panel([0.33, 0.39, 0.45, 0.5189, 0.5568, 0.5892, 0.612], 1.05);
    panel([0.612, 0.6757, 0.7243, 0.756], 0.7);
    // waist tie
    loft(b, [torsoRing(0.6, e + 0.002 * K, dark), torsoRing(0.612, e + 0.003 * K, c), torsoRing(0.624, e + 0.002 * K, dark)], { segs: 16 });
    // neck strap
    for (const s of [1, -1]) {
      const at = (yf: number, x: number, lift: number): V3 => {
        const t = torsoAt(yf);
        const q = Math.min(0.98, Math.abs(x) / (t.rx + e));
        return [s * x, yf * H, t.cz + (t.rz + e) * Math.pow(1 - Math.pow(q, 2.6), 1 / 2.6) + lift];
      };
      const pts: V3[] = [
        at(0.752, 0.085 * K, 0.004 * K),
        at(0.79, 0.078 * K, 0.006 * K),
        at(0.818, 0.068 * K, 0.008 * K),
        [s * 0.062 * K, 0.846 * H, neckZ + 0.03 * K],
        [s * 0.058 * K, 0.855 * H, neckZ - 0.02 * K],
        [s * 0.03 * K, 0.852 * H, neckZ - neckR - 0.012 * K],
        [0, 0.85 * H, neckZ - neckR - 0.016 * K],
      ];
      tubePath(b, pts, 0.009 * K, 0.004 * K, dark, [[B.chest, 1]], 5, false, [s, 0, 0]);
    }
  }

  /* ------------------------------------------------------------ accessories */
  const acc = opts.accessory ?? 'none';
  if (acc === 'tote') {
    const s = d.bagSide;
    const bw: BW = [[B.bag, 1]];
    const px = d.bagPivot.x * s;
    const py = d.bagPivot.y;
    const pz = d.bagPivot.z;
    const hipR = torsoAt(0.56);
    const bx = s * (hipR.rx + 0.075 * K);
    const bagTop = 0.615 * H;
    const bagH = 0.3 * K;
    box(b, [bx, bagTop - bagH / 2, pz - 0.03 * K], 0.05 * K, bagH / 2, 0.165 * K, col.bag, bw, 6, 12);
    // two straps from the bag mouth over the shoulder
    for (const dz of [0.09, -0.11]) {
      const pts: V3[] = [
        [bx - s * 0.01 * K, bagTop - 0.02 * K, pz - 0.03 * K + dz * K],
        [lerp(bx, px, 0.55) + s * 0.03 * K, lerp(bagTop, py, 0.55), pz + dz * 0.55 * K],
        [px + s * 0.012 * K, py - 0.012 * K, pz + dz * 0.22 * K],
        [px - s * 0.012 * K, py + 0.004 * K, pz + dz * 0.1 * K],
      ];
      tubePath(b, pts, 0.011 * K, 0.004 * K, col.strap, bw, 5, true, [s, 0, 0]);
    }
  } else if (acc === 'backpack') {
    const cw: BW = [[B.chest, 0.8], [B.spine, 0.2]];
    const back = torsoAt(0.72);
    const zc = back.cz - back.rz - (hood ? 0.1 : 0.07) * K;
    box(b, [0, 0.705 * H, zc], 0.135 * K, 0.2 * K, 0.07 * K, col.bag, cw, 4, 12);
    box(b, [0, 0.655 * H, zc - 0.06 * K], 0.095 * K, 0.075 * K, 0.025 * K, shade(col.bag, 0.85), cw, 4, 10);
    for (const s of [1, -1]) {
      const f = torsoAt(0.77);
      const pts: V3[] = [
        [s * 0.09 * K, 0.795 * H, zc + 0.05 * K],
        [s * 0.1 * K, 0.832 * H, -0.03 * K],
        [s * 0.108 * K, 0.812 * H, f.cz + f.rz * 0.8],
        [s * 0.125 * K, 0.76 * H, f.cz + f.rz * 0.93 + 0.012 * K],
        [s * 0.15 * K, 0.7 * H, f.cz + f.rz * 0.75],
        [s * (f.rx + 0.012 * K), 0.655 * H, 0],
        [s * 0.12 * K, 0.63 * H, zc + 0.04 * K],
      ];
      tubePath(b, pts, 0.016 * K, 0.006 * K, col.strap, [[B.chest, 1]], 5, true, [s, 0, 0]);
    }
  }

  return b.build({ weld: true });
}

function setWeights(b: GeoBuilder, i: number, w: BW): void {
  const ws = [...w].sort((a, c) => c[1] - a[1]).slice(0, 4);
  let sum = 0;
  for (const e of ws) sum += e[1];
  for (let k = 0; k < 4; k++) {
    b.skinI[i * 4 + k] = ws[k] ? ws[k][0] : 0;
    b.skinW[i * 4 + k] = ws[k] ? ws[k][1] / sum : 0;
  }
}
