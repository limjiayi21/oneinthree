/**
 * Webcam head look: the player looks around by turning their head.
 *
 * MediaPipe Face Landmarker runs in the browser on webcam frames; no frame
 * leaves the device. gaze.ts turns the head's direction into a glance (a
 * head turn the body does not follow) plus a slow body turn while the head
 * is held turned near the edge. Eye direction is ignored, so the eyes stay
 * free to read the screen. The mouse keeps working.
 *
 * The MediaPipe bundle is only fetched when head look is first switched on.
 * The model ships in public/models so it works without internet. The webcam
 * is shared with hand tracking (vision.ts).
 */

import type { FaceLandmarker } from '@mediapipe/tasks-vision';
import { GazeFilter, gazeFromFace, gazeToLook, type EyeLook, type Gaze } from './gaze';
import { VISION_FILESET, cameraErrorMessage, modelUrl, subscribeFrames } from './vision';

export type { EyeLook } from './gaze';

/** What the player controller reads each frame. */
export interface EyeLookSource {
  /** Current look, or null when off, calibrating or no face is seen. */
  read(): EyeLook | null;
}

export type EyeState = 'off' | 'loading' | 'calibrating' | 'on' | 'noface' | 'error';

export interface EyeTracker extends EyeLookSource {
  readonly state: EyeState;
  enable(): Promise<void>;
  disable(): void;
  toggle(): void;
  recalibrate(): void;
  dispose(): void;
}

export interface EyeTrackerOptions {
  /** Multiplies head movement; above 1 needs a smaller turn. */
  sensitivity?: number;
  /** Overrides `sensitivity` for up/down only. */
  verticalSensitivity?: number;
}

const CALIBRATION_SECONDS = 1.4;

async function loadFaceLandmarker(): Promise<FaceLandmarker> {
  const { FaceLandmarker } = await import('@mediapipe/tasks-vision');
  const options = {
    runningMode: 'VIDEO' as const,
    numFaces: 1,
    outputFaceBlendshapes: false,
    minFaceDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  };
  const base = { modelAssetPath: modelUrl('face_landmarker.task') };
  try {
    return await FaceLandmarker.createFromOptions(VISION_FILESET, { ...options, baseOptions: { ...base, delegate: 'GPU' } });
  } catch {
    return await FaceLandmarker.createFromOptions(VISION_FILESET, { ...options, baseOptions: { ...base, delegate: 'CPU' } });
  }
}

export function createEyeTracker(opts: EyeTrackerOptions = {}): EyeTracker {
  const sensitivity = opts.sensitivity && opts.sensitivity > 0 ? opts.sensitivity : 1;
  const sensitivityY = opts.verticalSensitivity && opts.verticalSensitivity > 0 ? opts.verticalSensitivity : sensitivity;
  const filter = new GazeFilter();
  const ui = createIndicator();

  let state: EyeState = 'off';
  let landmarker: FaceLandmarker | null = null;
  let landmarkerLoad: Promise<FaceLandmarker> | null = null;
  let unsubscribe: (() => void) | null = null;
  let calibrationEnds = 0;
  let gaze: Gaze | null = null;
  let disposed = false;
  let generation = 0; // bumps on disable, so a slow enable() can tell it was cancelled
  let retry: ReturnType<typeof setTimeout> | null = null;

  function setState(s: EyeState, detail?: string): void {
    state = s;
    ui.show(s, detail);
  }

  function startCalibration(): void {
    filter.beginCalibration();
    calibrationEnds = performance.now() + CALIBRATION_SECONDS * 1000;
    setState('calibrating');
  }

  function startCalibrationSoon(): void {
    if (retry) clearTimeout(retry);
    retry = setTimeout(() => {
      retry = null;
      if (unsubscribe) startCalibration();
    }, 900);
  }

  function frame(video: HTMLVideoElement, now: number, dt: number): void {
    if (!landmarker) return;
    let raw = null;
    try {
      const res = landmarker.detectForVideo(video, now);
      const points = res.faceLandmarks[0];
      if (points) raw = gazeFromFace(points, sensitivity, sensitivityY);
    } catch (err) {
      console.warn('head look: detection failed', err);
    }
    filter.push(raw, dt);

    if (filter.isCalibrating) {
      if (now >= calibrationEnds) {
        if (filter.endCalibration()) setState('on');
        else {
          setState('noface');
          startCalibrationSoon();
        }
      }
    } else if (state === 'on' || state === 'noface') {
      const seen = filter.value() !== null;
      if (seen && state === 'noface') setState('on');
      if (!seen && state === 'on') setState('noface');
    }
    gaze = filter.value();
    ui.dot(gaze);
  }

  async function enable(): Promise<void> {
    if (disposed || state !== 'off') return;
    const gen = ++generation;
    setState('loading');
    try {
      landmarker = await (landmarkerLoad ??= loadFaceLandmarker().catch((err) => {
        landmarkerLoad = null; // let the next G retry the download
        throw err;
      }));
      if (gen !== generation || disposed) return;
      const unsub = await subscribeFrames(frame);
      if (gen !== generation || disposed) {
        unsub();
        return;
      }
      unsubscribe = unsub;
      startCalibration();
    } catch (err) {
      if (gen !== generation) return;
      console.warn('head look:', err);
      setState('error', cameraErrorMessage('Head look', err, 'G'));
      setTimeout(() => {
        if (state === 'error') setState('off');
      }, 4000);
    }
  }

  function disable(): void {
    generation++;
    unsubscribe?.();
    unsubscribe = null;
    if (retry) clearTimeout(retry);
    retry = null;
    gaze = null;
    if (filter.isCalibrating) filter.endCalibration();
    setState('off');
  }

  return {
    get state() {
      return state;
    },
    read() {
      if (state !== 'on' || !gaze) return null;
      return gazeToLook(gaze);
    },
    enable,
    disable,
    toggle() {
      if (state === 'off' || state === 'error') {
        state = 'off';
        void enable();
      } else disable();
    },
    recalibrate() {
      if (unsubscribe) startCalibration();
    },
    dispose() {
      disposed = true;
      disable();
      landmarker?.close();
      landmarker = null;
      ui.remove();
    },
  };
}

