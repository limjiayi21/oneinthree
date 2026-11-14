/**
 * Her body, heard from inside: the heartbeat and the breath. Both are
 * synthesised live on the self bus and scheduled ahead of the audio clock, so
 * timing is sample-accurate and tempo / intensity glide instead of jumping.
 */

import { clamp, clamp01, lerp, mixInto, makeRng, peakOf, pink, scale, smoothstep, white } from './dsp';
import { BUTTERWORTH_DB, bufferFrom, type Graph, type Voice } from './graph';
import { renderHeart } from './synth';

/** Peak of the heartbeat on the self bus at volume 1 is about 0.9 x this. */
const HEART_LEVEL = 0.46;
const BREATH_LEVEL = 1.3;

export class Body {
  /* ---- heartbeat */
  private readonly hbIn: GainNode;
  private readonly hbLp: BiquadFilterNode;
  private readonly hbGain: GainNode;
  private lub: AudioBuffer | null = null;
  private dub: AudioBuffer | null = null;
  private bpm = 62;
  private targetBpm = 62;
  private hbVolume = 0;
  private hbZeroAt = 0;
  private nextBeat = 0;
  private readonly pendingBeats = new Set<AudioBufferSourceNode>();
  /** Audio-clock times of the most recent "lub"s (for tests). */
  readonly beatLog: number[] = [];

  /* ---- breathing */
  private readonly f1: BiquadFilterNode;
  private readonly f2: BiquadFilterNode;
  private readonly g3: GainNode;
  private readonly gHiss: GainNode;
  private readonly env: GainNode;
  private readonly tremDepth: GainNode;
  private readonly brOut: GainNode;
  private readonly brNodes: AudioNode[] = [];
  private readonly brSources: AudioScheduledSourceNode[] = [];
  private breath = 0;
  private brNext = 0;
  private brPhase: 'in' | 'out' = 'in';
  private brFile: AudioBuffer | null = null;
  private brFileTrim = 1;
  private brFileVoice: Voice | null = null;

  constructor(private readonly g: Graph) {
    const ctx = g.ctx;

    this.hbIn = ctx.createGain();
    this.hbLp = ctx.createBiquadFilter();
    this.hbLp.type = 'lowpass';
    this.hbLp.frequency.value = 75;
    this.hbLp.Q.value = BUTTERWORTH_DB;
    this.hbGain = ctx.createGain();
    this.hbGain.gain.value = 0;
    this.hbIn.connect(this.hbLp).connect(this.hbGain).connect(g.inputs.self);

    // breath: looped turbulence -> formant band-passes -> breath envelope -> tremor -> level
    const sr = ctx.sampleRate;
    const r = makeRng(4242);
    const n = 3 * sr;
    const noise = white(n, r, 0.6);
    mixInto(noise, pink(n, r), 0, 3.2);
    scale(noise, 0.9 / Math.max(1e-6, peakOf(noise)));
    const src = ctx.createBufferSource();
    src.buffer = bufferFrom([noise], sr);
    src.loop = true;

    const bp = (f: number, q: number): BiquadFilterNode => {
      const b = ctx.createBiquadFilter();
      b.type = 'bandpass';
      b.frequency.value = f;
      b.Q.value = q;
      return b;
    };
    const gain = (v: number): GainNode => {
      const x = ctx.createGain();
      x.gain.value = v;
      return x;
    };
    this.f1 = bp(1200, 2.2);
    this.f2 = bp(2000, 3);
    const f3 = bp(3100, 4);
    const hiss = ctx.createBiquadFilter();
    hiss.type = 'highpass';
    hiss.frequency.value = 3200;
    hiss.Q.value = BUTTERWORTH_DB;
    const g1 = gain(1), g2 = gain(0.8);
    this.g3 = gain(0.2);
    this.gHiss = gain(0.03);
    this.env = gain(0);
    const trem = gain(1);
    this.tremDepth = gain(0);
    this.brOut = gain(0);
    src.connect(this.f1).connect(g1).connect(this.env);
    src.connect(this.f2).connect(g2).connect(this.env);
    src.connect(f3).connect(this.g3).connect(this.env);
    src.connect(hiss).connect(this.gHiss).connect(this.env);
    this.env.connect(trem).connect(this.brOut).connect(g.inputs.self);
    // the tremor of fear: two slow oscillators beating against each other
    const lfoA = ctx.createOscillator(), lfoB = ctx.createOscillator();
    lfoA.frequency.value = 8.7;
    lfoB.frequency.value = 11.9;
    const mixB = gain(0.5);
    lfoA.connect(this.tremDepth);
    lfoB.connect(mixB).connect(this.tremDepth);
    this.tremDepth.connect(trem.gain);
    src.start();
    lfoA.start();
    lfoB.start();
    this.brSources.push(src, lfoA, lfoB);
    this.brNodes.push(this.f1, this.f2, f3, hiss, g1, g2, this.g3, this.gHiss, this.env, trem, this.tremDepth, this.brOut, mixB, this.hbIn, this.hbLp, this.hbGain);
  }

