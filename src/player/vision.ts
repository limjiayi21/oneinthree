/**
 * One webcam shared by eye look (eyes.ts) and hand tracking (hands.ts).
 *
 * The camera opens when the first tracker starts and closes when the last
 * one stops. Each tracker registers a per-frame callback; frames are paced by
 * the video itself (requestVideoFrameCallback) so no frame is processed twice.
 * Nothing leaves the device.
 */

import wasmLoaderPath from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmBinaryPath from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';

/** WASM file locations for MediaPipe `createFromOptions`. */
export const VISION_FILESET = { wasmLoaderPath, wasmBinaryPath };

export const modelUrl = (file: string): string => `${import.meta.env.BASE_URL}models/${file}`;

export type FrameFn = (video: HTMLVideoElement, now: number, dt: number) => void;

let stream: MediaStream | null = null;
let video: HTMLVideoElement | null = null;
let opening: Promise<HTMLVideoElement> | null = null;
let lastT = 0;
let scheduled = false;
const subscribers = new Set<FrameFn>();

function tick(): void {
  scheduled = false;
  if (!video || subscribers.size === 0) return;
  const now = performance.now();
  const dt = Math.min(0.1, Math.max(0.001, (now - lastT) / 1000));
  lastT = now;
  if (video.readyState >= 2) {
    for (const fn of [...subscribers]) {
      try {
        fn(video, now, dt);
      } catch (err) {
        console.warn('vision: frame callback failed', err);
      }
    }
  }
  schedule();
}

function schedule(): void {
  if (scheduled || !video || subscribers.size === 0) return;
  scheduled = true;
  const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
  if (typeof v.requestVideoFrameCallback === 'function') v.requestVideoFrameCallback(tick);
  else requestAnimationFrame(tick);
}

async function open(): Promise<HTMLVideoElement> {
  if (video) return video;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser has no camera access.');
  const s = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
    audio: false,
  });
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.srcObject = s;
  try {
    await v.play();
  } catch (err) {
    for (const t of s.getTracks()) t.stop();
    throw err;
  }
  stream = s;
  video = v;
  lastT = performance.now();
  return v;
}

/**
 * Start receiving frames. Opens the camera if needed; rejects if it cannot
 * (NotAllowedError, NotFoundError, ...). Returns the unsubscribe function.
 */
export async function subscribeFrames(fn: FrameFn): Promise<() => void> {
  opening ??= open().finally(() => {
    opening = null;
  });
  await opening;
  subscribers.add(fn);
  schedule();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    subscribers.delete(fn);
    if (subscribers.size === 0) closeCamera();
  };
}

function closeCamera(): void {
  if (stream) for (const t of stream.getTracks()) t.stop();
  stream = null;
  if (video) video.srcObject = null;
  video = null;
  scheduled = false;
}

/** Friendly message for a failed start. */
export function cameraErrorMessage(what: string, err: unknown, key: string): string {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'NotAllowedError') return `Camera blocked. Allow it in the address bar, then press ${key}.`;
  if (name === 'NotFoundError') return 'No camera found.';
  if (name === 'NotReadableError') return 'The camera is in use by another app.';
  const detail = err instanceof Error && err.message ? `: ${err.message.slice(0, 80)}` : '.';
  return `${what} could not start${detail}`;
}
