/**
 * Push-to-talk microphone. The stream is opened once (init) and kept open so
 * start() is instant; each press records one clip with MediaRecorder. The mic
 * is never routed to the speakers.
 */

import { baseAudioType } from '../../shared/audio';
import type { Mic } from '../contracts';
import { METER_LIVE_PEAK, absorbRecorderEvent, discardReason, freshAccum, sealRecorder, type RecorderAccum } from './clip';

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/ogg;codecs=opus'];

function pickMime(): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return '';
  for (const m of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      /* keep looking */
    }
  }
  return '';
}

interface Clip {
  recorder: MediaRecorder;
  chunks: Blob[];
  startedAt: number;
  peak: number;
  /** Number of level samples taken while the analyser was live. */
  metered: number;
  /** Set once a sample is loud enough to prove the analyser is not stuck at zero. */
  meterLive: boolean;
  stopping: Promise<Blob | null> | null;
  accum: RecorderAccum;
}

class PushToTalkMic implements Mic {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private data: Float32Array<ArrayBuffer> | null = null;
  private nodes: AudioNode[] = [];
  private initing: Promise<boolean> | null = null;
  private clip: Clip | null = null;
  private meterTimer = 0;
  private smoothed = 0;
  private mime = '';
  private disposed = false;
  private ok = false;
  private watching = false;

  get available(): boolean {
    return this.ok && !this.disposed;
  }

  get recording(): boolean {
    return this.clip !== null && this.clip.stopping === null;
  }

  init(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (this.ok) return Promise.resolve(true);
    this.initing ??= this.open().then((ok) => {
      this.initing = null;
      return ok;
    });
    return this.initing;
  }

