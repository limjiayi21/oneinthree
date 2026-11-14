#!/usr/bin/env node
/**
 * Pre-renders every scripted and line-bank line to public/audio/vo/<id>.mp3.
 *
 *   node scripts/gen-voice.mjs            render what is missing
 *   node scripts/gen-voice.mjs --force    re-render everything
 *   node scripts/gen-voice.mjs --only=lb_hostile   only ids starting with this prefix
 *   node scripts/gen-voice.mjs --dry      list what would be rendered
 *
 * Sources: content/script.json (every line except speaker "self") and
 * content/linebank.json (each line, plus its matching thought as <id>_t).
 * Voices, models, settings and audio tags come from worker/voices.ts, the same
 * module the Worker uses for live lines. The API key is read from .dev.vars
 * (or the environment) and is never printed.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TTS_RENDER_MODEL, VOICES, buildTts } from '../worker/voices.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const force = args.includes('--force');
const dry = args.includes('--dry');
const only = (args.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length);
const CONCURRENCY = 4;

function readKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY.trim();
  const file = resolve(root, '.dev.vars');
  if (!existsSync(file)) return '';
  const m = readFileSync(file, 'utf8').match(/^ELEVENLABS_API_KEY=(.*)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
}

const ROLE = { thought: 'thought', woman: 'woman', man: 'man', clerk: 'clerk' };

function collect() {
  const jobs = [];
  const script = JSON.parse(readFileSync(resolve(root, 'content/script.json'), 'utf8')).lines ?? {};
  for (const [id, line] of Object.entries(script)) {
    if (line.speaker === 'self') continue;
    const role = ROLE[line.speaker];
    if (!role) continue;
    jobs.push({ id, role, text: line.text, emotion: line.emotion ?? 'neutral', delivery: line.delivery ?? 'normal' });
  }
  const bankFile = resolve(root, 'content/linebank.json');
  if (existsSync(bankFile)) {
    const bank = JSON.parse(readFileSync(bankFile, 'utf8'));
    for (const section of ['woman', 'bystander']) {
      for (const entries of Object.values(bank[section] ?? {})) {
        for (const e of entries) {
          jobs.push({ id: e.id, role: ROLE[e.speaker] ?? 'man', text: e.text, emotion: e.emotion ?? 'neutral', delivery: e.delivery ?? 'normal' });
          if (e.thought) jobs.push({ id: `${e.id}_t`, role: 'thought', text: e.thought, emotion: e.thoughtEmotion ?? 'afraid', delivery: 'low' });
        }
      }
    }
  }
  return jobs.filter((j) => !only || j.id.startsWith(only));
}

const looksLikeMp3 = (buf) => buf.length > 2000 && ((buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0));

async function render(job, key) {
  const req = buildTts(job.role, job.text, job.emotion, job.delivery, TTS_RENDER_MODEL);
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(req.url, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (!looksLikeMp3(buf)) throw new Error(`${job.id}: response is not an mp3 (${buf.length} bytes)`);
      return { buf, cost: Number(res.headers.get('character-cost') ?? 0) };
    }
    const detail = (await res.text()).slice(0, 200);
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 800 * attempt * attempt));
      continue;
    }
    throw new Error(`${job.id}: HTTP ${res.status} ${detail}`);
  }
  throw new Error(`${job.id}: gave up`);
}

const jobs = collect();
const outDir = resolve(root, 'public/audio/vo');
mkdirSync(outDir, { recursive: true });
const todo = jobs.filter((j) => force || !existsSync(resolve(outDir, `${j.id}.mp3`)) || statSync(resolve(outDir, `${j.id}.mp3`)).size < 2000);

console.log(`voices: man=${VOICES.man.name} | her=${VOICES.woman.name} | clerk=${VOICES.clerk.name} | model=${TTS_RENDER_MODEL}`);
console.log(`${jobs.length} lines, ${jobs.length - todo.length} already rendered, ${todo.length} to render${force ? ' (--force)' : ''}`);
if (dry) {
  for (const j of todo) console.log(`  ${j.id}  [${j.role}/${j.emotion}/${j.delivery}]  ${j.text}`);
  process.exit(0);
}
if (!todo.length) process.exit(0);

const key = readKey();
if (!key) {
  console.error('ELEVENLABS_API_KEY is not set (.dev.vars or environment). Nothing rendered.');
  process.exit(1);
}

let done = 0;
let failed = 0;
let bytes = 0;
let cost = 0;
let chars = 0;
const errors = [];
const queue = [...todo];
async function worker() {
  for (;;) {
    const job = queue.shift();
    if (!job) return;
    try {
      const { buf, cost: c } = await render(job, key);
      writeFileSync(resolve(outDir, `${job.id}.mp3`), buf);
      done += 1;
      bytes += buf.length;
      cost += c;
      chars += job.text.length;
    } catch (err) {
      failed += 1;
      errors.push(String(err.message ?? err));
    }
    if ((done + failed) % 20 === 0) console.log(`  ${done + failed}/${todo.length}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

console.log(`rendered ${done}, failed ${failed}, ${(bytes / 1024).toFixed(0)} KB, ${chars} characters, reported cost ${cost} credits`);
for (const e of errors.slice(0, 10)) console.error(`  ! ${e}`);
process.exit(failed ? 1 : 0);
