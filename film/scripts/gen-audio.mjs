#!/usr/bin/env node
/**
 * Renders the narration, sound effects and music for the Part 1 film to
 * film/assets/. Each file is rendered once: anything that already exists is
 * skipped (pass --force=<name> to redo one item).
 *
 *   node film/scripts/gen-audio.mjs            render what is missing
 *   node film/scripts/gen-audio.mjs --dry      list what would be rendered
 *   node film/scripts/gen-audio.mjs --only=sfx only items whose name starts with this
 *
 * Narration uses the repo's pre-render model, output format and settings from
 * worker/voices.ts (eleven_v4, mp3_44100_128, the calm "clerk"-style settings,
 * one bracketed delivery tag). SFX use the repo's SFX model. The cost of each
 * item comes from the API's character-cost header where it is sent, and the
 * total from the account's credit counter. Every item is appended to
 * film/assets/log.jsonl. The API key is read from .dev.vars or the environment
 * and is never printed.
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SFX_MODEL, TTS_OUTPUT_FORMAT, TTS_RENDER_MODEL } from '../../worker/voices.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(root, 'film/assets');
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const only = (args.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length);
const force = (args.find((a) => a.startsWith('--force=')) ?? '').slice('--force='.length);

/**
 * Calm, low, warm narrators, chosen from the account's voice list. Both get the
 * same model, settings and delivery tag so the only difference is the voice.
 */
const SETTINGS = { stability: 0.5, similarity_boost: 0.8 };
const TAG = '[calm, low, warm]';
export const NARRATORS = [
  { suffix: 'male', id: 'nPczCjzI2devNBz1zQrb', name: 'Brian - Deep, Resonant and Comforting' },
  { suffix: 'female', id: 'XrExE9yKIg1WjnnlVkGX', name: 'Matilda - Knowledgable, Professional' },
];

const NARRATION = [
  'For you, that was a simulation. For many women, it’s an ordinary walk home.',
  'Most of it happens when no one else is around. So most men never see it.',
  'But sometimes, someone is there.',
];

/**
 * The 30 s film's spoken stats and closing hook, in the chosen (female) voice
 * only. Short spoken forms of content/evidence.json entries; the full wording
 * and the source stay on screen.
 */
const FILM_LINES = [
  { name: 'stat-66', text: 'Sixty-six percent of women in the US have been sexually harassed in public.' }, // ssh2018_public_66
  { name: 'stat-44', text: 'In the UK, forty-four percent of women hold their keys ready to defend themselves.' }, // yougov_keys_44 (UK survey)
  { name: 'stat-34', text: 'More than one in three women in the US have been followed.' }, // ssh2018_followed_34
  { name: 'stat-25', text: 'Only twenty-five percent of people harassed in public say someone helped.' }, // loreal_helped_25
  { name: 'hook', text: 'This time, you’re the one. What would you do?' },
  { name: 'someone-help', text: 'But sometimes, someone is there to help.' },
];
const FILM_VOICE = 'female';

const SFX = [
  { name: 'footsteps', prompt: 'Footsteps on wet pavement at night, steady walking pace, close to the listener', seconds: 10 },
  { name: 'follower', prompt: 'A second set of heavier footsteps on wet pavement, approaching slowly from behind', seconds: 10 },
  { name: 'keys', prompt: 'Keys jingling in a tightly gripped hand while walking', seconds: 6 },
  { name: 'heartbeat', prompt: 'Slow human heartbeat, deep and muffled, gradually speeding up', seconds: 15 },
  { name: 'ambience', prompt: 'Distant city night ambience, faint traffic, light rain, no voices', seconds: 20 },
];

const MUSIC = {
  prompt: 'Sparse ambient score, a low sustained drone with occasional soft single piano notes, tense and restrained, no drums, no melody, 80 seconds, slow fade out at the end',
  ms: 80000,
  model: 'music_v2_5',
};

