#!/usr/bin/env node
/**
 * End-to-end check against a running dev server (or a deployed Worker).
 *
 *   node scripts/e2e.mjs [baseUrl] [--latency=5] [--no-voice] [--quiet]
 *
 * Default baseUrl: http://localhost:5173. It walks the whole contract in
 * shared/types.ts and fails loudly on any violation:
 *   - health
 *   - a woman-POV session: begin, three typed turns of different kinds, a
 *     silence, reached_home, summary
 *   - bystander sessions: the scene_timeout path and an intervention path
 *   - one real voice round trip: a sentence is synthesised with ElevenLabs,
 *     posted as the audio clip, and the transcript checked
 *   - with --latency=N, N spoken turns and the median of each stage
 *
 * The ElevenLabs key (for synthesising the test clip) is read from .dev.vars
 * or the environment and never printed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VOICES, TTS_LIVE_MODEL } from '../worker/voices.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const base = (args.find((a) => /^https?:/.test(a)) ?? 'http://localhost:5173').replace(/\/+$/, '');
const latencyRuns = Number((args.find((a) => a.startsWith('--latency=')) ?? '').split('=')[1] ?? 0);
const noVoice = args.includes('--no-voice');
const quiet = args.includes('--quiet');

const evidence = JSON.parse(readFileSync(resolve(root, 'content/evidence.json'), 'utf8'));
const STAT_IDS = new Set((evidence.stats ?? []).map((s) => s.id));
const CASE_IDS = new Set((evidence.caseStudies ?? []).map((c) => c.id));
const SOURCE_IDS = new Set(Object.keys(evidence.sources ?? {}));

/* ------------------------------------------------------------------ contract (mirrors shared/types.ts) */

const EMOTIONS = ['neutral', 'friendly', 'smirk', 'leer', 'mocking', 'annoyed', 'angry', 'contempt', 'sheepish', 'surprised', 'afraid', 'worried', 'relieved', 'determined'];
const STANCES = ['idle', 'opening', 'persist', 'follow', 'block', 'guilt', 'hostile', 'intimidate', 'back_off', 'gone', 'escalate'];
const ACTIONS = ['stay', 'approach', 'walk_alongside', 'follow_behind', 'step_closer', 'block_path', 'lean_in', 'back_away', 'leave', 'turn_on_bystander', 'grab'];
const WOMAN_STRATEGIES = ['ignore', 'polite_deflect', 'firm_boundary', 'hostile', 'excuse', 'threaten_attention', 'seek_help', 'engage', 'plead', 'unclear'];
const BYSTANDER_STRATEGIES = ['direct', 'distract', 'delegate', 'delay', 'document', 'none', 'aggressive', 'unclear'];
const TARGETS = ['man', 'woman', 'clerk', 'nobody'];
const WOMAN_ACTIONS = ['keep_walking', 'stop', 'step_back', 'move_to_player', 'hurry_home', 'enter_shop', 'freeze'];
const DELIVERIES = ['normal', 'call_out', 'low', 'shout'];
const OUTCOMES = ['he_left', 'reached_home_alone', 'reached_home_followed', 'took_refuge', 'escalated', 'intervened_he_left', 'intervened_she_safe', 'intervened_escalated', 'no_intervention_she_escaped', 'no_intervention_escalated', 'exited'];
const BASES = ['data', 'inferred', 'assumption'];
const ORDER = { heard: 0, read: 1, decision: 2, line: 3, thought: 4, outcome: 5, error: -1, done: 6 };

let failures = 0;
const problems = [];
function fail(message) {
  failures += 1;
  problems.push(message);
  console.error(`  CONTRACT VIOLATION: ${message}`);
}
const check = (cond, message) => {
  if (!cond) fail(message);
  return Boolean(cond);
};
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const unit = (v) => isNum(v) && v >= 0 && v <= 1;

function checkRationale(r, where) {
  if (r === undefined) return;
  check(r && typeof r.text === 'string' && r.text.length > 5, `${where}: rationale.text`);
  check(BASES.includes(r?.basis), `${where}: rationale.basis "${r?.basis}"`);
  check(Array.isArray(r?.sourceIds) && r.sourceIds.every((s) => SOURCE_IDS.has(s)), `${where}: rationale.sourceIds must exist in evidence.json (${r?.sourceIds})`);
}

