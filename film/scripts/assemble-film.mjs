#!/usr/bin/env node
/**
 * Assembles the 30 s Part 1 film from the prepared assets. No API calls.
 * Needs ffmpeg and Google Chrome (headless, to render the text cards).
 *
 *   node film/scripts/assemble-film.mjs              build everything
 *   node film/scripts/assemble-film.mjs --vtt-only   only write the text track
 *
 * Inputs (film/assets/, not in git): video/A-veo.mp4, video/C-veo.mp4,
 * edit/B.mp4, edit/D.mp4, edit/E.mp4, montage-5s.wav (build-montage.mjs
 * --profile short), the narration-*-female.mp3 lines, music.mp3, sfx-*.mp3.
 *
 * Outputs:
 *   film/assets/part1-film-master.mp4   1280x720, 24 fps, high quality
 *   public/film/part1-film.mp4          H.264 crf 26, AAC 128k, +faststart
 *   public/film/part1-film.vtt          the on-screen words, for screen readers
 *   film/assets/check/still-*.png       a still from the middle of each shot
 *   film/assets/build/                  text cards, trimmed narration, the mix
 *
 * The film is narrated end to end, so the timeline is worked out from the
 * narration (see plan()): each line is trimmed of silence and sped up by
 * TEMPO, the lines run back to back with GAP between them, and every shot,
 * text card and sound effect is placed around the line it belongs to.
 * Stats are read from content/evidence.json by id; the on-screen source line
 * is the publisher (up to any bracket or "via") and the source's year.
 *
 * ffmpeg here has no drawtext/libass, so each text card is rendered to a
 * transparent 1280x720 PNG by headless Chrome (with the game's fonts and
 * colours) and laid over the picture with a 0.3 s alpha fade in and out.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const A = (p) => resolve(root, 'film/assets', p);
const build = A('build');
const fontsDir = A('fonts');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W = 1280, H = 720, FPS = 24, LENGTH = 30, XF = 0.3, FADE_OUT = 1.5;

// ---------------------------------------------------------------- the script

/** Narration speed-up (pitch kept) so every line fits in 30 s, and the pause between lines. */
const TEMPO = 1.13;
const GAP = 0.16;
/** When the first line starts (the montage cuts to silence at 4.8 s), and the latest the last may end. */
const NARRATION_START = 5.1;
const NARRATION_END_BY = 29.6;

/**
 * The film, line by line. shot: the clip under the line (a shot runs until the
 * next line that names a different one). card: the on-screen text for it.
 * Shots: file, where to start in it, and maxSource (seconds of the source that
 * may be used; a longer slot is slowed to fit).
 */
const SHOTS = {
  A: { file: 'video/A-veo.mp4', from: 0, maxSource: 6 }, // the walk, original speed (it brightens after 6 s)
  D: { file: 'edit/D.mp4', from: 0 }, // the empty street, rain
  B: { file: 'edit/B.mp4', from: 0 }, // keys (the calm 4 s of the clip, slowed)
  C: { file: 'video/C-veo.mp4', from: 0, maxSource: 3 }, // the shadow; after 3 s the light cuts out and strobes
  E: { file: 'edit/E.mp4', from: 0 }, // from across the road (the road stays visible)
};
const LINES = [
  { file: 'narration-1-female.mp3', shot: 'A', card: { kind: 'caption', text: 'For you, that was a simulation. For many women, it’s an ordinary walk home.' } },
  { file: 'narration-stat-66-female.mp3', shot: 'D', card: { kind: 'stat', id: 'ssh2018_public_66' } },
  { file: 'narration-stat-44-female.mp3', shot: 'B', card: { kind: 'stat', id: 'yougov_keys_44' } },
  { file: 'narration-stat-34-female.mp3', shot: 'C', card: { kind: 'stat', id: 'ssh2018_followed_34' } },
  { file: 'narration-stat-25-female.mp3', shot: 'E', card: { kind: 'stat', id: 'loreal_helped_25' } },
  { file: 'narration-hook-female.mp3', shot: 'E', card: { kind: 'closing', text: 'This time, you’re the one. What would you do?' } },
];

/** Target loudness (LUFS) of each source before mixing, as measured with ebur128. */
const NARRATION_LUFS = -16;
const MUSIC_BELOW = 20; // dB under the narration

