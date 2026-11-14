/**
 * Procedural sound design. Every SfxName has a synthesised version here, built
 * from noise, filters, resonators and envelopes; these play until (and unless)
 * the generated .mp3 assets exist. All renderers are deterministic and pure:
 * (sample rate) -> Float32Array channels.
 */

import type { SfxName } from '../contracts';
import {
  Biquad,
  TAU,
  brown,
  burst,
  clamp01,
  echoes,
  f32,
  filtered,
  finish,
  formants,
  harmonicSource,
  lerp,
  makeLoop,
  makeRng,
  mixInto,
  peakOf,
  pink,
  rand,
  reverb,
  rmsOf,
  scale,
  shape,
  smoothstep,
  softClip,
  strike,
  sweptFilter,
  thump,
  wander,
  white,
  type F32,
  type Formant,
  type Partial,
  type Rng,
} from './dsp';

export interface Rendered {
  sr: number;
  /** 1 (mono) or 2 (stereo) channels. */
  channels: F32[];
  loop: boolean;
}

export type Surface = 'concrete' | 'asphalt' | 'metal' | 'tile';

const mono = (sr: number, ch: F32, loop = false): Rendered => ({ sr, channels: [ch], loop });

/** Scale a buffer to a target RMS (for predictable layer balances). */
function toRms(buf: F32, target: number): F32 {
  const r = rmsOf(buf);
  return r > 1e-9 ? scale(buf, target / r) : buf;
}

/** White + pink mix: the raw turbulence used for breaths. */
function breathNoise(n: number, r: Rng): F32 {
  const out = white(n, r, 0.6);
  mixInto(out, pink(n, r), 0, 3.2);
  return out;
}

/* ============================================================== ambience */

export interface CityBed {
  /** 11 s stereo loop: low traffic rumble (filtered brown noise). */
  rumble: Rendered;
  /** 7 s stereo loop: the wide, far-off "air" of a city at night. */
  air: Rendered;
  /** 10 s mono loop: a rooftop air-conditioner drone. */
  drone: Rendered;
  /** 5 s stereo loop of raw pink noise; the engine filters it live into wind. */
  windSource: Rendered;
}

export function renderCityBed(sr: number): CityBed {
  const r = makeRng(7001);

  // --- traffic rumble
  const nR = 11 * sr, xf = sr;
  const rumbleCh = (): F32 => {
    const src = brown(nR + xf, r);
    const low = filtered(src, sr, 'lowpass', 105, 0.7071, 2);
    const mid = filtered(src, sr, 'bandpass', 230, 0.5);
    mixInto(low, mid, 0, 0.5);
    new Biquad(sr).highpass(30, 0.7071).run(low);
    return low;
  };
  const rc = rumbleCh(), rl = rumbleCh(), rr = rumbleCh();
  const rumbleL = f32(nR + xf), rumbleR = f32(nR + xf);
  mixInto(rumbleL, rc, 0, 0.75);
  mixInto(rumbleL, rl, 0, 0.5);
  mixInto(rumbleR, rc, 0, 0.75);
  mixInto(rumbleR, rr, 0, 0.5);
  const rumble: Rendered = {
    sr,
    loop: true,
    channels: finish([makeLoop(rumbleL, nR), makeLoop(rumbleR, nR)], sr, { peak: 0.6, loop: true }),
  };

  // --- city air
  const nA = 7 * sr;
  const airCh = (): F32 => {
    const src = pink(nA + xf, r);
    const band = filtered(src, sr, 'bandpass', 640, 0.32);
    const out = filtered(band, sr, 'lowpass', 2600, 0.7071);
    // a little very-high "hiss of distance" so the bed is not purely dull
    mixInto(out, filtered(src, sr, 'bandpass', 5200, 0.6), 0, 0.05);
    return makeLoop(out, nA);
  };
  const air: Rendered = { sr, loop: true, channels: finish([airCh(), airCh()], sr, { peak: 0.5, loop: true }) };

  // --- air-conditioner drone (frequencies are multiples of 0.1 Hz so the 10 s loop is seamless)
  const nD = 10 * sr;
  const drone = f32(nD);
  const hum: [number, number][] = [
    [59.8, 0.25], [119.6, 1], [120.7, 0.7], [179.4, 0.16], [239.2, 0.3], [241.4, 0.18], [358.8, 0.1], [362.1, 0.07],
  ];
  const phases = hum.map(() => r() * TAU);
  for (let i = 0; i < nD; i++) {
    const t = i / sr;
    let s = 0;
    for (let k = 0; k < hum.length; k++) s += Math.sin(TAU * hum[k][0] * t + phases[k]) * hum[k][1];
    drone[i] = s * 0.25;
  }
  const fan = makeLoop(filtered(pink(nD + xf, r), sr, 'bandpass', 340, 1.4), nD);
  mixInto(drone, toRms(fan, rmsOf(drone) * 0.8));
  const droneOut: Rendered = { sr, loop: true, channels: finish([drone], sr, { peak: 0.5, loop: true }) };

  // --- wind source
  const nW = 5 * sr;
  const windCh = (): F32 => makeLoop(pink(nW + xf, r), nW);
  const windSource: Rendered = { sr, loop: true, channels: finish([windCh(), windCh()], sr, { peak: 0.7, loop: true }) };

  return { rumble, air, drone: droneOut, windSource };
}

/** A far-off car horn fragment, already "distant" (dull, echoing off buildings). */
export function renderHorn(seed: number, sr: number): F32 {
  const r = makeRng(9100 + seed * 53);
  const fA = rand(r, 392, 446);
  const fB = fA * rand(r, 1.24, 1.27);
  const segs: [number, number][] =
    seed % 3 === 0
      ? [[0.05, rand(r, 0.5, 0.95)]]
      : seed % 3 === 1
        ? [[0.05, 0.16], [0.33, rand(r, 0.28, 0.5)]]
        : [[0.05, 0.12], [0.26, 0.12], [0.5, rand(r, 0.35, 0.6)]];
  const last = segs[segs.length - 1];
  const dry = f32((last[0] + last[1] + 0.1) * sr);
  for (const [at, len] of segs) {
    const n = Math.round(len * sr);
    const a = harmonicSource(n, sr, () => fA, { harmonics: 16, tilt: 0.65, maxHz: 7000 });
    const b = harmonicSource(n, sr, () => fB, { harmonics: 14, tilt: 0.65, maxHz: 7000 });
    mixInto(a, b, 0, 0.85);
    shape(a, sr, (t) => smoothstep(0, 0.012, t) * (1 - smoothstep(len - 0.045, len, t)));
    mixInto(dry, a, at * sr);
  }
  new Biquad(sr).peaking(2100, 1.1, 7).run(dry);
  new Biquad(sr).highpass(320, 0.7071).run(dry);
  const far = filtered(dry, sr, 'lowpass', 1500, 0.7071, 2);
  const ech = echoes(far, sr, [
    { t: 0.118, g: 0.5, lp: 1300 },
    { t: 0.263, g: 0.34, lp: 1100 },
    { t: 0.47, g: 0.22, lp: 900 },
  ]);
  const out = reverb(ech, sr, { rt60: 1.9, damp: 0.6, mix: 0.7, size: 1.6, seed });
  return finish([out], sr, { peak: 0.4, fadeOut: 0.3 })[0];
}

/* ============================================================= shop hum */

