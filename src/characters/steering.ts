/**
 * Getting an NPC around the street furniture.
 *
 * There is no navmesh: the world is a handful of axis-aligned Rects (building
 * fronts, parked cars, scaffolding posts, hydrants). An agent walks straight
 * at its goal whenever the line is clear; when it is not, a small visibility
 * graph over the corners of the nearby obstacles (inflated by the agent's
 * radius) is searched with A* and the agent heads for the first corner on the
 * shortest way round. Collision push-out (src/player/collision.ts) remains the
 * last line of defence, so a bad plan can never put anybody inside a wall.
 */

import type { Rect } from '../contracts';
import { clampToBounds, pushOutOfRect, type Vec2 } from '../player/collision';

const EPS = 1e-6;

/** Is (x, z) strictly inside `r` grown by `m`? */
export function pointInRect(x: number, z: number, r: Rect, m: number): boolean {
  return x > r.minX - m && x < r.maxX + m && z > r.minZ - m && z < r.maxZ + m;
}

/** Does the segment a-b pass through the open interior of `r` grown by `m`? Grazing an edge does not count. */
export function segmentHitsRect(ax: number, az: number, bx: number, bz: number, r: Rect, m: number): boolean {
  const minX = r.minX - m;
  const maxX = r.maxX + m;
  const minZ = r.minZ - m;
  const maxZ = r.maxZ + m;
  if ((ax <= minX && bx <= minX) || (ax >= maxX && bx >= maxX) || (az <= minZ && bz <= minZ) || (az >= maxZ && bz >= maxZ)) return false;
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dz = bz - az;
  if (Math.abs(dx) > EPS) {
    let ta = (minX - ax) / dx;
    let tb = (maxX - ax) / dx;
    if (ta > tb) {
      const t = ta;
      ta = tb;
      tb = t;
    }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
  }
  if (Math.abs(dz) > EPS) {
    let ta = (minZ - az) / dz;
    let tb = (maxZ - az) / dz;
    if (ta > tb) {
      const t = ta;
      ta = tb;
      tb = t;
    }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
  }
  return t1 - t0 > 1e-5;
}

export interface SteerResult {
  /** Point to walk at right now. */
  x: number;
  z: number;
  /** Path length from the agent to the goal, metres. */
  remaining: number;
  /** True when the goal itself is in a straight clear line. */
  direct: boolean;
}

/** Static-world queries for one agent radius. */
export class Navigator {
  private rects: Rect[] = [];
  private bounds: Rect | null = null;
  /** Clearance the planner keeps from obstacles, beyond the body radius. */
  private readonly testMargin: number;
  /** Corner waypoints sit a little further out again so edges along a wall stay "clear". */
  private readonly nodeMargin: number;

  constructor(readonly radius: number) {
    this.testMargin = radius + 0.06;
    this.nodeMargin = radius + 0.09;
  }

  setWorld(rects: Rect[], bounds: Rect | null): void {
    this.rects = rects;
    this.bounds = bounds;
  }

  get obstacles(): Rect[] {
    return this.rects;
  }
  get limits(): Rect | null {
    return this.bounds;
  }

  inBounds(x: number, z: number): boolean {
    const b = this.bounds;
    if (!b) return true;
    const r = this.radius - 1e-4;
    return x >= b.minX + r && x <= b.maxX - r && z >= b.minZ + r && z <= b.maxZ - r;
  }

  /** Can the agent stand here (with planning clearance)? */
  isFree(x: number, z: number): boolean {
    if (!this.inBounds(x, z)) return false;
    for (const r of this.rects) if (pointInRect(x, z, r, this.testMargin)) return false;
    return true;
  }

