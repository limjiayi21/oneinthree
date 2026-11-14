/**
 * First-person player controller.
 *
 * This is not a game character. She walks (1.45 m/s), can hurry (2.3 m/s),
 * cannot run or jump, and her body reacts before she decides to: it flinches,
 * steps back, startles, glances over its shoulder and freezes. All of those
 * are additive layers on top of the player's own look and movement:
 *
 *   look      = mouse yaw/pitch  + glance blend + recoil springs + breathing + tremor
 *   position  = walking (accelerated, collided) + reaction displacement (collided)
 *   eye       = eye height + head bob + startle jolt + flinch dip + breathing
 *
 * Reactions are spring impulses and short envelopes, so any number of them
 * compose and every one of them returns the view to rest on its own.
 *
 * Conventions: yaw 0 faces -Z, positive yaw turns left; pitch + is up.
 * The controller drives engine.camera directly in update().
 */

import * as THREE from 'three';
import type { DynamicCollider, Engine, Player, PlayerEvents, StreetWorld } from '../contracts';
import { createBody, type BodyFrame, type BodyKind } from './body';
import { circlePenetration, clampToBounds, pushOutOfCircle, pushOutOfRect, type Vec2 } from './collision';
import { createInput, type MoveIntent } from './input';
import type { EyeLookSource } from './eyes';
import { DEG, Spring, clamp, clamp01, createRng, damp, easeOutCubic, forwardX, forwardZ, lerp, smoothstep, wrapAngle, yawOf } from './mathx';

export interface PlayerOptions {
  body?: BodyKind;
  /**
   * Default true: keys and mouse only respond while the pointer is locked.
   * false (automation, accessibility fallback): WASD works without the lock,
   * Arrow-Left / Arrow-Right and mouse-drag turn the view, `isLocked` reports
   * true and 'unlock' is never emitted.
   */
  requireLock?: boolean;
  /** Optional webcam head look; read every frame while input is live. */
  eyes?: EyeLookSource;
  /** Extra movement source (the paired phone), added to the keys. */
  extraMove?: () => { forward: number; hurry: boolean } | null;
}

/** Additive reaction layers, for tests and the dev harness. Everything is 0 at rest. */
export interface ReactionState {
  /** Recoil offsets in degrees. */
  yaw: number;
  pitch: number;
  roll: number;
  /** Vertical reaction offset of the eye in metres (startle jolt + flinch dip + settle). */
  lift: number;
  /** FOV kick in degrees. */
  fov: number;
  /** Glance offsets in degrees. */
  glanceYaw: number;
  glancePitch: number;
  /** 0..1 hands raised by a flinch / startle. */
  guard: number;
  /** 0..1 keys hand raised by tension. */
  keys: number;
  /** 0..1 phone raised. */
  phone: number;
  /** 0..1 how much the legs respond to input (0 while frozen / startled / stepping back). */
  legs: number;
  /** Transient tension added by reactions; decays by itself. */
  arousal: number;
  /** Smoothed setTension() level. */
  tension: number;
  /** True while a flinch lurch or forced step is still moving the body. */
  displacing: boolean;
  /** True when every reaction layer has returned to rest. */
  atRest: boolean;
}

/** The contract's Player plus a few read-outs used by the harness and tests. */
export interface PlayerController extends Player {
  /** Look pitch in radians (+ up), without reaction offsets. */
  readonly pitch: number;
  /** Pitch the camera actually shows, including head look and reactions. */
  readonly viewPitch: number;
  readonly radius: number;
  readonly body: BodyKind;
  /** Set the look direction directly (harness / cutscenes). */
  setLook(yaw: number, pitch: number): void;
  getReactionState(): ReactionState;
}

export const PLAYER_TUNING = {
  radius: 0.3,
  walkSpeed: 1.45,
  hurrySpeed: 2.3,
  /** Backwards and sideways are slower than forwards. */
  slowFactor: 0.7,
  accelRate: 7.5, // 1/s, exponential approach to the wanted velocity
  decelRate: 9.5,
  mouseSensitivity: 0.0021, // rad per CSS pixel
  keyTurnRate: 105 * DEG, // rad/s, only without pointer lock
  pitchMin: -80 * DEG,
  pitchMax: 75 * DEG,
  eyeHeight: { woman: 1.62, bystander: 1.72 } as Record<BodyKind, number>,
  /** Step length (one footfall to the next) at walking speed. */
  stride: 0.68,
  /** Speed multiplier while pressed against an NPC: squeezing past is slow. */
  contactSlow: 0.5,
  bumpInterval: 0.8, // s between 'bumped' events
  /** Glance never takes more than this share of the view. */
  maxGlanceWeight: 0.8,
  startleFreeze: 0.35, // s
} as const;

