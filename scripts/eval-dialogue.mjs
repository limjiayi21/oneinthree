#!/usr/bin/env node
/**
 * End-to-end checks of the woman-POV conversation against a running dev server
 * (real Clef reader, real decision model, real line writer). Typed turns only:
 * no microphone. Each spoken turn also voices his reply through ElevenLabs when
 * a key is configured, so a full run costs a little credit (about 100 lines).
 *
 *   node scripts/eval-dialogue.mjs reader worker/fixtures/woman-replies.json [--base http://localhost:5173]
 *       -> accuracy of the reader on a labelled set of replies, and every miss
 *   node scripts/eval-dialogue.mjs conversations [--seeds 3] [--out docs/research/conversation-tests.md]
 *       -> scripted conversations: what she said, how it was read, his level, his line;
 *          plus automatic checks (never more than +2 per turn, a greeting never makes him
 *          leave, turn hostile or jump)
 *   node scripts/eval-dialogue.mjs golden [--out docs/research/golden-run-check.md]
 *       -> the golden run (docs/golden-run.md), both endings, in ?run=golden mode: checks every beat's
 *          level, how her words were read, that his line was written live and does not re-ask, and the ending
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const BASE = opt('base', 'http://localhost:5173');
const CTX = { elapsed: 40, distanceToMan: 2.2, progress: 0.3, playerSpeed: 0.8, facingMan: true, manBlocking: false, oppositeSidewalk: false };
const LEVEL_NAMES = ['Calm', 'Interested', 'Pushy', 'Offended', 'Angry', 'Intimidating', 'Threatening'];

async function post(path, body) {
  const res = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.text();
}
const events = (text) => text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

async function session(seed) {
  const r = JSON.parse(await post('/api/session', { pov: 'woman', scenario: 'walk-home', seed }));
  return r.sessionId;
}

async function turn(sid, body) {
  const ev = events(await post(`/api/session/${sid}/turn`, body));
  const pick = (t) => ev.find((e) => e.type === t);
  return { read: pick('read'), decision: pick('decision'), line: pick('line'), thought: pick('thought'), outcome: pick('outcome'), done: pick('done') };
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}

/* ------------------------------------------------------------------ reader */

async function reader(file) {
  const set = JSON.parse(fs.readFileSync(file, 'utf8'));
  const res = await pool(set, 4, async ([text, label]) => {
    const sid = await session(7);
    await turn(sid, { event: 'begin', ctx: CTX });
    const t = await turn(sid, { event: 'speech', text, source: 'typed', ctx: CTX });
    return { text, label, got: t.read?.strategy, conf: t.read?.confidence };
  });
  const ok = res.filter((r) => r.got === r.label).length;
  console.log(`reader accuracy ${ok}/${res.length} = ${Math.round((100 * ok) / res.length)}%`);
  for (const r of res) if (r.got !== r.label) console.log(`  MISS ${JSON.stringify(r.text).padEnd(52)} want ${r.label.padEnd(18)} got ${r.got} (${r.conf})`);
  return ok === res.length ? 0 : 1;
}

/* ------------------------------------------------------------------ conversations */

const SCRIPTS = {
  'Says hello (the reported bug)': ['Hello.', 'Hello?'],
  'Friendly small talk': ['Hi.', "I'm good, how are you?", "I'm just heading home.", 'Okay, have a good night.'],
  'Polite, then firm': ['No thanks.', 'I said no thanks.', 'Leave me alone.', '…'],
  'Ignores him and keeps walking': ['…', '…', '…', '…'],
  'Firm, then threatens the police': ['Leave me alone.', 'Stop following me.', "I'm calling the police."],
  'Insults him': ['Fuck off.', 'Get lost, creep.', "You're disgusting."],
  'Excuse, then pleads': ['I have a boyfriend.', "He's waiting for me.", 'Please just let me go.'],
};

async function conversation(name, lines, seed) {
  const sid = await session(seed);
  const rows = [];
  const open = await turn(sid, { event: 'begin', ctx: CTX });
  let level = open.decision?.man?.level ?? 0;
  rows.push({ her: '(she walks past)', read: '', from: null, to: level, step: 'opening', him: open.line?.text ?? '', stance: open.decision?.man?.stance });
  let elapsed = CTX.elapsed;
  for (const said of lines) {
    elapsed += 9;
    const silent = said === '…';
    const t = await turn(sid, silent ? { event: 'silence', ctx: { ...CTX, elapsed, playerSpeed: 1.4 } } : { event: 'speech', text: said, source: 'typed', ctx: { ...CTX, elapsed } });
    const man = t.decision?.man;
    const to = man?.level ?? level;
    rows.push({
      her: silent ? '(says nothing, keeps walking)' : said,
      read: t.read ? `${t.read.strategy} ${Math.round(100 * t.read.confidence)}%` : '',
      from: level,
      to,
      stance: man?.stance ?? '(no change)',
      him: t.line?.text ?? (man?.stance === 'gone' ? '(walks off)' : '(says nothing)'),
      why: t.decision?.rationale?.text ?? '',
      outcome: t.outcome?.outcome,
    });
    level = to;
    if (t.outcome || man?.stance === 'gone') break;
  }
  return { name, seed, rows };
}

