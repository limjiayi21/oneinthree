/**
 * Pose data: the body-pose parameter vector, posture presets, the body and
 * face presets for each emotion, and the gesture timelines.
 *
 * Arms are authored as hand targets, not joint angles: a hand position relative
 * to its own shoulder in a mirrored "canonical" frame (x = out to the side,
 * y = up, z = forward, metres at reference-man scale), an elbow direction hint,
 * and a wrist rotation. Both arms use the same numbers for a symmetric pose.
 */
import type { Emotion } from '../../shared/types';
import type { Gesture, Posture } from '../contracts';
import { FC } from './face';
import { ease, envelope, lerp, saturate, scurve, smoothstep } from './util';

/* ------------------------------------------------------------ pose vector */

export const ARM = {
  hx: 0,
  hy: 1,
  hz: 2,
  px: 3,
  py: 4,
  pz: 5,
  /** wrist: deviation (x), twist (y, + = palm turns forward/up), flex (z, + = toward the palm) */
  wx: 6,
  wy: 7,
  wz: 8,
  curl: 9,
  point: 10,
  thumb: 11,
  /** 0 = target hangs under the shoulder regardless of torso lean, 1 = target moves with the chest */
  chest: 12,
} as const;
export const ARM_N = 13;

export const P = {
  hipsX: 0,
  hipsY: 1,
  hipsZ: 2,
  /** + = forward */
  hipsPitch: 3,
  /** + = toward the character's left */
  hipsYaw: 4,
  /** + = left hip up */
  hipsRoll: 5,
  spinePitch: 6,
  spineYaw: 7,
  spineRoll: 8,
  chestPitch: 9,
  chestYaw: 10,
  chestRoll: 11,
  /** + = chin down */
  headNod: 12,
  /** + = toward the character's left */
  headTurn: 13,
  /** + = top of the head toward the character's right shoulder */
  headTilt: 14,
  /** + = head pushed forward on the neck, - = pulled back */
  headFwd: 15,
  clavUpL: 16,
  clavFwdL: 17,
  clavUpR: 18,
  clavFwdR: 19,
  armL: 20,
  armR: 33,
  /** feet: x (out), y (lift), z (forward), pitch (+ toes down), yaw (+ toes out) */
  footL: 46,
  footR: 51,
  /** arm swing multiplier while walking */
  swing: 56,
  N: 57,
} as const;

export type PoseVec = Float32Array;

const ARM_REST = [0.045, -0.572, 0.05, 0.3, 0, -1, 0, 0, 0, 0.38, 0, 0.25, 0];

function basePose(): PoseVec {
  const p = new Float32Array(P.N);
  p.set(ARM_REST, P.armL);
  p.set(ARM_REST, P.armR);
  p.set([0.105, 0, 0, 0, 0.14], P.footL);
  p.set([0.105, 0, 0, 0, 0.14], P.footR);
  p[P.swing] = 1;
  return p;
}

function arm(p: PoseVec, which: 'L' | 'R', v: Partial<Record<keyof typeof ARM, number>>): void {
  const o = which === 'L' ? P.armL : P.armR;
  for (const k in v) p[o + ARM[k as keyof typeof ARM]] = v[k as keyof typeof ARM]!;
}

/** The wall a `lean_wall` character rests on is this far behind the root origin (metres, reference scale). */
export const LEAN_WALL_OFFSET = 0.37;

