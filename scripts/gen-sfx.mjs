#!/usr/bin/env node
/**
 * Renders the sound effects listed in content/sfx.json to public/<file>.
 *
 *   node scripts/gen-sfx.mjs              render what is missing
 *   node scripts/gen-sfx.mjs --force      re-render everything
 *   node scripts/gen-sfx.mjs --only=footstep   only names starting with this prefix
 *   node scripts/gen-sfx.mjs --dry        list what would be rendered
 *
 * content/sfx.json is an array of
 *   { name, file, prompt, durationSeconds, loop, promptInfluence }
 * The API key is read from .dev.vars (or the environment) and is never printed.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SFX_MODEL, TTS_OUTPUT_FORMAT } from '../worker/voices.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const force = args.includes('--force');
const dry = args.includes('--dry');
const only = (args.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length);
const CONCURRENCY = 3;

function readKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY.trim();
  const file = resolve(root, '.dev.vars');
  if (!existsSync(file)) return '';
  const m = readFileSync(file, 'utf8').match(/^ELEVENLABS_API_KEY=(.*)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
}

const manifest = resolve(root, 'content/sfx.json');
if (!existsSync(manifest)) {
  console.error('content/sfx.json does not exist yet. Nothing rendered.');
  process.exit(1);
}
const all = JSON.parse(readFileSync(manifest, 'utf8'));
if (!Array.isArray(all)) {
  console.error('content/sfx.json must be an array.');
  process.exit(1);
}
const items = all.filter((s) => s && s.name && s.file && s.prompt && (!only || String(s.name).startsWith(only)));
const target = (s) => resolve(root, 'public', String(s.file).replace(/^\/+/, ''));
const todo = items.filter((s) => force || !existsSync(target(s)) || statSync(target(s)).size < 800);

console.log(`${items.length} effects, ${items.length - todo.length} already rendered, ${todo.length} to render${force ? ' (--force)' : ''} | model=${SFX_MODEL}`);
if (dry) {
  for (const s of todo) console.log(`  ${s.name}  ${s.durationSeconds}s${s.loop ? ' loop' : ''}  -> public/${s.file}`);
  process.exit(0);
}
if (!todo.length) process.exit(0);

const key = readKey();
if (!key) {
  console.error('ELEVENLABS_API_KEY is not set (.dev.vars or environment). Nothing rendered.');
  process.exit(1);
}

const looksLikeMp3 = (buf) => buf.length > 800 && ((buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0));

/** The API rejects prompts over 450 characters: trim at the last full sentence that fits. */
const MAX_PROMPT = 450;
function fitPrompt(s) {
  const text = String(s.prompt).trim();
  if (text.length <= MAX_PROMPT) return text;
  const cut = text.slice(0, MAX_PROMPT);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  const trimmed = (stop > 200 ? cut.slice(0, stop + 1) : cut.slice(0, cut.lastIndexOf(' '))).trim();
  console.log(`  note ${s.name}: prompt is ${text.length} characters, trimmed to ${trimmed.length} (limit ${MAX_PROMPT})`);
  return trimmed;
}

async function render(s) {
  const duration = typeof s.durationSeconds === 'number' ? Math.min(30, Math.max(0.5, s.durationSeconds)) : null;
  const body = {
    text: fitPrompt(s),
    model_id: SFX_MODEL,
    duration_seconds: duration,
    prompt_influence: typeof s.promptInfluence === 'number' ? Math.min(1, Math.max(0, s.promptInfluence)) : 0.3,
    loop: Boolean(s.loop),
  };
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(`https://api.elevenlabs.io/v1/sound-generation?output_format=${TTS_OUTPUT_FORMAT}`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (!looksLikeMp3(buf)) throw new Error(`${s.name}: response is not an mp3 (${buf.length} bytes)`);
      return { buf, cost: Number(res.headers.get('character-cost') ?? 0) };
    }
    const detail = (await res.text()).slice(0, 240);
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 1200 * attempt * attempt));
      continue;
    }
    throw new Error(`${s.name}: HTTP ${res.status} ${detail}`);
  }
  throw new Error(`${s.name}: gave up`);
}

let done = 0;
let failed = 0;
let bytes = 0;
let cost = 0;
const errors = [];
const queue = [...todo];
async function worker() {
  for (;;) {
    const s = queue.shift();
    if (!s) return;
    try {
      const { buf, cost: c } = await render(s);
      mkdirSync(dirname(target(s)), { recursive: true });
      writeFileSync(target(s), buf);
      done += 1;
      bytes += buf.length;
      cost += c;
      console.log(`  ok   ${s.name} (${(buf.length / 1024).toFixed(0)} KB)`);
    } catch (err) {
      failed += 1;
      errors.push(String(err.message ?? err));
      console.log(`  FAIL ${s.name}`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

console.log(`rendered ${done}, failed ${failed}, ${(bytes / 1024).toFixed(0)} KB, reported cost ${cost} credits`);
for (const e of errors.slice(0, 10)) console.error(`  ! ${e}`);
process.exit(failed ? 1 : 0);