  /** Use a recorded shaky-breath loop (if the asset exists) for the top of the range (level > 0.6). */
  setBreathFile(buffer: AudioBuffer | null, trim = 1): void {
    this.brFile = buffer;
    this.brFileTrim = trim;
  }

  get state(): { bpm: number; targetBpm: number; heartVolume: number; breathing: number } {
    return { bpm: this.bpm, targetBpm: this.targetBpm, heartVolume: this.hbVolume, breathing: this.breath };
  }

  /* ------------------------------------------------------------ heartbeat */

  setHeartbeat(bpm: number, volume: number): void {
    if (Number.isFinite(bpm)) this.targetBpm = clamp(bpm, 40, 190);
    const v = Number.isFinite(volume) ? clamp01(volume) : 0;
    if (Math.abs(v - this.hbVolume) < 0.004 && (v === 0) === (this.hbVolume === 0)) return;
    const now = this.g.ctx.currentTime;
    if (v === 0) this.hbZeroAt = now;
    this.hbVolume = v;
    // quiet = only the sub survives (felt, not heard); loud = the knock opens up
    this.hbGain.gain.setTargetAtTime(Math.pow(v, 1.5) * HEART_LEVEL, now, 0.3);
    this.hbLp.frequency.setTargetAtTime(75 + 230 * v, now, 0.3);
  }

  private pumpHeart(now: number, horizon: number): void {
    if (this.hbVolume <= 0) {
      // let the fade-out finish on the beat, then idle
      if (this.nextBeat === 0 || now - this.hbZeroAt > 1.6) {
        this.nextBeat = 0;
        return;
      }
    }
    if (!this.lub || !this.dub) {
      const h = renderHeart(this.g.ctx.sampleRate);
      this.lub = bufferFrom([h.lub], this.g.ctx.sampleRate);
      this.dub = bufferFrom([h.dub], this.g.ctx.sampleRate);
    }
    if (this.nextBeat === 0 || this.nextBeat < now - 1) {
      this.nextBeat = now + 0.05;
      this.bpm = this.targetBpm;
    }
    while (this.nextBeat < now + horizon) {
      const t = Math.max(this.nextBeat, now + 0.005);
      const period = 60 / this.bpm;
      const rate = 1 + ((this.bpm - 60) / 90) * 0.16;
      const amp = 0.9 + Math.random() * 0.2;
      this.beat(this.lub, t, rate, amp);
      // systole shortens as the heart speeds up, but not in proportion
      this.beat(this.dub, t + 0.115 + 0.19 * period, rate * 1.02, amp * 0.72);
      this.beatLog.push(t);
      if (this.beatLog.length > 64) this.beatLog.shift();
      this.bpm += (this.targetBpm - this.bpm) * (1 - Math.exp(-period / 0.8));
      this.nextBeat = t + period * (1 + (Math.random() * 2 - 1) * 0.012);
    }
  }

  private beat(buffer: AudioBuffer, at: number, rate: number, amp: number): void {
    const ctx = this.g.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const gn = ctx.createGain();
    gn.gain.value = amp;
    src.connect(gn).connect(this.hbIn);
    this.pendingBeats.add(src);
    src.onended = () => {
      this.pendingBeats.delete(src);
      src.disconnect();
      gn.disconnect();
    };
    src.start(at);
  }

  /* ------------------------------------------------------------ breathing */

  setBreathing(level: number): void {
    const l = Number.isFinite(level) ? clamp01(level) : 0;
    if (Math.abs(l - this.breath) < 0.004 && (l === 0) === (this.breath === 0)) return;
    this.breath = l;
    const now = this.g.ctx.currentTime;
    const shake = smoothstep(0.5, 0.95, l);
    // with a recorded loop available, the synthesised breath hands over to it completely near the
    // top of the range (two breathing rhythms at once would read as two people)
    const fileMix = this.brFile ? smoothstep(0.6, 0.85, l) : 0;
    this.brOut.gain.setTargetAtTime(Math.pow(l, 1.1) * BREATH_LEVEL * (1 - fileMix), now, 0.35);
    this.tremDepth.gain.setTargetAtTime(shake * 0.38, now, 0.4);
    if (this.brFile) {
      if (fileMix > 0 && (!this.brFileVoice || this.brFileVoice.ended)) {
        this.brFileVoice = this.g.play(this.brFile, { bus: 'self', loop: true, volume: 0 });
      }
      if (this.brFileVoice && !this.brFileVoice.ended) {
        if (l < 0.55) {
          this.brFileVoice.stop(0.6);
          this.brFileVoice = null;
        } else {
          this.brFileVoice.setVolume(fileMix * Math.pow(l, 1.1) * this.brFileTrim, 0.35);
        }
      }
    }
  }

