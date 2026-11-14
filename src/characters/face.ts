/**
 * Procedural head with an animatable face.
 *
 * The head is one vertex-coloured mesh built from a lat/long style grid with
 * real openings for the eyes and the mouth. Expression is driven by "channels"
 * (roughly FACS action units): each is a precomputed sparse displacement field,
 * blended on the CPU every frame together with a rotating jaw, eyelids that
 * slide over the eyeballs and brows that travel over the brow ridge. Hair,
 * ears, teeth and brows live in the same buffer, so the head is ONE draw call
 * plus one per eye.
 *
 * Head space: metres at "reference man" size, origin at the skull pivot (top
 * of the neck), +Z = face forward, +X = the character's left, +Y = up.
 */
import * as THREE from 'three';
import { GeoBuilder, ellipsoid, loft, tubePath, type Ring, type V3 } from './geo';
import { clamp, curve, gauss, gauss2, lerp, saturate, smoothstep } from './util';

/** Face channels. L = the character's left (+X), R = right. */
export const FC = {
  browRaiseL: 0,
  browRaiseR: 1,
  /** + inner end up (worry, fear), - inner end down and in (anger). */
  browInnerL: 2,
  browInnerR: 3,
  browOuterL: 4,
  browOuterR: 5,
  /** + closes the upper lid, - opens it wider than rest. */
  lidUpL: 6,
  lidUpR: 7,
  /** + raises the lower lid (squint). */
  lidLowL: 8,
  lidLowR: 9,
  smileL: 10,
  smileR: 11,
  frownL: 12,
  frownR: 13,
  /** Corner pulled straight sideways (fear, grimace). */
  stretchL: 14,
  stretchR: 15,
  pucker: 16,
  /** One-sided upper lip raise with the nose wing. */
  sneerL: 17,
  sneerR: 18,
  upperLipUp: 19,
  lowerLipDrop: 20,
  lipsPart: 21,
  lipPress: 22,
  chinRaise: 23,
  jawOpen: 24,
  /** + toward the character's left. */
  jawSide: 25,
  jawFwd: 26,
  cheekL: 27,
  cheekR: 28,
  /** Whole mouth shifted toward the character's left (+) or right (-). */
  mouthX: 29,
} as const;
export const FACE_CHANNELS = 30;
const CH_FURROW_L = 30;
const CH_FURROW_R = 31;
const CH_TOTAL = 32;

export interface FaceOptions {
  man: boolean;
  skin: THREE.Color;
  hair: THREE.Color;
  hairStyle: 'short' | 'buzz' | 'long' | 'ponytail' | 'beanie' | 'hood_down';
  headphones: boolean;
  material: THREE.Material;
  eyeMaterial: THREE.Material;
}

export interface FaceRig {
  readonly mesh: THREE.Mesh;
  readonly eyeL: THREE.Mesh;
  readonly eyeR: THREE.Mesh;
  /** Eye centres in head space. */
  readonly eyeCenterL: THREE.Vector3;
  readonly eyeCenterR: THREE.Vector3;
  /** Deform the face to the given channel weights (length FACE_CHANNELS). */
  apply(ch: Float32Array): void;
  dispose(): void;
}

const Y_MOUTH = -0.0397;
const EYE_X = 0.0325;
const EYE_Y = 0.0322;
const R_LID = 0.0142;
const R_EYE = 0.0125;
const JAW_Y = 0.004;
const JAW_Z = 0.0;
const JAW_MAX = 0.3;

/* ------------------------------------------------------------ head shape */

// y, half-width W, front F, back B, widest-point C, superellipse n
const PROFILE_MAN: number[][] = [
  [-0.09, 0.02, 0.083, 0.04, 0.062, 2.2],
  [-0.082, 0.034, 0.094, 0.03, 0.062, 2.3],
  [-0.072, 0.043, 0.097, 0.018, 0.056, 2.4],
  [-0.06, 0.052, 0.094, 0.004, 0.048, 2.5],
  [-0.05, 0.058, 0.097, -0.012, 0.036, 2.5],
  [-0.04, 0.063, 0.099, -0.045, 0.012, 2.5],
  [-0.03, 0.066, 0.099, -0.058, 0.002, 2.5],
  [-0.018, 0.069, 0.097, -0.068, -0.004, 2.5],
  [0.0, 0.072, 0.094, -0.082, -0.006, 2.5],
  [0.015, 0.074, 0.091, -0.092, -0.006, 2.45],
  [0.032, 0.075, 0.088, -0.098, -0.006, 2.4],
  [0.05, 0.076, 0.094, -0.102, -0.006, 2.35],
  [0.07, 0.078, 0.096, -0.104, -0.006, 2.3],
  [0.095, 0.077, 0.09, -0.102, -0.006, 2.2],
  [0.115, 0.07, 0.076, -0.092, -0.008, 2.1],
  [0.132, 0.056, 0.054, -0.072, -0.01, 2.0],
  [0.144, 0.034, 0.028, -0.045, -0.01, 2.0],
];

interface Shape {
  prof: number[][];
  sock: number;
  ridge: number;
  noseP: number;
  noseW: number;
  lipF: number;
  chin: number;
  eyeH: number;
  zEye: number;
}

function makeShape(man: boolean): Shape {
  const prof = PROFILE_MAN.map((r) => r.slice());
  if (!man) {
    for (const r of prof) {
      const y = r[0];
      // softer, narrower jaw and chin; slightly rounder cheeks
      const jaw = smoothstep(-0.01, -0.075, y);
      r[1] *= 0.975 * (1 - 0.17 * jaw);
      r[5] = lerp(r[5], 2.2, 0.6);
      if (y < -0.07) r[2] -= 0.002;
    }
  }
  const s: Shape = {
    prof,
    sock: man ? 0.0068 : 0.0058,
    ridge: man ? 0.0052 : 0.0018,
    noseP: man ? 1 : 0.84,
    noseW: man ? 1 : 0.86,
    lipF: man ? 1 : 1.3,
    chin: man ? 0.003 : 0.0015,
    eyeH: man ? 1 : 1.14,
    zEye: 0,
  };
  return s;
}

function profile(sh: Shape, y: number, out: number[]): void {
  const p = sh.prof;
  const n = p.length;
  if (y <= p[0][0]) {
    for (let k = 1; k < 6; k++) out[k] = p[0][k];
    return;
  }
  if (y >= p[n - 1][0]) {
    for (let k = 1; k < 6; k++) out[k] = p[n - 1][k];
    return;
  }
  let i = 0;
  while (y > p[i + 1][0]) i++;
  const y0 = p[i][0];
  const y1 = p[i + 1][0];
  const h = y1 - y0;
  const t = (y - y0) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  for (let k = 1; k < 6; k++) {
    const m0 = i > 0 ? (p[i + 1][k] - p[i - 1][k]) / (p[i + 1][0] - p[i - 1][0]) : (p[1][k] - p[0][k]) / (p[1][0] - p[0][0]);
    const m1 = i < n - 2 ? (p[i + 2][k] - p[i][k]) / (p[i + 2][0] - p[i][0]) : (p[n - 1][k] - p[n - 2][k]) / (p[n - 1][0] - p[n - 2][0]);
    out[k] = h00 * p[i][k] + h10 * h * m0 + h01 * p[i + 1][k] + h11 * h * m1;
  }
}

