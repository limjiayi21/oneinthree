/**
 * Procedural, fully animated low-poly human.
 *
 * FACING CONVENTION
 *   `root` has its origin at the feet, on the ground. The character faces local
 *   +Z, its left hand is on +X, up is +Y. So `root.lookAt(target)` turns it to
 *   face `target`, and to face a direction (dx, dz) on the ground use
 *   `root.rotation.y = Math.atan2(dx, dz)`. (With the player/NPC convention
 *   "yaw 0 faces -Z" that is `root.rotation.y = yaw + Math.PI`.)
 *
 * WHAT DRIVES IT
 *   setEmotion  -> face channels (brows, lids, mouth, jaw), head carriage, gaze
 *                  habits, breathing and an additive body layer, blended ~0.3 s
 *   setPosture  -> the base stance (feet, hips, spine, arm rest positions)
 *   playGesture -> a one-shot layered over the posture
 *   setGaze     -> head, eyes and a little torso follow a world point. The
 *                  vector is read every frame, so a live vector is tracked
 *   setTalking  -> jaw and lips
 *   The walk cycle is driven by how far `root` actually moved since the last
 *   update (so feet do not slide, and backing away or side-stepping steps in
 *   the right direction); setLocomotion() is the fallback when root is still.
 *
 * BEYOND THE `Human` INTERFACE (see HumanExt)
 *   onFootfall, getEyePosition, stopGesture, gestureRemaining, height, debug.
 *   `lean_wall` assumes a wall LEAN_WALL_OFFSET * (height / 1.85) metres behind
 *   the root origin: place the root that far in front of the wall, facing away.
 *
 * COST: 4 draw calls (skinned body, head, two eyes), +1 while the phone is out.
 */
import * as THREE from 'three';
import type { Emotion } from '../../shared/types';
import type { Gesture, Human, HumanOptions, Posture } from '../contracts';
import { B, buildBody, buildSkeleton, computeDims, type BodyColors } from './body';
import { FACE_CHANNELS, FC, buildFace } from './face';
import { ARM, ARM_N, EMOTIONS, GESTURE_DURATION, LEAN_WALL_OFFSET, P, POSTURES, evalGesture, newGestureFrame } from './poses';
import { Rng, clamp, damp, ease, lerp, noise1, saturate, scurve, smoothstep } from './util';

export { LEAN_WALL_OFFSET, GESTURE_DURATION } from './poses';

export interface HumanExt extends Human {
  /**
   * Called at each heel strike of the walk cycle with the foot's world position
   * and the current speed (m/s). Use it to time footstep sounds.
   */
  onFootfall: ((foot: 'left' | 'right', position: THREE.Vector3, speed: number) => void) | null;
  /** World-space point between the eyes (the natural gaze target for others). */
  getEyePosition(out?: THREE.Vector3): THREE.Vector3;
  /** Ends the current gesture with a short ease-out. */
  stopGesture(): void;
  /** Seconds left of the current gesture, 0 when idle. */
  readonly gestureRemaining: number;
  /** Actual height in metres. */
  readonly height: number;
  /** Harness hooks: force face channels or arm poses. Not for game code. */
  readonly debug: {
    face: Float32Array | null;
    armL: number[] | null;
    armR: number[] | null;
    /** Suppress blinking (for reproducible stills). */
    noBlink: boolean;
    readonly faceOut: Float32Array;
  };
}

/* -------------------------------------------------------------- materials */

interface Shared {
  body: THREE.MeshStandardMaterial;
  eye: THREE.MeshStandardMaterial;
  phone: THREE.MeshBasicMaterial;
  refs: number;
}
let shared: Shared | null = null;

/**
 * A little self-illumination so a face under a single lamp never goes fully
 * black: adds `floor` x albedo to the emitted light.
 */
function lightFloor(mat: THREE.MeshStandardMaterial, floor: number, ambientBoost = 1): void {
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += diffuseColor.rgb * ${floor.toFixed(4)};`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n\treflectedLight.indirectDiffuse *= ${ambientBoost.toFixed(3)};`);
  };
  mat.customProgramCacheKey = () => `oit-floor-${floor}-${ambientBoost}`;
}

function acquireMaterials(): Shared {
  if (!shared) {
    const body = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0 });
    lightFloor(body, 0.04);
    const eye = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.22, metalness: 0 });
    // eyes answer ambient light strongly and take no shadows, so they stay readable under the brow
    lightFloor(eye, 0.06, 3);
    const phone = new THREE.MeshBasicMaterial({ vertexColors: true });
    shared = { body, eye, phone, refs: 0 };
  }
  shared.refs++;
  return shared;
}

function releaseMaterials(): void {
  if (!shared) return;
  if (--shared.refs <= 0) {
    shared.body.dispose();
    shared.eye.dispose();
    shared.phone.dispose();
    shared = null;
  }
}

/* ------------------------------------------------------------------ maths */

const UP = new THREE.Vector3(0, 1, 0);
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _vx = new THREE.Vector3();
const _vy = new THREE.Vector3();
const _vz = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _perp = new THREE.Vector3();
const _n = new THREE.Vector3();
const _el = new THREE.Vector3();
const _tt = new THREE.Vector3();

function qEuler(out: THREE.Quaternion, x: number, y: number, z: number, order: THREE.EulerOrder = 'YXZ'): THREE.Quaternion {
  return out.setFromEuler(_e.set(x, y, z, order));
}

/**
 * Two-bone IK in the parent's space. Bones point along their local -Y; the
 * hinge is local X. `sign` is +1 for arms (elbow toward the pole), -1 for legs.
 */