export const POSTURES: Record<Posture, PoseVec> = (() => {
  const stand = basePose();

  const relaxed = basePose();
  relaxed[P.hipsX] = 0.034;
  relaxed[P.hipsY] = -0.012;
  relaxed[P.hipsRoll] = 0.055;
  relaxed[P.spineRoll] = -0.045;
  relaxed[P.chestRoll] = -0.02;
  relaxed[P.spinePitch] = -0.02;
  relaxed[P.clavUpR] = -0.1;
  relaxed.set([0.095, 0, -0.015, 0, 0.1], P.footL);
  relaxed.set([0.15, 0, 0.1, 0, 0.36], P.footR);
  // right thumb hooked in the pocket
  arm(relaxed, 'R', { hx: -0.035, hy: -0.492, hz: 0.125, px: 0.9, py: 0, pz: -0.5, wy: -0.5, wz: 0.25, curl: 0.55, thumb: 0 });
  arm(relaxed, 'L', { hx: 0.05, hy: -0.57, hz: 0.03 });
  relaxed[P.swing] = 0.85;

  const lean = basePose();
  lean[P.hipsZ] = -0.2;
  lean[P.hipsY] = -0.04;
  lean[P.hipsYaw] = 0.1;
  lean[P.hipsPitch] = -0.05;
  lean[P.spinePitch] = -0.05;
  lean[P.chestPitch] = 0.04;
  lean[P.chestYaw] = 0.16;
  lean[P.spineRoll] = 0.03;
  lean[P.headFwd] = 0.35;
  lean[P.headNod] = 0.04;
  lean.set([0.1, 0, 0.04, 0, 0.16], P.footL);
  // right sole flat on the wall behind him
  lean.set([0.1, 0.235, -0.27, 1.25, 0.05], P.footR);
  arm(lean, 'L', { hx: -0.285, hy: -0.2, hz: 0.175, px: 0.75, py: -0.65, pz: 0.2, wy: -0.4, wz: 0.35, curl: 0.55, thumb: 0.5, chest: 1 });
  arm(lean, 'R', { hx: -0.25, hy: -0.265, hz: 0.15, px: 0.75, py: -0.65, pz: 0.2, wy: -0.3, wz: 0.3, curl: 0.5, thumb: 0.5, chest: 1 });
  lean[P.swing] = 0.2;

  const aggressive = basePose();
  aggressive[P.hipsY] = -0.03;
  aggressive[P.hipsZ] = 0.02;
  aggressive[P.spinePitch] = 0.13;
  aggressive[P.chestPitch] = -0.02;
  aggressive[P.headFwd] = 0.55;
  aggressive[P.headNod] = 0.06;
  aggressive[P.clavUpL] = aggressive[P.clavUpR] = 0.3;
  aggressive[P.clavFwdL] = aggressive[P.clavFwdR] = 0.4;
  aggressive.set([0.14, 0, 0.1, 0, 0.18], P.footL);
  aggressive.set([0.145, 0, -0.08, 0, 0.3], P.footR);
  for (const s of ['L', 'R'] as const) arm(aggressive, s, { hx: 0.1, hy: -0.52, hz: 0.1, px: 0.8, py: 0.05, pz: -0.7, wz: 0.15, curl: 0.92, thumb: 0.9 });
  aggressive[P.swing] = 0.75;

  const guarded = basePose();
  guarded[P.spinePitch] = 0.05;
  guarded[P.chestPitch] = 0.05;
  guarded[P.clavUpL] = guarded[P.clavUpR] = 0.35;
  guarded[P.clavFwdL] = guarded[P.clavFwdR] = 0.35;
  guarded[P.headNod] = 0.05;
  guarded.set([0.08, 0, 0, 0, 0.06], P.footL);
  guarded.set([0.085, 0, -0.03, 0, 0.1], P.footR);
  // left hand on the bag strap at the shoulder, right arm folded across the body
  arm(guarded, 'L', { hx: -0.05, hy: -0.115, hz: 0.135, px: 0.25, py: -1, pz: -0.25, wy: -0.2, wz: 0.3, curl: 0.9, thumb: 0.8, chest: 1 });
  arm(guarded, 'R', { hx: -0.22, hy: -0.31, hz: 0.15, px: 0.5, py: -0.85, pz: 0.1, wy: -0.4, wz: 0.3, curl: 0.55, thumb: 0.4, chest: 1 });
  guarded[P.swing] = 0.12;

  const cower = basePose();
  cower[P.hipsY] = -0.09;
  cower[P.hipsZ] = -0.06;
  cower[P.spinePitch] = 0.24;
  cower[P.chestPitch] = 0.12;
  cower[P.clavUpL] = cower[P.clavUpR] = 0.8;
  cower[P.clavFwdL] = cower[P.clavFwdR] = 0.65;
  cower[P.headNod] = 0.16;
  cower[P.headTurn] = 0.22;
  cower[P.headFwd] = -0.4;
  cower.set([0.09, 0, 0.03, 0, 0.05], P.footL);
  cower.set([0.1, 0, -0.11, 0, 0.2], P.footR);
  arm(cower, 'L', { hx: -0.1, hy: -0.075, hz: 0.2, px: 0.2, py: -1, pz: 0.05, wy: 0.3, wz: -0.4, curl: 0.55, thumb: 0.4, chest: 1 });
  arm(cower, 'R', { hx: -0.14, hy: -0.13, hz: 0.22, px: 0.25, py: -1, pz: 0.05, wy: 0.3, wz: -0.4, curl: 0.6, thumb: 0.4, chest: 1 });
  cower[P.swing] = 0.05;

  return { stand, relaxed, lean_wall: lean, aggressive, guarded, cower };
})();