function checkEvent(ev, pov, where) {
  if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') return fail(`${where}: not an event: ${JSON.stringify(ev)}`);
  switch (ev.type) {
    case 'heard':
      check(typeof ev.text === 'string', `${where}: heard.text`);
      break;
    case 'read': {
      const all = pov === 'woman' ? WOMAN_STRATEGIES : BYSTANDER_STRATEGIES;
      check(all.includes(ev.strategy), `${where}: read.strategy "${ev.strategy}" is not a ${pov} strategy`);
      check(unit(ev.confidence), `${where}: read.confidence ${ev.confidence}`);
      if (ev.target !== undefined) check(TARGETS.includes(ev.target), `${where}: read.target "${ev.target}"`);
      if (ev.probs !== undefined) {
        const values = Object.values(ev.probs);
        check(values.every(unit), `${where}: read.probs values`);
        const total = values.reduce((a, b) => a + b, 0);
        check(Math.abs(total - 1) < 0.02, `${where}: read.probs sums to ${total.toFixed(3)}`);
        check(Object.keys(ev.probs).every((k) => all.includes(k)), `${where}: read.probs keys`);
      }
      break;
    }
    case 'decision': {
      const m = ev.man;
      check(m && STANCES.includes(m.stance), `${where}: decision.man.stance "${m?.stance}"`);
      check(m && ACTIONS.includes(m.action), `${where}: decision.man.action "${m?.action}"`);
      check(m && EMOTIONS.includes(m.emotion), `${where}: decision.man.emotion "${m?.emotion}"`);
      check(m && unit(m.emotionIntensity), `${where}: decision.man.emotionIntensity ${m?.emotionIntensity}`);
      check(m && isNum(m.proximity) && m.proximity > 0 && m.proximity < 20, `${where}: decision.man.proximity ${m?.proximity}`);
      if (m?.action === 'grab') check(m.stance === 'escalate', `${where}: action grab must be paired with stance escalate`);
      if (m?.action === 'turn_on_bystander') check(pov === 'bystander', `${where}: turn_on_bystander in woman POV`);
      if (ev.woman !== undefined) {
        check(pov === 'bystander', `${where}: decision.woman in woman POV`);
        check(EMOTIONS.includes(ev.woman?.emotion), `${where}: decision.woman.emotion "${ev.woman?.emotion}"`);
        check(WOMAN_ACTIONS.includes(ev.woman?.action), `${where}: decision.woman.action "${ev.woman?.action}"`);
      }
      check(unit(ev.fear), `${where}: decision.fear ${ev.fear}`);
      check(unit(ev.tension), `${where}: decision.tension ${ev.tension}`);
      checkRationale(ev.rationale, where);
      break;
    }
    case 'line':
      check(['man', 'woman', 'clerk'].includes(ev.speaker), `${where}: line.speaker "${ev.speaker}"`);
      check(typeof ev.text === 'string' && ev.text.trim().length > 0, `${where}: line.text`);
      check(typeof ev.audioUrl === 'string' && (ev.audioUrl === '' || ev.audioUrl.startsWith('/')), `${where}: line.audioUrl "${ev.audioUrl}"`);
      check(EMOTIONS.includes(ev.emotion), `${where}: line.emotion "${ev.emotion}"`);
      check(DELIVERIES.includes(ev.delivery), `${where}: line.delivery "${ev.delivery}"`);
      if (ev.speaker === 'man') check(ev.text.split(/\s+/).length <= 22, `${where}: his line is a speech (${ev.text.split(/\s+/).length} words)`);
      break;
    case 'thought':
      check(typeof ev.text === 'string' && ev.text.trim().length > 0, `${where}: thought.text`);
      check(typeof ev.audioUrl === 'string' && (ev.audioUrl === '' || ev.audioUrl.startsWith('/')), `${where}: thought.audioUrl`);
      check(unit(ev.fear), `${where}: thought.fear ${ev.fear}`);
      break;
    case 'outcome':
      check(OUTCOMES.includes(ev.outcome), `${where}: outcome "${ev.outcome}"`);
      break;
    case 'error':
      check(typeof ev.message === 'string' && typeof ev.recoverable === 'boolean', `${where}: error shape`);
      break;
    case 'done':
      check(Number.isInteger(ev.turn) && ev.turn > 0, `${where}: done.turn ${ev.turn}`);
      check(ev.ms && typeof ev.ms === 'object' && Object.values(ev.ms).every(isNum), `${where}: done.ms must be a map of numbers`);
      check(isNum(ev.ms?.total), `${where}: done.ms.total`);
      break;
    default:
      fail(`${where}: unknown event type "${ev.type}"`);
  }
}

