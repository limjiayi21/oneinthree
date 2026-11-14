/**
 * The mixing graph: buses, master chain, listener, and buffer playback.
 *
 *   world   ambience + positional SFX + other people's footsteps
 *           (street reverb send, tunnel-hearing muffle, ducked under thoughts)
 *   voice   other people speaking, positional; never muffled
 *   self    her own body: footsteps, breath, heartbeat, cloth; close, no panning
 *   thought her inner voice: band-limited, dry + short dark room
 *   direct  the tinnitus tone only: survives cutToSilence()
 *
 *   buses -> sum -> limiter -> soft clip -> master gain -> (test mute) -> destination
 */

import { renderStreetIR, renderThoughtIR } from './synth';
import type { F32 } from './dsp';

export type BusName = 'world' | 'voice' | 'self' | 'thought';
export type PlayBus = BusName | 'worldDry' | 'direct';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** How a positional source falls off with distance. */
export interface Spatial {
  /** Distance (m) inside which the source is at full level. */
  ref: number;
  /** Inverse-distance roll-off factor beyond `ref`. */
  rolloff: number;
  /** The distance low-pass never closes below this (Hz). */
  lpFloor?: number;
}

/**
 * For Web Audio low-pass / high-pass filters Q is a resonance in decibels, not
 * a quality factor: -3 dB gives the flat (Butterworth) response.
 */
export const BUTTERWORTH_DB = -3.01;

export const SPATIAL_DEFAULT: Spatial = { ref: 2, rolloff: 1 };
/** A voice: close and present at 1 m, clear at 8 m (-14 dB), faint at 25 m (-24 dB). */
export const SPATIAL_VOICE: Spatial = { ref: 1.25, rolloff: 0.8, lpFloor: 2800 };

export interface PlayOptions {
  bus: PlayBus;
  /** Overrides the bus input (e.g. a sub-mix gain that itself feeds a bus). */
  dest?: AudioNode;
  position?: Vec3 | null;
  spatial?: Spatial;
  volume?: number;
  rate?: number;
  loop?: boolean;
  loopStart?: number;
  loopEnd?: number;
  /** -1..1 stereo placement for non-positional sounds. */
  pan?: number;
  /** Start offset into the buffer, seconds. */
  offset?: number;
  /** Play only this many seconds (with a fade-out), for fragments. */
  duration?: number;
  fadeIn?: number;
  /** Audio-clock start time; default now. */
  when?: number;
}

export interface Voice {
  readonly ended: boolean;
  readonly bus: PlayBus;
  /** Fade out over `fade` seconds (default 0.03) and release. */
  stop(fade?: number): void;
  /** Set the level smoothly. */
  setVolume(volume: number, timeConstant?: number): void;
}

interface VoiceImpl extends Voice {
  ended: boolean;
  src: AudioBufferSourceNode;
  gain: GainNode;
  lp: BiquadFilterNode | null;
  position: Vec3 | null;
  spatial: Spatial;
  lastLp: number;
  nodes: AudioNode[];
}

export function bufferFrom(channels: F32[], sampleRate: number): AudioBuffer {
  const buf = new AudioBuffer({ length: Math.max(1, channels[0].length), numberOfChannels: channels.length, sampleRate });
  channels.forEach((ch, i) => buf.copyToChannel(ch, i));
  return buf;
}

/** Cut-off of the "air absorption" low-pass for a source `d` metres away. */
export function distanceLowpass(d: number, s: Spatial): number {
  const x = Math.max(0, d - s.ref);
  return Math.max(s.lpFloor ?? 1500, 20000 * Math.exp(-x / 10));
}

function softClipCurve(): Float32Array<ArrayBuffer> {
  const n = 2049;
  const curve = new Float32Array(n);
  const knee = 0.7;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee));
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}

export class Graph {
  readonly ctx: AudioContext;
  readonly inputs: Record<PlayBus, GainNode>;
  /** Post-fader points for metering. */
  readonly taps: { world: AudioNode; voice: AudioNode; self: AudioNode; thought: AudioNode; master: AudioNode };
  readonly listenerPos: Vec3 = { x: 0, y: 1.62, z: 0 };