/* ---------------------------------------------------------------- emotion */

type FaceSet = Partial<Record<keyof typeof FC, number>>;
type BodySet = Partial<Record<Exclude<keyof typeof P, 'armL' | 'armR' | 'footL' | 'footR' | 'N'>, number>>;
type ArmSet = Partial<Record<keyof typeof ARM, number>>;

export interface EmotionDef {
  face: FaceSet;
  /** Added in proportion to the talk level (e.g. bared teeth when he speaks in anger). */
  talkFace?: FaceSet;
  body?: BodySet;
  /** Additive on both arms. */
  arms?: ArmSet;
  blink?: number;
  saccade?: number;
  breathRate?: number;
  breathAmp?: number;
  sway?: number;
  tremor?: number;
}

export const EMOTIONS: Record<Emotion, EmotionDef> = {
  neutral: { face: {} },

  // fake charm: the mouth does all the smiling, the eyes stay flat and a little too open
  friendly: {
    face: {
      smileL: 0.95,
      smileR: 0.95,
      lipsPart: 0.75,
      upperLipUp: 0.4,
      jawOpen: 0.1,
      browRaiseL: 0.5,
      browRaiseR: 0.5,
      browOuterL: 0.2,
      browOuterR: 0.2,
      lidUpL: -0.2,
      lidUpR: -0.2,
      lidLowL: -0.25,
      lidLowR: -0.25,
    },
    body: { headTilt: 0.12, headNod: 0.03, headFwd: 0.4, spinePitch: 0.05, clavUpL: 0.15, clavUpR: 0.15 },
    arms: { hx: 0.06, hz: 0.06, hy: 0.02, wy: 0.7, curl: -0.2 },
    blink: 1.1,
  },

  smirk: {
    face: {
      smileL: 1.05,
      smileR: 0.0,
      frownR: 0.18,
      mouthX: 0.6,
      lipPress: 0.3,
      cheekL: 0.5,
      lidLowL: 0.25,
      browRaiseL: 0.6,
      browOuterL: 0.35,
      browRaiseR: -0.3,
      lidUpL: 0.14,
      lidUpR: 0.22,
      chinRaise: 0.15,
    },
    body: { headNod: -0.1, headTilt: -0.08, headTurn: 0.07, chestPitch: -0.05, spinePitch: -0.02, hipsX: 0.02, hipsRoll: 0.03 },
    blink: 0.7,
  },

  leer: {
    face: {
      lidUpL: 0.3,
      lidUpR: 0.34,
      lidLowL: 0.22,
      lidLowR: 0.22,
      smileL: 0.5,
      smileR: 0.32,
      mouthX: 0.2,
      lipsPart: 0.4,
      jawOpen: 0.07,
      browRaiseL: 0.3,
      browRaiseR: 0.05,
      browInnerL: -0.15,
      browInnerR: -0.2,
    },
    body: { headTilt: 0.13, headNod: 0.02, headFwd: 0.3, spinePitch: -0.03, hipsX: 0.02, hipsRoll: 0.03, clavUpL: -0.15, clavUpR: 0.1 },
    blink: 0.45,
    saccade: 0.3,
  },

  mocking: {
    face: {
      smileL: 1,
      smileR: 1,
      lipsPart: 0.85,
      upperLipUp: 0.5,
      jawOpen: 0.3,
      cheekL: 0.6,
      cheekR: 0.6,
      lidLowL: 0.25,
      lidLowR: 0.25,
      lidUpL: 0.08,
      lidUpR: 0.08,
      browRaiseL: 0.45,
      browRaiseR: 0.45,
      browInnerL: 0.2,
      browInnerR: 0.2,
      sneerL: 0.2,
      sneerR: 0.2,
    },
    body: { headNod: -0.2, headTilt: 0.06, chestPitch: -0.07, spinePitch: -0.04, clavUpL: 0.15, clavUpR: 0.15 },
    blink: 0.8,
  },

  annoyed: {
    face: {
      browRaiseL: -0.5,
      browRaiseR: -0.45,
      browInnerL: -0.6,
      browInnerR: -0.55,
      lidUpL: 0.24,
      lidUpR: 0.24,
      lidLowL: 0.2,
      lidLowR: 0.2,
      lipPress: 0.65,
      frownL: 0.5,
      frownR: 0.3,
      jawSide: 0.9,
      mouthX: 0.55,
      chinRaise: 0.3,
    },
    body: { headTilt: 0.1, headNod: -0.04, headTurn: -0.06, clavUpL: -0.15, clavUpR: -0.15, hipsX: -0.02, hipsRoll: -0.03, spinePitch: -0.02 },
    blink: 0.9,
  },

  angry: {
    face: {
      browRaiseL: -0.95,
      browRaiseR: -0.95,
      browInnerL: -1,
      browInnerR: -1,
      lidUpL: -0.35,
      lidUpR: -0.35,
      lidLowL: 0.6,
      lidLowR: 0.6,
      lipPress: 0.85,
      frownL: 0.5,
      frownR: 0.5,
      jawFwd: 1,
      sneerL: 0.35,
      sneerR: 0.35,
      chinRaise: 0.25,
    },
    talkFace: { sneerL: 0.5, sneerR: 0.5, upperLipUp: 0.35, lowerLipDrop: 0.8, lipPress: -0.85, stretchL: 0.3, stretchR: 0.3 },
    body: { headNod: 0.17, headFwd: 0.8, spinePitch: 0.09, chestPitch: -0.05, clavUpL: 0.35, clavUpR: 0.35, clavFwdL: 0.5, clavFwdR: 0.5 },
    arms: { curl: 0.65, thumb: 0.6, hx: 0.06, hz: 0.03, hy: 0.02, px: 0.5 },
    blink: 0.3,
    saccade: 0.08,
    breathRate: 1.35,
    breathAmp: 2.2,
    sway: 0.5,
  },

  contempt: {
    face: {
      sneerL: 0.85,
      smileL: 0.3,
      mouthX: 0.3,
      lipPress: 0.35,
      chinRaise: 0.45,
      lidUpL: 0.26,
      lidUpR: 0.3,
      lidLowL: 0.15,
      browRaiseL: 0.15,
      browRaiseR: -0.3,
      browInnerR: -0.3,
      browInnerL: -0.15,
      frownR: 0.3,
    },
    body: { headNod: -0.16, headTurn: 0.2, headTilt: -0.05, chestPitch: -0.05, chestYaw: 0.1, spinePitch: -0.03 },
    blink: 0.55,
    saccade: 0.3,
  },

  sheepish: {
    face: {
      smileL: 0.55,
      smileR: 0.5,
      lipPress: 0.6,
      stretchL: 0.3,
      stretchR: 0.3,
      browInnerL: 0.65,
      browInnerR: 0.65,
      browRaiseL: 0.3,
      browRaiseR: 0.3,
      lidUpL: 0.12,
      lidUpR: 0.12,
      cheekL: 0.25,
      cheekR: 0.25,
      chinRaise: 0.2,
    },
    body: { headNod: 0.1, headTurn: 0.22, headTilt: 0.1, clavUpL: 0.7, clavUpR: 0.55, hipsZ: -0.04, spinePitch: -0.04, chestPitch: 0.04 },
    arms: { hy: 0.17, hz: 0.15, hx: 0.06, wy: 0.9, wz: -0.2, curl: -0.25 },
    blink: 1.5,
  },

  surprised: {
    face: {
      browRaiseL: 1,
      browRaiseR: 1,
      browOuterL: 0.3,
      browOuterR: 0.3,
      lidUpL: -0.95,
      lidUpR: -0.95,
      jawOpen: 0.38,
      lipsPart: 0.5,
      pucker: 0.3,
    },
    body: { headNod: -0.05, headFwd: -0.6, spinePitch: -0.06, hipsZ: -0.02, clavUpL: 0.4, clavUpR: 0.4 },
    arms: { hy: 0.05, hz: 0.05, hx: 0.03, curl: -0.25 },
    blink: 0.4,
  },

  afraid: {
    face: {
      browRaiseL: 0.75,
      browRaiseR: 0.75,
      browInnerL: 0.95,
      browInnerR: 0.95,
      lidUpL: -1.05,
      lidUpR: -1.05,
      lidLowL: 0.25,
      lidLowR: 0.25,
      stretchL: 0.8,
      stretchR: 0.8,
      lipsPart: 0.6,
      jawOpen: 0.16,
      frownL: 0.3,
      frownR: 0.3,
      lowerLipDrop: 0.25,
    },
    body: { headFwd: -0.9, headNod: 0.05, headTurn: 0.1, spinePitch: -0.07, chestPitch: 0.05, hipsZ: -0.04, hipsY: -0.015, clavUpL: 0.8, clavUpR: 0.8, clavFwdL: 0.4, clavFwdR: 0.4 },
    arms: { hx: -0.04, hy: 0.14, hz: 0.1, curl: 0.3 },
    blink: 1.4,
    saccade: 0.4,
    breathRate: 2.2,
    breathAmp: 0.8,
    tremor: 1,
  },

  worried: {
    face: {
      browInnerL: 0.85,
      browInnerR: 0.85,
      browRaiseL: 0.15,
      browRaiseR: 0.15,
      lidLowL: 0.15,
      lidLowR: 0.15,
      lipPress: 0.45,
      frownL: 0.45,
      frownR: 0.45,
      chinRaise: 0.4,
    },
    body: { headNod: 0.07, headTilt: 0.06, clavUpL: 0.4, clavUpR: 0.4, clavFwdL: 0.25, clavFwdR: 0.25, chestPitch: 0.03 },
    arms: { hx: -0.03, hy: 0.04, hz: 0.04 },
    blink: 1.3,
    breathRate: 1.3,
    tremor: 0.25,
  },

  relieved: {
    face: {
      smileL: 0.42,
      smileR: 0.42,
      browInnerL: 0.35,
      browInnerR: 0.35,
      browRaiseL: 0.2,
      browRaiseR: 0.2,
      lidUpL: 0.1,
      lidUpR: 0.1,
      cheekL: 0.2,
      cheekR: 0.2,
      lipsPart: 0.25,
    },
    body: { clavUpL: -0.6, clavUpR: -0.6, spinePitch: 0.03, chestPitch: 0.05, headNod: 0.02 },
    blink: 0.9,
    breathRate: 0.8,
    breathAmp: 1.4,
  },

  determined: {
    face: {
      browRaiseL: -0.45,
      browRaiseR: -0.45,
      browInnerL: -0.5,
      browInnerR: -0.5,
      lidLowL: 0.35,
      lidLowR: 0.35,
      lidUpL: 0.05,
      lidUpR: 0.05,
      lipPress: 0.8,
      jawFwd: 0.4,
      chinRaise: 0.25,
      frownL: 0.1,
      frownR: 0.1,
    },
    body: { headNod: -0.02, chestPitch: -0.06, spinePitch: 0.02, clavFwdL: -0.3, clavFwdR: -0.3, headFwd: 0.15 },
    arms: { curl: 0.3 },
    blink: 0.7,
    saccade: 0.2,
    sway: 0.5,
  },
};

