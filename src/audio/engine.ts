/**
 * The audio engine: everything the trainee hears.
 *
 * Web Audio only, no libraries. Sound files are looked for at
 * /audio/sfx/<name>.mp3 (see content/sfx.json); any that are missing or do not
 * decode fall back, per sound, to the procedural versions in synth.ts.
 *
 * Nothing here throws before resume(): calls made earlier are remembered
 * (listener, heartbeat, breathing, muffle, master, ambience, looping sounds)
 * or dropped (one-shots, speech).
 */

import type * as THREE from 'three';
import type { AudioEngine, SfxName, SpeakOptions, SpeechHandle } from '../contracts';
import manifestJson from '../../content/sfx.json';
import { CityAmbience, type AmbienceSources, type BedBuffers } from './ambience';
import { Body } from './body';
import { METER_TAPS, Meters, type MeterReading, type MeterTap } from './debug';
import { Graph, bufferFrom, type PlayBus, type Spatial, type Vec3 } from './graph';
import { Speech } from './speech';
import { SURFACES, SYNTH_NAMES, renderCityBed, renderFootstep, renderHorn, renderSfx, type Rendered, type Surface, type SynthName } from './synth';

/* ------------------------------------------------------------------ tables */

interface ManifestEntry {
  name: string;
  file: string;
  prompt: string;
  durationSeconds: number;
  loop: boolean;
  promptInfluence: number;
}

const MANIFEST = manifestJson as ManifestEntry[];

/** Sounds that loop unless play() is told otherwise. */
const LOOPS: ReadonlySet<SfxName> = new Set<SfxName>(['ambience_city_night', 'ambience_shop_hum', 'breath_shaky']);

/**
 * Played without a position these belong to her own body / her own doorway:
 * they go to the self bus (close, never muffled). Everything else without a
 * position is the world, unspatialised.
 */
const SELF_SOUNDS: ReadonlySet<SfxName> = new Set<SfxName>([
  'gasp',
  'breath_shaky',
  'exhale_relief',
  'cloth_rustle',
  'keys_jingle',
  'phone_camera_start',
  'impact_thud',
  'door_buzz_open',
  'door_close_heavy',
]);

/** Distance behaviour per sound when it is given a position. */
const SPATIAL: Partial<Record<SfxName, Spatial>> = {
  ambience_shop_hum: { ref: 2, rolloff: 1.2 },
  subway_rumble: { ref: 6, rolloff: 0.8, lpFloor: 600 },
  distant_siren: { ref: 80, rolloff: 0.6 }, // already far away by design: place it anywhere
  car_pass: { ref: 8, rolloff: 0.8 },
  trash_can_crash: { ref: 4, rolloff: 0.8 },
  cat_yowl: { ref: 3, rolloff: 0.8 },
  door_buzz_open: { ref: 2.5, rolloff: 1 },
  door_close_heavy: { ref: 3, rolloff: 1 },
  shop_bell: { ref: 2.5, rolloff: 0.9 },
  wind_gust: { ref: 10, rolloff: 0.6 },
};

/** Someone else's footsteps: clear behind you at 8 m, still there at 20. */
const SPATIAL_STEP: Spatial = { ref: 2, rolloff: 0.8, lpFloor: 1800 };

/**
 * What a decoded asset is levelled to, so a generated file sits where the
 * synthesised version did: one-shots by peak, loops by RMS (dBFS).
 */
const FILE_PEAK: Record<SynthName, number> = {
  ambience_shop_hum: 0.5,
  subway_rumble: 0.75,
  distant_siren: 0.45,
  car_pass: 0.7,
  trash_can_crash: 0.88,
  cat_yowl: 0.72,
  door_buzz_open: 0.6,
  door_close_heavy: 0.88,
  keys_jingle: 0.5,
  gasp: 0.6,
  breath_shaky: 0.45,
  exhale_relief: 0.5,
  cloth_rustle: 0.35,
  phone_camera_start: 0.32,
  shop_bell: 0.5,
  tinnitus: 0.085,
  impact_thud: 0.9,
  wind_gust: 0.6,
};
const FILE_LOOP_RMS_DB: Partial<Record<SfxName, number>> = {
  ambience_city_night: -27,
  ambience_shop_hum: -17.5,
  breath_shaky: -24.8,
};
const STEP_PEAK = 0.8;
const STEP_SURFACE_TRIM: Record<Surface, number> = { concrete: 1, asphalt: 0.9, metal: 0.62, tile: 0.95 };
const STEP_VARIANTS = 5;
const HORN_VARIANTS = 3;

