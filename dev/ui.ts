/**
 * UI harness: mounts the HUD and every screen in isolation, with no 3D, audio
 * or Worker, so each state can be looked at and screenshotted reproducibly.
 *
 *   npx vite --config vite.harness.config.ts --port 5185
 *   http://localhost:5185/dev/ui.html                      index of views
 *   http://localhost:5185/dev/ui.html?view=summary-woman&evidence=mock
 *
 * view      intro | briefing-woman | briefing-bystander | hud | summary-woman |
 *           summary-woman-escalated | summary-bystander | recap | closing | pause |
 *           card | loading | error | selftest (scripted checks, see selftest.ts)
 * evidence  real (content/evidence.json as bundled) | mock (dev/mock.ts) | empty
 *           default: real once the file has content, mock until then
 * clean=1   hide the harness panel and log (for screenshots)
 * still=1   no transitions or animations: every state is settled at once
 * scroll=N  scroll the screen N px down;  open=1  open every disclosure
 *
 * intro:    step=0..3   voice=0   mic=grant|deny|real   micclick=1
 * hud:      state=calm|tense|panic|bystander|ask|long|cross   bg=night|bright|black
 * summary:  minimal=1 (the fallback shape main.ts uses when the server has no debrief)
 * loading:  fraction=0..1
 */

import { createHud } from '../src/ui/hud';
import { createScreens } from '../src/ui/screens';
import { bundledEvidence, EMPTY_EVIDENCE } from '../src/ui/evidence';
import type { Hud, MicState } from '../src/contracts';
import type { Evidence } from '../shared/evidence';
import { minimalSummary, mockEvidence, mockSummary, type MockSummaryKind } from './mock';
import guidedJson from '../content/guided.json';
import type { GuidedData } from '../shared/content';

const GUIDED = guidedJson as unknown as GuidedData;
import { runSelfTest } from './selftest';

const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'index';
const realHasContent = bundledEvidence.stats.length > 0 || bundledEvidence.resources.length > 0;
// No param: the real file once it has content, the mock entries until then.
const evidenceMode = params.get('evidence') ?? (realHasContent ? 'real' : 'mock');
const clean = params.get('clean') === '1';

const evidence: Evidence = evidenceMode === 'mock' ? mockEvidence : evidenceMode === 'empty' ? EMPTY_EVIDENCE : bundledEvidence;

const hudRoot = document.querySelector<HTMLElement>('#hud')!;
const screensRoot = document.querySelector<HTMLElement>('#screens')!;
const sceneEl = document.querySelector<HTMLElement>('#scene')!;
const harnessEl = document.querySelector<HTMLElement>('#harness')!;

const hud = createHud(hudRoot);
const screens = createScreens(screensRoot, evidenceMode === 'real' ? {} : { evidence });
Object.assign(window as unknown as Record<string, unknown>, { __hud: hud, __screens: screens, __evidence: evidence });

/* --------------------------------------------------------------- utilities */

