/**
 * The 30 s film after Part 1 (public/film/part1-film.mp4).
 *
 * Flow: a content note for 3 s, then "start" (Enter or click). The film plays
 * full screen on black with no browser controls. Space or Esc pauses and
 * resumes; a quiet Skip button is always there. It resolves when the film
 * ends or is skipped.
 *
 * Accessibility: everything works from the keyboard; focus moves to whatever
 * needs an answer; the on-screen text is read out from a hidden WebVTT track
 * through a polite live region (the narration says the same words aloud);
 * with prefers-reduced-motion nothing fades.
 *
 * Classes are oit-reel-*: oit-film-* belongs to the HUD's phone-filming frame.
 */

import './film.css';
import { h, nextId, reducedMotion } from './dom';

export interface FilmOptions {
  src: string;
  /** WebVTT with the on-screen text, read to screen readers. */
  track?: string;
}

export interface FilmResult {
  /** False when the player pressed Skip, or the film could not play. */
  completed: boolean;
}

export const FILM = {
  src: '/film/part1-film.mp4',
  track: '/film/part1-film.vtt',
  noteMs: 3000,
} as const;

export function createFilmPlayer(opts: FilmOptions, onDone: (result: FilmResult) => void): { el: HTMLElement } {
  let finished = false;
  let started = false;
  let enteredFullscreen = false;

  const titleId = nextId('oit-reel');
  const el = h('section', { class: `oit-screen oit-reel${reducedMotion() ? ' is-calm' : ''}`, 'aria-labelledby': titleId });

  /* ------------------------------------------------------------ the note */

  const startBtn = h('button', { class: 'oit-btn oit-btn--primary oit-reel-start', type: 'button', disabled: true }, 'Start the film');
  const note = h(
    'div',
    { class: 'oit-reel-note' },
    h('h1', { class: 'oit-sr', id: titleId }, 'Part 1 film'),
    h('p', { class: 'oit-reel-note-text', tabindex: -1, 'data-focus': true }, h('span', null, 'Contains harassing language.'), h('span', null, 'Headphones recommended.')),
    h('div', { class: 'oit-reel-note-go' }, startBtn, h('p', { class: 'oit-reel-hint', 'aria-hidden': 'true' }, 'Press Enter or click to start.')),
  );

  /* ----------------------------------------------------------- the player */

  const video = h('video', { class: 'oit-reel-video', src: opts.src, preload: 'auto', playsinline: true, 'aria-label': 'Film, 30 seconds, narrated.' }) as HTMLVideoElement;
  video.controls = false;
  video.disablePictureInPicture = true;
  const spoken = h('div', { class: 'oit-sr', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const status = h('div', { class: 'oit-sr', role: 'status' });
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

  const skipBtn = h('button', { class: 'oit-reel-skip', type: 'button', onclick: () => finish(false) }, 'Skip', h('span', { class: 'oit-sr' }, ' the film'));
  const resumeBtn = h('button', { class: 'oit-btn oit-btn--ghost', type: 'button', onclick: () => resume() }, 'Resume');
  const pausedPanel = h(
    'div',
    { class: 'oit-reel-paused', hidden: true },
    h('p', { class: 'oit-reel-paused-title' }, 'Paused'),
    resumeBtn,
    h('p', { class: 'oit-reel-hint', 'aria-hidden': 'true' }, 'Space or Esc to resume.'),
  );
  const player = h('div', { class: 'oit-reel-player', hidden: true, tabindex: -1 }, video, pausedPanel, spoken, status);
  el.append(note, player, skipBtn);

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
      // Most often autoplay rules: the paused panel lets a click or key start it.
      showPaused(true);
    });
  }

  function showPaused(on: boolean): void {
    pausedPanel.hidden = !on;
    if (on) resumeBtn.focus({ preventScroll: true });
  }

  function pause(): void {
    if (!started || finished || video.paused) return;
    video.pause();
    showPaused(true);
    announce('Paused. Press Space or Escape to resume.');
  }

  function resume(): void {
    if (!started || finished) return;
    showPaused(false);
    void enterFullscreen();
    announce('Playing.');
    player.focus({ preventScroll: true });
    play();
  }

  function start(): void {
    if (started || startBtn.disabled) return;
    started = true;
    note.hidden = true;
    player.hidden = false;
    void enterFullscreen();
    player.focus({ preventScroll: true });
    play();
  }

  function finish(completed: boolean): void {
    if (finished) return;
    finished = true;
    video.pause();
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    if (enteredFullscreen && document.fullscreenElement === el) void document.exitFullscreen().catch(() => {});
    onDone({ completed });
  }

  /* -------------------------------------------------------------- events */

  video.addEventListener('ended', () => finish(true));
  video.addEventListener('error', () => {
    console.warn('[film] video failed to load', video.error);
    finish(false);
  });
  startBtn.addEventListener('click', start);
  note.addEventListener('click', (e) => {
    if (e.target !== startBtn) start();
  });
  // A click on the picture pauses or resumes, like Space.
  video.addEventListener('click', () => (video.paused ? resume() : pause()));

  function onKey(e: KeyboardEvent): void {
    if (finished || !el.isConnected) return;
    if (!started) {
      if (e.key === 'Enter' && !startBtn.disabled) {
        e.preventDefault();
        start();
      }
      return;
    }
    if (e.key === ' ' || e.key === 'Spacebar' || e.key === 'Escape') {
      // Space never activates the focused button here, so it cannot press Skip by accident.
      e.preventDefault();
      e.stopPropagation();
      if (video.paused) resume();
      else pause();
    }
  }
  window.addEventListener('keydown', onKey, true);

  /** Esc in real full screen is taken by the browser to leave full screen: treat that as a pause. */
  function onFullscreenChange(): void {
    if (!document.fullscreenElement && started && !finished && !video.paused) pause();
  }
  document.addEventListener('fullscreenchange', onFullscreenChange);

  // The note stays up for at least noteMs before the film can start.
  window.setTimeout(() => {
    if (finished) return;
    startBtn.disabled = false;
    el.dataset.ready = 'true';
    if (note.contains(document.activeElement) || document.activeElement === document.body) startBtn.focus({ preventScroll: true });
  }, FILM.noteMs);

  return { el };
}