  /** Move a point to the nearest spot the agent could stand on. */
  projectFree(p: Vec2): void {
    for (let iter = 0; iter < 4; iter++) {
      let moved = false;
      if (this.bounds && clampToBounds(p, this.radius, this.bounds)) moved = true;
      for (const r of this.rects) {
        if (!pointInRect(p.x, p.z, r, this.testMargin)) continue;
        // out through the nearest face of the inflated rect
        const m = this.nodeMargin;
        const left = p.x - (r.minX - m);
        const right = r.maxX + m - p.x;
        const back = p.z - (r.minZ - m);
        const front = r.maxZ + m - p.z;
        const least = Math.min(left, right, back, front);
        if (least === left) p.x = r.minX - m;
        else if (least === right) p.x = r.maxX + m;
        else if (least === back) p.z = r.minZ - m;
        else p.z = r.maxZ + m;
        moved = true;
      }
      if (!moved) return;
    }
    if (this.bounds) clampToBounds(p, this.radius, this.bounds);
  }

  /** Straight walk a -> b without clipping an obstacle (planning clearance)? */
  lineClear(ax: number, az: number, bx: number, bz: number, rects: Rect[] = this.rects): boolean {
    for (const r of rects) if (segmentHitsRect(ax, az, bx, bz, r, this.testMargin)) return false;
    return true;
  }

  /**
   * Like lineClear, but forgiving about where the agent is standing: if it is
   * already inside an obstacle's clearance band (brushing a car), that obstacle
   * is tested with the bare body radius so that walking away along it counts.
   */
  lineClearFrom(ax: number, az: number, bx: number, bz: number, rects: Rect[] = this.rects): boolean {
    for (const r of rects) {
      const m = pointInRect(ax, az, r, this.testMargin) ? this.radius - 0.03 : this.testMargin;
      if (pointInRect(ax, az, r, m)) continue; // overlapping (should not happen): let push-out deal with it
      if (segmentHitsRect(ax, az, bx, bz, r, m)) return false;
    }
    return true;
  }

  /** Shortest corner-to-corner route. Returns the waypoints after `from` (ending at `to`), or null. */
  findPath(from: Vec2, to: Vec2): Vec2[] | null {
    const pad = 5;
    const minX = Math.min(from.x, to.x) - pad;
    const maxX = Math.max(from.x, to.x) + pad;
    const minZ = Math.min(from.z, to.z) - pad;
    const maxZ = Math.max(from.z, to.z) + pad;
    const m = this.testMargin;
    const near = this.rects.filter((r) => r.maxX + m > minX && r.minX - m < maxX && r.maxZ + m > minZ && r.minZ - m < maxZ);
    return this.search(from, to, near) ?? (near.length < this.rects.length ? this.search(from, to, this.rects) : null);
  }

  private search(from: Vec2, to: Vec2, rects: Rect[]): Vec2[] | null {
    const nodes: Vec2[] = [from, to];
    const nm = this.nodeMargin;
    for (const r of rects) {
      const xs = [r.minX - nm, r.maxX + nm];
      const zs = [r.minZ - nm, r.maxZ + nm];
      for (const x of xs) for (const z of zs) if (this.isFree(x, z)) nodes.push({ x, z });
    }
    const count = nodes.length;
    if (count > 600) return null; // absurdly dense: fall back to sliding
    const g = new Float64Array(count).fill(Infinity);
    const f = new Float64Array(count).fill(Infinity);
    const came = new Int32Array(count).fill(-1);
    const closed = new Uint8Array(count);
    const queued = new Uint8Array(count);
    const open: number[] = [0];
    g[0] = 0;
    f[0] = Math.hypot(to.x - from.x, to.z - from.z);
    queued[0] = 1;

    while (open.length > 0) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (f[open[i]] < f[open[bi]]) bi = i;
      const u = open[bi];
      open[bi] = open[open.length - 1];
      open.pop();
      queued[u] = 0;
      if (u === 1) break;
      closed[u] = 1;
      const a = nodes[u];
      for (let v = 1; v < count; v++) {
        if (closed[v] || v === u) continue;
        const b = nodes[v];
        const cost = g[u] + Math.hypot(b.x - a.x, b.z - a.z);
        if (cost >= g[v]) continue;
        const clear = u === 0 ? this.lineClearFrom(a.x, a.z, b.x, b.z, rects) : this.lineClear(a.x, a.z, b.x, b.z, rects);
        if (!clear) continue;
        g[v] = cost;
        came[v] = u;
        f[v] = cost + Math.hypot(to.x - b.x, to.z - b.z);
        if (!queued[v]) {
          queued[v] = 1;
          open.push(v);
        }
      }
    }
    if (came[1] < 0) return null;
    const path: Vec2[] = [];
    for (let i = 1; i > 0; i = came[i]) path.push({ x: nodes[i].x, z: nodes[i].z });
    path.reverse();
    return path;
  }

  /** Final positional safety: push a body out of every obstacle and back inside the bounds. Returns true if moved. */
  pushOut(p: Vec2): boolean {
    let moved = false;
    for (let iter = 0; iter < 4; iter++) {
      let any = false;
      for (const r of this.rects) if (pushOutOfRect(p, this.radius, r) > 1e-6) any = true;
      if (this.bounds && clampToBounds(p, this.radius, this.bounds)) any = true;
      if (!any) break;
      moved = true;
    }
    return moved;
  }
}

