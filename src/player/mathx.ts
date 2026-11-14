/**
 * Small numeric helpers shared by the player controller and the NPC controller.
 * Everything here is allocation-free and frame-rate independent.
 */

export const DEG = Math.PI / 180;
export const TAU = Math.PI * 2;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Exponential approach to `target`: the same curve at any frame rate. `rate` is 1 / time-constant. */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return target + (current - target) * Math.exp(-rate * dt);
}

export const smoothstep = (t: number): number => {
  t = clamp01(t);
  return t * t * (3 - 2 * t);
};
export const easeOutCubic = (t: number): number => {
  t = 1 - clamp01(t);
  return 1 - t * t * t;
};

/**
 * Yaw convention used everywhere in this project: yaw 0 faces -Z, positive
 * yaw turns left (counter-clockwise seen from above), exactly like
 * `Object3D.rotation.y` on something modelled facing -Z.
 */
export const yawOf = (dx: number, dz: number): number => Math.atan2(-dx, -dz);
export const forwardX = (yaw: number): number => -Math.sin(yaw);
export const forwardZ = (yaw: number): number => -Math.cos(yaw);

/**
 * Damped spring resting at 0, integrated in closed form (stable and identical
 * at any dt). Reactions add velocity impulses with `kick()`; the spring always
 * brings the value back to rest, so any number of reactions compose.
 */
export class Spring {
  x = 0;
  v = 0;
  private readonly wd: number;
  private readonly zw: number;
  /** Velocity needed for the impulse response to peak at exactly 1. */
  private readonly unitKick: number;

  /**
   * @param omega natural frequency, rad/s (higher = snappier)
   * @param zeta  damping ratio, 0 < zeta < 1 (lower = more overshoot past rest)
   */
  constructor(
    readonly omega: number,
    readonly zeta: number,
  ) {
    const z = clamp(zeta, 0.05, 0.995);
    this.zw = z * omega;
    this.wd = omega * Math.sqrt(1 - z * z);
    const tPeak = Math.atan2(this.wd, this.zw) / this.wd;
    this.unitKick = this.wd / (Math.exp(-this.zw * tPeak) * Math.sin(this.wd * tPeak));
  }

  /** Add an impulse sized so that, from rest, the value peaks at `peak`. */
  kick(peak: number): void {
    this.v += peak * this.unitKick;
  }

  step(dt: number): number {
    const { x, v, wd, zw } = this;
    if (x === 0 && v === 0) return 0;
    const e = Math.exp(-zw * dt);
    const c = Math.cos(wd * dt);
    const s = Math.sin(wd * dt);
    const b = (v + zw * x) / wd;
    // x(t) = e^(-zw t) (x0 cos wd t + b sin wd t), and its exact derivative
    this.x = e * (x * c + b * s);
    this.v = e * ((b * wd - zw * x) * c - (x * wd + zw * b) * s);
    if (Math.abs(this.x) < 1e-7 && Math.abs(this.v) < 1e-6) {
      this.x = 0;
      this.v = 0;
    }
    return this.x;
  }

  reset(): void {
    this.x = 0;
    this.v = 0;
  }
}

/** Deterministic pseudo-random source (mulberry32) so reactions replay identically in the harness. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
