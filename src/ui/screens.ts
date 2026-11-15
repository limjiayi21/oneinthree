/**
 * The full-page screens: intro, briefings, debriefs, closing, loading, error.
 *
 * Tone: editorial and restrained. This is training material about something
 * many of the people using it have lived through; it is not a game and nothing
 * here should read like one. No scores, no rewards, no playful copy.
 *
 * Facts: every statistic, case study, definition, phone number and citation is
 * read from content/evidence.json at runtime (see ./evidence.ts). Sections whose
 * data is missing are left out entirely rather than shown empty.
 */

import './base.css';
import './screens.css';
import type { PlayMode, Screens } from '../contracts';
import type { PhoneLink } from '../net/phoneLink';
import type { FiveDResult, Insight, Pov, Rationale, SummaryData, TimelineEntry } from '../../shared/types';
import type { CaseStudy, Evidence, EvidenceSource, EvidenceStat, SupportResource } from '../../shared/evidence';
import { add, clamp01, ensureFonts, focusables, h, keycap, nextId, reflow, type Child } from './dom';
import { bundledEvidence, headlineStat, hostOf, normaliseEvidence, resolveSources, resolveStats, safeUrl } from './evidence';

export interface ScreensOptions {
  /**
   * Evidence to render instead of the bundled content/evidence.json.
   * Used by the dev harness to lay screens out against mock entries.
   */
  evidence?: Evidence;
  /** Optional phone link: adds the pairing button to the intro. */
  phone?: PhoneLink;
}

const PRODUCT = 'One in Three';

/* ---------------------------------------------------------------- helpers */