function checkSequence(events, where) {
  let rank = -1;
  let decisions = 0;
  for (const ev of events) {
    const r = ORDER[ev.type];
    if (r === undefined || r < 0) continue;
    check(r >= rank, `${where}: "${ev.type}" arrived after a later-stage event (order must be heard, read, decision, line, thought, outcome, done)`);
    rank = Math.max(rank, r);
    if (ev.type === 'decision') decisions += 1;
  }
  check(events.filter((e) => e.type === 'done').length === 1, `${where}: exactly one done event`);
  check(events[events.length - 1]?.type === 'done', `${where}: done must be last`);
  check(decisions <= 1, `${where}: more than one decision in a turn`);
}

/* ------------------------------------------------------------------ transport */

async function getJson(path, init) {
  const res = await fetch(base + path, init);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, body, text, type: res.headers.get('content-type') ?? '' };
}

/** POST a turn and read the NDJSON stream, timestamping each event as it arrives. */
async function turn(sessionId, req, pov, clip) {
  const where = `${pov}/${req.event}${req.text ? `("${req.text.slice(0, 24)}")` : ''}`;
  const started = performance.now();
  let res;
  if (clip) {
    const form = new FormData();
    form.append('meta', JSON.stringify(req));
    form.append('audio', new Blob([clip.bytes], { type: clip.type }), clip.name);
    res = await fetch(`${base}/api/session/${sessionId}/turn`, { method: 'POST', body: form });
  } else {
    res = await fetch(`${base}/api/session/${sessionId}/turn`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
  }
  check(res.ok, `${where}: HTTP ${res.status}`);
  check((res.headers.get('content-type') ?? '').includes('application/x-ndjson'), `${where}: content-type is "${res.headers.get('content-type')}", expected application/x-ndjson`);
  const events = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let chunks = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks += 1;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        ev._at = Math.round(performance.now() - started);
        events.push(ev);
      } catch {
        fail(`${where}: a line of the stream is not JSON: ${line.slice(0, 80)}`);
      }
    }
  }
  check(!buffer.trim(), `${where}: stream ended mid-line`);
  events.forEach((ev) => checkEvent(ev, pov, where));
  checkSequence(events, where);
  if (!quiet) for (const ev of events) console.log(`    ${String(ev._at).padStart(5)}ms  ${describe(ev)}`);
  return { events, chunks, started };
}

function describe(ev) {
  switch (ev.type) {
    case 'heard':
      return `heard    "${ev.text}"`;
    case 'read': {
      const top = Object.entries(ev.probs ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ');
      return `read     ${ev.strategy} (${ev.confidence.toFixed(2)})${ev.target ? ` -> ${ev.target}` : ''}  [${top}]`;
    }
    case 'decision':
      return `decision ${ev.man.stance}/${ev.man.action}/${ev.man.emotion} ${ev.man.emotionIntensity} @${ev.man.proximity}m${ev.woman ? `  her: ${ev.woman.action}/${ev.woman.emotion}` : ''}  fear ${ev.fear} tension ${ev.tension}${ev.rationale ? `\n             why [${ev.rationale.basis}; ${ev.rationale.sourceIds.join(', ') || 'no sources'}]: ${ev.rationale.text}` : ''}`;
    case 'line':
      return `line     ${ev.speaker} (${ev.emotion}, ${ev.delivery}): "${ev.text}"  ${ev.audioUrl || '(no audio)'}`;
    case 'thought':
      return `thought  "${ev.text}"  ${ev.audioUrl || '(no audio)'}`;
    case 'outcome':
      return `OUTCOME  ${ev.outcome}`;
    case 'error':
      return `error    ${ev.message} (recoverable: ${ev.recoverable})`;
    case 'done':
      return `done     turn ${ev.turn}  ${Object.entries(ev.ms).map(([k, v]) => `${k}=${v}`).join(' ')}`;
    default:
      return JSON.stringify(ev);
  }
}

const isMp3 = (b) => b.length > 1000 && ((b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0));

/** GET an audioUrl, check it is playable MP3, and report time to first byte. */
async function fetchAudio(url, where, since) {
  const t0 = performance.now();
  const res = await fetch(base + url);
  if (!check(res.ok, `${where}: GET ${url} -> HTTP ${res.status}`)) return null;
  check((res.headers.get('content-type') ?? '').startsWith('audio/mpeg'), `${where}: ${url} content-type "${res.headers.get('content-type')}"`);
  const reader = res.body.getReader();
  const parts = [];
  let ttfb = 0;
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!ttfb) ttfb = performance.now() - t0;
    parts.push(value);
    size += value.length;
  }
  const bytes = Buffer.concat(parts);
  check(isMp3(bytes), `${where}: ${url} is not MP3 audio (${size} bytes)`);
  const out = { ttfb: Math.round(ttfb), bytes: size, sinceTurnStart: since !== undefined ? Math.round(t0 + ttfb - since) : null, chunks: parts.length, data: bytes };
  if (!quiet) console.log(`           audio ${url.split('/').slice(-2).join('/')}: ${size} bytes, first byte ${out.ttfb}ms after GET${out.sinceTurnStart !== null ? ` (${out.sinceTurnStart}ms after the turn was sent)` : ''}, ${parts.length} chunks`);
  return out;
}