function shopHum(sr: number): Rendered {
  const r = makeRng(101);
  const dur = 4, n = dur * sr, xf = Math.round(0.5 * sr);
  const out = f32(n);
  // compressor + ballast hum: every frequency is a multiple of 0.25 Hz so 4 s loops exactly
  const parts: [number, number][] = [
    [60, 0.1], [119.5, 0.5], [120, 1], [180, 0.2], [239.75, 0.22], [240, 0.42], [300, 0.1], [360, 0.17], [480, 0.07], [600, 0.035], [720, 0.02],
  ];
  const ph = parts.map(() => r() * TAU);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let s = 0;
    for (let k = 0; k < parts.length; k++) s += Math.sin(TAU * parts[k][0] * t + ph[k]) * parts[k][1];
    const am = 1 + 0.07 * Math.sin(TAU * 0.25 * t) + 0.04 * Math.sin(TAU * 0.75 * t + 1.3);
    out[i] = s * am;
  }
  const humRms = rmsOf(out);
  // condenser fan / airflow
  const fan = makeLoop(filtered(filtered(pink(n + xf, r), sr, 'bandpass', 430, 0.6), sr, 'lowpass', 2200), n);
  mixInto(out, toRms(fan, humRms * 0.55));
  // fluorescent tube buzz: high harmonics of 120 Hz, very low
  const buzz = f32(n);
  for (let k = 17; k <= 42; k++) {
    const a = 1 / (k - 10), p = r() * TAU;
    for (let i = 0; i < n; i++) buzz[i] += Math.sin((TAU * 120 * k * i) / sr + p) * a;
  }
  mixInto(out, toRms(buzz, humRms * 0.06));
  return mono(sr, finish([out], sr, { peak: 0.5, loop: true })[0], true);
}

/* ======================================================== subway rumble */

const GRATE_PARTIALS: readonly Partial[] = [
  { f: 287, tau: 0.32, a: 0.5 },
  { f: 431, tau: 0.3, a: 0.8 },
  { f: 598, tau: 0.26, a: 1 },
  { f: 812, tau: 0.22, a: 0.7 },
  { f: 1175, tau: 0.18, a: 0.8 },
  { f: 1630, tau: 0.14, a: 0.55 },
  { f: 2240, tau: 0.11, a: 0.45 },
  { f: 2980, tau: 0.08, a: 0.3 },
  { f: 3870, tau: 0.06, a: 0.2 },
  { f: 5100, tau: 0.04, a: 0.12 },
];

function subwayRumble(sr: number): Rendered {
  const r = makeRng(202);
  const dur = 9.5, n = Math.round(dur * sr);
  const env = (t: number): number =>
    t < 3.8 ? Math.pow(smoothstep(0, 3.8, t), 1.6) : t < 5.2 ? 1 : Math.pow(1 - smoothstep(5.2, 9.3, t), 1.3);

  const rumbleCh = (): F32 => {
    const src = brown(n, r);
    let rum = sweptFilter(src, sr, 'lowpass', (t) => 45 + 120 * env(t), 0.9);
    rum = sweptFilter(rum, sr, 'lowpass', (t) => 60 + 170 * env(t), 0.7071);
    return shape(rum, sr, (t) => Math.pow(env(t), 1.1));
  };
  const common = rumbleCh();

  // sub tones + wheel clacks + squeal: the train itself, heard through the ground
  const train = f32(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr, e = env(t);
    train[i] = (Math.sin(TAU * 33 * t + 0.6 * Math.sin(TAU * 0.31 * t)) * 0.5 + Math.sin(TAU * 49.5 * t) * 0.3) * e * 0.3;
  }
  let t = 0.5;
  while (t < dur - 0.7) {
    const e = env(t);
    if (e > 0.04) {
      for (const [dt, g] of [[0, 1], [rand(r, 0.075, 0.095), 0.7]] as const) {
        thump(train, sr, t + dt, { f0: 96, f1: 58, pitchTau: 0.02, tau: 0.045, gain: 0.42 * e * g });
        burst(train, sr, t + dt, r, { kind: 'lowpass', f: 420, tau: 0.02, gain: 0.5 * e * g });
      }
    }
    t += (1 / (1.5 + 2.7 * e)) * rand(r, 0.95, 1.05);
  }
  const squeal = filtered(white(n, r), sr, 'bandpass', 2850, 45);
  mixInto(squeal, filtered(white(n, r), sr, 'bandpass', 3620, 55), 0, 0.6);
  const sqMod = wander(n, sr, 1.2, r);
  for (let i = 0; i < n; i++) squeal[i] *= Math.pow(env(i / sr), 3) * clamp01(0.4 + 0.6 * sqMod[i]);
  mixInto(train, toRms(squeal, 0.012));

  // grate bars rattling in sympathy at the surface
  const rattle = f32(n);
  t = 1.5;
  while (t < dur - 1.5) {
    const e = env(t);
    if (e > 0.3) {
      const pick = GRATE_PARTIALS.filter(() => r() < 0.5).map((p) => ({ ...p, f: p.f * rand(r, 0.97, 1.03), tau: p.tau * 0.5 }));
      strike(rattle, sr, t, pick, 0.02 * e * e * rand(r, 0.4, 1));
    }
    t += rand(r, 0.05, 0.3) / Math.max(0.2, e);
  }

  const build = (): F32 => {
    const ch = rumbleCh();
    scale(ch, 0.55);
    mixInto(ch, common, 0, 0.8);
    mixInto(ch, train, 0, 1);
    const under = filtered(ch, sr, 'lowpass', 1500, 0.7071);
    mixInto(under, rattle, 0, 1);
    return under;
  };
  return { sr, loop: false, channels: finish([build(), build()], sr, { peak: 0.75, fadeIn: 0.2, fadeOut: 0.3 }) };
}

/* ======================================================== distant siren */

function distantSiren(sr: number): Rendered {
  const r = makeRng(303);
  const dur = 10, n = dur * sr;
  const cycle = 4.3;
  const ease = (x: number): number => 0.5 - 0.5 * Math.cos(Math.PI * x);
  const f0 = (t: number): number => {
    const u = (t % cycle) / cycle;
    const up = u < 0.42 ? ease(u / 0.42) : 1 - ease((u - 0.42) / 0.58);
    // the whole wail drifts flat as the vehicle passes its nearest point and recedes
    const doppler = lerp(1.032, 0.96, smoothstep(2.5, 7.5, t));
    return 640 * Math.pow(1380 / 640, up) * doppler;
  };
  const src = harmonicSource(n, sr, f0, { harmonics: 7, tilt: 1, maxHz: 6000 });
  new Biquad(sr).peaking(1150, 1.2, 7).run(src);
  new Biquad(sr).highpass(420, 0.7071).run(src);
  const far = filtered(src, sr, 'lowpass', 2500, 0.7071, 2);
  const flutter = wander(n, sr, 0.8, r);
  for (let i = 0; i < n; i++) {
    const tt = i / sr;
    far[i] *= smoothstep(0, 3, tt) * (1 - smoothstep(6.2, 9.9, tt)) * (0.72 + 0.28 * flutter[i]);
  }
  const ech = echoes(far, sr, [
    { t: 0.131, g: 0.5, lp: 2200 },
    { t: 0.287, g: 0.36, lp: 1800 },
    { t: 0.452, g: 0.26, lp: 1500 },
    { t: 0.71, g: 0.16, lp: 1200 },
  ]);
  const out = reverb(ech, sr, { rt60: 2.2, damp: 0.55, mix: 0.6, size: 1.7 });
  return mono(sr, finish([out], sr, { peak: 0.45, fadeIn: 0.05, fadeOut: 0.5 })[0]);
}