function check(conv) {
  const problems = [];
  for (const r of conv.rows) {
    if (r.from === null) continue;
    if (r.to - r.from > 2) problems.push(`jumped ${r.to - r.from} levels after "${r.her}"`);
    if (r.to - r.from < -1) problems.push(`dropped ${r.from - r.to} levels after "${r.her}"`);
    const greeting = /^(hello|hi|hey)[.?!]*$/i.test(r.her.trim());
    if (greeting && (r.stance === 'back_off' || r.stance === 'gone')) problems.push(`walked off after a greeting ("${r.her}")`);
    if (greeting && ['hostile', 'intimidate', 'escalate'].includes(r.stance)) problems.push(`turned ${r.stance} after a greeting ("${r.her}")`);
    if (greeting && r.to - r.from > 1) problems.push(`jumped two levels after a greeting ("${r.her}")`);
    const refusal = /^(polite_deflect|firm_boundary|hostile|excuse|threaten_attention|plead|seek_help)\b/.test(r.read);
    if (refusal && !['back_off', 'gone'].includes(r.stance) && r.to < 2) problems.push(`stayed at level ${r.to} after a no ("${r.her}")`);
  }
  return problems;
}

async function conversations() {
  const seeds = Number(opt('seeds', '3'));
  const jobs = [];
  for (const [name, lines] of Object.entries(SCRIPTS)) for (let k = 0; k < seeds; k++) jobs.push([name, lines, 1000 + 37 * k]);
  const convs = await pool(jobs, 3, ([name, lines, seed]) => conversation(name, lines, seed));
  const md = [
    '# Conversation tests (woman POV)',
    '',
    `Generated by \`node scripts/eval-dialogue.mjs conversations\` against ${BASE} on ${new Date().toISOString().slice(0, 10)}: the real reader (Clef plus reply rules), the escalation ladder (worker/model/ladder.ts) and the line writer. Typed turns, ${seeds} seeds per script; each seed draws a different man (disposition).`,
    '',
    'Automatic checks on every turn: he never rises more than two levels or drops more than one; a plain greeting never makes him walk off, turn hostile or jump two levels; if he carries on after she says no (in any form), he is at least level 2.',
    '',
  ];
  let failures = 0;
  for (const c of convs) {
    const problems = check(c);
    failures += problems.length;
    md.push(`## ${c.name} (seed ${c.seed})`, '', '| She | Read as | His level | He | Why |', '|---|---|---|---|---|');
    for (const r of c.rows) {
      const lv = r.from === null ? `${r.to} ${LEVEL_NAMES[r.to]}` : `${r.from} → ${r.to} ${LEVEL_NAMES[r.to]}`;
      md.push(`| ${r.her} | ${r.read} | ${lv} | ${r.him}${r.outcome ? ` **[${r.outcome}]**` : ''} | ${r.why ?? ''} |`.replace(/\n/g, ' '));
    }
    md.push('', problems.length ? `**Check failed:** ${problems.join('; ')}` : 'Checks passed.', '');
  }
  const out = opt('out', null);
  if (out) fs.writeFileSync(out, md.join('\n'));
  console.log(md.join('\n'));
  console.log(`\n${convs.length} conversations, ${failures} check failures`);
  return failures ? 1 : 0;
}

/* ------------------------------------------------------------------ golden run */

