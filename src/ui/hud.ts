/**
 * The in-simulation HUD: everything drawn over the 3D view.
 *
 * Layering, bottom to top:
 *   world layer   fear vignette, filming overlay, objective, reticle, prompt, hint, mic
 *   fade          the black used by fade()
 *   text layer    subtitles and her inner voice (they stay readable over black,
 *                 so a thought can land after a cut to black)
 *   ask           typed-speech input
 *   card          text card over black
 *   pause         pause overlay
 *
 * The root never takes pointer events; only the typed-speech input and the
 * pause overlay do. Nothing is placed over the centre of the view except the
 * reticle dot and the context prompt directly beneath it.
 */

import './base.css';
import './hud.css';
import type { Hud, MicState } from '../contracts';
import type { PhoneLink } from '../net/phoneLink';
import { add, clamp, clamp01, ensureFonts, h, keycap, nextId, reducedMotion, reflow, splitKeyPrompt, trapFocus, withKeycaps } from './dom';

type Speaker = 'man' | 'woman' | 'you' | 'clerk';

const SPEAKER_LABEL: Record<Speaker, string> = { man: 'Man', woman: 'Woman', you: 'You', clerk: 'Clerk' };

/** Longest run of text that still fits on two subtitle lines at every supported width. */
const SUBTITLE_CHUNK = 104;