/* ============================================================= car pass */

function carPass(sr: number): Rendered {
  const r = makeRng(404);
  const dur = 5.2, n = Math.round(dur * sr);
  const t0 = 2.5, v = 13, d0 = 6;
  const dist = (t: number): number => Math.hypot(d0, v * (t - t0));
  const near = (t: number): number => d0 / dist(t);
  const doppler = (t: number): number => 1 / (1 + (v * v * (t - t0)) / dist(t) / 343);

  // tyres on the road: the body of the whoosh
  const tyre = sweptFilter(pink(n, r), sr, 'bandpass', (t) => 900 * doppler(t) * (0.5 + 0.9 * near(t)), 0.7);
  shape(tyre, sr, (t) => Math.pow(near(t), 1.3));
  // close-range hiss
  const hiss = filtered(white(n, r), sr, 'highpass', 3000, 0.7071);
  shape(hiss, sr, (t) => Math.pow(near(t), 2.6));
  // engine: a firing-order drone with Doppler
  const engine = f32(n);
  const hw = [1, 0.7, 0.45, 0.5, 0.25, 0.2, 0.12, 0.1];
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    ph += (TAU * 82 * doppler(t)) / sr;
    let s = 0.35 * Math.sin(ph * 0.5);
    for (let k = 0; k < hw.length; k++) s += Math.sin(ph * (k + 1)) * hw[k];
    engine[i] = s * Math.pow(near(t), 1.1);
  }
  const engineLp = filtered(engine, sr, 'lowpass', 620, 0.7071, 2);
  // the pressure wave as it goes by
  const whump = filtered(brown(n, r), sr, 'lowpass', 140, 0.7071);
  shape(whump, sr, (t) => Math.exp(-Math.pow((t - t0) / 0.28, 2)));

  const out = toRms(tyre, 0.1);
  mixInto(out, toRms(hiss, 0.018));
  mixInto(out, toRms(engineLp, 0.05));
  mixInto(out, toRms(whump, 0.035));
  return mono(sr, finish([out], sr, { peak: 0.7, fadeIn: 0.4, fadeOut: 0.6 })[0]);
}

/* ====================================================== trash can crash */

const CAN_F = [142, 228, 371, 512, 690, 865, 1130, 1490, 1920, 2480, 3150, 4100, 5300];
const CAN_TAU = [0.45, 0.5, 0.42, 0.36, 0.3, 0.26, 0.2, 0.16, 0.13, 0.1, 0.08, 0.06, 0.045];

function canPartials(r: Rng, pitch: number, decay: number, bright: number): Partial[] {
  return CAN_F.map((f, k) => ({
    f: f * pitch * rand(r, 0.985, 1.015),
    tau: CAN_TAU[k] * decay,
    a: (rand(r, 0.4, 1) / (1 + k * 0.22)) * Math.pow(bright, k / 4),
  }));
}

function trashCanCrash(sr: number): Rendered {
  const r = makeRng(505);
  const dur = 3.0, n = Math.round(dur * sr);
  const dry = f32(n);
  const hit = (at: number, strength: number, pitch: number, decay: number, bright: number): void => {
    strike(dry, sr, at, canPartials(r, pitch, decay, bright), 0.2 * strength);
    burst(dry, sr, at, r, { kind: 'bandpass', f: 3400 * pitch, q: 0.5, tau: 0.011, gain: 2 * strength });
  };
  // the can goes over...
  hit(0.04, 1, 1, 1, 1.1);
  thump(dry, sr, 0.04, { f0: 110, f1: 62, pitchTau: 0.03, tau: 0.06, gain: 0.35 });
  hit(0.17, 0.5, 1.03, 0.8, 0.9);
  // ...the lid comes off and wobbles to a stop (bounces get faster and quieter)
  let t = 0.31, gap = 0.19, amp = 0.62;
  while (gap > 0.022 && t < dur - 0.6) {
    hit(t, amp, 1.9 * rand(r, 0.97, 1.03), 0.5, 1.25);
    t += gap * rand(r, 0.9, 1.1);
    gap *= 0.76;
    amp *= 0.84;
  }
  // ...and the can rolls a little
  const rollLen = Math.round(1.5 * sr);
  const rollSrc = white(rollLen, r);
  const roll = formants(rollSrc, sr, [
    { f: 371, q: 14, g: 1 },
    { f: 865, q: 16, g: 0.8 },
    { f: 1920, q: 14, g: 0.5 },
    { f: 228, q: 10, g: 0.7 },
  ]);
  let rp = 0;
  for (let i = 0; i < rollLen; i++) {
    const tt = i / sr;
    rp += (TAU * lerp(9, 3.5, tt / 1.5)) / sr;
    const lump = Math.pow(0.5 + 0.5 * Math.sin(rp), 3);
    roll[i] *= lump * Math.exp(-tt / 0.45) * smoothstep(0, 0.08, tt);
  }
  mixInto(dry, toRms(roll, 0.03), 0.42 * sr);
  const out = reverb(dry, sr, { rt60: 0.9, damp: 0.45, mix: 0.3, size: 0.9, predelay: 0.012 });
  softClip(scale(out, 1 / Math.max(1e-6, peakOf(out))), 1.4);
  return mono(sr, finish([out], sr, { peak: 0.88, fadeIn: 0.001, fadeOut: 0.2 })[0]);
}

/* ============================================================= cat yowl */

function catYowl(sr: number): Rendered {
  const r = makeRng(606);
  const dur = 1.45, n = Math.round(dur * sr);
  const drift = wander(n, sr, 9, r);
  const f0 = (t: number): number => {
    const rise = lerp(510, 830, smoothstep(0, 0.24, t));
    const fall = lerp(0, 380, smoothstep(0.55, 1.25, t));
    const i = Math.min(n - 1, Math.round(t * sr));
    return (rise - fall) * (1 + 0.028 * Math.sin(TAU * 6.3 * t) * smoothstep(0.2, 0.5, t) + 0.02 * drift[i]);
  };
  const src = harmonicSource(n, sr, f0, { harmonics: 16, tilt: 0.9, maxHz: 9000 });
  // growl: subharmonic roughness in the middle of the cry
  let gp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    gp += (TAU * f0(t) * 0.5) / sr;
    const depth = 0.55 * smoothstep(0.15, 0.4, t) * (1 - smoothstep(0.9, 1.2, t));
    src[i] *= 1 - depth * (0.5 + 0.5 * Math.sin(gp + 0.8 * Math.sin(TAU * 31 * t)));
  }
  // "m-eee-aaa-ow": the vowel opens then closes
  const open = (t: number): number => smoothstep(0.02, 0.3, t) * (1 - 0.7 * smoothstep(0.75, 1.3, t));
  const voiced = formants(src, sr, [
    { f: (t) => lerp(650, 1300, open(t)), q: 5, g: 1 },
    { f: (t) => lerp(1750, 2750, open(t)), q: 8, g: 0.8 },
    { f: 3700, q: 9, g: 0.4 },
    { f: 5200, q: 8, g: 0.15 },
  ]);
  shape(voiced, sr, (t) => smoothstep(0, 0.045, t) * (1 - smoothstep(0.95, 1.36, t)));
  // spit / hiss at the onset and breath through the cry
  const noise = white(n, r);
  const hiss = filtered(noise, sr, 'bandpass', 4600, 1.1);
  shape(hiss, sr, (t) => smoothstep(0, 0.006, t) * Math.exp(-t / 0.11));
  const breath = formants(noise, sr, [
    { f: 1300, q: 3, g: 1 },
    { f: 2700, q: 4, g: 0.7 },
  ]);
  shape(breath, sr, (t) => smoothstep(0, 0.05, t) * (1 - smoothstep(0.9, 1.3, t)));
  const dry = toRms(voiced, 0.12);
  mixInto(dry, toRms(hiss, 0.02));
  mixInto(dry, toRms(breath, 0.012));
  const out = reverb(dry, sr, { rt60: 0.8, damp: 0.5, mix: 0.22, size: 0.9, predelay: 0.01 });
  return mono(sr, finish([out], sr, { peak: 0.72, fadeOut: 0.15 })[0]);
}