/** Filled in by plan(). */
let SCENES = [];
let AUDIO = [];
let CARDS = [];
let BANDS = [];
let TIMES = [];

/**
 * Layout in pixels of the 1280x720 frame: side margin, the stat block's top
 * edge and maximum width, and the caption's distance from the bottom.
 */
export const LAYOUT = { side: 96, statTop: 448, statMaxWidth: 700, captionBottom: 46 };

/** Trim a narration line's leading and trailing silence and speed it up; returns the new file and its length. */
function prepareLine(file) {
  const out = resolve(build, `vo-${file.replace(/\.mp3$/, '')}.wav`);
  const trim = 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.03';
  ff(['-i', A(file), '-af', `${trim},areverse,${trim},areverse,atempo=${TEMPO}`, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s24le', out]);
  const dur = Number(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString().trim());
  return { out, dur };
}

/** Lay the narration end to end, then hang the shots, cards, bands and sound off it. */
function plan() {
  let t = NARRATION_START;
  TIMES = LINES.map((l) => {
    const { out, dur } = prepareLine(l.file);
    const at = t;
    t = at + dur + GAP;
    return { ...l, wav: out, at, until: at + dur, dur };
  });
  const last = TIMES[TIMES.length - 1];
  if (last.until > NARRATION_END_BY) throw new Error(`narration ends at ${last.until.toFixed(2)} s, after ${NARRATION_END_BY} s: raise TEMPO or shorten a line`);

  // Shots: black under the montage, then a cut 0.1 s before the first line of each new shot.
  SCENES = [{ name: 'black', at: 0, slot: 5 }];
  for (const l of TIMES) {
    if (SCENES[SCENES.length - 1].name === l.shot) continue;
    const at = SCENES.length === 1 ? 5 : Math.round((l.at - 0.1) * FPS) / FPS;
    SCENES.push({ name: l.shot, at, ...SHOTS[l.shot] });
  }
  SCENES.forEach((s, i) => (s.slot = (i + 1 < SCENES.length ? SCENES[i + 1].at : LENGTH) - s.at));

  // Cards: each with its line. Stats hold until just after the line; the closing holds to the end.
  CARDS = TIMES.map((l) => {
    const scene = [...SCENES].reverse().find((s) => s.at <= l.at);
    const sceneEnd = scene.at + scene.slot;
    if (l.card.kind === 'closing') return { ...l.card, at: l.at - 0.2, until: LENGTH };
    return { ...l.card, at: Math.max(scene.at + 0.15, l.at - 0.1), until: Math.min(sceneEnd, l.until + 0.45) };
  });
  // Bands under the lower-third cards, merged where they touch.
  BANDS = [];
  for (const c of CARDS.filter((c) => c.kind !== 'closing')) {
    const prev = BANDS[BANDS.length - 1];
    if (prev && c.at - prev[1] < 0.6) prev[1] = Math.max(prev[1], c.until);
    else BANDS.push([c.at, c.until]);
  }

  const span = (name) => {
    const s = SCENES.find((x) => x.name === name);
    return [s.at, s.at + s.slot];
  };
  const [aAt] = span('A');
  const [, dEnd] = span('D');
  const [bAt, bEnd] = span('B');
  const [cAt, cEnd] = span('C');
  const [eAt] = span('E');
  AUDIO = [
    { file: 'montage-5s.wav', at: 0, until: 5, keep: true }, // already mixed and cut at 4.8 s
    { file: 'sfx-ambience.mp3', at: aAt, until: LENGTH, loop: true, lufs: -34, fadeIn: XF },
    { file: 'sfx-footsteps.mp3', at: aAt, until: bEnd + XF, loop: true, lufs: -30, fadeIn: XF, fadeOut: XF }, // her steps: the walk, the street, the keys
    { file: 'sfx-keys.mp3', at: bAt, until: Math.min(bEnd, bAt + 6), lufs: -28, fadeIn: 0.15, fadeOut: XF },
    { file: 'sfx-follower.mp3', at: cAt - 0.4, until: cEnd + XF, from: 10 - (cEnd + XF - cAt + 0.4), lufs: -28, ramp: [0.5, 1], fadeIn: 0.4, fadeOut: XF }, // the closest seconds
    { file: 'sfx-heartbeat.mp3', at: cAt - 0.4, until: cEnd + 0.8, from: 15 - (cEnd + 0.8 - cAt + 0.4), lufs: -25, ramp: [0.5, 1], fadeIn: 0.4, fadeOut: 0.8 }, // the faster end
    { file: 'music.mp3', at: aAt, until: LENGTH, from: 0, lufs: NARRATION_LUFS - MUSIC_BELOW, rise: { from: eAt, to: eAt + 2, db: 4 }, fadeIn: 0.5 },
    ...TIMES.map((l) => ({ wav: l.wav, at: l.at, lufs: NARRATION_LUFS })),
  ];
  void dEnd;
}

// ---------------------------------------------------------------- helpers

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { maxBuffer: 1 << 26, ...opts });
const ff = (args) => sh('ffmpeg', ['-y', '-v', 'error', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
/** Integrated loudness (LUFS) of a file, from ffmpeg's ebur128 summary on stderr. */
function measureLufs(file) {
  const res = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 24 });
  const m = String(res.stderr).match(/Integrated loudness:\s*\n\s*I:\s*(-?[\d.]+) LUFS/);
  if (!m) throw new Error(`could not measure loudness of ${file}`);
  return Number(m[1]);
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------------------------------------------------------------- fonts

const FONTS = {
  'Inter-400.ttf': ['Inter', 400],
  'Inter-500.ttf': ['Inter', 500],
  'Newsreader-300.ttf': ['Newsreader', 300],
  'Newsreader-400.ttf': ['Newsreader', 400],
};
function ensureFonts() {
  mkdirSync(fontsDir, { recursive: true });
  if (Object.keys(FONTS).every((f) => existsSync(resolve(fontsDir, f)))) return;
  // The Google Fonts CSS API returns static TTF URLs to a plain client.
  const css = sh('curl', ['-sfL', 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500&family=Newsreader:opsz,wght@6..72,300;6..72,400&display=swap']).toString();
  for (const block of css.split('@font-face').slice(1)) {
    const fam = block.match(/font-family:\s*'([^']+)'/)?.[1];
    const wt = Number(block.match(/font-weight:\s*(\d+)/)?.[1]);
    const url = block.match(/url\((https:[^)]+\.ttf)\)/)?.[1];
    const name = Object.keys(FONTS).find((f) => FONTS[f][0] === fam && FONTS[f][1] === wt);
    if (name && url) sh('curl', ['-sfL', '-o', resolve(fontsDir, name), url]);
  }
  for (const f of Object.keys(FONTS)) if (!existsSync(resolve(fontsDir, f))) throw new Error(`could not download font ${f}`);
}

// ---------------------------------------------------------------- cards

const evidence = JSON.parse(readFileSync(resolve(root, 'content/evidence.json'), 'utf8'));
function stat(id) {
  const s = evidence.stats.find((x) => x.id === id);
  if (!s) throw new Error(`evidence.json has no stat ${id}`);
  const src = Array.isArray(evidence.sources) ? evidence.sources.find((x) => x.id === s.sourceId) : evidence.sources[s.sourceId];
  if (!src) throw new Error(`evidence.json has no source ${s.sourceId}`);
  const publisher = src.publisher.split(' (')[0].split(' via ')[0].trim();
  return { headline: s.headline, text: s.text, source: `${publisher}, ${src.year}` };
}

const fontFaces = Object.entries(FONTS)
  .map(([f, [fam, wt]]) => `@font-face{font-family:'${fam}';font-weight:${wt};src:url('file://${resolve(fontsDir, f)}') format('truetype');}`)
  .join('\n');

// Game tokens from src/ui/base.css.
const CSS = `${fontFaces}
:root{--ink:#e9e4da;--ink-2:#b8b2a6;--bg:7,8,11;--sans:'Inter',sans-serif;--serif:'Newsreader',serif}
html,body{margin:0;width:${W}px;height:${H}px;background:transparent;overflow:hidden;-webkit-font-smoothing:antialiased}
.band{position:absolute;left:0;right:0;bottom:0;height:${H - 400}px;
  background:linear-gradient(to bottom,rgba(var(--bg),0) 0%,rgba(var(--bg),.58) 26%,rgba(var(--bg),.74) 55%,rgba(var(--bg),.8) 100%)}
.caption{position:absolute;left:${LAYOUT.side}px;right:${LAYOUT.side}px;bottom:${LAYOUT.captionBottom}px;
  color:var(--ink);font:500 27px/1.35 var(--sans);letter-spacing:-.005em;text-wrap:balance}
.stat{position:absolute;left:${LAYOUT.side}px;top:${LAYOUT.statTop}px;max-width:${LAYOUT.statMaxWidth}px;color:var(--ink)}
.stat .num{font:300 50px/1 var(--serif);font-variant-numeric:lining-nums proportional-nums;margin:0 0 8px}
.stat .txt{font:400 20px/1.42 var(--sans);margin:0;text-wrap:pretty}
.stat .src{font:400 13px/1.4 var(--sans);color:var(--ink-2);margin:8px 0 0;letter-spacing:.01em}
.closing{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  color:var(--ink);font:400 50px/1.15 var(--serif);text-align:center;padding:0 ${LAYOUT.side}px;
  text-shadow:0 2px 24px rgba(0,0,0,.55);
  background:radial-gradient(ellipse 46% 22% at 50% 50%,rgba(var(--bg),.62) 0%,rgba(var(--bg),.38) 55%,rgba(var(--bg),0) 100%)}
`;

function cardHtml(card) {
  let body = '';
  if (card.kind === 'band') body = '<div class="band"></div>';
  else if (card.kind === 'caption') body = `<div class="caption">${esc(card.text)}</div>`;
  else if (card.kind === 'closing') body = `<div class="closing">${esc(card.text)}</div>`;
  else {
    const s = stat(card.id);
    body = `<div class="stat"><p class="num">${esc(s.headline)}</p><p class="txt">${esc(s.text)}</p><p class="src">Source: ${esc(s.source)}</p></div>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${body}</body></html>`;
}

function renderCard(name, card) {
  const html = resolve(build, `${name}.html`);
  const png = resolve(build, `${name}.png`);
  writeFileSync(html, cardHtml(card));
  sh(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${resolve(build, 'chrome-profile')}`, '--default-background-color=00000000', `--window-size=${W},${H}`, '--virtual-time-budget=2000', `--screenshot=${png}`, `file://${html}`], { stdio: 'ignore' });
  if (!existsSync(png)) throw new Error(`Chrome did not render ${name}`);
  return png;
}

// ---------------------------------------------------------------- audio

function buildAudio() {
  const inputs = [];
  const filters = [];
  AUDIO.forEach((l, i) => {
    const file = l.wav ?? A(l.file);
    if (!existsSync(file)) throw new Error(`missing ${file}`);
    if (l.loop) inputs.push('-stream_loop', '-1');
    inputs.push('-i', file);
    const from = l.from ?? 0;
    const chain = [`aformat=sample_rates=48000:channel_layouts=stereo`];
    if (l.until !== undefined) chain.push(`atrim=start=${from}:duration=${(l.until - l.at).toFixed(3)}`);
    else if (from) chain.push(`atrim=start=${from}`);
    chain.push('asetpts=PTS-STARTPTS');
    if (!l.keep) {
      const gain = l.lufs - measureLufs(file);
      chain.push(`volume=${gain.toFixed(2)}dB`);
    }
    const dur = l.until !== undefined ? l.until - l.at : null;
    if (l.ramp && dur) chain.push(`volume='${l.ramp[0]}+(${l.ramp[1] - l.ramp[0]})*min(t/${dur.toFixed(3)},1)':eval=frame`);
    if (l.rise) {
      const a = l.rise.from - l.at, b = l.rise.to - l.at, g = 10 ** (l.rise.db / 20) - 1;
      chain.push(`volume='1+${g.toFixed(4)}*clip((t-${a})/${b - a},0,1)':eval=frame`);
    }
    if (l.fadeIn) chain.push(`afade=t=in:d=${l.fadeIn}`);
    if (l.fadeOut && dur) chain.push(`afade=t=out:st=${(dur - l.fadeOut).toFixed(3)}:d=${l.fadeOut}`);
    chain.push(`adelay=${Math.round(l.at * 1000)}:all=1`);
    filters.push(`[${i}:a]${chain.join(',')}[a${i}]`);
  });
  // Music and effects fade out with the picture; the narration (the closing hook) is left whole.
  const bed = AUDIO.map((l, i) => (l.wav ? null : `[a${i}]`)).filter(Boolean);
  const voice = AUDIO.map((l, i) => (l.wav ? `[a${i}]` : null)).filter(Boolean);
  filters.push(`${bed.join('')}amix=inputs=${bed.length}:normalize=0:duration=longest,atrim=0:${LENGTH},apad=whole_dur=${LENGTH},afade=t=out:st=${LENGTH - FADE_OUT}:d=${FADE_OUT}[bed]`);
  filters.push(`${voice.join('')}amix=inputs=${voice.length}:normalize=0:duration=longest,apad=whole_dur=${LENGTH},atrim=0:${LENGTH}[voice]`);
  filters.push('[bed][voice]amix=inputs=2:normalize=0:duration=first[mix]');
  const raw = resolve(build, 'mix-raw.wav');
  ff([...inputs, '-filter_complex', filters.join(';'), '-map', '[mix]', '-t', String(LENGTH), '-c:a', 'pcm_s24le', raw]);
  // Bring the whole mix to -16 LUFS with a -1 dBFS ceiling.
  const gain = -16 - measureLufs(raw);
  const out = resolve(build, 'mix.wav');
  ff(['-i', raw, '-af', `volume=${gain.toFixed(2)}dB,alimiter=limit=0.89:level=false`, '-c:a', 'pcm_s24le', out]);
  return { out, gain };
}

// ---------------------------------------------------------------- picture

function buildFilm(mixWav) {
  const inputs = [];
  const f = [];
  let n = 0;
  // Scenes
  SCENES.forEach((s, i) => {
    const last = i === SCENES.length - 1;
    const dur = s.slot + (last ? 0 : XF);
    if (s.name === 'black') inputs.push('-f', 'lavfi', '-t', String(dur), '-i', `color=c=black:s=${W}x${H}:r=${FPS}`);
    else {
      const file = A(s.file);
      if (!existsSync(file)) throw new Error(`missing ${file}`);
      inputs.push('-i', file);
    }
    // A shot allowed only maxSource seconds of its clip is slowed (frames held) to fill a longer slot.
    const source = s.maxSource && dur > s.maxSource ? s.maxSource : dur;
    const stretch = dur / source;
    f.push(`[${n}:v]trim=start=${s.from ?? 0}:duration=${source.toFixed(3)},setpts=(PTS-STARTPTS)*${stretch.toFixed(4)},fps=${FPS},scale=${W}:${H},setsar=1,format=yuv420p,settb=AVTB[s${i}]`);
    s.stretch = stretch;
    n++;
  });
  let prev = 's0';
  for (let i = 1; i < SCENES.length; i++) {
    f.push(`[${prev}][s${i}]xfade=transition=fade:duration=${XF}:offset=${SCENES[i].at}[x${i}]`);
    prev = `x${i}`;
  }
  // Fade the picture (not the text) to black at the end.
  f.push(`[${prev}]fade=t=out:st=${LENGTH - FADE_OUT}:d=${FADE_OUT},format=yuva420p[pic0]`);
  prev = 'pic0';
  // Text layers: bands first, then cards.
  const layers = [
    ...BANDS.map(([at, until], i) => ({ name: `band-${i + 1}`, card: { kind: 'band' }, at, until })),
    ...CARDS.map((c, i) => ({ name: `card-${i + 1}-${c.kind}${c.id ? `-${c.id}` : ''}`, card: c, at: c.at, until: c.until })),
  ];
  const bandPng = renderCard('band', { kind: 'band' });
  layers.forEach((L, i) => {
    const png = L.card.kind === 'band' ? bandPng : renderCard(L.name, L.card);
    const dur = L.until - L.at;
    inputs.push('-loop', '1', '-framerate', String(FPS), '-t', dur.toFixed(3), '-i', png);
    f.push(`[${n}:v]format=rgba,fade=t=in:st=0:d=${XF}:alpha=1,fade=t=out:st=${(dur - XF).toFixed(3)}:d=${XF}:alpha=1,setpts=PTS-STARTPTS+${L.at}/TB[t${i}]`);
    f.push(`[${prev}][t${i}]overlay=0:0:eof_action=pass:format=yuv420[o${i}]`);
    prev = `o${i}`;
    n++;
  });
  f.push(`[${prev}]format=yuv420p,trim=duration=${LENGTH}[vout]`);
  inputs.push('-i', mixWav);
  const master = A('part1-film-master.mp4');
  ff([...inputs, '-filter_complex', f.join(';'), '-map', '[vout]', '-map', `${n}:a`, '-r', String(FPS), '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '320k', '-t', String(LENGTH), '-movflags', '+faststart', master]);
  return { master, layers };
}

// ---------------------------------------------------------------- text track

/**
 * public/film/part1-film.vtt: the on-screen words with a description of the
 * montage, so the game can read them to screen readers (the narration says
 * a short form of each stat; the cue carries the full wording and source).
 */
function writeVtt() {
  const ts = (s) => {
    const ms = Math.round(s * 1000);
    const hh = String(Math.floor(ms / 3600000)).padStart(2, '0');
    const mm = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
    const ss = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
    return `${hh}:${mm}:${ss}.${String(ms % 1000).padStart(3, '0')}`;
  };
  const cues = [{ at: 0, until: 4.8, text: '[A man calls out at a woman, again and again, over a heartbeat. Then silence.]' }];
  for (const c of CARDS) {
    if (c.kind === 'stat') {
      const s = stat(c.id);
      cues.push({ at: c.at, until: c.until, text: `${s.headline} ${s.text} (Source: ${s.source})` });
    } else cues.push({ at: c.at, until: c.until, text: c.text });
  }
  cues.sort((a, b) => a.at - b.at);
  const body = cues.map((c, i) => `${i + 1}\n${ts(c.at)} --> ${ts(c.until)}\n${c.text}\n`).join('\n');
  const out = resolve(root, 'public/film/part1-film.vtt');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `WEBVTT\n\n${body}`);
  return out;
}

// ---------------------------------------------------------------- run

mkdirSync(build, { recursive: true });
plan();
console.log('narration:');
for (const l of TIMES) console.log(`  ${l.at.toFixed(2)}-${l.until.toFixed(2)} s  ${l.file}`);
console.log(`shots: ${SCENES.map((s) => `${s.name} ${s.at.toFixed(2)}-${(s.at + s.slot).toFixed(2)}`).join(', ')}`);
console.log(`text track -> ${writeVtt()}`);
if (process.argv.includes('--vtt-only')) process.exit(0);
if (!existsSync(A('montage-5s.wav'))) {
  console.log('building montage-5s.wav');
  sh('node', [resolve(root, 'film/scripts/build-montage.mjs'), '--profile', 'short'], { stdio: 'inherit' });
}
ensureFonts();
console.log('mixing audio');
const mix = buildAudio();
console.log(`  mix gain to -16 LUFS: ${mix.gain.toFixed(1)} dB`);
console.log('building picture and master');
const { master, layers } = buildFilm(mix.out);

const web = resolve(root, 'public/film/part1-film.mp4');
mkdirSync(dirname(web), { recursive: true });
console.log('compressing for the web');
ff(['-i', master, '-c:v', 'libx264', '-preset', 'slow', '-crf', '26', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', web]);

const check = A('check');
mkdirSync(check, { recursive: true });
for (const s of SCENES.slice(1)) {
  // A still from the middle of each shot, plus the closing line.
  const t = s.name === 'E' ? LENGTH - 2 : s.at + s.slot / 2;
  ff(['-ss', t.toFixed(2), '-i', master, '-frames:v', '1', resolve(check, `still-${s.name}-${t.toFixed(1)}s.png`)]);
}
console.log(`shot stretch: ${SCENES.slice(1).map((s) => `${s.name} x${(s.stretch ?? 1).toFixed(2)}`).join(', ')}`);

const mb = (p) => (statSync(p).size / 1e6).toFixed(2);
console.log(`master ${mb(master)} MB -> ${master}`);
console.log(`web    ${mb(web)} MB -> ${web}`);
console.log(`stills -> ${check}`);
console.log(`text layers: ${layers.map((l) => `${l.name} ${l.at}-${l.until}s`).join(', ')}`);
if (statSync(web).size >= 25e6) {
  console.error('web file is 25 MB or more');
  process.exit(1);
}
