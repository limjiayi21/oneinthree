/**
 * Small offline DSP toolkit used by the procedural sound generators in synth.ts.
 * Everything here is plain sample-by-sample JavaScript on Float32Arrays: no
 * AudioContext is needed, so sounds can be rendered before the first user
 * gesture (and inspected from Node).
 */

export type F32 = Float32Array<ArrayBuffer>;
export type Rng = () => number;

export const TAU = Math.PI * 2;

/** Deterministic PRNG (mulberry32): the same seed always renders the same sound. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
export const rand = (r: Rng, lo: number, hi: number): number => lo + (hi - lo) * r();
export const dbToGain = (db: number): number => Math.pow(10, db / 20);

export function f32(n: number): F32 {
  return new Float32Array(Math.max(0, Math.round(n)));
}

/* ------------------------------------------------------------------ noise */

export function white(n: number, r: Rng, gain = 1): F32 {
  const out = f32(n);
  for (let i = 0; i < out.length; i++) out[i] = (r() * 2 - 1) * gain;
  return out;
}

/** Pink noise (Paul Kellet's filter), roughly unit peak. */
export function pink(n: number, r: Rng, gain = 1): F32 {
  const out = f32(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < out.length; i++) {
    const w = r() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11 * gain;
    b6 = w * 0.115926;
  }
  return out;
}

/** Brown (red) noise: leaky integrated white noise, roughly unit peak. */
export function brown(n: number, r: Rng, gain = 1): F32 {
  const out = f32(n);
  let y = 0;
  for (let i = 0; i < out.length; i++) {
    const w = r() * 2 - 1;
    y = (y + 0.02 * w) / 1.02;
    out[i] = y * 3.5 * gain;
  }
  return out;
}

/** Slowly wandering control signal in roughly [-1, 1]: low-passed noise, normalised. */
export function wander(n: number, sr: number, hz: number, r: Rng): F32 {
  const out = f32(n);
  const a = 1 - Math.exp((-TAU * hz) / sr);
  let y1 = 0, y2 = 0, peak = 1e-9;
  // warm up so the start is not pinned to zero
  for (let i = 0; i < Math.min(sr, 20000); i++) {
    y1 += a * (r() * 2 - 1 - y1);
    y2 += a * (y1 - y2);
  }
  for (let i = 0; i < out.length; i++) {
    y1 += a * (r() * 2 - 1 - y1);
    y2 += a * (y1 - y2);
    out[i] = y2;
    const m = Math.abs(y2);
    if (m > peak) peak = m;
  }
  const g = 1 / peak;
  for (let i = 0; i < out.length; i++) out[i] *= g;
  return out;
}

/* ---------------------------------------------------------------- filters */

/** RBJ biquad, transposed direct form II. Coefficients may be changed while running. */
export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;

  constructor(private readonly sr: number) {}

  private set(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): this {
    const inv = 1 / a0;
    this.b0 = b0 * inv;
    this.b1 = b1 * inv;
    this.b2 = b2 * inv;
    this.a1 = a1 * inv;
    this.a2 = a2 * inv;
    return this;
  }

  private w(f: number): number {
    return (TAU * clamp(f, 5, this.sr * 0.49)) / this.sr;
  }

  lowpass(f: number, q = 0.7071): this {
    const w0 = this.w(f), c = Math.cos(w0), al = Math.sin(w0) / (2 * q);
    return this.set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al);
  }

  highpass(f: number, q = 0.7071): this {
    const w0 = this.w(f), c = Math.cos(w0), al = Math.sin(w0) / (2 * q);
    return this.set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
  }

  /** Band-pass with 0 dB peak gain. */
  bandpass(f: number, q = 1): this {
    const w0 = this.w(f), c = Math.cos(w0), al = Math.sin(w0) / (2 * q);
    return this.set(al, 0, -al, 1 + al, -2 * c, 1 - al);
  }

  peaking(f: number, q: number, gainDb: number): this {
    const w0 = this.w(f), c = Math.cos(w0), A = Math.pow(10, gainDb / 40), al = Math.sin(w0) / (2 * q);
    return this.set(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A);
  }

  lowshelf(f: number, gainDb: number): this {
    const w0 = this.w(f), c = Math.cos(w0), A = Math.pow(10, gainDb / 40);
    const al = (Math.sin(w0) / 2) * Math.SQRT2, s = 2 * Math.sqrt(A) * al;
    return this.set(
      A * (A + 1 - (A - 1) * c + s),
      2 * A * (A - 1 - (A + 1) * c),
      A * (A + 1 - (A - 1) * c - s),
      A + 1 + (A - 1) * c + s,
      -2 * (A - 1 + (A + 1) * c),
      A + 1 + (A - 1) * c - s,
    );
  }

  highshelf(f: number, gainDb: number): this {
    const w0 = this.w(f), c = Math.cos(w0), A = Math.pow(10, gainDb / 40);
    const al = (Math.sin(w0) / 2) * Math.SQRT2, s = 2 * Math.sqrt(A) * al;
    return this.set(
      A * (A + 1 + (A - 1) * c + s),
      -2 * A * (A - 1 + (A + 1) * c),
      A * (A + 1 + (A - 1) * c - s),
      A + 1 - (A - 1) * c + s,
      2 * (A - 1 - (A + 1) * c),
      A + 1 - (A - 1) * c - s,
    );
  }

  tick(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  /** Filter a whole buffer in place. */
  run(buf: F32): F32 {
    for (let i = 0; i < buf.length; i++) buf[i] = this.tick(buf[i]);
    return buf;
  }

  reset(): this {
    this.z1 = 0;
    this.z2 = 0;
    return this;
  }
}