/* ====================================================== door buzz + latch */

function doorBuzzOpen(sr: number): Rendered {
  const r = makeRng(707);
  const dur = 2.3, n = Math.round(dur * sr);
  const on = 0.06, off = 1.46;
  const buzzN = Math.round((off - on) * sr);
  // an AC solenoid buzzer: a harsh 120 Hz pulse train with 60 Hz armature rattle
  const buzz = f32(buzzN);
  const H = 44;
  const amps: number[] = [], phs: number[] = [];
  for (let k = 1; k <= H; k++) {
    amps.push((1 / Math.pow(k, 0.7)) * (1 + 0.35 * Math.cos(k * 0.9)));
    phs.push(r() * 0.6);
  }
  const jit = wander(buzzN, sr, 25, r);
  for (let i = 0; i < buzzN; i++) {
    const t = i / sr;
    let s = 0;
    const base = TAU * 120 * t;
    for (let k = 1; k <= H; k++) s += Math.sin(base * k + phs[k - 1]) * amps[k - 1];
    const rattle = 1 + 0.4 * Math.sin(TAU * 60 * t + 0.4) + 0.12 * jit[i];
    buzz[i] = s * rattle;
  }
  const housing = formants(buzz, sr, [
    { f: 480, q: 3, g: 1 },
    { f: 1250, q: 4, g: 1.1 },
    { f: 2700, q: 3, g: 0.7 },
    { f: 4100, q: 4, g: 0.25 },
  ]);
  mixInto(housing, buzz, 0, 0.12);
  shape(housing, sr, (t) => smoothstep(0, 0.004, t) * (1 - smoothstep(off - on - 0.018, off - on, t)));
  const dry = f32(n);
  mixInto(dry, toRms(housing, 0.16), on * sr);
  // the electric strike pulling in, then the latch letting go as the door is pushed
  const latch = (at: number, g: number): void => {
    strike(dry, sr, at, [
      { f: 950, tau: 0.03, a: 1 },
      { f: 1730, tau: 0.024, a: 0.8 },
      { f: 2600, tau: 0.018, a: 0.6 },
      { f: 3900, tau: 0.012, a: 0.35 },
    ], 0.18 * g);
    burst(dry, sr, at, r, { kind: 'bandpass', f: 2600, q: 0.7, tau: 0.004, gain: 0.5 * g });
    thump(dry, sr, at, { f0: 150, f1: 95, pitchTau: 0.015, tau: 0.04, gain: 0.5 * g });
  };
  latch(on - 0.012, 0.35);
  latch(off + 0.02, 1);
  latch(off + 0.17, 0.4);
  const out = reverb(dry, sr, { rt60: 0.5, damp: 0.5, mix: 0.2, size: 0.6 });
  return mono(sr, finish([out], sr, { peak: 0.6, fadeOut: 0.12 })[0]);
}

/* ====================================================== heavy door close */

function doorCloseHeavy(sr: number): Rendered {
  const r = makeRng(808);
  const dur = 1.0, n = Math.round(dur * sr);
  const dry = f32(n);
  const at = 0.07;
  // latch bolt riding over the strike plate just before the slab lands
  burst(dry, sr, at - 0.026, r, { kind: 'bandpass', f: 2300, q: 0.9, tau: 0.004, gain: 0.3 });
  // the slab meeting the frame
  thump(dry, sr, at, { f0: 98, f1: 46, pitchTau: 0.03, tau: 0.11, gain: 0.6, drive: 1.5 });
  burst(dry, sr, at, r, { kind: 'bandpass', f: 250, q: 1.1, tau: 0.05, gain: 3.2, passes: 2 });
  burst(dry, sr, at, r, { kind: 'bandpass', f: 900, q: 0.8, tau: 0.012, gain: 1.6 });
  strike(dry, sr, at, [
    { f: 148, tau: 0.12, a: 1 },
    { f: 212, tau: 0.1, a: 0.8 },
    { f: 330, tau: 0.08, a: 0.6 },
    { f: 470, tau: 0.06, a: 0.4 },
    { f: 720, tau: 0.04, a: 0.25 },
  ], 0.2);
  // the latch snapping home
  strike(dry, sr, at + 0.012, [
    { f: 1100, tau: 0.03, a: 1 },
    { f: 1850, tau: 0.022, a: 0.7 },
    { f: 2900, tau: 0.016, a: 0.45 },
  ], 0.22);
  // frame and letterbox settling
  for (const [dt, g] of [[0.05, 0.4], [0.094, 0.28], [0.137, 0.16]] as const) {
    burst(dry, sr, at + dt, r, { kind: 'bandpass', f: rand(r, 500, 1400), q: 1.5, tau: 0.008, gain: g });
  }
  const out = reverb(dry, sr, { rt60: 1.1, damp: 0.65, mix: 0.4, size: 1.1, predelay: 0.008 });
  return mono(sr, finish([out], sr, { peak: 0.88, fadeIn: 0.001, fadeOut: 0.25 })[0]);
}

/* ============================================================ keys jingle */

function keysJingle(sr: number): Rendered {
  const r = makeRng(909);
  const dur = 1.45, n = Math.round(dur * sr);
  const out = f32(n);
  const ratios = [1, 1.47, 2.09, 2.56, 3.2];
  const keys = [2750, 3320, 4050, 4880, 5650].map((base) =>
    ratios.map((m, k): Partial => ({ f: base * m * rand(r, 0.99, 1.01), tau: rand(r, 0.03, 0.09) / (1 + k * 0.35), a: 1 / (1 + k * 0.5) })),
  );
  const ring: Partial[] = [
    { f: 1880, tau: 0.13, a: 0.5 },
    { f: 3050, tau: 0.1, a: 0.3 },
  ];
  const clink = (at: number, g: number): void => {
    const key = keys[Math.floor(r() * keys.length)];
    strike(out, sr, at, key, 0.2 * g);
    if (r() < 0.35) strike(out, sr, at, ring, 0.1 * g);
    burst(out, sr, at, r, { kind: 'highpass', f: 5200, tau: 0.0015, gain: 0.35 * g });
  };
  const clusters: [number, number, number][] = [
    [0.04, 6, 1],
    [0.4, 5, 0.8],
    [0.74, 6, 0.65],
    [1.03, 3, 0.3],
  ];
  for (const [at, count, g] of clusters) {
    for (let k = 0; k < count; k++) clink(at + rand(r, 0, 0.13) + k * 0.012, g * rand(r, 0.3, 1));
  }
  return mono(sr, finish([out], sr, { peak: 0.5, fadeOut: 0.08, hp: 400 })[0]);
}