const NOSE_P: Array<[number, number]> = [
  [-0.0245, 0],
  [-0.0225, 0.01],
  [-0.02, 0.0215],
  [-0.017, 0.027],
  [-0.012, 0.0262],
  [-0.005, 0.0222],
  [0.01, 0.0135],
  [0.03, 0.0045],
  [0.041, 0],
];
const NOSE_W: Array<[number, number]> = [
  [-0.0245, 0.0135],
  [-0.019, 0.0165],
  [-0.013, 0.0165],
  [-0.004, 0.0135],
  [0.01, 0.0098],
  [0.03, 0.0078],
  [0.041, 0.008],
];

/** Forward displacement of the facial features at (x, y) on the front of the head. */
function featureZ(sh: Shape, x: number, y: number): number {
  const ax = Math.abs(x);
  let d = 0;
  // eye sockets
  d -= sh.sock * gauss2(ax - EYE_X, 0.021, y - 0.033, 0.0135);
  // brow ridge and glabella
  d += sh.ridge * gauss(y - 0.0525, 0.0078) * smoothstep(0.0, 0.014, ax) * (1 - smoothstep(0.05, 0.072, ax));
  d += sh.ridge * 0.55 * gauss2(ax, 0.012, y - 0.05, 0.008);
  // nose
  if (y > -0.0245 && y < 0.041 && ax < 0.03) {
    const P = curve(NOSE_P, y) * sh.noseP;
    const w = curve(NOSE_W, y) * sh.noseW;
    d += P * (1 - smoothstep(0.28 * w, w, ax));
    d += 0.004 * sh.noseP * gauss2(ax - 0.0122 * sh.noseW, 0.0046, y + 0.0165, 0.005);
  }
  // cheekbones
  d += 0.0025 * gauss2(ax - 0.05, 0.016, y - 0.006, 0.012);
  // lips
  const tu = Math.pow(saturate(1 - (ax / 0.0285) * (ax / 0.0285)), 0.7);
  const tl = Math.pow(saturate(1 - (ax / 0.026) * (ax / 0.026)), 0.7);
  d += 0.003 * sh.lipF * gauss(y + 0.0368, 0.003) * tu;
  d += 0.0042 * sh.lipF * gauss(y + 0.0438, 0.0036) * tl;
  d -= 0.001 * gauss(y - Y_MOUTH, 0.0012) * tu;
  // dent under the lower lip, chin boss
  d -= 0.0025 * gauss2(ax, 0.02, y + 0.0545, 0.004);
  d += sh.chin * gauss2(ax, 0.018, y + 0.076, 0.009);
  return d;
}

const _p = [0, 0, 0, 0, 0, 0];

/** Point on the head surface for height y and meridian phi (0 = front, +90deg = character's left). */
function surf(sh: Shape, y: number, phi: number, out: THREE.Vector3, features = true): THREE.Vector3 {
  profile(sh, y, _p);
  const W = _p[1];
  const F = _p[2];
  const Bk = _p[3];
  const C = _p[4];
  const e = 2 / _p[5];
  const s = Math.sin(phi);
  const c = Math.cos(phi);
  const x = W * Math.sign(s) * Math.pow(Math.abs(s), e);
  let z = C + (c >= 0 ? F - C : C - Bk) * Math.sign(c) * Math.pow(Math.abs(c), e);
  if (features && c > 0.1) {
    z += featureZ(sh, x, y) * smoothstep(0.1, 0.45, c);
    // the eyeball pushes the lids out
    const dx = Math.abs(x) - EYE_X;
    const dy = y - EYE_Y;
    const q = R_LID * R_LID - dx * dx - dy * dy;
    if (q > 0) z = Math.max(z, sh.zEye + Math.sqrt(q));
  }
  return out.set(x, y, z);
}

/** Front-surface z at an arbitrary (x, y). */
function surfXY(sh: Shape, x: number, y: number): number {
  profile(sh, y, _p);
  const n = _p[5];
  const sx = Math.min(0.999, Math.abs(x) / _p[1]);
  const sn = Math.pow(sx, n / 2);
  const cs = Math.sqrt(1 - sn * sn);
  let z = _p[4] + (_p[2] - _p[4]) * Math.pow(cs, 2 / n);
  z += featureZ(sh, x, y) * smoothstep(0.1, 0.45, cs);
  return z;
}

/* ------------------------------------------------------------------ grid */

type Tag =
  | ''
  | 'lipLowBorder'
  | 'lipLowPeak'
  | 'mLow'
  | 'mLowIn'
  | 'mUpIn'
  | 'mUp'
  | 'lipUpPeak'
  | 'lipUpBorder'
  | 'A2'
  | 'A'
  | 'Ain'
  | 'Bin'
  | 'B'
  | 'B2'
  | 'C';

const ROWS: Array<[number, Tag]> = [
  [-0.0895, ''],
  [-0.082, ''],
  [-0.072, ''],
  [-0.061, ''],
  [-0.054, ''],
  [-0.0487, 'lipLowBorder'],
  [-0.0436, 'lipLowPeak'],
  [Y_MOUTH, 'mLow'],
  [Y_MOUTH, 'mLowIn'],
  [Y_MOUTH, 'mUpIn'],
  [Y_MOUTH, 'mUp'],
  [-0.0366, 'lipUpPeak'],
  [-0.0333, 'lipUpBorder'],
  [-0.029, ''],
  [-0.0245, ''],
  [-0.0212, ''],
  [-0.018, ''],
  [-0.0145, ''],
  [-0.0105, ''],
  [-0.005, ''],
  [0.003, ''],
  [0.011, ''],
  [0.018, ''],
  [0.0232, 'A2'],
  [0.0265, 'A'],
  [0.0265, 'Ain'],
  [0.0375, 'Bin'],
  [0.0375, 'B'],
  [0.0405, 'B2'],
  [0.0455, 'C'],
  [0.0515, ''],
  [0.058, ''],
  [0.066, ''],
  [0.076, ''],
  [0.088, ''],
  [0.101, ''],
  [0.115, ''],
  [0.129, ''],
  [0.141, ''],
];
const NR = ROWS.length;
const rowOf = (t: Tag): number => ROWS.findIndex((r) => r[1] === t);
const R_ = {
  lipLowBorder: rowOf('lipLowBorder'),
  lipLowPeak: rowOf('lipLowPeak'),
  mLow: rowOf('mLow'),
  mLowIn: rowOf('mLowIn'),
  mUpIn: rowOf('mUpIn'),
  mUp: rowOf('mUp'),
  lipUpPeak: rowOf('lipUpPeak'),
  lipUpBorder: rowOf('lipUpBorder'),
  A2: rowOf('A2'),
  A: rowOf('A'),
  Ain: rowOf('Ain'),
  Bin: rowOf('Bin'),
  B: rowOf('B'),
  B2: rowOf('B2'),
  C: rowOf('C'),
};