export type FilterKind = 'lowpass' | 'highpass' | 'bandpass';

/** Static filter over a copy of the buffer. */
export function filtered(src: F32, sr: number, kind: FilterKind, f: number, q = 0.7071, passes = 1): F32 {
  const out = src.slice() as F32;
  for (let p = 0; p < passes; p++) {
    const bq = new Biquad(sr);
    bq[kind](f, q);
    bq.run(out);
  }
  return out;
}

/** Filter whose frequency (and optionally Q) follows a function of time. Coefficients update every 32 samples. */
export function sweptFilter(
  src: F32,
  sr: number,
  kind: FilterKind,
  freq: (t: number) => number,
  q: number | ((t: number) => number) = 0.7071,
): F32 {
  const out = f32(src.length);
  const bq = new Biquad(sr);
  const qf = typeof q === 'number' ? () => q : q;
  for (let i = 0; i < src.length; i++) {
    if ((i & 31) === 0) {
      const t = i / sr;
      bq[kind](freq(t), qf(t));
    }
    out[i] = bq.tick(src[i]);
  }
  return out;
}

/* ----------------------------------------------------------------- mixing */

/** dst[offset + i] += src[i] * gain (clipped to dst's length). */
export function mixInto(dst: F32, src: F32, offset = 0, gain = 1): void {
  const start = Math.max(0, Math.round(offset));
  const n = Math.min(src.length, dst.length - start);
  for (let i = 0; i < n; i++) dst[start + i] += src[i] * gain;
}

export function scale(buf: F32, gain: number): F32 {
  for (let i = 0; i < buf.length; i++) buf[i] *= gain;
  return buf;
}

/** Multiply by an envelope given as a function of time (seconds). */
export function shape(buf: F32, sr: number, env: (t: number) => number): F32 {
  for (let i = 0; i < buf.length; i++) buf[i] *= env(i / sr);
  return buf;
}

export function peakOf(...bufs: F32[]): number {
  let p = 0;
  for (const b of bufs) for (let i = 0; i < b.length; i++) {
    const m = Math.abs(b[i]);
    if (m > p) p = m;
  }
  return p;
}

export function rmsOf(buf: F32): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / Math.max(1, buf.length));
}

/** Gentle saturation: linear for small signals, approaches +-1. */
export function softClip(buf: F32, drive = 1): F32 {
  const norm = 1 / Math.tanh(drive);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i] * drive) * norm;
  return buf;
}

export interface FinishOptions {
  /** Target absolute peak after normalisation. */
  peak: number;
  fadeIn?: number;
  fadeOut?: number;
  /** DC-blocking high-pass corner, Hz. 0 disables. */
  hp?: number;
  /** When true the edges are left untouched (the buffer is a seamless loop). */
  loop?: boolean;
}

/** DC-block, normalise all channels together to a target peak, fade the edges. */
export function finish(channels: F32[], sr: number, o: FinishOptions): F32[] {
  const hp = o.hp ?? 22;
  if (hp > 0 && !o.loop) for (const ch of channels) new Biquad(sr).highpass(hp, 0.7071).run(ch);
  for (const ch of channels) for (let i = 0; i < ch.length; i++) if (!Number.isFinite(ch[i])) ch[i] = 0;
  const p = peakOf(...channels);
  if (p > 1e-9) for (const ch of channels) scale(ch, o.peak / p);
  if (!o.loop) {
    const fi = Math.round((o.fadeIn ?? 0.002) * sr);
    const fo = Math.round((o.fadeOut ?? 0.02) * sr);
    for (const ch of channels) {
      for (let i = 0; i < fi && i < ch.length; i++) ch[i] *= i / fi;
      for (let i = 0; i < fo && i < ch.length; i++) {
        const k = i / fo;
        ch[ch.length - 1 - i] *= k * (2 - k);
      }
    }
  }
  return channels;
}