  private readonly master: GainNode;
  /** After the master fader and its meter tap: lets tests run with the speakers off. */
  private readonly output: GainNode;
  private readonly kills: Record<BusName, GainNode>;
  private readonly muffleLp: BiquadFilterNode;
  private readonly muffleDuck: GainNode;
  private readonly thoughtDuck: GainNode;
  private readonly voices = new Set<VoiceImpl>();
  private muffle = -1;
  private ducking = false;
  private listenerSet = false;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    const g = (v = 1): GainNode => {
      const n = ctx.createGain();
      n.gain.value = v;
      return n;
    };

    // ---- master chain
    const sum = g();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -4;
    limiter.knee.value = 4;
    limiter.ratio.value = 16;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.2;
    const clip = ctx.createWaveShaper();
    clip.curve = softClipCurve();
    this.master = g();
    this.output = g();
    sum.connect(limiter).connect(clip).connect(this.master).connect(this.output).connect(ctx.destination);

    this.kills = { world: g(), voice: g(), self: g(), thought: g() };
    for (const k of Object.values(this.kills)) k.connect(sum);

    const street = bufferFrom(renderStreetIR(ctx.sampleRate), ctx.sampleRate);
    const convolver = (buf: AudioBuffer): ConvolverNode => {
      const c = ctx.createConvolver();
      c.buffer = buf;
      return c;
    };

    // ---- world: [sfx (+ street reverb) | bed] -> muffle low-pass -> muffle duck -> thought duck -> kill
    const world = g();
    const worldDry = g();
    this.muffleLp = ctx.createBiquadFilter();
    this.muffleLp.type = 'lowpass';
    this.muffleLp.frequency.value = 20000;
    this.muffleLp.Q.value = BUTTERWORTH_DB;
    this.muffleDuck = g();
    this.thoughtDuck = g();
    const worldSend = g(0.2);
    world.connect(this.muffleLp);
    worldDry.connect(this.muffleLp);
    world.connect(worldSend).connect(convolver(street)).connect(this.muffleLp);
    this.muffleLp.connect(this.muffleDuck).connect(this.thoughtDuck).connect(this.kills.world);

    // ---- voice: dry + a touch of the same street, never muffled
    const voice = g(0.85); // a little headroom: a voice at arm's length through HRTF runs hot
    const voiceSend = g(0.08);
    voice.connect(this.kills.voice);
    voice.connect(voiceSend).connect(convolver(street)).connect(this.kills.voice);

    // ---- self: straight through
    const self = g();
    self.connect(this.kills.self);

    // ---- thought: band-limit -> gentle compression -> dry + short dark room
    const thought = g();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 150;
    hp.Q.value = BUTTERWORTH_DB;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 6000;
    lp.Q.value = BUTTERWORTH_DB;
    const warm = ctx.createBiquadFilter();
    warm.type = 'peaking';
    warm.frequency.value = 260;
    warm.Q.value = 0.9;
    warm.gain.value = 2.5;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -26;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.008;
    comp.release.value = 0.2;
    const dry = g(0.9);
    const wet = g(0.3);
    thought.connect(hp).connect(lp).connect(warm).connect(comp);
    comp.connect(dry).connect(this.kills.thought);
    comp.connect(convolver(bufferFrom(renderThoughtIR(ctx.sampleRate), ctx.sampleRate))).connect(wet).connect(this.kills.thought);

    // ---- direct: the tinnitus tone, bypassing every kill switch
    const direct = g();
    direct.connect(sum);

    this.inputs = { world, worldDry, voice, self, thought, direct };
    this.taps = { world: this.kills.world, voice: this.kills.voice, self: this.kills.self, thought: this.kills.thought, master: this.master };