function checkSummary(s, pov, where) {
  check(s && s.pov === pov, `${where}: pov`);
  check(s?.outcome && OUTCOMES.includes(s.outcome.kind) && typeof s.outcome.title === 'string' && s.outcome.title && typeof s.outcome.body === 'string' && s.outcome.body.length > 40, `${where}: outcome copy`);
  check(isNum(s?.durationSec) && s.durationSec >= 0, `${where}: durationSec`);
  check(Array.isArray(s?.timeline) && s.timeline.length > 0, `${where}: timeline`);
  for (const [i, e] of (s?.timeline ?? []).entries()) {
    check(isNum(e.t) && ['you', 'man', 'woman', 'clerk', 'thought', 'event'].includes(e.actor) && typeof e.text === 'string' && e.text, `${where}: timeline[${i}]`);
    checkRationale(e.rationale, `${where}: timeline[${i}]`);
  }
  check(Array.isArray(s?.insights) && s.insights.length >= 2 && s.insights.length <= 4, `${where}: 2 to 4 insights (got ${s?.insights?.length})`);
  for (const [i, ins] of (s?.insights ?? []).entries()) {
    check(typeof ins.title === 'string' && ins.title && typeof ins.body === 'string' && ins.body.length > 30, `${where}: insights[${i}] copy`);
    check(Array.isArray(ins.statIds) && ins.statIds.every((id) => STAT_IDS.has(id)), `${where}: insights[${i}].statIds must exist in evidence.json (${ins.statIds})`);
    // numbers belong to evidence.json, not to templates
    check(!/\d+\s?%|\b\d+ (in|of|out of) \d+\b/.test(`${ins.title} ${ins.body}`), `${where}: insights[${i}] hard-codes a statistic: "${ins.body.slice(0, 80)}"`);
  }
  check(!/\d+\s?%|\b\d+ (in|of|out of) \d+\b/.test(`${s?.outcome?.title} ${s?.outcome?.body}`), `${where}: outcome copy hard-codes a statistic`);
  check(Array.isArray(s?.statIds) && s.statIds.every((id) => STAT_IDS.has(id)), `${where}: statIds must exist in evidence.json`);
  if (STAT_IDS.size) check(s.statIds.length >= 3 && s.statIds.length <= 6, `${where}: 4 to 6 featured stats (got ${s?.statIds?.length})`);
  if (s?.caseStudyId !== undefined) check(CASE_IDS.has(s.caseStudyId), `${where}: caseStudyId "${s.caseStudyId}" not in evidence.json`);
  check(Array.isArray(s?.modelNotes) && s.modelNotes.length >= 1, `${where}: modelNotes`);
  for (const [i, n] of (s?.modelNotes ?? []).entries()) checkRationale(n, `${where}: modelNotes[${i}]`);
  if (pov === 'bystander') {
    check(Array.isArray(s?.fiveDs) && s.fiveDs.length === 5, `${where}: fiveDs must list all five`);
    const keys = (s?.fiveDs ?? []).map((d) => d.key).sort().join(',');
    check(keys === 'delay,delegate,direct,distract,document', `${where}: fiveDs keys (${keys})`);
    for (const d of s?.fiveDs ?? []) {
      check(typeof d.used === 'boolean' && Array.isArray(d.moments) && typeof d.feedback === 'string' && d.feedback.length > 30, `${where}: fiveDs.${d.key}`);
      check(d.used === d.moments.length > 0, `${where}: fiveDs.${d.key} used/moments disagree`);
    }
  } else {
    check(s?.fiveDs === undefined, `${where}: fiveDs in woman POV`);
    check(/fault|caused|brought this on|no (right|correct) (answer|response)|responsibility/i.test(`${s?.outcome?.body} ${(s?.insights ?? []).map((i) => i.title + i.body).join(' ')}`), `${where}: woman-POV copy must say it was not her fault and there was no correct response`);
  }
}

