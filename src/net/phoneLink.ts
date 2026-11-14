/**
 * Game side of the phone controller: pairs through the relay, listens on the
 * game socket, and turns the phone's step messages into walking.
 * createStepRhythm is pure (no DOM) so it can be tested alone.
 */
import { parsePhoneMessage, phonePairPath, phoneWsPath, type PhonePairResponse } from '../../shared/phone';

export const STOP_AFTER_MS = 900;
/**
 * Once there is a pace, each step carries momentum: full speed until EASE_START step
 * times with no new step, then speed eases down to zero at EASE_END step times. A missed
 * or late step (next one at about 2 step times) becomes a dip in speed, not a stop.
 */
export const EASE_START = 1.3;
export const EASE_END = 2.3;
export const STOP_MIN_MS = 450;
export const MAX_COAST_MS = 1400;
/** Never coast to a stop sooner than this, even if the pace reads very quick: a misread pace must not cause stop-start walking. */
export const MIN_COAST_MS = 900;
export const HURRY_RATIO = 0.75;
/** Steps faster than this share of the normal interval are running in place (sprint). */
export const RUN_RATIO = 0.62;
/** Phone walking takes longer strides than the W key (1.45 m/s becomes about 1.8 m/s, still under the 2.0 m/s "sped up" line). Hurry speed is capped, so it is unchanged. */
export const PHONE_STRIDE = 1.25;
export const DEFAULT_NORMAL_MS = 550;
export const CALIBRATION_STEPS = 8;

