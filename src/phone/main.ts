/**
 * Phone controller page. Pairs with the game by code, reads the motion sensor,
 * detects steps (shared/stepDetector.ts) and sends them through the relay.
 * See docs/INTERACTIVE_CONTROLS_PLAN.md.
 */
import { isPhoneCode, parsePhoneMessage, phoneWsPath, type PhoneToGame } from '../../shared/phone';
import { createStepDetector } from '../../shared/stepDetector';

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 5000;
const HEARTBEAT_MS = 2000;
const MAX_FAILED_RECONNECTS = 3;

type UiState = 'idle' | 'connecting' | 'waiting' | 'connected' | 'reconnecting';

interface WakeLockLike {
  release(): Promise<void>;
  addEventListener(type: 'release', cb: () => void): void;
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

const form = el<HTMLFormElement>('form');
const codeInput = el<HTMLInputElement>('code');
const startBtn = el<HTMLButtonElement>('start');
const stateEl = el<HTMLElement>('state');
const messageEl = el<HTMLElement>('message');
const stepsWrap = el<HTMLElement>('steps-wrap');
const stepsEl = el<HTMLElement>('steps');
// Live tuning aid: time since the previous step and how hard the previous step was.
const readoutEl = el<HTMLElement>('readout');
let lastStepAt = 0;
const hintEl = el<HTMLElement>('hint');

const detector = createStepDetector();

let running = false;
let socket: WebSocket | null = null;
let everOpened = false;
let backoff = RECONNECT_MIN_MS;
let reconnectTimer: number | undefined;
let wakeLock: WakeLockLike | null = null;
let steps = 0;
let tickTimer: number | undefined;
let heartbeatTimer: number | undefined;
let failedReconnects = 0;

function clearHeartbeat(): void {
  window.clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
}

function setState(s: UiState): void {
  const labels: Record<UiState, [string, string]> = {
    idle: ['Not connected', 'idle'],
    connecting: ['Connecting...', 'idle'],
    reconnecting: ['Not connected. Reconnecting...', 'idle'],
    waiting: ['Waiting for the game', 'waiting'],
    connected: ['Connected to the game', 'connected'],
  };
  stateEl.textContent = labels[s][0];
  stateEl.dataset.state = labels[s][1];
}

function showMessage(text: string): void {
  messageEl.textContent = text;
  messageEl.hidden = text === '';
}

function setRunningUi(on: boolean): void {
  startBtn.textContent = on ? 'Stop' : 'Start';
  startBtn.dataset.mode = on ? 'stop' : 'start';
  codeInput.disabled = on;
  stepsWrap.hidden = !on;
  if (on) {
    // iOS "Shake to Undo": walking shakes the phone and offers to undo the typed code.
    // A real script change of the value (not same-value) drops the typing history.
    const code = codeInput.value;
    codeInput.value = '';
    codeInput.value = code;
    codeInput.blur();
  }
}

function normaliseCode(): string {
  const code = codeInput.value.trim().toUpperCase();
  codeInput.value = code;
  return code;
}

function send(m: PhoneToGame): void {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(m));
}

// ---- motion sensor ----------------------------------------------------------

function onMotion(e: DeviceMotionEvent): void {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x === null || a.y === null || a.z === null) return;
  const now = performance.now();
  if (detector.push(a.x, a.y, a.z, now)) {
    steps += 1;
    stepsEl.textContent = String(steps);
    stepsWrap.classList.add('tick');
    window.clearTimeout(tickTimer);
    tickTimer = window.setTimeout(() => stepsWrap.classList.remove('tick'), 150);
    const pace = lastStepAt > 0 ? (now - lastStepAt) / 1000 : 0;
    lastStepAt = now;
    readoutEl.textContent = `pace ${pace ? pace.toFixed(2) + ' s' : '-'}  ·  strength ${detector.lastPeak.toFixed(1)}`;
    send({ t: 'step', at: now, peak: detector.lastPeak });
  }
}

/** Returns an error message if motion access was refused, else null. */
async function requestMotionPermission(): Promise<string | null> {
  const DME = window.DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> } | undefined;
  if (!DME) return 'This browser has no motion sensor. Try Safari on iPhone or Chrome on Android.';
  if (typeof DME.requestPermission === 'function') {
    try {
      const result = await DME.requestPermission();
      if (result !== 'granted') {
        return 'Motion access was refused. Close this page, open it again and tap Allow. On iPhone you can also reset it in Settings > Safari > Advanced > Website Data.';
      }
    } catch {
      return 'Motion access could not be requested. Open this page over https and try again.';
    }
  }
  return null;
}

