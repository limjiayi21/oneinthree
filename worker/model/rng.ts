/**
 * Small seeded PRNG (mulberry32). The whole decision model draws from one of
 * these so that a session with a fixed seed replays exactly, and so the state
 * is a single integer the Durable Object can persist.
 */
export class Rng {
  state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Uniform pick from a non-empty array. */
  pick<T>(items: readonly T[]): T {
    return items[Math.min(items.length - 1, Math.floor(this.next() * items.length))];
  }

  /** Sample a key from a (not necessarily normalised) weight table. */
  sample<K extends string>(weights: Partial<Record<K, number>>): K {
    const entries = (Object.entries(weights) as [K, number][]).filter(([, w]) => w > 0);
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [k, w] of entries) {
      r -= w;
      if (r < 0) return k;
    }
    return entries[entries.length - 1][0];
  }
}

/** Derive a 32-bit seed from a string (session ids). */
export function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function normalise<K extends string>(weights: Partial<Record<K, number>>): Record<K, number> {
  const out = {} as Record<K, number>;
  let total = 0;
  for (const [k, w] of Object.entries(weights) as [K, number][]) {
    const v = Number.isFinite(w) && w > 0 ? w : 0;
    out[k] = v;
    total += v;
  }
  if (total <= 0) {
    const keys = Object.keys(out) as K[];
    for (const k of keys) out[k] = 1 / keys.length;
    return out;
  }
  for (const k of Object.keys(out) as K[]) out[k] = out[k] / total;
  return out;
}

export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
export const round3 = (v: number): number => Math.round(v * 1000) / 1000;