// Columns: dense across the face so the eyes and mouth have enough vertices.
const FRONT_X = [0, 0.0045, 0.009, 0.013, 0.0165, 0.0205, 0.0245, 0.0285, 0.0325, 0.0365, 0.0405, 0.0445, 0.0485, 0.053, 0.0585, 0.064, 0.069, 0.073];
const BACK_DEG = [84, 93, 103, 115, 128, 142, 156, 168, 180];
const HALF = FRONT_X.length + BACK_DEG.length - 1; // index of the 180deg column
const NC = HALF * 2;
const MOUTH_COL = 8; // column of the mouth corner
const EYE_IN = 4; // inner eye corner column
const EYE_OUT = 12;

/** Signed column: 0 at the front midline, positive toward the character's left. */
const sc = (c: number): number => (c <= HALF ? c : c - NC);

interface Brow {
  side: 1 | -1;
  /** per station: vertex index of top, front, bottom */
  vi: number[];
  s: number[];
  x0: number[];
  y0: number[];
  z0: number[];
  th: number[];
}

interface EyeCol {
  phi: number;
  s: number;
  A2: number;
  A: number;
  Ain: number;
  Bin: number;
  B: number;
  B2: number;
  C: number;
  cRestY: number;
}

export function buildFace(o: FaceOptions): FaceRig {
  const sh = makeShape(o.man);
  const b = new GeoBuilder(false);
  const tmp = new THREE.Vector3();

  // meridians
  profile(sh, EYE_Y, _p);
  const We = _p[1];
  const ne = _p[5];
  const halfPhi: number[] = [];
  for (const x of FRONT_X) halfPhi.push(Math.asin(Math.pow(x / We, ne / 2)));
  for (const dgr of BACK_DEG) halfPhi.push((dgr * Math.PI) / 180);
  const phis: number[] = [];
  for (let c = 0; c < NC; c++) phis.push(c <= HALF ? halfPhi[c] : -halfPhi[NC - c]);

  // eye depth: lid apex sits a little proud of the socket floor
  sh.zEye = -1;
  surf(sh, EYE_Y, halfPhi[8], tmp, true);
  sh.zEye = tmp.z + 0.0058 - R_LID;

  /* ----------------------------------------------------------- colours */
  const skin = o.skin.clone();
  const lipCol = skin.clone().lerp(new THREE.Color(o.man ? 0x7a3d38 : 0x93393f), o.man ? 0.5 : 0.75);
  const lipLine = lipCol.clone().lerp(new THREE.Color(0x1e0c0b), 0.62);
  const mouthDark = new THREE.Color(0x1a0808);
  const lash = new THREE.Color(0x0d0907);
  const stubble = o.hair.clone().lerp(new THREE.Color(0x2a2c30), 0.5).lerp(skin, 0.25);
  const blush = skin.clone().multiply(new THREE.Color(1.06, 0.86, 0.82));
  const hairCol = o.hair.clone();
  const browCol = o.hair.clone().multiplyScalar(0.62);
  const tooth = new THREE.Color(0xe6e0d0);

  const scalpStyle = o.hairStyle === 'beanie' || o.hairStyle === 'hood_down' ? 'short' : o.hairStyle;
  const hairline = (style: string, phiAbsDeg: number): number => curve(HAIRLINES[style] ?? HAIRLINES.short, phiAbsDeg);

  const colorAt = (r: number, c: number, x: number, y: number, z: number): THREE.Color => {
    const tag = ROWS[r][1];
    const s = sc(c);
    const as = Math.abs(s);
    const ax = Math.abs(x);
    const col = skin.clone();
    const front = smoothstep(0.0, 0.05, z);
    // warmth on nose, cheeks
    const warm = (0.45 * gauss2(ax, 0.014, y + 0.008, 0.012) + 0.3 * gauss2(ax - 0.045, 0.02, y + 0.004, 0.016)) * front;
    col.lerp(blush, warm);
    // shadowed eye sockets
    col.multiplyScalar(1 - 0.12 * gauss2(ax - EYE_X, 0.02, y - 0.034, 0.012) * front);
    if (o.man) {
      // stubble: jaw, chin, upper lip
      const line = -0.016 + Math.max(0, 0.088 - z) * 0.42;
      let m = smoothstep(line + 0.004, line - 0.014, y) * smoothstep(-0.03, 0.0, z);
      m *= 1 - 0.75 * gauss2(ax, 0.02, y + 0.041, 0.007);
      col.lerp(stubble, 0.42 * m);
    }
    // scalp under the hair
    const phiDeg = Math.abs((phis[c] * 180) / Math.PI);
    const hl = hairline(scalpStyle, phiDeg);
    const hm = smoothstep(hl - 0.004, hl + 0.006, y);
    if (hm > 0) col.lerp(hairCol, hm * (scalpStyle === 'buzz' ? 0.9 : 0.95));
    // lips
    if (r >= R_.lipLowBorder && r <= R_.lipUpBorder && as <= MOUTH_COL) {
      const taper = Math.pow(saturate(1 - (as / (MOUTH_COL + 0.4)) * (as / (MOUTH_COL + 0.4))), 0.6);
      if (tag === 'lipLowBorder' || tag === 'lipUpBorder') col.lerp(lipCol, 0.3 * taper);
      else if (tag === 'lipLowPeak' || tag === 'lipUpPeak') col.lerp(lipCol, 0.95 * taper);
      else if (tag === 'mLow' || tag === 'mUp') col.lerp(lipLine, as >= MOUTH_COL ? 0.75 : 0.92);
      else col.copy(mouthDark).lerp(lipCol, 0.25);
    }
    // eyes
    for (const sd of [1, -1]) {
      const es = s * sd;
      if (es < EYE_IN || es > EYE_OUT) continue;
      const inside = es > EYE_IN && es < EYE_OUT;
      if (tag === 'B') col.lerp(lash, inside ? 0.96 : 0.55);
      else if (tag === 'Bin') col.copy(lash);
      else if (tag === 'B2') col.lerp(lash, o.man ? 0.22 : 0.5).multiplyScalar(0.9);
      else if (tag === 'C') col.multiplyScalar(0.84);
      else if (tag === 'A') col.lerp(lash, inside ? (o.man ? 0.42 : 0.6) : 0.4);
      else if (tag === 'Ain') col.lerp(new THREE.Color(0x4a2620), 0.9);
      else if (tag === 'A2') col.multiplyScalar(0.9);
    }
    return col;
  };

  /* -------------------------------------------------------------- grid */
  const vid = new Int32Array(NR * NC).fill(-1);
  const vRow: number[] = [];
  const vCol: number[] = [];
  const aliasOf = (r: number, c: number): number => {
    const tag = ROWS[r][1];
    const as = Math.abs(sc(c));
    if ((tag === 'mLowIn' || tag === 'mUpIn' || tag === 'mUp') && as >= MOUTH_COL) return R_.mLow;
    if (tag === 'Ain' && !(as > EYE_IN && as < EYE_OUT)) return R_.A;
    if (tag === 'Bin' && !(as > EYE_IN && as < EYE_OUT)) return R_.B;
    return -1;
  };
  for (let r = 0; r < NR; r++) {
    for (let c = 0; c < NC; c++) {
      if (aliasOf(r, c) >= 0) continue;
      surf(sh, ROWS[r][0], phis[c], tmp);
      const tag = ROWS[r][1];
      if (tag === 'mLowIn') tmp.z -= 0.0042, (tmp.y -= 0.0002);
      if (tag === 'mUpIn') tmp.z -= 0.0042, (tmp.y += 0.0002);
      vid[r * NC + c] = b.v(tmp.x, tmp.y, tmp.z, skin);
      vRow.push(r);
      vCol.push(c);
    }
  }
  for (let r = 0; r < NR; r++) {
    for (let c = 0; c < NC; c++) {
      const a = aliasOf(r, c);
      if (a >= 0) vid[r * NC + c] = vid[a * NC + c];
    }
  }
  const gridCount = b.count;
  const V = (r: number, c: number): number => vid[r * NC + ((c + NC) % NC)];
  for (let r = 0; r < NR - 1; r++) {
    for (let c = 0; c < NC; c++) {
      const c2 = (c + 1) % NC;
      const s1 = sc(c);
      const s2 = sc(c2);
      if (r === R_.mLowIn && Math.abs(s1) <= MOUTH_COL && Math.abs(s2) <= MOUTH_COL && Math.abs(s1 - s2) === 1) continue;
      if (r === R_.Ain) {
        const inEye = (s: number): boolean => Math.abs(s) >= EYE_IN && Math.abs(s) <= EYE_OUT;
        if (inEye(s1) && inEye(s2) && Math.sign(s1) === Math.sign(s2)) continue;
      }
      b.quad(V(r, c), V(r, c2), V(r + 1, c2), V(r + 1, c));
    }
  }
  const bottomV = b.v(0, -0.0935, 0.06, skin);
  const topV = b.v(0, 0.15, -0.01, skin);
  for (let c = 0; c < NC; c++) {
    b.tri(bottomV, V(0, c + 1), V(0, c));
    b.tri(topV, V(NR - 1, c), V(NR - 1, c + 1));
  }

  /* -------------------------------------------------------------- eyes */
  const eyeH = sh.eyeH;
  const eyeCols: EyeCol[][] = [[], []];
  for (const side of [1, -1] as const) {
    const list = eyeCols[side === 1 ? 0 : 1];
    for (let k = EYE_IN; k <= EYE_OUT; k++) {
      const c = (side * k + NC) % NC;
      list.push({
        phi: phis[c],
        s: ((k - EYE_IN) / (EYE_OUT - EYE_IN)) * 2 - 1,
        A2: V(R_.A2, c),
        A: V(R_.A, c),
        Ain: V(R_.Ain, c),
        Bin: V(R_.Bin, c),
        B: V(R_.B, c),
        B2: V(R_.B2, c),
        C: V(R_.C, c),
        cRestY: ROWS[R_.C][0],
      });
    }
  }
  const lids = (pos: Float32Array, upL: number, upR: number, lowL: number, lowR: number, hoodL: number, hoodR: number): void => {
    for (let e = 0; e < 2; e++) {
      const up = clamp(e === 0 ? upL : upR, -1.2, 1);
      const low = clamp(e === 0 ? lowL : lowR, -0.6, 1.1);
      const hood = e === 0 ? hoodL : hoodR;
      for (const ec of eyeCols[e]) {
        const s = ec.s;
        const sU = s + 0.14 * (1 - s * s);
        const sL = s - 0.1 * (1 - s * s);
        const aU = Math.pow(Math.max(0, 1 - sU * sU), 0.62);
        const aL = Math.pow(Math.max(0, 1 - sL * sL), 0.8);
        const yc = EYE_Y + 0.0013 * s;
        const openU = yc + 0.0056 * eyeH * aU;
        const openL = yc - 0.0051 * eyeH * aL;
        const closed = yc - 0.0028 * aL;
        let yL = openL + low * 0.0043 * aL;
        let yU = up >= 0 ? lerp(openU, closed, up) : openU - up * 0.0046 * aU;
        if (yL > yc + 0.002 * aL) yL = yc + 0.002 * aL;
        if (yU < yL + 0.00025) yU = yL + 0.00025;
        const put = (vi: number, y: number, dz: number): void => {
          surf(sh, y, ec.phi, tmp);
          pos[vi * 3] = tmp.x;
          pos[vi * 3 + 1] = y;
          pos[vi * 3 + 2] = tmp.z + dz;
        };
        put(ec.B, yU, 0.0003);
        if (ec.Bin !== ec.B) put(ec.Bin, yU - 0.0003, -0.0014);
        const yB2 = yU + 0.0027 * (0.3 + 0.7 * aU);
        put(ec.B2, yB2, 0);
        put(ec.C, Math.max(ec.cRestY + 0.0006 * s - hood * 0.0022 * aU, yB2 + 0.0012), 0);
        put(ec.A, yL, 0.0002);
        if (ec.Ain !== ec.A) put(ec.Ain, yL + 0.0003, -0.0013);
        put(ec.A2, yL - 0.003 * (0.3 + 0.7 * aL), 0);
      }
    }
  };
  // rest positions of the lids
  {
    const arr = new Float32Array(b.pos);
    lids(arr, 0, 0, 0, 0, 0, 0);
    for (let i = 0; i < arr.length; i++) b.pos[i] = arr[i];
  }

  // paint the grid
  for (let i = 0; i < gridCount; i++) {
    const c = colorAt(vRow[i], vCol[i], b.pos[i * 3], b.pos[i * 3 + 1], b.pos[i * 3 + 2]);
    b.col[i * 3] = c.r;
    b.col[i * 3 + 1] = c.g;
    b.col[i * 3 + 2] = c.b;
  }
  {
    const c = colorAt(0, 0, 0, -0.0935, 0.06);
    b.col[bottomV * 3] = c.r;
    b.col[bottomV * 3 + 1] = c.g;
    b.col[bottomV * 3 + 2] = c.b;
    const hc = scalpStyle === 'buzz' ? skin.clone().lerp(hairCol, 0.9) : hairCol;
    b.col[topV * 3] = hc.r;
    b.col[topV * 3 + 1] = hc.g;
    b.col[topV * 3 + 2] = hc.b;
  }

  /* ---------------------------------------------------- mouth interior */
  const jawIdx: number[] = [];
  const jawW: number[] = [];
  {
    // dark pocket behind the lips (faces inward, so it is only ever seen through the mouth)
    const from = b.count;
    const rings: Ring[] = [];
    for (const [z, s] of [
      [0.09, 1],
      [0.075, 1],
      [0.055, 0.85],
      [0.042, 0.5],
    ] as Array<[number, number]>) {
      rings.push({ c: [0, -0.052, z], rx: 0.042 * s, rz: 0.032 * s, u: [1, 0, 0], v: [0, 1, 0], col: mouthDark });
    }
    loft(b, rings, { segs: 12, capEnd: true, flip: false });
    for (let i = from; i < b.count; i++) b.pos[i * 3 + 2] -= 12 * b.pos[i * 3] * b.pos[i * 3];
    // teeth
    const strip = (y0: number, y1: number, z0: number, c0: THREE.Color, c1: THREE.Color, jaw: boolean): void => {
      const n = 8;
      const first = b.count;
      for (let i = 0; i <= n; i++) {
        const x = lerp(-0.0235, 0.0235, i / n);
        const z = z0 - 13 * x * x;
        const sideDark = 1 - 0.45 * Math.pow(Math.abs(x) / 0.0235, 1.5);
        b.v(x, y0, z, c0.clone().multiplyScalar(sideDark));
        b.v(x, y1, z + 0.0005, c1.clone().multiplyScalar(sideDark));
      }
      for (let i = 0; i < n; i++) {
        const a = first + i * 2;
        b.quad(a, a + 2, a + 3, a + 1);
      }
      if (jaw) for (let i = first; i < b.count; i++) jawIdx.push(i), jawW.push(1);
    };
    strip(-0.0422, -0.0335, 0.0935, tooth, tooth.clone().multiplyScalar(0.7), false);
    strip(-0.0505, -0.0412, 0.0915, tooth.clone().multiplyScalar(0.5), tooth.clone().multiplyScalar(0.8), true);
    // tongue
    const t0 = b.count;
    ellipsoid(b, [0, -0.0505, 0.068], 0.019, 0.006, 0.024, new THREE.Color(0x5a2424), undefined, 8, 4);
    for (let i = t0; i < b.count; i++) jawIdx.push(i), jawW.push(1);
  }

  /* ------------------------------------------------------------- brows */
  const brows: Brow[] = [];
  for (const side of [1, -1] as const) {
    const N = 8;
    const br: Brow = { side, vi: [], s: [], x0: [], y0: [], z0: [], th: [] };
    const xin = o.man ? 0.0105 : 0.012;
    const xout = o.man ? 0.061 : 0.058;
    const yb = o.man ? 0.0528 : 0.0548;
    const first = b.count;
    // stations ordered by increasing x so the winding is the same on both sides
    for (let i = 0; i < N; i++) {
      const k = side === 1 ? i : N - 1 - i;
      const s = k / (N - 1);
      const x = side * lerp(xin, xout, s);
      const arch = o.man ? 0.0028 * Math.sin(Math.PI * Math.pow(s, 0.8)) - 0.0042 * s * s : 0.0046 * Math.sin(Math.PI * Math.pow(s, 0.75)) - 0.004 * s * s;
      const y = yb + arch;
      const th = (o.man ? 0.0043 : 0.0026) * (1 - 0.6 * s) * (0.75 + 0.25 * smoothstep(0, 0.12, s));
      const z = surfXY(sh, x, y);
      br.s.push(s);
      br.x0.push(x);
      br.y0.push(y);
      br.z0.push(z);
      br.th.push(th);
      br.vi.push(b.v(x, y - th, z + 0.0006, browCol), b.v(x, y, z + 0.0034, browCol), b.v(x, y + th, z + 0.0006, browCol));
    }
    for (let i = 0; i < N - 1; i++) {
      const a = first + i * 3;
      b.quad(a, a + 3, a + 4, a + 1);
      b.quad(a + 1, a + 4, a + 5, a + 2);
    }
    b.tri(first, first + 1, first + 2);
    const l = first + (N - 1) * 3;
    b.tri(l, l + 2, l + 1);
    brows.push(br);
  }

  /* -------------------------------------------- expression channels */
  const chIdx: number[][] = [];
  const chDel: number[][] = [];
  for (let k = 0; k < CH_TOTAL; k++) chIdx.push([]), chDel.push([]);
  const add = (k: number, vi: number, dx: number, dy: number, dz: number): void => {
    if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) < 2e-5) return;
    chIdx[k].push(vi);
    chDel[k].push(dx, dy, dz);
  };
  const xk = b.pos[V(R_.mLow, MOUTH_COL) * 3];
  for (let i = 0; i < gridCount; i++) {
    const r = vRow[i];
    const c = vCol[i];
    const x = b.pos[i * 3];
    const y = b.pos[i * 3 + 1];
    const z = b.pos[i * 3 + 2];
    const as = Math.abs(sc(c));
    const ff = smoothstep(0.015, 0.06, z);
    if (ff <= 0) continue;
    const isUpper = r >= R_.mUpIn && as < MOUTH_COL ? true : r > R_.mUp;
    const isLower = r <= R_.mLowIn && as < MOUTH_COL ? true : r < R_.mLow;
    const wyU = isUpper ? smoothstep(-0.015, -0.036, y) : 0;
    const wyL = isLower ? smoothstep(-0.062, -0.041, y) : 0;
    if (y < 0.03) {
      for (const s of [1, -1]) {
        const L = s === 1;
        const cw = gauss2(x - s * xk, 0.016, y - Y_MOUTH, 0.017) * ff;
        const chk = gauss2(x - s * 0.044, 0.019, y + 0.01, 0.019) * ff;
        add(L ? FC.smileL : FC.smileR, i, s * (0.0075 * cw + 0.002 * chk), 0.0105 * cw + 0.004 * chk, -0.0055 * cw + 0.003 * chk);
        add(L ? FC.frownL : FC.frownR, i, s * 0.002 * cw, -0.0085 * cw, -0.002 * cw);
        add(L ? FC.stretchL : FC.stretchR, i, s * 0.0085 * cw, -0.0015 * cw, -0.007 * cw);
        const uw = gauss(x - s * 0.013, 0.012) * wyU * ff;
        const nw = gauss2(x - s * 0.017, 0.012, y + 0.012, 0.012) * ff;
        add(L ? FC.sneerL : FC.sneerR, i, s * 0.0008 * nw, 0.0075 * uw + 0.0035 * nw, -0.001 * uw + 0.001 * nw);
        const c2 = gauss2(x - s * 0.042, 0.02, y - 0.002, 0.016) * ff;
        add(L ? FC.cheekL : FC.cheekR, i, 0, 0.0035 * c2, 0.003 * c2);
      }
      const lw = gauss2(x, 0.032, y - Y_MOUTH, 0.013) * ff;
      add(FC.pucker, i, -x * 0.3 * lw, 0, 0.0045 * lw);
      add(FC.upperLipUp, i, 0, 0.0055 * gauss(x, 0.02) * wyU * ff, 0);
      add(FC.lowerLipDrop, i, 0, -0.0065 * wyL * gauss(x, 0.024) * ff, -0.0005 * wyL);
      add(FC.lipsPart, i, 0, (0.0016 * wyU - 0.0024 * wyL) * gauss(x, 0.026) * ff, 0);
      {
        const taper = Math.pow(saturate(1 - (x / (xk * 1.02)) * (x / (xk * 1.02))), 0.6);
        let dy = 0;
        let dz = 0;
        if (r === R_.lipUpBorder || r === R_.lipUpPeak || r === R_.lipLowPeak || r === R_.lipLowBorder) {
          dy = -(y - Y_MOUTH) * 0.5 * taper;
          dz = (r === R_.lipUpPeak ? -0.0024 : r === R_.lipLowPeak ? -0.0032 : -0.001) * taper;
        }
        const cwL = gauss2(Math.abs(x) - xk, 0.012, y - Y_MOUTH, 0.012) * ff;
        add(FC.lipPress, i, Math.sign(x) * 0.0018 * cwL, dy, dz - 0.0008 * cwL);
      }
      {
        const cW = gauss2(x, 0.03, y + 0.066, 0.016) * ff;
        const g = isLower && y > -0.051 ? gauss(x, 0.022) * ff : 0;
        add(FC.chinRaise, i, 0, 0.004 * cW + 0.0022 * g, 0.002 * cW + 0.0018 * g);
      }
      add(FC.mouthX, i, 0.006 * gauss2(x, 0.045, y - Y_MOUTH, 0.03) * ff, 0, 0);
    }
    if (y > 0.036 && y < 0.085) {
      for (const s of [1, -1]) {
        const L = s === 1;
        const bw = gauss(y - 0.053, 0.011) * smoothstep(-0.004, 0.008, s * x) * (1 - smoothstep(0.062, 0.076, Math.abs(x))) * ff;
        if (bw < 0.01) continue;
        const sB = clamp((Math.abs(x) - 0.011) / 0.049, 0, 1);
        add(L ? FC.browRaiseL : FC.browRaiseR, i, 0, 0.009 * 0.55 * bw, 0);
        add(L ? FC.browInnerL : FC.browInnerR, i, 0, 0.008 * Math.pow(1 - sB, 1.6) * 0.55 * bw, 0);
        add(L ? FC.browOuterL : FC.browOuterR, i, 0, 0.006 * Math.pow(sB, 1.5) * 0.5 * bw, 0);
        add(L ? CH_FURROW_L : CH_FURROW_R, i, -s * 0.0028 * (1 - sB) * bw, -0.001 * (1 - sB) * bw, 0.0018 * gauss2(x, 0.014, y - 0.05, 0.01));
      }
    }
    // jaw weight
    {
      const t = smoothstep(0.55 * xk, 1.2 * xk, Math.abs(x));
      const soft = smoothstep(Y_MOUTH + 0.022, Y_MOUTH - 0.02, y);
      const hard = isLower || (r <= R_.mLow && as >= MOUTH_COL && y < Y_MOUTH - 0.001) ? 1 : 0;
      let w = lerp(hard, soft, t);
      w *= lerp(smoothstep(-0.02, 0.03, z), 1, smoothstep(-0.045, -0.055, y));
      if (w > 0.003) jawIdx.push(i), jawW.push(w);
    }
  }
  // under-jaw vertices that the front-facing loop skipped
  {
    const have = new Set(jawIdx);
    for (let i = 0; i < gridCount; i++) {
      if (have.has(i)) continue;
      const y = b.pos[i * 3 + 1];
      const z = b.pos[i * 3 + 2];
      const w = smoothstep(-0.045, -0.055, y) * smoothstep(-0.03, 0.0, z);
      if (w > 0.003) jawIdx.push(i), jawW.push(w);
    }
    if (!have.has(bottomV)) jawIdx.push(bottomV), jawW.push(1);
  }

  const dynCount = b.count;

  /* ----------------------------------------------- ears, hair, extras */
  for (const s of [1, -1]) {
    const from = b.count;
    ellipsoid(b, [0, 0, 0], 0.0055, 0.0275, 0.0145, skin.clone().lerp(blush, 0.35), undefined, 8, 6);
    profile(sh, 0.017, _p);
    const m = new THREE.Matrix4()
      .makeTranslation(s * (_p[1] + 0.0022), 0.016, -0.016)
      .multiply(new THREE.Matrix4().makeRotationY(-s * 0.32))
      .multiply(new THREE.Matrix4().makeRotationX(-0.12));
    b.transform(from, m);
  }
  buildHair(b, sh, o, hairCol, skin);
  if (o.headphones) {
    const dark = new THREE.Color(0x15161a);
    profile(sh, 0.017, _p);
    const W = _p[1];
    for (const s of [1, -1]) {
      const from = b.count;
      ellipsoid(b, [0, 0, 0], 0.017, 0.04, 0.034, dark, undefined, 10, 6);
      b.transform(from, new THREE.Matrix4().makeTranslation(s * (W + 0.016), 0.017, -0.014));
    }
    const pts: V3[] = [];
    for (let i = 0; i <= 12; i++) {
      const a = lerp(-0.12, Math.PI + 0.12, i / 12);
      pts.push([Math.cos(a) * (W + 0.02), 0.035 + Math.sin(a) * 0.135, -0.014]);
    }
    tubePath(b, pts, 0.013, 0.0045, dark, [], 6, true, [0, 0, 1]);
  }

  /* ----------------------------------------------------------- mesh */
  const geometry = b.build({ dynamic: true });
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.02, 0), 0.26);
  const mesh = new THREE.Mesh(geometry, o.material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
  const pos = posAttr.array as Float32Array;
  const rest = new Float32Array(pos);
  const chI = chIdx.map((a) => Uint16Array.from(a));
  const chD = chDel.map((a) => Float32Array.from(a));
  const jI = Uint16Array.from(jawIdx);
  const jW = Float32Array.from(jawW);
  const dynFloats = dynCount * 3;

  /* ----------------------------------------------------------- eyes */
  const eyeGeo = buildEyeGeometry(o.man);
  const eyeL = new THREE.Mesh(eyeGeo, o.eyeMaterial);
  const eyeR = new THREE.Mesh(eyeGeo, o.eyeMaterial);
  const eyeCenterL = new THREE.Vector3(EYE_X, EYE_Y, sh.zEye);
  const eyeCenterR = new THREE.Vector3(-EYE_X, EYE_Y, sh.zEye);
  eyeL.position.copy(eyeCenterL);
  eyeR.position.copy(eyeCenterR);
  eyeL.rotation.order = 'YXZ';
  eyeR.rotation.order = 'YXZ';
  mesh.add(eyeL, eyeR);

  const w = new Float32Array(CH_TOTAL);
  let lastKey = '';

  const apply = (ch: Float32Array): void => {
    for (let k = 0; k < FACE_CHANNELS; k++) w[k] = ch[k];
    w[CH_FURROW_L] = Math.max(0, -ch[FC.browInnerL]);
    w[CH_FURROW_R] = Math.max(0, -ch[FC.browInnerR]);
    // skip the work when nothing moved
    let key = '';
    for (let k = 0; k < CH_TOTAL; k++) key += ((w[k] * 400) | 0) + ',';
    if (key === lastKey) return;
    lastKey = key;

    pos.set(rest.subarray(0, dynFloats));
    for (let k = 0; k < CH_TOTAL; k++) {
      const wk = w[k];
      if (wk > -1e-4 && wk < 1e-4) continue;
      const idx = chI[k];
      const del = chD[k];
      for (let j = 0; j < idx.length; j++) {
        const vi = idx[j] * 3;
        pos[vi] += del[j * 3] * wk;
        pos[vi + 1] += del[j * 3 + 1] * wk;
        pos[vi + 2] += del[j * 3 + 2] * wk;
      }
    }
    const open = clamp(w[FC.jawOpen], -0.1, 1.25) * JAW_MAX;
    const jx = w[FC.jawSide] * 0.0048;
    const jz = w[FC.jawFwd] * 0.004;
    if (open !== 0 || jx !== 0 || jz !== 0) {
      for (let j = 0; j < jI.length; j++) {
        const vi = jI[j] * 3;
        const wt = jW[j];
        const a = open * wt;
        const cs = Math.cos(a);
        const sn = Math.sin(a);
        const y = pos[vi + 1] - JAW_Y;
        const z = pos[vi + 2] - JAW_Z;
        pos[vi] += jx * wt;
        pos[vi + 1] = JAW_Y + y * cs - z * sn;
        pos[vi + 2] = JAW_Z + y * sn + z * cs + jz * wt;
      }
    }
    lids(
      pos,
      w[FC.lidUpL],
      w[FC.lidUpR],
      w[FC.lidLowL] + 0.45 * w[FC.cheekL] + 0.12 * w[FC.smileL],
      w[FC.lidLowR] + 0.45 * w[FC.cheekR] + 0.12 * w[FC.smileR],
      w[CH_FURROW_L] - Math.min(0, w[FC.browRaiseL]),
      w[CH_FURROW_R] - Math.min(0, w[FC.browRaiseR]),
    );
    for (const br of brows) {
      const L = br.side === 1;
      const raise = w[L ? FC.browRaiseL : FC.browRaiseR];
      const inner = w[L ? FC.browInnerL : FC.browInnerR];
      const outer = w[L ? FC.browOuterL : FC.browOuterR];
      for (let i = 0; i < br.s.length; i++) {
        const s = br.s[i];
        const dy = 0.009 * raise + 0.008 * inner * Math.pow(1 - s, 1.6) + 0.006 * outer * Math.pow(s, 1.5);
        const dx = br.side * inner * (inner < 0 ? 0.0036 : 0.001) * (1 - s);
        const x = br.x0[i] + dx;
        const y = br.y0[i] + dy;
        const th = br.th[i] * (1 + 0.2 * Math.max(0, -inner) * (1 - s));
        // follow the forehead: half the surface change, since the skin travels with the brow
        const z = br.z0[i] + 0.5 * (surfXY(sh, x, y) - br.z0[i]) + Math.max(0, -inner) * 0.0016 * (1 - s) + Math.max(0, -raise) * 0.001;
        const v0 = br.vi[i * 3] * 3;
        pos[v0] = x;
        pos[v0 + 1] = y - th;
        pos[v0 + 2] = z + 0.0006;
        pos[v0 + 3] = x;
        pos[v0 + 4] = y;
        pos[v0 + 5] = z + 0.0034;
        pos[v0 + 6] = x;
        pos[v0 + 7] = y + th;
        pos[v0 + 8] = z + 0.0006;
      }
    }
    posAttr.needsUpdate = true;
    geometry.computeVertexNormals();
  };

  apply(new Float32Array(FACE_CHANNELS));

  return {
    mesh,
    eyeL,
    eyeR,
    eyeCenterL,
    eyeCenterR,
    apply,
    dispose(): void {
      geometry.dispose();
      eyeGeo.dispose();
    },
  };
}

