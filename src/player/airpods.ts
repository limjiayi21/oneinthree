/**
 * AirPods head tracking: head look from the AirPods' own motion sensors.
 *
 * Browsers cannot read headphone motion, so a tiny macOS helper
 * (tools/airpods-helper, `npm run airpods`) streams the head attitude over
 * ws://127.0.0.1:8765. When the player's audio device is AirPods and the
 * helper is running, head look comes from here instead of the webcam;
 * otherwise the webcam head look (eyes.ts) carries on as before.
 *
 * The first motion after connecting (and Shift+G) sets the straight-ahead
 * pose. Angles become the same gaze signal the webcam produces, so the view
 * behaves the same either way (gazeToLook).
 *
 * ?airpodsx=-1 / ?airpodsy=-1 flip an axis if a headset reports the other way.
 */

import { damp, wrapAngle, DEG } from './mathx';
import { gazeToLook, type EyeLook, type Gaze } from './gaze';
import type { EyeLookSource } from './eyes';

export const AIRPODS_TUNING = {
  url: 'ws://127.0.0.1:8765',
  /** Head turn, either way, that reaches the edge of the view (and starts turning her). */
  turnRange: 30 * DEG,
  /** Head tilt that reaches the furthest look up or down. */
  tiltRange: 22 * DEG,
  /** Smoothing rate, 1/s: the sensors are clean, so this can be quick. */
  smooth: 18,
  /** Seconds between attempts to reach the helper. */
  retry: 4,
  /** No motion for this long: the AirPods are out of the ears or asleep. */
  staleAfter: 1.5,
} as const;

const T = AIRPODS_TUNING;

export function isAirPodsLabel(label: string): boolean {
  return /airpods/i.test(label);
}

/** True when the browser's audio devices include AirPods (needs mic permission for names). */
export async function detectAirPods(): Promise<boolean> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.some((d) => (d.kind === 'audiooutput' || d.kind === 'audioinput') && isAirPodsLabel(d.label));
  } catch {
    return false;
  }
}

export interface Attitude {
  yaw: number;
  pitch: number;
}

/** Head attitude relative to the calibrated centre -> gaze (+x right, +y up; 1 = edge of range). */
export function attitudeToGaze(a: Attitude, centre: Attitude, opts: { flipX?: boolean; flipY?: boolean } = {}): Gaze {
  // CoreMotion yaw grows turning left; gaze +x is looking right.
  const x = -wrapAngle(a.yaw - centre.yaw) / T.turnRange;
  const y = (a.pitch - centre.pitch) / T.tiltRange;
  return { x: opts.flipX ? -x : x, y: opts.flipY ? -y : y };
}

export type AirPodsState = 'off' | 'connecting' | 'nohelper' | 'waiting' | 'on' | 'denied';

export interface AirPodsLook extends EyeLookSource {
  readonly state: AirPodsState;
  /** Start looking for the helper (call once AirPods are detected). */
  start(): void;
  stop(): void;
  recalibrate(): void;
  onChange(cb: () => void): () => void;
}

export function createAirPodsLook(opts: { flipX?: boolean; flipY?: boolean } = {}): AirPodsLook {
  let state: AirPodsState = 'off';
  let ws: WebSocket | null = null;
  let retryTimer = 0;
  let wanted = false;
  let centre: Attitude | null = null;
  let gaze: Gaze | null = null;
  let lastMotion = 0;
  let lastFrame = performance.now();
  const listeners = new Set<() => void>();

  const set = (s: AirPodsState) => {
    if (s === state) return;
    state = s;
    for (const cb of [...listeners]) cb();
  };

  const connect = () => {
    if (!wanted || ws) return;
    set(state === 'off' ? 'connecting' : state);
    let sock: WebSocket;
    try {
      sock = new WebSocket(T.url);
    } catch {
      set('nohelper');
      schedule();
      return;
    }
    ws = sock;
    sock.onmessage = (e) => {
      let msg: { type?: string; airpods?: string; auth?: string; yaw?: number; pitch?: number };
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (msg.type === 'status') {
        if (msg.auth === 'denied' || msg.auth === 'restricted') set('denied');
        else if (msg.airpods === 'connected') set('on');
        else set('waiting');
        if (msg.airpods !== 'connected') {
          centre = null;
          gaze = null;
        }
      } else if (msg.type === 'motion' && typeof msg.yaw === 'number' && typeof msg.pitch === 'number') {
        const a = { yaw: msg.yaw, pitch: msg.pitch };
        if (!centre) centre = a; // straight ahead = however the head is when tracking starts
        const target = attitudeToGaze(a, centre, opts);
        const now = performance.now();
        const dt = Math.min(0.1, (now - lastFrame) / 1000);
        lastFrame = now;
        gaze = gaze ? { x: damp(gaze.x, target.x, T.smooth, dt), y: damp(gaze.y, target.y, T.smooth, dt) } : target;
        lastMotion = now;
        if (state !== 'on') set('on');
      }
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      gaze = null;
      centre = null;
      if (wanted) {
        set('nohelper');
        schedule();
      }
    };
    sock.onerror = () => {
      /* onclose follows */
    };
  };

  const schedule = () => {
    window.clearTimeout(retryTimer);
    if (wanted) retryTimer = window.setTimeout(connect, T.retry * 1000);
  };

  return {
    get state() {
      return state;
    },
    read(): EyeLook | null {
      if (state !== 'on' || !gaze) return null;
      if (performance.now() - lastMotion > T.staleAfter * 1000) return null; // out of the ears or asleep
      return gazeToLook(gaze);
    },
    start() {
      if (wanted) return;
      wanted = true;
      connect();
    },
    stop() {
      wanted = false;
      window.clearTimeout(retryTimer);
      const sock = ws;
      ws = null;
      sock?.close();
      gaze = null;
      centre = null;
      set('off');
    },
    recalibrate() {
      centre = null;
      gaze = null;
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