function solveLimb(
  S: THREE.Vector3,
  T: THREE.Vector3,
  L1: number,
  L2: number,
  pole: THREE.Vector3,
  sign: number,
  outUpper: THREE.Quaternion,
  outLower: THREE.Quaternion,
): void {
  _dir.subVectors(T, S);
  let dist = _dir.length();
  if (dist < 1e-5) {
    _dir.set(0, -1, 0);
    dist = 1e-5;
  } else _dir.multiplyScalar(1 / dist);
  dist = clamp(dist, Math.abs(L1 - L2) + 0.01, (L1 + L2) * 0.9985);
  const a = (L1 * L1 - L2 * L2 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
  _perp.copy(pole).addScaledVector(_dir, -pole.dot(_dir));
  if (_perp.lengthSq() < 1e-6) {
    _perp.set(0, 0, -1).addScaledVector(_dir, _dir.z);
    if (_perp.lengthSq() < 1e-6) _perp.set(1, 0, 0);
  }
  _perp.normalize();
  _el.copy(S).addScaledVector(_dir, a).addScaledVector(_perp, h);
  _n.crossVectors(_dir, _perp).multiplyScalar(sign).normalize();
  // upper
  _vy.subVectors(S, _el).normalize();
  _vx.copy(_n);
  _vz.crossVectors(_vx, _vy);
  outUpper.setFromRotationMatrix(_m.makeBasis(_vx, _vy, _vz));
  // lower
  _tt.copy(S).addScaledVector(_dir, dist);
  _vy.subVectors(_el, _tt).normalize();
  _vz.crossVectors(_vx, _vy);
  outLower.setFromRotationMatrix(_m.makeBasis(_vx, _vy, _vz));
}

/* ----------------------------------------------------------------- colours */

function resolveColors(o: HumanOptions): BodyColors {
  const man = o.build === 'man';
  const top = new THREE.Color(o.top ?? (man ? 0x2b2f38 : 0x6a5546));
  const lum = top.r * 0.3 + top.g * 0.6 + top.b * 0.1;
  const inner = o.topStyle === 'apron' ? new THREE.Color(0x8f8a80) : lum < 0.12 ? top.clone().lerp(new THREE.Color(0xb9b2a4), 0.5) : top.clone().multiplyScalar(0.32).lerp(new THREE.Color(0x15161a), 0.35);
  const shoes = new THREE.Color(o.shoes ?? (man ? 0x101010 : 0x2a2220));
  return {
    skin: new THREE.Color(o.skin ?? (man ? 0xb5825f : 0xc48f70)),
    top,
    inner,
    bottom: new THREE.Color(o.bottom ?? (man ? 0x1d2330 : 0x22252c)),
    shoes,
    sole: shoes.clone().lerp(new THREE.Color(0x8d8a82), 0.55),
    bag: new THREE.Color(o.accessory === 'backpack' ? 0x20242a : 0x74685a),
    strap: new THREE.Color(o.accessory === 'backpack' ? 0x16181c : 0x4f463c),
    hair: new THREE.Color(o.hair ?? (man ? 0x1a1411 : 0x24170f)),
  };
}

function buildPhone(K: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(0.008 * K, 0.146 * K, 0.07 * K);
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  const nrm = g.getAttribute('normal');
  const pos = g.getAttribute('position');
  for (let i = 0; i < n; i++) {
    const screen = nrm.getX(i) > 0.5;
    const edge = Math.abs(pos.getY(i)) > 0.06 * K ? 0.8 : 1;
    col[i * 3] = screen ? 0.62 * edge : 0.01;
    col[i * 3 + 1] = screen ? 0.74 * edge : 0.01;
    col[i * 3 + 2] = screen ? 0.95 * edge : 0.012;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/* ------------------------------------------------------------------ human */

let seedCounter = 1;

export function createHuman(opts: HumanOptions): HumanExt {
  const d = computeDims(opts);
  const { K, H } = d;
  const man = d.man;
  const colors = resolveColors(opts);
  const mats = acquireMaterials();
  const rng = new Rng(seedCounter++ * 7919 + 13);
  const seed = rng.range(0, 100);

  const root = new THREE.Group();
  root.name = `human:${opts.build}`;

  const bones = buildSkeleton(d);
  const bodyGeo = buildBody(opts, d, colors);
  const body = new THREE.SkinnedMesh(bodyGeo, mats.body);
  body.name = 'body';
  body.castShadow = true;
  body.receiveShadow = true;
  root.add(bones[B.hips]);
  root.add(body);
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  body.bind(skeleton);
  body.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, H * 0.5, 0), H * 0.75);
  body.boundingBox = new THREE.Box3(new THREE.Vector3(-H * 0.6, -0.1, -H * 0.6), new THREE.Vector3(H * 0.6, H * 1.1, H * 0.6));

  const face = buildFace({
    man,
    skin: colors.skin,
    hair: colors.hair,
    hairStyle: opts.hairStyle ?? (man ? 'short' : 'long'),
    headphones: opts.accessory === 'headphones',
    material: mats.body,
    eyeMaterial: mats.eye,
  });
  face.mesh.scale.setScalar(d.headScale);
  bones[B.head].add(face.mesh);

  const phoneGeo = buildPhone(K);
  const phone = new THREE.Mesh(phoneGeo, mats.phone);
  phone.visible = false;
  // lies in the right palm, screen toward the palm normal (+X on the right hand)
  phone.position.set(0.021 * K, -0.088 * K, 0.006 * K);
  bones[B.handR].add(phone);

  /* ----------------------------------------------------------------- state */
  let time = rng.range(0, 50);
  let emotion: Emotion = 'neutral';
  let emoTime = 0;
  const faceTgt = new Float32Array(FACE_CHANNELS);
  const faceCur = new Float32Array(FACE_CHANNELS);
  const talkFaceTgt = new Float32Array(FACE_CHANNELS);
  const talkFaceCur = new Float32Array(FACE_CHANNELS);
  const faceOut = new Float32Array(FACE_CHANNELS);
  const emoBodyTgt = new Float32Array(P.N);
  const emoBody = new Float32Array(P.N);
  // [blink, saccade, breathRate, breathAmp, sway, tremor, special]
  const emoScalTgt = [1, 1, 1, 1, 1, 0, 0];
  const emoScal = [1, 1, 1, 1, 1, 0, 0];

  const post = new Float32Array(POSTURES.stand);
  let postTarget: Float32Array = POSTURES.stand;
  const pose = new Float32Array(P.N);

  let gesture: Gesture | null = null;
  let gTime = 0;
  const gf = newGestureFrame();

  let gazeTarget: THREE.Vector3 | null = null;
  let gazeW = 0;
  let headYaw = 0;
  let headYawV = 0;
  let headPitch = 0;
  let headPitchV = 0;
  let bodyFollow = 0;
  const gazeLocal = new THREE.Vector3(0, H * 0.93, 5);
  const lastGazeLocal = new THREE.Vector3(0, H * 0.93, 5);

  let talkIn = 0;
  let talk = 0;
  let visTimer = 0;
  let visWide = 0;
  let visWideT = 0;
  let visUp = 0;
  let visUpT = 0;
  let visOpen = 1;
  let visOpenT = 1;

  let blinkT = -1;
  let nextBlink = rng.range(1, 4);
  let sacTimer = 0;
  let sacX = 0;
  let sacY = 0;
  let sacXs = 0;
  let sacYs = 0;
  let breath = rng.range(0, 6);

  let declaredSpeed = 0;
  const lastWorld = new THREE.Vector3();
  let hasLast = false;
  let velX = 0;
  let velZ = 0;
  let locoW = 0;
  let phase = 0;
  let stepLen = 0.7 * K;
  let dirX = 0;
  let dirZ = 1;
  let prevPL = 0;
  let prevPR = 0.5;
  let hipDropSm = 0;

  const headCenterRoot = new THREE.Vector3(0, d.head.y + 0.04 * d.headScale, 0.02);
  const eyeMidRoot = new THREE.Vector3(0, d.head.y + 0.032 * d.headScale, 0.07);

  const debug: HumanExt['debug'] = { face: null, armL: null, armR: null, noBlink: false, faceOut };

  /* -------------------------------------------------------------- temporaries */
  const hipsPos = new THREE.Vector3();
  const hipsQ = new THREE.Quaternion();
  const spineQl = new THREE.Quaternion();
  const spineQ = new THREE.Quaternion();
  const spinePos = new THREE.Vector3();
  const chestQl = new THREE.Quaternion();
  const chestQ = new THREE.Quaternion();
  const chestPos = new THREE.Vector3();
  const neckPos = new THREE.Vector3();
  const neckQl = new THREE.Quaternion();
  const neckQ = new THREE.Quaternion();
  const headQl = new THREE.Quaternion();
  const headQ = new THREE.Quaternion();
  const headPos = new THREE.Vector3();
  const clavQl = new THREE.Quaternion();
  const clavQ = new THREE.Quaternion();
  const upperQ = new THREE.Quaternion();
  const lowerQ = new THREE.Quaternion();
  const q0 = new THREE.Quaternion();
  const q1 = new THREE.Quaternion();
  const q2 = new THREE.Quaternion();
  const yawQ = new THREE.Quaternion();
  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const v3 = new THREE.Vector3();
  const S = new THREE.Vector3();
  const T = new THREE.Vector3();
  const pole = new THREE.Vector3();
  const armA = new Float32Array(ARM_N);
  const footT = [new THREE.Vector3(), new THREE.Vector3()];
  const footPitch = [0, 0];
  const footYaw = [0, 0];
  const toeBend = [0, 0];
  const walkFoot = [new Float32Array(5), new Float32Array(5)];
  const rootInvQ = new THREE.Quaternion();
  const handWorldR = new THREE.Vector3();
  const IDENT = new THREE.Quaternion();

  const offSpine = d.spine.clone().sub(d.hips);
  const offChest = d.chest.clone().sub(d.spine);
  const offNeck = d.neck.clone().sub(d.chest);
  const offHead = d.head.clone().sub(d.neck);
  const offClav = d.clav.clone().sub(d.chest);
  const offShoulder = d.shoulder.clone().sub(d.clav);
  const offHip = d.hip.clone().sub(d.hips);
  const armLen = d.upperArm + d.foreArm;
  const legLen = d.thigh + d.shin;

  /* ----------------------------------------------------------------- emotion */
  function applyEmotion(e: Emotion, intensity: number): void {
    const def = EMOTIONS[e] ?? EMOTIONS.neutral;
    const k = clamp(intensity, 0, 1.25);
    faceTgt.fill(0);
    talkFaceTgt.fill(0);
    emoBodyTgt.fill(0);
    for (const key in def.face) faceTgt[FC[key as keyof typeof FC]] = def.face[key as keyof typeof FC]! * k;
    if (def.talkFace) for (const key in def.talkFace) talkFaceTgt[FC[key as keyof typeof FC]] = def.talkFace[key as keyof typeof FC]! * k;
    if (def.body) for (const key in def.body) emoBodyTgt[P[key as keyof typeof P] as number] = (def.body as Record<string, number>)[key] * k;
    if (def.arms) {
      for (const key in def.arms) {
        const i = ARM[key as keyof typeof ARM];
        const v = def.arms[key as keyof typeof ARM]! * k;
        emoBodyTgt[P.armL + i] = v;
        emoBodyTgt[P.armR + i] = v;
      }
    }
    emoScalTgt[0] = lerp(1, def.blink ?? 1, k);
    emoScalTgt[1] = lerp(1, def.saccade ?? 1, k);
    emoScalTgt[2] = lerp(1, def.breathRate ?? 1, k);
    emoScalTgt[3] = lerp(1, def.breathAmp ?? 1, k);
    emoScalTgt[4] = lerp(1, def.sway ?? 1, k);
    emoScalTgt[5] = (def.tremor ?? 0) * k;
    emoScalTgt[6] = k;
  }

  /* -------------------------------------------------------------------- walk */
  const walk = { hipsX: 0, hipsY: 0, hipsYaw: 0, hipsRoll: 0, twist: 0, lean: 0, swingL: 0, swingR: 0 };

  function stepFoot(i: number, p: number, sp: number, duty: number, half: number): void {
    const out = walkFoot[i];
    const fwd = Math.max(0, dirZ);
    const aS = 0.3 * Math.min(1, sp / 1.2) * fwd;
    const aH = (0.5 + 0.14 * Math.min(sp / 1.4, 1.6)) * Math.max(0.25, fwd);
    const heel = 0.07;
    const ball = 0.135;
    let along: number;
    let lift: number;
    let pitch: number;
    let toe = 0;
    if (p < duty) {
      const u = p / duty;
      along = half * (1 - 2 * u);
      const st = 1 - smoothstep(0, 0.16, u);
      const ho = smoothstep(0.58, 1, u);
      pitch = -aS * st + aH * ho;
      lift = heel * Math.sin(aS * st) + ball * Math.sin(aH * ho);
      along += ball * (1 - Math.cos(aH * ho)) * K;
      toe = aH * ho;
    } else {
      const s = (p - duty) / (1 - duty);
      const from = -half + ball * (1 - Math.cos(aH)) * K;
      along = lerp(from, half, ease(s));
      pitch = lerp(aH, -aS, smoothstep(0.05, 0.9, s));
      const clear = 0.04 + 0.03 * Math.min(sp / 1.4, 2);
      lift = ball * Math.sin(aH) * (1 - ease(Math.min(1, s / 0.55))) + clear * Math.pow(Math.sin(Math.PI * s), 1.15) + heel * Math.sin(aS) * smoothstep(0.75, 1, s);
      toe = aH * (1 - smoothstep(0, 0.3, s));
    }
    const side = i === 0 ? 1 : -1;
    // canonical foot params: x is "out", so un-mirror the lateral travel
    out[0] = 0.078 + (side * dirX * along) / K;
    out[1] = lift;
    out[2] = 0.012 + (dirZ * along) / K;
    out[3] = pitch;
    out[4] = 0.1;
    toeBend[i] = toe;
  }

  function updateWalk(dt: number): void {
    // measured motion of the root, in its own frame
    root.getWorldPosition(v0);
    root.getWorldQuaternion(rootInvQ).invert();
    let mx = 0;
    let mz = 0;
    let measured = false;
    if (hasLast && dt > 1e-5) {
      v1.subVectors(v0, lastWorld);
      const dist = v1.length();
      if (dist < 0.7 && dist / dt < 9) {
        v1.applyQuaternion(rootInvQ).multiplyScalar(1 / dt);
        mx = v1.x;
        mz = v1.z;
        measured = Math.hypot(mx, mz) > 0.04;
      }
    }
    lastWorld.copy(v0);
    hasLast = true;
    const tx = measured ? mx : 0;
    const tz = measured ? mz : declaredSpeed;
    velX = damp(velX, tx, 9, dt);
    velZ = damp(velZ, tz, 9, dt);
    const sp = Math.hypot(velX, velZ);
    locoW = damp(locoW, sp > 0.1 ? 1 : 0, sp > 0.1 ? 9 : 6, dt);
    if (sp > 0.03) {
      dirX = velX / sp;
      dirZ = velZ / sp;
      const target = clamp(0.7 * Math.pow(sp / 1.4, 0.55), 0.18, 1.05) * K * (man ? 1 : 0.98);
      stepLen = damp(stepLen, target, 8, dt);
      phase += (dt * sp) / (2 * stepLen);
      phase -= Math.floor(phase);
    }
    const duty = clamp(0.64 - 0.04 * (sp - 1.4), 0.52, 0.68);
    const half = duty * stepLen;
    const pL = phase;
    const pR = (phase + 0.5) % 1;
    stepFoot(0, pL, sp, duty, half);
    stepFoot(1, pR, sp, duty, half);
    if (locoW > 0.3 && sp > 0.15 && h.onFootfall) {
      if (pL < prevPL) emitFootfall(0, sp);
      if (pR < prevPR) emitFootfall(1, sp);
    }
    prevPL = pL;
    prevPR = pR;

    const c2 = Math.cos(Math.PI * 2 * phase);
    const sLat = Math.sin(Math.PI * 2 * (phase - 0.05));
    const ds = legLen - Math.sqrt(Math.max(0.01, legLen * legLen - Math.pow(0.52 * stepLen, 2))) + 0.006 * K;
    const mid = 0.02 * K;
    walk.hipsY = -(mid + (ds - mid) * (0.5 + 0.5 * Math.cos(Math.PI * 4 * (phase - 0.02))));
    walk.hipsX = (man ? 0.022 : 0.016) * K * sLat * Math.min(1, 1.2 / Math.max(0.6, sp));
    const Ay = (man ? 0.085 : 0.1) * Math.min(1.3, stepLen / (0.7 * K)) * dirZ;
    walk.hipsYaw = -Ay * c2;
    walk.hipsRoll = (man ? 0.04 : 0.055) * sLat;
    walk.twist = Ay * c2;
    walk.lean = (0.025 + 0.022 * sp) * dirZ;
    const As = (man ? 0.19 : 0.15) * Math.min(1.7, Math.pow(sp / 1.4, 0.8));
    walk.swingL = -As * c2 * dirZ;
    walk.swingR = As * c2 * dirZ;
  }

  function emitFootfall(i: number, sp: number): void {
    const f = walkFoot[i];
    const side = i === 0 ? 1 : -1;
    v2.set(side * f[0] * K, 0, f[2] * K);
    root.localToWorld(v2);
    h.onFootfall?.(i === 0 ? 'left' : 'right', v2.clone(), sp);
  }

  /* ------------------------------------------------------------------ update */
  function update(dtIn: number): void {
    const dt = clamp(dtIn, 0, 0.1);
    time += dt;
    emoTime += dt;
    root.updateWorldMatrix(true, false);

    /* --- smooth the emotion layers */
    const kf = 1 - Math.exp(-dt * 9.5);
    const kb = 1 - Math.exp(-dt * 6);
    for (let i = 0; i < FACE_CHANNELS; i++) {
      faceCur[i] += (faceTgt[i] - faceCur[i]) * kf;
      talkFaceCur[i] += (talkFaceTgt[i] - talkFaceCur[i]) * kf;
    }
    for (let i = 0; i < P.N; i++) emoBody[i] += (emoBodyTgt[i] - emoBody[i]) * kb;
    for (let i = 0; i < emoScal.length; i++) emoScal[i] += (emoScalTgt[i] - emoScal[i]) * kb;
    const emoK = emoScal[6];

    /* --- posture */
    const kp = 1 - Math.exp(-dt * 5.5);
    for (let i = 0; i < P.N; i++) post[i] += (postTarget[i] - post[i]) * kp;

    /* --- gesture */
    if (gesture) {
      gTime += dt;
      if (!evalGesture(gesture, gTime, gf)) gesture = null;
    }
    const gOn = gesture !== null;

    /* --- locomotion */
    updateWalk(dt);
    const wl = locoW;
    const still = 1 - wl;

    /* --- talk */
    talk = damp(talk, talkIn, talkIn > talk ? 28 : 14, dt);
    visTimer -= dt;
    if (visTimer <= 0) {
      visTimer = rng.range(0.07, 0.16);
      visWideT = rng.range(-1, 1);
      visUpT = rng.range(0, 1);
      visOpenT = rng.range(0.55, 1.15);
    }
    visWide = damp(visWide, visWideT, 22, dt);
    visUp = damp(visUp, visUpT, 22, dt);
    visOpen = damp(visOpen, visOpenT, 26, dt);

    /* --- compose the body pose: posture + emotion + idle + walk + gesture */
    for (let i = 0; i < P.N; i++) pose[i] = post[i];
    // emotion layer (hand offsets shrink when the hands are parked on the chest)
    for (let i = 0; i < P.armL; i++) pose[i] += emoBody[i];
    for (const o of [P.armL, P.armR]) {
      const free = 1 - 0.75 * post[o + ARM.chest];
      for (let i = 0; i < 9; i++) pose[o + i] += emoBody[o + i] * free;
      pose[o + ARM.curl] = saturate(pose[o + ARM.curl] + emoBody[o + ARM.curl]);
      pose[o + ARM.thumb] += emoBody[o + ARM.thumb];
    }

    // emotion-specific motion
    const fx = { eyeYaw: 0, eyePitch: 0, drop: 0, lidUp: 0, jaw: 0, nod: 0, turn: 0, tilt: 0, shoulders: 0, lock: 0, pucker: 0, chest: 0 };
    if (emoK > 0.02) emotionMotion(fx, emoK);

    // breathing
    breath += dt * Math.PI * 2 * 0.24 * emoScal[2] * (1 + 0.5 * wl);
    const br = Math.sin(breath + 0.35 * Math.sin(breath));
    const bAmp = emoScal[3] * (1 + 0.6 * wl);
    pose[P.chestPitch] += -0.016 * br * bAmp + fx.chest;
    pose[P.spinePitch] += 0.006 * br * bAmp;
    pose[P.clavUpL] += 0.07 * br * bAmp + fx.shoulders;
    pose[P.clavUpR] += 0.07 * br * bAmp + fx.shoulders;

    // weight shifts and sway (standing only)
    const sw = emoScal[4] * still;
    const sway = noise1(time * 0.13, seed) * 0.016 + noise1(time * 0.31, seed + 3) * 0.006;
    pose[P.hipsX] += sway * sw;
    pose[P.hipsRoll] += sway * 1.6 * sw;
    pose[P.spineRoll] -= sway * 1.3 * sw;
    pose[P.hipsZ] += noise1(time * 0.17, seed + 7) * 0.006 * sw;
    pose[P.spinePitch] += noise1(time * 0.21, seed + 9) * 0.008 * sw;
    pose[P.chestYaw] += noise1(time * 0.11, seed + 11) * 0.02 * sw;
    // small head life
    pose[P.headTurn] += noise1(time * 0.23, seed + 13) * 0.03 + fx.turn;
    pose[P.headNod] += noise1(time * 0.29, seed + 15) * 0.02 + fx.nod;
    pose[P.headTilt] += noise1(time * 0.19, seed + 17) * 0.018 + fx.tilt;
    // speech moves the head
    if (talk > 0.02) {
      pose[P.headNod] += (noise1(time * 2.3, seed + 21) * 0.035 + (visOpen - 0.85) * 0.03) * talk;
      pose[P.headTurn] += noise1(time * 1.3, seed + 23) * 0.03 * talk;
      pose[P.headTilt] += noise1(time * 0.9, seed + 25) * 0.025 * talk;
    }
    // fear tremor
    const trem = emoScal[5];
    if (trem > 0.01) {
      pose[P.headTurn] += noise1(time * 13, seed + 31) * 0.006 * trem;
      pose[P.headNod] += noise1(time * 11, seed + 33) * 0.005 * trem;
      for (const o of [P.armL, P.armR]) {
        pose[o + ARM.hx] += noise1(time * 12, seed + o) * 0.004 * trem;
        pose[o + ARM.hy] += noise1(time * 10, seed + o + 1) * 0.004 * trem;
      }
    }

    // walking: the posture's stance gives way to the cycle
    pose[P.hipsX] = pose[P.hipsX] * still + (walk.hipsX / K) * wl;
    pose[P.hipsZ] *= still;
    pose[P.hipsY] = pose[P.hipsY] * lerp(1, 0.4, wl);
    pose[P.hipsYaw] = pose[P.hipsYaw] * still + walk.hipsYaw * wl;
    pose[P.hipsRoll] = pose[P.hipsRoll] * still + walk.hipsRoll * wl;
    pose[P.hipsPitch] *= still;
    pose[P.spineRoll] = pose[P.spineRoll] * still - walk.hipsRoll * 0.6 * wl;
    pose[P.spineYaw] += walk.twist * 0.5 * wl;
    pose[P.chestYaw] = pose[P.chestYaw] * lerp(1, 0.3, wl) + walk.twist * 1.0 * wl;
    pose[P.spinePitch] += walk.lean * wl;
    const swing = pose[P.swing] * wl;
    for (let i = 0; i < 2; i++) {
      const o = i === 0 ? P.armL : P.armR;
      const s = (i === 0 ? walk.swingL : walk.swingR) * swing;
      const f = Math.max(0, s);
      pose[o + ARM.hz] += s;
      pose[o + ARM.hy] += 0.22 * f + 0.06 * Math.max(0, -s);
      pose[o + ARM.hx] -= 0.1 * f;
      const fo = i === 0 ? P.footL : P.footR;
      for (let k = 0; k < 5; k++) pose[fo + k] = lerp(pose[fo + k], walkFoot[i][k], wl);
    }

    // gesture: additive body + arm overrides
    if (gOn) {
      for (let i = 0; i < P.armL; i++) pose[i] += gf.add[i];
      for (let i = 0; i < ARM_N; i++) {
        pose[P.armL + i] = lerp(pose[P.armL + i], gf.armL[i], gf.wL);
        pose[P.armR + i] = lerp(pose[P.armR + i], gf.armR[i], gf.wR);
      }
    }
    if (debug.armL) for (let i = 0; i < ARM_N; i++) pose[P.armL + i] = debug.armL[i] ?? pose[P.armL + i];
    if (debug.armR) for (let i = 0; i < ARM_N; i++) pose[P.armR + i] = debug.armR[i] ?? pose[P.armR + i];

    /* --- gaze target in root space */
    const hasGaze = gazeTarget !== null;
    if (hasGaze) {
      gazeLocal.copy(gazeTarget!);
      root.worldToLocal(gazeLocal);
      // a different target: let the eyes jump and the lids follow with a blink
      if (gazeLocal.distanceToSquared(lastGazeLocal) > 0.6 && blinkT < 0 && gazeW > 0.5) blinkT = 0;
      lastGazeLocal.copy(gazeLocal);
    }
    gazeW = damp(gazeW, hasGaze ? 1 : 0, 6, dt);
    let yawT = 0;
    let pitchT = 0;
    let gazeDist = 2;
    if (gazeW > 0.001) {
      const dx = lastGazeLocal.x - headCenterRoot.x;
      const dy = lastGazeLocal.y - eyeMidRoot.y;
      const dz = lastGazeLocal.z - headCenterRoot.z;
      gazeDist = Math.max(0.2, Math.hypot(dx, dy, dz));
      yawT = Math.atan2(dx, dz);
      pitchT = Math.atan2(dy, Math.hypot(dx, dz));
    }
    const gLookYaw = gOn ? gf.lookYaw : 0;
    const lookHand = gOn ? gf.lookHand : 0;
    bodyFollow = damp(bodyFollow, clamp(yawT * 0.22, -0.32, 0.32) * gazeW * (1 - lookHand), 3.5, dt);
    pose[P.spineYaw] += bodyFollow * 0.4;
    pose[P.chestYaw] += bodyFollow * 0.6;

    /* --- trunk */
    hipsPos.set(d.hips.x + pose[P.hipsX] * K, d.hips.y + pose[P.hipsY] * K + walk.hipsY * wl, d.hips.z + pose[P.hipsZ] * K);
    qEuler(hipsQ, pose[P.hipsPitch], pose[P.hipsYaw], pose[P.hipsRoll]);

    // feet (root space) and the reach constraint that keeps them planted
    let need = 0;
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const fo = i === 0 ? P.footL : P.footR;
      footT[i].set(side * pose[fo] * K, d.ankleH + pose[fo + 1] * K, pose[fo + 2] * K);
      footPitch[i] = pose[fo + 3];
      footYaw[i] = pose[fo + 4];
      v0.set(side * offHip.x, offHip.y, offHip.z).applyQuaternion(hipsQ).add(hipsPos);
      const hx = footT[i].x - v0.x;
      const hz = footT[i].z - v0.z;
      const hor2 = hx * hx + hz * hz;
      const max = legLen * 0.997;
      if (hor2 < max * max) {
        const top = footT[i].y + Math.sqrt(max * max - hor2);
        if (top < v0.y) need = Math.min(need, top - v0.y);
      }
    }
    hipDropSm = need < hipDropSm ? damp(hipDropSm, need, 40, dt) : damp(hipDropSm, need, 12, dt);
    hipsPos.y += hipDropSm;

    // lean toward whoever he is looking at (lean_in, reach)
    const lean = gOn ? gf.lean : 0;
    qEuler(spineQl, pose[P.spinePitch], pose[P.spineYaw], pose[P.spineRoll]);
    qEuler(chestQl, pose[P.chestPitch], pose[P.chestYaw], pose[P.chestRoll]);
    if (lean !== 0) {
      const psi = clamp(yawT * gazeW, -0.9, 0.9);
      v0.set(Math.cos(psi), 0, -Math.sin(psi));
      q0.setFromAxisAngle(v0, lean * 0.6);
      spineQl.premultiply(q0);
      q0.setFromAxisAngle(v0, lean * 0.4);
      chestQl.premultiply(q0);
    }
    spineQ.multiplyQuaternions(hipsQ, spineQl);
    spinePos.copy(offSpine).applyQuaternion(hipsQ).add(hipsPos);
    chestQ.multiplyQuaternions(spineQ, chestQl);
    chestPos.copy(offChest).applyQuaternion(spineQ).add(spinePos);
    neckPos.copy(offNeck).applyQuaternion(chestQ).add(chestPos);

    // chest heading and pitch, for the arm frame and the resting head
    v0.set(0, 0, 1).applyQuaternion(chestQ);
    const chestYaw = Math.atan2(v0.x, v0.z);
    const chestDown = -Math.asin(clamp(v0.y, -1, 1));
    yawQ.setFromAxisAngle(UP, chestYaw);

    /* --- head */
    const yawGoal = clamp(yawT, chestYaw - 1.22, chestYaw + 1.22) * 0.92;
    const pitchGoal = clamp(pitchT, -0.7, 0.6) * 0.82;
    {
      // critically damped springs
      const w = 10;
      const ay = w * w * (yawGoal * gazeW - headYaw) - 2 * w * headYawV;
      headYawV += ay * dt;
      headYaw += headYawV * dt;
      const ap = w * w * (pitchGoal * gazeW - headPitch) - 2 * w * headPitchV;
      headPitchV += ap * dt;
      headPitch += headPitchV * dt;
    }
    const restYaw = chestYaw * 0.85 * (1 - gazeW);
    const restDown = chestDown * 0.55 * (1 - gazeW);
    const dropAngle = fx.drop > 0 ? Math.atan2(fx.drop, gazeDist) : 0;
    let hYaw = headYaw + restYaw + pose[P.headTurn] + gLookYaw * 0.8;
    let hDown = -headPitch + restDown + pose[P.headNod] + dropAngle * 0.26 - (gOn ? gf.lookPitch : 0);
    const hTilt = pose[P.headTilt];
    if (lookHand > 0) {
      // look at the phone in the right hand (previous frame's position is fine)
      const dx = handWorldR.x - headCenterRoot.x;
      const dy = handWorldR.y + 0.06 * K - eyeMidRoot.y;
      const dz = handWorldR.z - headCenterRoot.z;
      hYaw = lerp(hYaw, Math.atan2(dx, dz) * 0.8, lookHand);
      hDown = lerp(hDown, -Math.atan2(dy, Math.hypot(dx, dz)) * 0.72, lookHand);
    }
    hYaw = clamp(hYaw, chestYaw - 1.4, chestYaw + 1.4);
    qEuler(headQ, hDown, hYaw, hTilt, 'YXZ');
    // split between neck and head
    q0.copy(chestQ).invert().multiply(headQ);
    neckQl.copy(IDENT).slerp(q0, 0.42);
    headQl.copy(neckQl).invert().multiply(q0);
    const fwd = pose[P.headFwd] * 0.3;
    if (fwd !== 0) {
      q1.setFromAxisAngle(_vx.set(1, 0, 0), fwd);
      neckQl.multiply(q1);
      q1.invert();
      headQl.premultiply(q1);
    }
    neckQ.multiplyQuaternions(chestQ, neckQl);
    headPos.copy(offHead).applyQuaternion(neckQ).add(neckPos);
    headQ.multiplyQuaternions(neckQ, headQl);
    headCenterRoot.set(0, 0.04 * d.headScale, 0.02 * d.headScale).applyQuaternion(headQ).add(headPos);
    eyeMidRoot.set(0, 0.0322 * d.headScale, 0.075 * d.headScale).applyQuaternion(headQ).add(headPos);

    /* --- write the trunk */
    bones[B.hips].position.copy(hipsPos);
    bones[B.hips].quaternion.copy(hipsQ);
    bones[B.spine].quaternion.copy(spineQl);
    bones[B.chest].quaternion.copy(chestQl);
    bones[B.neck].quaternion.copy(neckQl);
    bones[B.head].quaternion.copy(headQl);

    /* --- arms */
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const bo = i === 0 ? 0 : 10;
      const o = i === 0 ? P.armL : P.armR;
      for (let k = 0; k < ARM_N; k++) armA[k] = pose[o + k];
      const up = i === 0 ? pose[P.clavUpL] : pose[P.clavUpR];
      const fw = i === 0 ? pose[P.clavFwdL] : pose[P.clavFwdR];
      qEuler(clavQl, 0, -side * fw * 0.28, side * up * 0.3, 'YXZ');
      clavQ.multiplyQuaternions(chestQ, clavQl);
      v0.set(side * offClav.x, offClav.y, offClav.z).applyQuaternion(chestQ).add(chestPos);
      S.set(side * offShoulder.x, offShoulder.y, offShoulder.z).applyQuaternion(clavQ).add(v0);
      const cs = saturate(armA[ARM.chest]);
      q0.copy(yawQ).slerp(chestQ, cs);
      T.set(side * armA[ARM.hx] * K, armA[ARM.hy] * K, armA[ARM.hz] * K).applyQuaternion(q0).add(S);
      pole.set(side * armA[ARM.px], armA[ARM.py], armA[ARM.pz]).applyQuaternion(q0);
      const aim = gOn ? (i === 0 ? gf.aimL * gf.wL : gf.aimR * gf.wR) : 0;
      if (aim > 0) {
        if (gazeW > 0.3) v1.set(lastGazeLocal.x, lastGazeLocal.y - gf.aimDrop, lastGazeLocal.z).sub(S).normalize();
        else v1.set(0, -0.12, 1).normalize().applyQuaternion(yawQ);
        v1.multiplyScalar(gf.aimDist * armLen).add(S);
        T.lerp(v1, aim);
      }
      solveLimb(S, T, d.upperArm, d.foreArm, pole, 1, upperQ, lowerQ);
      bones[B.clavL + bo].quaternion.copy(clavQl);
      bones[B.upperArmL + bo].quaternion.copy(clavQ).invert().multiply(upperQ);
      bones[B.foreArmL + bo].quaternion.copy(upperQ).invert().multiply(lowerQ);
      qEuler(bones[B.handL + bo].quaternion, armA[ARM.wx], side * armA[ARM.wy], -side * armA[ARM.wz], 'YZX');
      // fingers
      const curl = saturate(armA[ARM.curl]);
      const pt = saturate(armA[ARM.point]);
      const ic = lerp(curl, 0.04, pt);
      bones[B.fingL1 + bo].rotation.z = -side * curl * 1.45;
      bones[B.fingL2 + bo].rotation.z = -side * curl * 1.75;
      bones[B.indexL1 + bo].rotation.z = -side * ic * 1.4;
      bones[B.indexL2 + bo].rotation.z = -side * ic * 1.7;
      const tc = armA[ARM.thumb];
      bones[B.thumbL1 + bo].rotation.set(0.15 * tc, -side * 0.55 * tc, -side * 0.35 * tc);
      bones[B.thumbL2 + bo].rotation.set(0.25 * tc, 0, -side * 0.6 * Math.max(0, tc));
      if (i === 1) {
        // wrist position, for looking at the phone
        handWorldR.copy(T);
      }
    }

    /* --- legs */
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const bo = i === 0 ? 0 : 4;
      S.set(side * offHip.x, offHip.y, offHip.z).applyQuaternion(hipsQ).add(hipsPos);
      const yaw = side * footYaw[i];
      pole.set(Math.sin(yaw * 0.8) + side * 0.1, 0, Math.cos(yaw * 0.8));
      solveLimb(S, footT[i], d.thigh, d.shin, pole, -1, upperQ, lowerQ);
      bones[B.upperLegL + bo].quaternion.copy(hipsQ).invert().multiply(upperQ);
      bones[B.lowerLegL + bo].quaternion.copy(upperQ).invert().multiply(lowerQ);
      qEuler(q0, footPitch[i], yaw, 0, 'YXZ');
      bones[B.footL + bo].quaternion.copy(lowerQ).invert().multiply(q0);
      bones[B.toeL + bo].rotation.x = -toeBend[i] * wl;
    }

    /* --- bag hangs plumb, with a little swing */
    {
      v0.copy(UP).applyQuaternion(q0.copy(chestQ).invert());
      q1.setFromUnitVectors(UP, v0);
      q2.setFromAxisAngle(_vx.set(1, 0, 0), 0.05 * Math.sin(Math.PI * 2 * phase + 0.6) * wl);
      bones[B.bag].quaternion.copy(q1).multiply(q2);
    }

    /* --- face */
    updateFace(dt, fx, hasGaze, gazeDist, lookHand, gLookYaw);

    phone.visible = gOn && gf.phone > 0.02;
    if (phone.visible) phone.scale.setScalar(Math.max(0.01, gf.phone));
  }

  /* --------------------------------------------- emotion-specific movement */
  interface Fx {
    eyeYaw: number;
    eyePitch: number;
    /** metres below the gaze target the eyes travel to (the leer) */
    drop: number;
    lidUp: number;
    jaw: number;
    nod: number;
    turn: number;
    tilt: number;
    shoulders: number;
    lock: number;
    pucker: number;
    chest: number;
  }

  function emotionMotion(fx: Fx, k: number): void {
    const t = emoTime;
    switch (emotion) {
      case 'leer': {
        // eyes travel slowly down her body and back up to her face
        const u = t % 5.4;
        const s = scurve(
          [
            [0, 0],
            [0.7, 0],
            [2.1, 1],
            [2.9, 1],
            [4.2, 0],
            [5.4, 0],
          ],
          u,
        );
        fx.drop = 0.62 * s * k;
        fx.tilt = 0.03 * s * k;
        break;
      }
      case 'mocking': {
        // bursts of laughter: jaw and shoulders bounce together
        const u = t % 2.7;
        const env = smoothstep(0, 0.12, u) * (1 - smoothstep(0.95, 1.35, u));
        const p = Math.pow(Math.max(0, Math.sin(u * Math.PI * 2 * 5.1)), 1.4) * env;
        fx.jaw = (0.22 * p + 0.12 * env - 0.1 * (1 - env)) * k;
        fx.shoulders = 0.35 * p * k;
        fx.nod = (-0.07 * env + 0.025 * p) * k;
        fx.lidUp = 0.1 * env * k;
        fx.chest = -0.02 * p * k;
        break;
      }
      case 'annoyed': {
        // look away with an eye-roll, breathe out, come back
        const u = t % 5.0;
        const s = scurve(
          [
            [0, 0],
            [1.1, 0],
            [1.45, 1],
            [2.05, 1],
            [2.5, 0],
            [5, 0],
          ],
          u,
        );
        fx.eyePitch = 0.36 * s * k;
        fx.eyeYaw = -0.42 * s * k;
        fx.turn = -0.14 * s * k;
        fx.tilt = 0.05 * s * k;
        fx.nod = -0.05 * s * k;
        fx.lidUp = -0.12 * s * k;
        fx.chest = 0.03 * s * k;
        break;
      }
      case 'sheepish': {
        // eyes mostly elsewhere, with quick checks back
        const u = t % 2.9;
        const away = 1 - smoothstep(1.9, 2.0, u) * (1 - smoothstep(2.45, 2.6, u));
        const a = away * smoothstep(0.0, 0.35, t) * k;
        fx.eyeYaw = 0.34 * a;
        fx.eyePitch = -0.2 * a;
        fx.turn = -0.1 * (1 - away) * k;
        break;
      }
      case 'relieved': {
        // the long breath out: eyes close, shoulders fall
        const s = scurve(
          [
            [0, 0],
            [0.25, 1],
            [0.95, 1],
            [1.5, 0],
          ],
          t,
        );
        fx.lidUp = 1.0 * s * k;
        fx.jaw = 0.1 * s * k;
        fx.pucker = 0.3 * s * k;
        fx.nod = (-0.07 * scurve([[0, 0], [0.4, 1], [1.0, 0.2], [1.6, 0]], t) + 0.05 * scurve([[0.8, 0], [1.4, 1], [2.6, 0]], t)) * k;
        fx.shoulders = -0.35 * scurve([[0, 0], [0.9, 1], [2.2, 0]], t) * k;
        fx.chest = 0.05 * s * k;
        break;
      }
      case 'surprised': {
        const s = scurve([[0, 0], [0.12, 1], [0.5, 0]], t);
        fx.nod = -0.06 * s * k;
        fx.shoulders = 0.3 * s * k;
        fx.lidUp = -0.2 * s * k;
        break;
      }
      case 'afraid': {
        // a darting glance for a way out, then straight back to the threat
        const u = t % 3.6;
        const s = smoothstep(2.6, 2.68, u) * (1 - smoothstep(2.95, 3.05, u));
        fx.eyeYaw = -0.38 * s * k;
        break;
      }
      case 'worried': {
        const u = t % 4.2;
        const s = smoothstep(2.4, 2.55, u) * (1 - smoothstep(3.1, 3.3, u));
        const dir = Math.floor(t / 4.2) % 2 === 0 ? 1 : -1;
        fx.eyeYaw = 0.4 * dir * s * k;
        fx.turn = 0.12 * dir * s * k;
        break;
      }
      case 'angry':
      case 'determined':
        fx.lock = k;
        break;
      default:
        break;
    }
  }

  /* -------------------------------------------------------------------- face */
  function updateFace(dt: number, fx: Fx, hasGaze: boolean, gazeDist: number, lookHand: number, lookYaw: number): void {
    for (let i = 0; i < FACE_CHANNELS; i++) faceOut[i] = faceCur[i] + talkFaceCur[i] * Math.min(1, talk * 1.6);
    if (gesture) for (let i = 0; i < FACE_CHANNELS; i++) faceOut[i] += gf.face[i];

    // speech
    if (talk > 0.005) {
      const tk = Math.pow(talk, 0.8);
      faceOut[FC.jawOpen] += 0.44 * tk * visOpen;
      faceOut[FC.lipsPart] += 0.5 * tk;
      faceOut[FC.lowerLipDrop] += 0.2 * tk * visUp;
      faceOut[FC.upperLipUp] += 0.22 * tk * visUp;
      faceOut[FC.pucker] += 0.55 * Math.max(0, -visWide) * tk;
      faceOut[FC.stretchL] += 0.28 * Math.max(0, visWide) * tk;
      faceOut[FC.stretchR] += 0.28 * Math.max(0, visWide) * tk;
      // lips cannot stay pressed while speaking
      faceOut[FC.lipPress] *= 1 - 0.8 * Math.min(1, talk * 2);
      faceOut[FC.browRaiseL] += 0.1 * tk * visUp;
      faceOut[FC.browRaiseR] += 0.1 * tk * visUp;
    }
    faceOut[FC.jawOpen] += fx.jaw;
    faceOut[FC.pucker] += fx.pucker;

    // blink
    nextBlink -= dt * emoScal[0];
    if (debug.noBlink) blinkT = -1;
    else if (nextBlink <= 0 && blinkT < 0) {
      blinkT = 0;
      nextBlink = rng.range(2.2, 5.6);
      if (rng.next() < 0.15) nextBlink = 0.32;
    }
    let blink = 0;
    if (blinkT >= 0) {
      blinkT += dt;
      blink = blinkT < 0.065 ? ease(blinkT / 0.065) : 1 - ease((blinkT - 0.065) / 0.11);
      if (blinkT > 0.175) blinkT = -1;
    }

    /* eyes */
    // saccades: tiny refixations so the eyes never look painted on
    sacTimer -= dt;
    if (sacTimer <= 0) {
      sacTimer = rng.range(0.5, 2.4);
      const amp = 0.035 * emoScal[1] * (1 - 0.9 * fx.lock);
      sacX = rng.range(-1, 1) * amp;
      sacY = rng.range(-1, 1) * amp * 0.6;
    }
    sacXs = damp(sacXs, sacX, 40, dt);
    sacYs = damp(sacYs, sacY, 40, dt);

    const hs = d.headScale;
    let pitchAvg = 0;
    for (let i = 0; i < 2; i++) {
      const eye = i === 0 ? face.eyeL : face.eyeR;
      const c = i === 0 ? face.eyeCenterL : face.eyeCenterR;
      let yaw = 0;
      let pitch = 0;
      if (lookHand > 0.5) {
        v0.copy(handWorldR);
        v0.y += 0.07 * K;
        v1.copy(c).multiplyScalar(hs).applyQuaternion(headQ).add(headPos);
        v0.sub(v1).applyQuaternion(q0.copy(headQ).invert());
        yaw = Math.atan2(v0.x, v0.z);
        pitch = Math.atan2(v0.y, Math.hypot(v0.x, v0.z));
      } else if (gazeW > 0.02) {
        v0.copy(lastGazeLocal);
        v0.y -= fx.drop;
        v1.copy(c).multiplyScalar(hs).applyQuaternion(headQ).add(headPos);
        v0.sub(v1).applyQuaternion(q0.copy(headQ).invert());
        yaw = Math.atan2(v0.x, v0.z) * gazeW;
        pitch = Math.atan2(v0.y, Math.hypot(v0.x, v0.z)) * gazeW;
      }
      // looking around: the eyes lead the head
      yaw += lookYaw * 0.35 + fx.eyeYaw + sacXs;
      pitch += fx.eyePitch + sacYs;
      yaw = clamp(yaw, -0.68, 0.68);
      pitch = clamp(pitch, -0.52, 0.46);
      eye.rotation.set(-pitch, yaw, 0);
      pitchAvg += pitch * 0.5;
    }
    void hasGaze;
    void gazeDist;

    // lids ride with the eyes, then the blink
    const lidGaze = -pitchAvg * 0.85;
    // unless he is blinking, the lid never hides the pupil: the gaze has to stay readable
    const uMax = Math.max(0.3, (4.1 - 11.8 * Math.sin(pitchAvg)) / 7.9);
    for (const [up, low] of [
      [FC.lidUpL, FC.lidLowL],
      [FC.lidUpR, FC.lidLowR],
    ]) {
      let u = Math.min(faceOut[up] + lidGaze, uMax) + fx.lidUp;
      u = lerp(u, 1, blink);
      faceOut[up] = Math.max(u, blink);
      faceOut[low] += 0.25 * blink - 1.1 * Math.max(0, lidGaze);
    }

    face.apply(debug.face ?? faceOut);
  }

  /* --------------------------------------------------------------------- api */
  const h: HumanExt = {
    root,
    height: H,
    onFootfall: null,
    debug,
    get gestureRemaining(): number {
      return gesture ? Math.max(0, GESTURE_DURATION[gesture] - gTime) : 0;
    },
    getHeadPosition(out = new THREE.Vector3()): THREE.Vector3 {
      root.updateWorldMatrix(true, false);
      return out.copy(headCenterRoot).applyMatrix4(root.matrixWorld);
    },
    getEyePosition(out = new THREE.Vector3()): THREE.Vector3 {
      root.updateWorldMatrix(true, false);
      return out.copy(eyeMidRoot).applyMatrix4(root.matrixWorld);
    },
    setEmotion(e: Emotion, intensity = 1): void {
      if (e !== emotion) emoTime = 0;
      emotion = e;
      applyEmotion(e, intensity);
    },
    setGaze(target: THREE.Vector3 | null): void {
      // looking up at someone ends the phone check
      if (target && target !== gazeTarget && gesture === 'check_phone') h.stopGesture();
      gazeTarget = target;
    },
    setTalking(level: number): void {
      talkIn = clamp(level, 0, 1);
    },
    playGesture(g: Gesture): void {
      if (!(g in GESTURE_DURATION)) return;
      gesture = g;
      gTime = 0;
    },
    stopGesture(): void {
      if (!gesture) return;
      const dur = GESTURE_DURATION[gesture];
      gTime = Math.max(gTime, dur - 0.5);
    },
    setPosture(p: Posture): void {
      const next = POSTURES[p] ?? POSTURES.stand;
      if (next !== postTarget && (gesture === 'arms_crossed' || gesture === 'check_phone')) h.stopGesture();
      postTarget = next;
    },
    setLocomotion(speed: number): void {
      declaredSpeed = Number.isFinite(speed) ? speed : 0;
    },
    setVisible(visible: boolean): void {
      root.visible = visible;
    },
    update,
    dispose(): void {
      root.removeFromParent();
      bodyGeo.dispose();
      skeleton.dispose();
      face.dispose();
      phoneGeo.dispose();
      releaseMaterials();
    },
  };

  applyEmotion('neutral', 0);
  update(0);
  return h;
}
