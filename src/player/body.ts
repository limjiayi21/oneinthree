/**
 * The first-person body: what she sees when she looks down, and the hands
 * that come up into view when her body reacts.
 *
 * Low-poly on purpose. It is seen in the dark, at a glance, from above: two
 * legs that step in time with the footfalls, the lower edge of a coat (or a
 * jacket hem), a right hand holding keys between the fingers and a left hand
 * on the bag strap ('woman'), or two jacket sleeves and a phone ('bystander').
 *
 * Everything is posed in BODY SPACE: origin at the feet, +X right, +Y up,
 * -Z forward. The group is yawed with the body (mouse yaw), never with a
 * glance, so on a look over the shoulder the body stays facing forward.
 * Hands that rise into view are placed relative to the eye so they sit on a
 * known part of the frame whatever the camera FOV is.
 */

import * as THREE from 'three';
import { DEG, TAU, clamp, lerp, smoothstep } from './mathx';

export type BodyKind = 'woman' | 'bystander';

/** Everything the rig needs for one frame. Filled in by the player controller. */
export interface BodyFrame {
  /** Feet position. */
  x: number;
  z: number;
  /** Body yaw (0 faces -Z). */
  yaw: number;
  /** Eye position in body space. */
  eyeX: number;
  eyeY: number;
  eyeZ: number;
  /** View pitch in radians (+ up). */
  pitch: number;
  /** Walk phase: a footfall at every multiple of PI (left foot on even multiples). */
  phase: number;
  /** 0..1 how much the legs are walking. */
  gait: number;
  /** Current step length in metres. */
  stepLength: number;
  /** Unit direction of travel in body space (right, forward). */
  moveRight: number;
  moveForward: number;
  /** Vertical head bob in metres (the hips follow it). */
  bob: number;
  /** 0..1 right hand (keys) rising into the bottom of the frame: driven by tension. */
  keysRaise: number;
  /** 0..1 both hands jerking up in front of the chest: flinch / startle. */
  guardRaise: number;
  /** 0..1 phone held up to film ('bystander'). */
  phoneRaise: number;
  /** 0..1 fine tremor in the hands. */
  tremor: number;
  time: number;
  /** Camera vertical FOV (degrees), without transient kicks. */
  fovDeg: number;
}

export interface BodyRig {
  readonly group: THREE.Group;
  setVisible(visible: boolean): void;
  update(frame: BodyFrame): void;
  dispose(): void;
}

/** Colours. Kept together so art direction can change them in one place. */
export const BODY_PALETTE = {
  woman: { top: 0x8a6e52, legs: 0x1c2028, shoe: 0xcfcbc2, sole: 0xe9e6de, skin: 0xc99b7d, strap: 0x33251e, metal: 0xd8d2bc },
  bystander: { top: 0x3c4a3f, legs: 0x27303f, shoe: 0x2b2521, sole: 0x7d776c, skin: 0xc99b7d, strap: 0x1a1a1c, metal: 0x0b0c0f },
} as const;

const UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);

/* Proportions for a 1.62 m eye height; scaled linearly for other bodies. */
const HIP_Y = 0.88;
const HIP_X = 0.085;
const THIGH = 0.43;
const SHIN = 0.41;
const ANKLE_Y = 0.075;
const SHOULDER_X = 0.185;
const SHOULDER_Y = 1.37;
const UPPER_ARM = 0.27;
const FOREARM = 0.25;
const HAND_REACH = 0.045;
const FOOT_LIFT = 0.075;
/**
 * The spine sits behind the eyes. The body is built this far back from the
 * player's centre (where the camera is), so that looking down she sees past
 * her chest to the coat hem and her shoes, as a person does.
 */
const SPINE_BACK = 0.085;
const HIP_BACK = 0.055;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _p = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();

/** Planar two-bone IK. `end` is the target clamped to what the limb can reach. */
function solveTwoBone(root: THREE.Vector3, target: THREE.Vector3, l1: number, l2: number, pole: THREE.Vector3, mid: THREE.Vector3, end: THREE.Vector3): void {
  _d.subVectors(target, root);
  let dist = _d.length();
  const maxReach = (l1 + l2) * 0.998;
  const minReach = Math.abs(l1 - l2) + 0.01;
  if (dist < 1e-6) {
    _d.set(0, -1, 0);
    dist = minReach;
  } else {
    _d.multiplyScalar(1 / dist);
  }
  const d = clamp(dist, minReach, maxReach);
  end.copy(root).addScaledVector(_d, d);
  const along = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const out = Math.sqrt(Math.max(0, l1 * l1 - along * along));
  _p.copy(pole).addScaledVector(_d, -pole.dot(_d));
  if (_p.lengthSq() < 1e-8) _p.set(1, 0, 0).addScaledVector(_d, -_d.x);
  _p.normalize();
  mid.copy(root).addScaledVector(_d, along).addScaledVector(_p, out);
}

