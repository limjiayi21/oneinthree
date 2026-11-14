/**
 * The city at night. Either the generated ambience file, looped, or a live
 * layered bed that never repeats: traffic rumble, far-off "air", an
 * air-conditioner drone and wind, each breathing on its own slow LFOs. On top,
 * unrelated life happens now and then somewhere out in the dark: a car on a
 * cross street, a horn, a fragment of siren, a gust.
 */

import type { Graph, Vec3, Voice } from './graph';

export interface BedBuffers {
  rumble: AudioBuffer;
  air: AudioBuffer;
  drone: AudioBuffer;
  windSource: AudioBuffer;
}

export interface AmbienceSources {
  /** The recorded/generated loop, if the asset exists. */
  file: { buffer: AudioBuffer; trim: number; loopStart: number; loopEnd: number } | null;
  /** The synthesised layers (used when there is no file). */
  bed: BedBuffers | null;
  car: AudioBuffer | null;
  siren: AudioBuffer | null;
  gust: AudioBuffer | null;
  horns: AudioBuffer[];
}

// Layer gains: together the bed sits near -28 dBFS RMS, well under a voice a few metres away.
const RUMBLE = 0.21;
const AIR = 0.105;
const DRONE = 0.04;
const WIND = 0.125;

export class CityAmbience {
  private readonly out: GainNode;
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly nodes: AudioNode[] = [];
  private readonly eventVoices: Voice[] = [];
  private nextEvent = 0;
  private lastSiren = -1e9;
  private stopped = false;

  constructor(
    private readonly g: Graph,
    private readonly src: AmbienceSources,
    private readonly opts: { events: boolean; volume: number },
  ) {
    const ctx = g.ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(g.inputs.worldDry);
    this.nodes.push(this.out);

    const gain = (v: number): GainNode => {
      const n = ctx.createGain();
      n.gain.value = v;
      this.nodes.push(n);
      return n;
    };
    const loop = (buffer: AudioBuffer, loopStart = 0, loopEnd = 0): AudioBufferSourceNode => {
      const s = ctx.createBufferSource();
      s.buffer = buffer;
      s.loop = true;
      if (loopEnd > loopStart) {
        s.loopStart = loopStart;
        s.loopEnd = loopEnd;
      }
      this.sources.push(s);
      return s;
    };
    /** A slow sine added to a parameter. */
    const lfo = (hz: number, depth: number, target: AudioParam): void => {
      const o = ctx.createOscillator();
      o.frequency.value = hz;
      const d = gain(depth);
      o.connect(d).connect(target);
      this.sources.push(o);
    };

    if (src.file) {
      loop(src.file.buffer, src.file.loopStart, src.file.loopEnd).connect(gain(src.file.trim)).connect(this.out);
    } else if (src.bed) {
      const rumble = gain(RUMBLE);
      loop(src.bed.rumble).connect(rumble).connect(this.out);
      lfo(0.07, RUMBLE * 0.3, rumble.gain);
      lfo(0.113, RUMBLE * 0.2, rumble.gain);

      const air = gain(AIR);
      loop(src.bed.air).connect(air).connect(this.out);
      lfo(0.047, AIR * 0.25, air.gain);

      const drone = gain(DRONE);
      const droneSrc = loop(src.bed.drone);
      if (ctx.createStereoPanner) {
        const pan = ctx.createStereoPanner();
        pan.pan.value = -0.45;
        this.nodes.push(pan);
        droneSrc.connect(pan).connect(drone);
      } else {
        droneSrc.connect(drone);
      }
      drone.connect(this.out);

      // wind: pink noise through a band-pass that wanders, level that swells and drops
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 430;
      bp.Q.value = 0.9;
      this.nodes.push(bp);
      const wind = gain(WIND);
      loop(src.bed.windSource).connect(bp).connect(wind).connect(this.out);
      lfo(0.09, 170, bp.frequency);
      lfo(0.23, 80, bp.frequency);
      lfo(0.061, WIND * 0.45, wind.gain);
      lfo(0.171, WIND * 0.25, wind.gain);
    }
  }

  start(fadeIn = 2): void {
    const now = this.g.ctx.currentTime;
    for (const s of this.sources) s.start(now);
    this.out.gain.setValueAtTime(0, now);
    this.out.gain.linearRampToValueAtTime(this.opts.volume, now + Math.max(0.01, fadeIn));
  }

  /** Call often: fires the occasional far-off event. */
  tick(now: number): void {
    if (this.stopped || !this.opts.events) return;
    if (this.nextEvent === 0) this.nextEvent = now + 5 + Math.random() * 7;
    if (now < this.nextEvent) return;
    this.nextEvent = now + 8 + Math.random() * 14;

    const g = this.g;
    const L = g.listenerPos;
    const sign = (): number => (Math.random() < 0.5 ? -1 : 1);
    // somewhere out past the ends of the block or over the rooftops
    const far = (): Vec3 => ({ x: L.x + sign() * (15 + Math.random() * 40), y: 2 + Math.random() * 10, z: L.z + sign() * (40 + Math.random() * 45) });
    const roll = Math.random();
    let v: Voice | null = null;
    if (roll < 0.4 && this.src.car) {
      v = g.play(this.src.car, {
        bus: 'world',
        position: far(),
        spatial: { ref: 30, rolloff: 0.6, lpFloor: 900 },
        volume: 0.14 + Math.random() * 0.14,
        rate: 0.8 + Math.random() * 0.22,
      });
    } else if (roll < 0.72 && this.src.horns.length > 0) {
      v = g.play(this.src.horns[Math.floor(Math.random() * this.src.horns.length)], {
        bus: 'world',
        position: far(),
        spatial: { ref: 40, rolloff: 0.5, lpFloor: 1200 },
        volume: 0.3 + Math.random() * 0.3,
        rate: 0.94 + Math.random() * 0.12,
      });
    } else if (roll < 0.84 && this.src.siren && now - this.lastSiren > 75) {
      this.lastSiren = now;
      const dur = 4.5 + Math.random() * 2.5;
      v = g.play(this.src.siren, {
        bus: 'world',
        position: far(),
        spatial: { ref: 60, rolloff: 0.5, lpFloor: 1200 },
        volume: 0.3,
        offset: Math.random() * Math.max(0, this.src.siren.duration - dur - 3),
        duration: dur,
        fadeIn: 1.5,
        rate: 0.96 + Math.random() * 0.06,
      });
    } else if (this.src.gust) {
      v = g.play(this.src.gust, { bus: 'world', volume: 0.25 + Math.random() * 0.25, rate: 0.85 + Math.random() * 0.3 });
    }
    if (v) {
      this.eventVoices.push(v);
      while (this.eventVoices.length > 0 && this.eventVoices[0].ended) this.eventVoices.shift();
    }
  }

  stop(fade = 1): void {
    if (this.stopped) return;
    this.stopped = true;
    const ctx = this.g.ctx;
    const now = ctx.currentTime;
    const f = Math.max(0.005, fade);
    const p = this.out.gain;
    try {
      p.cancelScheduledValues(now);
      p.setValueAtTime(p.value, now);
      p.linearRampToValueAtTime(0, now + f);
    } catch {
      /* context closed */
    }
    for (const v of this.eventVoices) v.stop(f);
    for (const s of this.sources) {
      try {
        s.stop(now + f + 0.05);
      } catch {
        /* never started */
      }
    }
    window.setTimeout(() => {
      for (const n of [...this.sources, ...this.nodes]) {
        try {
          n.disconnect();
        } catch {
          /* fine */
        }
      }
    }, (f + 0.2) * 1000);
  }
}
