/**
 * DEV HARNESS ONLY. A scripted pass over every promise and state change in the
 * HUD and the screens, run with  dev/ui.html?view=selftest .
 * Results are written as JSON into <pre id="selftest"> (and logged), so the
 * page can be checked by eye or dumped from a headless browser:
 *
 *   chrome-headless-shell --virtual-time-budget=60000 --dump-dom \
 *     "http://localhost:5185/dev/ui.html?view=selftest" | grep -A200 'id="selftest"'
 */

import type { Hud, Screens } from '../src/contracts';
import type { Evidence } from '../shared/evidence';
import { minimalSummary, mockSummary } from './mock';

type Result = Record<string, unknown>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const q = <T extends HTMLElement = HTMLElement>(selector: string): T | null => document.querySelector<T>(selector);
const opacity = (selector: string): number => {
  const el = q(selector);
  return el ? Number(getComputedStyle(el).opacity) : -1;
};
const clickText = (scope: string, text: string): boolean => {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>(`${scope} button`)).find((b) => b.textContent?.trim() === text);
  button?.click();
  return Boolean(button);
};
/** Resolves to the promise's value, or 'PENDING' if it has not settled within `ms`. */
const settle = <T>(promise: Promise<T>, ms = 1500): Promise<T | 'PENDING'> => Promise.race([promise, sleep(ms).then(() => 'PENDING' as const)]);