const logEl = document.createElement('div');
logEl.className = 'log';
function log(message: string): void {
  console.log(`[harness] ${message}`);
  logEl.textContent = `${logEl.textContent ? `${logEl.textContent}\n` : ''}${message}`.split('\n').slice(-6).join('\n');
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const HOLD = 10 * 60 * 1000; // long enough to screenshot

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function panel(build: (add: (title: string, ...nodes: Node[]) => void) => void): void {
  const p = document.createElement('div');
  p.className = 'panel';
  build((title, ...nodes) => {
    const heading = document.createElement('h2');
    heading.textContent = title;
    p.append(heading, ...nodes);
  });
  harnessEl.append(p);
}

/* --------------------------------------------------------------------- hud */

let levelLoop = 0;
function simulateLevel(target: Hud): void {
  cancelAnimationFrame(levelLoop);
  const tick = (t: number): void => {
    const level = Math.max(0, Math.min(1, 0.45 + 0.35 * Math.sin(t / 130) + 0.25 * Math.sin(t / 47)));
    target.setMic('recording', level);
    levelLoop = requestAnimationFrame(tick);
  };
  levelLoop = requestAnimationFrame(tick);
}
function mic(state: MicState): void {
  cancelAnimationFrame(levelLoop);
  if (state === 'recording') simulateLevel(hud);
  else hud.setMic(state);
}

const LINES = {
  m1: 'Hey. Hey, beautiful. Where you headed?',
  m3: 'Come on, slow down. Let me walk you home. Where you live at?',
  m5: 'Stuck-up bitch. You think you’re too good for me?',
  w2: 'Please. I just want to get home.',
  c1: 'Hey! Hey, leave her alone, man. I got cameras out here.',
  long: 'Look, I don’t know you and I don’t want to talk to you. I have asked you twice now to leave me alone. If you keep following me I am going to walk into that shop and ask them to call the police, and I will tell them exactly what you look like.',
};

function hudState(state: string): void {
  hud.setVisible(true);
  switch (state) {
    case 'calm':
      hud.setFear(0.12);
      hud.objective('Walk home.');
      mic('idle');
      hud.hint('W A S D to walk  ·  mouse to look  ·  Shift to hurry', HOLD);
      hud.thought('Long day. Just get home.', 0.15, HOLD);
      break;
    case 'panic':
      hud.setFear(1);
      hud.objective('Get home.');
      mic('thinking');
      hud.subtitle('man', LINES.m5, HOLD);
      hud.thought('Don’t let him touch me.', 1, HOLD);
      break;
    case 'bystander':
      hud.setFear(0.3);
      hud.setFilming(true);
      mic('unavailable');
      hud.subtitle('woman', LINES.w2, HOLD);
      hud.prompt('E   Ask the shopkeeper for help');
      break;
    case 'hints':
      hud.setFear(0.2);
      mic('idle');
      hud.hint('SPACE speak  ·  F film  ·  E interact  ·  or keep walking', HOLD);
      hud.subtitle('clerk', LINES.c1, HOLD);
      break;
    case 'ask':
      hud.setFear(0.45);
      hud.objective('Get home.');
      hud.subtitle('man', LINES.m3, HOLD);
      void hud.askText('Say something…').then((text) => log(`askText() resolved: ${JSON.stringify(text)}`));
      break;
    case 'long':
      hud.setFear(0.4);
      mic('idle');
      hud.subtitle('you', LINES.long);
      break;
    case 'cross':
      hud.setFear(0.5);
      hud.thought('He’s still behind me.', 0.5);
      setTimeout(() => hud.thought('Don’t look back. Don’t look back.', 0.75, HOLD), 700);
      break;
    case 'tense':
    default:
      hud.setFear(0.58);
      hud.objective('Get home.');
      mic('recording');
      hud.subtitle('man', LINES.m3, HOLD);
      hud.thought('He’s too close. Back up.', 0.6, HOLD);
      break;
  }
}

function hudPanel(): void {
  panel((add) => {
    add(
      'Subtitle',
      button('man', () => hud.subtitle('man', LINES.m1)),
      button('woman', () => hud.subtitle('woman', LINES.w2)),
      button('clerk', () => hud.subtitle('clerk', LINES.c1)),
      button('you', () => hud.subtitle('you', 'Leave me alone.')),
      button('long (pages)', () => hud.subtitle('you', LINES.long)),
      button('clear', () => hud.clearSubtitle()),
    );
    add(
      'Thought',
      button('0.15', () => hud.thought('It’s so quiet tonight.', 0.15)),
      button('0.5', () => hud.thought('He’s still behind me.', 0.5)),
      button('1.0', () => hud.thought('Don’t let him touch me.', 1)),
      button('two, quickly', () => {
        hud.thought('He’s still behind me.', 0.5);
        setTimeout(() => hud.thought('Don’t look back. Don’t look back.', 0.8), 600);
      }),
      button('long', () => hud.thought('I could cross the street. Would that make it worse? If I go in now, he sees where I live.', 0.4)),
    );
    add(
      'Hint / objective / prompt',
      button('hint', () => hud.hint('Hold SPACE to speak.  Or say nothing.', 6000)),
      button('hint list', () => hud.hint('SPACE speak  ·  F film  ·  E interact  ·  or keep walking', 6000)),
      button('hint off', () => hud.hint(null)),
      button('objective', () => hud.objective('Get home.')),
      button('objective off', () => hud.objective(null)),
      button('prompt', () => hud.prompt('E   Ask the shopkeeper for help')),
      button('prompt off', () => hud.prompt(null)),
    );
    add('Mic', ...(['hidden', 'idle', 'recording', 'thinking', 'unavailable'] as MicState[]).map((s) => button(s, () => mic(s))));
    const fear = document.createElement('input');
    fear.type = 'range';
    fear.min = '0';
    fear.max = '1';
    fear.step = '0.01';
    fear.value = '0.5';
    fear.addEventListener('input', () => hud.setFear(Number(fear.value)));
    add('Fear', fear);
    add(
      'Fade / card',
      button('fade out', () => void hud.fade(true, 1200).then(() => log('fade(true) resolved'))),
      button('fade in', () => void hud.fade(false, 1200).then(() => log('fade(false) resolved'))),
      button('cut', () => void hud.fade(true, 60).then(() => log('fade(true, 60) resolved'))),
      button('card', () => void hud.card('11:42 PM', 'Four blocks from home.', 3000).then(() => log('card() resolved'))),
      button('card (stop)', () => void hud.card('We stop here.', 'What happens next is not shown. For many women, it is not a simulation.', 5000).then(() => log('card() resolved'))),
    );
    add(
      'Overlays',
      button('filming on', () => hud.setFilming(true)),
      button('filming off', () => hud.setFilming(false)),
      button('askText', () => void hud.askText('Say something…').then((t) => log(`askText() resolved: ${JSON.stringify(t)}`))),
      button('pause', () => void hud.pause().then((c) => log(`pause() resolved: ${c}`))),
      button('choice', () => {
        const m = GUIDED.moments[1]!;
        void hud
          .choice({ caption: m.caption, prompt: m.prompt, innerVoice: m.innerVoice, options: m.choices.map((c, i) => ({ label: c.text, note: i === 1 ? '(tried)' : undefined })) })
          .then((i) => log(`choice() resolved: ${i}`));
      }),
      button('freeze', () => hud.freeze({})),
      button('freeze spot', () => hud.freeze({ spot: { x: 0.55, y: 0.45, r: 0.17 } })),
      button('unfreeze', () => hud.freeze(null)),
      button('strip', () => {
        const c = GUIDED.moments[1]!.choices[0]!;
        void hud
          .strip({
            concept: c.strip.concept,
            sentence: c.strip.sentence,
            credit: { text: 'Bibb Latané & John Darley, The Unresponsive Bystander, 1970' },
            stats: [
              { headline: 'In 9 of 10', text: 'public conflicts recorded by street cameras in the UK, the Netherlands and South Africa, at least one bystander did something to help.', source: { label: 'American Psychologist, 2020', url: 'https://pubmed.ncbi.nlm.nih.gov/31157529/' } },
              { headline: 'Only 25%', text: 'of people who experienced sexual harassment in public spaces say someone helped them.', source: { label: "L'Oreal Paris via PR Newswire, 2020" } },
            ],
            action: 'Continue',
          })
          .then(() => log('strip() resolved'));
      }),
      button('you think', () => hud.subtitle('self', 'At least I am getting it on video.')),
      button('visible off', () => hud.setVisible(false)),
      button('visible on', () => hud.setVisible(true)),
    );
    add(
      'Background',
      button('night', () => (sceneEl.dataset.bg = 'night')),
      button('bright', () => (sceneEl.dataset.bg = 'bright')),
      button('black', () => (sceneEl.dataset.bg = 'black')),
    );
  });
}

/* ------------------------------------------------------------------- views */

const VIEWS = [
  'intro',
  'briefing-woman',
  'briefing-bystander',
  'hud',
  'summary-woman',
  'summary-woman-escalated',
  'summary-bystander',
  'recap',
  'closing',
  'pause',
  'card',
  'loading',
  'error',
  'selftest',
];

function renderIndex(): void {
  const wrap = document.createElement('div');
  wrap.className = 'index';
  const h1 = document.createElement('h1');
  h1.textContent = 'One in Three: UI harness';
  const p = document.createElement('p');
  p.textContent = `content/evidence.json currently has ${bundledEvidence.stats.length} statistics, ${bundledEvidence.caseStudies.length} case studies, ${bundledEvidence.resources.length} resources and ${Object.keys(bundledEvidence.sources).length} sources. "mock" merges in the obviously fake entries from dev/mock.ts; "empty" shows how each screen degrades with no evidence at all.`;
  const table = document.createElement('table');
  const head = document.createElement('tr');
  for (const label of ['view', 'real', 'mock', 'empty']) {
    const th = document.createElement('th');
    th.textContent = label;
    head.append(th);
  }
  table.append(head);
  for (const v of VIEWS) {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    const code = document.createElement('code');
    code.textContent = v;
    name.append(code);
    tr.append(name);
    for (const mode of ['real', 'mock', 'empty']) {
      const td = document.createElement('td');
      const a = document.createElement('a');
      a.href = `?view=${v}&evidence=${mode}`;
      a.textContent = 'open';
      td.append(a);
      tr.append(td);
    }
    table.append(tr);
  }
  wrap.append(h1, p, table);
  document.body.append(wrap);
}

async function run(): Promise<void> {
  sceneEl.dataset.bg = params.get('bg') ?? 'night';
  if (params.get('still') === '1') {
    // Freeze every entrance so a screenshot taken at any moment shows the settled state.
    const style = document.createElement('style');
    style.textContent = '*,*::before,*::after{animation-delay:0s!important;animation-duration:0s!important;transition-delay:0s!important;transition-duration:0s!important}';
    document.head.append(style);
  }
  harnessEl.hidden = clean;
  harnessEl.append(logEl);
  hud.setVisible(false);

  switch (view) {
    case 'index':
      renderIndex();
      return;

    case 'intro': {
      const micMode = params.get('mic') ?? 'grant';
      const requestMic = async (): Promise<boolean> => {
        if (micMode === 'real') {
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach((t) => t.stop());
            return true;
          } catch {
            return false;
          }
        }
        await wait(700);
        return micMode !== 'deny';
      };
      const done = screens.intro({ voiceAvailable: params.get('voice') !== '0', requestMic });
      const step = Number(params.get('step') ?? 0);
      for (let i = 0; i < step; i += 1) {
        await wait(60);
        document.querySelector<HTMLButtonElement>('.oit-intro .oit-btn--primary')?.click();
      }
      if (params.get('micclick') === '1') {
        await wait(60);
        document.querySelector<HTMLButtonElement>('.oit-mic-check .oit-btn')?.click();
      }
      await done;
      log('intro() resolved');
      return;
    }

    case 'briefing-woman':
    case 'briefing-bystander':
      await screens.briefing(view === 'briefing-woman' ? 'woman' : 'bystander');
      log(`briefing() resolved`);
      return;

    case 'summary-woman':
    case 'summary-woman-escalated':
    case 'summary-bystander': {
      const kind = view.replace('summary-', '') as MockSummaryKind;
      const data = params.get('minimal') === '1' ? minimalSummary(kind === 'bystander' ? 'bystander' : 'woman') : mockSummary(kind, evidence);
      const choice = await screens.summary(data);
      log(`summary() resolved: ${choice}`);
      return;
    }

    case 'recap': {
      const picked = params.get('picked')?.split(',') ?? ['distract', 'delay'];
      await screens.recap({ ...GUIDED.recap, fiveDs: GUIDED.recap.fiveDs.map((d) => ({ name: d.name, line: d.line, firstPick: picked.includes(d.key) })) });
      log('recap() resolved');
      return;
    }

    case 'closing': {
      const choice = await screens.closing();
      log(`closing() resolved: ${choice}`);
      return;
    }

    case 'loading': {
      const fraction = params.get('fraction');
      screens.loading(params.get('message') ?? 'Preparing the street…', fraction === null ? undefined : Number(fraction));
      return;
    }

    case 'error':
      screens.error('This simulation needs a desktop browser with WebGL. It could not start on this device.');
      return;

    case 'pause': {
      hudState('tense');
      const choice = await hud.pause();
      log(`pause() resolved: ${choice}`);
      return;
    }

    case 'card': {
      hud.setVisible(true);
      await hud.fade(true, 0);
      const stop = params.get('card') === 'stop';
      await hud.card(stop ? 'We stop here.' : '11:42 PM', stop ? 'What happens next is not shown. For many women, it is not a simulation.' : 'Four blocks from home.', Number(params.get('ms') ?? HOLD));
      log('card() resolved');
      await hud.fade(false, 1500);
      log('fade(false) resolved');
      return;
    }

    case 'selftest': {
      const pre = document.createElement('pre');
      pre.id = 'selftest';
      pre.style.cssText = 'position:fixed;inset:0;z-index:60;margin:0;padding:24px;overflow:auto;background:#07080b;color:#e9e4da;font:12px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap';
      pre.textContent = 'running\u2026';
      try {
        const result = await runSelfTest(hud, screens, evidence);
        pre.textContent = JSON.stringify(result, null, 2);
      } catch (err) {
        pre.textContent = `SELFTEST THREW: ${err instanceof Error ? `${err.message}\n${err.stack}` : String(err)}`;
      }
      document.body.append(pre);
      console.log(pre.textContent);
      return;
    }

    case 'hud':
    default:
      hudState(params.get('state') ?? 'tense');
      if (!clean) hudPanel();
  }
}

const scrollTo = Number(params.get('scroll') ?? 0);
if (scrollTo > 0) {
  // Screens scroll inside themselves; this lets a long debrief be captured a viewport at a time.
  setTimeout(() => document.querySelector('.oit-screen.is-in')?.scrollTo(0, scrollTo), 150);
}
if (params.get('open') === '1') {
  setTimeout(() => document.querySelectorAll('details').forEach((d) => (d.open = true)), 100);
}

void run();