/* ------------------------------------------------------------------- types */

interface Sound {
  buffer: AudioBuffer;
  /** Gain that brings the buffer to its mix level. */
  trim: number;
  /** Where a one-shot starts playing (seconds): generated files often open with silence. */
  start: number;
  loopStart: number;
  loopEnd: number;
}

type Handle = { stop(fade?: number): void };
const NO_HANDLE: Handle = { stop() {} };
const DONE: SpeechHandle = { done: Promise.resolve(), stop() {} };

export interface AudioDebugState {
  context: AudioContextState | 'none';
  sampleRate: number;
  loaded: boolean;
  /** True between cutToSilence() and the next startAmbience(). */
  silenced: boolean;
  ambience: boolean;
  voices: number;
  speech: number;
  muffle: number;
  master: number;
  heart: { bpm: number; targetBpm: number; volume: number; beats: number[] };
  breathing: number;
  /** Which version of each sound is in use. */
  sources: Record<string, 'file' | 'synth' | 'pending'>;
  /** How each asset file that loaded is being used: length, level trim, one-shot start and loop points (seconds). */
  files: Record<string, { duration: number; trim: number; start: number; loopStart: number; loopEnd: number }>;
}

/** Test / harness hooks. Exposed as `createAudio().debug` and, in dev builds, as `window.__audio`. */
export interface AudioDebug {
  readonly context: AudioContext | null;
  readonly taps: readonly MeterTap[];
  /** Start the per-bus meters. Resolves true when the sample-exact worklet meters are running. */
  enableMeters(): Promise<boolean>;
  /** Audio-clock time of the newest meter data. */
  now(): number;
  /** RMS / peak / high-frequency reading of a bus over the last `seconds`. */
  read(tap: MeterTap, seconds?: number): MeterReading;
  /** Reading of a bus over everything since audio-clock time `t0`. */
  since(tap: MeterTap, t0: number): MeterReading;
  /** RMS envelope of a bus, one value per 128-sample quantum. */
  envelope(tap: MeterTap, seconds?: number): { dt: number; rms: number[] };
  /** Turn the speakers off (or back on) without affecting any bus or the meters: for silent test runs. */
  muteOutput(muted: boolean): void;
  state(): AudioDebugState;
}

export type DebuggableAudioEngine = AudioEngine & { readonly debug: AudioDebug };

/* ----------------------------------------------------------------- helpers */

const rnd = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);

/** Yield to the event loop without a timer (timers are throttled in background tabs). */
function breathe(): Promise<void> {
  return new Promise((res) => {
    if (typeof MessageChannel === 'undefined') {
      setTimeout(res, 0);
      return;
    }
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      res();
    };
    ch.port2.postMessage(0);
  });
}

function toBuffer(r: Rendered): AudioBuffer {
  return bufferFrom(r.channels, r.sr);
}

function measure(buffer: AudioBuffer): { peak: number; rms: number } {
  let peak = 0, sum = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
      sum += a * a;
    }
  }
  return { peak, rms: Math.sqrt(sum / Math.max(1, buffer.length * buffer.numberOfChannels)) };
}

/** First and last sample index (any channel) louder than `threshold`. first > last when nothing is. */
function soundingRange(buffer: AudioBuffer, threshold: number): { first: number; last: number } {
  let first = buffer.length, last = -1;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < first; i++) {
      if (Math.abs(d[i]) > threshold) {
        first = i;
        break;
      }
    }
    for (let i = d.length - 1; i > last; i--) {
      if (Math.abs(d[i]) > threshold) {
        last = i;
        break;
      }
    }
  }
  return { first, last };
}

/* ------------------------------------------------------------------ engine */

class OitAudio implements AudioEngine {
  private ctx: AudioContext | null = null;
  private graph: Graph | null = null;
  private body: Body | null = null;
  private speech: Speech | null = null;
  private meters: Meters | null = null;
  private ambience: CityAmbience | null = null;
  private decoder: BaseAudioContext | null = null;

