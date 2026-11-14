/**
 * NPC movement controller: a kinematic agent on the ground plane that carries
 * a Human around.
 *
 * Each frame the current behaviour produces a wanted velocity and, optionally,
 * a wanted facing. The agent then:
 *   1. steers around other bodies in its way,
 *   2. turns toward its facing at a limited rate (it slows down to turn rather
 *      than sliding sideways, unless the behaviour is a deliberate side-step),
 *   3. accelerates toward the wanted velocity at a limited rate,
 *   4. moves, and is pushed out of static obstacles and other bodies.
 * Because the velocity and heading are the only state carried between frames,
 * switching behaviour mid-stride blends by construction.
 *
 * Conventions: yaw 0 faces -Z, positive yaw turns left (same as the player).
 * The controller does NOT call human.update(); the scene director does.
 */

import * as THREE from 'three';
import type { DynamicCollider, Human, Npc, NpcBehaviour, Rect } from '../contracts';
import { pushOutOfCircle, type Vec2 } from '../player/collision';
import { DEG, clamp, clamp01, damp, forwardX, forwardZ, lerp, smoothstep, wrapAngle, yawOf } from '../player/mathx';
import { Navigator, PathFollower, type SteerResult } from './steering';

/**
 * Added to the agent's yaw when orienting human.root. src/characters/human.ts
 * builds its model facing local +Z (see its FACING CONVENTION note), and the
 * agent's yaw 0 faces -Z, so the offset is PI. It would be 0 for a model built
 * facing -Z. This is the one place to flip it.
 */
export const NPC_MODEL_YAW_OFFSET: number = Math.PI;

/** The optional heel-strike hook a Human may expose (createHuman() does, as `onFootfall`). */
type FootfallHook = (foot: 'left' | 'right', position: THREE.Vector3, speed: number) => void;
type HumanWithFootfalls = Human & { onFootfall?: FootfallHook | null };

export const NPC_TUNING = {
  radius: 0.32,
  walkSpeed: 1.4,
  briskSpeed: 2.0,
  backAwaySpeed: 0.95,
  turnRate: 240 * DEG, // rad/s
  turnAccel: 30, // rad/s^2
  accel: 4.5, // m/s^2
  /** Footfall spacing at walking speed (used when the Human exposes no footfall hook). */
  stride: 0.74,
  /** block: how late he notices where she has moved to. */
  blockLag: 0.4,
  /** block: share of that lag he makes up by assuming she keeps doing what she was doing. */
  blockAnticipation: 0.6,
  /** block: side-step speed cap once he is in front of her. */
  blockShuffleSpeed: 1.7,
  /** block: speed while getting round to the front. */
  blockRunSpeed: 2.5,
  /** walkAlongside: how far ahead of her shoulder he walks. */
  alongsideAhead: 0.4,
  /** walkAlongside: how far his body is turned in toward her. */
  alongsideTurn: 30 * DEG,
} as const;

export interface NpcOptions {
  radius?: number;
  /** Override NPC_MODEL_YAW_OFFSET for this agent. */
  modelYawOffset?: number;
}

/** Read-only view of the steering state, for the dev harness. */
export interface NpcDebug {
  yaw: number;
  vx: number;
  vz: number;
  /** The point the agent is currently trying to reach, if any. */
  goal: Vec2 | null;
  waypoints: readonly Vec2[];
}

export interface NpcController extends Npc {
  /** Heading in radians (0 faces -Z). */
  readonly yaw: number;
  debug(): NpcDebug;
}

const T = NPC_TUNING;

interface BehaviourState {
  done: boolean;
  pathIndex: number;
  travelled: number;
  /** Seconds he has wanted to move but could not (wedged against something). */
  blockedTime: number;
  // target tracking
  tracked: boolean;
  tx: number;
  tz: number;
  tvx: number;
  tvz: number;
  // walkAlongside
  dirInit: boolean;
  dirYaw: number;
  moving: boolean;
  stillFor: number;
  slot: number;
  slotTimer: number;
  // block
  hist: Array<{ t: number; x: number; z: number }>;
}

const freshState = (): BehaviourState => ({
  done: false,
  pathIndex: 0,
  travelled: 0,
  blockedTime: 0,
  tracked: false,
  tx: 0,
  tz: 0,
  tvx: 0,
  tvz: 0,
  dirInit: false,
  dirYaw: 0,
  moving: false,
  stillFor: 0,
  slot: 0,
  slotTimer: 0,
  hist: [],
});