/* ================================================== her breath: the gasp */

function gasp(sr: number): Rendered {
  const r = makeRng(1111);
  const dur = 0.6, n = Math.round(dur * sr);
  const t0 = 0.012, T = 0.4;
  const src = breathNoise(n, r);
  const glide = (a: number, b: number) => (t: number): number => lerp(a, b, Math.pow(smoothstep(t0, t0 + T, t), 0.7));
  // a sharp inhale through an open mouth: the formants climb as the throat tightens
  const body = formants(src, sr, [
    { f: glide(780, 1150), q: 2.6, g: 1 },
    { f: glide(1450, 2150), q: 3.5, g: 0.9 },
    { f: glide(2800, 3500), q: 4.5, g: 0.6 },
    { f: glide(4200, 4800), q: 4, g: 0.3 },
  ]);
  mixInto(body, filtered(src, sr, 'highpass', 3000, 0.7071), 0, 0.1);
  shape(body, sr, (t) => {
    const x = t - t0;
    if (x < 0) return 0;
    const rise = 1 - Math.exp(-x / 0.026);
    const swell = 0.7 + 0.3 * smoothstep(0, T * 0.8, x);
    const cut = 1 - smoothstep(T - 0.028, T, x); // the breath catches: an abrupt stop
    return rise * swell * cut;
  });
  // the faintest involuntary voice in it: the pitch of a small "hh-ih"
  const voiced = harmonicSource(n, sr, (t) => lerp(305, 440, smoothstep(t0, t0 + 0.22, t)), { harmonics: 12, tilt: 1.3 });
  const v = formants(voiced, sr, [
    { f: 900, q: 4, g: 1 },
    { f: 1750, q: 5, g: 0.5 },
    { f: 3000, q: 6, g: 0.2 },
  ]);
  shape(v, sr, (t) => {
    const x = t - t0;
    return x < 0 ? 0 : smoothstep(0, 0.03, x) * (1 - smoothstep(0.1, 0.25, x));
  });
  mixInto(body, toRms(v, rmsOf(body) * 0.2));
  return mono(sr, finish([body], sr, { peak: 0.6, fadeOut: 0.03, hp: 150 })[0]);
}

/** One inhale or exhale of mouth breathing. `shake` 0..1 adds the tremor of fear. */
function breathPhase(sr: number, r: Rng, kind: 'in' | 'out', dur: number, shake: number): F32 {
  const n = Math.round(dur * sr);
  const src = breathNoise(n, r);
  const u = (t: number): number => t / dur;
  const bank: Formant[] =
    kind === 'in'
      ? [
          { f: (t) => lerp(950, 1250, u(t)), q: 2.2, g: 1 },
          { f: (t) => lerp(1700, 2300, u(t)), q: 3, g: 0.8 },
          { f: 3100, q: 4, g: 0.45 },
          { f: 4600, q: 3, g: 0.2 },
        ]
      : [
          { f: (t) => lerp(720, 560, u(t)), q: 1.8, g: 1 },
          { f: (t) => lerp(1350, 1100, u(t)), q: 2.5, g: 0.7 },
          { f: 2600, q: 3.5, g: 0.3 },
        ];
  let out = formants(src, sr, bank);
  if (kind === 'in') mixInto(out, filtered(src, sr, 'highpass', 3200, 0.7071), 0, 0.08);
  else out = filtered(out, sr, 'lowpass', 4500, 0.7071);
  const tremHz = rand(r, 8, 12), tremPh = r() * TAU;
  const irregular = wander(n, sr, 5, r);
  // one or two catches in a frightened inhale
  const catches: number[] = [];
  if (kind === 'in' && shake > 0.3) {
    catches.push(rand(r, 0.3, 0.45));
    if (r() < 0.6) catches.push(rand(r, 0.6, 0.75));
  }
  shape(out, sr, (t) => {
    const x = u(t);
    const env =
      kind === 'in'
        ? Math.pow(Math.sin(Math.PI * Math.pow(x, 1.25)), 0.85)
        : Math.pow(x, 0.35) * Math.pow(1 - x, 1.4) * 2.2;
    const i = Math.min(n - 1, Math.round(t * sr));
    const depth = shake * (kind === 'in' ? 0.55 : 0.4);
    let trem = 1 - depth * (0.5 + 0.5 * Math.sin(TAU * tremHz * t + tremPh)) * (0.7 + 0.3 * irregular[i]);
    for (const c of catches) trem *= 1 - 0.8 * Math.exp(-Math.pow((x - c) / 0.035, 2));
    return env * trem;
  });
  return out;
}

function breathShaky(sr: number): Rendered {
  const r = makeRng(1212);
  const phases: { kind: 'in' | 'out'; at: number; dur: number; gain: number }[] = [];
  let t = 0.03;
  for (let c = 0; c < 4; c++) {
    const inh = rand(r, 0.44, 0.58), exh = rand(r, 0.58, 0.76);
    phases.push({ kind: 'in', at: t, dur: inh, gain: rand(r, 0.8, 1) });
    t += inh + rand(r, 0.05, 0.1);
    phases.push({ kind: 'out', at: t, dur: exh, gain: rand(r, 0.65, 0.85) });
    t += exh + rand(r, 0.12, 0.2);
  }
  const out = f32(t * sr);
  for (const p of phases) mixInto(out, toRms(breathPhase(sr, r, p.kind, p.dur, 1), 0.1 * p.gain), p.at * sr);
  new Biquad(sr).highpass(180, 0.7071).run(out);
  // the loop begins and ends in the pause between breaths, so no cross-fade is needed
  const ch = finish([out], sr, { peak: 0.45, loop: true })[0];
  return mono(sr, ch, true);
}

function exhaleRelief(sr: number): Rendered {
  const r = makeRng(1313);
  const dur = 2.0, n = Math.round(dur * sr);
  const src = breathNoise(n, r);
  let body = formants(src, sr, [
    { f: (t) => lerp(640, 500, t / dur), q: 1.8, g: 1 },
    { f: (t) => lerp(1200, 980, t / dur), q: 2.4, g: 0.75 },
    { f: 2500, q: 3.5, g: 0.3 },
  ]);
  body = sweptFilter(body, sr, 'lowpass', (t) => lerp(5200, 1900, smoothstep(0.1, 1.7, t)), 0.7071);
  const env = (t: number): number => smoothstep(0, 0.14, t) * Math.exp(-Math.max(0, t - 0.14) / 0.52) * (1 - smoothstep(1.6, 1.95, t));
  shape(body, sr, (t) => env(t) * (1 - 0.22 * Math.exp(-t / 0.35) * (0.5 + 0.5 * Math.sin(TAU * 7.5 * t))));
  // the sigh in it: a soft, falling, breathy voice
  const voiced = harmonicSource(n, sr, (t) => lerp(245, 172, smoothstep(0.05, 1.3, t)), { harmonics: 10, tilt: 1.6 });
  const v = formants(voiced, sr, [
    { f: 620, q: 3, g: 1 },
    { f: 1150, q: 4, g: 0.45 },
  ]);
  shape(v, sr, (t) => env(t) * smoothstep(0.03, 0.2, t) * (1 - smoothstep(0.5, 1.1, t)));
  mixInto(body, toRms(v, rmsOf(body) * 0.3));
  return mono(sr, finish([body], sr, { peak: 0.5, fadeOut: 0.1, hp: 150 })[0]);
}