const T = PLAYER_TUNING;
const MAX_GLANCE_TURN = 165 * DEG;

interface Push {
  dx: number;
  dz: number;
  distance: number;
  duration: number;
  t: number;
  /** Footfalls this displacement produces. */
  steps: number;
  /** 'out' = one sharp lurch; 'steps' = each step eases in and out. */
  ease: 'out' | 'steps';
  /** Player movement input is ignored while it runs. */
  suppress: boolean;
}

interface Glance {
  target: THREE.Vector3;
  t: number;
  duration: number;
  weight: number;
  lastDelta: number;
}

function pushEase(p: Push, t: number): number {
  const u = clamp01(t / p.duration);
  if (p.ease === 'out') return easeOutCubic(u);
  const n = Math.max(1, p.steps);
  const s = u * n;
  const i = Math.min(n - 1, Math.floor(s));
  return (i + smoothstep(s - i)) / n;
}

/** Step length grows a little with speed, so cadence stays human (about 128 steps/min walking, 157 hurrying). */
function stepLength(speed: number): number {
  return clamp(T.stride + (speed - T.walkSpeed) * 0.235, 0.42, 0.9);
}

export function createPlayer(engine: Engine, world: Pick<StreetWorld, 'colliders' | 'bounds' | 'surfaceAt'>, opts: PlayerOptions = {}): PlayerController {
  const kind: BodyKind = opts.body === 'bystander' ? 'bystander' : 'woman';
  const requireLock = opts.requireLock ?? true;
  const eyeHeight = T.eyeHeight[kind];
  const camera = engine.camera;
  const pulse = (s: number) => {
    if (typeof engine.pulse === 'function') engine.pulse(clamp01(s));
  };

  /* ---------------------------------------------------------------- state */

  const position = new THREE.Vector3();
  const vel: Vec2 = { x: 0, z: 0 };
  let yaw = 0;
  let pitch = 0;
  let turnVel = 0;
  let inputEnabled = true;
  let disposed = false;
  let time = 0;

  // locomotion
  const intent: MoveIntent = { forward: 0, strafe: 0, turn: 0, hurry: false };
  let phase = Math.PI / 2; // footfall at every multiple of PI
  let footIndex = 0;
  let gait = 0; // 0..1 leg / bob amplitude
  let gaitSpeed = 0; // smoothed ground speed including reaction displacement
  let moveRight = 0;
  let moveForward = 1;
  let strafeLean = 0;
  let contactSlow = 1;
  let lastBump = -10;

  // reactions
  const pushes: Push[] = [];
  const rYaw = new Spring(15, 0.48); // degrees
  const rPitch = new Spring(15, 0.5);
  const rRoll = new Spring(13, 0.55);
  const dip = new Spring(13, 0.62); // metres: shoulders up, head down
  const jolt = new Spring(17, 0.42); // metres: startle jump
  const fovKick = new Spring(16, 0.9); // degrees
  const sag = new Spring(3.6, 0.85); // metres: knees stay soft for a second after a startle
  let inputFreeze = 0; // startle: seconds of ignored movement input
  let freezeTimer = 0; // freeze(): seconds remaining
  let legs = 1; // 0..1 scale on movement input
  let suppressTail = 0;
  let guard = 0;
  let guardPeak = 0;
  let guardHold = 0;
  let keys = 0;
  let phoneTarget = 0;
  let phone = 0;
  let tensionTarget = 0;
  let tension = 0;
  let arousal = 0;
  let breath = 0;
  let glance: Glance | null = null;
  let glanceYaw = 0;
  let glancePitch = 0;
  // webcam eye-look: a head turn on top of the body yaw, like a glance
  let eyeYaw = 0;
  let eyePitch = 0;
  const rng = createRng(0x51ed270b);

  // camera bookkeeping
  let baseFov = camera.fov;
  let lastFovSet = camera.fov;
  let viewYaw = 0;
  let viewPitch = 0;

  const colliders: DynamicCollider[] = [];
  const listeners: { [K in keyof PlayerEvents]: Set<(payload: PlayerEvents[K]) => void> } = {
    step: new Set(),
    lock: new Set(),
    unlock: new Set(),
    bumped: new Set(),
  };
  function emit<K extends keyof PlayerEvents>(event: K, payload: PlayerEvents[K]): void {
    for (const cb of [...listeners[event]]) cb(payload);
  }

  const body = createBody(kind, eyeHeight);
  engine.scene.add(body.group);

  const input = createInput(engine.renderer.domElement, {
    requireLock,
    extraMove: opts.extraMove,
    // only while the game is live: never under a pause overlay or a cutscene
    canRelock: () => inputEnabled && !disposed,
    onLook(dx, dy) {
      if (!inputEnabled || disposed) return;
      yaw = wrapAngle(yaw - dx * T.mouseSensitivity);
      pitch = clamp(pitch - dy * T.mouseSensitivity, T.pitchMin, T.pitchMax);
    },
    onLock: () => emit('lock', undefined),
    onUnlock: () => emit('unlock', undefined),
  });

  /* ------------------------------------------------------------ collision */

  const p: Vec2 = { x: 0, z: 0 };
  const n: Vec2 = { x: 0, z: 0 };
  let contact: DynamicCollider | null = null;
  let contactNx = 0;
  let contactNz = 0;
  let contactDepth = 0;
  let touchedAnything = false;

  function dynamicPenetration(x: number, z: number): number {
    let worst = 0;
    for (const c of colliders) {
      const r = c.radius;
      if (!(r > 0)) continue; // a hidden / departed NPC has no body
      const cp = c.getPosition();
      const pen = circlePenetration(x, z, T.radius, cp.x, cp.z, r);
      if (pen > worst) worst = pen;
    }
    return worst;
  }

  function resolve(): void {
    const statics = world.colliders;
    for (let iter = 0; iter < 6; iter++) {
      let any = false;
      for (const c of colliders) {
        const r = c.radius;
        if (!(r > 0)) continue;
        const cp = c.getPosition();
        // if exactly coincident, leave backwards
        const pen = pushOutOfCircle(p, T.radius, cp.x, cp.z, r, n, -forwardX(yaw), -forwardZ(yaw));
        if (pen > 1e-6) {
          any = true;
          if (pen > contactDepth || contact === null) {
            contact = c;
            contactNx = n.x;
            contactNz = n.z;
            contactDepth = pen;
          }
        }
      }
      // Statics and bounds go last in every pass: walls always win over bodies.
      for (let i = 0; i < statics.length; i++) {
        if (pushOutOfRect(p, T.radius, statics[i]) > 1e-6) any = true;
      }
      if (clampToBounds(p, T.radius, world.bounds)) any = true;
      if (!any) break;
      touchedAnything = true;
    }
  }

  /**
   * Move by (dx, dz) with sliding. A move that would leave her overlapping an
   * NPC (no room between him and a wall) is refused: she can slide around him
   * where there is space and nowhere else.
   */
  function moveAndCollide(dx: number, dz: number): void {
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-7) return;
    const subs = Math.max(1, Math.ceil(dist / 0.1));
    const sx = dx / subs;
    const sz = dz / subs;
    for (let i = 0; i < subs; i++) {
      const ox = position.x;
      const oz = position.z;
      const before = dynamicPenetration(ox, oz);
      p.x = ox + sx;
      p.z = oz + sz;
      resolve();
      const after = dynamicPenetration(p.x, p.z);
      if (after > 0.004 && after > before - 1e-5) {
        touchedAnything = true;
        return; // wedged: stay where she was
      }
      position.x = p.x;
      position.z = p.z;
    }
  }

  /* ------------------------------------------------------------- footfalls */

  function emitFootfalls(): void {
    const idx = Math.floor(phase / Math.PI + 1e-6);
    while (footIndex < idx) {
      footIndex++;
      if (listeners.step.size > 0) {
        emit('step', { surface: world.surfaceAt(position.x, position.z), speed: gaitSpeed, position: position.clone() });
      }
    }
  }

  /* ---------------------------------------------------------------- camera */

  const frame: BodyFrame = {
    x: 0,
    z: 0,
    yaw: 0,
    eyeX: 0,
    eyeY: eyeHeight,
    eyeZ: 0,
    pitch: 0,
    phase,
    gait: 0,
    stepLength: T.stride,
    moveRight: 0,
    moveForward: 1,
    bob: 0,
    keysRaise: 0,
    guardRaise: 0,
    phoneRaise: 0,
    tremor: 0,
    time: 0,
    fovDeg: baseFov,
  };

  function applyCamera(): void {
    const level = clamp01(tension + arousal);

    // breathing: slow at rest, fast and shallow-then-deep as tension rises
    const breathY = Math.sin(breath) * (0.0022 + 0.0075 * level);
    const swayPitch = Math.sin(breath + 0.6) * (0.09 + 0.45 * level) * DEG;
    const swayYaw = Math.sin(breath * 0.5 + 1.3) * (0.05 + 0.28 * level) * DEG;
    const swayRoll = Math.sin(breath * 0.5) * 0.09 * level * DEG;

    // fine tremor: only at high tension, a fraction of a degree
    const tremor = smoothstep((level - 0.55) / 0.45);
    const tremYaw = tremor * 0.1 * DEG * (Math.sin(time * 58.4) + 0.6 * Math.sin(time * 82.3 + 1)) * 0.62;
    const tremPitch = tremor * 0.09 * DEG * (Math.sin(time * 67.2 + 2) + 0.6 * Math.sin(time * 49.6)) * 0.62;
    const tremRoll = tremor * 0.05 * DEG * Math.sin(time * 73.9 + 0.5);

    // head bob: lowest at each footfall, weight over the planted foot
    // (kept well under real head travel, about 3 cm peak to peak walking: this is a long walk)
    const bobAmp = lerp(0.012, 0.022, clamp01((gaitSpeed - 1.0) / 1.3)) * gait;
    const bobY = -Math.cos(2 * phase) * bobAmp;
    const bobX = -Math.sin(phase) * 0.008 * gait;
    const bobRoll = Math.sin(phase) * 0.16 * DEG * gait;
    const heel = Math.max(0, Math.cos(2 * phase));
    const bobPitch = -heel * heel * 0.12 * DEG * gait;

    const recoilYaw = clamp(rYaw.x, -10, 10) * DEG;
    const recoilPitch = clamp(rPitch.x, -8, 8) * DEG;
    const recoilRoll = clamp(rRoll.x, -4, 4) * DEG;
    const lift = clamp(jolt.x + dip.x + sag.x, -0.07, 0.08);

    viewYaw = yaw + eyeYaw + glanceYaw + recoilYaw + swayYaw + tremYaw;
    viewPitch = clamp(pitch + eyePitch + glancePitch + recoilPitch + swayPitch + tremPitch + bobPitch, T.pitchMin - 4 * DEG, T.pitchMax + 4 * DEG);
    const roll = strafeLean + recoilRoll + bobRoll + swayRoll + tremRoll;

    // The eyes sit in front of the neck pivot: looking down carries them forward and a little lower.
    const down = Math.max(0, Math.sin(-viewPitch));
    const headForward = 0.1 * down;
    const headDrop = 0.03 * (1 - Math.cos(viewPitch));
    const eyeY = eyeHeight + bobY + breathY + lift - headDrop;

    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    camera.position.set(
      position.x + cy * bobX + forwardX(viewYaw) * headForward,
      eyeY,
      position.z - sy * bobX + forwardZ(viewYaw) * headForward,
    );
    camera.rotation.set(viewPitch, viewYaw, roll, 'YXZ');

    // FOV: adopt outside changes to the base, add the startle kick on top
    if (Math.abs(camera.fov - lastFovSet) > 1e-4) baseFov = camera.fov;
    const fov = baseFov + clamp(fovKick.x, -5, 5);
    if (Math.abs(fov - camera.fov) > 1e-4) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    lastFovSet = camera.fov;

    // body
    const dYaw = viewYaw - yaw;
    frame.x = position.x;
    frame.z = position.z;
    frame.yaw = yaw;
    frame.eyeX = bobX - Math.sin(dYaw) * headForward;
    frame.eyeY = eyeY;
    frame.eyeZ = -Math.cos(dYaw) * headForward;
    frame.pitch = viewPitch;
    frame.phase = phase;
    frame.gait = gait;
    frame.stepLength = stepLength(gaitSpeed);
    frame.moveRight = moveRight;
    frame.moveForward = moveForward;
    frame.bob = bobY;
    frame.keysRaise = keys;
    frame.guardRaise = guard;
    frame.phoneRaise = phone;
    frame.tremor = tremor;
    frame.time = time;
    frame.fovDeg = baseFov;
    body.update(frame);
  }

  /* ---------------------------------------------------------------- update */

  function update(dtRaw: number): void {
    if (disposed || !(dtRaw > 0)) return;
    const dt = Math.min(dtRaw, 0.05);
    time += dt;

    /* --- what the legs are allowed to do */
    inputFreeze = Math.max(0, inputFreeze - dt);
    freezeTimer = Math.max(0, freezeTimer - dt);
    let suppressed = false;
    for (const push of pushes) if (push.suppress) suppressed = true;
    if (suppressed) suppressTail = 0.12;
    else suppressTail = Math.max(0, suppressTail - dt);
    const frozen = freezeTimer > 0;
    legs = damp(legs, frozen ? 0 : 1, frozen ? 16 : 4.2, dt);
    if (!frozen && legs > 0.995) legs = 1;

    input.read(intent);
    const canMove = inputEnabled && inputFreeze <= 0 && suppressTail <= 0;

    /* --- keyboard turning (no-lock mode only) */
    const wantTurn = inputEnabled ? intent.turn * T.keyTurnRate : 0;
    turnVel = damp(turnVel, wantTurn, 12, dt);
    if (Math.abs(turnVel) > 1e-4) yaw = wrapAngle(yaw + turnVel * dt);

    /* --- webcam eye-look: glance offset plus a body turn at the edges */
    // An involuntary glance (glanceAt) takes the head away from the player: head look lets go
    // quickly while it runs, then comes back at its normal pace.
    const look = inputEnabled && input.locked && !glance ? (opts.eyes?.read() ?? null) : null;
    const lookRate = glance ? 14 : 9;
    eyeYaw = damp(eyeYaw, look ? look.yawOffset : 0, lookRate, dt);
    eyePitch = damp(eyePitch, look ? look.pitchOffset : 0, lookRate, dt);
    if (look && look.yawRate !== 0) yaw = wrapAngle(yaw + look.yawRate * dt);

    /* --- wanted velocity */
    let lf = 0; // forward, m/s
    let ls = 0; // right, m/s
    if (canMove) {
      const f = intent.forward;
      const s = intent.strafe;
      const fwdSpeed = intent.hurry ? T.hurrySpeed : T.walkSpeed;
      lf = f > 0 ? Math.min(fwdSpeed * f, T.hurrySpeed) : f < 0 ? -T.walkSpeed * T.slowFactor : 0;
      ls = s * T.walkSpeed * T.slowFactor * (intent.hurry && f > 0 ? 1.25 : 1);
      if (f !== 0 && s !== 0) {
        lf *= Math.SQRT1_2;
        ls *= Math.SQRT1_2;
      }
      const scale = legs * contactSlow;
      lf *= scale;
      ls *= scale;
    }
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const wantX = -sy * lf + cy * ls;
    const wantZ = -cy * lf - sy * ls;

    const wantSpeed = Math.hypot(wantX, wantZ);
    const curSpeed = Math.hypot(vel.x, vel.z);
    const rate = inputFreeze > 0 || suppressTail > 0 ? 22 : wantSpeed >= curSpeed ? T.accelRate : T.decelRate;
    vel.x = damp(vel.x, wantX, rate, dt);
    vel.z = damp(vel.z, wantZ, rate, dt);
    if (wantSpeed === 0 && Math.hypot(vel.x, vel.z) < 0.012) {
      vel.x = 0;
      vel.z = 0;
    }

    /* --- walk */
    const startX = position.x;
    const startZ = position.z;
    contact = null;
    contactDepth = 0;
    touchedAnything = false;
    moveAndCollide(vel.x * dt, vel.z * dt);
    const walkedX = position.x - startX;
    const walkedZ = position.z - startZ;
    const walked = Math.hypot(walkedX, walkedZ);
    if (touchedAnything) {
      // keep only the part of the velocity that actually happened (wall / body sliding)
      vel.x = walkedX / dt;
      vel.z = walkedZ / dt;
    }
    const walkContact: DynamicCollider | null = contact;
    let pressing = false;
    if (walkContact) {
      // pushing into him? (contact normal points from him to her)
      const into = -(wantX * contactNx + wantZ * contactNz);
      pressing = into > 0.3 * contactSlow;
      if (pressing && time - lastBump >= T.bumpInterval) {
        lastBump = time;
        emit('bumped', { collider: walkContact });
      }
    }
    contactSlow = damp(contactSlow, pressing ? T.contactSlow : 1, pressing ? 14 : 5, dt);
    phase += (walked / stepLength(gaitSpeed)) * Math.PI;

    /* --- reaction displacement (flinch lurch, forced steps) */
    for (let i = pushes.length - 1; i >= 0; i--) {
      const push = pushes[i];
      const e0 = pushEase(push, push.t);
      push.t = Math.min(push.duration, push.t + dt);
      const e1 = pushEase(push, push.t);
      const d = (e1 - e0) * push.distance;
      moveAndCollide(push.dx * d, push.dz * d);
      phase += (e1 - e0) * push.steps * Math.PI;
      if (push.t >= push.duration) {
        phase += 1e-4; // make sure the last foot of the step lands
        pushes.splice(i, 1);
      }
    }

    /* --- gait bookkeeping from what really moved */
    const movedX = position.x - startX;
    const movedZ = position.z - startZ;
    const moved = Math.hypot(movedX, movedZ);
    const groundSpeed = moved / dt;
    gaitSpeed = damp(gaitSpeed, groundSpeed, 9, dt);
    gait = damp(gait, clamp01(gaitSpeed / 1.05), 9, dt);
    if (moved > 1e-5) {
      const mr = (movedX * cy - movedZ * sy) / moved;
      const mf = (-movedX * sy - movedZ * cy) / moved;
      moveRight = damp(moveRight, mr, 12, dt);
      moveForward = damp(moveForward, mf, 12, dt);
      const len = Math.hypot(moveRight, moveForward);
      if (len > 1e-3) {
        moveRight /= len;
        moveForward /= len;
      } else {
        moveRight = mr;
        moveForward = mf;
      }
    }
    emitFootfalls();
    if (gait < 0.03 && pushes.length === 0 && wantSpeed === 0) {
      // standing: park mid-stance so the next walk starts with half a step
      gait = 0;
      gaitSpeed = 0;
      phase = footIndex * Math.PI + Math.PI / 2;
    }

    // lean into a strafe
    const lateral = (vel.x * cy - vel.z * sy) / T.walkSpeed;
    strafeLean = damp(strafeLean, -clamp(lateral, -1, 1) * 1.15 * DEG, 7, dt);

    /* --- reaction layers */
    rYaw.step(dt);
    rPitch.step(dt);
    rRoll.step(dt);
    dip.step(dt);
    jolt.step(dt);
    fovKick.step(dt);
    sag.step(dt);

    tension = damp(tension, tensionTarget, 1.7, dt);
    if (Math.abs(tension - tensionTarget) < 1e-4) tension = tensionTarget;
    arousal = damp(arousal, 0, 0.6, dt);
    if (arousal < 1e-3) arousal = 0;
    const level = clamp01(tension + arousal);
    breath += dt * Math.PI * 2 * (0.24 + 0.36 * level);

    if (guardHold > 0) {
      guardHold -= dt;
      guard = damp(guard, guardPeak, 26, dt);
    } else {
      guard = damp(guard, 0, 3.4, dt);
      if (guard < 0.002) guard = 0;
    }
    keys = damp(keys, smoothstep((level - 0.45) / 0.4), 3, dt);
    if (keys < 0.002) keys = 0;
    const phoneStep = dt / 0.45;
    phone = phone < phoneTarget ? Math.min(phoneTarget, phone + phoneStep) : Math.max(phoneTarget, phone - phoneStep * 1.3);

    updateGlance(dt);
    applyCamera();
  }

  function updateGlance(dt: number): void {
    let wantYaw = 0;
    let wantPitch = 0;
    if (glance) {
      const g = glance;
      g.t += dt;
      if (g.t >= g.duration) {
        glance = null;
      } else {
        // A head turn takes longer the further it goes: a look right over the
        // shoulder is about half a second each way, never a whip-pan.
        const reach = Math.abs(g.lastDelta) * g.weight; // radians the view will actually turn
        const tIn = Math.min(g.duration * 0.4, 0.2 + 0.15 * reach);
        const tOut = Math.min(g.duration * 0.4, 0.26 + 0.15 * reach);
        const env = Math.min(smoothstep(g.t / tIn), smoothstep((g.duration - g.t) / tOut));
        const dx = g.target.x - position.x;
        const dz = g.target.z - position.z;
        const flat = Math.hypot(dx, dz);
        if (flat > 0.05) {
          // Keep turning the way the head first went: no swinging through the
          // front when the thing she is checking on is directly behind her.
          let d = wrapAngle(yawOf(dx, dz) - yaw);
          d = g.lastDelta + wrapAngle(d - g.lastDelta);
          d = clamp(d, -MAX_GLANCE_TURN, MAX_GLANCE_TURN);
          g.lastDelta = d;
          // A point on the ground is somebody's feet: look at the person, not the pavement.
          const ty = g.target.y < 0.3 ? g.target.y + 1.5 : g.target.y;
          const wantP = clamp(Math.atan2(ty - eyeHeight, flat), T.pitchMin, T.pitchMax);
          wantYaw = d * env * g.weight;
          wantPitch = (wantP - pitch) * env * g.weight;
        }
      }
    }
    glanceYaw = damp(glanceYaw, wantYaw, 24, dt);
    glancePitch = damp(glancePitch, wantPitch, 24, dt);
    if (!glance) {
      if (Math.abs(glanceYaw) < 2e-4) glanceYaw = 0;
      if (Math.abs(glancePitch) < 2e-4) glancePitch = 0;
    }
  }

  /* ------------------------------------------------------------- reactions */

  /** Unit vector on the ground pointing from `from` to her; backwards if they coincide. */
  function awayFrom(from: THREE.Vector3, out: Vec2): number {
    const dx = position.x - from.x;
    const dz = position.z - from.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-3) {
      out.x = -forwardX(yaw);
      out.z = -forwardZ(yaw);
      return 0;
    }
    out.x = dx / d;
    out.z = dz / d;
    return d;
  }
  const away: Vec2 = { x: 0, z: 0 };

  function raiseGuard(peak: number, hold: number): void {
    guardPeak = Math.max(guardHold > 0 ? guardPeak : 0, clamp01(peak));
    guardHold = Math.max(guardHold, hold);
  }

  function flinch(from: THREE.Vector3, strength = 0.6): void {
    if (disposed) return;
    const s = clamp01(strength);
    const d = awayFrom(from, away);
    pushes.push({ dx: away.x, dz: away.z, distance: lerp(0.15, 0.35, s), duration: lerp(0.2, 0.12, s), t: 0, steps: 1, ease: 'out', suppress: false });

    // Where is it, relative to her body? (+right, +ahead)
    let right = 0;
    let ahead = 1;
    if (d > 1e-3) {
      const tx = -away.x;
      const tz = -away.z;
      right = tx * Math.cos(yaw) - tz * Math.sin(yaw);
      ahead = -tx * Math.sin(yaw) - tz * Math.cos(yaw);
    }
    // The head whips away from it, and the spring's rebound carries the eyes back toward it.
    // (Dead ahead there is no "away" side: she jerks back and off to one side or the other.)
    const sideways = Math.abs(right);
    const side = sideways > 0.15 ? Math.sign(right) : rng() < 0.5 ? -1 : 1;
    rYaw.kick(side * (sideways * lerp(2.5, 6.5, s) + (1 - sideways) * lerp(0.8, 2.2, s)));
    rPitch.kick(ahead >= 0 ? ahead * lerp(1.0, 3.2, s) : ahead * lerp(0.6, 2.0, s));
    rRoll.kick(right * lerp(0.8, 2.2, s));
    dip.kick(-lerp(0.012, 0.032, s));
    raiseGuard(lerp(0.55, 1, s), lerp(0.16, 0.34, s));
    // she loses her stride for an instant
    const keep = 1 - 0.6 * s;
    vel.x *= keep;
    vel.z *= keep;
    arousal = Math.min(1, arousal + 0.3 * s);
    pulse(lerp(0.15, 0.55, s));
  }

  function stepBack(from: THREE.Vector3, distance = 0.6, duration = 0.5): void {
    if (disposed) return;
    const dist = clamp(distance, 0.05, 2);
    awayFrom(from, away);
    const steps = dist > 0.42 ? 2 : 1;
    pushes.push({ dx: away.x, dz: away.z, distance: dist, duration: Math.max(0.15 * steps, duration), t: 0, steps, ease: 'steps', suppress: true });
    suppressTail = 0.12;
    arousal = Math.min(1, arousal + 0.08);
  }

  function startle(strength = 0.7): void {
    if (disposed) return;
    const s = clamp01(strength);
    jolt.kick(lerp(0.033, 0.066, s)); // 3-6 cm up once the sag below is counted
    fovKick.kick(lerp(2, 4, s));
    rPitch.kick(lerp(0.8, 2.2, s)); // chin jerks up
    rRoll.kick((rng() - 0.5) * 1.2 * s);
    sag.kick(-lerp(0.006, 0.014, s)); // the slow settle
    inputFreeze = Math.max(inputFreeze, T.startleFreeze);
    raiseGuard(lerp(0.3, 0.7, s), 0.12);
    vel.x *= 0.15;
    vel.z *= 0.15;
    arousal = Math.min(1, arousal + lerp(0.35, 0.7, s));
    pulse(lerp(0.35, 1, s));
  }

  function glanceAt(target: THREE.Vector3, duration = 1.1, weight = 0.6): void {
    if (disposed) return;
    const dx = target.x - position.x;
    const dz = target.z - position.z;
    glance = {
      target: target.clone(),
      t: 0,
      duration: Math.max(0.2, duration),
      weight: clamp(weight, 0, T.maxGlanceWeight),
      lastDelta: Math.hypot(dx, dz) > 0.05 ? wrapAngle(yawOf(dx, dz) - yaw) : 0,
    };
  }

  /* ------------------------------------------------------------------- api */

  const _dir = new THREE.Vector3();
  const _to = new THREE.Vector3();

  const player: PlayerController = {
    position,
    radius: T.radius,
    body: kind,

    get speed() {
      return Math.hypot(vel.x, vel.z);
    },
    get yaw() {
      return yaw;
    },
    get pitch() {
      return pitch;
    },
    get viewPitch() {
      return viewPitch;
    },

    get inputEnabled() {
      return inputEnabled;
    },
    set inputEnabled(v: boolean) {
      inputEnabled = !!v;
    },

    get isLocked() {
      return input.locked;
    },
    requestLock() {
      input.requestLock();
    },
    releaseLock() {
      input.releaseLock();
    },

    setPose(pos, newYaw) {
      position.set(pos.x, 0, pos.z);
      yaw = wrapAngle(newYaw);
      pitch = 0;
      turnVel = 0;
      vel.x = 0;
      vel.z = 0;
      pushes.length = 0;
      suppressTail = 0;
      glance = null;
      glanceYaw = 0;
      glancePitch = 0;
      eyeYaw = 0;
      eyePitch = 0;
      gait = 0;
      gaitSpeed = 0;
      strafeLean = 0;
      contactSlow = 1;
      footIndex = 0;
      phase = Math.PI / 2;
      moveRight = 0;
      moveForward = 1;
      applyCamera();
    },

    setLook(newYaw, newPitch) {
      yaw = wrapAngle(newYaw);
      pitch = clamp(newPitch, T.pitchMin, T.pitchMax);
      applyCamera();
    },

    getForward(out = new THREE.Vector3()) {
      return out.set(forwardX(yaw), 0, forwardZ(yaw));
    },

    getEyePosition(out = new THREE.Vector3()) {
      return out.copy(camera.position);
    },

    isLookingAt(point, halfAngleDeg = 25) {
      // view direction including glance and recoil
      const cp = Math.cos(viewPitch);
      _dir.set(forwardX(viewYaw) * cp, Math.sin(viewPitch), forwardZ(viewYaw) * cp);
      _to.subVectors(point, camera.position);
      if (point.y < 0.3) {
        // A ground-level point is a person's feet: count a look anywhere on the
        // figure standing there (feet to head), not only at the pavement.
        const flat = Math.hypot(_to.x, _to.z);
        const rayY = camera.position.y + Math.tan(viewPitch) * flat;
        _to.y = clamp(rayY, point.y, point.y + 1.8) - camera.position.y;
      }
      const len = _to.length();
      if (len < 1e-4) return true;
      return _dir.dot(_to) / len >= Math.cos(clamp(halfAngleDeg, 0, 180) * DEG);
    },

    addCollider(c) {
      if (!colliders.includes(c)) colliders.push(c);
      return () => {
        const i = colliders.indexOf(c);
        if (i >= 0) colliders.splice(i, 1);
      };
    },

    on(event, cb) {
      listeners[event].add(cb);
      return () => {
        listeners[event].delete(cb);
      };
    },

    flinch,
    stepBack,
    startle,
    glanceAt,

    setTension(level) {
      tensionTarget = clamp01(Number.isFinite(level) ? level : 0);
    },

    setBodyVisible(visible) {
      body.setVisible(visible);
      if (visible) applyCamera();
    },

    setPhoneRaised(raised) {
      phoneTarget = raised && kind === 'bystander' ? 1 : 0;
    },

    freeze(duration) {
      if (disposed || !(duration > 0)) return;
      freezeTimer = Math.max(freezeTimer, duration);
    },

    getReactionState() {
      const displacing = pushes.length > 0;
      const state: ReactionState = {
        yaw: rYaw.x,
        pitch: rPitch.x,
        roll: rRoll.x,
        lift: jolt.x + dip.x + sag.x,
        fov: fovKick.x,
        glanceYaw: glanceYaw / DEG,
        glancePitch: glancePitch / DEG,
        guard,
        keys,
        phone,
        legs: inputFreeze > 0 || suppressTail > 0 ? 0 : legs,
        arousal,
        tension,
        displacing,
        atRest: false,
      };
      state.atRest =
        !displacing &&
        Math.abs(state.yaw) < 0.05 &&
        Math.abs(state.pitch) < 0.05 &&
        Math.abs(state.roll) < 0.05 &&
        Math.abs(state.lift) < 0.001 &&
        Math.abs(state.fov) < 0.02 &&
        Math.abs(state.glanceYaw) < 0.05 &&
        Math.abs(state.glancePitch) < 0.05 &&
        state.guard < 0.01 &&
        state.legs > 0.99 &&
        glance === null;
      return state;
    },

    update,

    dispose() {
      if (disposed) return;
      disposed = true;
      input.dispose();
      body.dispose();
      colliders.length = 0;
      pushes.length = 0;
      for (const set of Object.values(listeners)) set.clear();
      // leave the camera level and at its own FOV
      camera.rotation.z = 0;
      if (Math.abs(camera.fov - baseFov) > 1e-4) {
        camera.fov = baseFov;
        camera.updateProjectionMatrix();
      }
    },
  };

  applyCamera();
  return player;
}