/* --------------------------------------------------------------- gestures */

/** Gesture lengths in seconds. `arms_crossed` and `check_phone` hold until replaced (or this long). */
export const GESTURE_DURATION: Record<Gesture, number> = {
  beckon: 1.6,
  shrug: 1.3,
  open_arms: 1.6,
  point: 1.4,
  hands_up: 2.4,
  dismiss: 1.1,
  lean_in: 2.0,
  reach: 2.2,
  wave: 1.5,
  clutch_bag: 2.0,
  arms_crossed: 12,
  check_phone: 45,
  look_around: 2.8,
};

export interface GestureFrame {
  /** Arm override weights. */
  wL: number;
  wR: number;
  armL: Float32Array;
  armR: Float32Array;
  /** 0..1: aim the hand along the line from the shoulder to the gaze target. */
  aimL: number;
  aimR: number;
  /** For an aimed hand: fraction of full arm length, and how far below the gaze target to aim (metres). */
  aimDist: number;
  aimDrop: number;
  /** Additive body parameters. */
  add: PoseVec;
  /** Lean toward the gaze target, radians. */
  lean: number;
  /** Head look offsets (radians) on top of the gaze; the eyes go with it. */
  lookYaw: number;
  lookPitch: number;
  /** 0..1 look down at whatever the right hand holds. */
  lookHand: number;
  phone: number;
  face: Float32Array;
}

