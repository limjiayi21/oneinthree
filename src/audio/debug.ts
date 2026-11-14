/**
 * Signal-level meters for tests and the dev harness (nothing here is needed to
 * make sound). An AudioWorklet measures every render quantum of each tapped
 * bus (RMS, peak, and the RMS of the part above 2 kHz, 24 dB/octave), so readings do not
 * depend on requestAnimationFrame and no samples are missed.
 */

export type MeterTap = 'world' | 'voice' | 'self' | 'thought' | 'master';
export const METER_TAPS: readonly MeterTap[] = ['world', 'voice', 'self', 'thought', 'master'];

export interface MeterReading {
  /** RMS over the window, linear. */
  rms: number;
  /** RMS in dBFS (-200 when silent). */
  rmsDb: number;
  /** Largest absolute sample in the window. */
  peak: number;
  /** RMS of the signal above 2 kHz (4th-order high-pass). */
  hfRms: number;
  /** hfRms / rms: 0 = all low end, towards 1 = all highs. */
  hfRatio: number;
  /** Seconds actually covered by the reading. */
  seconds: number;
}

const WORKLET = `
class OitMeter extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.n = o.numberOfInputs;
    // 4th-order (two cascaded Butterworth biquads) high-pass at 2 kHz: the "highs" band
    const w = 2 * Math.PI * 2000 / sampleRate, c = Math.cos(w), al = Math.sin(w) / (2 * Math.SQRT1_2), a0 = 1 + al;
    this.b0 = (1 + c) / 2 / a0; this.b1 = -(1 + c) / a0; this.b2 = this.b0;
    this.a1 = -2 * c / a0; this.a2 = (1 - al) / a0;
    this.z = new Float64Array(this.n * 4);
    this.rows = [];
  }
  process(inputs) {
    const row = new Float32Array(this.n * 3);
    const b0 = this.b0, b1 = this.b1, b2 = this.b2, a1 = this.a1, a2 = this.a2, z = this.z;
    for (let i = 0; i < this.n; i++) {
      const input = inputs[i];
      if (!input || input.length === 0) continue;
      const c0 = input[0], c1 = input.length > 1 ? input[1] : input[0];
      const len = c0.length;
      let sum = 0, peak = 0, hf = 0;
      let z1 = z[i * 4], z2 = z[i * 4 + 1], z3 = z[i * 4 + 2], z4 = z[i * 4 + 3];
      for (let k = 0; k < len; k++) {
        const l = c0[k], r = c1[k];
        const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
        if (al > peak) peak = al;
        if (ar > peak) peak = ar;
        sum += (l * l + r * r) * 0.5;
        const m = (l + r) * 0.5;
        const y = b0 * m + z1; z1 = b1 * m - a1 * y + z2; z2 = b2 * m - a2 * y;
        const h = b0 * y + z3; z3 = b1 * y - a1 * h + z4; z4 = b2 * y - a2 * h;
        hf += h * h;
      }
      const tiny = 1e-25;
      z[i * 4] = Math.abs(z1) < tiny ? 0 : z1; z[i * 4 + 1] = Math.abs(z2) < tiny ? 0 : z2;
      z[i * 4 + 2] = Math.abs(z3) < tiny ? 0 : z3; z[i * 4 + 3] = Math.abs(z4) < tiny ? 0 : z4;
      row[i * 3] = sum / len;
      row[i * 3 + 1] = peak;
      row[i * 3 + 2] = hf / len;
    }
    this.rows.push(row);
    if (this.rows.length >= 8) {
      this.port.postMessage({ t: currentTime, rows: this.rows });
      this.rows = [];
    }
    return true;
  }
}
registerProcessor('oit-meter', OitMeter);
`;

/** ~32 s of history at 48 kHz / 128-sample quanta. */
const RING = 12000;

export class Meters {
  private node: AudioWorkletNode | null = null;
  private analysers: Partial<Record<MeterTap, AnalyserNode>> = {};
  private enabling: Promise<boolean> | null = null;
  // per tap: mean-square, peak, hf mean-square for each quantum
  private ms = METER_TAPS.map(() => new Float32Array(RING));
  private pk = METER_TAPS.map(() => new Float32Array(RING));
  private hf = METER_TAPS.map(() => new Float32Array(RING));
  private head = 0;
  private filled = 0;
  private lastTime = 0;
  private readonly quantum: number;

  constructor(
    private readonly ctx: AudioContext,
    private readonly taps: Record<MeterTap, AudioNode>,
  ) {
    this.quantum = 128 / ctx.sampleRate;
  }

  get enabled(): boolean {
    return this.node !== null || Object.keys(this.analysers).length > 0;
  }

