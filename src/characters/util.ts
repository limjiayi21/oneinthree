/** Small numeric helpers shared by the character modules. */

export const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);
export const saturate = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Hermite step from a to b (works with a > b as a falling edge). */
export function smoothstep(a: number, b: number, x: number): number {
  const t = saturate((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** Ease in/out on 0..1. */
export function ease(t: number): number {
  t = saturate(t);
  return t * t * (3 - 2 * t);
}

/** Stronger ease (quintic). */
export function ease5(t: number): number {
  t = saturate(t);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Frame-rate independent exponential approach. lambda ~ 1 / time-constant. */
export function damp(cur: number, target: number, lambda: number, dt: number): number {
  return cur + (target - cur) * (1 - Math.exp(-lambda * dt));
}

export function gauss(x: number, sigma: number): number {
  const q = x / sigma;
  return Math.exp(-q * q);
}

export function gauss2(x: number, sx: number, y: number, sy: number): number {
  const a = x / sx;
  const b = y / sy;
  return Math.exp(-a * a - b * b);
}

export function hash1(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

/** Smooth 1-D value noise in [-1, 1]. */
export function noise1(t: number, seed = 0): number {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * (3 - 2 * f);
  const o = seed * 57.31;
  return lerp(hash1(i + o), hash1(i + 1 + o), u) * 2 - 1;
}

/** Deterministic PRNG (mulberry32). */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
}

/** 0 -> 1 -> 0 envelope: rise over `a`, hold, fall over the last `r` of `dur`. */
export function envelope(t: number, dur: number, a: number, r: number): number {
  if (t <= 0 || t >= dur) return 0;
  if (t < a) return ease(t / a);
  if (t > dur - r) return ease((dur - t) / r);
  return 1;
}

/** Piecewise-linear lookup through sorted [x, y] pairs. */
export function curve(pts: ReadonlyArray<readonly [number, number]>, x: number): number {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return pts[pts.length - 1][1];
}

/** Same as curve() but smooth through each segment. */
export function scurve(pts: ReadonlyArray<readonly [number, number]>, x: number): number {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      return y0 + (y1 - y0) * ease((x - x0) / (x1 - x0));
    }
  }
  return pts[pts.length - 1][1];
}