export function newGestureFrame(): GestureFrame {
  return {
    wL: 0,
    wR: 0,
    armL: new Float32Array(ARM_N),
    armR: new Float32Array(ARM_N),
    aimL: 0,
    aimR: 0,
    aimDist: 0.9,
    aimDrop: 0,
    add: new Float32Array(P.N),
    lean: 0,
    lookYaw: 0,
    lookPitch: 0,
    lookHand: 0,
    phone: 0,
    face: new Float32Array(32),
  };
}

function setArm(out: Float32Array, v: number[]): void {
  for (let i = 0; i < ARM_N; i++) out[i] = v[i];
}

/** Blend two arm poses. */
function mixArm(out: Float32Array, a: number[], b: number[], t: number): void {
  for (let i = 0; i < ARM_N; i++) out[i] = lerp(a[i], b[i], t);
}

//                hx     hy     hz    px    py    pz    wx    wy    wz   curl point thumb chest
const A_BECKON = [0.07, -0.2, 0.36, 0.5, -0.9, -0.2, 0, 1.45, 0.0, 0.15, 0, 0.1, 0.6];
const A_SHRUG = [0.2, -0.36, 0.2, 0.6, -0.5, -0.7, 0, 1.5, -0.35, 0.12, 0, 0, 0.5];
const A_OPEN = [0.36, -0.3, 0.27, 0.7, -0.7, -0.4, 0, 1.45, -0.3, 0.06, 0, 0, 0.6];
const A_POINT = [0.0, -0.1, 0.52, 0.6, -0.8, 0, 0, -0.2, 0, 1.0, 1, 0.8, 0.5];
const A_HANDS_UP = [0.2, 0.04, 0.2, 0.75, -0.65, 0.05, 0, 0.1, -0.3, 0.05, 0, 0, 0.7];
const A_DISMISS_A = [-0.02, -0.16, 0.3, 0.6, -0.8, -0.1, 0, -0.9, 0.2, 0.3, 0, 0.2, 0.6];
const A_DISMISS_B = [0.33, -0.3, 0.22, 0.5, -0.4, -0.8, 0.3, -1.2, -0.7, 0.12, 0, 0.1, 0.6];
const A_REACH = [0.0, -0.12, 0.54, 0.5, -0.85, 0, 0, -0.9, -0.2, 0.12, 0, 0.1, 0.4];
const A_WAVE = [0.2, 0.12, 0.16, 0.8, -0.6, 0.1, 0, 0.1, -0.15, 0.03, 0, 0, 0.7];
const A_CLUTCH_L = [-0.075, -0.15, 0.15, 0.25, -1, -0.2, 0, -0.2, 0.3, 0.9, 0, 0.8, 1];
const A_CLUTCH_R = [-0.2, -0.2, 0.17, 0.4, -0.9, 0.05, 0, -0.5, 0.3, 0.8, 0, 0.6, 1];
const A_CROSS_L = [-0.285, -0.2, 0.175, 0.75, -0.65, 0.2, 0, -0.4, 0.35, 0.55, 0, 0.5, 1];
const A_CROSS_R = [-0.25, -0.265, 0.15, 0.75, -0.65, 0.2, 0, -0.3, 0.3, 0.5, 0, 0.5, 1];
const A_PHONE = [-0.1, -0.27, 0.27, 0.55, -0.8, -0.3, 0, 1.25, 0.25, 0.42, 0.42, -0.6, 0.9];