/**
 * Keeps a route to a (possibly moving) goal and hands out the next point to
 * walk at. It commits to a way round an obstacle instead of re-deciding every
 * frame, which is what stops an agent dithering in front of a parked car.
 */
export class PathFollower {
  private path: Vec2[] = [];
  private readonly plannedGoal: Vec2 = { x: NaN, z: NaN };
  private age = Infinity;
  private readonly goal: Vec2 = { x: 0, z: 0 };

  constructor(private readonly nav: Navigator) {}

  reset(): void {
    this.path.length = 0;
    this.age = Infinity;
    this.plannedGoal.x = NaN;
  }

  /** Waypoints still ahead (for debug drawing). */
  get waypoints(): readonly Vec2[] {
    return this.path;
  }

  steer(pos: Vec2, goalIn: Vec2, dt: number, out: SteerResult): SteerResult {
    const nav = this.nav;
    const goal = this.goal;
    goal.x = goalIn.x;
    goal.z = goalIn.z;
    nav.projectFree(goal);
    this.age += dt;

    if (nav.lineClearFrom(pos.x, pos.z, goal.x, goal.z)) {
      this.path.length = 0;
      this.age = Infinity;
      out.x = goal.x;
      out.z = goal.z;
      out.remaining = Math.hypot(goal.x - pos.x, goal.z - pos.z);
      out.direct = true;
      return out;
    }

    const path = this.path;
    const drift = Math.hypot(goal.x - this.plannedGoal.x, goal.z - this.plannedGoal.z);
    const stale =
      path.length === 0 ||
      !(drift <= 0.6) || // also true when plannedGoal is NaN
      this.age > 2.5 || // the world can change under him (a door opens)
      !nav.lineClearFrom(pos.x, pos.z, path[0].x, path[0].z);
    if (stale && this.age > 0.12) {
      const fresh = nav.findPath(pos, goal);
      this.path = fresh ?? [{ x: goal.x, z: goal.z }];
      this.plannedGoal.x = goal.x;
      this.plannedGoal.z = goal.z;
      this.age = 0;
    } else if (path.length > 0) {
      // same route, goal crept: keep the tail on it
      path[path.length - 1].x = goal.x;
      path[path.length - 1].z = goal.z;
    }

    const route = this.path;
    if (route.length === 0) route.push({ x: goal.x, z: goal.z });
    // cut corners as soon as the next leg is in view, and tick off reached waypoints
    while (route.length > 1) {
      const reached = Math.hypot(route[0].x - pos.x, route[0].z - pos.z) < 0.14;
      if (reached || nav.lineClearFrom(pos.x, pos.z, route[1].x, route[1].z)) route.shift();
      else break;
    }

    out.x = route[0].x;
    out.z = route[0].z;
    let remaining = Math.hypot(route[0].x - pos.x, route[0].z - pos.z);
    for (let i = 1; i < route.length; i++) remaining += Math.hypot(route[i].x - route[i - 1].x, route[i].z - route[i - 1].z);
    out.remaining = remaining;
    out.direct = false;
    return out;
  }
}
