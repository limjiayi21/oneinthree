/**
 * Live text to speech. The upstream ElevenLabs request starts the moment a
 * line exists; the bytes are buffered as they arrive so that the client's GET
 * can attach to the stream while it is still in flight, and so a second GET
 * for the same line (or a replay) is served from memory.
 */
import type { Emotion } from '../shared/types';
import { TTS_LIVE_MODEL, buildTts, type Delivery, type VoiceRole } from './voices';

export interface AudioSpec {
  role: VoiceRole;
  text: string;
  emotion: Emotion;
  delivery: Delivery;
  /** The line he (or she) said just before this one, so the voice can continue. */
  previousText?: string;
}

export class LiveAudio {
  readonly startedAt = Date.now();
  firstByteAt: number | null = null;
  private chunks: Uint8Array[] = [];
  private done = false;
  private error: string | null = null;
  private waiters: Array<() => void> = [];

  constructor(upstream: Promise<Response>) {
    void this.pump(upstream);
  }

  private wake(): void {
    const list = this.waiters;
    this.waiters = [];
    for (const w of list) w();
  }

  private async pump(upstream: Promise<Response>): Promise<void> {
    try {
      const res = await upstream;
      if (!res.ok || !res.body) {
        await res.body?.cancel();
        throw new Error(`text-to-speech ${res.status}`);
      }
      const reader = res.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength) {
          if (this.firstByteAt === null) this.firstByteAt = Date.now();
          this.chunks.push(value);
          this.wake();
        }
      }
    } catch (err) {
      this.error = String((err as Error)?.message ?? err);
    } finally {
      this.done = true;
      this.wake();
    }
  }

  private next(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Resolves true once there is audio to send, false if the request failed before producing any. */
  async ready(): Promise<boolean> {
    while (!this.chunks.length && !this.done) await this.next();
    return this.chunks.length > 0;
  }

  /** Milliseconds from request to first audio byte, or null if none arrived within `timeoutMs`. */
  async timeToFirstByte(timeoutMs: number): Promise<number | null> {
    const timeout = new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs));
    const ok = await Promise.race([this.ready(), timeout]);
    return ok && this.firstByteAt !== null ? this.firstByteAt - this.startedAt : null;
  }

  get failed(): string | null {
    return this.error;
  }

  get complete(): boolean {
    return this.done && !this.error;
  }

  /** A fresh stream for one listener: replays what has arrived, then follows the live upstream. */
  stream(): ReadableStream<Uint8Array> {
    let i = 0;
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        for (;;) {
          if (i < this.chunks.length) {
            controller.enqueue(this.chunks[i++]);
            return;
          }
          if (this.done) {
            controller.close();
            return;
          }
          await this.next();
        }
      },
    });
  }
}

export function startTts(apiKey: string, spec: AudioSpec, fetchImpl: typeof fetch = fetch): LiveAudio {
  const req = buildTts(spec.role, spec.text, spec.emotion, spec.delivery, TTS_LIVE_MODEL, spec.previousText);
  return new LiveAudio(
    fetchImpl(req.url, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(req.body),
    }),
  );
}