/* ------------------------------------------------------------------ hair */

const HAIRLINES: Record<string, Array<[number, number]>> = {
  short: [
    [0, 0.093],
    [25, 0.095],
    [45, 0.09],
    [58, 0.074],
    [68, 0.046],
    [76, 0.018],
    [84, 0.022],
    [92, 0.046],
    [104, 0.05],
    [114, 0.024],
    [128, -0.006],
    [150, -0.02],
    [180, -0.024],
  ],
  ponytail: [
    [0, 0.097],
    [30, 0.097],
    [50, 0.088],
    [64, 0.066],
    [74, 0.044],
    [84, 0.04],
    [92, 0.048],
    [104, 0.05],
    [114, 0.022],
    [128, -0.014],
    [150, -0.032],
    [180, -0.036],
  ],
  long: [
    [0, 0.097],
    [25, 0.094],
    [42, 0.082],
    [52, 0.058],
    [60, 0.03],
    [180, 0.03],
  ],
  beanieEdge: [
    [0, 0.071],
    [40, 0.069],
    [70, 0.052],
    [90, 0.036],
    [110, 0.027],
    [140, 0.008],
    [180, 0.002],
  ],
};
HAIRLINES.buzz = HAIRLINES.short.map(([a, y]) => [a, y - 0.002] as [number, number]);
HAIRLINES.buzz[0][1] = 0.09;
HAIRLINES.buzz[1][1] = 0.092;