  private pumpBreath(now: number, horizon: number): void {
    const l = this.breath;
    if (l <= 0.01) {
      this.brNext = 0;
      return;
    }
    if (this.brNext === 0 || this.brNext < now - 2) {
      this.brNext = now + 0.08;
      this.brPhase = 'in';
    }
    while (this.brNext < now + horizon) {
      const t0 = Math.max(this.brNext, now + 0.01);
      const mouth = smoothstep(0.3, 0.7, l);
      const shake = smoothstep(0.5, 0.95, l);
      // 12 breaths a minute at rest, about 42 when terrified
      const period = 60 / (12 + 30 * Math.pow(l, 1.2));
      const jitter = 1 + (Math.random() * 2 - 1) * (0.06 + 0.1 * shake);
      const inhale = this.brPhase === 'in';
      const dur = period * (inhale ? 0.38 : 0.44) * jitter;
      const gap = period * (inhale ? 0.06 : 0.12 * (1 + Math.random() * 0.5));
      this.breathPhase(inhale, t0, dur, mouth, shake);
      this.brNext = t0 + dur + gap;
      this.brPhase = inhale ? 'out' : 'in';
    }
  }

  private breathPhase(inhale: boolean, t0: number, dur: number, mouth: number, shake: number): void {
    // nose: narrow and high. mouth: open and lower. in: brightening. out: darkening.
    const f1a = inhale ? lerp(1500, 950, mouth) : lerp(900, 720, mouth);
    const f2a = inhale ? lerp(2600, 1700, mouth) : lerp(1500, 1350, mouth);
    const end = t0 + dur;
    try {
      this.f1.frequency.setValueAtTime(f1a, t0);
      this.f1.frequency.linearRampToValueAtTime(f1a * (inhale ? 1.25 : 0.78), end);
      this.f2.frequency.setValueAtTime(f2a, t0);
      this.f2.frequency.linearRampToValueAtTime(f2a * (inhale ? 1.3 : 0.8), end);
      this.g3.gain.setValueAtTime(inhale ? lerp(0.15, 0.45, mouth) : lerp(0.08, 0.3, mouth), t0);
      this.gHiss.gain.setValueAtTime(inhale ? lerp(0.03, 0.1, mouth) : 0.01, t0);

      const amp = (inhale ? 1 : 0.8) * lerp(0.5, 1, mouth) * (0.9 + Math.random() * 0.2);
      const catches: number[] = [];
      if (inhale && shake > 0.35) {
        catches.push(0.3 + Math.random() * 0.15);
        if (Math.random() < 0.6 * shake) catches.push(0.6 + Math.random() * 0.15);
      }
      const N = 64;
      const curve = new Float32Array(N);
      for (let i = 1; i < N - 1; i++) {
        const x = i / (N - 1);
        let e = inhale ? Math.pow(Math.sin(Math.PI * Math.pow(x, 1.25)), 0.85) : Math.pow(x, 0.35) * Math.pow(1 - x, 1.4) * 2.2;
        for (const c of catches) e *= 1 - 0.8 * shake * Math.exp(-Math.pow((x - c) / 0.04, 2));
        curve[i] = e * amp;
      }
      this.env.gain.setValueCurveAtTime(curve, t0, dur);
    } catch {
      /* an overlapping automation event: skip this breath rather than throw */
    }
  }

  /* --------------------------------------------------------------- shared */

  /** Schedule everything due before `now + horizon`. Call often (it is idempotent). */
  pump(now: number, horizon: number): void {
    this.pumpHeart(now, horizon);
    this.pumpBreath(now, horizon);
  }

  /** Stop heart and breath at once and forget their targets. */
  silence(): void {
    const now = this.g.ctx.currentTime;
    this.hbVolume = 0;
    this.hbZeroAt = now - 10;
    this.nextBeat = 0;
    this.breath = 0;
    this.brNext = 0;
    for (const src of [...this.pendingBeats]) {
      try {
        src.stop();
      } catch {
        /* not started yet */
      }
    }
    for (const p of [this.hbGain.gain, this.brOut.gain, this.env.gain, this.tremDepth.gain]) {
      try {
        p.cancelScheduledValues(now);
        p.setValueAtTime(0, now);
      } catch {
        /* fine */
      }
    }
    if (this.brFileVoice) {
      this.brFileVoice.stop(0.01);
      this.brFileVoice = null;
    }
  }

  dispose(): void {
    this.silence();
    for (const s of this.brSources) {
      try {
        s.stop();
        s.disconnect();
      } catch {
        /* fine */
      }
    }
    for (const n of this.brNodes) {
      try {
        n.disconnect();
      } catch {
        /* fine */
      }
    }
  }
}