  private async open(): Promise<boolean> {
    try {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return false;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        video: false,
      });
      if (this.disposed) {
        for (const t of stream.getTracks()) t.stop();
        return false;
      }
      const track = stream.getAudioTracks()[0];
      if (!track) {
        for (const t of stream.getTracks()) t.stop();
        return false;
      }
      this.stream = stream;
      this.mime = pickMime();
      // if the device goes away (unplugged, permission revoked) stop offering the mic
      track.addEventListener('ended', () => {
        if (this.stream !== stream) return;
        this.ok = false;
        this.stream = null;
        this.stopMeter();
      });
      this.setupMeter(stream);
      this.ok = true;
      return true;
    } catch {
      // denied, no device, insecure context...
      this.ok = false;
      return false;
    }
  }

  /** Level metering is a nicety: any failure here leaves recording fully working. */
  private setupMeter(stream: MediaStream): void {
    try {
      const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
      const AC = w.AudioContext ?? w.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0;
      // analyser -> silent gain -> destination keeps the analyser pulled in every browser, with no monitoring
      const mute = ctx.createGain();
      // Exactly 0 lets some browsers drop the branch, so the analyser stays at
      // zero while MediaRecorder (a separate consumer) still hears the mic.
      mute.gain.value = 0.00001;
      src.connect(analyser).connect(mute).connect(ctx.destination);
      this.ctx = ctx;
      this.analyser = analyser;
      this.data = new Float32Array(analyser.fftSize);
      this.nodes = [src, analyser, mute];
    } catch {
      this.ctx = null;
      this.analyser = null;
    }
  }

  private sample(): void {
    const clip = this.clip;
    const an = this.analyser;
    if (!an || !this.data || this.ctx?.state !== 'running') {
      this.smoothed *= 0.8;
      return;
    }
    an.getFloatTimeDomainData(this.data);
    let sum = 0, peak = 0;
    for (let i = 0; i < this.data.length; i++) {
      const v = this.data[i];
      sum += v * v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
    if (clip && clip.stopping === null) {
      clip.metered++;
      if (peak > clip.peak) clip.peak = peak;
      if (peak >= METER_LIVE_PEAK) clip.meterLive = true;
    }
    const rms = Math.sqrt(sum / this.data.length);
    // speech into a laptop mic sits around 0.02-0.2 RMS: stretch that across 0..1
    const target = Math.min(1, Math.pow(Math.min(1, rms * 6), 0.6));
    this.smoothed += (target - this.smoothed) * (target > this.smoothed ? 0.6 : 0.25);
  }

  private stopMeter(): void {
    if (this.meterTimer) clearInterval(this.meterTimer);
    this.meterTimer = 0;
    this.smoothed = 0;
  }

  /**
   * Timeslice so chunks exist before stop. Without one, the entire utterance
   * arrives in a single dataavailable that Chromium can deliver after stop,
   * and a handler that seals on stop throws the words away.
   */
  start(): boolean {
    if (!this.available || !this.stream || this.recording) return false;
    try {
      const recorder = this.mime ? new MediaRecorder(this.stream, { mimeType: this.mime, audioBitsPerSecond: 48000 }) : new MediaRecorder(this.stream);
      const clip: Clip = { recorder, chunks: [], startedAt: performance.now(), peak: 0, metered: 0, meterLive: false, stopping: null, accum: freshAccum() };
      recorder.ondataavailable = (ev: BlobEvent) => {
        if (ev.data && ev.data.size > 0) {
          clip.chunks.push(ev.data);
          clip.accum = absorbRecorderEvent(clip.accum, 'data', ev.data.size);
        }
      };
      recorder.start(200);
      this.clip = clip;
      // start() comes from a key press, so this is allowed even if init() was not gesture-driven
      if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
      this.stopMeter();
      this.meterTimer = window.setInterval(() => this.sample(), 20);
      return true;
    } catch {
      this.clip = null;
      return false;
    }
  }

  watch(on: boolean): void {
    this.watching = on;
    if (on) {
      if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
      if (!this.meterTimer) this.meterTimer = window.setInterval(() => this.sample(), 20);
    } else if (!this.recording) {
      this.stopMeter();
    }
  }

  stop(): Promise<Blob | null> {
    const clip = this.clip;
    if (!clip) return Promise.resolve(null);
    if (clip.stopping) return clip.stopping;
    this.sample();
    const duration = performance.now() - clip.startedAt;
    this.stopMeter();

    clip.stopping = new Promise<Blob | null>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        if (this.clip === clip) this.clip = null;
        clip.accum = sealRecorder(clip.accum);
        const named = baseAudioType(clip.recorder.mimeType || this.mime || clip.chunks[0]?.type || 'audio/webm');
        const blob = clip.chunks.length ? new Blob(clip.chunks, { type: named.type }) : null;
        const reason = discardReason({
          durationMs: duration,
          bytes: blob?.size ?? clip.accum.bytes,
          peak: clip.peak,
          samples: clip.metered,
          meterLive: clip.meterLive,
        });
        resolve(reason || !blob ? null : blob);
      };
      // A recorder that never reports back must not leave the caller waiting.
      // The short delay after stop lets a late dataavailable land first.
      const guard = window.setTimeout(finish, 1500);
      const later = (): void => {
        window.setTimeout(finish, 40);
      };
      clip.recorder.onstop = () => {
        clip.accum = absorbRecorderEvent(clip.accum, 'stop');
        later();
      };
      clip.recorder.onerror = later;
      try {
        if (clip.recorder.state === 'recording') {
          try {
            clip.recorder.requestData();
          } catch {
            /* not every browser implements requestData */
          }
          clip.recorder.stop();
        } else later();
      } catch {
        finish();
      }
    });
    // a new press may begin while this clip is still being finalised
    this.clip = null;
    if (this.watching && !this.meterTimer) this.meterTimer = window.setInterval(() => this.sample(), 20);
    return clip.stopping;
  }

  level(): number {
    return this.recording || this.watching ? this.smoothed : 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ok = false;
    this.stopMeter();
    const clip = this.clip;
    this.clip = null;
    try {
      if (clip && clip.recorder.state !== 'inactive') clip.recorder.stop();
    } catch {
      /* fine */
    }
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* fine */
      }
    }
    this.nodes = [];
    if (this.ctx && this.ctx.state !== 'closed') void this.ctx.close().catch(() => {});
    this.ctx = null;
    this.analyser = null;
  }
}

export function createMic(): Mic {
  return new PushToTalkMic();
}
