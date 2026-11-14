/**
 * Streamed speech. Each line is an HTMLAudioElement (so playback starts as
 * soon as the first bytes arrive) routed into the graph: positional on the
 * voice bus, or straight into the thought bus for her inner voice.
 */

import type { SpeakOptions, SpeechHandle } from '../contracts';
import { clamp01, smoothstep } from './dsp';
import { SPATIAL_VOICE, distanceLowpass, type Graph, type Vec3 } from './graph';

/** Give up if nothing has started playing after this long (ms). */
const START_TIMEOUT_MS = 9000;
/** Give up if playback has started but made no progress for this long (ms). */
const STALL_TIMEOUT_MS = 7000;

interface Line {
  bus: 'voice' | 'thought';
  el: HTMLAudioElement;
  analyser: AnalyserNode;
  data: Float32Array<ArrayBuffer>;
  gain: GainNode;
  panner: PannerNode | null;
  lp: BiquadFilterNode | null;
  prox: BiquadFilterNode | null;
  nodes: AudioNode[];
  position: (() => Vec3) | undefined;
  onLevel: ((level: number) => void) | undefined;
  level: number;
  startedAt: number;
  started: boolean;
  lastProgressAt: number;
  lastTime: number;
  lastLp: number;
  finished: boolean;
  finish: () => void;
}

const DONE: SpeechHandle = { done: Promise.resolve(), stop() {} };

export class Speech {
  private readonly lines = new Set<Line>();
  private thoughtsPlaying = 0;

  constructor(private readonly g: Graph) {}

  get count(): number {
    return this.lines.size;
  }

  speak(url: string, opts: SpeakOptions): SpeechHandle {
    if (!url) return DONE;
    const g = this.g;
    const ctx = g.ctx;
    let line: Line;
    let resolve!: () => void;
    const done = new Promise<void>((res) => (resolve = res));

    try {
      const el = new Audio();
      el.preload = 'auto';
      const src = ctx.createMediaElementSource(el);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0;
      const gain = ctx.createGain();
      gain.gain.value = Math.max(0, opts.volume ?? 1);
      src.connect(analyser);
      src.connect(gain);
      const nodes: AudioNode[] = [src, analyser, gain];
      let panner: PannerNode | null = null;
      let lp: BiquadFilterNode | null = null;
      let prox: BiquadFilterNode | null = null;
      const bus = opts.bus === 'thought' ? 'thought' : 'voice';
      const position = bus === 'voice' ? opts.position : undefined;

      if (position) {
        let p: Vec3 = g.listenerPos;
        try {
          p = position();
        } catch {
          /* speaker not ready: start at the listener */
        }
        const d = g.distanceTo(p);
        // proximity: a voice right at your shoulder gains chest and weight
        prox = ctx.createBiquadFilter();
        prox.type = 'lowshelf';
        prox.frequency.value = 220;
        prox.gain.value = proximityDb(d);
        lp = g.makeDistanceFilter(d, SPATIAL_VOICE);
        panner = g.makePanner(p, SPATIAL_VOICE);
        gain.connect(prox).connect(lp).connect(panner).connect(g.inputs.voice);
        nodes.push(prox, lp, panner);
      } else {
        gain.connect(g.inputs[bus]);
      }

      const wall = performance.now();
      line = {
        bus,
        el,
        analyser,
        data: new Float32Array(analyser.fftSize),
        gain,
        panner,
        lp,
        prox,
        nodes,
        position,
        onLevel: opts.onLevel,
        level: 0,
        startedAt: wall,
        started: false,
        lastProgressAt: wall,
        lastTime: 0,
        lastLp: lp ? lp.frequency.value : 0,
        finished: false,
        finish: () => {
          if (line.finished) return;
          line.finished = true;
          this.lines.delete(line);
          if (line.bus === 'thought' && line.started) {
            this.thoughtsPlaying = Math.max(0, this.thoughtsPlaying - 1);
            if (this.thoughtsPlaying === 0) g.setThoughtDuck(false);
          }
          el.onended = el.onerror = el.onplaying = null;
          // a few ms of fade so a stop mid-word does not click, then release everything
          try {
            gain.gain.setTargetAtTime(0, ctx.currentTime, 0.008);
          } catch {
            /* context closed */
          }
          window.setTimeout(() => {
            try {
              el.pause();
              el.removeAttribute('src');
              el.load();
            } catch {
              /* fine */
            }
            for (const n of nodes) {
              try {
                n.disconnect();
              } catch {
                /* fine */
              }
            }
          }, 60);
          try {
            line.onLevel?.(0);
          } catch (err) {
            console.error(err);
          }
          resolve();
        },
      };

      el.onplaying = () => {
        if (line.finished || line.started) return;
        line.started = true;
        line.lastProgressAt = performance.now();
        if (line.bus === 'thought') {
          this.thoughtsPlaying++;
          g.setThoughtDuck(true);
        }
      };
      el.onended = line.finish;
      el.onerror = line.finish;
      this.lines.add(line);
      el.src = url;
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
      const p = el.play();
      if (p && typeof p.catch === 'function') p.catch(line.finish);
    } catch (err) {
      // never let a failed line take the scene down with it
      console.warn('speak() failed', err);
      resolve();
      return { done, stop() {} };
    }

    return { done, stop: () => line.finish() };
  }

  stopAll(): void {
    for (const l of [...this.lines]) l.finish();
  }

  /** Per-frame: move panners with their speakers, report levels, run the watchdogs. */
  frame(): void {
    if (this.lines.size === 0) return;
    const g = this.g;
    const wall = performance.now();
    const now = g.ctx.currentTime;
    for (const l of [...this.lines]) {
      // watchdogs: a line must never hang the scene
      if (!l.started) {
        if (wall - l.startedAt > START_TIMEOUT_MS) {
          l.finish();
          continue;
        }
      } else {
        const t = l.el.currentTime;
        if (t !== l.lastTime) {
          l.lastTime = t;
          l.lastProgressAt = wall;
        } else if (l.el.ended || wall - l.lastProgressAt > STALL_TIMEOUT_MS) {
          l.finish();
          continue;
        }
      }

      if (l.panner && l.position) {
        try {
          const p = l.position();
          g.movePanner(l.panner, p);
          const d = g.distanceTo(p);
          const f = distanceLowpass(d, SPATIAL_VOICE);
          if (l.lp && Math.abs(f - l.lastLp) > l.lastLp * 0.04) {
            l.lp.frequency.setTargetAtTime(f, now, 0.1);
            l.lastLp = f;
          }
          l.prox?.gain.setTargetAtTime(proximityDb(d), now, 0.15);
        } catch {
          /* the speaker was disposed mid-line: keep the last position */
        }
      }

      if (l.onLevel) {
        l.analyser.getFloatTimeDomainData(l.data);
        let sum = 0;
        for (let i = 0; i < l.data.length; i++) sum += l.data[i] * l.data[i];
        const rms = Math.sqrt(sum / l.data.length);
        // speech RMS sits around 0.03-0.2: map that onto a usable 0..1 mouth opening
        const target = Math.pow(clamp01(rms * 5.5), 0.7);
        l.level += (target - l.level) * (target > l.level ? 0.65 : 0.28);
        if (l.level < 0.004) l.level = 0;
        try {
          l.onLevel(l.level);
        } catch (err) {
          console.error(err);
          l.onLevel = undefined;
        }
      }
    }
  }
}

function proximityDb(d: number): number {
  return 5 * (1 - smoothstep(0.45, 1.7, d));
}
