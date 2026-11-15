/**
 * Interactive pieces for the Part 2 debrief and the recap, replacing reading
 * with doing:
 *
 *   createFiveCards   your 5 Ds as a hand of cards: the ones you used land
 *                     face-up with your own words; flip the others to see what
 *                     they could have looked like on this street
 *   createGuessStat   "out of 100": set your guess on a grid of 100 people,
 *                     then the cited figure fills in beside it
 *   createPledge      "Next time, I'll…": pick one, get a card to remember it by
 *
 * The pure helpers (parsePercent, pickGuessStat, fiveCardModels) are tested.
 */

import './debriefCards.css';
import guided from '../../content/guided.json';
import type { FiveDResult } from '../../shared/types';
import { h, nextId } from './dom';

export type FiveDKey = FiveDResult['key'];
export const FIVE_D_ORDER: FiveDKey[] = ['distract', 'delegate', 'document', 'delay', 'direct'];

interface StatLike {
  id: string;
  headline: string;
  text: string;
  sourceId?: string;
}

/* ------------------------------------------------------------------ pure */

/** "65%" -> 65, "1 in 5" -> 20. Null for anything that is not a share of people. */
export function parsePercent(headline: string): number | null {
  const pct = headline.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pct) {
    const v = Number(pct[1]);
    return v >= 0 && v <= 100 ? Math.round(v) : null;
  }
  const ratio = headline.match(/(\d+)\s+in\s+(\d+)/i);
  if (ratio) {
    const v = (Number(ratio[1]) / Number(ratio[2])) * 100;
    return v > 0 && v <= 100 ? Math.floor(v) : null;
  }
  return null;
}

/** Questions written for specific stats, so the wording is exact. First one that resolves wins by default. */
export const GUESS_QUESTIONS: Array<{ statId: string; question: string; unit: string }> = [
  { statId: 'ssh2014_65', question: 'Out of 100 women in the US, how many have been harassed on the street?', unit: 'women' },
  { statId: 'nyc_bystanders_present_31', question: 'Out of 100 street harassment incidents in New York, how many had bystanders around?', unit: 'incidents' },
  { statId: 'ssh2014_repeat_86', question: 'Out of 100 US women who have been harassed on the street, how many say it happened more than once?', unit: 'women' },
];

export function pickGuessStat(
  citedIds: readonly string[],
  lookup: (id: string) => StatLike | null,
): { stat: StatLike; question: string; unit: string; value: number } | null {
  const usable = GUESS_QUESTIONS.map((q) => {
    const stat = lookup(q.statId);
    const value = stat ? parsePercent(stat.headline) : null;
    return stat && value !== null ? { stat, question: q.question, unit: q.unit, value } : null;
  }).filter((x): x is NonNullable<typeof x> => !!x);
  return usable.find((u) => citedIds.includes(u.stat.id)) ?? usable[0] ?? null;
}

export interface FiveCard {
  key: FiveDKey;
  name: string;
  used: boolean;
  /** Your own words (or what you did), shortened, when you used it. */
  quote: string | null;
  /** True when `quote` is something you said (shown in quotes), false for something you did. */
  spoken: boolean;
  /** First sentence of the feedback when there is no quote. */
  note: string | null;
  /** What it could have looked like on this street. */
  example: string;
}