/* ============================================================ small things */

function clothRustle(sr: number): Rendered {
  const r = makeRng(1414);
  const dur = 0.72, n = Math.round(dur * sr);
  const out = f32(n);
  const grains = 5;
  for (let g = 0; g < grains; g++) {
    const len = rand(r, 0.07, 0.17);
    const at = rand(r, 0, dur - len - 0.02);
    const gn = Math.round(len * sr);
    const grain = filtered(white(gn, r), sr, 'bandpass', rand(r, 2400, 5200), 0.6);
    // the crinkle: fabric fibres catch and release, so the level is granular, not smooth
    const tex = wander(gn, sr, 170, r);
    const amp = rand(r, 0.4, 1);
    for (let i = 0; i < gn; i++) {
      const w = Math.sin((Math.PI * i) / gn);
      grain[i] *= w * w * amp * Math.pow(Math.abs(tex[i]), 0.7);
    }
    mixInto(out, grain, at * sr);
  }
  // the soft body of a sleeve or bag strap moving
  const low = filtered(white(n, r), sr, 'bandpass', 420, 0.8);
  const slow = wander(n, sr, 6, r);
  for (let i = 0; i < n; i++) low[i] *= Math.abs(slow[i]) * Math.sin((Math.PI * i) / n);
  mixInto(out, toRms(low, rmsOf(out) * 0.25));
  return mono(sr, finish([out], sr, { peak: 0.35, fadeIn: 0.01, fadeOut: 0.05, hp: 120 })[0]);
}

function phoneCameraStart(sr: number): Rendered {
  const dur = 0.42, n = Math.round(dur * sr);
  const out = f32(n);
  const tone = (at: number, f: number, len: number, g: number): void => {
    const start = Math.round(at * sr);
    for (let i = 0; i < len * sr && start + i < n; i++) {
      const t = i / sr;
      const env = smoothstep(0, 0.004, t) * Math.exp(-t / (len * 0.45)) * (1 - smoothstep(len * 0.8, len, t));
      out[start + i] += (Math.sin(TAU * f * t) + 0.1 * Math.sin(TAU * 2 * f * t) + 0.04 * Math.sin(TAU * 3 * f * t)) * env * g;
    }
  };
  tone(0.01, 1174.66, 0.085, 0.9);
  tone(0.115, 1760, 0.2, 1);
  return mono(sr, finish([out], sr, { peak: 0.32, fadeOut: 0.03 })[0]);
}

function shopBell(sr: number): Rendered {
  const r = makeRng(1616);
  const dur = 2.6, n = Math.round(dur * sr);
  const out = f32(n);
  const base = 1550;
  const spec: [number, number, number][] = [
    [0.5, 1.2, 0.22], [1, 1.0, 1], [1.2, 0.7, 0.35], [1.5, 0.6, 0.3], [2, 0.8, 0.7], [2.74, 0.4, 0.4], [3.76, 0.25, 0.25], [5.04, 0.15, 0.12],
  ];
  const partials: Partial[] = [];
  for (const [ratio, tau, a] of spec) {
    partials.push({ f: base * ratio, tau, a });
    partials.push({ f: base * ratio * 1.0031, tau: tau * 0.9, a: a * 0.5 }); // doublet: the shimmer of a real bell
  }
  // a bell on a coiled spring: it is struck again and again as the spring settles
  const strikes: [number, number][] = [[0.03, 1], [0.17, 0.55], [0.29, 0.72], [0.47, 0.38], [0.6, 0.3], [0.83, 0.16], [1.02, 0.08]];
  for (const [at, g] of strikes) {
    strike(out, sr, at + rand(r, -0.006, 0.006), partials.map((p) => ({ ...p, a: p.a * rand(r, 0.7, 1.1) })), 0.12 * g);
    burst(out, sr, at, r, { kind: 'highpass', f: 4200, tau: 0.002, gain: 0.3 * g });
  }
  return mono(sr, finish([out], sr, { peak: 0.5, fadeOut: 0.3, hp: 300 })[0]);
}

function tinnitus(sr: number): Rendered {
  const dur = 5.6, n = Math.round(dur * sr);
  const out = f32(n);
  let p1 = 0, p2 = 0, p3 = 0, p4 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const rise = smoothstep(0, 0.55, t);
    const f = 4150 - 520 * (1 - rise) * (1 - rise);
    p1 += (TAU * f) / sr;
    p2 += (TAU * (f + 23)) / sr;
    p3 += (TAU * f * 2.006) / sr;
    p4 += (TAU * 6270) / sr;
    const env = Math.pow(rise, 1.5) * (t < 1.1 ? 1 : Math.exp(-(t - 1.1) / 1.05)) * (1 - smoothstep(4.6, 5.5, t));
    out[i] = (Math.sin(p1) + 0.55 * Math.sin(p2) + 0.16 * Math.sin(p3) + 0.1 * Math.sin(p4) * rise) * env;
  }
  // 4 kHz is where the ear is most sensitive: this is deliberately far below the level of everything else
  return mono(sr, finish([out], sr, { peak: 0.085, fadeOut: 0.1, hp: 0 })[0]);
}

function impactThud(sr: number): Rendered {
  const r = makeRng(1818);
  const dur = 0.6, n = Math.round(dur * sr);
  const out = f32(n);
  thump(out, sr, 0.004, { f0: 108, f1: 42, pitchTau: 0.04, tau: 0.12, gain: 1, attack: 0.003, drive: 1.8 });
  burst(out, sr, 0.004, r, { kind: 'lowpass', f: 220, tau: 0.06, gain: 2.2, passes: 2, attack: 0.002 });
  burst(out, sr, 0.004, r, { kind: 'bandpass', f: 420, q: 1, tau: 0.018, gain: 0.5 });
  const lp = filtered(out, sr, 'lowpass', 900, 0.7071);
  softClip(scale(lp, 1 / Math.max(1e-6, peakOf(lp))), 1.6);
  return mono(sr, finish([lp], sr, { peak: 0.9, fadeIn: 0.001, fadeOut: 0.1 })[0]);
}

function windGust(sr: number): Rendered {
  const r = makeRng(1919);
  const dur = 4.6, n = Math.round(dur * sr);
  const env = (t: number): number => Math.pow(smoothstep(0, 1.7, t), 1.4) * Math.pow(1 - smoothstep(2.0, 4.5, t), 1.2);
  const fl = wander(n, sr, 1.6, r);
  const centre = (t: number): number => {
    const i = Math.min(n - 1, Math.round(t * sr));
    return 260 + 720 * Math.pow(env(t), 1.5) * (1 + 0.25 * fl[i]);
  };
  const whistleSrc = filtered(white(n, r), sr, 'bandpass', 1480, 35);
  shape(whistleSrc, sr, (t) => Math.pow(env(t), 3));
  const whistle = toRms(whistleSrc, 0.006);
  const ch = (): F32 => {
    const body = sweptFilter(pink(n, r), sr, 'bandpass', centre, 0.9);
    const flutter = wander(n, sr, 2.2, r);
    for (let i = 0; i < n; i++) body[i] *= env(i / sr) * (0.75 + 0.25 * flutter[i]);
    // wind buffeting the ears: low, turbulent
    const low = filtered(brown(n, r), sr, 'lowpass', 130, 0.7071);
    const buf = wander(n, sr, 9, r);
    for (let i = 0; i < n; i++) low[i] *= env(i / sr) * (0.5 + 0.5 * Math.abs(buf[i]));
    const out = toRms(body, 0.1);
    mixInto(out, toRms(low, 0.06));
    mixInto(out, whistle);
    return out;
  };
  return { sr, loop: false, channels: finish([ch(), ch()], sr, { peak: 0.6, fadeIn: 0.1, fadeOut: 0.3 }) };
}

