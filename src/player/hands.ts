/**
 * Webcam hand tracking: act with your hands.
 *
 * MediaPipe Hand Landmarker runs in the browser on the webcam frames shared
 * with eye look (vision.ts); nothing is uploaded. gestures.ts turns the hand
 * into events (pinch, palm, fist) that scenes map onto actions. Both hands are
 * tracked, each with its own detector: the LEFT hand pinches (the phone), the
 * RIGHT hand holds a fist (talking), and an open palm from either asks for
 * help. The keyboard keeps working. ?handswap=1 flips left and right, for a
 * camera whose image comes through the other way round.
 */

import type { HandLandmarker, NormalizedLandmark } from '@mediapipe/tasks-vision';
import { GestureDetector, type GestureEvent, type GestureState } from './gestures';
import { VISION_FILESET, cameraErrorMessage, modelUrl, subscribeFrames } from './vision';

export type { GestureEvent } from './gestures';

/** What scenes use: gesture events plus an on-screen hint line. */
export interface HandGestureSource {
  /** True while hands are being tracked. */
  readonly active: boolean;
  onGesture(cb: (g: GestureEvent) => void): () => void;
  /** Gesture hint near the bottom of the screen (null hides it). */
  setHint(text: string | null): void;
}

export type HandState = 'off' | 'loading' | 'on' | 'nohand' | 'error';

export interface HandTracker extends HandGestureSource {
  readonly state: HandState;
  enable(): Promise<void>;
  disable(): void;
  toggle(): void;
  dispose(): void;
}

async function loadHandLandmarker(): Promise<HandLandmarker> {
  const { HandLandmarker } = await import('@mediapipe/tasks-vision');
  const options = {
    runningMode: 'VIDEO' as const,
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  };
  const base = { modelAssetPath: modelUrl('hand_landmarker.task') };
  try {
    return await HandLandmarker.createFromOptions(VISION_FILESET, { ...options, baseOptions: { ...base, delegate: 'GPU' } });
  } catch {
    return await HandLandmarker.createFromOptions(VISION_FILESET, { ...options, baseOptions: { ...base, delegate: 'CPU' } });
  }
}

export type HandSide = 'left' | 'right';

/**
 * The player's hand from the model's label. MediaPipe labels handedness as if the image were mirrored
 * (a selfie view); webcam frames are not, so its 'Left' is the player's right hand. `swap` undoes that
 * for a camera that delivers a mirrored image.
 */
export function sideFromLabel(label: string | undefined, swap: boolean): HandSide | null {
  if (label !== 'Left' && label !== 'Right') return null;
  const side: HandSide = label === 'Left' ? 'right' : 'left';
  return swap ? (side === 'left' ? 'right' : 'left') : side;
}

/** Which hand each gesture belongs to: pinch is the left hand's, the fist is the right hand's, a palm either. */
export function gestureAllowed(side: HandSide, g: GestureEvent): boolean {
  if (g === 'pinch') return side === 'left';
  if (g === 'fist' || g === 'fistEnd') return side === 'right';
  return true;
}

/** One state for the badge from both hands: the right hand's fist, the left hand's pinch, either's palm. */
export function mergeHands(left: GestureState, right: GestureState): GestureState {
  return {
    present: left.present || right.present,
    pinching: left.pinching,
    pinchRatio: left.pinchRatio,
    palm: left.palm || right.palm,
    fist: right.fist,
    fistHeld: right.fistHeld,
  };
}