export async function runSelfTest(hud: Hud, screens: Screens, evidence: Evidence): Promise<Result> {
  const out: Result = {};
  const expect = (name: string, pass: boolean, detail?: unknown): void => {
    out[name] = pass ? 'ok' : { FAIL: detail ?? true };
  };

  /* ------------------------------------------------------------------ hud */
  hud.setVisible(true);

  await hud.fade(true, 300);
  expect('fade(true) is black when it resolves', opacity('.oit-fade') > 0.98, opacity('.oit-fade'));
  await hud.fade(false, 200);
  expect('fade(false) is clear when it resolves', opacity('.oit-fade') < 0.02, opacity('.oit-fade'));
  await hud.fade(true, 0);
  expect('fade(true, 0) is immediate', opacity('.oit-fade') > 0.98, opacity('.oit-fade'));
  await hud.fade(false, 0);

  hud.subtitle('man', 'This line should be cut.', 60000);
  await hud.fade(true, 60);
  expect('a hard cut to black clears the subtitle', !q('.oit-sub')!.classList.contains('is-on'));
  hud.subtitle('clerk', 'A line after the cut still shows.', 400);
  expect('subtitles show over black', q('.oit-sub')!.classList.contains('is-on') && Number(getComputedStyle(q('.oit-hud-text')!).zIndex) > Number(getComputedStyle(q('.oit-fade')!).zIndex));
  await hud.fade(false, 0);

  const cardStart = performance.now();
  const card = hud.card('11:42 PM', 'Four blocks from home.', 300);
  await sleep(1300);
  expect('card is fully visible during its hold', opacity('.oit-card') > 0.98, opacity('.oit-card'));
  await card;
  expect('card resolves after fading out', !q('.oit-card') && performance.now() - cardStart > 2300, Math.round(performance.now() - cardStart));

  hud.subtitle('woman', 'Please. I just want to get home.', 500);
  expect('subtitle shows speaker and text', q('.oit-sub')!.dataset.speaker === 'woman' && q('.oit-sub-who')!.textContent === 'Woman' && q('.oit-sub-text')!.textContent === 'Please. I just want to get home.');
  await sleep(700);
  expect('subtitle clears itself', !q('.oit-sub')!.classList.contains('is-on'));
  const long =
    'Look, I do not know you and I do not want to talk to you. I have asked you twice now to leave me alone. If you keep following me I am going to walk into that shop and ask them to call the police.';
  hud.subtitle('you', long, 1800);
  const firstPage = q('.oit-sub-text')!.textContent ?? '';
  await sleep(1100);
  const laterPage = q('.oit-sub-text')!.textContent ?? '';
  const lineHeight = parseFloat(getComputedStyle(q('.oit-sub-text')!).lineHeight);
  expect('long subtitle is paged', firstPage.length < long.length && laterPage !== firstPage, { firstPage, laterPage });
  expect('a subtitle page is at most two lines', q('.oit-sub-text')!.getBoundingClientRect().height <= lineHeight * 2 + 2, q('.oit-sub-text')!.getBoundingClientRect().height);
  hud.clearSubtitle();

  hud.thought('He is still behind me.', 0.5);
  await sleep(60);
  hud.thought('Do not look back.', 0.8);
  await sleep(60);
  hud.thought('Third thought.', 0.2, 600);
  expect('thoughts cross-fade, never stack', document.querySelectorAll('.oit-thought').length === 2 && document.querySelectorAll('.oit-thought.is-on').length === 1, document.querySelectorAll('.oit-thought').length);
  await sleep(1800);
  expect('thought clears itself', document.querySelectorAll('.oit-thought').length === 0, document.querySelectorAll('.oit-thought').length);
  hud.thought('Do not let him touch me.', 1, 60000);
  await sleep(1200);
  const calm = 24;
  const size = parseFloat(getComputedStyle(q('.oit-thought')!).fontSize);
  expect('thought grows and trembles at high intensity', size > calm * 1.2 && q('.oit-thought')!.classList.contains('is-trembling'), size);
  expect('thought words have all arrived', Array.from(document.querySelectorAll('.oit-w')).every((w) => Number(getComputedStyle(w).opacity) > 0.98));
  hud.thought('', 0);

  hud.setFear(0.9);
  await sleep(400);
  const rate = q('.oit-fear-pulse i')!.getAnimations()[0]?.playbackRate ?? 0;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  expect(still ? 'no heartbeat animation under reduced motion' : 'heartbeat rate rises with fear', still ? rate === 0 : rate > 2 && rate < 2.5, rate);
  hud.setFear(0);
  await sleep(1200);
  expect('fear layer hides at zero', opacity('.oit-fear') < 0.02, opacity('.oit-fear'));

  hud.setMic('idle');
  expect('mic spells out the instruction first', !q('.oit-mic')!.classList.contains('is-compact'));
  await sleep(5000);
  expect('mic falls back to the key cap', q('.oit-mic')!.classList.contains('is-compact'));
  hud.setMic('recording', 0.7);
  expect('mic level reaches the ring', q('.oit-mic')!.style.getPropertyValue('--level') === '0.700');
  hud.setMic('hidden');

  hud.setFilming(true);
  await sleep(1300);
  expect('filming timer counts', q('.oit-film-time')!.textContent === '00:01', q('.oit-film-time')!.textContent);
  hud.setFilming(false);

  // typed speech: Enter sends, Esc cancels, keys do not leak to the page
  let leaked = 0;
  const leak = (): void => void (leaked += 1);
  document.addEventListener('keydown', leak);
  let ask = hud.askText('Say something');
  // The form that just closed lingers for its fade-out, so always address the live one.
  const input = (): HTMLInputElement => q<HTMLInputElement>('.oit-ask.is-on .oit-ask-input')!;
  const form = (): HTMLFormElement => q<HTMLFormElement>('.oit-ask.is-on')!;
  expect('askText focuses its input', document.activeElement === input());
  input().dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true }));
  expect('keys typed in askText do not reach the page', leaked === 0, leaked);
  input().value = '  Leave me   alone.  ';
  form().requestSubmit();
  expect('askText resolves with the trimmed text on Enter', (await settle(ask)) === 'Leave me alone.');
  ask = hud.askText();
  input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect('askText resolves null on Esc', (await settle(ask)) === null);
  ask = hud.askText();
  form().requestSubmit();
  expect('askText ignores an empty Enter', (await settle(ask, 300)) === 'PENDING');
  const second = hud.askText();
  expect('a new askText cancels the open one', (await settle(ask)) === null);
  input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await second;
  document.removeEventListener('keydown', leak);

  // pause
  let pause = hud.pause();
  expect('pause() returns the same promise while open', hud.pause() === pause);
  expect('pause focuses Continue', document.activeElement?.textContent === 'Continue');
  expect('pause takes pointer events', getComputedStyle(q('.oit-pause')!).pointerEvents === 'auto');
  clickText('.oit-pause.is-on', 'Continue');
  expect('pause resolves resume', (await settle(pause)) === 'resume');
  pause = hud.pause();
  clickText('.oit-pause.is-on', 'Leave the simulation');
  expect('pause resolves exit', (await settle(pause)) === 'exit');

  hud.setVisible(false);
  await sleep(600);
  expect('setVisible(false) hides the world and text layers', getComputedStyle(q('.oit-hud-world')!).visibility === 'hidden' && getComputedStyle(q('.oit-hud-text')!).visibility === 'hidden');
  await hud.fade(true, 0);
  expect('fade still works while hidden', opacity('.oit-fade') > 0.98);
  await hud.fade(false, 0);
  expect('hud root never takes pointer events', getComputedStyle(q('#hud')!).pointerEvents === 'none');

  /* -------------------------------------------------------------- screens */
  const hitScene = (): boolean => document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.id === 'scene';

  screens.loading('Loading…');
  expect('loading shows', Boolean(q('.oit-loading')));
  screens.loading('Preparing the street…', 0.5);
  expect('loading shows progress', q('.oit-loading-bar')!.getAttribute('aria-valuenow') === '50' && document.querySelectorAll('.oit-loading').length === 1);
  screens.loading(null);
  await sleep(700);
  expect('loading(null) removes it', !q('.oit-loading') && hitScene());

  let micAsked = 0;
  const intro = screens.intro({
    voiceAvailable: false,
    requestMic: async () => {
      micAsked += 1;
      return false;
    },
  });
  expect('intro opens on the title', q('.oit-intro.is-in')!.dataset.step === '0' && document.activeElement?.textContent === 'One in Three');
  expect('title shows the 1-in-3 statistic only when the evidence has it', Boolean(q('.oit-title-stat')) === evidence.stats.some((s) => s.region === 'global' && s.topic === 'prevalence'));
  clickText('.oit-intro', 'Begin');
  expect('step 2 is the content note', q('.oit-h1')!.textContent === 'Before you begin' && document.activeElement === q('.oit-h1'));
  expect('intro has not resolved before the content note is passed', (await settle(intro, 100)) === 'PENDING');
  clickText('.oit-intro', 'Continue');
  expect('step 3 is how it works', q('.oit-h1')!.textContent === 'How it works');
  clickText('.oit-intro', 'Back');
  expect('Back returns to the content note', q('.oit-h1')!.textContent === 'Before you begin');
  clickText('.oit-intro', 'Continue');
  clickText('.oit-intro', 'Continue');
  expect('step 4 says voices are off', q('.oit-intro')!.textContent!.includes('Voices are off for this session'));
  clickText('.oit-intro', 'Allow microphone');
  await sleep(50);
  expect('mic denial is explained', micAsked === 1 && q('.oit-mic-status')!.dataset.state === 'denied' && q('.oit-mic-status')!.textContent!.includes('type what you would say'));
  clickText('.oit-intro', 'Begin Part 1');
  expect('intro resolves', (await settle(intro)) === undefined);
  await sleep(800);
  expect('nothing blocks the view after the intro', q('#screens')!.children.length === 0 && hitScene());

  for (const pov of ['woman', 'bystander'] as const) {
    const briefing = screens.briefing(pov);
    expect(`briefing(${pov}) shows`, q('.oit-brief.is-in')!.dataset.pov === pov);
    clickText('.oit-brief.is-in', 'Begin');
    expect(`briefing(${pov}) resolves`, (await settle(briefing)) === undefined);
  }

  let summary = screens.summary(mockSummary('woman', evidence));
  expect('woman debrief carries the not-her-fault statement', q('.oit-summary.is-in .oit-nofault')!.textContent!.includes('made this her fault'));
  expect('woman debrief has no 5 Ds and no score', !q('.oit-summary.is-in .oit-ds'));
  clickText('.oit-summary.is-in', 'Walk it again');
  expect('summary resolves retry', (await settle(summary)) === 'retry');
  summary = screens.summary(mockSummary('bystander', evidence));
  await sleep(700);
  expect('bystander debrief shows the 5 Ds', document.querySelectorAll('.oit-summary.is-in .oit-d').length === 5, document.querySelectorAll('.oit-summary.is-in .oit-d').length);
  expect('debrief source links open in a new tab', Array.from(document.querySelectorAll<HTMLAnchorElement>('.oit-summary.is-in a.oit-src')).every((a) => a.target === '_blank' && a.rel.includes('noopener') && /^https?:/.test(a.href)));
  clickText('.oit-summary.is-in', 'Continue');
  expect('summary resolves continue', (await settle(summary)) === 'continue');

  summary = screens.summary(minimalSummary('woman'));
  await sleep(700);
  // With no run data the debrief is the outcome, the statement and the buttons. The model
  // section still appears when the evidence itself documents the model (it needs no run data).
  const documented = evidence.modelCalibration.parameters.length > 0 || evidence.harasserBehaviour.length > 0 || Boolean(evidence.modelCalibration.notes);
  const sections = document.querySelectorAll('.oit-summary.is-in .oit-sec').length;
  expect('debrief with no run data degrades to outcome, statement and buttons', sections === (documented ? 2 : 1) && Boolean(q('.oit-summary.is-in .oit-nofault')) && !q('.oit-summary.is-in .oit-tl') && !q('.oit-summary.is-in .oit-stats'), sections);
  clickText('.oit-summary.is-in', 'Continue to Part 2');
  await summary;

  const closing = screens.closing();
  await sleep(700);
  expect('closing lists resources only when the evidence has them', Boolean(q('.oit-closing.is-in .oit-res')) === evidence.resources.length > 0);
  expect('closing lists every source', document.querySelectorAll('.oit-closing.is-in .oit-biblio li').length === Object.keys(evidence.sources).length);
  expect('closing shows no phone number that is not in the evidence', Array.from(document.querySelectorAll('.oit-closing.is-in .oit-res-phone')).every((el) => evidence.resources.some((r) => r.phone === el.textContent)));
  clickText('.oit-closing.is-in', 'Start over');
  expect('closing resolves restart', (await settle(closing)) === 'restart');

  screens.error('This simulation needs a desktop browser with WebGL.');
  expect('error shows the message', q('.oit-error')!.textContent!.includes('needs a desktop browser with WebGL'));
  const again = screens.briefing('woman');
  await sleep(700);
  expect('the next screen replaces the error', !q('.oit-error') || q('.oit-error')!.classList.contains('is-out'));
  clickText('.oit-brief.is-in', 'Begin');
  await again;

  hud.dispose();
  expect('dispose empties the hud', q('#hud')!.children.length === 0);

  const failures = Object.entries(out).filter(([, v]) => v !== 'ok');
  return { passed: Object.keys(out).length - failures.length, failed: failures.length, failures: Object.fromEntries(failures), all: out };
}