/* ============================================================== dispatch */

export type SynthName = Exclude<SfxName, 'ambience_city_night'>;

const RENDERERS: Record<SynthName, (sr: number) => Rendered> = {
  ambience_shop_hum: shopHum,
  subway_rumble: subwayRumble,
  distant_siren: distantSiren,
  car_pass: carPass,
  trash_can_crash: trashCanCrash,
  cat_yowl: catYowl,
  door_buzz_open: doorBuzzOpen,
  door_close_heavy: doorCloseHeavy,
  keys_jingle: keysJingle,
  gasp,
  breath_shaky: breathShaky,
  exhale_relief: exhaleRelief,
  cloth_rustle: clothRustle,
  phone_camera_start: phoneCameraStart,
  shop_bell: shopBell,
  tinnitus,
  impact_thud: impactThud,
  wind_gust: windGust,
};

export const SYNTH_NAMES = Object.keys(RENDERERS) as SynthName[];

/** Render the synthesised version of a sound. (The city ambience is a live layered bed: see renderCityBed.) */
export function renderSfx(name: SynthName, sr: number): Rendered {
  return RENDERERS[name](sr);
}

/* ============================================================= footsteps */

export const SURFACES: readonly Surface[] = ['concrete', 'asphalt', 'metal', 'tile'];

/**
 * One isolated footstep: a heel strike, then the sole coming down a moment
 * later. `seed` selects the variant (pitch, heel-toe gap and grit all move).
 * Light = a woman's flat shoes; heavy = a man's boots (lower, longer, slower).
 */
export function renderFootstep(surface: Surface, heavy: boolean, seed: number, sr: number): F32 {
  const r = makeRng(seed * 7919 + SURFACES.indexOf(surface) * 131 + (heavy ? 17 : 0) + 1);
  const dur = surface === 'metal' ? (heavy ? 0.95 : 0.72) : heavy ? 0.5 : 0.36;
  const out = f32(dur * sr);
  const heel = 0.004;
  const toe = heel + (heavy ? rand(r, 0.085, 0.13) : rand(r, 0.05, 0.085));
  const v = (): number => rand(r, 0.88, 1.12);
  const grit = (from: number, to: number, count: number, lo: number, hi: number, g: number): void => {
    for (let k = 0; k < count; k++) {
      burst(out, sr, rand(r, from, to), r, { kind: 'bandpass', f: rand(r, lo, hi), q: 1.5, tau: rand(r, 0.001, 0.004), gain: g * rand(r, 0.25, 1) });
    }
  };

  switch (surface) {
    case 'concrete':
      if (!heavy) {
        thump(out, sr, heel, { f0: 210 * v(), f1: 140 * v(), pitchTau: 0.012, tau: 0.014, gain: 0.16 });
        burst(out, sr, heel, r, { kind: 'bandpass', f: 480 * v(), q: 1.2, tau: 0.012, gain: 2.2 });
        burst(out, sr, heel, r, { kind: 'bandpass', f: 1300 * v(), q: 0.9, tau: 0.008, gain: 1.8 });
        burst(out, sr, heel, r, { kind: 'highpass', f: 3200, tau: 0.0025, gain: 0.3 });
        burst(out, sr, toe, r, { kind: 'bandpass', f: 1900 * v(), q: 0.8, tau: 0.012, gain: 1.1 });
        burst(out, sr, toe, r, { kind: 'bandpass', f: 620 * v(), q: 1, tau: 0.01, gain: 0.5 });
        burst(out, sr, toe, r, { kind: 'bandpass', f: 2900, q: 0.7, tau: 0.03, gain: 0.2, attack: 0.012 });
        new Biquad(sr).lowpass(7500, 0.7071).run(out); // flats, not heels: a soft sole
      } else {
        thump(out, sr, heel, { f0: 118 * v(), f1: 66 * v(), pitchTau: 0.02, tau: 0.042, gain: 0.5, drive: 1.3 });
        burst(out, sr, heel, r, { kind: 'bandpass', f: 320 * v(), q: 1, tau: 0.03, gain: 1.6 });
        burst(out, sr, heel, r, { kind: 'bandpass', f: 780 * v(), q: 0.8, tau: 0.016, gain: 2.2 });
        burst(out, sr, heel, r, { kind: 'lowpass', f: 300, tau: 0.03, gain: 1.5, passes: 2 });
        grit(heel + 0.005, toe + 0.06, 6, 1800, 4200, 0.4);
        burst(out, sr, toe, r, { kind: 'bandpass', f: 1050 * v(), q: 0.8, tau: 0.022, gain: 1.2 });
        thump(out, sr, toe, { f0: 135, f1: 88, pitchTau: 0.02, tau: 0.022, gain: 0.16 });
      }
      break;

    case 'asphalt':
      if (!heavy) {
        thump(out, sr, heel, { f0: 170 * v(), f1: 110 * v(), pitchTau: 0.014, tau: 0.018, gain: 0.15 });
        burst(out, sr, heel, r, { kind: 'bandpass', f: 380 * v(), q: 1, tau: 0.016, gain: 1.3 });
        burst(out, sr, heel, r, { kind: 'bandpass', f: 760 * v(), q: 0.7, tau: 0.013, gain: 2 });
        grit(heel + 0.003, toe + 0.05, 9, 2200, 5200, 0.5);
        burst(out, sr, toe, r, { kind: 'bandpass', f: 1100 * v(), q: 0.7, tau: 0.016, gain: 1 });
      } else {
        thump(out, sr, heel, { f0: 105 * v(), f1: 60 * v(), pitchTau: 0.022, tau: 0.045, gain: 0.5, drive: 1.3 });
        burst(out, sr, heel, r, { kind: 'bandpass', f: 260 * v(), q: 1, tau: 0.032, gain: 1.6 });
        burst(out, sr, heel, r, { kind: 'bandpass', f: 520 * v(), q: 0.7, tau: 0.02, gain: 2.2 });
        burst(out, sr, heel, r, { kind: 'lowpass', f: 260, tau: 0.03, gain: 1.4, passes: 2 });
        grit(heel + 0.004, toe + 0.09, 14, 1600, 4600, 0.55);
        burst(out, sr, toe, r, { kind: 'bandpass', f: 760 * v(), q: 0.7, tau: 0.026, gain: 1.2 });
      }
      new Biquad(sr).lowpass(5600, 0.7071).run(out);
      break;

    case 'metal': {
      const ringScale = heavy ? 1.4 : 1;
      const partials = (lowCut: number, tilt: number): Partial[] =>
        GRATE_PARTIALS.filter((_, k) => k >= lowCut).map((p, k) => ({
          f: p.f * (heavy ? 0.94 : 1) * rand(r, 0.97, 1.03),
          tau: p.tau * ringScale * rand(r, 0.85, 1.15),
          a: p.a * rand(r, 0.6, 1.2) * Math.pow(tilt, k),
        }));
      strike(out, sr, heel, partials(0, 1), heavy ? 0.2 : 0.13);
      thump(out, sr, heel, { f0: (heavy ? 120 : 150) * v(), f1: heavy ? 70 : 95, pitchTau: 0.02, tau: heavy ? 0.05 : 0.03, gain: heavy ? 0.9 : 0.42 });
      burst(out, sr, heel, r, { kind: 'bandpass', f: heavy ? 1500 : 2400, q: 0.8, tau: 0.004, gain: 0.5 });
      // the void under the grate answers
      burst(out, sr, heel, r, { kind: 'bandpass', f: 175, q: 4, tau: 0.05, gain: heavy ? 1.4 : 0.8 });
      // loose bars chatter
      for (let k = 0, c = 2 + Math.floor(r() * 2); k < c; k++) {
        strike(out, sr, heel + rand(r, 0.02, 0.09), partials(4, 1), rand(r, 0.02, 0.05));
      }
      strike(out, sr, toe, partials(1, 1.08), heavy ? 0.1 : 0.06);
      burst(out, sr, toe, r, { kind: 'bandpass', f: 3000, q: 0.8, tau: 0.005, gain: 0.22 });
      break;
    }

    case 'tile': {
      const dry = f32(out.length);
      if (!heavy) {
        burst(dry, sr, heel, r, { kind: 'bandpass', f: 2500 * v(), q: 1.2, tau: 0.005, gain: 2.2 });
        burst(dry, sr, heel, r, { kind: 'bandpass', f: 700 * v(), q: 1.2, tau: 0.008, gain: 0.9 });
        thump(dry, sr, heel, { f0: 250 * v(), f1: 170, pitchTau: 0.008, tau: 0.009, gain: 0.1 });
        burst(dry, sr, heel, r, { kind: 'highpass', f: 5000, tau: 0.0015, gain: 0.45 });
        burst(dry, sr, toe, r, { kind: 'bandpass', f: 3100 * v(), q: 1.1, tau: 0.007, gain: 0.9 });
      } else {
        burst(dry, sr, heel, r, { kind: 'bandpass', f: 1500 * v(), q: 1.1, tau: 0.009, gain: 2.4 });
        burst(dry, sr, heel, r, { kind: 'bandpass', f: 420 * v(), q: 1, tau: 0.02, gain: 1.4 });
        thump(dry, sr, heel, { f0: 150 * v(), f1: 85, pitchTau: 0.015, tau: 0.03, gain: 0.4, drive: 1.2 });
        burst(dry, sr, heel, r, { kind: 'lowpass', f: 320, tau: 0.02, gain: 1.2, passes: 2 });
        burst(dry, sr, toe, r, { kind: 'bandpass', f: 1900 * v(), q: 1, tau: 0.012, gain: 1.2 });
        burst(dry, sr, toe + 0.02, r, { kind: 'bandpass', f: 3600, q: 3, tau: 0.03, gain: 0.12, attack: 0.01 }); // rubber on glazed tile
      }
      // hard little room: the shop's close walls
      const wet = echoes(dry, sr, [
        { t: 0.011, g: 0.24, lp: 6000 },
        { t: 0.019, g: 0.17, lp: 4500 },
        { t: 0.031, g: 0.11, lp: 3500 },
        { t: 0.047, g: 0.07, lp: 2500 },
        { t: 0.068, g: 0.04, lp: 1800 },
      ]);
      mixInto(out, wet);
      break;
    }
  }
  return finish([out], sr, { peak: 0.8, fadeIn: 0.0005, fadeOut: 0.03, hp: heavy ? 35 : 60 })[0];
}

