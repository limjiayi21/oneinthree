/**
 * The debrief coach screen, opened from a button on the Part 2 debrief.
 *
 * While the coach works, the player sees its plan tick off and what it and its
 * helpers are doing. Then the debrief, with its research cited, and a box for
 * follow-up questions. "Back to your debrief" returns to the debrief; if the
 * coach fails the screen says so and the button still works.
 */
import './coach.css';
import { h, nextId, type Child } from './dom';
import { streamCoach } from '../net/coach';
import { EXAMPLE_DEBRIEF, exampleCitations } from './coachExample';
import { bundledEvidence } from './evidence';

/** If the live debrief has not arrived by then (it usually takes 25-35 s), show the example instead. */
const DEBRIEF_TIMEOUT_MS = 75_000;
/** When the server switches to the backup model, the debrief gets this long again from then. */
const BACKUP_TIMEOUT_MS = 70_000;
import { COACH_BACKUP_STEP, COACH_LIMITS, type CoachCitation, type CoachEvent, type CoachFile, type CoachTodo, type CoachWho } from '../../shared/coach';

export interface CoachOptions {
  /** Part 2 session id. */
  bystander: string;
  /** Part 1 session id, when Part 1 was played. */
  woman?: string;
}

const WHO: Record<CoachWho, string> = { coach: 'Coach', 'moment-analyst': 'Moment analyst', 'evidence-researcher': 'Evidence researcher' };

const SUGGESTED = ['What else could I have done at the hardest moment?', 'Was what I said to him risky?', 'What if no one else had been around?'];

/* ------------------------------------------------------------- markdown */

/** A tiny, safe markdown renderer: headings, paragraphs, lists, bold, italics and [citation] markers. Text only, never HTML. */
export function renderMarkdown(md: string, cite: (id: string) => HTMLElement | null): HTMLElement[] {
  const inline = (text: string): Child[] => {
    const out: Child[] = [];
    const re = /(\*\*[^*]+\*\*|\*[^*]+\*|\[[a-z0-9_]+\])/gi;
    let last = 0;
    for (const m of text.matchAll(re)) {
      const at = m.index ?? 0;
      if (at > last) out.push(text.slice(last, at));
      const tok = m[0];
      if (tok.startsWith('**')) out.push(h('strong', null, tok.slice(2, -2)));
      else if (tok.startsWith('*')) out.push(h('em', null, tok.slice(1, -1)));
      else out.push(cite(tok.slice(1, -1)) ?? '');
      last = at + tok.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  };
  const blocks: HTMLElement[] = [];
  let list: HTMLElement | null = null;
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push(h('p', null, inline(para.join(' '))));
    para = [];
  };
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    const item = line.match(/^[-*]\s+(.*)$/) ?? line.match(/^\d+[.)]\s+(.*)$/);
    if (!line) {
      flush();
      list = null;
    } else if (heading) {
      flush();
      list = null;
      blocks.push(h('h3', { class: 'oit-coach-h' }, inline(heading[1])));
    } else if (item) {
      flush();
      if (!list) {
        list = h('ul', null);
        blocks.push(list);
      }
      list.appendChild(h('li', null, inline(item[1])));
    } else {
      list = null;
      para.push(line);
    }
  }
  flush();
  return blocks;
}

/* --------------------------------------------------------------- screen */