/**
 * Fill `g` with the gesture's contribution at time t. Returns false when it has finished.
 * All weights ease in and out so a gesture always starts and ends on the posture underneath.
 */
export function evalGesture(name: Gesture, t: number, g: GestureFrame): boolean {
  const dur = GESTURE_DURATION[name];
  g.wL = g.wR = g.aimL = g.aimR = g.lean = g.lookYaw = g.lookPitch = g.lookHand = g.phone = 0;
  g.aimDist = 0.9;
  g.aimDrop = 0;
  g.add.fill(0);
  g.face.fill(0);
  if (t >= dur) return false;
  const add = g.add;
  switch (name) {
    case 'beckon': {
      const w = envelope(t, dur, 0.38, 0.4);
      g.wR = w;
      setArm(g.armR, A_BECKON);
      // two curls of the fingers with a small pump of the forearm
      const u = saturate((t - 0.35) / 0.9);
      const flick = Math.pow(Math.sin(u * Math.PI * 2), 2) * (u > 0 && u < 1 ? 1 : 0);
      g.armR[ARM.curl] = 0.12 + 0.75 * flick;
      g.armR[ARM.wz] = 0.55 * flick;
      g.armR[ARM.hy] += 0.035 * flick;
      g.armR[ARM.hz] -= 0.04 * flick;
      add[P.headNod] = -0.06 * w + 0.05 * flick * w;
      add[P.headTilt] = -0.06 * w;
      add[P.chestYaw] = -0.05 * w;
      break;
    }
    case 'shrug': {
      const w = envelope(t, dur, 0.3, 0.45);
      g.wL = g.wR = w * 0.95;
      setArm(g.armL, A_SHRUG);
      setArm(g.armR, A_SHRUG);
      add[P.clavUpL] = add[P.clavUpR] = 1.0 * w;
      add[P.headTilt] = 0.1 * w;
      add[P.headNod] = 0.03 * w;
      g.face[FC.browRaiseL] = g.face[FC.browRaiseR] = 0.5 * w;
      g.face[FC.frownL] = g.face[FC.frownR] = 0.35 * w;
      g.face[FC.chinRaise] = 0.4 * w;
      break;
    }
    case 'open_arms': {
      const w = envelope(t, dur, 0.34, 0.45);
      g.wL = g.wR = w;
      setArm(g.armL, A_OPEN);
      setArm(g.armR, A_OPEN);
      const bob = Math.sin(saturate((t - 0.3) / 0.8) * Math.PI * 2) * 0.02;
      g.armL[ARM.hy] += bob;
      g.armR[ARM.hy] += bob;
      add[P.clavUpL] = add[P.clavUpR] = 0.45 * w;
      add[P.headFwd] = 0.4 * w;
      add[P.headTilt] = 0.07 * w;
      add[P.spinePitch] = 0.03 * w;
      g.face[FC.browRaiseL] = g.face[FC.browRaiseR] = 0.45 * w;
      break;
    }
    case 'point': {
      const w = envelope(t, dur, 0.26, 0.4);
      g.wR = w;
      setArm(g.armR, A_POINT);
      g.aimR = 1;
      // two jabs
      const u = saturate((t - 0.26) / 0.7);
      const jab = Math.pow(Math.abs(Math.sin(u * Math.PI * 2)), 1.5) * (u < 1 ? 1 : 0);
      g.aimDist = 0.8 + 0.16 * jab;
      g.aimDrop = 0.2;
      add[P.spinePitch] = 0.05 * w + 0.03 * jab * w;
      add[P.chestYaw] = 0.12 * w;
      add[P.clavFwdR] = 0.6 * w;
      add[P.headFwd] = 0.3 * w;
      break;
    }
    case 'hands_up': {
      const w = envelope(t, dur, 0.4, 0.6);
      g.wL = g.wR = w;
      setArm(g.armL, A_HANDS_UP);
      setArm(g.armR, A_HANDS_UP);
      const pat = Math.sin(saturate((t - 0.45) / 1.0) * Math.PI * 3) * 0.018;
      g.armL[ARM.hz] += pat;
      g.armR[ARM.hz] += pat;
      add[P.clavUpL] = add[P.clavUpR] = 0.5 * w;
      add[P.spinePitch] = -0.06 * w;
      add[P.hipsZ] = -0.02 * w;
      add[P.headNod] = -0.05 * w;
      add[P.headTilt] = 0.06 * w;
      g.face[FC.browRaiseL] = g.face[FC.browRaiseR] = 0.4 * w;
      break;
    }
    case 'dismiss': {
      const w = envelope(t, dur, 0.22, 0.4);
      g.wR = w;
      const s = ease(saturate((t - 0.2) / 0.36));
      mixArm(g.armR, A_DISMISS_A, A_DISMISS_B, s);
      add[P.headTurn] = 0.22 * w * s;
      add[P.headNod] = -0.05 * w;
      add[P.chestYaw] = 0.08 * w * s;
      g.face[FC.lidUpL] = g.face[FC.lidUpR] = 0.1 * w;
      break;
    }
    case 'lean_in': {
      const w = scurve(
        [
          [0, 0],
          [0.5, 1],
          [1.5, 1],
          [dur, 0],
        ],
        t,
      );
      g.lean = 0.3 * w;
      add[P.hipsZ] = -0.035 * w;
      add[P.hipsY] = -0.01 * w;
      add[P.headFwd] = 0.9 * w;
      add[P.clavFwdL] = add[P.clavFwdR] = 0.3 * w;
      break;
    }
    case 'reach': {
      const w = scurve(
        [
          [0, 0],
          [0.42, 1],
          [1.75, 1],
          [dur, 0],
        ],
        t,
      );
      g.wR = w;
      setArm(g.armR, A_REACH);
      g.aimR = 1;
      g.aimDist = lerp(0.7, 0.97, ease(saturate(t / 0.5)));
      g.aimDrop = 0.3;
      g.lean = 0.12 * w;
      add[P.chestYaw] = 0.16 * w;
      add[P.clavFwdR] = 0.9 * w;
      add[P.headFwd] = 0.4 * w;
      break;
    }
    case 'wave': {
      const w = envelope(t, dur, 0.3, 0.4);
      g.wR = w;
      setArm(g.armR, A_WAVE);
      const s = Math.sin(saturate((t - 0.25) / 1.0) * Math.PI * 5);
      g.armR[ARM.hx] += 0.055 * s;
      g.armR[ARM.wx] = -0.3 * s;
      add[P.headTilt] = -0.05 * w;
      break;
    }
    case 'clutch_bag': {
      const w = envelope(t, dur, 0.28, 0.6);
      g.wL = g.wR = w;
      setArm(g.armL, A_CLUTCH_L);
      setArm(g.armR, A_CLUTCH_R);
      add[P.clavUpL] = add[P.clavUpR] = 0.5 * w;
      add[P.clavFwdL] = add[P.clavFwdR] = 0.5 * w;
      add[P.spinePitch] = 0.04 * w;
      add[P.chestYaw] = -0.08 * w;
      add[P.headFwd] = -0.3 * w;
      break;
    }
    case 'arms_crossed': {
      const w = envelope(t, dur, 0.55, 0.6);
      g.wL = g.wR = w;
      setArm(g.armL, A_CROSS_L);
      setArm(g.armR, A_CROSS_R);
      add[P.chestPitch] = -0.02 * w;
      add[P.clavFwdL] = add[P.clavFwdR] = 0.25 * w;
      break;
    }
    case 'check_phone': {
      const w = envelope(t, dur, 0.6, 0.5);
      g.wR = w;
      setArm(g.armR, A_PHONE);
      // thumb scrolls now and then
      const scroll = Math.max(0, Math.sin(t * 2.3)) * Math.max(0, Math.sin(t * 0.7 + 1));
      g.armR[ARM.thumb] = -0.6 + 0.5 * scroll;
      g.phone = smoothstep(0.2, 0.45, t) * (1 - smoothstep(dur - 0.35, dur - 0.15, t));
      g.lookHand = w;
      add[P.clavFwdR] = 0.25 * w;
      break;
    }
    case 'look_around': {
      const y = scurve(
        [
          [0, 0],
          [0.45, 0.85],
          [0.95, 0.85],
          [1.55, -0.8],
          [2.05, -0.8],
          [dur, 0],
        ],
        t,
      );
      g.lookYaw = y;
      g.lookPitch = -0.03 * Math.abs(y);
      add[P.chestYaw] = 0.12 * y;
      add[P.spineYaw] = 0.06 * y;
      break;
    }
  }
  return true;
}