/* ------------------------------------------------------------------ helpers for the voice round trip */

function readKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY.trim();
  const file = resolve(root, '.dev.vars');
  if (!existsSync(file)) return '';
  const m = readFileSync(file, 'utf8').match(/^ELEVENLABS_API_KEY=(.*)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
}

/** Synthesise the player's sentence so there is a real clip to post. Opus in Ogg, about what a browser records. */
async function synthClip(key, text, format = 'opus_48000_32') {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICES.woman.id}/stream?output_format=${format}`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: TTS_LIVE_MODEL }),
  });
  if (!res.ok) throw new Error(`could not synthesise the test clip: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const ogg = bytes.subarray(0, 4).toString('latin1') === 'OggS';
  return format.startsWith('opus') ? { bytes, type: ogg ? 'audio/ogg' : 'audio/opus', name: ogg ? 'clip.ogg' : 'clip.opus' } : { bytes, type: 'audio/mpeg', name: 'clip.mp3' };
}

const words = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
function overlap(said, heard) {
  const a = words(said);
  const b = new Set(words(heard));
  return a.length ? a.filter((w) => b.has(w)).length / a.length : 0;
}
const median = (list) => {
  const s = [...list].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

const ctx = (over = {}) => ({ elapsed: 30, distanceToMan: 6, progress: 0.3, playerSpeed: 1.4, facingMan: false, manBlocking: false, oppositeSidewalk: false, ...over });
const bctx = (over = {}) => ({ elapsed: 20, distanceToMan: 3, distanceToWoman: 3.5, progress: 0.4, playerSpeed: 0, facingMan: true, manBlocking: true, oppositeSidewalk: false, lookingAt: 'man', filming: false, betweenThem: false, beat: 'blocks', ...over });

async function createSession(pov, seed) {
  const r = await getJson('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pov, scenario: 'walk-home', seed }) });
  check(r.status === 200 && typeof r.body?.sessionId === 'string' && r.body.pov === pov && typeof r.body.voice === 'boolean', `create ${pov} session: ${r.status} ${r.text.slice(0, 120)}`);
  return r.body;
}

/* ------------------------------------------------------------------ run */

console.log(`e2e against ${base}`);

console.log('\n[1] health');
const health = await getJson('/api/health');
check(health.status === 200 && health.body?.ok === true && typeof health.body.voice === 'boolean' && typeof health.body.ai === 'boolean', `health: ${health.status} ${health.text.slice(0, 120)}`);
console.log(`    ${JSON.stringify(health.body)}`);
const voice = Boolean(health.body?.voice) && !noVoice;

console.log('\n[2] woman POV: begin, three kinds of speech, a silence, home, summary');
{
  const session = await createSession('woman', 11);
  check(session.voice === health.body.voice, 'session.voice must match health.voice');
  const id = session.sessionId;
  let t = 30;
  let distance = 6;
  let gone = false;
  const step = async (event, text, over = {}) => {
    console.log(`  > ${event}${text ? ` "${text}"` : ''}`);
    const r = await turn(id, { event, text, ctx: ctx({ elapsed: t, distanceToMan: gone ? 99 : distance, ...over }) }, 'woman');
    const d = r.events.find((e) => e.type === 'decision');
    if (d) {
      distance = d.man.proximity;
      if (d.man.stance === 'gone') gone = true;
    }
    t += 9;
    return r;
  };
  const begin = await step('begin');
  const opening = begin.events.find((e) => e.type === 'decision');
  check(opening?.man.stance === 'opening', 'begin must answer with the opening call-out');
  const openLine = begin.events.find((e) => e.type === 'line');
  check(openLine?.delivery === 'call_out' && openLine.speaker === 'man', 'the opening line is a call-out from the man');
  check(begin.events.some((e) => e.type === 'thought'), 'begin should carry her first thought');
  check(begin.events[begin.events.length - 1].ms.total < 400, `begin must answer without model latency (took ${begin.events[begin.events.length - 1].ms.total}ms)`);
  if (voice && openLine?.audioUrl) {
    check(openLine.audioUrl.startsWith('/audio/vo/'), 'the opening should be a pre-rendered line');
    await fetchAudio(openLine.audioUrl, 'opening line');
  }

  const spoken = [
    ['No thanks. Have a good night.', ['polite_deflect', 'excuse']],
    ['Leave me alone. Stop following me.', ['firm_boundary', 'hostile', 'threaten_attention']],
    ["I'm calling the police right now.", ['threaten_attention', 'firm_boundary']],
  ];
  let audioChecked = false;
  for (const [text, expected] of spoken) {
    const r = await step('speech', text);
    const read = r.events.find((e) => e.type === 'read');
    if (!gone || read) {
      check(Boolean(read), `speech "${text}" must be read`);
      if (read) check(expected.includes(read.strategy), `"${text}" was read as ${read.strategy}; expected one of ${expected.join(', ')}`);
    }
    const line = r.events.find((e) => e.type === 'line');
    if (voice && line?.audioUrl && !audioChecked) {
      await fetchAudio(line.audioUrl, `line "${line.text}"`, r.started);
      audioChecked = true;
    }
    const outcome = r.events.find((e) => e.type === 'outcome');
    if (outcome) check(outcome.outcome === 'escalated', `unexpected outcome mid-encounter: ${outcome.outcome}`);
  }
  await step('silence', undefined, { playerSpeed: 1.6 });
  const home = await step('reached_home', undefined, { progress: 1 });
  const outcome = home.events.find((e) => e.type === 'outcome');
  check(outcome && ['reached_home_alone', 'reached_home_followed', 'escalated'].includes(outcome.outcome) || home.events.length === 1, `reached_home must end the scene (got ${outcome?.outcome})`);
  const after = await turn(id, { event: 'silence', ctx: ctx({ elapsed: t }) }, 'woman');
  check(after.events.length === 1 && after.events[0].type === 'done', 'a turn after the outcome is answered with just done');

  const sum = await getJson(`/api/session/${id}/summary`);
  check(sum.status === 200, `summary: HTTP ${sum.status}`);
  checkSummary(sum.body, 'woman', 'woman summary');
  console.log(`    summary: "${sum.body?.outcome?.title}" | ${sum.body?.timeline?.length} timeline entries | insights: ${(sum.body?.insights ?? []).map((i) => i.title).join(' / ')}`);
  console.log(`             stats: ${(sum.body?.statIds ?? []).join(', ')} | case: ${sum.body?.caseStudyId ?? 'none'} | ${sum.body?.modelNotes?.length} model notes`);
}

console.log('\n[3] woman POV: the shop, and an unknown session');
{
  const session = await createSession('woman', 5);
  await turn(session.sessionId, { event: 'begin', ctx: ctx() }, 'woman');
  console.log('  > entered_shop');
  const shop = await turn(session.sessionId, { event: 'entered_shop', ctx: ctx({ elapsed: 44, distanceToMan: 4 }) }, 'woman');
  check(shop.events.find((e) => e.type === 'outcome')?.outcome === 'took_refuge', 'entered_shop must end with took_refuge');
  const missing = await fetch(`${base}/api/session/00000000-0000-4000-8000-000000000000/turn`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'begin', ctx: ctx() }) });
  check(missing.status === 404, `a turn for an unknown session should be 404 (got ${missing.status})`);
  await missing.body?.cancel();
  const bad = await fetch(`${base}/api/session/${session.sessionId}/turn`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'dance', ctx: ctx() }) });
  check(bad.status === 400, `an unknown event should be 400 (got ${bad.status})`);
  await bad.body?.cancel();
}