/* ------------------------------------------------------------- indicator */

interface Indicator {
  show(state: EyeState, detail?: string): void;
  dot(g: Gaze | null): void;
  remove(): void;
}

const CSS = `
.oit-eyes{position:fixed;top:60px;right:14px;z-index:60;display:flex;align-items:center;gap:8px;padding:6px 10px 6px 8px;border-radius:999px;background:rgba(10,12,16,.72);color:#e9edf2;font:500 12px/1.2 system-ui,-apple-system,sans-serif;pointer-events:none;backdrop-filter:blur(6px);transition:opacity .3s}
.oit-eyes[hidden]{display:none}
.oit-eyes-pad{position:relative;width:34px;height:22px;border-radius:5px;background:rgba(255,255,255,.08);box-shadow:inset 0 0 0 1px rgba(255,255,255,.18)}
.oit-eyes-pad::after{content:"";position:absolute;inset:7px 13px;border-radius:2px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.12)}
.oit-eyes-dot{position:absolute;left:50%;top:50%;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;background:#8fd3ff;opacity:0;transition:opacity .2s}
.oit-eyes-center{position:fixed;inset:0;z-index:59;display:grid;place-items:center;pointer-events:none}
.oit-eyes-center[hidden]{display:none}
.oit-eyes-target{display:grid;justify-items:center;gap:14px;color:#fff;font:500 15px/1.3 system-ui,-apple-system,sans-serif;text-shadow:0 1px 6px rgba(0,0,0,.8)}
.oit-eyes-target i{width:14px;height:14px;border-radius:50%;background:#8fd3ff;box-shadow:0 0 0 6px rgba(143,211,255,.25),0 0 24px rgba(143,211,255,.8);animation:oit-eyes-pulse 1.1s ease-in-out infinite}
@keyframes oit-eyes-pulse{50%{transform:scale(.7)}}
@media (prefers-reduced-motion:reduce){.oit-eyes-target i{animation:none}}
`;

const LABEL: Record<EyeState, string> = {
  off: '',
  loading: 'Head look: starting camera…',
  calibrating: 'Head look: calibrating',
  on: 'Head look on · G to turn off',
  noface: 'Head look: can’t see your face',
  error: 'Head look unavailable',
};

function createIndicator(): Indicator {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);

  const pill = document.createElement('div');
  pill.className = 'oit-eyes';
  pill.hidden = true;
  pill.setAttribute('role', 'status');
  pill.setAttribute('aria-live', 'polite');
  pill.title = 'Webcam frames are processed on this device and never uploaded.';
  const pad = document.createElement('div');
  pad.className = 'oit-eyes-pad';
  const dotEl = document.createElement('div');
  dotEl.className = 'oit-eyes-dot';
  pad.append(dotEl);
  const label = document.createElement('span');
  pill.append(pad, label);

  const center = document.createElement('div');
  center.className = 'oit-eyes-center';
  center.hidden = true;
  center.innerHTML = '<div class="oit-eyes-target"><i></i><span>Face the dot and hold still</span></div>';

  document.body.append(pill, center);

  return {
    show(state, detail) {
      pill.hidden = state === 'off';
      label.textContent = detail ?? LABEL[state];
      center.hidden = state !== 'calibrating';
      if (state !== 'on') dotEl.style.opacity = '0';
    },
    dot(g) {
      if (!g) {
        dotEl.style.opacity = '0';
        return;
      }
      const x = Math.max(-1, Math.min(1, g.x));
      const y = Math.max(-1, Math.min(1, g.y));
      dotEl.style.opacity = '1';
      dotEl.style.transform = `translate(${x * 14}px, ${-y * 8}px)`;
    },
    remove() {
      pill.remove();
      center.remove();
      style.remove();
    },
  };
}