  /** Start measuring. Resolves true when the precise (worklet) meters are running. */
  enable(): Promise<boolean> {
    if (this.enabling) return this.enabling;
    this.enabling = (async () => {
      try {
        if (!this.ctx.audioWorklet) throw new Error('no AudioWorklet');
        const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
        try {
          await this.ctx.audioWorklet.addModule(url);
        } finally {
          URL.revokeObjectURL(url);
        }
        const node = new AudioWorkletNode(this.ctx, 'oit-meter', {
          numberOfInputs: METER_TAPS.length,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 2,
          channelCountMode: 'explicit',
        });
        METER_TAPS.forEach((tap, i) => this.taps[tap].connect(node, 0, i));
        // keep it pulled without making sound
        const sink = this.ctx.createGain();
        sink.gain.value = 0;
        node.connect(sink).connect(this.ctx.destination);
        node.port.onmessage = (ev: MessageEvent<{ t: number; rows: Float32Array[] }>) => {
          this.lastTime = ev.data.t;
          for (const row of ev.data.rows) {
            const h = this.head;
            for (let i = 0; i < METER_TAPS.length; i++) {
              this.ms[i][h] = row[i * 3];
              this.pk[i][h] = row[i * 3 + 1];
              this.hf[i][h] = row[i * 3 + 2];
            }
            this.head = (h + 1) % RING;
            if (this.filled < RING) this.filled++;
          }
        };
        this.node = node;
        return true;
      } catch {
        // Fallback: analysers give a snapshot of the most recent ~43 ms only.
        for (const tap of METER_TAPS) {
          const an = this.ctx.createAnalyser();
          an.fftSize = 2048;
          this.taps[tap].connect(an);
          this.analysers[tap] = an;
        }
        return false;
      }
    })();
    return this.enabling;
  }

  /** Audio-clock time of the newest measurement. */
  now(): number {
    return this.node ? this.lastTime : this.ctx.currentTime;
  }

  /** Reading over the most recent `seconds` (default 1). */
  read(tap: MeterTap, seconds = 1): MeterReading {
    const i = METER_TAPS.indexOf(tap);
    if (!this.node) return this.snapshot(tap);
    const want = Math.max(1, Math.min(this.filled, Math.round(seconds / this.quantum)));
    let sum = 0, peak = 0, hf = 0;
    for (let k = 0; k < want; k++) {
      const idx = (this.head - 1 - k + RING * 2) % RING;
      sum += this.ms[i][idx];
      hf += this.hf[i][idx];
      if (this.pk[i][idx] > peak) peak = this.pk[i][idx];
    }
    return reading(sum / want, peak, hf / want, want * this.quantum);
  }

  /** Reading over everything measured since audio-clock time `t0` (see now()). */
  since(tap: MeterTap, t0: number): MeterReading {
    return this.read(tap, Math.max(this.quantum, this.now() - t0));
  }

  /** Per-quantum RMS envelope of the most recent `seconds` (oldest first). `dt` is the step in seconds. */
  envelope(tap: MeterTap, seconds = 4): { dt: number; rms: number[] } {
    const i = METER_TAPS.indexOf(tap);
    const want = Math.max(0, Math.min(this.filled, Math.round(seconds / this.quantum)));
    const out: number[] = new Array(want);
    for (let k = 0; k < want; k++) {
      const idx = (this.head - want + k + RING * 2) % RING;
      out[k] = Math.sqrt(this.ms[i][idx]);
    }
    return { dt: this.quantum, rms: out };
  }

  private snapshot(tap: MeterTap): MeterReading {
    const an = this.analysers[tap];
    if (!an) return reading(0, 0, 0, 0);
    const buf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(buf);
    const a = 1 - Math.exp((-2 * Math.PI * 2000) / this.ctx.sampleRate);
    let sum = 0, peak = 0, hf = 0, lp = 0;
    for (let k = 0; k < buf.length; k++) {
      const v = buf[k];
      sum += v * v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
      lp += a * (v - lp);
      hf += (v - lp) * (v - lp);
    }
    return reading(sum / buf.length, peak, hf / buf.length, buf.length / this.ctx.sampleRate);
  }

  dispose(): void {
    try {
      this.node?.port.close();
      this.node?.disconnect();
      for (const an of Object.values(this.analysers)) an?.disconnect();
    } catch {
      /* already gone */
    }
    this.node = null;
    this.analysers = {};
  }
}

function reading(meanSquare: number, peak: number, hfMeanSquare: number, seconds: number): MeterReading {
  const rms = Math.sqrt(meanSquare);
  const hfRms = Math.sqrt(hfMeanSquare);
  return {
    rms,
    rmsDb: rms > 1e-10 ? 20 * Math.log10(rms) : -200,
    peak,
    hfRms,
    hfRatio: rms > 1e-10 ? hfRms / rms : 0,
    seconds,
  };
}