const shorten = (s: string, max = 120) => {
  const t = s.trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 20)).trimEnd()}…`;
};
/**
 * The debrief marks speech with quotes ("Leave her alone.") and actions as sentences ("You filmed what was
 * happening."). Strip the quotes, so the card adds its own pair only once, and keep actions unquoted.
 */
function readMoment(m: string): { text: string; spoken: boolean } {
  const t = m.trim();
  const quoted = /^["“'‘]([\s\S]*)["”'’]$/.exec(t);
  if (quoted) return { text: quoted[1]!.trim(), spoken: true };
  if (/^You\b/.test(t)) return { text: t, spoken: false };
  return { text: t, spoken: true };
}
const firstSentence = (s: string) => (s.match(/^.*?[.!?](\s|$)/)?.[0] ?? s).trim();

export function fiveCardModels(results: readonly FiveDResult[], lines: Record<FiveDKey, { name: string; line: string }>): FiveCard[] {
  return FIVE_D_ORDER.map((key) => {
    const r = results.find((x) => x.key === key);
    const used = !!r?.used;
    const raw = used ? r!.moments.find((m) => m.trim()) : undefined;
    const moment = raw ? readMoment(raw) : undefined;
    return {
      key,
      name: lines[key].name,
      used,
      quote: moment ? shorten(moment.text) : null,
      spoken: moment?.spoken ?? false,
      note: used && !moment && r!.feedback ? firstSentence(r!.feedback) : null,
      example: lines[key].line,
    };
  });
}

/** The one-line "what it looks like" per D, from the teaching replay's content. */
export function guidedLines(): Record<FiveDKey, { name: string; line: string }> {
  const out = {} as Record<FiveDKey, { name: string; line: string }>;
  for (const d of (guided as { recap: { fiveDs: Array<{ key: FiveDKey; name: string; line: string }> } }).recap.fiveDs) out[d.key] = { name: d.name, line: d.line };
  return out;
}

/* ------------------------------------------------------------- your cards */

export function createFiveCards(results: readonly FiveDResult[]): HTMLElement | null {
  if (!results.length) return null;
  const cards = fiveCardModels(results, guidedLines());
  const usedCount = cards.filter((c) => c.used).length;
  const status = h('p', { class: 'oit-sr', role: 'status', 'aria-live': 'polite' });

  const items = cards.map((c, i) => {
    const face = h(
      'div',
      { class: 'oit-dcard-face oit-dcard-front' },
      h('span', { class: 'oit-dcard-name' }, c.name),
      c.used
        ? c.quote
          ? h('p', { class: 'oit-dcard-quote' }, c.spoken ? `“${c.quote}”` : c.quote)
          : h('p', { class: 'oit-dcard-text' }, c.note ?? 'You did this.')
        : h('p', { class: 'oit-dcard-text' }, c.example),
      h('span', { class: 'oit-dcard-tag' }, c.used ? 'You did this' : 'You could have'),
    );
    const back = h(
      'div',
      { class: 'oit-dcard-face oit-dcard-back', 'aria-hidden': 'true' },
      h('span', { class: 'oit-dcard-name' }, c.name),
      h('span', { class: 'oit-dcard-flip' }, 'Tap to flip'),
    );
    const card = h(
      'button',
      {
        class: 'oit-dcard',
        type: 'button',
        'data-used': String(c.used),
        'data-flipped': String(c.used),
        style: `--i:${i}`,
        'aria-pressed': String(c.used),
        'aria-label': c.used ? `${c.name}: you did this.` : `${c.name}: not used. Flip to see what it could have looked like.`,
        disabled: c.used,
        onclick: () => {
          card.dataset.flipped = 'true';
          card.setAttribute('aria-pressed', 'true');
          card.setAttribute('aria-label', `${c.name}: ${c.example}`);
          status.textContent = `${c.name}. ${c.example}`;
        },
      },
      h('span', { class: 'oit-dcard-inner' }, face, back),
    );
    return h('li', null, card);
  });

  return h(
    'div',
    { class: 'oit-dcards' },
    h('p', { class: 'oit-dcards-lede' }, usedCount === 0 ? 'You did not step in this time. Flip the cards: each is a way you could have.' : usedCount === 5 ? 'You used all five.' : `You used ${usedCount} of the five. Flip the others to see how they would have looked here.`),
    h('ul', { class: 'oit-dcards-hand' }, items),
    status,
  );
}

/* --------------------------------------------------------- guess, then see */

export function createGuessStat(
  citedIds: readonly string[],
  lookup: (id: string) => StatLike | null,
  sourceLabel: (sourceId: string | undefined) => string,
): HTMLElement | null {
  const pick = pickGuessStat(citedIds, lookup);
  if (!pick) return null;
  const sliderId = nextId('oit-guess');
  let guess = 50;

  const dots = Array.from({ length: 100 }, () => h('i', { class: 'oit-guess-dot' }));
  const grid = h('div', { class: 'oit-guess-grid', 'aria-hidden': 'true' }, dots);
  const value = h('output', { class: 'oit-guess-value', for: sliderId }, '50');
  const slider = h('input', { id: sliderId, class: 'oit-guess-slider', type: 'range', min: '0', max: '100', step: '1', value: '50' }) as HTMLInputElement;
  const reveal = h('button', { class: 'oit-btn oit-btn--primary oit-guess-btn', type: 'button' }, 'Show me');
  const result = h('div', { class: 'oit-guess-result', role: 'status', 'aria-live': 'polite' });

  const paint = (n: number, real: number | null) => {
    dots.forEach((d, i) => {
      d.dataset.guess = String(i < n);
      d.dataset.real = String(real !== null && i < real);
    });
  };
  paint(guess, null);
  slider.addEventListener('input', () => {
    guess = Number(slider.value);
    value.textContent = String(guess);
    paint(guess, null);
  });
  reveal.addEventListener('click', () => {
    slider.disabled = true;
    reveal.hidden = true;
    root.dataset.revealed = 'true';
    paint(guess, pick.value);
    const diff = pick.value - guess;
    const verdict = Math.abs(diff) <= 5 ? 'Close.' : diff > 0 ? `${diff} more than you guessed.` : `${-diff} fewer than you guessed.`;
    result.replaceChildren(
      h('p', { class: 'oit-guess-answer' }, h('strong', null, `${pick.value} out of 100`), ` ${pick.unit}. You guessed ${guess}. ${verdict}`),
      h('p', { class: 'oit-guess-key' }, diff > 0 ? 'Pale gold: the ones your guess left out.' : diff < 0 ? 'Outlined: more than there really are.' : ''),
      h('p', { class: 'oit-guess-full' }, `${pick.stat.headline} ${pick.stat.text}`),
      h('p', { class: 'oit-guess-source' }, sourceLabel(pick.stat.sourceId)),
    );
  });

  const root = h(
    'div',
    { class: 'oit-guess', 'data-revealed': 'false' },
    h('label', { class: 'oit-guess-q', for: sliderId }, pick.question),
    grid,
    h('div', { class: 'oit-guess-controls' }, slider, value, reveal),
    result,
  );
  return root;
}

/* -------------------------------------------------- one thing you'll do */

export function createPledge(fiveDs: ReadonlyArray<{ name: string; line: string }>): HTMLElement {
  const card = h('div', { class: 'oit-pledge-card', hidden: true, role: 'status', 'aria-live': 'polite' });
  const choices = h(
    'div',
    { class: 'oit-pledge-choices', role: 'group', 'aria-label': 'Next time, I’ll…' },
    fiveDs.map((d) =>
      h(
        'button',
        {
          class: 'oit-pledge-choice',
          type: 'button',
          onclick: (e: Event) => {
            for (const b of choices.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === e.currentTarget));
            card.hidden = false;
            card.replaceChildren(h('p', { class: 'oit-pledge-eyebrow' }, 'Next time'), h('p', { class: 'oit-pledge-big' }, `I’ll ${d.name}.`), h('p', { class: 'oit-pledge-line' }, d.line));
            card.classList.remove('oit-pledge-card--in');
            void card.offsetWidth;
            card.classList.add('oit-pledge-card--in');
          },
          'aria-pressed': 'false',
        },
        d.name,
      ),
    ),
  );
  return h('div', { class: 'oit-pledge' }, h('p', { class: 'oit-pledge-q' }, 'Next time, I’ll…'), choices, card);
}