/* ============================================================= heartbeat */

/** The two heart sounds. Sub-heavy: meant to be felt more than heard. */
export function renderHeart(sr: number): { lub: F32; dub: F32 } {
  const make = (f0: number, f1: number, tau: number, noise: number, seed: number): F32 => {
    const r = makeRng(seed);
    const out = f32(0.36 * sr);
    thump(out, sr, 0.004, { f0, f1, pitchTau: 0.035, tau, gain: 1, attack: 0.006, drive: 1.6 });
    thump(out, sr, 0.004, { f0: f0 * 2.02, f1: f1 * 2, pitchTau: 0.025, tau: tau * 0.6, gain: 0.22, attack: 0.006 });
    burst(out, sr, 0.002, r, { kind: 'lowpass', f: 160, tau: tau * 0.5, gain: noise, attack: 0.004, passes: 2 });
    const lp = filtered(out, sr, 'lowpass', 340, 0.7071, 2);
    return finish([lp], sr, { peak: 0.9, hp: 18, fadeIn: 0.001, fadeOut: 0.05 })[0];
  };
  return { lub: make(66, 40, 0.07, 1.6, 2101), dub: make(84, 50, 0.045, 1.0, 2102) };
}

/* ==================================================== impulse responses */

/** Short, dark, close room: the inside of her head. Stereo. */
export function renderThoughtIR(sr: number): [F32, F32] {
  const r = makeRng(3101);
  const make = (offset: number): F32 => {
    const n = Math.round(0.42 * sr);
    const ir = f32(n);
    const pre = Math.round((0.007 + offset) * sr);
    for (let i = pre; i < n; i++) ir[i] = (r() * 2 - 1) * Math.exp(-(i - pre) / (0.05 * sr)) * 0.5;
    for (const [t, g] of [[0.009, 0.9], [0.015, -0.6], [0.023, 0.45]] as const) ir[Math.round((t + offset) * sr)] += g;
    new Biquad(sr).lowpass(4200, 0.7071).run(ir);
    new Biquad(sr).highpass(250, 0.7071).run(ir);
    return ir;
  };
  return [make(0), make(0.0013)];
}

/** Street canyon: hard slaps off the building fronts and a thin diffuse tail. Stereo. */
export function renderStreetIR(sr: number): [F32, F32] {
  const r = makeRng(3202);
  const make = (taps: readonly (readonly [number, number])[]): F32 => {
    const n = Math.round(0.95 * sr);
    const ir = f32(n);
    for (const [t, g] of taps) {
      const at = Math.round(t * sr);
      for (let k = 0; k < 6; k++) ir[at + k] += g * (r() * 2 - 1) * (1 - k / 6) + (k === 0 ? g : 0);
    }
    const start = Math.round(0.03 * sr);
    for (let i = start; i < n; i++) ir[i] += (r() * 2 - 1) * Math.exp(-(i - start) / (0.12 * sr)) * 0.1;
    new Biquad(sr).lowpass(3000, 0.7071).run(ir);
    new Biquad(sr).highpass(220, 0.7071).run(ir);
    for (let i = 0; i < 0.05 * sr; i++) ir[n - 1 - i] *= i / (0.05 * sr);
    return ir;
  };
  return [
    make([[0.013, 0.5], [0.052, 0.3], [0.089, 0.42], [0.151, 0.2], [0.23, 0.1]]),
    make([[0.009, 0.6], [0.047, 0.25], [0.094, 0.38], [0.16, 0.18], [0.25, 0.09]]),
  ];
}