/** Where a hanging curtain of long hair ends, by meridian. */
const LONG_END: Array<[number, number]> = [
  [0, 0.097],
  [25, 0.094],
  [42, 0.082],
  [50, 0.06],
  [58, -0.055],
  [70, -0.1],
  [90, -0.122],
  [180, -0.126],
];

function buildHair(b: GeoBuilder, sh: Shape, o: FaceOptions, hairCol: THREE.Color, skin: THREE.Color): void {
  const style = o.hairStyle === 'hood_down' ? 'short' : o.hairStyle;
  const p = new THREE.Vector3();
  const pa = new THREE.Vector3();
  const pb = new THREE.Vector3();
  const n = new THREE.Vector3();
  const beanie = style === 'beanie';
  const NH = style === 'long' ? 48 : 40;
  const NT = style === 'long' ? 13 : 9;
  const crownY = 0.1495;
  const capCol = beanie ? new THREE.Color(0x1b1d22) : hairCol;

  const edgeY = (deg: number): number => {
    if (beanie) return curve(HAIRLINES.beanieEdge, deg);
    if (style === 'long') return curve(LONG_END, deg);
    return curve(HAIRLINES[style] ?? HAIRLINES.short, deg);
  };
  const thick = (deg: number, y: number, t: number): number => {
    const top = smoothstep(0.06, 0.13, y);
    let T: number;
    if (style === 'buzz') T = 0.0028;
    else if (beanie) T = 0.0105 + 0.006 * smoothstep(0.1, 0.15, y) + (t > 0.74 ? 0.0045 : 0);
    else if (style === 'ponytail') T = 0.0065 + 0.004 * top;
    else if (style === 'long') T = 0.011 + 0.006 * top + 0.004 * smoothstep(0.02, -0.06, y);
    else T = 0.0075 + 0.0085 * top + 0.007 * gauss(deg, 38) * gauss(y - 0.106, 0.022);
    if (!beanie && style !== 'buzz') T *= 1 + 0.14 * Math.sin(deg * 0.31 + y * 140) * Math.sin(deg * 0.117 + 1.3);
    if (!beanie) T *= lerp(0.06, 1, smoothstep(1.0, style === 'long' ? 0.93 : 0.84, t));
    return T;
  };
  const point = (phi: number, y: number, T: number, out: THREE.Vector3): void => {
    const yRef = 0.012;
    if (y >= yRef) {
      surf(sh, y, phi, out, false);
      const dphi = 0.02;
      surf(sh, y, phi + dphi, pa, false);
      surf(sh, y, phi - dphi, pb, false);
      const tx = pa.x - pb.x;
      const tz = pa.z - pb.z;
      surf(sh, Math.min(0.1499, y + 0.004), phi, pa, false);
      surf(sh, y - 0.004, phi, pb, false);
      // normal = d/dphi x d/dy
      n.set(tx, 0, tz).cross(pa.sub(pb)).normalize();
      // near the crown the grid pinches; lean on straight-up there
      const up = smoothstep(0.125, 0.1499, y);
      n.lerp(new THREE.Vector3(0, 1, 0), up).normalize();
      out.addScaledVector(n, T);
    } else {
      // free-hanging: keep the outline of the head at ear height, drawn in slightly lower down
      surf(sh, yRef, phi, out, false);
      const k = 1 - 0.13 * saturate((yRef - y) / 0.14);
      const cz = -0.006;
      const rx = out.x;
      const rz = out.z - cz;
      const len = Math.hypot(rx, rz) || 1;
      out.set((rx * k) + (rx / len) * T, y, cz + rz * k + (rz / len) * T - 0.006 * saturate((yRef - y) / 0.1));
    }
  };

  const first = b.count;
  const top = b.v(0, crownY + thick(0, crownY, 0) + (beanie ? 0.004 : 0), -0.01 - (beanie ? 0.006 : 0), capCol);
  const rows: number[][] = [];
  for (let k = 1; k <= NT; k++) {
    const t = k / NT;
    const row: number[] = [];
    for (let c = 0; c < NH; c++) {
      const phi = (c / NH) * Math.PI * 2;
      const deg = Math.abs((((phi * 180) / Math.PI + 180) % 360) - 180);
      const yEnd = edgeY(deg);
      const tt = Math.pow(t, 0.85);
      const y = lerp(crownY, yEnd, tt);
      const T = thick(deg, y, t);
      point(phi, y, T, p);
      const shadeF = 0.8 + 0.22 * smoothstep(0.04, 0.13, y) + 0.07 * Math.sin(deg * 0.9 + y * 200);
      const col = capCol.clone().multiplyScalar(beanie ? (t > 0.74 ? 0.86 : 1) * (0.92 + 0.08 * Math.sin(c * 2.1)) : shadeF);
      if (!beanie && t > 0.99 && style !== 'long') col.lerp(skin, style === 'buzz' ? 0.5 : 0.25);
      if (style === 'buzz') col.lerp(skin, 0.06);
      row.push(b.v(p.x, p.y, p.z, col));
    }
    rows.push(row);
  }
  if (beanie) {
    // close the cuff back onto the head
    const row: number[] = [];
    for (let c = 0; c < NH; c++) {
      const phi = (c / NH) * Math.PI * 2;
      const deg = Math.abs((((phi * 180) / Math.PI + 180) % 360) - 180);
      point(phi, edgeY(deg) + 0.001, 0.0005, p);
      row.push(b.v(p.x, p.y, p.z, capCol.clone().multiplyScalar(0.6)));
    }
    rows.push(row);
  }
  for (let c = 0; c < NH; c++) b.tri(top, rows[0][c], rows[0][(c + 1) % NH]);
  for (let k = 0; k < rows.length - 1; k++) {
    for (let c = 0; c < NH; c++) {
      const c2 = (c + 1) % NH;
      b.quad(rows[k][c], rows[k][c2], rows[k + 1][c2], rows[k + 1][c], true);
    }
  }
  void first;

  if (style === 'ponytail') {
    const pts: V3[] = [
      [0, 0.108, -0.092],
      [0, 0.106, -0.118],
      [0, 0.085, -0.138],
      [0, 0.04, -0.14],
      [0, -0.02, -0.128],
      [0, -0.075, -0.112],
      [0, -0.105, -0.104],
    ];
    const rs = [0.014, 0.019, 0.026, 0.025, 0.02, 0.012, 0.004];
    tubePath(b, pts, rs, rs.map((r) => r * 0.85), hairCol.clone().multiplyScalar(0.92), [], 8, true, [1, 0, 0]);
    // hair tie
    tubePath(
      b,
      [
        [0, 0.108, -0.1],
        [0, 0.107, -0.112],
      ],
      0.0165,
      0.0165,
      new THREE.Color(0x15161a),
      [],
      8,
      true,
      [1, 0, 0],
    );
  }
}

