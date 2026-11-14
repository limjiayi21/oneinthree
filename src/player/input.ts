/**
 * Keyboard + pointer-lock input for the player controller.
 *
 * Bound keys: W A S D, the arrow keys and Shift. Nothing else: Space, T, F
 * and E belong to the scene director and are never read or preventDefault-ed
 * here. All key input is ignored while a text field has focus.
 *
 * With `requireLock: false` (automation / accessibility fallback) the keys
 * work without pointer lock, Arrow-Left / Arrow-Right turn the view instead
 * of strafing, and dragging the mouse with a button held looks around.
 */

export interface MoveIntent {
  /** -1 (back) .. 1 (forward) */
  forward: number;
  /** -1 (left) .. 1 (right) */
  strafe: number;
  /** -1 (turn right) .. 1 (turn left); only used without pointer lock */
  turn: number;
  hurry: boolean;
}

export interface PlayerInput {
  readonly locked: boolean;
  read(out: MoveIntent): MoveIntent;
  requestLock(): void;
  releaseLock(): void;
  /** Forget every held key (focus loss, lock loss, cutscene). */
  clear(): void;
  dispose(): void;
}

export interface InputOptions {
  requireLock: boolean;
  /**
   * May a click on the canvas take the pointer lock back? Asked when the lock
   * was wanted (requestLock) but is not held, e.g. the browser refused a
   * re-lock made too soon after Esc.
   */
  canRelock(): boolean;
  /** Raw mouse deltas in CSS pixels. */
  onLook(dx: number, dy: number): void;
  onLock(): void;
  onUnlock(): void;
}

const MOVE_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight']);
const ARROWS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
/** Largest believable single mouse delta; some browsers emit huge spurious jumps while locked. */
const MAX_MOUSE_DELTA = 400;