// ---- wake lock --------------------------------------------------------------

async function acquireWakeLock(): Promise<void> {
  const nav = navigator as unknown as { wakeLock?: { request(type: 'screen'): Promise<WakeLockLike> } };
  if (!running || wakeLock || !nav.wakeLock) return;
  try {
    const lock = await nav.wakeLock.request('screen');
    lock.addEventListener('release', () => {
      if (wakeLock === lock) wakeLock = null;
    });
    wakeLock = lock;
  } catch {
    // Not allowed or not supported: the screen may dim, the page still works.
  }
}

function releaseWakeLock(): void {
  const lock = wakeLock;
  wakeLock = null;
  if (lock) lock.release().catch(() => {});
}

function onVisibility(): void {
  if (document.visibilityState === 'visible') void acquireWakeLock();
}

// ---- socket -----------------------------------------------------------------

function wsUrl(code: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${phoneWsPath(code, 'phone')}`;
}

function connect(code: string): void {
  let opened = false;
  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl(code));
  } catch {
    stopAll();
    showMessage('Could not open a connection. Check the address and try again.');
    return;
  }
  socket = ws;

  ws.onopen = () => {
    opened = true;
    everOpened = true;
    backoff = RECONNECT_MIN_MS;
    failedReconnects = 0;
    setState('waiting');
    send({ t: 'hello' });
    clearHeartbeat();
    heartbeatTimer = window.setInterval(() => send({ t: 'hello' }), HEARTBEAT_MS);
  };

  ws.onmessage = (ev) => {
    const m = parsePhoneMessage(ev.data);
    if (m && m.t === 'peer') setState(m.connected ? 'connected' : 'waiting');
  };

  ws.onclose = (ev) => {
    if (socket !== ws) return;
    socket = null;
    clearHeartbeat();
    if (!running) return;
    if (ev.code === 1000 && ev.reason === 'replaced') {
      stopAll();
      showMessage('Another phone joined with this code.');
      return;
    }
    if (!opened && !everOpened) {
      stopAll();
      showMessage('Could not connect. The code may be wrong or expired. Check it, or get a new code from the game.');
      return;
    }
    if (!opened) {
      failedReconnects += 1;
      if (failedReconnects >= MAX_FAILED_RECONNECTS) {
        stopAll();
        showMessage('The code may have expired. Get a new code from the game.');
        return;
      }
    }
    setState('reconnecting');
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined;
      if (running) connect(code);
    }, backoff);
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
  };
}

// ---- lifecycle --------------------------------------------------------------

async function start(): Promise<void> {
  showMessage('');
  const code = normaliseCode();
  if (!isPhoneCode(code)) {
    showMessage('Enter the 6-character code shown in the game.');
    codeInput.focus();
    return;
  }
  startBtn.disabled = true;
  // Must be called straight from the tap, before any other await.
  const problem = await requestMotionPermission();
  startBtn.disabled = false;
  if (problem) {
    showMessage(problem);
    return;
  }

  running = true;
  everOpened = false;
  failedReconnects = 0;
  backoff = RECONNECT_MIN_MS;
  steps = 0;
  stepsEl.textContent = '0';
  readoutEl.textContent = '';
  lastStepAt = 0;
  detector.reset();
  setRunningUi(true);
  setState('connecting');
  window.addEventListener('devicemotion', onMotion);
  document.addEventListener('visibilitychange', onVisibility);
  void acquireWakeLock();
  connect(code);
}

function stopAll(): void {
  running = false;
  window.removeEventListener('devicemotion', onMotion);
  document.removeEventListener('visibilitychange', onVisibility);
  window.clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  clearHeartbeat();
  window.clearTimeout(tickTimer);
  stepsWrap.classList.remove('tick');
  const ws = socket;
  socket = null;
  if (ws) {
    ws.onopen = ws.onmessage = ws.onclose = null;
    ws.close();
  }
  releaseWakeLock();
  setRunningUi(false);
  setState('idle');
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (running) {
    stopAll();
    showMessage('');
  } else {
    void start();
  }
});

codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.toUpperCase();
});

window.addEventListener('pagehide', stopAll);

const preset = new URLSearchParams(location.search).get('code');
if (preset) codeInput.value = preset.trim().toUpperCase().slice(0, 6);
setRunningUi(false);
setState('idle');
hintEl.hidden = false;