  private readonly files = new Map<string, Sound>();
  private readonly synths = new Map<string, Sound>();
  private readonly stepSynths = new Map<string, Sound[]>();
  private readonly lastStep = new Map<string, number>();
  private bed: BedBuffers | null = null;
  private horns: AudioBuffer[] = [];
  private loading: Promise<void> | null = null;
  private loaded = false;

  /** Work to do as soon as the context exists (looping sounds asked for before resume()). */
  private pending: (() => void)[] = [];
  private wantAmbience = false;
  private silenced = false;
  private disposed = false;
  private foot = 1;

  private readonly want = {
    master: 1,
    muffle: 0,
    bpm: 62,
    heart: 0,
    breath: 0,
    listener: null as { p: Vec3; f: Vec3 } | null,
  };

  private raf = 0;
  private timer = 0;
  private lastFrame = 0;
  private readonly onGesture = (): void => {
    const ctx = this.ctx;
    // 'suspended' (autoplay policy) or Safari's 'interrupted' (a call, another app took the output)
    if (ctx && ctx.state !== 'running' && ctx.state !== 'closed' && !this.disposed) void ctx.resume().catch(() => {});
  };

  readonly debug: AudioDebug = {
    taps: METER_TAPS,
    enableMeters: () => (this.meters ? this.meters.enable() : Promise.resolve(false)),
    now: () => this.meters?.now() ?? 0,
    read: (tap, seconds) => this.meters?.read(tap, seconds) ?? EMPTY_READING,
    since: (tap, t0) => this.meters?.since(tap, t0) ?? EMPTY_READING,
    envelope: (tap, seconds) => this.meters?.envelope(tap, seconds) ?? { dt: 0, rms: [] },
    muteOutput: (muted) => this.graph?.setOutputMuted(muted),
    state: () => this.debugState(),
    context: null,
  };

  constructor() {
    Object.defineProperty(this.debug, 'context', { get: () => this.ctx, enumerable: true });
  }

  /* ----------------------------------------------------------- life cycle */