export interface StepRhythm {
  step(phoneAtMs: number, receivedAtMs: number): void;
  state(nowMs: number): 'stopped' | 'walking' | 'hurrying' | 'running';
  /** Walking speed, 0 (stopped) .. 1 (full). */
  drive(nowMs: number): number;
  readonly normalMs: number;
  reset(): void;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function createStepRhythm(): StepRhythm {
  let lastAt: number | null = null;
  let lastReceived: number | null = null;
  let recent: number[] = [];
  let calibration: number[] = [];
  let normal = DEFAULT_NORMAL_MS;

  return {
    step(phoneAtMs, receivedAtMs) {
      lastReceived = receivedAtMs;
      const interval = lastAt === null ? null : phoneAtMs - lastAt;
      lastAt = phoneAtMs;
      // Pauses and a phone clock that went backwards are not rhythm.
      if (interval === null || interval <= 0 || interval > STOP_AFTER_MS) return;
      recent.push(interval);
      if (recent.length > 3) recent.shift();
      if (calibration.length < CALIBRATION_STEPS) {
        calibration.push(interval);
        if (calibration.length === CALIBRATION_STEPS) normal = median(calibration);
      }
    },
    drive(nowMs) {
      if (lastReceived === null) return 0;
      const gap = nowMs - lastReceived;
      if (!recent.length) return gap < STOP_AFTER_MS ? 1 : 0; // first step: no pace yet
      const pace = median(recent);
      const easeFrom = Math.max(STOP_MIN_MS, EASE_START * pace);
      const easeTo = Math.min(MAX_COAST_MS, Math.max(easeFrom + 1, MIN_COAST_MS, EASE_END * pace));
      if (gap <= easeFrom) return 1;
      return gap >= easeTo ? 0 : 1 - (gap - easeFrom) / (easeTo - easeFrom);
    },
    state(nowMs) {
      if (this.drive(nowMs) === 0) return 'stopped';
      if (!recent.length) return 'walking';
      // Running must be sustained (every recent step fast, not just the median) and measured against the
      // player's own calibrated pace, so a double-counted step or a naturally quick stepper never sets off a sprint.
      const calibrated = calibration.length >= CALIBRATION_STEPS;
      if (calibrated && recent.length === 3 && recent.every((i) => i < RUN_RATIO * normal)) return 'running';
      return median(recent) < HURRY_RATIO * normal ? 'hurrying' : 'walking';
    },
    get normalMs() {
      return normal;
    },
    reset() {
      lastAt = null;
      lastReceived = null;
      recent = [];
      calibration = [];
      normal = DEFAULT_NORMAL_MS;
    },
  };
}

export type PhoneStatus = 'off' | 'waiting' | 'connected' | 'lost';

export interface PhoneLink {
  pair(): Promise<void>;
  readonly code: string;
  readonly status: PhoneStatus;
  /** True once a phone has ever joined this pairing. */
  readonly everConnected: boolean;
  onChange(cb: () => void): () => void;
  move(nowMs: number): { forward: number; hurry: boolean; run: boolean };
  close(): void;
}

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 5000;
const MAX_REFUSALS = 3;
/** No message (hello heartbeat or step) from the phone for this long means it is gone. */
const SILENT_AFTER_MS = 6000;

export function createPhoneLink(): PhoneLink {
  const rhythm = createStepRhythm();
  const listeners = new Set<() => void>();
  let code = '';
  let status: PhoneStatus = 'off';
  let everConnected = false;
  let ws: WebSocket | null = null;
  let retry: number | undefined;
  let backoff = BACKOFF_MIN_MS;
  let refusals = 0;
  let pairing = false;
  let lastMsgAt = 0; // game clock of the last message from the phone

  const set = (next: PhoneStatus): void => {
    if (next === status) return;
    status = next;
    for (const cb of [...listeners]) cb();
  };

  const lose = (): void => {
    rhythm.reset();
    if (status === 'connected') set('lost');
  };

  function connect(): void {
    const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${phoneWsPath(code, 'game')}`);
    ws = sock;
    let opened = false;
    sock.onopen = () => {
      opened = true;
      refusals = 0;
      backoff = BACKOFF_MIN_MS;
    };
    sock.onmessage = (e) => {
      if (ws !== sock) return; // late message from a closed or replaced socket
      const m = parsePhoneMessage(e.data);
      if (!m) return;
      const now = performance.now();
      if (m.t === 'hello' || m.t === 'step') {
        lastMsgAt = now;
        if (status === 'lost') set('connected');
        if (m.t === 'step') rhythm.step(m.at, now);
      } else if (m.t === 'peer') {
        if (m.connected) {
          everConnected = true;
          lastMsgAt = now;
          set('connected');
        } else lose();
      }
    };
    sock.onclose = (e) => {
      if (ws !== sock) return; // closed on purpose
      ws = null;
      lose();
      if (e.code === 1000 && e.reason === 'replaced') {
        // another game tab took this code: do not fight for it
        code = '';
        set('off');
        return;
      }
      if (!opened && ++refusals >= MAX_REFUSALS) {
        code = '';
        set('off');
        return;
      }
      retry = window.setTimeout(connect, backoff);
      backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
    };
  }

  return {
    async pair() {
      if (status !== 'off' || pairing) return;
      pairing = true;
      try {
        const res = await fetch(phonePairPath, { method: 'POST' });
        if (!res.ok) return;
        const body = (await res.json()) as PhonePairResponse;
        if (typeof body.code !== 'string' || !body.code) return;
        code = body.code;
        refusals = 0;
        backoff = BACKOFF_MIN_MS;
        everConnected = false;
        set('waiting');
        connect();
      } catch {
        /* offline: stay off, the player can try again */
      } finally {
        pairing = false;
      }
    },
    get code() {
      return code;
    },
    get status() {
      return status;
    },
    get everConnected() {
      return everConnected;
    },
    onChange(cb) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    move(nowMs) {
      if (status === 'connected' && nowMs - lastMsgAt >= SILENT_AFTER_MS) lose();
      if (status !== 'connected') return { forward: 0, hurry: false, run: false };
      const state = rhythm.state(nowMs);
      return { forward: rhythm.drive(nowMs) * PHONE_STRIDE, hurry: state === 'hurrying' || state === 'running', run: state === 'running' };
    },
    close() {
      window.clearTimeout(retry);
      const sock = ws;
      ws = null;
      sock?.close();
      rhythm.reset();
      code = '';
      set('off');
    },
  };
}