/** Stretch a unit-height limb mesh from a to b. */
function placeLimb(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3): void {
  _d.subVectors(b, a);
  const len = _d.length() || 1e-4;
  mesh.position.copy(a).addScaledVector(_d, 0.5);
  mesh.scale.set(1, len, 1);
  mesh.quaternion.setFromUnitVectors(UP, _d.multiplyScalar(1 / len));
}

/** Orient an object with +Y along `dir`, its +X as close to `side` as possible. */
function aimHand(obj: THREE.Object3D, dir: THREE.Vector3, side: THREE.Vector3): void {
  _a.copy(side).addScaledVector(dir, -side.dot(dir));
  if (_a.lengthSq() < 1e-6) _a.set(0, 0, -1).addScaledVector(dir, dir.z);
  _a.normalize();
  _b.crossVectors(_a, dir); // z = x cross y
  _m.makeBasis(_a, dir, _b);
  obj.quaternion.setFromRotationMatrix(_m);
}

interface Arm {
  side: -1 | 1;
  shoulder: THREE.Vector3;
  upper: THREE.Mesh;
  fore: THREE.Mesh;
  hand: THREE.Group;
  elbow: THREE.Vector3;
  wrist: THREE.Vector3;
  target: THREE.Vector3;
  pole: THREE.Vector3;
  dir: THREE.Vector3;
}

interface Leg {
  side: -1 | 1;
  thigh: THREE.Mesh;
  shin: THREE.Mesh;
  shoe: THREE.Group;
  hip: THREE.Vector3;
  knee: THREE.Vector3;
  ankle: THREE.Vector3;
  target: THREE.Vector3;
}

