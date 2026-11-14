/**
 * The 30 s film after Part 1 (public/film/part1-film.mp4).
 *
 * Flow: a content note for 3 s, then "start" (Enter or click). The film plays
 * full screen on black with no browser controls. Space or Esc pauses and
 * resumes; a quiet Skip button is always there. At QUESTION_AT the film stops
 * for one question (a 0-100 slider and "Lock in"), then carries on; while the
 * burned-in answer is on screen the player's own guess is shown beside it.
 *
 * Accessibility: everything works from the keyboard; focus moves to whatever
 * needs an answer; the burned-in text is read out from a hidden WebVTT track
 * through a polite live region; with prefers-reduced-motion the overlays
 * appear without fades.
 *
 * Positions of the guess label are in the film's own 1280x720 frame (see
 * film/scripts/assemble-film.mjs LAYOUT) and follow the video as it scales.
 */

import './film.css';
import { h, nextId, reducedMotion } from './dom';

export interface FilmOptions {
  src: string;
  /** WebVTT with the burned-in text, read to screen readers. */
  track?: string;
  /** Called once when the player locks in a guess (a whole number 0-100). */
  onGuess?: (guess: number) => void;
}

export interface FilmResult {
  /** The locked-in guess, or null if the film was skipped before the question. */
  guess: number | null;
  /** False when the player pressed Skip, or the film could not play. */
  completed: boolean;
}

/** Film timings (seconds), matching film/scripts/assemble-film.mjs. */
export const FILM = {
  src: '/film/part1-film.mp4',
  track: '/film/part1-film.vtt',
  noteMs: 3000,
  questionAt: 17.5,
  answerFrom: 20,
  answerUntil: 23,
  question: 'Out of 100 women in the US, how many have been followed?',
  /** The frame the film was cut at, and where the burned-in answer's headline sits in it. */
  frame: { w: 1280, h: 720 },
  answerRow: { top: 448, height: 50 },
  guessLeft: 826,
} as const;