console.log('\n[4] bystander POV: nobody intervenes');
{
  const session = await createSession('bystander', 3);
  const id = session.sessionId;
  for (const event of ['approached', 'walked_past']) {
    console.log(`  > ${event}`);
    const r = await turn(id, { event, ctx: bctx({ elapsed: 12, beat: 'deflect' }) }, 'bystander');
    check(r.events.length === 1 && r.events[0].type === 'done', `${event} must be answered with just done (no takeover)`);
  }
  console.log('  > scene_timeout');
  const end = await turn(id, { event: 'scene_timeout', ctx: bctx({ elapsed: 43.5, beat: 'timeout', distanceToMan: 15, distanceToWoman: 15 }) }, 'bystander');
  const outcome = end.events.find((e) => e.type === 'outcome');
  check(outcome && ['no_intervention_she_escaped', 'no_intervention_escalated'].includes(outcome.outcome), `scene_timeout must end with a no_intervention outcome (got ${outcome?.outcome})`);
  if (outcome?.outcome === 'no_intervention_she_escaped') check(!end.events.some((e) => e.type === 'decision' || e.type === 'line'), 'she_escaped is staged by the client: no decision or line should take over');
  const sum = await getJson(`/api/session/${id}/summary`);
  checkSummary(sum.body, 'bystander', 'bystander (no intervention) summary');
  console.log(`    summary: "${sum.body?.outcome?.title}" | 5 Ds used: ${(sum.body?.fiveDs ?? []).filter((d) => d.used).map((d) => d.key).join(', ') || 'none'} | insights: ${(sum.body?.insights ?? []).map((i) => i.title).join(' / ')}`);
}