export function createHandTracker(): HandTracker {
  const detectors: Record<HandSide, GestureDetector> = { left: new GestureDetector(), right: new GestureDetector() };
  const swap = typeof location !== 'undefined' && new URLSearchParams(location.search).get('handswap') === '1';
  const listeners = new Set<(g: GestureEvent) => void>();
  const ui = createIndicator();

  let state: HandState = 'off';
  let landmarker: HandLandmarker | null = null;
  let landmarkerLoad: Promise<HandLandmarker> | null = null;
  let unsubscribe: (() => void) | null = null;
  let disposed = false;
  let generation = 0;
  let hint: string | null = null;

  function setState(s: HandState, detail?: string): void {
    state = s;
    ui.show(s, detail);
    ui.hint(s === 'on' || s === 'nohand' ? hint : null);
  }

  function frame(video: HTMLVideoElement, now: number, dt: number): void {
    if (!landmarker) return;
    const seen: Record<HandSide, NormalizedLandmark[] | null> = { left: null, right: null };
    try {
      const res = landmarker.detectForVideo(video, now);
      res.landmarks.forEach((points, i) => {
        const side = sideFromLabel(res.handedness?.[i]?.[0]?.categoryName, swap);
        if (side && !seen[side]) seen[side] = points;
      });
    } catch (err) {
      console.warn('hands: detection failed', err);
    }
    const events: GestureEvent[] = [];
    for (const side of ['left', 'right'] as const) {
      for (const e of detectors[side].push(seen[side], dt)) if (gestureAllowed(side, e)) events.push(e);
    }
    const merged = mergeHands(detectors.left.state, detectors.right.state);
    if (merged.present && state === 'nohand') setState('on');
    if (!merged.present && state === 'on') setState('nohand');
    ui.pose(merged);
    for (const e of events) {
      ui.flash(e);
      for (const cb of [...listeners]) cb(e);
    }
  }

  async function enable(): Promise<void> {
    if (disposed || state !== 'off') return;
    const gen = ++generation;
    setState('loading');
    try {
      landmarker = await (landmarkerLoad ??= loadHandLandmarker().catch((err) => {
        landmarkerLoad = null;
        throw err;
      }));
      if (gen !== generation || disposed) return;
      const unsub = await subscribeFrames(frame);
      if (gen !== generation || disposed) {
        unsub();
        return;
      }
      unsubscribe = unsub;
      detectors.left.reset();
      detectors.right.reset();
      setState('nohand');
    } catch (err) {
      if (gen !== generation) return;
      console.warn('hands:', err);
      setState('error', cameraErrorMessage('Hand tracking', err, 'H'));
      setTimeout(() => {
        if (state === 'error') setState('off');
      }, 4000);
    }
  }

  function disable(): void {
    generation++;
    unsubscribe?.();
    unsubscribe = null;
    detectors.left.reset();
    detectors.right.reset();
    setState('off');
  }

  return {
    get state() {
      return state;
    },
    get active() {
      return state === 'on' || state === 'nohand';
    },
    onGesture(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    setHint(text) {
      if (text === hint) return;
      hint = text;
      ui.hint(state === 'on' || state === 'nohand' ? hint : null);
    },
    enable,
    disable,
    toggle() {
      if (state === 'off' || state === 'error') {
        state = 'off';
        void enable();
      } else disable();
    },
    dispose() {
      disposed = true;
      disable();
      landmarker?.close();
      landmarker = null;
      listeners.clear();
      ui.remove();
    },
  };
}

/* ------------------------------------------------------------- indicator */

/** The badge's emoji for what the hand is doing: a fist (hold to talk) first, then pinch, open palm, any hand. */
export function handIcon(s: GestureState): string {
  if (s.fist) return '✊';
  if (s.pinching) return '🤏';
  if (s.palm) return '🖐️';
  return '✋';
}

interface Indicator {
  show(state: HandState, detail?: string): void;
  pose(s: GestureState): void;
  flash(e: GestureEvent): void;
  hint(text: string | null): void;
  remove(): void;
}

const CSS = `
.oit-hands{position:fixed;top:98px;right:14px;z-index:60;display:flex;align-items:center;gap:8px;padding:6px 10px 6px 8px;border-radius:999px;background:rgba(10,12,16,.72);color:#e9edf2;font:500 12px/1.2 system-ui,-apple-system,sans-serif;pointer-events:none;backdrop-filter:blur(6px)}
.oit-hands[hidden],.oit-hands-hint[hidden]{display:none}
.oit-hands-icon{width:22px;text-align:center;font-size:15px;line-height:1;opacity:.45;transition:opacity .15s,transform .15s}
.oit-hands-icon[data-seen]{opacity:1}
.oit-hands-icon[data-flash]{transform:scale(1.35)}
.oit-hands-hint{position:fixed;left:50%;bottom:26%;z-index:58;transform:translateX(-50%);padding:8px 14px;border-radius:999px;background:rgba(10,12,16,.62);color:#fff;font:500 14px/1.2 system-ui,-apple-system,sans-serif;pointer-events:none;white-space:nowrap}
`;

const LABEL: Record<HandState, string> = {
  off: '',
  loading: 'Hands: starting camera…',
  on: 'Hands on · H to turn off',
  nohand: 'Hands: raise a hand to the camera',
  error: 'Hand tracking unavailable',
};

function createIndicator(): Indicator {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);

  const pill = document.createElement('div');
  pill.className = 'oit-hands';
  pill.hidden = true;
  pill.setAttribute('role', 'status');
  pill.setAttribute('aria-live', 'polite');
  pill.title = 'Webcam frames are processed on this device and never uploaded.';
  const icon = document.createElement('span');
  icon.className = 'oit-hands-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '✋';
  const label = document.createElement('span');
  pill.append(icon, label);

  const hintEl = document.createElement('div');
  hintEl.className = 'oit-hands-hint';
  hintEl.hidden = true;

  document.body.append(pill, hintEl);
  let flashTimer: ReturnType<typeof setTimeout> | null = null;

  return {
    show(state, detail) {
      pill.hidden = state === 'off';
      label.textContent = detail ?? LABEL[state];
    },
    pose(s) {
      icon.toggleAttribute('data-seen', s.present);
      icon.textContent = handIcon(s);
    },
    flash() {
      icon.setAttribute('data-flash', '');
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = setTimeout(() => icon.removeAttribute('data-flash'), 180);
    },
    hint(text) {
      hintEl.hidden = !text;
      if (text) hintEl.textContent = text;
    },
    remove() {
      if (flashTimer) clearTimeout(flashTimer);
      pill.remove();
      hintEl.remove();
      style.remove();
    },
  };
}