export function createBody(kind: BodyKind, eyeHeight: number): BodyRig {
  const k = eyeHeight / 1.62;
  const back = SPINE_BACK * k;
  const hipBack = HIP_BACK * k;
  const pal = BODY_PALETTE[kind];
  const group = new THREE.Group();
  group.name = `player-body-${kind}`;

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  const cloth = (color: number, opts: { double?: boolean; rough?: number } = {}) => {
    const m = new THREE.MeshStandardMaterial({
      color,
      roughness: opts.rough ?? 0.92,
      metalness: 0,
      // A whisper of self-light: the body must never be pure black under a dead street lamp.
      emissive: color,
      emissiveIntensity: 0.035,
      side: opts.double ? THREE.DoubleSide : THREE.FrontSide,
    });
    materials.push(m);
    return m;
  };
  const geo = <T extends THREE.BufferGeometry>(g: T): T => {
    geometries.push(g);
    return g;
  };
  const mesh = (g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D = group): THREE.Mesh => {
    const o = new THREE.Mesh(g, m);
    o.castShadow = false;
    o.receiveShadow = false;
    parent.add(o);
    return o;
  };

  const matTop = cloth(pal.top);
  const matTopDouble = cloth(pal.top, { double: true });
  const matLegs = cloth(pal.legs);
  const matShoe = cloth(pal.shoe, { rough: 0.8 });
  const matSole = cloth(pal.sole, { rough: 0.85 });
  const matSkin = cloth(pal.skin, { rough: 0.75 });
  const matStrap = cloth(pal.strap, { rough: 0.7 });

  /* ---------------------------------------------------------------- torso */

  const ELLIPSE = 0.66; // front-to-back flattening of the torso
  const yoke = mesh(geo(new THREE.CylinderGeometry(0.07 * k, 0.2 * k, 0.14 * k, 12, 1)), matTop);
  yoke.position.set(0, 1.38 * k, back);
  yoke.scale.z = ELLIPSE;

  // Hem pivot: the coat skirt (or jacket hem) swings a little with each step.
  const hem = new THREE.Group();
  group.add(hem);

  if (kind === 'woman') {
    const chest = mesh(geo(new THREE.CylinderGeometry(0.2 * k, 0.2 * k, 0.39 * k, 12, 1, true)), matTop);
    chest.position.set(0, 1.115 * k, back);
    chest.scale.z = ELLIPSE;
    hem.position.set(0, 0.92 * k, back);
    const skirt = mesh(geo(new THREE.CylinderGeometry(0.2 * k, 0.24 * k, 0.37 * k, 12, 1, true)), matTopDouble, hem);
    skirt.position.y = -0.185 * k;
    skirt.scale.z = 0.72;
    // Two buttons and the front overlap line read as "coat" even as a silhouette.
    const matButton = cloth(0x2a211a, { rough: 0.5 });
    const buttonGeo = geo(new THREE.SphereGeometry(0.011 * k, 6, 4));
    for (const y of [1.2, 1.06]) {
      const b = mesh(buttonGeo, matButton);
      b.position.set(0.03 * k, y * k, back - 0.2 * k * ELLIPSE - 0.002);
    }
  } else {
    const chest = mesh(geo(new THREE.CylinderGeometry(0.205 * k, 0.21 * k, 0.33 * k, 12, 1, true)), matTop);
    chest.position.set(0, 1.145 * k, back);
    chest.scale.z = ELLIPSE;
    hem.position.set(0, 0.98 * k, back);
    const band = mesh(geo(new THREE.CylinderGeometry(0.212 * k, 0.205 * k, 0.085 * k, 12, 1, true)), matTopDouble, hem);
    band.position.y = -0.04 * k;
    band.scale.z = 0.68;
    const pelvis = mesh(geo(new THREE.CylinderGeometry(0.19 * k, 0.175 * k, 0.16 * k, 10, 1)), matLegs);
    pelvis.position.set(0, 0.87 * k, (back + hipBack) / 2);
    pelvis.scale.z = 0.64;
    // Zip line down the front of the jacket.
    const zip = mesh(geo(new THREE.BoxGeometry(0.008 * k, 0.4 * k, 0.004)), cloth(0x15181a, { rough: 0.4 }));
    zip.position.set(0, 1.15 * k, back - 0.208 * k * ELLIPSE);
  }

  /* ----------------------------------------------------------------- legs */

  const thighGeo = geo(new THREE.CylinderGeometry(0.058 * k, 0.08 * k, 1, 7, 1));
  const shinGeo = geo(new THREE.CylinderGeometry(0.04 * k, 0.056 * k, 1, 7, 1));
  const shoeGeo = geo(new THREE.BoxGeometry(0.092 * k, 0.062 * k, 0.25 * k));
  const soleGeo = geo(new THREE.BoxGeometry(0.1 * k, 0.02 * k, 0.262 * k));
  const toeGeo = geo(new THREE.BoxGeometry(0.086 * k, 0.03 * k, 0.07 * k));

  const makeLeg = (side: -1 | 1): Leg => {
    const thigh = mesh(thighGeo, matLegs);
    const shin = mesh(shinGeo, matLegs);
    const shoe = new THREE.Group();
    group.add(shoe);
    // The shoe pivots at the ankle; the mesh hangs below and ahead of it.
    const upperM = mesh(shoeGeo, matShoe, shoe);
    upperM.position.set(0, (-ANKLE_Y + 0.051) * k, -0.06 * k);
    const sole = mesh(soleGeo, matSole, shoe);
    sole.position.set(0, (-ANKLE_Y + 0.01) * k, -0.06 * k);
    const toe = mesh(toeGeo, matSole, shoe);
    toe.position.set(0, (-ANKLE_Y + 0.035) * k, -0.165 * k);
    return {
      side,
      thigh,
      shin,
      shoe,
      hip: new THREE.Vector3(),
      knee: new THREE.Vector3(),
      ankle: new THREE.Vector3(),
      target: new THREE.Vector3(),
    };
  };
  const legs: Leg[] = [makeLeg(-1), makeLeg(1)];
  const kneePole = new THREE.Vector3(0, 0.12, -1);

  /* ----------------------------------------------------------------- arms */

  const upperGeo = geo(new THREE.CylinderGeometry(0.047 * k, 0.056 * k, 1, 7, 1));
  const foreGeo = geo(new THREE.CylinderGeometry(0.036 * k, 0.047 * k, 1, 7, 1));
  const fistGeo = geo(new THREE.SphereGeometry(0.5, 7, 5).scale(0.08 * k, 0.082 * k, 0.056 * k));
  const cuffGeo = geo(new THREE.CylinderGeometry(0.04 * k, 0.04 * k, 0.03 * k, 7, 1));

  const makeArm = (side: -1 | 1): Arm => {
    const upper = mesh(upperGeo, matTop);
    const fore = mesh(foreGeo, matTop);
    const hand = new THREE.Group();
    group.add(hand);
    mesh(fistGeo, matSkin, hand);
    const cuff = mesh(cuffGeo, matTop, hand);
    cuff.position.y = -0.05 * k;
    return {
      side,
      shoulder: new THREE.Vector3(side * SHOULDER_X * k, SHOULDER_Y * k, back - 0.01 * k),
      upper,
      fore,
      hand,
      elbow: new THREE.Vector3(),
      wrist: new THREE.Vector3(),
      target: new THREE.Vector3(),
      pole: new THREE.Vector3(side * 0.55, -1, 0.4),
      dir: new THREE.Vector3(0, -1, 0),
    };
  };
  const armL = makeArm(-1);
  const armR = makeArm(1);

  /* ---------------------------------------------------- what the hands hold */

  let phone: THREE.Group | null = null;
  let phoneScreenMat: THREE.MeshBasicMaterial | null = null;
  let phoneDotMat: THREE.MeshBasicMaterial | null = null;

  if (kind === 'woman') {
    // Keys pushed out between the knuckles of the right fist.
    const matMetal = new THREE.MeshStandardMaterial({ color: pal.metal, roughness: 0.32, metalness: 0.35, emissive: pal.metal, emissiveIntensity: 0.06 });
    materials.push(matMetal);
    const keyGeo = geo(new THREE.BoxGeometry(0.008 * k, 0.058 * k, 0.017 * k));
    const keys = new THREE.Group();
    armR.hand.add(keys);
    const splay = [-0.16, 0.02, 0.17];
    const xs = [-0.023, 0.001, 0.024];
    for (let i = 0; i < 3; i++) {
      const key = mesh(keyGeo, matMetal, keys);
      key.position.set(xs[i] * k, (0.037 + 0.022 - Math.abs(xs[i]) * 0.25) * k, 0);
      key.rotation.z = -splay[i];
    }
    const ring = mesh(geo(new THREE.TorusGeometry(0.013 * k, 0.0022 * k, 4, 10)), matMetal, keys);
    ring.position.set(0.012 * k, -0.046 * k, -0.02 * k);
    ring.rotation.y = 0.6;
    const fob = mesh(geo(new THREE.BoxGeometry(0.016 * k, 0.03 * k, 0.006 * k)), matStrap, keys);
    fob.position.set(0.016 * k, -0.07 * k, -0.022 * k);
    fob.rotation.z = 0.25;

    // Shoulder bag: strap down the front of the left shoulder, bag at the hip.
    const strapTop = new THREE.Vector3(-0.142 * k, 1.425 * k, back - 0.065 * k);
    const strapBottom = new THREE.Vector3(-0.235 * k, 1.0 * k, back - 0.125 * k);
    const strap = mesh(geo(new THREE.BoxGeometry(0.028 * k, 1, 0.006 * k)), matStrap);
    placeLimb(strap, strapTop, strapBottom);
    const bag = mesh(geo(new THREE.BoxGeometry(0.09 * k, 0.25 * k, 0.33 * k)), matStrap);
    bag.position.set(-0.275 * k, 0.9 * k, back - 0.02 * k);
  } else {
    phone = new THREE.Group();
    group.add(phone);
    const matPhone = new THREE.MeshStandardMaterial({ color: pal.metal, roughness: 0.35, metalness: 0.2, emissive: 0x050608, emissiveIntensity: 1 });
    materials.push(matPhone);
    mesh(geo(new THREE.BoxGeometry(0.074 * k, 0.152 * k, 0.009 * k)), matPhone, phone);
    phoneScreenMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
    materials.push(phoneScreenMat);
    const screen = mesh(geo(new THREE.PlaneGeometry(0.066 * k, 0.142 * k)), phoneScreenMat, phone);
    screen.position.z = 0.0048 * k;
    // camera UI: a dark bar along the bottom with the red record button, and a REC dot
    const bar = mesh(geo(new THREE.PlaneGeometry(0.066 * k, 0.03 * k)), new THREE.MeshBasicMaterial({ color: 0x030405 }), phone);
    bar.position.set(0, -0.056 * k, 0.005 * k);
    materials.push(bar.material as THREE.Material);
    phoneDotMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
    materials.push(phoneDotMat);
    const dotGeo = geo(new THREE.CircleGeometry(1, 12));
    const record = mesh(dotGeo, phoneDotMat, phone);
    record.scale.setScalar(0.009 * k);
    record.position.set(0, -0.056 * k, 0.0054 * k);
    const dot = mesh(dotGeo, phoneDotMat, phone);
    dot.scale.setScalar(0.0035 * k);
    dot.position.set(-0.024 * k, 0.06 * k, 0.0054 * k);
  }

  /* ----------------------------------------------------------------- pose */

  const eye = new THREE.Vector3();
  const restL = new THREE.Vector3();
  const restR = new THREE.Vector3();
  const tKeys = new THREE.Vector3();
  const tGuardL = new THREE.Vector3();
  const tGuardR = new THREE.Vector3();
  const tPhone = new THREE.Vector3();
  const phoneRestPos = new THREE.Vector3();
  const phoneUpPos = new THREE.Vector3();
  const sideAxis = new THREE.Vector3();

  /** A point given relative to the eye (view space at the clamped pitch) -> body space. */
  const fromView = (out: THREE.Vector3, x: number, y: number, z: number, pitchFollow: number): THREE.Vector3 =>
    out.set(x, y, z).applyAxisAngle(X_AXIS, pitchFollow).add(eye);

  /** A point `dist` from the eye, `below` radians under the view centre, `x` metres to the side. */
  const onFrame = (out: THREE.Vector3, x: number, below: number, dist: number, pitchFollow: number): THREE.Vector3 =>
    fromView(out, x, -Math.sin(below) * dist, -Math.cos(below) * dist, pitchFollow);

  function poseArm(arm: Arm): void {
    solveTwoBone(arm.shoulder, arm.target, UPPER_ARM * k, FOREARM * k, arm.pole, arm.elbow, arm.wrist);
    placeLimb(arm.upper, arm.shoulder, arm.elbow);
    placeLimb(arm.fore, arm.elbow, arm.wrist);
    arm.dir.subVectors(arm.wrist, arm.elbow).normalize();
    arm.hand.position.copy(arm.wrist).addScaledVector(arm.dir, HAND_REACH * k);
    aimHand(arm.hand, arm.dir, sideAxis.set(1, 0, 0));
  }

  function update(f: BodyFrame): void {
    group.position.set(f.x, 0, f.z);
    group.rotation.y = f.yaw;
    if (!group.visible) return;

    const g = f.gait;
    eye.set(f.eyeX, f.eyeY, f.eyeZ);

    /* legs */
    const half = f.stepLength * 0.5 * 0.94;
    for (const leg of legs) {
      const cyc = (((f.phase + (leg.side > 0 ? Math.PI : 0)) % TAU) + TAU) % TAU;
      let along: number;
      let lift = 0;
      let tilt: number;
      if (cyc < Math.PI) {
        // stance: the planted foot slides back under the body at walking speed
        const u = cyc / Math.PI;
        along = half * (1 - 2 * u);
        tilt = u < 0.22 ? 0.24 * (1 - u / 0.22) : u > 0.68 ? -0.38 * ((u - 0.68) / 0.32) : 0;
      } else {
        // swing: lift, carry forward, reach
        const u = (cyc - Math.PI) / Math.PI;
        const s = smoothstep(u);
        along = half * (2 * s - 1);
        lift = Math.sin(u * Math.PI) * FOOT_LIFT * k;
        tilt = lerp(-0.38, 0.24, s);
      }
      along *= g;
      lift *= g;
      leg.hip.set(leg.side * HIP_X * k, HIP_Y * k + f.bob * 0.85, hipBack);
      leg.target.set(leg.side * HIP_X * k + f.moveRight * along * 0.55, ANKLE_Y * k + lift, hipBack - f.moveForward * along);
      solveTwoBone(leg.hip, leg.target, THIGH * k, SHIN * k, kneePole, leg.knee, leg.ankle);
      placeLimb(leg.thigh, leg.hip, leg.knee);
      placeLimb(leg.shin, leg.knee, leg.ankle);
      leg.shoe.position.copy(leg.ankle);
      leg.shoe.rotation.x = tilt * g * f.moveForward;
    }

    /* coat hem: swings against the leading leg */
    hem.rotation.x = Math.cos(f.phase) * 0.035 * g * f.moveForward * (kind === 'woman' ? 1 : 0.4);
    hem.rotation.z = Math.sin(f.phase) * 0.02 * g;

    /* arms */
    const pitchFollow = clamp(f.pitch, -0.42, 0.55) * 0.85;
    const halfFov = clamp(f.fovDeg, 40, 100) * 0.5 * DEG;
    const swing = Math.cos(f.phase) * g;
    const shake = f.tremor * 0.0022;
    const jx = shake * (Math.sin(f.time * 61.3) + 0.6 * Math.sin(f.time * 83.1 + 1.3));
    const jy = shake * (Math.sin(f.time * 67.9 + 2.1) + 0.6 * Math.sin(f.time * 49.7));

    if (kind === 'woman') {
      // right: keys held low in front of the waist; left: gripping the bag strap
      restR.set(0.205 * k, 1.04 * k + f.bob * 0.6, back - 0.24 * k + swing * 0.012);
      restL.set(-0.178 * k, 1.195 * k + f.bob * 0.5, back - 0.158 * k);
    } else {
      restR.set(0.255 * k, 0.9 * k + f.bob * 0.6, back - 0.06 * k - swing * 0.075);
      restL.set(-0.255 * k, 0.9 * k + f.bob * 0.6, back - 0.06 * k + swing * 0.075);
    }

    // The fist just breaks the lower edge of the frame, right of centre.
    onFrame(tKeys, 0.17 * k, halfFov + 3 * DEG, 0.4 * k, pitchFollow);
    onFrame(tGuardR, 0.16 * k, Math.max(halfFov - 12 * DEG, 12 * DEG), 0.36 * k, pitchFollow);
    onFrame(tGuardL, -0.16 * k, Math.max(halfFov - 10 * DEG, 14 * DEG), 0.36 * k, pitchFollow);
    onFrame(tPhone, 0.14 * k, Math.max(halfFov - 9 * DEG, 14 * DEG), 0.44 * k, pitchFollow);

    const keysW = kind === 'woman' ? smoothstep(f.keysRaise) : 0;
    const phoneW = kind === 'bystander' ? smoothstep(f.phoneRaise) : 0;
    const guardW = smoothstep(f.guardRaise);

    armR.target.copy(restR);
    if (keysW > 0) armR.target.lerp(tKeys, keysW);
    if (phoneW > 0) armR.target.lerp(tPhone, phoneW);
    // Filming hand does not let go of the phone on a flinch: it only jolts.
    if (guardW > 0) armR.target.lerp(tGuardR, guardW * (1 - 0.7 * phoneW));
    armR.target.x += jx;
    armR.target.y += jy;

    armL.target.copy(restL);
    if (guardW > 0) armL.target.lerp(tGuardL, guardW);
    armL.target.x -= jy * 0.7;
    armL.target.y += jx * 0.7;

    poseArm(armL);
    poseArm(armR);

    /* phone */
    if (phone && phoneScreenMat && phoneDotMat) {
      // lowered: an extension of the hanging hand, screen dark
      phoneRestPos.copy(armR.hand.position).addScaledVector(armR.dir, 0.05 * k);
      _q1.copy(armR.hand.quaternion);
      // raised: upright in front of the eye, screen toward the face, tilted a touch
      phoneUpPos.copy(armR.wrist);
      _c.set(-0.012 * k, 0.09 * k, -0.012 * k).applyAxisAngle(X_AXIS, pitchFollow);
      phoneUpPos.add(_c);
      _q2.setFromEuler(_e.set(pitchFollow - 0.1, -0.2, 0.03, 'YXZ'));
      phone.position.lerpVectors(phoneRestPos, phoneUpPos, phoneW);
      phone.quaternion.slerpQuaternions(_q1, _q2, phoneW);
      const lit = smoothstep((f.phoneRaise - 0.35) / 0.5);
      // the live preview of a night street: a cool glow, not a white card
      phoneScreenMat.color.setRGB(0.012 + 0.3 * lit, 0.014 + 0.4 * lit, 0.018 + 0.56 * lit);
      phoneDotMat.color.setRGB(0.04 + 1.5 * lit, 0.012 + 0.06 * lit, 0.012 + 0.05 * lit);
    }
  }

  return {
    group,
    setVisible(visible) {
      group.visible = visible;
    },
    update,
    dispose() {
      group.removeFromParent();
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
    },
  };
}