/**
 * Make a seamless loop of length n out of a stationary signal of length n + xf
 * by equal-power cross-fading its tail into its head.
 */
export function makeLoop(src: F32, n: number): F32 {
  const xf = src.length - n;
  const out = src.slice(0, n) as F32;
  for (let i = 0; i < xf; i++) {
    const a = i / xf;
    out[i] = src[i] * Math.sqrt(a) + src[n + i] * Math.sqrt(1 - a);
  }
  return out;
}

/* ------------------------------------------------------------ generators */

export interface Partial {
  /** Frequency, Hz. */
  f: number;
  /** Amplitude decay time constant, seconds. */
  tau: number;
  /** Linear amplitude. */
  a: number;
}

/**
 * Modal synthesis: adds a struck-object ring (a sum of exponentially decaying
 * sinusoids) into `dst` starting at time `at`. Uses two-pole recursive
 * resonators, so it is cheap enough for dozens of hits.
 */
export function strike(dst: F32, sr: number, at: number, partials: readonly Partial[], gain = 1): void {
  const start = Math.round(at * sr);
  if (start >= dst.length) return;
  for (const p of partials) {
    if (p.f >= sr * 0.47 || p.a === 0) continue;
    const w = (TAU * p.f) / sr;
    const r = Math.exp(-1 / (p.tau * sr));
    const c = 2 * r * Math.cos(w);
    const r2 = r * r;
    const amp = p.a * gain;
    let y1 = 0; // y[n-1]
    let y2 = (-amp * Math.sin(w)) / r; // y[n-2]
    const len = Math.min(dst.length - start, Math.round(p.tau * 7 * sr));
    // 0.4 ms raised attack so the onset is a knock, not a digital click
    const atk = Math.max(1, Math.round(0.0004 * sr));
    for (let i = 0; i < len; i++) {
      const y = c * y1 - r2 * y2;
      y2 = y1;
      y1 = y;
      dst[start + i] += i < atk ? y * (i / atk) : y;
    }
  }
}

/** A pitched thump: a sine whose pitch drops from f0 to f1 while it decays. */
export function thump(
  dst: F32,
  sr: number,
  at: number,
  o: { f0: number; f1: number; pitchTau: number; tau: number; gain: number; attack?: number; drive?: number },
): void {
  const start = Math.round(at * sr);
  const len = Math.min(dst.length - start, Math.round(o.tau * 8 * sr));
  const atk = Math.max(1, Math.round((o.attack ?? 0.002) * sr));
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const f = o.f1 + (o.f0 - o.f1) * Math.exp(-t / o.pitchTau);
    ph += (TAU * f) / sr;
    let s = Math.sin(ph);
    if (o.drive) s = Math.tanh(s * o.drive) / Math.tanh(o.drive);
    const env = Math.exp(-t / o.tau) * (i < atk ? i / atk : 1);
    dst[start + i] += s * env * o.gain;
  }
}

/** A short filtered noise burst with an exponential decay. */
export function burst(
  dst: F32,
  sr: number,
  at: number,
  r: Rng,
  o: { kind: FilterKind; f: number; q?: number; tau: number; gain: number; attack?: number; passes?: number },
): void {
  const start = Math.round(at * sr);
  const len = Math.min(dst.length - start, Math.round(o.tau * 8 * sr) + 8);
  if (len <= 0) return;
  const filters: Biquad[] = [];
  for (let p = 0; p < (o.passes ?? 1); p++) filters.push(new Biquad(sr)[o.kind](o.f, o.q ?? 0.8));
  const atk = Math.max(1, Math.round((o.attack ?? 0.0005) * sr));
  for (let i = 0; i < len; i++) {
    let s = r() * 2 - 1;
    for (const f of filters) s = f.tick(s);
    const env = Math.exp(-i / (o.tau * sr)) * (i < atk ? i / atk : 1);
    dst[start + i] += s * env * o.gain;
  }
}

/* ----------------------------------------------------------------- reverb */