/* ------------------------------------------------------------------ eyes */

function buildEyeGeometry(man: boolean): THREE.BufferGeometry {
  const b = new GeoBuilder(false);
  const sclera = new THREE.Color(0xece8df);
  const scleraEdge = new THREE.Color(0xb8b0a6);
  const iris = new THREE.Color(man ? 0x3a2414 : 0x40291a);
  const irisIn = new THREE.Color(man ? 0x5c3c20 : 0x6a4526);
  const limbus = new THREE.Color(0x120a06);
  const pupil = new THREE.Color(0x030202);
  // polar angle (deg from the +Z pole) -> colour
  const bands: Array<[number, THREE.Color]> = [
    [6, pupil],
    [11, pupil],
    [13, irisIn],
    [23, iris],
    [30, iris.clone().multiplyScalar(0.7)],
    [33, limbus],
    [36, sclera],
    [52, sclera],
    [72, sclera.clone().lerp(scleraEdge, 0.5)],
    [92, scleraEdge],
    [115, scleraEdge],
    [140, scleraEdge],
  ];
  const segs = 16;
  const pole = b.v(0, 0, R_EYE, pupil);
  const rows: number[][] = [];
  for (const [deg, col] of bands) {
    const a = (deg * Math.PI) / 180;
    const row: number[] = [];
    for (let i = 0; i < segs; i++) {
      const t = (i / segs) * Math.PI * 2;
      row.push(b.v(R_EYE * Math.sin(a) * Math.cos(t), R_EYE * Math.sin(a) * Math.sin(t), R_EYE * Math.cos(a), col));
    }
    rows.push(row);
  }
  for (let i = 0; i < segs; i++) b.tri(pole, rows[0][i], rows[0][(i + 1) % segs]);
  for (let k = 0; k < rows.length - 1; k++) {
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % segs;
      b.quad(rows[k][i], rows[k + 1][i], rows[k + 1][j], rows[k][j]);
    }
  }
  return b.build();
}

export const FACE_CONST = { EYE_X, EYE_Y, R_EYE };
