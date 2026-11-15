#!/usr/bin/env node
/**
 * Generates stills and clips for the Part 1 film through ElevenLabs Flows.
 *
 *   node film/scripts/flow.mjs image A --versions 3
 *   node film/scripts/flow.mjs image B --versions 3 --ref film/assets/images/A-2.png
 *   node film/scripts/flow.mjs image E --versions 3 --from 4 --ref ...   (writes E-4..E-6)
 *   node film/scripts/flow.mjs video A --model veo-3.1-generate-001 --start film/assets/images/A-2.png
 *   node film/scripts/flow.mjs video A --model bytedance-seedance-v2 --start film/assets/images/A-2.png
 *   add --dry to print the request without calling the API
 *
 * Prompts come from film/PROMPTS.md (one source of truth). Output goes to
 * film/assets/images/<clip>-<n>.<ext> and film/assets/video/<clip>-<model>.mp4.
 * Items run one at a time, so the cost of each is measured from the change in
 * the account's credit counter (GET /v1/user/subscription) around it. Every
 * item is appended to film/assets/log.jsonl.
 *
 * The API key is read from the environment or .dev.vars and is never printed.
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const API = 'https://api.elevenlabs.io';
const [kind, clip, ...rest] = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : fallback;
};
const dry = rest.includes('--dry');

if (!['image', 'video'].includes(kind) || !/^[A-E]$/.test(clip ?? '')) {
  console.error('usage: flow.mjs image|video <A-E> [--versions n] [--model id] [--ref path] [--start path] [--res 720p] [--dry]');
  process.exit(1);
}

// ---------- prompts ----------
function parsePrompts() {
  const md = readFileSync(resolve(root, 'film/PROMPTS.md'), 'utf8');
  const style = md.split('## Style suffix')[1].split('\n## ')[0]
    .split('\n').filter((l) => l.startsWith('>')).map((l) => l.replace(/^>\s?/, '')).join(' ').trim();
  const woman = md.match(/\*\*The woman:\*\*\s*(.+)/)[1].trim().replace(/\.$/, '');
  const clips = {};
  for (const block of md.split('\n## Clip ').slice(1)) {
    const id = block[0];
    const field = (name) => {
      const m = block.match(new RegExp(`\\*\\*${name}:\\*\\*([\\s\\S]*?)(?=\\n- \\*\\*|\\n\\s*\\n|\\n## |$)`));
      return m ? m[1].replace(/\s+/g, ' ').trim() : '';
    };
    clips[id] = { image: field('Image'), motion: field('Motion') };
  }
  return { style, woman, clips };
}
const P = parsePrompts();
const c = P.clips[clip];
// The character description is added wherever the woman herself is on screen.
const character = /\bwoman\b/i.test(c.image) && !/shadow/i.test(c.image) ? ` The woman is ${P.woman}.` : '';
const prompt = kind === 'image' ? `${c.image}${character} ${P.style}` : `${c.motion}${character} ${P.style}`;

// ---------- api ----------
function readKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY.trim();
  for (const dir of [root, resolve(root, '../oneinthree')]) {
    const file = resolve(dir, '.dev.vars');
    if (!existsSync(file)) continue;
    const m = readFileSync(file, 'utf8').match(/^ELEVENLABS_API_KEY=(.*)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return '';
}
const key = dry ? '' : readKey();
if (!dry && !key) {
  console.error('ELEVENLABS_API_KEY is not set (.dev.vars or environment). Nothing generated.');
  process.exit(1);
}
const headers = { 'xi-api-key': key, 'content-type': 'application/json' };

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}
const creditsUsed = async () => (await api('GET', '/v1/user/subscription')).character_count;

function inlineImage(path) {
  const abs = resolve(root, path);
  const ext = extname(abs).toLowerCase();
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[ext];
  if (!mime) throw new Error(`unsupported image type: ${path}`);
  return { type: 'inline_base64', content_base64: readFileSync(abs).toString('base64'), mime_type: mime };
}

async function waitFor(flow, id) {
  const deadline = Date.now() + 20 * 60 * 1000;
  for (;;) {
    const g = await api('GET', `/v1/flows/${flow}/${id}`);
    if (g.status === 'completed') return g;
    if (g.status === 'failed') throw new Error(`generation failed: ${g.failure_reason} ${g.error_message ?? ''}`);
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${id}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'video/mp4': '.mp4' };

async function generate(body, outBase) {
  if (dry) {
    const shown = JSON.parse(JSON.stringify(body, (k, v) => (k === 'content_base64' ? `<${v.length} b64 chars>` : v)));
    console.log(JSON.stringify(shown, null, 2));
    return;
  }
  const before = await creditsUsed();
  const t0 = Date.now();
  const { id } = await api('POST', `/v1/flows/${kind}`, body);
  const done = await waitFor(kind, id);
  const seconds = (Date.now() - t0) / 1000;
  const media = await fetch(done.content_url);
  if (!media.ok) throw new Error(`download failed: HTTP ${media.status}`);
  const out = `${outBase}${EXT[done.content_mime_type] ?? extname(new URL(done.content_url).pathname) ?? ''}`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(await media.arrayBuffer()));
  // The counter can lag slightly behind the generation; give it a moment.
  await new Promise((r) => setTimeout(r, 3000));
  const credits = (await creditsUsed()) - before;
  const entry = { at: new Date().toISOString(), kind, clip, model: body.model_id, file: relative(root, out), generation_id: id, seconds: Math.round(seconds), credits, prompt: body.prompt };
  appendFileSync(resolve(root, 'film/assets/log.jsonl'), `${JSON.stringify(entry)}\n`);
  console.log(`  ok  ${entry.file}  ${entry.seconds}s  ${credits} credits`);
}

// ---------- run ----------
if (kind === 'image') {
  const model = opt('model', 'gemini-3-pro-image');
  const versions = Number(opt('versions', '1'));
  // Number new versions from here so earlier ones are not overwritten.
  const from = Number(opt('from', '1'));
  const ref = opt('ref');
  const body = { model_id: model, prompt, aspect_ratio: '16:9', resolution: opt('res', '2K') };
  if (ref) {
    body.images = [inlineImage(ref)];
    body.prompt = `Match the drawing style, palette, texture and grain of the reference image exactly; use it only as a style reference, not for composition. ${prompt}`;
  }
  console.log(`image ${clip} x${versions} | ${model}${ref ? ` | style ref ${ref}` : ''}`);
  for (let n = from; n < from + versions; n++) await generate(body, resolve(root, `film/assets/images/${clip}-${n}`));
} else {
  const model = opt('model', 'veo-3.1-generate-001');
  const start = opt('start');
  if (!start) {
    console.error('video needs --start <approved image>');
    process.exit(1);
  }
  const body = { model_id: model, prompt, aspect_ratio: '16:9', duration_secs: 8, resolution: opt('res', '720p'), start_frame: inlineImage(start), generate_audio: false };
  console.log(`video ${clip} | ${model} | 8s 16:9 ${body.resolution} | start ${start}`);
  const short = model.startsWith('veo') ? 'veo' : 'seedance';
  await generate(body, resolve(root, `film/assets/video/${clip}-${short}`));
}