function isTextField(el: EventTarget | Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export function createInput(dom: HTMLElement, opts: InputOptions): PlayerInput {
  const held = new Set<string>();
  const doc = dom.ownerDocument;
  const win = doc.defaultView ?? window;
  let pointerLocked = false;
  let virtualLock = false; // requireLock === false: 'lock' is announced once, on the first requestLock()
  let dragging = false;
  let disposed = false;
  let wantLock = false; // requestLock() was called and releaseLock() has not been since

  const active = () => (opts.requireLock ? pointerLocked : true);

  const onKeyDown = (e: KeyboardEvent) => {
    if (!MOVE_CODES.has(e.code)) return;
    if (isTextField(e.target) || isTextField(doc.activeElement)) return;
    if (!active()) return;
    // Browser / OS shortcuts (Cmd+Left, Ctrl+W ...) are not movement. On macOS the
    // keyup of a key held with Cmd never arrives, so drop everything held as well.
    if (e.metaKey || e.ctrlKey || e.altKey) {
      held.clear();
      return;
    }
    held.add(e.code);
    if (ARROWS.has(e.code)) e.preventDefault(); // arrows would scroll the page
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'MetaLeft' || e.code === 'MetaRight') {
      held.clear();
      return;
    }
    held.delete(e.code);
  };

  const clear = () => {
    held.clear();
    dragging = false;
  };

  const onBlur = () => clear();
  const onVisibility = () => {
    if (doc.visibilityState !== 'visible') clear();
  };
  const onFocusIn = (e: FocusEvent) => {
    if (isTextField(e.target)) clear();
  };

  const onLockChange = () => {
    const now = doc.pointerLockElement === dom;
    if (now === pointerLocked) return;
    pointerLocked = now;
    if (!opts.requireLock) return; // virtual lock: real pointer-lock changes are irrelevant
    if (now) {
      opts.onLock();
    } else {
      clear();
      opts.onUnlock();
    }
  };
  const onLockError = () => {
    // Refused (no user gesture, or re-requested too soon after Esc). The caller
    // sees isLocked === false and can ask again on the next click.
  };

  const onMouseMove = (e: MouseEvent) => {
    const viaLock = opts.requireLock ? pointerLocked : doc.pointerLockElement === dom;
    const viaDrag = !opts.requireLock && dragging && e.buttons !== 0;
    if (!viaLock && !viaDrag) return;
    let dx = e.movementX || 0;
    let dy = e.movementY || 0;
    if (Math.abs(dx) > MAX_MOUSE_DELTA || Math.abs(dy) > MAX_MOUSE_DELTA) return;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    if (dx === 0 && dy === 0) return;
    opts.onLook(dx, dy);
  };
  const lockNow = () => {
    if (doc.pointerLockElement === dom) return;
    try {
      const res = dom.requestPointerLock() as unknown;
      if (res && typeof (res as Promise<void>).catch === 'function') (res as Promise<void>).catch(() => {});
    } catch {
      /* not available: isLocked stays false */
    }
  };
  const onMouseDown = (e: MouseEvent) => {
    if (e.target !== dom) return;
    if (!opts.requireLock) dragging = true;
    else if (wantLock && !pointerLocked && opts.canRelock()) lockNow();
  };
  const onMouseUp = () => {
    dragging = false;
  };

  win.addEventListener('keydown', onKeyDown);
  win.addEventListener('keyup', onKeyUp);
  win.addEventListener('blur', onBlur);
  win.addEventListener('mouseup', onMouseUp);
  doc.addEventListener('visibilitychange', onVisibility);
  doc.addEventListener('focusin', onFocusIn);
  doc.addEventListener('pointerlockchange', onLockChange);
  doc.addEventListener('pointerlockerror', onLockError);
  doc.addEventListener('mousemove', onMouseMove);
  dom.addEventListener('mousedown', onMouseDown);

  const down = (code: string) => held.has(code);

  return {
    get locked() {
      // Without the lock requirement the controller always counts as "locked".
      return opts.requireLock ? pointerLocked : true;
    },

    read(out) {
      out.forward = 0;
      out.strafe = 0;
      out.turn = 0;
      out.hurry = false;
      if (!active() || held.size === 0) return out;
      if (isTextField(doc.activeElement)) {
        held.clear();
        return out;
      }
      const arrowsTurn = !opts.requireLock;
      if (down('KeyW') || down('ArrowUp')) out.forward += 1;
      if (down('KeyS') || down('ArrowDown')) out.forward -= 1;
      if (down('KeyD') || (!arrowsTurn && down('ArrowRight'))) out.strafe += 1;
      if (down('KeyA') || (!arrowsTurn && down('ArrowLeft'))) out.strafe -= 1;
      if (arrowsTurn) {
        if (down('ArrowLeft')) out.turn += 1;
        if (down('ArrowRight')) out.turn -= 1;
      }
      out.hurry = down('ShiftLeft') || down('ShiftRight');
      return out;
    },

    requestLock() {
      if (disposed) return;
      if (!opts.requireLock) {
        if (!virtualLock) {
          virtualLock = true;
          // Deferred so a listener attached right after requestLock() still hears it.
          queueMicrotask(() => {
            if (!disposed && virtualLock) opts.onLock();
          });
        }
        return;
      }
      wantLock = true;
      lockNow();
    },

    releaseLock() {
      clear();
      wantLock = false;
      if (!opts.requireLock) return; // virtual lock never "unlocks": no pause overlay in this mode
      if (doc.pointerLockElement === dom) doc.exitPointerLock();
    },

    clear,

    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
      win.removeEventListener('keydown', onKeyDown);
      win.removeEventListener('keyup', onKeyUp);
      win.removeEventListener('blur', onBlur);
      win.removeEventListener('mouseup', onMouseUp);
      doc.removeEventListener('visibilitychange', onVisibility);
      doc.removeEventListener('focusin', onFocusIn);
      doc.removeEventListener('pointerlockchange', onLockChange);
      doc.removeEventListener('pointerlockerror', onLockError);
      doc.removeEventListener('mousemove', onMouseMove);
      dom.removeEventListener('mousedown', onMouseDown);
      if (doc.pointerLockElement === dom) doc.exitPointerLock();
    },
  };
}