    // Chrome loads its HRTF set lazily and a panner is silent until it arrives: ask for it now.
    const warmup = ctx.createPanner();
    warmup.panningModel = 'HRTF';
    this.setListener(this.listenerPos, { x: 0, y: 0, z: -1 });
    this.listenerSet = false;
  }

  /* -------------------------------------------------------------- listener */

  setListener(p: Vec3, f: Vec3): void {
    if (!Number.isFinite(p.x + p.y + p.z)) return;
    this.listenerPos.x = p.x;
    this.listenerPos.y = p.y;
    this.listenerPos.z = p.z;
    const l = this.ctx.listener;
    const len = Math.hypot(f.x, f.y, f.z);
    const ok = Number.isFinite(len) && len > 1e-6;
    try {
      if (l.positionX) {
        // the first placement jumps; later ones glide over a frame or two (no zipper noise)
        const jump = !this.listenerSet;
        const t = this.ctx.currentTime + 0.04;
        const set = (param: AudioParam, v: number): void => {
          if (jump) param.value = v;
          else param.linearRampToValueAtTime(v, t);
        };
        set(l.positionX, p.x);
        set(l.positionY, p.y);
        set(l.positionZ, p.z);
        if (ok) {
          set(l.forwardX, f.x / len);
          set(l.forwardY, f.y / len);
          set(l.forwardZ, f.z / len);
          if (jump) {
            l.upX.value = 0;
            l.upY.value = 1;
            l.upZ.value = 0;
          }
        }
      } else {
        l.setPosition(p.x, p.y, p.z);
        if (ok) l.setOrientation(f.x / len, f.y / len, f.z / len, 0, 1, 0);
      }
      this.listenerSet = true;
    } catch {
      /* a non-finite value slipped through: skip this frame */
    }
  }

  distanceTo(p: Vec3): number {
    return Math.hypot(p.x - this.listenerPos.x, p.y - this.listenerPos.y, p.z - this.listenerPos.z);
  }

  /** A configured HRTF panner at `p`. */
  makePanner(p: Vec3, s: Spatial): PannerNode {
    const pn = this.ctx.createPanner();
    pn.panningModel = 'HRTF';
    pn.distanceModel = 'inverse';
    pn.refDistance = s.ref;
    pn.rolloffFactor = s.rolloff;
    pn.maxDistance = 10000;
    pn.coneInnerAngle = 360;
    pn.coneOuterAngle = 360;
    this.movePanner(pn, p, true);
    return pn;
  }

  movePanner(pn: PannerNode, p: Vec3, jump = false): void {
    if (!Number.isFinite(p.x + p.y + p.z)) return;
    if (pn.positionX) {
      if (jump) {
        pn.positionX.value = p.x;
        pn.positionY.value = p.y;
        pn.positionZ.value = p.z;
      } else {
        const t = this.ctx.currentTime + 0.04;
        pn.positionX.linearRampToValueAtTime(p.x, t);
        pn.positionY.linearRampToValueAtTime(p.y, t);
        pn.positionZ.linearRampToValueAtTime(p.z, t);
      }
    } else {
      pn.setPosition(p.x, p.y, p.z);
    }
  }

  /** A mono-summing low-pass set for a source at distance `d`. */
  makeDistanceFilter(d: number, s: Spatial): BiquadFilterNode {
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = BUTTERWORTH_DB;
    lp.frequency.value = distanceLowpass(d, s);
    lp.channelCount = 1;
    lp.channelCountMode = 'explicit';
    return lp;
  }

  /* -------------------------------------------------------------- playback */

  play(buffer: AudioBuffer, o: PlayOptions): Voice {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const when = Math.max(now, o.when ?? now);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = Math.min(4, Math.max(0.25, o.rate ?? 1));
    if (o.loop) {
      src.loop = true;
      if (o.loopEnd && o.loopEnd > (o.loopStart ?? 0)) {
        src.loopStart = o.loopStart ?? 0;
        src.loopEnd = o.loopEnd;
      }
    }
    const gain = ctx.createGain();
    const vol = Math.max(0, o.volume ?? 1);
    if (o.fadeIn && o.fadeIn > 0) {
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(vol, when + o.fadeIn);
    } else {
      gain.gain.value = vol;
    }
    src.connect(gain);
    const nodes: AudioNode[] = [src, gain];
    let tail: AudioNode = gain;
    let lp: BiquadFilterNode | null = null;
    const spatial = o.spatial ?? SPATIAL_DEFAULT;
    const position = o.position ? { x: o.position.x, y: o.position.y, z: o.position.z } : null;
    if (position) {
      lp = this.makeDistanceFilter(this.distanceTo(position), spatial);
      const pn = this.makePanner(position, spatial);
      tail.connect(lp).connect(pn);
      nodes.push(lp, pn);
      tail = pn;
    } else if (o.pan && ctx.createStereoPanner) {
      const sp = ctx.createStereoPanner();
      sp.pan.value = Math.min(1, Math.max(-1, o.pan));
      tail.connect(sp);
      nodes.push(sp);
      tail = sp;
    }
    tail.connect(o.dest ?? this.inputs[o.bus]);

    const voice: VoiceImpl = {
      ended: false,
      bus: o.bus,
      src,
      gain,
      lp,
      position,
      spatial,
      lastLp: lp ? lp.frequency.value : 0,
      nodes,
      stop: (fade = 0.03) => {
        if (voice.ended) return;
        const t = ctx.currentTime;
        const f = Math.max(0.005, fade);
        try {
          gain.gain.cancelScheduledValues(t);
          gain.gain.setValueAtTime(gain.gain.value, t);
          gain.gain.linearRampToValueAtTime(0, t + f);
          src.stop(t + f + 0.02);
        } catch {
          release();
        }
      },
      setVolume: (volume: number, timeConstant = 0.05) => {
        if (voice.ended) return;
        gain.gain.setTargetAtTime(Math.max(0, volume), ctx.currentTime, Math.max(0.005, timeConstant));
      },
    };
    const release = (): void => {
      if (voice.ended) return;
      voice.ended = true;
      this.voices.delete(voice);
      for (const n of nodes) {
        try {
          n.disconnect();
        } catch {
          /* fine */
        }
      }
    };
    src.onended = release;
    this.voices.add(voice);

    const offset = Math.max(0, Math.min(o.offset ?? 0, buffer.duration - 0.01));
    src.start(when, offset);
    if (o.duration && o.duration > 0 && !o.loop) {
      const end = when + o.duration;
      const fo = Math.min(0.6, o.duration * 0.3);
      gain.gain.setValueAtTime(vol, end - fo);
      gain.gain.linearRampToValueAtTime(0, end);
      src.stop(end + 0.02);
    }
    return voice;
  }

  /** Per-frame upkeep: distance low-pass of positional voices follows the listener. */
  frame(): void {
    const now = this.ctx.currentTime;
    for (const v of this.voices) {
      if (!v.lp || !v.position) continue;
      const f = distanceLowpass(this.distanceTo(v.position), v.spatial);
      if (Math.abs(f - v.lastLp) > v.lastLp * 0.04) {
        v.lp.frequency.setTargetAtTime(f, now, 0.1);
        v.lastLp = f;
      }
    }
  }

  get voiceCount(): number {
    return this.voices.size;
  }

  /** Stop buffer voices (optionally only those on some buses). */
  stopVoices(fade: number, filter?: (bus: PlayBus) => boolean): void {
    for (const v of [...this.voices]) if (!filter || filter(v.bus)) v.stop(fade);
  }

  /* ----------------------------------------------------------------- mixes */

  /** 0..1 tunnel hearing: the world bus loses its top end and drops a few dB. */
  setMuffle(level: number): void {
    const m = Math.min(1, Math.max(0, level));
    if (Math.abs(m - this.muffle) < 0.004) return;
    this.muffle = m;
    const now = this.ctx.currentTime;
    const cutoff = 20000 * Math.pow(450 / 20000, Math.pow(m, 0.8));
    this.muffleLp.frequency.setTargetAtTime(cutoff, now, 0.22);
    this.muffleDuck.gain.setTargetAtTime(1 - 0.45 * m, now, 0.22);
  }

  /** Duck the world about 4 dB while her inner voice speaks. */
  setThoughtDuck(on: boolean): void {
    if (on === this.ducking) return;
    this.ducking = on;
    this.thoughtDuck.gain.setTargetAtTime(on ? 0.63 : 1, this.ctx.currentTime, on ? 0.07 : 0.28);
  }

  setMaster(volume: number, fade: number): void {
    const now = this.ctx.currentTime;
    const p = this.master.gain;
    const v = Math.min(1.5, Math.max(0, volume));
    p.cancelScheduledValues(now);
    p.setValueAtTime(p.value, now);
    p.linearRampToValueAtTime(v, now + Math.max(0.01, fade));
  }

  /** Test hook: silence the speakers without changing anything the meters see. */
  setOutputMuted(muted: boolean): void {
    this.output.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.01);
  }

  /**
   * Shut world, voice, self and thought within ~8 ms, stop every buffer voice,
   * then re-open the (now empty) buses so later sounds can play: self after
   * 0.15 s, the others after ~1 s.
   */
  cut(): void {
    const now = this.ctx.currentTime;
    for (const [name, k] of Object.entries(this.kills)) {
      // buses with a reverb stay shut until its tail has rung out behind the gate
      const hold = name === 'self' ? 0.15 : 1.05;
      const p = k.gain;
      p.cancelScheduledValues(now);
      p.setValueAtTime(p.value, now);
      p.linearRampToValueAtTime(0, now + 0.008);
      p.setValueAtTime(0, now + hold);
      p.linearRampToValueAtTime(1, now + hold + 0.02);
    }
    this.stopVoices(0.006);
  }
}