console.log('\n[5] bystander POV: an intervention, then checking on her');
{
  const session = await createSession('bystander', 21);
  const id = session.sessionId;
  let t = 22;
  console.log('  > filming_start (from far away)');
  await turn(id, { event: 'filming_start', ctx: bctx({ elapsed: 15, distanceToMan: 18, distanceToWoman: 18, filming: true, beat: 'walk_you_home' }) }, 'bystander');
  const said = 'Hey! There you are. I have been looking everywhere for you.';
  console.log(`  > speech "${said}"`);
  const first = await turn(id, { event: 'speech', text: said, ctx: bctx({ elapsed: t, lookingAt: 'woman' }) }, 'bystander');
  const read = first.events.find((e) => e.type === 'read');
  check(read && ['distract', 'direct'].includes(read.strategy), `"${said}" was read as ${read?.strategy}; expected distract`);
  check(read?.target === 'woman', `target should be the woman (got ${read?.target})`);
  const d = first.events.find((e) => e.type === 'decision');
  check(Boolean(d), 'an intervention must produce a decision (the model takes over)');
  check(d?.woman !== undefined, 'after takeover the decision carries the woman too');
  check(first.events.some((e) => e.type === 'line'), 'an intervention must produce at least one line');
  const firstLine = first.events.find((e) => e.type === 'line');
  if (voice && firstLine?.audioUrl) await fetchAudio(firstLine.audioUrl, `line "${firstLine.text}"`, first.started);
  let ended = first.events.find((e) => e.type === 'outcome')?.outcome ?? null;
  let heGone = false;
  for (let i = 0; i < 10 && !ended; i++) {
    t += 7;
    let r;
    if (heGone) {
      console.log('  > speech "Are you okay? Do you want me to walk with you?"');
      r = await turn(id, { event: 'speech', text: 'Are you okay? Do you want me to walk with you?', ctx: bctx({ elapsed: t, distanceToMan: 99, lookingAt: 'woman', beat: 'intervention' }) }, 'bystander');
      check(r.events.some((e) => e.type === 'line' && e.speaker === 'woman'), 'she should answer when the bystander checks on her');
    } else {
      console.log('  > silence');
      r = await turn(id, { event: 'silence', ctx: bctx({ elapsed: t, beat: 'intervention' }) }, 'bystander');
    }
    const dd = r.events.find((e) => e.type === 'decision');
    if (dd?.man.stance === 'gone') heGone = true;
    ended = r.events.find((e) => e.type === 'outcome')?.outcome ?? null;
  }
  check(ended && ended.startsWith('intervened'), `an intervention must end with an intervened_* outcome (got ${ended})`);
  const sum = await getJson(`/api/session/${id}/summary`);
  checkSummary(sum.body, 'bystander', 'bystander (intervention) summary');
  const ds = sum.body?.fiveDs ?? [];
  check(ds.find((x) => x.key === 'document')?.used === true, 'filming should count as Document');
  check(ds.find((x) => x.key === 'distract')?.used === true || ds.find((x) => x.key === 'direct')?.used === true, 'the spoken intervention should be credited to a D');
  console.log(`    summary: "${sum.body?.outcome?.title}" | 5 Ds used: ${ds.filter((x) => x.used).map((x) => x.key).join(', ')} | case: ${sum.body?.caseStudyId ?? 'none'}`);
}