const GOLDEN_CLIMB = [
  { say: 'Hi.', read: 'engage', level: 1 },
  { say: "I'm just heading home.", read: 'engage', level: 1 },
  { say: "No thanks, I'm fine.", read: 'polite_deflect', level: 2 },
  { silence: true, level: 2 },
  { say: 'Please leave me alone.', read: 'firm_boundary', level: 3 },
  { say: 'I said leave me alone.', read: 'firm_boundary', level: 4 },
];
const GOLDEN_ENDINGS = {
  'A: she got away (the shop)': [
    { event: 'crossed_street', ctx: { playerSpeed: 2.2, distanceToMan: 2.5 }, level: 5 },
    { event: 'entered_shop', outcome: 'took_refuge' },
  ],
  'B: cut to black': [
    { say: 'Get away from me, you creep.', read: 'hostile', level: 5 },
    { event: 'pushed_past', ctx: { distanceToMan: 0.8 }, level: 6, outcome: 'escalated' },
  ],
};
const ASKS = { name: /\byour name\b/i, where: /\bwhere (you|ya|are you)('re)? (headed|heading|going|goin)/i, number: /\b(your|ya) number\b/i };

async function golden() {
  const md = [
    '# Golden run check',
    '',
    `Generated by \`node scripts/eval-dialogue.mjs golden\` against ${BASE} on ${new Date().toISOString().slice(0, 10)}. The script is docs/golden-run.md; levels are held to it (\`?run=golden\`), the words are written live.`,
    '',
  ];
  let failures = 0;
  let warnings = 0;
  for (const [ending, tail] of Object.entries(GOLDEN_ENDINGS)) {
    const sid = JSON.parse(await post('/api/session', { pov: 'woman', scenario: 'walk-home', run: 'golden' })).sessionId;
    let elapsed = 40;
    const asked = new Set();
    const open = await turn(sid, { event: 'begin', ctx: { ...CTX, elapsed } });
    md.push(`## Ending ${ending}`, '', '| # | She | Read as | Level | He | Check |', '|---|---|---|---|---|---|');
    const openOk = open.decision?.man?.level === 1;
    if (!openOk) failures++;
    md.push(`| 1 | *(walks toward him)* |  | ${open.decision?.man?.level} | ${open.line?.text ?? ''} | ${openOk ? 'ok' : '**FAIL** opening level should be 1'} |`);
    for (const t of Object.keys(ASKS)) if (ASKS[t].test(open.line?.text ?? '')) asked.add(t);
    const beats = [...GOLDEN_CLIMB, ...tail];
    for (const [k, b] of beats.entries()) {
      elapsed += 9;
      const body = b.say
        ? { event: 'speech', text: b.say, source: 'typed', ctx: { ...CTX, elapsed } }
        : { event: b.silence ? 'silence' : b.event, ctx: { ...CTX, elapsed, playerSpeed: b.silence ? 1.6 : CTX.playerSpeed, ...(b.ctx ?? {}) } };
      const r = await turn(sid, body);
      const level = r.decision?.man?.level;
      const line = r.line?.text ?? '';
      const problems = [];
      const notes = [];
      if (b.level !== undefined && level !== b.level) problems.push(`level ${level}, script says ${b.level}`);
      if (b.outcome && r.outcome?.outcome !== b.outcome) problems.push(`ending ${r.outcome?.outcome ?? 'none'}, script says ${b.outcome}`);
      if (b.read && r.read?.strategy !== b.read) notes.push(`read as ${r.read?.strategy}, script says ${b.read}`);
      if (r.done?.ms?.fallbackLine) notes.push('line was a pre-written fallback (AI unavailable?)');
      for (const t of Object.keys(ASKS)) {
        if (!ASKS[t].test(line)) continue;
        if (asked.has(t)) problems.push(`asked about ${t} again`);
        asked.add(t);
      }
      failures += problems.length;
      warnings += notes.length;
      const she = b.say ?? (b.silence ? '*(says nothing, walks faster)*' : `*(${b.event.replace('_', ' ')})*`);
      const check = problems.length ? `**FAIL** ${problems.join('; ')}` : notes.length ? `warn: ${notes.join('; ')}` : 'ok';
      md.push(`| ${k + 2} | ${she} | ${r.read ? `${r.read.strategy} ${Math.round(100 * r.read.confidence)}%` : ''} | ${level ?? ''} ${level !== undefined ? '' : ''}| ${line}${r.outcome ? ` **[${r.outcome.outcome}]**` : ''} | ${check} |`);
      if (r.outcome) break;
    }
    md.push('');
  }
  md.push(`${failures} failures, ${warnings} warnings.`);
  const out = opt('out', null);
  if (out) fs.writeFileSync(out, md.join('\n') + '\n');
  console.log(md.join('\n'));
  return failures ? 1 : 0;
}

const mode = args[0];
const code =
  mode === 'reader'
    ? await reader(args[1] ?? 'worker/fixtures/woman-replies.json')
    : mode === 'conversations'
      ? await conversations()
      : mode === 'golden'
        ? await golden()
        : (console.log('usage: reader <file> | conversations | golden'), 2);
process.exit(code);