export interface ReverbOptions {
  /** Decay time to -60 dB, seconds. */
  rt60: number;
  /** 0..1 high-frequency damping in the tail. */
  damp?: number;
  /** Wet level added to the dry signal. */
  mix: number;
  /** Seconds. */
  predelay?: number;
  /** Scales the delay lengths: <1 small room, >1 large space. */
  size?: number;
  /** Changes the delay tunings (use different seeds for L and R). */
  seed?: number;
}

/**
 * Freeverb-style room: parallel damped combs into series all-passes.
 * Returns a new buffer extended by the tail.
 */
export function reverb(src: F32, sr: number, o: ReverbOptions): F32 {
  const size = o.size ?? 1;
  const damp = clamp01(o.damp ?? 0.4);
  const tail = Math.round(o.rt60 * sr * 1.1);
  const pre = Math.round((o.predelay ?? 0.004) * sr);
  const n = src.length + tail + pre;
  const out = f32(n);
  const wet = f32(n);
  const spread = ((o.seed ?? 0) % 7) * 0.00023;
  const combMs = [0.0297, 0.0371, 0.0411, 0.0437, 0.0353, 0.0323].map((s) => (s + spread) * size);
  for (const d of combMs) {
    const len = Math.max(8, Math.round(d * sr));
    const buf = new Float64Array(len);
    const fb = Math.pow(10, (-3 * d) / o.rt60);
    let idx = 0, lp = 0;
    for (let i = 0; i < n; i++) {
      const x = i - pre >= 0 && i - pre < src.length ? src[i - pre] : 0;
      const y = buf[idx];
      lp = y * (1 - damp) + lp * damp;
      buf[idx] = x + lp * fb;
      idx = idx + 1 === len ? 0 : idx + 1;
      wet[i] += y;
    }
  }
  for (const d of [0.005, 0.0017, 0.0127]) {
    const len = Math.max(4, Math.round((d + spread * 0.5) * size * sr));
    const buf = new Float64Array(len);
    let idx = 0;
    const g = 0.6;
    for (let i = 0; i < n; i++) {
      const bufOut = buf[idx];
      const x = wet[i];
      buf[idx] = x + bufOut * g;
      wet[i] = bufOut - x * g;
      idx = idx + 1 === len ? 0 : idx + 1;
    }
  }
  const wetGain = o.mix / combMs.length;
  for (let i = 0; i < n; i++) out[i] = (i < src.length ? src[i] : 0) + wet[i] * wetGain * 2.2;
  return out;
}

/** Feed-forward echoes (hard reflections), each progressively duller. */
export function echoes(src: F32, sr: number, taps: readonly { t: number; g: number; lp?: number }[]): F32 {
  const maxT = taps.reduce((m, tp) => Math.max(m, tp.t), 0);
  const out = f32(src.length + Math.round(maxT * sr));
  mixInto(out, src, 0, 1);
  for (const tp of taps) {
    const copy = tp.lp ? filtered(src, sr, 'lowpass', tp.lp) : src;
    mixInto(out, copy, tp.t * sr, tp.g);
  }
  return out;
}

/* ------------------------------------------------------------- voice-ish */

/**
 * Band-limited glottal-ish source: a sum of harmonics with a spectral tilt.
 * `f0` is a function of time so pitch can glide; `tilt` is the 1/k^tilt roll-off.
 */
export function harmonicSource(
  n: number,
  sr: number,
  f0: (t: number) => number,
  o: { harmonics: number; tilt: number; maxHz?: number },
): F32 {
  const out = f32(n);
  const maxHz = o.maxHz ?? sr * 0.45;
  let ph = 0;
  const amps: number[] = [];
  for (let k = 1; k <= o.harmonics; k++) amps.push(1 / Math.pow(k, o.tilt));
  for (let i = 0; i < n; i++) {
    const f = f0(i / sr);
    ph += (TAU * f) / sr;
    if (ph > TAU * 64) ph -= TAU * 64;
    let s = 0;
    for (let k = 1; k <= o.harmonics; k++) {
      if (f * k > maxHz) break;
      s += Math.sin(ph * k) * amps[k - 1];
    }
    out[i] = s;
  }
  return out;
}

export interface Formant {
  f: number | ((t: number) => number);
  q: number;
  g: number;
}

/** Parallel band-pass formant bank: the vocal-tract colour for breaths, gasps and the cat. */
export function formants(src: F32, sr: number, bank: readonly Formant[]): F32 {
  const out = f32(src.length);
  for (const fm of bank) {
    const f = fm.f;
    const band = typeof f === 'number' ? filtered(src, sr, 'bandpass', f, fm.q) : sweptFilter(src, sr, 'bandpass', f, fm.q);
    mixInto(out, band, 0, fm.g);
  }
  return out;
}