export function createNpc(human: Human, scene: THREE.Scene, opts: NpcOptions = {}): NpcController {
  const bodyRadius = opts.radius ?? T.radius;
  const yawOffset = opts.modelYawOffset ?? NPC_MODEL_YAW_OFFSET;

  const position = new THREE.Vector3();
  const vel: Vec2 = { x: 0, z: 0 };
  let yaw = 0;
  let angVel = 0;
  let speed = 0;
  let time = 0;
  let gone = false; // walked off with 'leave': no body until posed or given something to do
  let disposed = false;
  let strideAccum = 0;

  let behaviour: NpcBehaviour = { type: 'idle' };
  let st = freshState();
  let arrival: Promise<void> = Promise.resolve();
  let resolveArrival: (() => void) | null = null;

  const avoid: DynamicCollider[] = [];
  const stepCallbacks: Array<(position: THREE.Vector3, speed: number) => void> = [];
  const nav = new Navigator(bodyRadius);
  const follower = new PathFollower(nav);
  const steerOut: SteerResult = { x: 0, z: 0, remaining: 0, direct: true };
  const goal: Vec2 = { x: 0, z: 0 };
  let hasGoal = false;

  /** What the behaviour wants this frame. */
  const cmd = {
    vx: 0,
    vz: 0,
    /** Explicit facing (yaw), or null to face the direction of travel. */
    face: null as number | null,
    /** Turn-then-walk (true) or free to side-step / back-pedal (false). */
    travel: true,
    accel: T.accel as number,
    /** Do not steer around the body standing at this point (the person he is approaching). */
    excludeX: NaN,
    excludeZ: NaN,
  };

  scene.add(human.root);

  // Footfalls: if the Human reports its own heel strikes, steps are timed by the
  // walk animation (and placed at the foot); otherwise by distance covered.
  const walker = human as HumanWithFootfalls;
  const animatedFootfalls = 'onFootfall' in walker;
  const onFootfall: FootfallHook = (_foot, footPosition, footSpeed) => {
    if (gone || disposed) return;
    for (const cb of stepCallbacks) cb(footPosition, footSpeed);
  };
  if (animatedFootfalls) walker.onFootfall = onFootfall;

  function syncHuman(): void {
    human.root.position.set(position.x, 0, position.z);
    human.root.rotation.y = yaw + yawOffset;
  }

  function finish(): void {
    const r = resolveArrival;
    resolveArrival = null;
    if (r) r();
  }

  /* -------------------------------------------------------------- helpers */

  const distTo = (x: number, z: number) => Math.hypot(x - position.x, z - position.z);

  function yawToward(pt: { x: number; z: number }): number | null {
    const dx = pt.x - position.x;
    const dz = pt.z - position.z;
    if (dx * dx + dz * dz < 0.0025) return null;
    return yawOf(dx, dz);
  }

  /** Closest he may stand to a target at T: touching distance plus a hair. */
  function minGap(tx: number, tz: number): number {
    let other = 0.34;
    for (const c of avoid) {
      const cp = c.getPosition();
      if (Math.hypot(cp.x - tx, cp.z - tz) < 0.4 && c.radius > 0) other = c.radius;
    }
    return bodyRadius + other + 0.03;
  }

  function trackTarget(tx: number, tz: number, dt: number): void {
    if (!st.tracked) {
      st.tracked = true;
      st.tx = tx;
      st.tz = tz;
      st.tvx = 0;
      st.tvz = 0;
      return;
    }
    const ivx = (tx - st.tx) / dt;
    const ivz = (tz - st.tz) / dt;
    st.tx = tx;
    st.tz = tz;
    if (Math.hypot(ivx, ivz) > 9) return; // teleported: not a velocity
    st.tvx = damp(st.tvx, ivx, 7, dt);
    st.tvz = damp(st.tvz, ivz, 7, dt);
  }

  /** Wedged for `limit` seconds: give up rather than grind against the obstacle (and keep a caller waiting forever). */
  const stuck = (limit: number): boolean => st.blockedTime > limit;

  /** Route to (gx, gz); writes the unit direction to walk in to `dir` and returns the path length left. */
  const dir: Vec2 = { x: 0, z: 0 };
  function route(gx: number, gz: number, dt: number): number {
    goal.x = gx;
    goal.z = gz;
    hasGoal = true;
    follower.steer(position, goal, dt, steerOut);
    const dx = steerOut.x - position.x;
    const dz = steerOut.z - position.z;
    const d = Math.hypot(dx, dz);
    if (d > 1e-4) {
      dir.x = dx / d;
      dir.z = dz / d;
    } else {
      dir.x = 0;
      dir.z = 0;
    }
    return steerOut.remaining;
  }

  /** Speed that lets him stop `left` metres from here at a comfortable deceleration. */
  const arriveSpeed = (left: number, max: number, decel: number) => Math.min(max, Math.sqrt(2 * decel * Math.max(0, left)));

  function go(speedNow: number): void {
    cmd.vx = dir.x * speedNow;
    cmd.vz = dir.z * speedNow;
  }

  /* ------------------------------------------------------------ behaviours */

  const slotPoint: Vec2 = { x: 0, z: 0 };
  const s0: Vec2 = { x: 0, z: 0 };
  const s1: Vec2 = { x: 0, z: 0 };

  function sampleHistory(t: number, out: Vec2): void {
    const h = st.hist;
    if (h.length === 0) return;
    if (t <= h[0].t) {
      out.x = h[0].x;
      out.z = h[0].z;
      return;
    }
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].t <= t) {
        const a = h[i];
        const b = h[Math.min(h.length - 1, i + 1)];
        const span = b.t - a.t;
        const u = span > 1e-6 ? (t - a.t) / span : 0;
        out.x = lerp(a.x, b.x, u);
        out.z = lerp(a.z, b.z, u);
        return;
      }
    }
  }

  function think(dt: number): void {
    cmd.vx = 0;
    cmd.vz = 0;
    cmd.face = null;
    cmd.travel = true;
    cmd.accel = T.accel;
    cmd.excludeX = NaN;
    cmd.excludeZ = NaN;
    hasGoal = false;

    const b = behaviour;
    switch (b.type) {
      case 'idle': {
        if (b.face) cmd.face = yawToward(b.face());
        break;
      }

      case 'goTo': {
        if (st.done) {
          if (b.faceOnArrive) cmd.face = yawToward(b.faceOnArrive());
          break;
        }
        const left = route(b.target.x, b.target.z, dt);
        if (left < 0.07 || stuck(2.5)) {
          st.done = true;
          finish();
          break;
        }
        go(arriveSpeed(left, b.speed ?? T.walkSpeed, 2.2));
        break;
      }

      case 'path': {
        const pts = b.points;
        if (st.done || pts.length === 0) break;
        const i = Math.min(st.pathIndex, pts.length - 1);
        const max = b.speed ?? T.walkSpeed;
        const last = i === pts.length - 1 && !b.loop;
        const left = route(pts[i].x, pts[i].z, dt);
        if (last) {
          if (left < 0.07 || stuck(2.5)) {
            st.done = true;
            finish();
            break;
          }
          go(arriveSpeed(left, max, 2.2));
        } else {
          if (left < 0.45 || stuck(3)) {
            st.pathIndex = (i + 1) % pts.length;
            st.blockedTime = 0;
            follower.reset();
          }
          go(max); // walks through intermediate points without breaking stride
        }
        break;
      }

      case 'leave': {
        if (st.done) break;
        const left = route(b.to.x, b.to.z, dt);
        if (left < 0.25 || stuck(3)) {
          st.done = true;
          gone = true;
          vel.x = 0;
          vel.z = 0;
          speed = 0;
          human.setLocomotion(0);
          human.setVisible(false);
          finish();
          break;
        }
        go(b.speed ?? T.walkSpeed);
        break;
      }

      case 'followBehind': {
        const tp = b.target();
        const d = distTo(tp.x, tp.z);
        const gap = Math.max(b.gap, minGap(tp.x, tp.z));
        cmd.excludeX = tp.x;
        cmd.excludeZ = tp.z;
        if (d > gap + 0.06) {
          const left = route(tp.x, tp.z, dt);
          // Speed depends only on the distance still to close, so he cannot be
          // caught out by her stopping dead: he is always able to stop short of `gap`.
          go(arriveSpeed((steerOut.direct ? d : Math.max(d, left)) - gap - 0.05, b.speed ?? T.briskSpeed, 1.5));
        }
        if (Math.hypot(cmd.vx, cmd.vz) < 0.3) cmd.face = yawToward(tp);
        break;
      }

      case 'closeIn': {
        const tp = b.target();
        const d = distTo(tp.x, tp.z);
        const gap = Math.max(b.gap, minGap(tp.x, tp.z));
        cmd.excludeX = tp.x;
        cmd.excludeZ = tp.z;
        if (!st.done) {
          if (d <= gap + 0.05 || stuck(2)) {
            st.done = true;
            finish();
          } else {
            const left = route(tp.x, tp.z, dt);
            go(arriveSpeed((steerOut.direct ? d : Math.max(d, left)) - gap, b.speed ?? T.walkSpeed, 2));
          }
        }
        // then hold: stand his ground, eyes on her
        if (st.done || d < 3) cmd.face = yawToward(tp);
        break;
      }

      case 'backAway': {
        const fp = b.from();
        let ax = position.x - fp.x;
        let az = position.z - fp.z;
        const d = Math.hypot(ax, az);
        if (d < 1e-3) {
          ax = -forwardX(yaw);
          az = -forwardZ(yaw);
        } else {
          ax /= d;
          az /= d;
        }
        const left = b.distance - st.travelled;
        if (left <= 0.02 || stuck(0.7)) {
          const face = b.from;
          behaviour = { type: 'idle', face };
          st = freshState();
          cmd.face = yawToward(fp);
          finish();
          break;
        }
        const s = Math.min(b.speed ?? T.backAwaySpeed, Math.sqrt(2 * 2.5 * left) + 0.05);
        cmd.vx = ax * s;
        cmd.vz = az * s;
        cmd.face = yawToward(fp); // keeps his eyes on her while he gives ground
        cmd.travel = false;
        break;
      }

      case 'walkAlongside': {
        const tp = b.target();
        trackTarget(tp.x, tp.z, dt);
        const ts = Math.hypot(st.tvx, st.tvz);
        if (!st.dirInit) {
          const f = b.targetForward();
          st.dirYaw = Math.hypot(f.x, f.z) > 1e-4 ? yawOf(f.x, f.z) : yaw;
          st.dirInit = true;
        }
        // The frame is her direction of TRAVEL, not where she is looking: when
        // she turns her head to him the slot must not swing round her.
        if (ts > 0.3) st.dirYaw = wrapAngle(st.dirYaw + wrapAngle(yawOf(st.tvx, st.tvz) - st.dirYaw) * (1 - Math.exp(-5 * dt)));
        if (ts > 0.4) {
          st.moving = true;
          st.stillFor = 0;
        } else if (ts < 0.2) {
          st.stillFor += dt;
          if (st.stillFor > 0.2) st.moving = false;
        }
        const dxF = forwardX(st.dirYaw);
        const dzF = forwardZ(st.dirYaw);
        const rx = -dzF; // right of her direction of travel
        const rz = dxF;
        const sgn = b.side === 'right' ? 1 : -1;
        const least = minGap(tp.x, tp.z) + 0.03;
        const gap = Math.max(b.gap, least);

        // Where to walk: beside her and a little ahead. If street furniture is in
        // that spot he tucks in closer, and failing that drops in behind her.
        const BEHIND = 4;
        const slotAt = (i: number): void => {
          let lat = gap;
          let ahead: number = T.alongsideAhead;
          if (i === 1) lat = Math.max(least, gap - 0.12);
          else if (i === 2) lat = Math.max(least, gap - 0.26);
          else if (i === 3) {
            lat = least;
            ahead += 0.15;
          } else if (i >= BEHIND) {
            lat = 0.25;
            ahead = -Math.max(gap, 0.95);
          }
          slotPoint.x = tp.x + rx * sgn * lat + dxF * ahead;
          slotPoint.z = tp.z + rz * sgn * lat + dzF * ahead;
        };
        let best = BEHIND;
        for (let i = 0; i < BEHIND; i++) {
          slotAt(i);
          if (nav.isFree(slotPoint.x, slotPoint.z)) {
            best = i;
            break;
          }
        }
        if (best !== st.slot) {
          slotAt(st.slot);
          const currentOk = st.slot >= BEHIND || nav.isFree(slotPoint.x, slotPoint.z);
          st.slotTimer += dt;
          if (!currentOk || st.slotTimer > 0.3) {
            st.slot = best;
            st.slotTimer = 0;
          }
        } else {
          st.slotTimer = 0;
        }
        slotAt(st.slot);
        if (st.slot >= BEHIND) nav.projectFree(slotPoint);

        const ex = slotPoint.x - position.x;
        const ez = slotPoint.z - position.z;
        const e = Math.hypot(ex, ez);
        cmd.excludeX = tp.x;
        cmd.excludeZ = tp.z;
        goal.x = slotPoint.x;
        goal.z = slotPoint.z;
        hasGoal = true;

        if (st.moving || e > 1.1) {
          const ff = st.moving ? 1 : 0;
          const cap = clamp(ts + 1.2, T.walkSpeed, 2.9);
          let vx = st.tvx * ff + ex * 2.6;
          let vz = st.tvz * ff + ez * 2.6;
          if (e > 0.6 && !nav.lineClearFrom(position.x, position.z, slotPoint.x, slotPoint.z)) {
            const left = route(slotPoint.x, slotPoint.z, dt);
            const s = Math.min(cap, ts * ff + 2.6 * left);
            vx = dir.x * s;
            vz = dir.z * s;
          }
          const v = Math.hypot(vx, vz);
          if (v > cap) {
            vx *= cap / v;
            vz *= cap / v;
          }
          cmd.vx = vx;
          cmd.vz = vz;
          cmd.accel = 5.5;
          if (e < 1.6) {
            // in step with her: walking her way, shoulders turned in toward her
            cmd.face = wrapAngle(st.dirYaw + sgn * T.alongsideTurn);
            cmd.travel = false;
          }
        } else {
          // she has stopped: so does he, and he turns to her
          cmd.face = yawToward(tp);
          cmd.travel = false;
        }
        break;
      }

      case 'block': {
        const tp = b.target();
        const f = b.targetForward();
        let fx = f.x;
        let fz = f.z;
        const fl = Math.hypot(fx, fz);
        if (fl < 1e-4) {
          // no usable forward: stand between her and where he already is
          fx = position.x - tp.x;
          fz = position.z - tp.z;
          const l = Math.hypot(fx, fz) || 1;
          fx /= l;
          fz /= l;
        } else {
          fx /= fl;
          fz /= fl;
        }
        const gap = Math.max(b.gap, minGap(tp.x, tp.z));

        // The spot in her path, as he perceives it: late, and extrapolated from what she was doing.
        const hist = st.hist;
        hist.push({ t: time, x: tp.x + fx * gap, z: tp.z + fz * gap });
        while (hist.length > 2 && hist[1].t < time - T.blockLag - 0.3) hist.shift();
        sampleHistory(time - T.blockLag, s1);
        sampleHistory(time - T.blockLag - 0.15, s0);
        let pvx = (s1.x - s0.x) / 0.15;
        let pvz = (s1.z - s0.z) / 0.15;
        const pv = Math.hypot(pvx, pvz);
        if (pv > 3) {
          pvx *= 3 / pv;
          pvz *= 3 / pv;
        }
        goal.x = s1.x + pvx * T.blockLag * T.blockAnticipation;
        goal.z = s1.z + pvz * T.blockLag * T.blockAnticipation;
        nav.projectFree(goal);
        hasGoal = true;

        const ex = goal.x - position.x;
        const ez = goal.z - position.z;
        const e = Math.hypot(ex, ez);
        const far = smoothstep((e - 0.8) / 1.0);
        const cap = lerp(T.blockShuffleSpeed, T.blockRunSpeed, far);
        let vx = pvx * 0.8 * (1 - far) + ex * 5;
        let vz = pvz * 0.8 * (1 - far) + ez * 5;
        if (e > 0.5 && !nav.lineClearFrom(position.x, position.z, goal.x, goal.z)) {
          route(goal.x, goal.z, dt);
          vx = dir.x * cap;
          vz = dir.z * cap;
        }
        const v = Math.hypot(vx, vz);
        if (v > cap) {
          vx *= cap / v;
          vz *= cap / v;
        }

        // Hold his ground: once in front of her he never backs up to keep the
        // gap. If she walks at him, she walks into him.
        const ux = position.x - tp.x;
        const uz = position.z - tp.z;
        const ud = Math.hypot(ux, uz);
        if (ud > 1e-3) {
          const nx = ux / ud;
          const nz = uz / ud;
          const inFront = nx * fx + nz * fz;
          const radial = vx * nx + vz * nz;
          if (inFront > 0.35 && radial > 0 && ud < gap + 0.5) {
            vx -= nx * radial;
            vz -= nz * radial;
          }
        }
        cmd.vx = vx;
        cmd.vz = vz;
        cmd.accel = 6.5;
        if (ud < 4) {
          cmd.face = yawToward(tp);
          cmd.travel = false;
        }
        break;
      }
    }
  }

  /** Bend the wanted velocity around other bodies that are in the way. */
  function steerAroundBodies(): void {
    const s = Math.hypot(cmd.vx, cmd.vz);
    if (s < 0.05 || avoid.length === 0) return;
    const dx = cmd.vx / s;
    const dz = cmd.vz / s;
    let steer = 0;
    for (const c of avoid) {
      const r = c.radius;
      if (!(r > 0)) continue;
      const cp = c.getPosition();
      if (Math.hypot(cp.x - cmd.excludeX, cp.z - cmd.excludeZ) < 0.4) continue;
      const rx = cp.x - position.x;
      const rz = cp.z - position.z;
      const ahead = rx * dx + rz * dz;
      if (ahead <= 0) continue;
      const need = bodyRadius + r + 0.18;
      const look = need + 0.4 + s * 0.9;
      if (ahead > look) continue;
      // which side of his line is the body on? (+ = left of travel in the x/z plane as (-dz, dx))
      const lat = -dz * rx + dx * rz;
      if (Math.abs(lat) >= need) continue;
      const side = lat > 0.02 ? -1 : lat < -0.02 ? 1 : 1;
      steer += side * (1 - Math.abs(lat) / need) * (1 - 0.6 * (ahead / look));
    }
    if (steer === 0) return;
    const k = clamp(steer, -1, 1) * 1.3;
    let nx = dx + -dz * k;
    let nz = dz + dx * k;
    const nl = Math.hypot(nx, nz) || 1;
    nx /= nl;
    nz /= nl;
    cmd.vx = nx * s;
    cmd.vz = nz * s;
  }

  /* ---------------------------------------------------------------- update */

  const p: Vec2 = { x: 0, z: 0 };

  function update(dtRaw: number): void {
    if (disposed || !(dtRaw > 0)) return;
    const dt = Math.min(dtRaw, 0.05);
    time += dt;

    if (gone) {
      speed = 0;
      return;
    }

    think(dt);
    if (gone) return; // 'leave' just completed
    steerAroundBodies();

    /* heading: turn first, then walk */
    const wantSpeed = Math.hypot(cmd.vx, cmd.vz);
    const travelYaw = wantSpeed > 0.08 ? yawOf(cmd.vx, cmd.vz) : null;
    const wantYaw = cmd.face ?? travelYaw;
    if (cmd.travel && travelYaw !== null) {
      // facing the wrong way: slow right down until he has turned (no sliding sideways)
      const err = Math.abs(wrapAngle(travelYaw - yaw));
      const aligned = clamp01((Math.cos(err) + 0.25) / 0.95);
      cmd.vx *= aligned;
      cmd.vz *= aligned;
    }
    if (wantYaw !== null) {
      const err = wrapAngle(wantYaw - yaw);
      const wantRate = clamp(err * 6, -T.turnRate, T.turnRate);
      const maxStep = T.turnAccel * dt;
      angVel += clamp(wantRate - angVel, -maxStep, maxStep);
    } else {
      angVel = damp(angVel, 0, 12, dt);
    }
    yaw = wrapAngle(yaw + angVel * dt);

    /* velocity: acceleration-limited */
    const ax = cmd.vx - vel.x;
    const az = cmd.vz - vel.z;
    const dv = Math.hypot(ax, az);
    const maxDv = cmd.accel * dt;
    if (dv <= maxDv) {
      vel.x = cmd.vx;
      vel.z = cmd.vz;
    } else {
      vel.x += (ax / dv) * maxDv;
      vel.z += (az / dv) * maxDv;
    }

    /* move and collide */
    const v0 = Math.hypot(vel.x, vel.z);
    let moved = 0;
    if (v0 > 1e-4) {
      const ox = position.x;
      const oz = position.z;
      p.x = ox + vel.x * dt;
      p.z = oz + vel.z * dt;
      let hit = false;
      for (let iter = 0; iter < 4; iter++) {
        let any = false;
        for (const c of avoid) {
          const r = c.radius;
          if (!(r > 0)) continue;
          const cp = c.getPosition();
          // He never walks into another body, and other bodies are never moved
          // from here. But if SHE has pressed in closer than his comfort radius,
          // he does not get shoved back by it either: he just may not come closer.
          const keep = Math.min(bodyRadius + r, Math.hypot(ox - cp.x, oz - cp.z));
          if (pushOutOfCircle(p, keep, cp.x, cp.z, 0, undefined, -vel.x, -vel.z) > 1e-6) any = true;
        }
        if (nav.pushOut(p)) any = true; // walls last: they always win
        if (!any) break;
        hit = true;
      }
      position.x = p.x;
      position.z = p.z;
      const mx = p.x - ox;
      const mz = p.z - oz;
      moved = Math.hypot(mx, mz);
      if (hit) {
        // keep only the motion that happened (sliding), never more than he was doing
        let nvx = mx / dt;
        let nvz = mz / dt;
        const nv = Math.hypot(nvx, nvz);
        if (nv > v0) {
          nvx *= v0 / nv;
          nvz *= v0 / nv;
        }
        vel.x = nvx;
        vel.z = nvz;
      }
    } else {
      vel.x = 0;
      vel.z = 0;
    }

    if (behaviour.type === 'backAway') st.travelled += moved;
    if (wantSpeed > 0.25 && moved / dt < 0.12) st.blockedTime += dt;
    else st.blockedTime = 0;

    speed = damp(speed, moved / dt, 16, dt);
    if (speed < 0.01) speed = 0;

    /* footfalls (distance-based fallback) */
    if (animatedFootfalls) {
      // the Human's walk cycle calls onFootfall itself
    } else if (moved > 0) {
      strideAccum += moved;
      const stepLen = T.stride * clamp(0.75 + (0.25 * speed) / T.walkSpeed, 0.6, 1.25);
      if (strideAccum >= stepLen) {
        strideAccum -= stepLen;
        if (strideAccum > stepLen) strideAccum = 0;
        for (const cb of stepCallbacks) cb(position.clone(), speed);
      }
    } else if (speed === 0) {
      strideAccum = Math.min(strideAccum, T.stride * 0.5); // next walk starts with half a step
    }

    syncHuman();
    human.setLocomotion(speed);
  }

  /* ------------------------------------------------------------------- api */

  const npc: NpcController = {
    human,
    position,

    get radius() {
      // No body while he is gone or hidden, so nobody bumps into thin air.
      return gone || !human.root.visible ? 0 : bodyRadius;
    },
    set radius(_v: number) {
      /* fixed at creation (NpcOptions.radius) */
    },

    get behaviour() {
      return behaviour.type;
    },
    get speed() {
      return speed;
    },
    get yaw() {
      return yaw;
    },

    getPosition() {
      return position;
    },

    setPose(pos, newYaw) {
      position.set(pos.x, 0, pos.z);
      yaw = wrapAngle(newYaw);
      angVel = 0;
      vel.x = 0;
      vel.z = 0;
      speed = 0;
      strideAccum = T.stride * 0.5;
      gone = false;
      follower.reset();
      // tracked target velocity / block history would see a jump: start them again
      st.tracked = false;
      st.hist.length = 0;
      st.blockedTime = 0;
      syncHuman();
      human.setLocomotion(0);
    },

    setBehaviour(next) {
      finish(); // whoever was waiting on the previous one is released
      behaviour = next;
      st = freshState();
      follower.reset();
      gone = false;
      arrival =
        next.type === 'idle'
          ? Promise.resolve()
          : new Promise<void>((res) => {
              resolveArrival = res;
            });
    },

    arrived() {
      return arrival;
    },

    distanceTo(point) {
      return Math.hypot(point.x - position.x, point.z - position.z);
    },

    setObstacles(colliders: Rect[], bounds: Rect) {
      nav.setWorld(colliders, bounds);
      follower.reset();
    },

    addAvoid(c) {
      if (c !== npc && !avoid.includes(c)) avoid.push(c);
    },

    onStep(cb) {
      stepCallbacks.push(cb);
    },

    update,

    debug() {
      return { yaw, vx: vel.x, vz: vel.z, goal: hasGoal ? { x: goal.x, z: goal.z } : null, waypoints: follower.waypoints };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      finish();
      if (animatedFootfalls && walker.onFootfall === onFootfall) walker.onFootfall = null;
      scene.remove(human.root);
      avoid.length = 0;
      stepCallbacks.length = 0;
    },
  };

  syncHuman();
  return npc;
}