  async resume(): Promise<void> {
    if (this.disposed) return;
    try {
      if (!this.ctx) this.build();
    } catch (err) {
      console.warn('[audio] Web Audio is not available; continuing without sound.', err);
      return;
    }
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'running') return;
    try {
      // resume() stays pending until the browser has seen a gesture: never wait on it forever
      await Promise.race([ctx.resume(), new Promise((res) => setTimeout(res, 1200))]);
    } catch {
      /* closed or refused: the gesture listeners will retry */
    }
  }

  private build(): void {
    const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const AC = w.AudioContext ?? w.webkitAudioContext;
    if (!AC) throw new Error('no AudioContext');
    const ctx = new AC({ latencyHint: 'interactive' });
    const graph = new Graph(ctx);
    this.ctx = ctx;
    this.graph = graph;
    this.body = new Body(graph);
    this.speech = new Speech(graph);
    this.meters = new Meters(ctx, graph.taps);

    // apply whatever was asked for before the context existed
    graph.setMaster(this.want.master, 0.01);
    graph.setMuffle(this.want.muffle);
    if (this.want.listener) graph.setListener(this.want.listener.p, this.want.listener.f);
    this.useBreathFile();
    this.body.setHeartbeat(this.want.bpm, this.want.heart);
    this.body.setBreathing(this.want.breath);

    const loop = (): void => {
      this.raf = requestAnimationFrame(loop);
      this.tick(true);
    };
    this.raf = requestAnimationFrame(loop);
    // rAF stops in a hidden tab; the timer keeps the schedulers and watchdogs alive
    this.timer = window.setInterval(() => this.tick(false), 50);
    window.addEventListener('pointerdown', this.onGesture, true);
    window.addEventListener('keydown', this.onGesture, true);

    if (import.meta.env.DEV) (window as unknown as { __audio?: AudioDebug }).__audio = this.debug;

    if (this.wantAmbience) this.startAmbience();
    for (const fn of this.pending.splice(0)) {
      try {
        fn();
      } catch (err) {
        console.warn('[audio] queued sound failed', err);
      }
    }
  }

  private tick(fromRaf: boolean): void {
    const g = this.graph;
    if (!g || this.disposed) return;
    try {
      const now = g.ctx.currentTime;
      const hidden = typeof document !== 'undefined' && document.hidden;
      if (!this.silenced) this.body?.pump(now, hidden ? 2.5 : 0.35);
      this.ambience?.tick(now);
      const wall = performance.now();
      if (fromRaf || wall - this.lastFrame > 150) {
        this.lastFrame = wall;
        g.frame();
        this.speech?.frame();
      }
    } catch (err) {
      console.warn('[audio] tick failed', err);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearInterval(this.timer);
    window.removeEventListener('pointerdown', this.onGesture, true);
    window.removeEventListener('keydown', this.onGesture, true);
    this.pending = [];
    try {
      this.speech?.stopAll();
      this.ambience?.stop(0.01);
      this.graph?.stopVoices(0.01);
      this.body?.dispose();
      this.meters?.dispose();
    } catch {
      /* tearing down anyway */
    }
    this.ambience = null;
    const ctx = this.ctx;
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => {});
    const w = window as unknown as { __audio?: AudioDebug };
    if (w.__audio === this.debug) delete w.__audio;
  }

  /* -------------------------------------------------------------- loading */

  load(onProgress?: (fraction: number) => void): Promise<void> {
    if (!this.loading) {
      this.loading = this.loadAll(onProgress).catch((err) => {
        console.warn('[audio] load failed; synthesised sound only', err);
      });
    } else if (onProgress) {
      void this.loading.then(() => onProgress(1));
    }
    return this.loading;
  }

  private async loadAll(onProgress?: (fraction: number) => void): Promise<void> {
    const report = (f: number): void => {
      try {
        onProgress?.(Math.min(1, Math.max(0, f)));
      } catch (err) {
        console.error(err);
      }
    };
    report(0);

    // 1. the asset files: any of them may be missing
    let fetched = 0;
    const queue = [...MANIFEST];
    const worker = async (): Promise<void> => {
      for (let entry = queue.shift(); entry; entry = queue.shift()) {
        const buffer = await this.fetchSound(entry);
        if (buffer && !this.disposed) this.files.set(entry.name, this.levelFile(entry.name, buffer));
        report((++fetched / MANIFEST.length) * 0.5);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    if (this.disposed) return;
    this.useBreathFile();

    // 2. the synthesised fallbacks for everything that is not on disk
    const jobs: (() => void)[] = [];
    for (const name of SYNTH_NAMES) if (!this.files.has(name)) jobs.push(() => void this.sound(name));
    jobs.push(() => void this.synthSound('tinnitus')); // cutToSilence() uses this one even when a file exists
    if (!this.files.has('ambience_city_night')) jobs.push(() => void this.bedBuffers());
    jobs.push(() => void this.hornBuffers());
    for (const heavy of [false, true]) {
      for (const surface of SURFACES) {
        if (this.stepFiles(surface, heavy).length === 0) jobs.push(() => void this.stepSynth(surface, heavy));
      }
    }
    let done = 0;
    for (const job of jobs) {
      if (this.disposed) return;
      job();
      report(0.5 + (++done / jobs.length) * 0.5);
      await breathe();
    }
    this.loaded = true;
    report(1);
  }

  /** Fetch and decode one asset. Resolves null (never throws) when it is absent or not audio. */
  private async fetchSound(entry: ManifestEntry): Promise<AudioBuffer | null> {
    try {
      const base = import.meta.env.BASE_URL || '/';
      const res = await fetch(base + entry.file.replace(/^\//, ''));
      if (!res.ok) return null;
      // a dev server or SPA host may answer a missing file with index.html and a 200
      const type = (res.headers.get('content-type') ?? '').toLowerCase();
      if (type && !/audio|mpeg|ogg|wav|octet-stream|video\/mp4/.test(type)) return null;
      const data = await res.arrayBuffer();
      if (data.byteLength < 256) return null;
      this.decoder ??= this.ctx ?? new OfflineAudioContext(1, 1, 48000);
      const buffer = await this.decoder.decodeAudioData(data);
      return buffer.length > 0 ? buffer : null;
    } catch {
      return null;
    }
  }

  private levelFile(name: string, buffer: AudioBuffer): Sound {
    const m = measure(buffer);
    const sr = buffer.sampleRate;
    let trim = 1;
    const loopRms = FILE_LOOP_RMS_DB[name as SfxName];
    if (loopRms !== undefined) trim = m.rms > 1e-6 ? Math.pow(10, loopRms / 20) / m.rms : 1;
    else if (name.startsWith('footstep_')) trim = m.peak > 1e-6 ? STEP_PEAK / m.peak : 1;
    else if (name in FILE_PEAK) trim = m.peak > 1e-6 ? FILE_PEAK[name as SynthName] / m.peak : 1;

    // One-shots: skip the silence generated files tend to open with (a footstep that lands 100 ms
    // late is a footstep out of sync), keeping 4 ms of run-in.
    const head = soundingRange(buffer, Math.max(5e-4, m.peak * 0.02));
    const start = head.first < buffer.length ? Math.max(0, head.first / sr - 0.004) : 0;

    // Loops: mp3 encoders can pad both ends with digital silence. Loop only the part that sounds.
    const edge = soundingRange(buffer, Math.max(1e-4, m.peak * 0.002));
    const pad = 0.08 * sr;
    const loopStart = edge.first > 1 && edge.first < pad ? edge.first / sr : 0;
    const loopEnd = edge.last > edge.first && buffer.length - 1 - edge.last > 1 && buffer.length - edge.last < pad ? (edge.last + 1) / sr : 0;
    return { buffer, trim: Math.min(32, trim), start, loopStart, loopEnd: loopStart > 0 && loopEnd === 0 ? buffer.duration : loopEnd };
  }

  /** If the recorded shaky-breath loop exists, the body uses it for the top of the breathing range. */
  private useBreathFile(): void {
    const f = this.files.get('breath_shaky');
    this.body?.setBreathFile(f?.buffer ?? null, f?.trim ?? 1);
  }

  private get rate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  /** The buffer for a sound: the file if it loaded, otherwise the synthesised version. */
  private sound(name: SynthName): Sound {
    return this.files.get(name) ?? this.synthSound(name);
  }

  /** The synthesised version of a sound (rendered once, on first use or during load()). */
  private synthSound(name: SynthName): Sound {
    let s = this.synths.get(name);
    if (!s) {
      s = { buffer: toBuffer(renderSfx(name, this.rate)), trim: 1, start: 0, loopStart: 0, loopEnd: 0 };
      this.synths.set(name, s);
    }
    return s;
  }

  private bedBuffers(): BedBuffers {
    if (!this.bed) {
      const b = renderCityBed(this.rate);
      this.bed = { rumble: toBuffer(b.rumble), air: toBuffer(b.air), drone: toBuffer(b.drone), windSource: toBuffer(b.windSource) };
    }
    return this.bed;
  }

  private hornBuffers(): AudioBuffer[] {
    if (this.horns.length === 0) {
      for (let i = 0; i < HORN_VARIANTS; i++) this.horns.push(bufferFrom([renderHorn(i, this.rate)], this.rate));
    }
    return this.horns;
  }

  private stepFiles(surface: Surface, heavy: boolean): Sound[] {
    const out: Sound[] = [];
    for (let i = 1; i <= 4; i++) {
      const s = this.files.get(heavy ? `footstep_heavy_${i}` : `footstep_${surface}_${i}`);
      if (s) out.push(s);
    }
    return out;
  }

  private stepSynth(surface: Surface, heavy: boolean): Sound[] {
    const key = `${surface}:${heavy ? 'heavy' : 'light'}`;
    let list = this.stepSynths.get(key);
    if (!list) {
      list = [];
      for (let i = 0; i < STEP_VARIANTS; i++) {
        list.push({ buffer: bufferFrom([renderFootstep(surface, heavy, i, this.rate)], this.rate), trim: 1, start: 0, loopStart: 0, loopEnd: 0 });
      }
      this.stepSynths.set(key, list);
    }
    return list;
  }

  /* ------------------------------------------------------------- listener */

  setListener(position: THREE.Vector3, forward: THREE.Vector3): void {
    const l = (this.want.listener ??= { p: { x: 0, y: 0, z: 0 }, f: { x: 0, y: 0, z: -1 } });
    l.p.x = position.x;
    l.p.y = position.y;
    l.p.z = position.z;
    l.f.x = forward.x;
    l.f.y = forward.y;
    l.f.z = forward.z;
    this.graph?.setListener(l.p, l.f);
  }

  /* ------------------------------------------------------------- ambience */

  startAmbience(): void {
    if (this.disposed) return;
    this.wantAmbience = true;
    this.silenced = false; // a scene is starting: the body may be heard again
    const g = this.graph;
    if (!g || this.ambience) return;
    try {
      this.ambience = this.makeAmbience(true, 1);
      this.ambience.start(2);
    } catch (err) {
      console.warn('[audio] ambience failed', err);
      this.ambience = null;
    }
  }

  stopAmbience(fadeSeconds = 1): void {
    this.wantAmbience = false;
    this.ambience?.stop(fadeSeconds);
    this.ambience = null;
  }

  private makeAmbience(events: boolean, volume: number): CityAmbience {
    const file = this.files.get('ambience_city_night') ?? null;
    const src: AmbienceSources = {
      file,
      bed: file ? null : this.bedBuffers(),
      car: events ? this.sound('car_pass').buffer : null,
      siren: events ? this.sound('distant_siren').buffer : null,
      gust: events ? this.sound('wind_gust').buffer : null,
      horns: events ? this.hornBuffers() : [],
    };
    return new CityAmbience(this.graph!, src, { events, volume });
  }

  /* ------------------------------------------------------------------ sfx */

  play(name: SfxName, opts: { position?: THREE.Vector3; volume?: number; rate?: number; loop?: boolean } = {}): Handle {
    if (this.disposed) return NO_HANDLE;
    const loop = opts.loop ?? LOOPS.has(name);
    if (!this.graph) {
      // before resume(): a one-shot is simply missed; a loop is started when audio comes up
      if (!loop) return NO_HANDLE;
      let handle: Handle | null = null;
      let cancelled = false;
      const position = opts.position ? { x: opts.position.x, y: opts.position.y, z: opts.position.z } : undefined;
      this.pending.push(() => {
        if (!cancelled) handle = this.playNow(name, { volume: opts.volume, rate: opts.rate, position }, loop);
      });
      return {
        stop: (fade) => {
          cancelled = true;
          handle?.stop(fade);
        },
      };
    }
    return this.playNow(name, opts, loop);
  }

  private playNow(name: SfxName, opts: { position?: Vec3; volume?: number; rate?: number }, loop: boolean): Handle {
    const g = this.graph;
    if (!g) return NO_HANDLE;
    try {
      const position = opts.position ?? null;
      const bus: PlayBus = name === 'tinnitus' ? 'direct' : position ? 'world' : SELF_SOUNDS.has(name) ? 'self' : 'world';
      // after the cut to black the world stays gone until the next scene starts
      if (this.silenced && bus === 'world') return NO_HANDLE;
      const volume = Math.max(0, opts.volume ?? 1);

      if (name === 'ambience_city_night') {
        const amb = this.makeAmbience(false, volume);
        amb.start(0.6);
        return { stop: (fade = 0.5) => amb.stop(fade) };
      }

      const s = this.sound(name);
      const voice = g.play(s.buffer, {
        bus,
        position,
        spatial: SPATIAL[name],
        volume: volume * s.trim,
        rate: opts.rate,
        loop,
        loopStart: s.loopStart,
        loopEnd: s.loopEnd,
        offset: loop ? s.loopStart : s.start,
      });
      return { stop: (fade = 0.05) => voice.stop(fade) };
    } catch (err) {
      console.warn(`[audio] play(${name}) failed`, err);
      return NO_HANDLE;
    }
  }

  footstep(surface: Surface, opts: { position?: THREE.Vector3; volume?: number; heavy?: boolean } = {}): void {
    const g = this.graph;
    if (!g || this.disposed || this.silenced) return;
    try {
      const heavy = !!opts.heavy;
      const surf: Surface = SURFACES.includes(surface) ? surface : 'concrete';
      const files = this.stepFiles(surf, heavy);
      const list = files.length > 0 ? files : this.stepSynth(surf, heavy);
      const key = `${surf}:${heavy}`;
      let i = Math.floor(Math.random() * list.length);
      if (list.length > 1 && i === this.lastStep.get(key)) i = (i + 1 + Math.floor(Math.random() * (list.length - 1))) % list.length;
      this.lastStep.set(key, i);
      const s = list[i];
      // no two steps are the same: level, pitch, and (in the synthesised set) heel-toe timing all move
      const volume = Math.max(0, opts.volume ?? 1) * s.trim * STEP_SURFACE_TRIM[surf] * rnd(0.8, 1);
      const rate = heavy ? rnd(0.92, 1.04) : rnd(0.94, 1.07);
      if (opts.position) {
        g.play(s.buffer, { bus: 'world', position: opts.position, spatial: SPATIAL_STEP, volume: volume * 1.1, rate, offset: s.start });
      } else {
        this.foot = -this.foot;
        g.play(s.buffer, { bus: 'self', volume: volume * 0.62, rate, pan: this.foot * 0.08, offset: s.start });
        // now and then her jacket and bag move with the stride
        if (Math.random() < 0.3) {
          const cloth = this.sound('cloth_rustle');
          g.play(cloth.buffer, { bus: 'self', volume: volume * cloth.trim * rnd(0.1, 0.2), rate: rnd(0.8, 1.3), pan: -this.foot * 0.15, offset: cloth.start });
        }
      }
    } catch (err) {
      console.warn('[audio] footstep failed', err);
    }
  }

  /* ----------------------------------------------------------------- body */

  setHeartbeat(bpm: number, volume: number): void {
    if (this.silenced) return;
    this.want.bpm = bpm;
    this.want.heart = volume;
    this.body?.setHeartbeat(bpm, volume);
  }

  setBreathing(level: number): void {
    if (this.silenced) return;
    this.want.breath = level;
    this.body?.setBreathing(level);
  }

  setMuffle(level: number): void {
    this.want.muffle = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
    this.graph?.setMuffle(this.want.muffle);
  }

  /* --------------------------------------------------------------- speech */

  speak(url: string, opts: SpeakOptions): SpeechHandle {
    if (!url || !this.speech || this.disposed) return DONE;
    return this.speech.speak(url, opts);
  }

  stopAllSpeech(): void {
    this.speech?.stopAll();
  }

  /* --------------------------------------------------------------- master */

  cutToSilence(): void {
    this.wantAmbience = false;
    this.want.heart = 0;
    this.want.breath = 0;
    this.pending = [];
    const g = this.graph;
    if (!g || this.disposed) return;
    this.silenced = true;
    try {
      this.speech?.stopAll();
      this.ambience?.stop(0.006);
      this.ambience = null;
      this.body?.silence();
      g.cut();
      // ...and what is left when everything else has gone. Always the synthesised tone: its shape
      // (a quick rise, then a fade to nothing over about five seconds) is the point of the moment.
      const t = this.synthSound('tinnitus');
      g.play(t.buffer, { bus: 'direct', volume: t.trim });
    } catch (err) {
      console.warn('[audio] cutToSilence failed', err);
    }
  }

  setMaster(volume: number, fadeSeconds = 0.05): void {
    this.want.master = Number.isFinite(volume) ? Math.max(0, volume) : 1;
    this.graph?.setMaster(this.want.master, Math.max(0, fadeSeconds));
  }

  /* ---------------------------------------------------------------- debug */

  private debugState(): AudioDebugState {
    const sources: AudioDebugState['sources'] = {};
    for (const e of MANIFEST) {
      const isStep = e.name.startsWith('footstep_');
      sources[e.name] = this.files.has(e.name) ? 'file' : isStep || this.synths.has(e.name) || (e.name === 'ambience_city_night' && this.bed) ? 'synth' : 'pending';
    }
    const files: AudioDebugState['files'] = {};
    for (const [name, f] of this.files) files[name] = { duration: f.buffer.duration, trim: f.trim, start: f.start, loopStart: f.loopStart, loopEnd: f.loopEnd };
    const b = this.body?.state;
    return {
      context: this.ctx?.state ?? 'none',
      sampleRate: this.ctx?.sampleRate ?? 0,
      loaded: this.loaded,
      silenced: this.silenced,
      ambience: this.ambience !== null,
      voices: this.graph?.voiceCount ?? 0,
      speech: this.speech?.count ?? 0,
      muffle: this.want.muffle,
      master: this.want.master,
      heart: { bpm: b?.bpm ?? 0, targetBpm: b?.targetBpm ?? this.want.bpm, volume: b?.heartVolume ?? 0, beats: this.body ? [...this.body.beatLog] : [] },
      breathing: b?.breathing ?? 0,
      sources,
      files,
    };
  }
}

const EMPTY_READING: MeterReading = { rms: 0, rmsDb: -200, peak: 0, hfRms: 0, hfRatio: 0, seconds: 0 };

export function createAudio(): DebuggableAudioEngine {
  return new OitAudio();
}