function mark(): HTMLElement {
  return h('span', { class: 'oit-mark', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
}

function wordmark(): HTMLElement {
  return h('span', { class: 'oit-wordmark' }, mark(), h('span', null, PRODUCT));
}

/** Split free text into paragraphs on blank lines. */
function paragraphs(text: string | undefined, className?: string): HTMLElement[] {
  return (text ?? '')
    .split(/\n\s*\n/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((part) => h('p', { class: className ?? null }, part));
}

function formatTime(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(s / 60);
  const rest = s % 60;
  if (minutes === 0) return `${rest} seconds`;
  const m = `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  return rest === 0 ? m : `${m} ${rest} ${rest === 1 ? 'second' : 'seconds'}`;
}

function sourceLabel(source: EvidenceSource): string {
  const name = source.publisher || source.title;
  return Number.isFinite(source.year) ? `${name}, ${source.year}` : name;
}

/** "Publisher, year" as a link that opens in a new tab (plain text when there is no usable URL). */
function sourceLink(source: EvidenceSource): HTMLElement {
  const url = safeUrl(source.url);
  const label = sourceLabel(source);
  if (!url) return h('span', { class: 'oit-src' }, label);
  return h(
    'a',
    { class: 'oit-src', href: url, target: '_blank', rel: 'noopener noreferrer', title: source.title || null },
    label,
    h('span', { class: 'oit-ext', 'aria-hidden': 'true' }, '↗'),
    h('span', { class: 'oit-sr' }, ' (opens in a new tab)'),
  );
}

function sourceLine(sources: EvidenceSource[], label = 'Source'): HTMLElement | null {
  if (sources.length === 0) return null;
  const line = h('p', { class: 'oit-srcline' }, h('span', { class: 'oit-srcline-k' }, sources.length > 1 ? `${label}s` : label));
  sources.forEach((source, index) => {
    if (index > 0) line.appendChild(h('span', { class: 'oit-sep', 'aria-hidden': 'true' }, '·'));
    line.appendChild(sourceLink(source));
  });
  return line;
}

const BASIS_LABEL: Record<Rationale['basis'], string> = {
  data: 'From data',
  inferred: 'Inferred from research',
  assumption: 'Assumption',
};

function basisBadge(basis: string): HTMLElement {
  const key = (basis in BASIS_LABEL ? basis : 'assumption') as Rationale['basis'];
  return h('span', { class: 'oit-basis', 'data-basis': key }, h('i', { 'aria-hidden': 'true' }), BASIS_LABEL[key]);
}

/** A debrief section: small-caps side heading on the left, content on the right. */
function section(title: string, modifier: string, ...children: Child[]): HTMLElement {
  const id = nextId('oit-sec');
  return h(
    'section',
    { class: `oit-sec ${modifier}`, 'aria-labelledby': id },
    h('h2', { class: 'oit-sec-title', id }, title),
    h('div', { class: 'oit-sec-body' }, children),
  );
}

/** A quiet "show more" disclosure for long supporting material. */
function disclosure(label: string, ...children: Child[]): HTMLElement {
  return h('details', { class: 'oit-more' }, h('summary', null, label), h('div', { class: 'oit-more-body' }, children));
}

/** "2026-11-12" as "12 November 2026"; anything else is shown as written. */
function formatDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** Headlines run from "65%" to "More than 1 in 3"; the type size steps down as they lengthen. */
function sizeClass(headline: string): string {
  const length = headline.length;
  return length <= 4 ? 'is-short' : length <= 7 ? 'is-medium' : length <= 11 ? 'is-wide' : 'is-long';
}

/* ------------------------------------------------------------------ factory */

export function createScreens(root: HTMLElement, options: ScreensOptions = {}): Screens {
  ensureFonts();
  root.classList.add('oit-root', 'oit-screens');
  const evidence: Evidence = options.evidence ? normaliseEvidence(options.evidence) : bundledEvidence;

  let current: HTMLElement | null = null;

  function dismiss(el: HTMLElement | null): void {
    if (!el || !el.isConnected) return;
    el.classList.remove('is-in');
    el.classList.add('is-out');
    el.setAttribute('inert', '');
    el.setAttribute('aria-hidden', 'true');
    window.setTimeout(() => el.remove(), 600);
  }

  /** Put a screen up, replacing whatever was there. */
  function show(el: HTMLElement): void {
    const previous = current;
    current = el;
    root.appendChild(el);
    reflow(el);
    el.classList.add('is-in');
    dismiss(previous);
    dismiss(errorEl);
    errorEl = null;
    focusStart(el);
  }

  function close(el: HTMLElement): void {
    if (current === el) current = null;
    // Drop focus before the element goes inert, so key presses return to the page.
    if (el.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    dismiss(el);
  }

  /** Move focus to the screen's heading so reading (and Tab) starts at the top. */
  function focusStart(scope: HTMLElement): void {
    const target = scope.querySelector<HTMLElement>('[data-focus]') ?? focusables(scope)[0];
    target?.focus({ preventScroll: true });
  }

  function statBlock(stat: EvidenceStat, variant: 'feature' | 'inline'): HTMLElement {
    return h(
      'figure',
      { class: `oit-stat oit-stat--${variant} ${sizeClass(stat.headline)}` },
      h('p', { class: 'oit-stat-num' }, stat.headline),
      h(
        'figcaption',
        { class: 'oit-stat-cap' },
        stat.text ? h('p', { class: 'oit-stat-text' }, stat.text) : null,
        stat.detail && variant === 'feature' ? h('p', { class: 'oit-stat-detail' }, stat.detail) : null,
        sourceLine(resolveSources(evidence, [stat.sourceId])),
      ),
    );
  }

  /* ------------------------------------------------------------------ intro */

  function intro(opts: { voiceAvailable: boolean; requestMic: () => Promise<boolean> }): Promise<PlayMode> {
    return new Promise<PlayMode>((resolve) => {
      type MicCheck = 'unchecked' | 'asking' | 'granted' | 'denied';
      let mic: MicCheck = 'unchecked';
      let step = 0;
      let mode: PlayMode = 'analog';

      const counter = h('p', { class: 'oit-topbar-step', 'aria-live': 'polite' });
      const topbar = h('header', { class: 'oit-topbar' }, wordmark(), counter);
      const stage = h('div', { class: 'oit-intro-stage' });
      const el = h('section', { class: 'oit-screen oit-screen--scrim oit-intro', 'aria-label': `${PRODUCT}: introduction` }, h('div', { class: 'oit-frame' }, topbar, stage));

      const actions = (primaryLabel: string, onPrimary: () => void, back: boolean): HTMLElement =>
        h(
          'div',
          { class: 'oit-actions oit-rise' },
          h('button', { class: 'oit-btn oit-btn--primary', type: 'button', onclick: onPrimary }, primaryLabel),
          back ? h('button', { class: 'oit-btn oit-btn--quiet', type: 'button', onclick: () => go(step - 1) }, 'Back') : null,
        );

      const row = (term: string, ...body: Child[]): HTMLElement => h('div', { class: 'oit-dl-row' }, h('dt', null, term), h('dd', null, body));

      /* Step 1: the title. */
      const renderTitle = (): HTMLElement => {
        const stat = headlineStat(evidence);
        const statEl = stat
          ? h(
              'div',
              { class: 'oit-title-stat oit-rise' },
              h('p', { class: 'oit-title-stat-text' }, h('strong', null, stat.headline), ' ', stat.text),
              stat.detail ? h('p', { class: 'oit-title-stat-detail' }, stat.detail) : null,
              sourceLine(resolveSources(evidence, [stat.sourceId])),
            )
          : null;
        return h(
          'div',
          { class: `oit-step oit-step--title${stat ? '' : ' is-statless'}` },
          h('p', { class: 'oit-eyebrow oit-rise' }, mark(), 'A first-person simulation'),
          h('h1', { class: 'oit-title oit-rise', tabindex: -1, 'data-focus': true }, PRODUCT),
          h(
            'div',
            { class: 'oit-title-grid' },
            statEl,
            h(
              'div',
              { class: 'oit-title-about oit-rise' },
              h('p', null, 'This is a simulation of street harassment, made for respect and bystander training.'),
              h('p', null, 'You walk home at night as a woman. Then you walk the same street again, as someone who sees it happen.'),
              h('div', { class: 'oit-actions' }, h('button', { class: 'oit-btn oit-btn--primary', type: 'button', onclick: () => go(1) }, 'Begin')),
            ),
          ),
        );
      };

      /* Step 2: the content note. There is no route into the simulation that skips it. */
      const renderNote = (): HTMLElement =>
        h(
          'div',
          { class: 'oit-step' },
          h('h1', { class: 'oit-h1 oit-rise', tabindex: -1, 'data-focus': true }, 'Before you begin'),
          h(
            'dl',
            { class: 'oit-dl oit-rise' },
            row('What it contains', h('p', null, 'This simulates verbal street harassment, including crude language and intimidation. Nothing graphic is shown.')),
            row('You can stop', h('p', null, 'Press ', keycap('Esc'), ' at any moment to pause. From there you can leave.')),
            row(
              'If you have lived this',
              h('p', null, 'If you have experienced harassment or assault, this may be hard. Choosing not to continue is completely fine. You can close this page now.'),
            ),
            row(
              'Who it is for',
              h('p', null, 'People taking part in respect, consent or bystander training at a university or a workplace. It is a training tool, not a game. There is nothing to win.'),
            ),
          ),
          actions('Continue', () => go(2), true),
        );

      /* Step 3: how it works. */
      const control = (keys: string[], label: string): HTMLElement =>
        h('li', { class: 'oit-control' }, h('span', { class: 'oit-control-keys' }, keys.map((k) => keycap(k))), h('span', null, label));

      const renderHow = (): HTMLElement =>
        h(
          'div',
          { class: 'oit-step' },
          h('h1', { class: 'oit-h1 oit-rise', tabindex: -1, 'data-focus': true }, 'How it works'),
          h(
            'ol',
            { class: 'oit-parts oit-rise' },
            h(
              'li',
              { class: 'oit-part' },
              h('p', { class: 'oit-part-n' }, 'Part 1'),
              h('h2', { class: 'oit-part-title' }, 'Her walk home'),
              h('p', null, 'You are a woman walking home at night. A man starts talking to you. You answer out loud, in your own words, and he reacts to what you say and do.'),
            ),
            h(
              'li',
              { class: 'oit-part' },
              h('p', { class: 'oit-part-n' }, 'Part 2'),
              h('h2', { class: 'oit-part-title' }, 'The same street, as a bystander'),
              h('p', null, 'You see it happen to someone else. What you do about it is up to you.'),
            ),
          ),
          h('p', { class: 'oit-how-note oit-rise' }, 'Each part is followed by a debrief: what happened, and the research behind it.'),
          h(
            'div',
            { class: 'oit-controls-wrap oit-rise' },
            h('h2', { class: 'oit-label' }, 'Controls'),
            h(
              'ul',
              { class: 'oit-controls' },
              control(['W', 'A', 'S', 'D'], 'Walk'),
              control(['Mouse'], 'Look around'),
              control(['Shift'], 'Hurry'),
              control(['Space'], 'Hold to speak'),
              control(['T'], 'Type instead of speaking'),
              control(['Esc'], 'Pause'),
            ),
          ),
          actions('Continue', () => go(3), true),
        );

      /* Step 4: keyboard or body. Asked once; everything after it is set up for that way of playing. */
      const modeCard = (value: PlayMode, title: string, lines: string[]): HTMLElement =>
        h(
          'button',
          {
            class: 'oit-mode-card',
            type: 'button',
            onclick: () => {
              mode = value;
              go(4);
            },
          },
          h('span', { class: 'oit-part-title' }, title),
          h('ul', null, lines.map((line) => h('li', null, line))),
        );

      const renderMode = (): HTMLElement =>
        h(
          'div',
          { class: 'oit-step' },
          h('h1', { class: 'oit-h1 oit-rise', tabindex: -1, 'data-focus': true }, 'How do you want to play?'),
          h(
            'div',
            { class: 'oit-mode-cards oit-rise' },
            modeCard('analog', 'With the keyboard', [
              'W A S D to walk, the mouse to look around.',
              'Hold Space to speak, or press T to type.',
              'When options appear, press 1 to 4 to pick one.',
            ]),
            modeCard('immersive', 'With your body', [
              'Step in place with your phone to walk. Turn your head to look (webcam).',
              'Say things out loud. Look down and pinch to take out your phone. Raise an open hand to ask for help.',
              'When options appear, you have to do them for real.',
            ]),
          ),
          h('div', { class: 'oit-actions oit-rise' }, h('button', { class: 'oit-btn oit-btn--quiet', type: 'button', onclick: () => go(2) }, 'Back')),
        );

      /* Step 5: sound, voices, microphone (and, played with the body, the phone). */
      const renderSound = (): HTMLElement => {
        const status = h('p', { class: 'oit-mic-status', role: 'status', tabindex: -1 });
        const button = h('button', { class: 'oit-btn oit-btn--ghost', type: 'button' }, 'Allow microphone');

        const paint = (): void => {
          status.replaceChildren();
          status.dataset.state = mic;
          // Focus must survive the state change: the button is never disabled outright,
          // and when it goes away focus moves to the result that replaced it.
          const hadFocus = document.activeElement === button;
          button.hidden = mic === 'granted';
          if (mic === 'asking') button.setAttribute('aria-disabled', 'true');
          else button.removeAttribute('aria-disabled');
          if (hadFocus && button.hidden) status.focus({ preventScroll: true });
          button.textContent = mic === 'denied' ? 'Try again' : 'Allow microphone';
          if (mic === 'asking') add(status, 'Waiting for your browser…');
          else if (mic === 'granted') add(status, h('i', { 'aria-hidden': 'true' }), 'Microphone ready.');
          else if (mic === 'denied') {
            add(status, 'The microphone is not available. That is fine: during the simulation, press ', keycap('T'), ' and type what you would say.');
          } else add(status, 'Optional. Without it, press ', keycap('T'), ' and type what you would say.');
        };

        button.addEventListener('click', () => {
          if (mic === 'asking') return;
          mic = 'asking';
          paint();
          let request: Promise<boolean>;
          try {
            request = Promise.resolve(opts.requestMic());
          } catch {
            request = Promise.resolve(false);
          }
          request
            .then((ok) => ok === true)
            .catch(() => false)
            .then((ok) => {
              mic = ok ? 'granted' : 'denied';
              paint();
            });
        });
        paint();

        /* Optional phone pairing: never blocks Continue. */
        const phone = mode === 'immersive' ? options.phone : undefined;
        let phoneRow: HTMLElement | null = null;
        if (phone) {
          const phoneBtn = h('button', { class: 'oit-btn oit-btn--ghost', type: 'button' }, 'Pair your phone');
          const phoneBox = h('div', { class: 'oit-phone-pair' });
          const paintPhone = (): void => {
            phoneBox.replaceChildren();
            if (phone.status === 'off') {
              phoneBtn.hidden = false;
              return;
            }
            phoneBtn.hidden = true;
            const label = { waiting: 'Waiting for your phone', connected: 'Phone connected', lost: 'Phone lost, reconnecting' }[phone.status];
            const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
            add(
              phoneBox,
              h('p', { class: 'oit-phone-code', 'aria-label': `Code ${phone.code.split('').join(' ')}` }, phone.code),
              h('p', { class: 'oit-mic-status' }, `On your phone, open ${location.origin}/phone.html?code=${phone.code}`),
              local
                ? h('p', { class: 'oit-mic-status' }, 'A phone cannot reach localhost. Open the game from the dev server’s tunnel address (press t then Enter in the dev server terminal).')
                : null,
              h('p', { class: 'oit-mic-status', role: 'status', 'data-state': phone.status }, label),
            );
          };
          phoneBtn.addEventListener('click', () => void phone.pair());
          // Stop listening once this step is replaced (the old element leaves the page).
          const off = phone.onChange(() => (phoneBox.isConnected || phoneBtn.isConnected ? paintPhone() : off()));
          paintPhone();
          phoneRow = h('div', { class: 'oit-mic-check' }, phoneBtn, phoneBox);
        }

        return h(
          'div',
          { class: 'oit-step' },
          h('h1', { class: 'oit-h1 oit-rise', tabindex: -1, 'data-focus': true }, 'Sound and voice'),
          h(
            'dl',
            { class: 'oit-dl oit-rise' },
            row('Headphones', h('p', null, 'Wear headphones if you can. The street is all around you, and where a sound comes from matters.')),
            row(
              'Voices',
              opts.voiceAvailable
                ? h('p', null, 'The voices you hear are generated by AI. No real person is speaking to you.')
                : h('p', null, 'Voices are off for this session. What people say will appear as text on the screen.'),
            ),
            row(
              'Microphone',
              h('p', null, 'You answer by holding ', keycap('Space'), ' and speaking. What you say is sent to the simulation’s server so that it can be understood and answered.'),
              h('div', { class: 'oit-mic-check' }, button, status),
            ),
            phoneRow ? row('Phone', h('p', null, 'You walk by stepping in place, with your phone in your pocket. The keys still work if it drops.'), phoneRow) : null,
            mode === 'immersive'
              ? row('Webcam', h('p', null, 'The webcam turns on when you begin: turn your head to look around, and use your hands to act. Nothing leaves your computer.'))
              : null,
          ),
          actions('Begin Part 1', finish, true),
        );
      };

      const steps = [renderTitle, renderNote, renderHow, renderMode, renderSound];

      function go(next: number): void {
        step = Math.min(steps.length - 1, Math.max(0, next));
        el.dataset.step = String(step);
        counter.textContent = step === 0 ? '' : `Step ${step} of ${steps.length - 1}`;
        stage.replaceChildren(steps[step]!());
        el.scrollTop = 0;
        focusStart(stage);
      }

      function finish(): void {
        close(el);
        resolve(mode);
      }

      go(0);
      show(el);
    });
  }

  /* --------------------------------------------------------------- briefing */

  function briefing(pov: Pov): Promise<void> {
    return new Promise<void>((resolve) => {
      const bystander = pov === 'bystander';
      const titleId = nextId('oit-brief');
      const el = h('section', { class: 'oit-screen oit-screen--scrim oit-brief', 'aria-labelledby': titleId, 'data-pov': bystander ? 'bystander' : 'woman' });

      const begin = h(
        'button',
        {
          class: 'oit-btn oit-btn--primary',
          type: 'button',
          onclick: () => {
            // Resolved inside the click: the caller uses this gesture for pointer lock and audio.
            close(el);
            resolve();
          },
        },
        'Begin',
      );

      const affordance = (key: string | null, label: string): HTMLElement =>
        h('li', { class: 'oit-afford' }, h('span', { class: 'oit-afford-key' }, key ? keycap(key) : null), h('span', null, label));

      const body = bystander
        ? [
            h('p', { class: 'oit-eyebrow oit-rise' }, mark(), 'Part 2'),
            h(
              'h1',
              { class: 'oit-brief-lines oit-rise', id: titleId, tabindex: -1, 'data-focus': true },
              h('span', null, 'Same street. Same night.'),
              h('span', null, 'This time you are a few steps behind her.'),
            ),
            h(
              'div',
              { class: 'oit-brief-what oit-rise' },
              h('p', { class: 'oit-label' }, 'What you can do'),
              h(
                'ul',
                { class: 'oit-affords' },
                affordance('Space', 'Hold to speak, to either of them'),
                affordance('F', 'Film what is happening'),
                affordance('E', 'Ask the shopkeeper for help'),
                affordance(null, 'When options appear, pick one, or let it pass'),
              ),
            ),
          ]
        : [
            h('p', { class: 'oit-eyebrow oit-rise' }, mark(), 'Part 1'),
            h(
              'h1',
              { class: 'oit-brief-lines oit-rise', id: titleId, tabindex: -1, 'data-focus': true },
              h('span', null, 'You are walking home.'),
              h('span', null, 'It is late.'),
              h('span', null, 'You are four blocks away.'),
            ),
            h('div', { class: 'oit-brief-what oit-rise' }, h('p', { class: 'oit-brief-task' }, 'Get home.')),
          ];

      add(
        el,
        h(
          'div',
          { class: 'oit-frame oit-brief-frame' },
          h(
            'div',
            { class: 'oit-brief-in' },
            body,
            h('div', { class: 'oit-actions oit-rise' }, begin, h('p', { class: 'oit-brief-esc' }, keycap('Esc'), ' pauses at any time.')),
          ),
        ),
      );
      show(el);
    });
  }

  /* ---------------------------------------------------------------- summary */

  const ACTOR_LABEL: Record<TimelineEntry['actor'], string> = {
    you: 'You',
    man: 'Man',
    woman: 'Woman',
    clerk: 'Clerk',
    thought: 'Inner voice',
    event: '',
  };

  function rationaleBlock(rationale: Rationale, label: string): HTMLElement {
    return h(
      'details',
      { class: 'oit-why' },
      h('summary', null, h('span', { class: 'oit-why-label' }, label), basisBadge(rationale.basis)),
      h('div', { class: 'oit-why-body' }, h('p', null, rationale.text), sourceLine(resolveSources(evidence, rationale.sourceIds))),
    );
  }

  function timelineRow(entry: TimelineEntry): HTMLElement {
    const actor = entry.actor in ACTOR_LABEL ? entry.actor : 'event';
    const why = actor === 'man' ? 'Why he did this' : actor === 'woman' ? 'Why she did this' : 'Why this happened';
    return h(
      'li',
      { class: 'oit-tl-row', 'data-actor': actor },
      h('span', { class: 'oit-tl-time' }, h('span', { class: 'oit-sr' }, 'At '), formatTime(entry.t)),
      h('span', { class: 'oit-tl-who' }, ACTOR_LABEL[actor]),
      h(
        'div',
        { class: 'oit-tl-body' },
        h('p', { class: 'oit-tl-text' }, entry.text),
        entry.rationale && entry.rationale.text ? rationaleBlock(entry.rationale, why) : null,
      ),
      entry.label ? h('span', { class: 'oit-tag' }, entry.label) : h('span', { class: 'oit-tl-notag', 'aria-hidden': 'true' }),
    );
  }

  function renderTimeline(entries: TimelineEntry[]): HTMLElement | null {
    const rows = entries.filter((entry) => entry && typeof entry.text === 'string' && entry.text.trim());
    if (rows.length === 0) return null;
    return section('What happened', 'oit-sec--timeline', h('ol', { class: 'oit-tl' }, rows.map(timelineRow)));
  }

  function renderInsights(insights: Insight[]): HTMLElement | null {
    const items = insights.filter((insight) => insight && (insight.title || insight.body));
    if (items.length === 0) return null;
    return section(
      'In context',
      'oit-sec--insights',
      items.map((insight) => {
        const stats = resolveStats(evidence, insight.statIds);
        return h(
          'article',
          { class: 'oit-insight' },
          insight.title ? h('h3', { class: 'oit-insight-title' }, insight.title) : null,
          paragraphs(insight.body, 'oit-insight-body'),
          stats.length ? h('div', { class: 'oit-insight-stats' }, stats.map((stat) => statBlock(stat, 'inline'))) : null,
        );
      }),
    );
  }

  function renderStats(statIds: string[]): HTMLElement | null {
    const stats = resolveStats(evidence, statIds);
    if (stats.length === 0) return null;
    return section('In numbers', 'oit-sec--stats', h('div', { class: `oit-stats${stats.length % 2 === 1 ? ' is-odd' : ''}` }, stats.map((stat) => statBlock(stat, 'feature'))));
  }

  function renderCase(caseStudyId: string | undefined): HTMLElement | null {
    if (!caseStudyId) return null;
    const study: CaseStudy | undefined = evidence.caseStudies.find((c) => c.id === caseStudyId);
    if (!study) return null;
    const meta = [study.location, Number.isFinite(study.year) ? String(study.year) : ''].filter(Boolean).join(', ');
    return section(
      'A real case',
      'oit-sec--case',
      h(
        'article',
        { class: 'oit-case' },
        h('p', { class: 'oit-case-flag' }, 'This is not part of the simulation. It happened.'),
        h('h3', { class: 'oit-case-name' }, study.name),
        meta ? h('p', { class: 'oit-case-meta' }, meta) : null,
        paragraphs(study.summary, 'oit-case-summary'),
        sourceLine(resolveSources(evidence, study.sourceIds)),
      ),
    );
  }

  function renderFiveDs(results: FiveDResult[]): HTMLElement | null {
    const definitions = evidence.bystander.fiveDs;
    const order: string[] = definitions.map((d) => d.key);
    for (const result of results) if (result && result.key && !order.includes(result.key)) order.push(result.key);
    if (order.length === 0) return null;

    const items = order.map((key) => {
      const definition = definitions.find((d) => d.key === key);
      const result = results.find((r) => r && r.key === key);
      const name = definition?.name || key.charAt(0).toUpperCase() + key.slice(1);
      const moments = (result?.moments ?? []).filter((m) => typeof m === 'string' && m.trim());
      return h(
        'li',
        { class: `oit-d${result?.used ? ' is-used' : ''}` },
        h(
          'div',
          { class: 'oit-d-head' },
          h('h3', { class: 'oit-d-name' }, name),
          result ? h('p', { class: 'oit-d-state' }, h('i', { 'aria-hidden': 'true' }), result.used ? 'You did this' : 'Not used this time') : null,
        ),
        h(
          'div',
          { class: 'oit-d-body' },
          definition?.description ? h('p', { class: 'oit-d-desc' }, definition.description) : null,
          definition?.example ? h('p', { class: 'oit-d-example' }, h('span', { class: 'oit-d-k' }, 'For example'), definition.example) : null,
          moments.length
            ? h('div', { class: 'oit-d-moments' }, h('p', { class: 'oit-d-k' }, 'On your walk'), h('ul', null, moments.map((moment) => h('li', null, moment))))
            : null,
          result?.feedback ? h('p', { class: 'oit-d-feedback' }, result.feedback) : null,
        ),
      );
    });

    const findings = evidence.bystander.findings;
    const finding = (f: { finding: string; sourceId: string }): HTMLElement => h('li', { class: 'oit-note' }, h('p', null, f.finding), sourceLine(resolveSources(evidence, [f.sourceId])));
    const shown = findings.slice(0, 3);
    const more = findings.slice(3);
    return section(
      'Five ways to step in',
      'oit-sec--fived',
      h('p', { class: 'oit-sec-lede' }, 'These are known as the 5 Ds of bystander intervention. They are a repertoire, not a checklist and not a score. Which one fits depends on the moment.'),
      h('ol', { class: 'oit-ds' }, items),
      findings.length
        ? h(
            'div',
            { class: 'oit-findings' },
            h('h3', { class: 'oit-label' }, 'What research says about bystanders'),
            h('ul', { class: 'oit-notes' }, shown.map(finding)),
            more.length ? disclosure(`${more.length} more ${more.length === 1 ? 'finding' : 'findings'}`, h('ul', { class: 'oit-notes' }, more.map(finding))) : null,
          )
        : null,
    );
  }

  function renderModel(notes: Rationale[]): HTMLElement | null {
    const items = notes.filter((note) => note && typeof note.text === 'string' && note.text.trim());
    const calibration = evidence.modelCalibration;
    const behaviour = evidence.harasserBehaviour;
    if (items.length === 0 && !calibration.notes && calibration.parameters.length === 0 && behaviour.length === 0) return null;

    const legend = h(
      'dl',
      { class: 'oit-legend' },
      h('div', null, h('dt', null, basisBadge('data')), h('dd', null, 'Taken directly from a published figure.')),
      h('div', null, h('dt', null, basisBadge('inferred')), h('dd', null, 'Derived from published findings gathered in a different setting, or by combining them.')),
      h('div', null, h('dt', null, basisBadge('assumption')), h('dd', null, 'Nobody has measured this. The value is a judgement by the people who built the model.')),
    );

    const noteList = items.length
      ? h(
          'ul',
          { class: 'oit-notes' },
          items.map((note) => h('li', { class: 'oit-note' }, basisBadge(note.basis), h('p', null, note.text), sourceLine(resolveSources(evidence, note.sourceIds)))),
        )
      : null;

    const behaviourList = behaviour.length
      ? disclosure(
          `Research findings the model draws on (${behaviour.length})`,
          h(
            'ul',
            { class: 'oit-notes' },
            behaviour.map((f) => h('li', { class: 'oit-note' }, basisBadge(f.confidence === 'data' ? 'data' : 'inferred'), h('p', null, f.finding), sourceLine(resolveSources(evidence, [f.sourceId])))),
          ),
        )
      : null;

    const number = (n: number): string => (Number.isFinite(n) ? String(Number(n.toFixed(3))) : '');
    const parameterTable = calibration.parameters.length
      ? disclosure(
          `Model parameters (${calibration.parameters.length})`,
          paragraphs(calibration.notes, 'oit-model-notes'),
          h(
            'div',
            { class: 'oit-table-wrap', tabindex: 0, role: 'region', 'aria-label': 'Model parameters' },
            h(
              'table',
              { class: 'oit-table' },
              h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Parameter'), h('th', { scope: 'col' }, 'Value'), h('th', { scope: 'col' }, 'Basis'), h('th', { scope: 'col' }, 'Reasoning'))),
              h(
                'tbody',
                null,
                calibration.parameters.map((p) =>
                  h(
                    'tr',
                    null,
                    h('th', { scope: 'row' }, h('code', null, p.key)),
                    h('td', { class: 'oit-table-num' }, number(p.value), Array.isArray(p.range) && p.range.length === 2 ? h('span', { class: 'oit-table-range' }, `${number(p.range[0])} to ${number(p.range[1])}`) : null),
                    h('td', null, basisBadge(p.basis)),
                    h('td', null, h('p', null, p.rationale), sourceLine(resolveSources(evidence, p.sourceIds))),
                  ),
                ),
              ),
            ),
          ),
        )
      : null;

    return h(
      'section',
      { class: 'oit-sec oit-sec--model' },
      h('h2', { class: 'oit-sec-title' }, 'The model'),
      h(
        'div',
        { class: 'oit-sec-body' },
        h(
          'details',
          { class: 'oit-model' },
          h('summary', null, h('span', { class: 'oit-model-title' }, 'How his behaviour was decided'), h('span', { class: 'oit-model-hint' }, 'Sources and assumptions')),
          h(
            'div',
            { class: 'oit-model-body' },
            h(
              'p',
              { class: 'oit-sec-lede' },
              'What the man does next is chosen by a decision model that reacts to what you say and do. Some of that model rests on published data, some is inferred from research, and some is assumption. Each note says which.',
            ),
            legend,
            calibration.parameters.length ? null : paragraphs(calibration.notes, 'oit-model-notes'),
            noteList,
            behaviourList,
            parameterTable,
          ),
        ),
      ),
    );
  }

  function summary(data: SummaryData): Promise<'continue' | 'retry'> {
    return new Promise<'continue' | 'retry'>((resolve) => {
      const pov: Pov = data.pov === 'bystander' ? 'bystander' : 'woman';
      const titleId = nextId('oit-sum');
      const el = h('section', { class: 'oit-screen oit-summary', 'aria-labelledby': titleId, 'data-pov': pov, 'data-outcome': data.outcome?.kind ?? '' });

      const finish = (choice: 'continue' | 'retry'): void => {
        close(el);
        resolve(choice);
      };
      const continueBtn = h('button', { class: 'oit-btn oit-btn--primary', type: 'button', onclick: () => finish('continue') }, pov === 'woman' ? 'Continue to Part 2' : 'Continue');
      const retryBtn = h('button', { class: 'oit-btn oit-btn--ghost', type: 'button', onclick: () => finish('retry') }, 'Walk it again');

      const duration = Number.isFinite(data.durationSec) && data.durationSec > 0 ? data.durationSec : 0;
      const header = h(
        'header',
        { class: 'oit-sum-head' },
        h('p', { class: 'oit-eyebrow oit-rise' }, pov === 'woman' ? 'Part 1 of 2 · Debrief' : 'Part 2 of 2 · Debrief'),
        h('h1', { class: 'oit-sum-title oit-rise', id: titleId, tabindex: -1, 'data-focus': true }, data.outcome?.title || 'Debrief'),
        h('div', { class: 'oit-sum-lede oit-rise' }, paragraphs(data.outcome?.body)),
        duration ? h('p', { class: 'oit-sum-meta oit-rise' }, `${pov === 'woman' ? 'Your walk' : 'The scene'} lasted ${formatDuration(duration)}.`) : null,
      );

      const noFault =
        pov === 'woman'
          ? h(
              'section',
              { class: 'oit-sec oit-sec--plain', 'aria-label': 'Whose fault this was' },
              h('span', { class: 'oit-sec-title', 'aria-hidden': 'true' }),
              h(
                'div',
                { class: 'oit-sec-body' },
                h(
                  'div',
                  { class: 'oit-nofault' },
                  h('p', { class: 'oit-nofault-lead' }, 'Nothing you said or did as her made this her fault.'),
                  h(
                    'p',
                    null,
                    'There is no correct response to harassment. Saying nothing, being polite, saying no, walking faster, asking for help: none of these is the wrong choice, and none of them makes his behaviour her responsibility. This debrief explains what he did. It does not grade what you did.',
                  ),
                ),
              ),
            )
          : null;

      const timeline = renderTimeline(Array.isArray(data.timeline) ? data.timeline : []);
      const insights = renderInsights(Array.isArray(data.insights) ? data.insights : []);
      const stats = renderStats(Array.isArray(data.statIds) ? data.statIds : []);
      const caseStudy = renderCase(data.caseStudyId);
      const fiveDs = pov === 'bystander' ? renderFiveDs(Array.isArray(data.fiveDs) ? data.fiveDs : []) : null;
      const model = renderModel(Array.isArray(data.modelNotes) ? data.modelNotes : []);

      // Part 2: the outcome, then straight on to the teaching replay. The full debrief is kept, unchanged, behind a disclosure.
      if (pov === 'bystander') {
        const learnBtn = h('button', { class: 'oit-btn oit-btn--primary', type: 'button', onclick: () => finish('continue') }, 'Learn how to help');
        const fullId = nextId('oit-full');
        add(
          el,
          h(
            'div',
            { class: 'oit-frame' },
            h('div', { class: 'oit-topbar oit-topbar--static' }, wordmark()),
            h(
              'article',
              { class: 'oit-article' },
              header,
              h(
                'section',
                { class: 'oit-sec oit-sec--plain oit-sec--next', 'aria-label': 'What next' },
                h('span', { class: 'oit-sec-title', 'aria-hidden': 'true' }),
                h(
                  'div',
                  { class: 'oit-sec-body' },
                  h('p', { class: 'oit-next-note' }, 'Next: the same street once more. It will stop at five moments and show what helps.'),
                  h('div', { class: 'oit-actions' }, learnBtn, retryBtn),
                ),
              ),
              h(
                'details',
                { class: 'oit-full', id: fullId },
                h('summary', null, h('span', { class: 'oit-full-title' }, 'See full details'), h('span', { class: 'oit-full-hint' }, 'Timeline, the 5 Ds, research, the model')),
                h('div', { class: 'oit-full-body' }, timeline, fiveDs, insights, stats, caseStudy, model),
              ),
            ),
          ),
        );
        show(el);
        return;
      }

      const actionsId = nextId('oit-sum-actions');
      add(
        el,
        h('a', { class: 'oit-skip', href: `#${actionsId}`, onclick: (e: Event) => { e.preventDefault(); continueBtn.focus(); } }, 'Skip to the end of the debrief'),
        h(
          'div',
          { class: 'oit-frame' },
          h('div', { class: 'oit-topbar oit-topbar--static' }, wordmark()),
          h('article', { class: 'oit-article' }, header, noFault, timeline, fiveDs, insights, stats, caseStudy, model),
          h(
            'footer',
            { class: 'oit-sum-foot', id: actionsId },
            h('p', { class: 'oit-sum-foot-note' }, pov === 'woman' ? 'Next: the same street, as a bystander.' : 'Next: support, and the sources behind this.'),
            h('div', { class: 'oit-sum-foot-actions' }, retryBtn, continueBtn),
          ),
        ),
      );
      show(el);
    });
  }

  /* ---------------------------------------------------------- teaching replay */

  function recap(opts: {
    title: string;
    fiveDs: Array<{ name: string; line: string; firstPick: boolean }>;
    stepsTitle: string;
    steps: Array<{ name: string; line: string }>;
    closing: string;
  }): Promise<void> {
    return new Promise<void>((resolve) => {
      const titleId = nextId('oit-recap');
      const el = h('section', { class: 'oit-screen oit-summary oit-recap', 'aria-labelledby': titleId });
      const next = h(
        'button',
        {
          class: 'oit-btn oit-btn--primary',
          type: 'button',
          onclick: () => {
            close(el);
            resolve();
          },
        },
        'Continue',
      );
      const picked = opts.fiveDs.filter((d) => d.firstPick).length;
      add(
        el,
        h(
          'div',
          { class: 'oit-frame' },
          h('div', { class: 'oit-topbar oit-topbar--static' }, wordmark()),
          h(
            'article',
            { class: 'oit-article' },
            h(
              'header',
              { class: 'oit-sum-head' },
              h('p', { class: 'oit-eyebrow oit-rise' }, 'Part 2 · How to help'),
              h('h1', { class: 'oit-sum-title oit-rise', id: titleId, tabindex: -1, 'data-focus': true }, opts.title),
            ),
            section(
              'The 5 Ds',
              'oit-sec--recap',
              h(
                'p',
                { class: 'oit-sec-lede' },
                picked ? 'A tick marks the ones you chose first in the replay.' : 'None of these was your first choice in the replay. Each one is open to you.',
              ),
              h(
                'ul',
                { class: 'oit-recap-ds' },
                opts.fiveDs.map((d) =>
                  h(
                    'li',
                    { class: d.firstPick ? 'is-picked' : null },
                    h('span', { class: 'oit-recap-tick', 'aria-hidden': 'true' }),
                    h(
                      'span',
                      null,
                      h('span', { class: 'oit-recap-name' }, d.name),
                      d.firstPick ? h('span', { class: 'oit-sr' }, ' (your first choice)') : null,
                      h('span', { class: 'oit-recap-line' }, d.line),
                    ),
                  ),
                ),
              ),
            ),
            section(
              opts.stepsTitle,
              'oit-sec--steps',
              h(
                'ol',
                { class: 'oit-recap-steps' },
                opts.steps.map((s) => h('li', null, h('span', null, h('span', { class: 'oit-recap-name' }, s.name), h('span', { class: 'oit-recap-line' }, s.line)))),
              ),
            ),
            h(
              'section',
              { class: 'oit-sec oit-sec--plain oit-sec--end' },
              h('span', { class: 'oit-sec-title', 'aria-hidden': 'true' }),
              h('div', { class: 'oit-sec-body' }, h('p', { class: 'oit-recap-closing' }, opts.closing), h('div', { class: 'oit-actions' }, next)),
            ),
          ),
        ),
      );
      show(el);
    });
  }

  /* ---------------------------------------------------------------- closing */

  const REGION_ORDER: SupportResource['region'][] = ['us', 'nyc', 'uk', 'international'];
  const REGION_LABEL: Record<string, string> = {
    nyc: 'New York City',
    us: 'United States',
    uk: 'United Kingdom',
    international: 'International',
  };

  function phoneLink(phone: string): HTMLElement {
    // Only plain numbers become tel: links; anything with words ("text HOME to ...") stays as written.
    if (/^[\d\s()+\-.]{3,}$/.test(phone)) {
      return h('a', { class: 'oit-res-phone', href: `tel:${phone.replace(/[^\d+]/g, '')}` }, phone);
    }
    return h('span', { class: 'oit-res-phone' }, phone);
  }

  function resourceItem(resource: SupportResource): HTMLElement {
    const url = safeUrl(resource.url);
    return h(
      'li',
      { class: 'oit-res' },
      h('h4', { class: 'oit-res-name' }, resource.name),
      resource.description ? h('p', { class: 'oit-res-desc' }, resource.description) : null,
      h(
        'p',
        { class: 'oit-res-contact' },
        resource.phone ? phoneLink(resource.phone) : null,
        url
          ? h(
              'a',
              { class: 'oit-res-url', href: url, target: '_blank', rel: 'noopener noreferrer' },
              hostOf(url),
              h('span', { class: 'oit-ext', 'aria-hidden': 'true' }, '↗'),
              h('span', { class: 'oit-sr' }, ` (${resource.name}, opens in a new tab)`),
            )
          : null,
      ),
    );
  }

  function renderResources(): HTMLElement | null {
    const resources = evidence.resources;
    if (resources.length === 0) return null;
    const regions = [...REGION_ORDER, ...resources.map((r) => r.region).filter((region) => !REGION_ORDER.includes(region))];
    const groups = [...new Set(regions)]
      .map((region) => ({ region, items: resources.filter((r) => r.region === region) }))
      .filter((group) => group.items.length > 0);
    return section(
      'Support',
      'oit-sec--resources',
      h('p', { class: 'oit-sec-lede' }, 'If any of this was close to something you have lived through, these organisations can help, whenever you are ready.'),
      groups.map((group) =>
        h('div', { class: 'oit-res-group' }, h('h3', { class: 'oit-label' }, REGION_LABEL[group.region] ?? group.region), h('ul', { class: 'oit-res-list' }, group.items.map(resourceItem))),
      ),
    );
  }

  function renderSources(): HTMLElement | null {
    const sources = Object.values(evidence.sources).sort((a, b) => (a.publisher || a.title).localeCompare(b.publisher || b.title) || a.year - b.year);
    if (sources.length === 0) return null;
    return section(
      'Sources',
      'oit-sec--sources',
      h('p', { class: 'oit-sec-lede' }, 'Every figure and every case in this simulation comes from one of these.'),
      h(
        'ol',
        { class: 'oit-biblio' },
        sources.map((source) => {
          const url = safeUrl(source.url);
          return h(
            'li',
            null,
            h('span', { class: 'oit-biblio-pub' }, sourceLabel(source)),
            source.title && source.publisher ? h('span', { class: 'oit-biblio-title' }, source.title) : null,
            h(
              'span',
              { class: 'oit-biblio-meta' },
              url
                ? h(
                    'a',
                    { href: url, target: '_blank', rel: 'noopener noreferrer' },
                    hostOf(url),
                    h('span', { class: 'oit-ext', 'aria-hidden': 'true' }, '↗'),
                    h('span', { class: 'oit-sr' }, ` (${source.title || source.publisher}, opens in a new tab)`),
                  )
                : null,
              source.accessed ? h('span', null, `Accessed ${formatDate(source.accessed)}`) : null,
            ),
          );
        }),
      ),
    );
  }

  function closing(): Promise<'restart'> {
    return new Promise<'restart'>((resolve) => {
      const titleId = nextId('oit-closing');
      const el = h('section', { class: 'oit-screen oit-closing', 'aria-labelledby': titleId });
      const restart = h(
        'button',
        {
          class: 'oit-btn oit-btn--ghost',
          type: 'button',
          onclick: () => {
            close(el);
            resolve('restart');
          },
        },
        'Start over',
      );
      const stat = headlineStat(evidence);
      add(
        el,
        h(
          'div',
          { class: 'oit-frame' },
          h('div', { class: 'oit-topbar oit-topbar--static' }, wordmark()),
          h(
            'article',
            { class: 'oit-article' },
            h(
              'header',
              { class: 'oit-sum-head' },
              h('p', { class: 'oit-eyebrow oit-rise' }, 'The end'),
              h('h1', { class: 'oit-sum-title oit-rise', id: titleId, tabindex: -1, 'data-focus': true }, 'The simulation ends here. What it shows does not.'),
              h(
                'div',
                { class: 'oit-sum-lede oit-rise' },
                h('p', null, 'However much of it you walked, that was enough. What you notice on a real street, what you say and whether you step in are yours to decide.'),
              ),
            ),
            // Support comes first: someone who stopped early should not have to scroll for it.
            renderResources(),
            stat ? section(PRODUCT, 'oit-sec--named', statBlock(stat, 'feature')) : null,
            renderSources(),
            h('section', { class: 'oit-sec oit-sec--plain oit-sec--end' }, h('span', { class: 'oit-sec-title', 'aria-hidden': 'true' }), h('div', { class: 'oit-sec-body' }, h('div', { class: 'oit-actions' }, restart))),
          ),
        ),
      );
      show(el);
    });
  }

  /* ------------------------------------------------------- loading and error */

  let loadingEl: HTMLElement | null = null;
  let loadingText: HTMLElement | null = null;
  let loadingBar: HTMLElement | null = null;
  let loadingFill: HTMLElement | null = null;
  let errorEl: HTMLElement | null = null;

  function loading(message: string | null, fraction?: number): void {
    if (message === null) {
      const el = loadingEl;
      loadingEl = loadingText = loadingBar = loadingFill = null;
      if (el) {
        el.classList.remove('is-in');
        el.classList.add('is-out');
        window.setTimeout(() => el.remove(), 500);
      }
      return;
    }
    if (!loadingEl) {
      loadingText = h('p', { class: 'oit-loading-text' });
      loadingFill = h('i');
      loadingBar = h('div', { class: 'oit-loading-bar', role: 'progressbar', 'aria-label': 'Loading', 'aria-valuemin': 0, 'aria-valuemax': 100 }, loadingFill);
      loadingEl = h('div', { class: 'oit-loading', role: 'status', 'aria-live': 'polite' }, h('div', { class: 'oit-loading-in' }, mark(), loadingText, loadingBar));
      root.appendChild(loadingEl);
      reflow(loadingEl);
      loadingEl.classList.add('is-in');
    }
    // A bare ellipsis is a "one moment" with nothing to say: show the line alone.
    const text = message.replace(/^[.…\s]+$/, '');
    loadingText!.textContent = text;
    loadingText!.hidden = text === '';
    if (typeof fraction === 'number' && Number.isFinite(fraction)) {
      const value = clamp01(fraction);
      loadingBar!.classList.remove('is-indeterminate');
      loadingBar!.setAttribute('aria-valuenow', String(Math.round(value * 100)));
      loadingFill!.style.transform = `scaleX(${value.toFixed(4)})`;
    } else {
      loadingBar!.classList.add('is-indeterminate');
      loadingBar!.removeAttribute('aria-valuenow');
      loadingFill!.style.transform = '';
    }
  }

  function error(message: string): void {
    loading(null);
    if (current) {
      const leaving = current;
      current = null;
      dismiss(leaving);
    }
    dismiss(errorEl);
    const titleId = nextId('oit-error');
    const reload = h('button', { class: 'oit-btn oit-btn--primary', type: 'button', onclick: () => window.location.reload() }, 'Reload the page');
    const el = h(
      'section',
      { class: 'oit-screen oit-error', role: 'alert', 'aria-labelledby': titleId },
      h(
        'div',
        { class: 'oit-frame oit-brief-frame' },
        h(
          'div',
          { class: 'oit-brief-in' },
          h('p', { class: 'oit-eyebrow' }, mark(), PRODUCT),
          h('h1', { class: 'oit-h1', id: titleId, tabindex: -1, 'data-focus': true }, 'The simulation has stopped.'),
          h('p', { class: 'oit-error-msg' }, message || 'Something went wrong.'),
          h('div', { class: 'oit-actions' }, reload, h('p', { class: 'oit-brief-esc' }, 'Reloading starts again from the beginning.')),
        ),
      ),
    );
    errorEl = el;
    root.appendChild(el);
    reflow(el);
    el.classList.add('is-in');
    focusStart(el);
  }

  return { intro, briefing, summary, recap, closing, loading, error };
}