export function createFilmPlayer(opts: FilmOptions, onDone: (result: FilmResult) => void): { el: HTMLElement } {
  const calm = reducedMotion();
  let guess: number | null = null;
  let asked = false;
  let finished = false;
  let started = false;
  let enteredFullscreen = false;
  let raf = 0;

  const titleId = nextId('oit-film');
  const el = h('section', {
    class: `oit-screen oit-film${calm ? ' is-calm' : ''}`,
    'aria-labelledby': titleId,
    'data-stage': 'note',
  });

  /* ------------------------------------------------------------ the note */

  const startBtn = h('button', { class: 'oit-btn oit-btn--primary oit-film-start', type: 'button', disabled: true }, 'Start the film');
  const startHint = h('p', { class: 'oit-film-hint', 'aria-hidden': 'true' }, 'Press Enter or click to start.');
  const note = h(
    'div',
    { class: 'oit-film-note' },
    h('h1', { class: 'oit-sr', id: titleId }, 'Part 1 film'),
    h(
      'p',
      { class: 'oit-film-note-text', tabindex: -1, 'data-focus': true },
      h('span', null, 'Contains harassing language.'),
      h('span', null, 'Headphones recommended.'),
    ),
    h('div', { class: 'oit-film-note-go' }, startBtn, startHint),
  );

  /* ----------------------------------------------------------- the player */

  const video = h('video', {
    class: 'oit-film-video',
    src: opts.src,
    preload: 'auto',
    playsinline: true,
    'aria-label': 'Film, 30 seconds. Its on-screen text is read out.',
  }) as HTMLVideoElement;
  video.controls = false;
  video.disablePictureInPicture = true;
  const spoken = h('div', { class: 'oit-sr', 'aria-live': 'polite', 'aria-atomic': 'true' });
  if (opts.track) {
    // Hidden, not shown: the words are already in the picture. Each new cue is read out.
    const trackEl = h('track', { kind: 'captions', src: opts.track, srclang: 'en', label: 'English', default: true }) as HTMLTrackElement;
    video.appendChild(trackEl);
    trackEl.track.mode = 'hidden';
    trackEl.track.addEventListener('cuechange', () => {
      const text = Array.from(trackEl.track.activeCues ?? [])
        .map((c) => (c as VTTCue).text)
        .join(' ');
      if (text) spoken.textContent = text;
    });
  }
  const status = h('div', { class: 'oit-sr', role: 'status' });

  const skipBtn = h('button', { class: 'oit-film-skip', type: 'button', onclick: () => finish(false) }, 'Skip', h('span', { class: 'oit-sr' }, ' the film'));

  const pausedPanel = h(
    'div',
    { class: 'oit-film-paused', hidden: true },
    h('p', { class: 'oit-film-paused-title' }, 'Paused'),
    h('button', { class: 'oit-btn oit-btn--ghost', type: 'button', onclick: () => resume() }, 'Resume'),
    h('p', { class: 'oit-film-hint', 'aria-hidden': 'true' }, 'Space or Esc to resume.'),
  );

  // Question
  const qId = nextId('oit-film-q');
  const valueId = nextId('oit-film-v');
  const slider = h('input', {
    class: 'oit-film-range',
    type: 'range',
    min: 0,
    max: 100,
    step: 1,
    value: 50,
    'aria-labelledby': qId,
    'aria-describedby': valueId,
  }) as HTMLInputElement;
  const value = h('output', { class: 'oit-film-value', id: valueId, 'aria-live': 'off' }, '50');
  const setValueText = () => {
    value.textContent = slider.value;
    slider.setAttribute('aria-valuetext', `${slider.value} out of 100`);
  };
  setValueText();
  slider.addEventListener('input', setValueText);
  const lockBtn = h('button', { class: 'oit-btn oit-btn--primary', type: 'submit' }, 'Lock in');
  const question = h(
    'form',
    {
      class: 'oit-film-question',
      hidden: true,
      onsubmit: (e: Event) => {
        e.preventDefault();
        lockIn();
      },
    },
    h('p', { class: 'oit-film-q', id: qId }, FILM.question),
    h('div', { class: 'oit-film-range-row' }, h('span', { class: 'oit-film-range-end', 'aria-hidden': 'true' }, '0'), slider, h('span', { class: 'oit-film-range-end', 'aria-hidden': 'true' }, '100')),
    h('div', { class: 'oit-film-q-foot' }, value, lockBtn),
  );

  // "You guessed N", laid over the video's own frame.
  const guessNum = h('span', { class: 'oit-film-guess-n' });
  const guessLabel = h('p', { class: 'oit-film-guess', 'aria-hidden': 'true' }, h('span', { class: 'oit-film-guess-k' }, 'You guessed'), guessNum);
  const frameLayer = h('div', { class: 'oit-film-frame' }, guessLabel);

  const player = h('div', { class: 'oit-film-player', hidden: true }, video, frameLayer, pausedPanel, question, spoken, status);
  el.append(note, player, skipBtn);

  /* -------------------------------------------------------------- layout */

  /** Keep the overlay layer exactly over the letterboxed picture. */
  function layout(): void {
    const w = el.clientWidth;
    const hgt = el.clientHeight;
    if (!w || !hgt) return;
    const ratio = FILM.frame.w / FILM.frame.h;
    const width = w / hgt > ratio ? hgt * ratio : w;
    const height = width / ratio;
    Object.assign(frameLayer.style, { left: `${(w - width) / 2}px`, top: `${(hgt - height) / 2}px`, width: `${width}px`, height: `${height}px` });
    frameLayer.style.setProperty('--u', `${height / FILM.frame.h}px`);
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(layout) : null;
  ro?.observe(el);
  Object.assign(guessLabel.style, {
    left: `${(FILM.guessLeft / FILM.frame.w) * 100}%`,
    top: `${(FILM.answerRow.top / FILM.frame.h) * 100}%`,
    height: `${(FILM.answerRow.height / FILM.frame.h) * 100}%`,
  });

  /* ------------------------------------------------------------ playback */

  const announce = (text: string) => {
    status.textContent = '';
    window.setTimeout(() => (status.textContent = text), 30);
  };

  async function enterFullscreen(): Promise<void> {
    if (document.fullscreenElement || typeof el.requestFullscreen !== 'function') return;
    try {
      await el.requestFullscreen({ navigationUI: 'hide' });
      enteredFullscreen = true;
    } catch {
      /* not allowed here: the black screen already fills the window */
    }
  }

  function play(): void {
    void video.play().catch((err) => {
      console.warn('[film] could not play', err);
      // Most often autoplay rules: show the paused panel so a click or key starts it.
      showPaused(true);
    });
    loop();
  }

  function loop(): void {
    cancelAnimationFrame(raf);
    const tick = () => {
      const t = video.currentTime;
      if (!asked && t >= FILM.questionAt) {
        askQuestion();
        return;
      }
      guessLabel.classList.toggle('is-on', guess !== null && t >= FILM.answerFrom && t < FILM.answerUntil);
      if (!video.paused && !finished) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  function showPaused(on: boolean): void {
    pausedPanel.hidden = !on;
    el.dataset.paused = on ? 'true' : 'false';
  }

  function pause(): void {
    if (!started || finished || !question.hidden) return;
    if (video.paused) return;
    video.pause();
    showPaused(true);
    announce('Paused. Press Space or Escape to resume.');
    (pausedPanel.querySelector('button') as HTMLButtonElement).focus({ preventScroll: true });
  }

  function resume(): void {
    if (!started || finished || !question.hidden) return;
    showPaused(false);
    void enterFullscreen();
    announce('Playing.');
    player.focus({ preventScroll: true });
    play();
  }

  function askQuestion(): void {
    asked = true;
    video.pause();
    cancelAnimationFrame(raf);
    question.hidden = false;
    el.dataset.stage = 'question';
    slider.focus({ preventScroll: true });
  }

  function lockIn(): void {
    if (guess !== null) return;
    const n = Math.max(0, Math.min(100, Math.round(Number(slider.value))));
    guess = n;
    guessNum.textContent = String(n);
    question.hidden = true;
    el.dataset.stage = 'playing';
    try {
      opts.onGuess?.(n);
    } catch (err) {
      console.warn('[film] guess handler failed', err);
    }
    announce(`You guessed ${n}.`);
    player.focus({ preventScroll: true });
    play();
  }

  function start(): void {
    if (started || startBtn.disabled) return;
    started = true;
    el.dataset.stage = 'playing';
    note.hidden = true;
    player.hidden = false;
    layout();
    void enterFullscreen();
    player.focus({ preventScroll: true });
    play();
  }

  function finish(completed: boolean): void {
    if (finished) return;
    finished = true;
    cancelAnimationFrame(raf);
    video.pause();
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    ro?.disconnect();
    if (enteredFullscreen && document.fullscreenElement === el) void document.exitFullscreen().catch(() => {});
    onDone({ guess, completed });
  }

  /* -------------------------------------------------------------- events */

  player.tabIndex = -1;
  video.addEventListener('ended', () => finish(true));
  video.addEventListener('error', () => {
    console.warn('[film] video failed to load', video.error);
    finish(false);
  });

  startBtn.addEventListener('click', start);
  note.addEventListener('click', (e) => {
    if (e.target !== startBtn) start();
  });
  // While playing, a click on the picture pauses or resumes, like a key.
  video.addEventListener('click', () => (video.paused ? resume() : pause()));

  function onKey(e: KeyboardEvent): void {
    if (finished || !el.isConnected) return;
    const key = e.key;
    if (!started) {
      if (key === 'Enter' && !startBtn.disabled) {
        e.preventDefault();
        start();
      }
      return;
    }
    // The question owns the keyboard until it is answered (Enter locks in via the form).
    if (!question.hidden) return;
    if (key === ' ' || key === 'Spacebar' || key === 'Escape') {
      // Space never activates the focused button here (so it cannot press Skip by accident).
      e.preventDefault();
      e.stopPropagation();
      if (video.paused) resume();
      else pause();
    }
  }
  window.addEventListener('keydown', onKey, true);

  /** Esc in real full screen is taken by the browser to leave full screen: treat that as a pause. */
  function onFullscreenChange(): void {
    if (!document.fullscreenElement && started && !finished && !video.paused && question.hidden) pause();
  }
  document.addEventListener('fullscreenchange', onFullscreenChange);

  // The note stays up for at least noteMs before the film can start.
  window.setTimeout(
    () => {
      if (finished) return;
      startBtn.disabled = false;
      el.dataset.ready = 'true';
      if (note.contains(document.activeElement) || document.activeElement === document.body) startBtn.focus({ preventScroll: true });
    },
    FILM.noteMs,
  );

  return { el };
}