/** Break a long line into two-line pages, preferring sentence ends, then clause breaks. */
export function splitSubtitle(text: string, max = SUBTITLE_CHUNK): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean ? [clean] : [];
  const pages: string[] = [];
  let rest = clean;
  while (rest.length > max) {
    const windowText = rest.slice(0, max + 1);
    const floor = Math.floor(max * 0.4);
    let cut = -1;
    for (const pattern of [/[.!?…]["'”’)]?\s/g, /[,;:]\s|\s[–—-]\s/g, /\s/g]) {
      for (const match of windowText.matchAll(pattern)) {
        const end = (match.index ?? 0) + match[0].length;
        if (end >= floor && end > cut) cut = end;
      }
      if (cut > 0) break;
    }
    if (cut <= 0) cut = max;
    pages.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pages.push(rest);
  return pages;
}

const subtitleMs = (text: string): number => clamp(1300 + text.length * 62, 2200, 14000);
const thoughtMs = (words: number): number => clamp(2000 + words * 400, 3000, 9500);

function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function createHud(root: HTMLElement, phone?: PhoneLink): Hud {
  ensureFonts();
  root.classList.add('oit-root', 'oit-hud');

  let disposed = false;
  const timers = new Set<number>();
  const later = (fn: () => void, ms: number): number => {
    const id = window.setTimeout(() => {
      timers.delete(id);
      if (!disposed) fn();
    }, Math.max(0, ms));
    timers.add(id);
    return id;
  };
  const cancel = (id: number | undefined): void => {
    if (id === undefined) return;
    window.clearTimeout(id);
    timers.delete(id);
  };

  /* ------------------------------------------------------------ structure */

  const fearPulse = h('i');
  const fearEl = h(
    'div',
    { class: 'oit-fear', 'aria-hidden': 'true' },
    h('div', { class: 'oit-fear-base' }),
    h('div', { class: 'oit-fear-pulse' }, fearPulse),
  );

  const filmTime = h('span', { class: 'oit-film-time' }, '00:00');
  const filmEl = h(
    'div',
    { class: 'oit-film', 'aria-hidden': 'true' },
    h('i', { class: 'oit-film-c oit-film-c--tl' }),
    h('i', { class: 'oit-film-c oit-film-c--tr' }),
    h('i', { class: 'oit-film-c oit-film-c--bl' }),
    h('i', { class: 'oit-film-c oit-film-c--br' }),
    h('div', { class: 'oit-film-rec' }, h('span', { class: 'oit-film-dot' }), h('span', { class: 'oit-film-label' }, 'REC'), filmTime),
  );

  const objectiveEl = h('div', { class: 'oit-objective', role: 'status' });
  const reticleEl = h('div', { class: 'oit-reticle', 'aria-hidden': 'true' });
  const promptEl = h('div', { class: 'oit-prompt', role: 'status' });
  const hintEl = h('div', { class: 'oit-hint', role: 'status' });

  const micEl = h(
    'div',
    { class: 'oit-mic', 'data-state': 'hidden', 'aria-hidden': 'true' },
    h('div', { class: 'oit-mic-face', 'data-face': 'idle' }, h('span', { class: 'oit-mic-l' }, 'Hold'), keycap('Space'), h('span', { class: 'oit-mic-r' }, 'to speak')),
    h(
      'div',
      { class: 'oit-mic-face', 'data-face': 'recording' },
      h('span', { class: 'oit-mic-l' }, 'Listening'),
      h('span', { class: 'oit-ring' }, h('i'), h('b')),
      h('span', { class: 'oit-mic-r' }, 'Release to send'),
    ),
    h('div', { class: 'oit-mic-face', 'data-face': 'thinking' }, h('span', { class: 'oit-mic-l' }), h('span', { class: 'oit-ring oit-ring--wait' }, h('i'), h('b')), h('span', { class: 'oit-mic-r' })),
    h('div', { class: 'oit-mic-face', 'data-face': 'unavailable' }, h('span', { class: 'oit-mic-l' }, 'Press'), keycap('T'), h('span', { class: 'oit-mic-r' }, 'to type instead')),
  );
  const micStatus = h('div', { class: 'oit-sr', role: 'status' });

  // Shown only while a phone that was paired is lost: walking is on the keyboard again.
  const phoneEl = h('div', { class: 'oit-phone-lost', role: 'status' });
  const offPhone = phone?.onChange(() => {
    const lost = phone.status === 'lost';
    phoneEl.textContent = lost ? 'Phone lost. Walk with the keyboard.' : '';
    phoneEl.classList.toggle('is-on', lost);
  });

  const worldLayer = h('div', { class: 'oit-hud-world' }, fearEl, filmEl, objectiveEl, reticleEl, promptEl, hintEl, micEl, micStatus, phoneEl);

  const fadeEl = h('div', { class: 'oit-fade', 'aria-hidden': 'true' });

  const thoughtZone = h('div', { class: 'oit-thought-zone', 'aria-hidden': 'true' });
  const thoughtLive = h('div', { class: 'oit-sr', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const subWho = h('span', { class: 'oit-sub-who' });
  const subText = h('span', { class: 'oit-sub-text' });
  const subEl = h('div', { class: 'oit-sub', 'aria-hidden': 'true' }, h('div', { class: 'oit-sub-box' }, subWho, subText));
  const subLive = h('div', { class: 'oit-sr', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const textLayer = h('div', { class: 'oit-hud-text' }, thoughtZone, thoughtLive, subEl, subLive);

  const overlayLayer = h('div', { class: 'oit-hud-over' });

  add(root, worldLayer, fadeEl, textLayer, overlayLayer);

  /* ------------------------------------------------------------- subtitle */

  let subTimers: number[] = [];
  const clearSubTimers = (): void => {
    subTimers.forEach(cancel);
    subTimers = [];
  };

  function clearSubtitle(): void {
    clearSubTimers();
    subEl.classList.remove('is-on');
  }

  function subtitle(speaker: Speaker, text: string, ms?: number): void {
    clearSubTimers();
    const pages = splitSubtitle(text);
    if (pages.length === 0) {
      clearSubtitle();
      return;
    }
    const who: Speaker = speaker in SPEAKER_LABEL ? speaker : 'man';
    const total = ms !== undefined && ms > 0 ? ms : pages.reduce((sum, page) => sum + subtitleMs(page), 0);
    const weight = pages.reduce((sum, page) => sum + page.length + 18, 0);

    subEl.dataset.speaker = who;
    subWho.textContent = SPEAKER_LABEL[who];
    subLive.textContent = `${SPEAKER_LABEL[who]}: ${pages.join(' ')}`;

    let at = 0;
    pages.forEach((page, index) => {
      const show = (): void => {
        subText.textContent = page;
        subEl.classList.add('is-on');
      };
      if (index === 0) show();
      else subTimers.push(later(show, at));
      at += (total * (page.length + 18)) / weight;
    });
    subTimers.push(later(() => subEl.classList.remove('is-on'), total));
  }

  /* -------------------------------------------------------------- thought */

  let thoughtTimer: number | undefined;
  let currentThought: HTMLElement | null = null;

  function retireThought(el: HTMLElement): void {
    el.classList.remove('is-on');
    el.classList.add('is-leaving');
    later(() => el.remove(), 900);
  }

  function thought(text: string, intensity = 0.3, ms?: number): void {
    cancel(thoughtTimer);
    thoughtTimer = undefined;
    const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);

    // Never more than one thought leaving and one arriving: older ones go at once.
    thoughtZone.querySelectorAll('.is-leaving').forEach((el) => el.remove());
    if (currentThought) {
      retireThought(currentThought);
      currentThought = null;
    }
    if (words.length === 0) {
      thoughtLive.textContent = '';
      return;
    }

    const level = clamp01(intensity);
    // Words arrive faster when she is frightened; the whole line lands within ~1.3 s.
    const step = Math.min(78 - 34 * level, 1300 / words.length);
    const inner = h('span', { class: 'oit-thought-in' });
    words.forEach((word, index) => {
      const span = h('span', { class: 'oit-w' }, word);
      span.style.setProperty('--n', String(index));
      inner.appendChild(span);
      if (index < words.length - 1) inner.appendChild(document.createTextNode(' '));
    });
    const el = h('p', { class: 'oit-thought' }, inner);
    el.style.setProperty('--i', level.toFixed(3));
    el.style.setProperty('--step', `${step.toFixed(1)}ms`);
    if (level >= 0.55) el.classList.add('is-trembling');
    thoughtZone.appendChild(el);
    reflow(el);
    el.classList.add('is-on');
    currentThought = el;
    thoughtLive.textContent = words.join(' ');

    const hold = ms !== undefined && ms > 0 ? ms : thoughtMs(words.length) + step * words.length;
    thoughtTimer = later(() => {
      if (currentThought === el) currentThought = null;
      retireThought(el);
    }, hold);
  }

  /* --------------------------------------------- hint, objective, prompt */

  let hintTimer: number | undefined;

  function hint(text: string | null, ms?: number): void {
    cancel(hintTimer);
    hintTimer = undefined;
    if (!text) {
      hintEl.classList.remove('is-on');
      return;
    }
    hintEl.replaceChildren();
    add(hintEl, withKeycaps(text));
    hintEl.classList.add('is-on');
    if (ms !== undefined && ms > 0) hintTimer = later(() => hintEl.classList.remove('is-on'), ms);
  }

  function objective(text: string | null): void {
    if (!text) {
      objectiveEl.classList.remove('is-on');
      return;
    }
    objectiveEl.textContent = text;
    objectiveEl.classList.add('is-on');
  }

  function prompt(text: string | null): void {
    if (!text) {
      promptEl.classList.remove('is-on');
      return;
    }
    promptEl.replaceChildren();
    const parts = splitKeyPrompt(text);
    if (parts) add(promptEl, keycap(parts.key), h('span', null, parts.label));
    else add(promptEl, h('span', null, withKeycaps(text)));
    promptEl.classList.add('is-on');
  }

  /* ------------------------------------------------------------------ mic */

  let micState: MicState = 'hidden';
  let micTimer: number | undefined;
  let micIntroduced = false;

  function setMic(state: MicState, level = 0): void {
    if (state === 'recording') micEl.style.setProperty('--level', clamp01(level).toFixed(3));
    if (state === micState) return;
    const previous = micState;
    micState = state;
    micEl.dataset.state = state;
    cancel(micTimer);
    micTimer = undefined;

    if (state === 'idle') {
      // Spell the instruction out when it is new; afterwards the key cap alone is enough.
      const spellOut = !micIntroduced || previous === 'hidden' || previous === 'unavailable';
      micEl.classList.toggle('is-compact', !spellOut);
      if (spellOut) {
        micIntroduced = true;
        micStatus.textContent = 'Hold Space to speak.';
        micTimer = later(() => micEl.classList.add('is-compact'), 4500);
      }
    } else if (state === 'unavailable') {
      micEl.classList.remove('is-compact');
      micStatus.textContent = 'Microphone unavailable. Press T to type instead.';
    } else if (state === 'hidden') {
      micStatus.textContent = '';
    }
  }

  /* ----------------------------------------------------------------- fear */

  let fear = -1;
  let pulseAnimation: Animation | null = null;

  function setFear(level: number): void {
    const next = clamp01(level);
    if (Math.abs(next - fear) < 0.004) return;
    fear = next;
    fearEl.style.setProperty('--fear', next.toFixed(3));
    fearEl.classList.toggle('is-on', next > 0.02);

    // One heartbeat per second at rest, rising to ~2.4 per second at full fear.
    const beatsPerSecond = (58 + 86 * next) / 60;
    if (reducedMotion()) return;
    if (!pulseAnimation && typeof fearPulse.getAnimations === 'function') {
      pulseAnimation = fearPulse.getAnimations()[0] ?? null;
    }
    if (pulseAnimation) {
      // Changing the playback rate keeps the phase, so the pulse never stutters as fear moves.
      pulseAnimation.updatePlaybackRate(beatsPerSecond);
    } else {
      const quantised = Math.round(beatsPerSecond * 8) / 8;
      fearPulse.style.animationDuration = `${(1 / quantised).toFixed(3)}s`;
    }
  }

  /* --------------------------------------------------------- fade and card */

  let fadeSettle: (() => void) | null = null;

  function fade(toBlack: boolean, ms = 900): Promise<void> {
    // A newer fade supersedes the one in flight; its promise resolves now.
    fadeSettle?.();
    const duration = Math.max(0, ms);
    fadeEl.style.transitionDuration = `${duration}ms`;
    reflow(fadeEl);
    fadeEl.classList.toggle('is-black', toBlack);
    // A hard cut to black takes the world with it, including the line still on screen.
    // (Subtitles shown after the cut are drawn over the black as usual.)
    if (toBlack && duration <= 150) clearSubtitle();
    return new Promise<void>((resolve) => {
      // Resolve on the frame the transition really ends, so the caller never acts on a
      // screen that is a frame short of black. The timer covers the cases with no
      // transition to wait for: zero duration, already in that state, a hidden tab.
      let timer: number | undefined;
      const settle = (): void => {
        if (fadeSettle !== settle) return;
        fadeSettle = null;
        cancel(timer);
        fadeEl.removeEventListener('transitionend', settle);
        resolve();
      };
      fadeSettle = settle;
      fadeEl.addEventListener('transitionend', settle);
      timer = later(settle, duration === 0 ? 0 : duration + 80);
    });
  }

  let cardEnd: (() => void) | null = null;

  function card(title: string, subtitleText?: string, ms = 2800): Promise<void> {
    cardEnd?.();
    const fadeMs = 1100;
    const el = h(
      'div',
      { class: 'oit-card', role: 'status' },
      h('div', { class: 'oit-card-in' }, h('p', { class: 'oit-card-title' }, title), subtitleText ? h('p', { class: 'oit-card-sub' }, subtitleText) : null),
    );
    overlayLayer.appendChild(el);
    reflow(el);
    el.classList.add('is-on');

    return new Promise<void>((resolve) => {
      let finished = false;
      const ids: number[] = [];
      const end = (): void => {
        if (finished) return;
        finished = true;
        ids.forEach(cancel);
        el.remove();
        if (cardEnd === end) cardEnd = null;
        resolve();
      };
      cardEnd = end;
      ids.push(later(() => el.classList.remove('is-on'), fadeMs + Math.max(0, ms)));
      ids.push(later(end, fadeMs + Math.max(0, ms) + fadeMs));
    });
  }

  /* -------------------------------------------------------------- filming */

  let filmInterval: number | undefined;

  function setFilming(on: boolean): void {
    if (on === filmEl.classList.contains('is-on')) return;
    filmEl.classList.toggle('is-on', on);
    window.clearInterval(filmInterval);
    filmInterval = undefined;
    if (on) {
      const started = performance.now();
      filmTime.textContent = '00:00';
      filmInterval = window.setInterval(() => {
        filmTime.textContent = formatClock((performance.now() - started) / 1000);
      }, 250);
    }
  }

  /* ---------------------------------------------------------- typed speech */

  let askCancel: (() => void) | null = null;

  function askText(placeholder = 'Type what you say'): Promise<string | null> {
    askCancel?.();
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const id = nextId('oit-ask');
    const input = h('input', {
      class: 'oit-ask-input',
      id,
      type: 'text',
      placeholder,
      maxlength: 280,
      autocomplete: 'off',
      autocapitalize: 'sentences',
      spellcheck: 'false',
      enterkeyhint: 'send',
    });
    const form = h(
      'form',
      { class: 'oit-ask', role: 'group', 'aria-label': 'Type what you say' },
      h('label', { class: 'oit-sr', for: id }, 'Type what you say. Enter sends, Escape cancels.'),
      input,
      h('p', { class: 'oit-ask-keys', 'aria-hidden': 'true' }, keycap('Enter'), h('span', null, 'send'), keycap('Esc'), h('span', null, 'cancel')),
    );
    root.classList.add('is-asking');
    overlayLayer.appendChild(form);
    reflow(form);
    form.classList.add('is-on');
    input.focus({ preventScroll: true });

    return new Promise<string | null>((resolve) => {
      let finished = false;
      const finish = (value: string | null): void => {
        if (finished) return;
        finished = true;
        if (askCancel === cancelAsk) askCancel = null;
        root.classList.remove('is-asking');
        form.classList.remove('is-on');
        form.setAttribute('inert', '');
        later(() => form.remove(), 260);
        if (previousFocus && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
        else input.blur();
        resolve(value);
      };
      const cancelAsk = (): void => finish(null);
      askCancel = cancelAsk;

      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const value = input.value.replace(/\s+/g, ' ').trim();
        if (value) finish(value);
      });
      // Keys typed here must not reach the movement / push-to-talk handlers.
      const contain = (e: KeyboardEvent): void => {
        e.stopPropagation();
        if (e.type === 'keydown' && e.key === 'Escape') {
          e.preventDefault();
          finish(null);
        }
      };
      input.addEventListener('keydown', contain);
      input.addEventListener('keyup', contain);
      input.addEventListener('keypress', contain);
    });
  }

  /* --------------------------------------------------------- guided replay */

  let panelEnd: (() => void) | null = null;

  /**
   * A panel over the frozen scene, low in the frame so the people stay in view.
   * Focus moves in and is kept there; when it closes, focus goes back where it was.
   */
  function openPanel(el: HTMLElement, first: HTMLElement, cleanup?: () => void): () => void {
    panelEnd?.();
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    root.classList.add('is-choosing');
    overlayLayer.appendChild(el);
    reflow(el);
    el.classList.add('is-on');
    const release = trapFocus(el);
    first.focus({ preventScroll: true });
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      if (panelEnd === close) panelEnd = null;
      cleanup?.();
      release();
      root.classList.remove('is-choosing');
      el.classList.remove('is-on');
      el.setAttribute('inert', '');
      later(() => el.remove(), 260);
      if (previousFocus && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
      else (document.activeElement as HTMLElement | null)?.blur?.();
    };
    panelEnd = close;
    return close;
  }

  const aborted = (): DOMException => new DOMException('The panel was closed.', 'AbortError');

  function choice(opts: { prompt: string; options: Array<{ label: string; note?: string }>; signal?: AbortSignal }): Promise<number> {
    clearSubtitle();
    const titleId = nextId('oit-choice');
    const buttons = opts.options.map((option, index) =>
      h(
        'button',
        { class: 'oit-choice-opt', type: 'button', 'data-index': index },
        keycap(String(index + 1)),
        h('span', { class: 'oit-choice-text' }, option.label, option.note ? h('span', { class: 'oit-choice-note' }, ` ${option.note}`) : null),
      ),
    );
    const el = h(
      'div',
      { class: 'oit-choice', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      h(
        'div',
        { class: 'oit-choice-panel' },
        h('p', { class: 'oit-choice-prompt', id: titleId }, opts.prompt),
        h('div', { class: 'oit-choice-list', role: 'group', 'aria-label': 'Your options' }, buttons),
        h('p', { class: 'oit-choice-keys', 'aria-hidden': 'true' }, 'Press ', keycap('1'), keycap('2'), keycap('3'), ' or choose with ', keycap('Tab'), ' and ', keycap('Enter')),
      ),
    );
    return new Promise<number>((resolve, reject) => {
      if (opts.signal?.aborted) {
        reject(aborted());
        return;
      }
      let done = false;
      const pick = (index: number): void => {
        if (done || index < 0 || index >= buttons.length) return;
        done = true;
        close();
        resolve(index);
      };
      const onKey = (e: KeyboardEvent): void => {
        if (e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
        const match = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
        if (!match) return;
        e.preventDefault();
        e.stopPropagation();
        pick(Number(match[1]) - 1);
      };
      buttons.forEach((b, i) => b.addEventListener('click', () => pick(i)));
      window.addEventListener('keydown', onKey, true);
      const close = openPanel(el, buttons[0] ?? el, () => window.removeEventListener('keydown', onKey, true));
      opts.signal?.addEventListener('abort', () => {
        if (done) return;
        done = true;
        close();
        reject(aborted());
      });
    });
  }

  function feedback(opts: { text: string; reference?: string; action: string; signal?: AbortSignal }): Promise<void> {
    const textId = nextId('oit-feedback');
    const button = h('button', { class: 'oit-btn oit-btn--primary', type: 'button' }, opts.action);
    const el = h(
      'div',
      { class: 'oit-choice oit-choice--feedback', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': textId },
      h(
        'div',
        { class: 'oit-choice-panel' },
        h('p', { class: 'oit-feedback-text', id: textId }, opts.text),
        opts.reference ? h('p', { class: 'oit-feedback-ref' }, opts.reference) : null,
        h('div', { class: 'oit-choice-actions' }, button),
      ),
    );
    return new Promise<void>((resolve, reject) => {
      if (opts.signal?.aborted) {
        reject(aborted());
        return;
      }
      let done = false;
      const close = openPanel(el, button);
      button.addEventListener('click', () => {
        if (done) return;
        done = true;
        close();
        resolve();
      });
      opts.signal?.addEventListener('abort', () => {
        if (done) return;
        done = true;
        close();
        reject(aborted());
      });
    });
  }

  /* ---------------------------------------------------------------- pause */

  let pausePromise: Promise<'resume' | 'exit'> | null = null;
  let pauseEnd: ((choice: 'resume' | 'exit') => void) | null = null;

  function pause(): Promise<'resume' | 'exit'> {
    if (pausePromise) return pausePromise;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const titleId = nextId('oit-pause-title');
    const noteId = nextId('oit-pause-note');
    const resumeBtn = h('button', { class: 'oit-btn oit-btn--primary', type: 'button' }, 'Continue');
    const exitBtn = h('button', { class: 'oit-btn oit-btn--ghost', type: 'button' }, 'Leave the simulation');
    const el = h(
      'div',
      { class: 'oit-pause', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, 'aria-describedby': noteId },
      h(
        'div',
        { class: 'oit-pause-panel' },
        h('h2', { class: 'oit-pause-title', id: titleId }, 'Paused'),
        h('p', { class: 'oit-pause-note', id: noteId }, 'It is fine to stop here. You can leave at any point, for any reason.'),
        h('div', { class: 'oit-pause-actions' }, resumeBtn, exitBtn),
      ),
    );
    overlayLayer.appendChild(el);
    reflow(el);
    el.classList.add('is-on');
    const release = trapFocus(el);
    resumeBtn.focus({ preventScroll: true });

    pausePromise = new Promise<'resume' | 'exit'>((resolve) => {
      let finished = false;
      const finish = (choice: 'resume' | 'exit'): void => {
        if (finished) return;
        finished = true;
        release();
        pausePromise = null;
        pauseEnd = null;
        el.classList.remove('is-on');
        el.setAttribute('inert', '');
        later(() => el.remove(), 320);
        if (previousFocus && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
        else (document.activeElement as HTMLElement | null)?.blur?.();
        // Resolved inside the click, so the caller can re-request pointer lock on this gesture.
        resolve(choice);
      };
      pauseEnd = finish;
      resumeBtn.addEventListener('click', () => finish('resume'));
      exitBtn.addEventListener('click', () => finish('exit'));
    });
    return pausePromise;
  }

  /* ----------------------------------------------------------- visibility */

  function setVisible(visible: boolean): void {
    root.classList.toggle('is-hidden', !visible);
  }

  function dispose(): void {
    if (disposed) return;
    askCancel?.();
    panelEnd?.();
    pauseEnd?.('exit');
    cardEnd?.();
    fadeSettle?.();
    disposed = true;
    offPhone?.();
    timers.forEach((id) => window.clearTimeout(id));
    timers.clear();
    window.clearInterval(filmInterval);
    worldLayer.remove();
    fadeEl.remove();
    textLayer.remove();
    overlayLayer.remove();
    root.classList.remove('oit-root', 'oit-hud', 'is-hidden', 'is-asking', 'is-choosing');
  }

  setFear(0);

  return {
    setVisible,
    subtitle,
    clearSubtitle,
    thought,
    hint,
    objective,
    setMic,
    setFear,
    fade,
    card,
    setFilming,
    prompt,
    askText,
    pause,
    choice,
    feedback,
    dispose,
  };
}