export function createCoachScreen(opts: CoachOptions, brand: HTMLElement, onDone: () => void): { el: HTMLElement } {
  const titleId = nextId('oit-coach');
  const abort = new AbortController();
  let files: CoachFile[] = [];
  let questionsLeft: number = COACH_LIMITS.questionsPerRun;
  let busy = false;

  /** Citations are numbered across the whole screen, in the order they first appear. */
  const citeNumbers = new Map<string, number>();
  const citeData = new Map<string, CoachCitation>();
  const sourcesList = h('ol', { class: 'oit-coach-sources' });
  const sourcesSec = h('section', { class: 'oit-coach-research', hidden: true, 'aria-label': 'Research cited' }, h('h3', { class: 'oit-coach-h' }, 'Research cited'), sourcesList);

  function citeChip(id: string): HTMLElement | null {
    const c = citeData.get(id);
    if (!c) return null;
    let n = citeNumbers.get(id);
    if (!n) {
      n = citeNumbers.size + 1;
      citeNumbers.set(id, n);
      const src = c.source ? [c.source.publisher, c.source.year].filter(Boolean).join(', ') : '';
      sourcesList.appendChild(
        h(
          'li',
          { id: `oit-coach-cite-${id}` },
          h('span', { class: 'oit-coach-cite-text' }, c.text),
          src ? h('span', { class: 'oit-coach-cite-src' }, c.source?.url ? h('a', { href: c.source.url, target: '_blank', rel: 'noopener noreferrer' }, src) : src) : null,
        ),
      );
      sourcesSec.hidden = false;
    }
    return h('a', { class: 'oit-coach-cite', href: `#oit-coach-cite-${id}`, title: c.text, 'aria-label': `Source ${n}` }, String(n));
  }

  /* plan and activity */
  const planList = h('ol', { class: 'oit-coach-plan' });
  const feed = h('ol', { class: 'oit-coach-feed', 'aria-label': 'What the coach is doing' });
  const live = h('p', { class: 'oit-sr', 'aria-live': 'polite' });
  const work = h(
    'aside',
    { class: 'oit-coach-work', 'aria-label': "The coach's work" },
    h('h2', { class: 'oit-coach-label' }, 'The plan'),
    planList,
    h('h2', { class: 'oit-coach-label' }, 'Working'),
    feed,
  );

  function showPlan(todos: CoachTodo[]): void {
    planList.replaceChildren(
      ...todos.map((t) =>
        h(
          'li',
          { class: `is-${t.status.replace('_', '-')}` },
          h('span', { class: 'oit-coach-check', 'aria-hidden': 'true' }),
          h('span', null, t.content, h('span', { class: 'oit-sr' }, t.status === 'completed' ? ' (done)' : t.status === 'in_progress' ? ' (in progress)' : '')),
        ),
      ),
    );
    const done = todos.filter((t) => t.status === 'completed').length;
    live.textContent = `Plan: ${done} of ${todos.length} done.`;
  }

  function addStep(who: CoachWho, text: string): void {
    feed.appendChild(h('li', { class: `oit-coach-step is-${who}` }, h('span', { class: 'oit-coach-who' }, WHO[who]), h('span', null, text)));
    while (feed.children.length > 40) feed.firstElementChild?.remove();
    feed.scrollTop = feed.scrollHeight;
  }

  /* the debrief and answers */
  const status = h('p', { class: 'oit-coach-status' }, h('span', { class: 'oit-coach-dots', 'aria-hidden': 'true' }), 'Your coach is going through what you did. This takes about half a minute.');
  const debrief = h('div', { class: 'oit-coach-debrief', hidden: true });
  const checkedLine = h('p', { class: 'oit-coach-checked', hidden: true });
  const answers = h('div', { class: 'oit-coach-answers' });

  /* questions */
  const input = h('input', { class: 'oit-coach-input', type: 'text', maxlength: COACH_LIMITS.questionChars, placeholder: 'Ask about your run…', 'aria-label': 'Ask the coach a question about your run' }) as HTMLInputElement;
  const askBtn = h('button', { class: 'oit-btn oit-btn--ghost', type: 'submit' }, 'Ask');
  const left = h('p', { class: 'oit-coach-left' });
  const chips = h(
    'div',
    { class: 'oit-coach-suggest' },
    SUGGESTED.map((q) => h('button', { class: 'oit-coach-chip', type: 'button', onclick: () => void ask(q) }, q)),
  );
  const form = h(
    'form',
    {
      class: 'oit-coach-ask',
      hidden: true,
      onsubmit: (e: Event) => {
        e.preventDefault();
        void ask(input.value);
      },
    },
    h('h3', { class: 'oit-coach-h' }, 'Ask your coach'),
    chips,
    h('div', { class: 'oit-coach-row' }, input, askBtn),
    left,
  );

  const continueBtn = h('button', { class: 'oit-btn oit-btn--primary', type: 'button', onclick: () => finish() }, 'Back to your debrief');
  const skipBtn = h('button', { class: 'oit-coach-skip', type: 'button', onclick: () => finish() }, 'Back');

  const title = h('h1', { class: 'oit-sum-title', id: titleId, tabindex: -1, 'data-focus': true }, 'Your debrief');
  const el = h(
    'section',
    { class: 'oit-screen oit-summary oit-coach', 'aria-labelledby': titleId },
    h(
      'div',
      { class: 'oit-frame' },
      h('div', { class: 'oit-topbar oit-topbar--static' }, brand, skipBtn),
      h(
        'div',
        { class: 'oit-coach-layout' },
        h(
          'article',
          { class: 'oit-coach-main' },
          h('header', { class: 'oit-sum-head' }, h('p', { class: 'oit-eyebrow' }, 'Part 2 · Your coach'), title),
          status,
          debrief,
          checkedLine,
          answers,
          form,
          sourcesSec,
          h('div', { class: 'oit-actions' }, continueBtn),
        ),
        work,
      ),
      live,
    ),
  );

  /** Back to the debrief. The screen is kept (src/ui/screens.ts), so work in progress carries on and is there on return. */
  function finish(): void {
    onDone();
  }

  function setLeft(): void {
    left.textContent = questionsLeft > 0 ? `${questionsLeft} question${questionsLeft === 1 ? '' : 's'} left.` : 'No questions left for this run.';
    const off = busy || questionsLeft <= 0;
    input.disabled = off;
    askBtn.toggleAttribute('disabled', off);
    for (const b of chips.querySelectorAll('button')) b.toggleAttribute('disabled', off);
  }

  function checkedText(c: { claims: number; revisions: number; removed: number }): string {
    const parts = [`Checked: ${c.claims} claim${c.claims === 1 ? '' : 's'} traced to the research`];
    if (c.revisions) parts.push(`revised ${c.revisions} time${c.revisions === 1 ? '' : 's'} to fix them`);
    if (c.removed) parts.push(`${c.removed} sentence${c.removed === 1 ? '' : 's'} it could not support removed`);
    return `${parts.join(', ')}.`;
  }

  /** The live coach could not finish: show what it writes, plainly marked as an example. */
  function showExample(): void {
    for (const c of exampleCitations(bundledEvidence)) citeData.set(c.id, c);
    status.remove();
    debrief.replaceChildren(...renderMarkdown(EXAMPLE_DEBRIEF, citeChip));
    debrief.hidden = false;
    checkedLine.textContent = 'An example of the coach’s debrief. The live coach could not finish yours this time.';
    checkedLine.hidden = false;
    work.hidden = true;
    form.hidden = true; // no follow-up questions on an example: there is no run behind it
    live.textContent = 'Showing an example debrief.';
  }

  async function run(question?: string): Promise<void> {
    busy = true;
    setLeft();
    // The first debrief gets a time limit; past it, the example is shown instead of waiting on.
    const local = new AbortController();
    const stop = (): void => local.abort();
    abort.signal.addEventListener('abort', stop);
    let timedOut = false;
    let gotResult = false;
    const giveUp = (): void => {
      if (gotResult) return;
      timedOut = true;
      local.abort();
    };
    let timer = question ? 0 : window.setTimeout(giveUp, DEBRIEF_TIMEOUT_MS);
    let block: HTMLElement | null = null;
    if (question) {
      block = h('div', { class: 'oit-coach-qa' }, h('p', { class: 'oit-coach-q' }, h('span', { class: 'oit-sr' }, 'You asked: '), question), h('p', { class: 'oit-coach-status' }, h('span', { class: 'oit-coach-dots', 'aria-hidden': 'true' }), 'Thinking…'));
      answers.appendChild(block);
      block.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      feed.appendChild(h('li', { class: 'oit-coach-sep' }, question));
    }
    try {
      for await (const ev of streamCoach({ ...opts, question, files: question ? files : undefined }, local.signal) as AsyncGenerator<CoachEvent>) {
        if (ev.type === 'plan') showPlan(ev.todos);
        else if (ev.type === 'step') {
          addStep(ev.who, ev.text);
          if (timer && ev.text === COACH_BACKUP_STEP) {
            window.clearTimeout(timer);
            timer = window.setTimeout(giveUp, BACKUP_TIMEOUT_MS);
          }
        }
        else if (ev.type === 'result') {
          gotResult = true;
          for (const c of ev.citations) citeData.set(c.id, c);
          const body = renderMarkdown(ev.markdown, citeChip);
          if (ev.kind === 'debrief') {
            status.remove();
            debrief.replaceChildren(...body);
            debrief.hidden = false;
            checkedLine.textContent = checkedText(ev.checked);
            checkedLine.hidden = false;
            form.hidden = false;
            live.textContent = 'Your debrief is ready.';
            title.focus({ preventScroll: true });
          } else if (block) {
            block.lastElementChild?.replaceWith(h('div', { class: 'oit-coach-a' }, body, h('p', { class: 'oit-coach-checked' }, checkedText(ev.checked))));
            live.textContent = 'The coach answered.';
          }
        } else if (ev.type === 'done') {
          files = ev.files;
          questionsLeft = ev.questionsLeft;
        } else if (ev.type === 'error') {
          throw new Error(ev.message);
        }
      }
      // The stream ended without a debrief (cut off mid-run): the example rather than a spinner forever.
      if (!question && !gotResult && !abort.signal.aborted) showExample();
    } catch (err) {
      if (abort.signal.aborted) return;
      // The debrief itself failed or timed out: the example, not an error.
      if (!question && (timedOut || !gotResult)) {
        showExample();
        return;
      }
      const message = err instanceof Error && err.message ? err.message : 'The coach is not available right now.';
      if (question && block) block.lastElementChild?.replaceWith(h('p', { class: 'oit-coach-error' }, message));
      else {
        status.replaceChildren(h('span', { class: 'oit-coach-error' }, `${message} You can go back to your debrief.`));
        work.hidden = true;
      }
      live.textContent = message;
    } finally {
      window.clearTimeout(timer);
      abort.signal.removeEventListener('abort', stop);
      busy = false;
      setLeft();
    }
  }

  async function ask(q: string): Promise<void> {
    const question = q.trim();
    if (!question || busy || questionsLeft <= 0) return;
    input.value = '';
    await run(question);
  }

  setLeft();
  void run();
  return { el };
}