const jobs = [
  ...NARRATORS.flatMap((v) => NARRATION.map((text, i) => ({
    name: `narration-${i + 1}-${v.suffix}`,
    file: `narration-${i + 1}-${v.suffix}.mp3`,
    url: `https://api.elevenlabs.io/v1/text-to-speech/${v.id}?output_format=${TTS_OUTPUT_FORMAT}`,
    body: { text: `${TAG} ${text}`, model_id: TTS_RENDER_MODEL, voice_settings: SETTINGS },
  }))),
  ...FILM_LINES.map((l) => {
    const v = NARRATORS.find((n) => n.suffix === FILM_VOICE);
    return {
      name: `narration-${l.name}-${v.suffix}`,
      file: `narration-${l.name}-${v.suffix}.mp3`,
      url: `https://api.elevenlabs.io/v1/text-to-speech/${v.id}?output_format=${TTS_OUTPUT_FORMAT}`,
      body: { text: `${TAG} ${l.text}`, model_id: TTS_RENDER_MODEL, voice_settings: SETTINGS },
    };
  }),
  ...SFX.map((s) => ({
    name: `sfx-${s.name}`,
    file: `sfx-${s.name}.mp3`,
    url: `https://api.elevenlabs.io/v1/sound-generation?output_format=${TTS_OUTPUT_FORMAT}`,
    body: { text: s.prompt, model_id: SFX_MODEL, duration_seconds: s.seconds, prompt_influence: 0.5, loop: false },
  })),
  {
    name: 'music',
    file: 'music.mp3',
    url: 'https://api.elevenlabs.io/v1/music',
    body: { prompt: MUSIC.prompt, music_length_ms: MUSIC.ms, model_id: MUSIC.model, force_instrumental: true },
  },
].filter((j) => !only || j.name.startsWith(only));

const todo = jobs.filter((j) => j.name === force || !existsSync(resolve(out, j.file)));
console.log(`narrators: ${NARRATORS.map((v) => `${v.suffix}=${v.name} (${v.id})`).join(', ')} | tts=${TTS_RENDER_MODEL} | sfx=${SFX_MODEL} | music=${MUSIC.model}`);
console.log(`${jobs.length} items, ${jobs.length - todo.length} already exist, ${todo.length} to render`);
if (dry) {
  for (const j of todo) console.log(`  ${j.file}  ${JSON.stringify(j.body)}`);
  process.exit(0);
}
if (!todo.length) process.exit(0);

function readKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY.trim();
  const file = resolve(root, '.dev.vars');
  if (!existsSync(file)) return '';
  const m = readFileSync(file, 'utf8').match(/^ELEVENLABS_API_KEY=(.*)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
}
const key = readKey();
if (!key) {
  console.error('ELEVENLABS_API_KEY is not set (.dev.vars or environment). Nothing rendered.');
  process.exit(1);
}
const creditsUsed = async () => (await (await fetch('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': key } })).json()).character_count;
const looksLikeMp3 = (buf) => buf.length > 800 && ((buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0));

mkdirSync(out, { recursive: true });
const startCredits = await creditsUsed();
let failed = 0;
for (const j of todo) {
  const t0 = Date.now();
  try {
    const res = await fetch(j.url, { method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify(j.body) });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!looksLikeMp3(buf)) throw new Error(`response is not an mp3 (${buf.length} bytes, ${res.headers.get('content-type')})`);
    writeFileSync(resolve(out, j.file), buf);
    const header = res.headers.get('character-cost');
    const entry = { at: new Date().toISOString(), kind: j.name.split('-')[0], file: relative(root, resolve(out, j.file)), model: j.body.model_id, seconds: Math.round((Date.now() - t0) / 1000), credits: header === null ? null : Number(header), request: { ...j.body } };
    appendFileSync(resolve(out, 'log.jsonl'), `${JSON.stringify(entry)}\n`);
    console.log(`  ok   ${j.file}  ${(buf.length / 1024).toFixed(0)} KB  ${entry.seconds}s  ${header ?? '?'} credits (header)`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${j.file}: ${err.message}`);
  }
}
await new Promise((r) => setTimeout(r, 4000));
console.log(`total from credit counter: ${(await creditsUsed()) - startCredits} credits`);
process.exit(failed ? 1 : 0);