console.log('\n[6] bystander POV: the shopkeeper');
{
  const session = await createSession('bystander', 8);
  console.log('  > asked_clerk');
  const r = await turn(session.sessionId, { event: 'asked_clerk', ctx: bctx({ elapsed: 25, lookingAt: 'clerk', distanceToMan: 8 }) }, 'bystander');
  const clerkLines = r.events.filter((e) => e.type === 'line' && e.speaker === 'clerk');
  check(clerkLines.length >= 1, 'asked_clerk must bring the shopkeeper to his door');
  check(clerkLines.every((l) => !voice || l.audioUrl.startsWith('/audio/vo/c_')), 'the shopkeeper speaks his scripted, pre-rendered lines');
  check(r.events.find((e) => e.type === 'read')?.strategy === 'delegate', 'asked_clerk is read as delegate');
}

const latency = [];
if (voice) {
  console.log('\n[7] a real voice round trip');
  const key = readKey();
  if (!key) {
    fail('voice is on but there is no ELEVENLABS_API_KEY to synthesise the test clip with');
  } else {
    const sentences = [
      'Leave me alone. I am not interested.',
      'No thank you. Have a good night.',
      'My boyfriend is waiting for me at home.',
      'Please stop following me.',
      'I said no. Back off.',
      'Sorry, I am in a hurry.',
      'Can you please just let me go home.',
      'I am going to call the police.',
    ];
    const runs = Math.max(1, latencyRuns);
    for (let i = 0; i < runs; i++) {
      const sentence = sentences[i % sentences.length];
      // One clip is Ogg/Opus, the rest MP3: both must be accepted as they are.
      const clip = await synthClip(key, sentence, i === 0 ? 'opus_48000_32' : 'mp3_44100_64');
      const session = await createSession('woman', 100 + i);
      await turn(session.sessionId, { event: 'begin', ctx: ctx() }, 'woman');
      console.log(`  > speech (audio clip ${clip.name}, ${clip.bytes.length} bytes): "${sentence}"`);
      const r = await turn(session.sessionId, { event: 'speech', ctx: ctx({ elapsed: 39, distanceToMan: 2.2 }) }, 'woman', clip);
      const heard = r.events.find((e) => e.type === 'heard');
      check(Boolean(heard), 'a spoken turn must emit heard');
      if (heard) check(overlap(sentence, heard.text) >= 0.7, `transcript does not match: said "${sentence}", heard "${heard.text}"`);
      check(r.events.findIndex((e) => e.type === 'heard') === 0, 'heard must be the first event of a spoken turn');
      const done = r.events[r.events.length - 1];
      const line = r.events.find((e) => e.type === 'line');
      let audio = null;
      if (line?.audioUrl) audio = await fetchAudio(line.audioUrl, `line "${line.text}"`, r.started);
      latency.push({
        stt: done.ms.stt,
        read: done.ms.read,
        decide: done.ms.decide,
        write: done.ms.write,
        tts: done.ms.tts,
        serverFirstAudio: done.ms.firstAudio,
        lineEvent: line?._at,
        heardEvent: heard?._at,
        decisionEvent: r.events.find((e) => e.type === 'decision')?._at,
        fallback: (done.ms.fallbackLine ?? 0) + (done.ms.fallbackRead ?? 0),
      });
    }
    if (latency.length >= 2) {
      const col = (k) => latency.map((l) => l[k]).filter(isNum);
      const row = (label, k) => console.log(`    ${label.padEnd(44)} median ${String(Math.round(median(col(k)))).padStart(5)}ms   min ${String(Math.min(...col(k))).padStart(5)}   max ${String(Math.max(...col(k))).padStart(5)}   (n=${col(k).length})`);
      console.log(`\n  per-stage latency over ${latency.length} spoken turns`);
      row('speech to text (Scribe)', 'stt');
      row('read (Clef)', 'read');
      row('decide (state machine)', 'decide');
      row('write (line model, to the complete line)', 'write');
      row('text to speech, time to first byte', 'tts');
      row('server: request in -> first audio byte', 'serverFirstAudio');
      row('client: request sent -> heard event', 'heardEvent');
      row('client: request sent -> decision event', 'decisionEvent');
      row('client: request sent -> line event', 'lineEvent');
      console.log(`    turns that fell back to heuristics or the line bank: ${latency.filter((l) => l.fallback).length}`);
    }
  }
} else {
  console.log('\n[7] voice round trip skipped (voice is off)');
}

console.log(failures ? `\nFAILED: ${failures} contract violation(s)\n${problems.map((p) => `  - ${p}`).join('\n')}` : '\nPASSED: every event and summary matched the contract');
process.exit(failures ? 1 : 0);
