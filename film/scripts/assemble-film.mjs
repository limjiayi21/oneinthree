#!/usr/bin/env node
/**
 * Assembles the 30 s Part 1 film from the prepared assets. No API calls.
 * Needs ffmpeg and Google Chrome (headless, to render the text cards).
 *
 *   node film/scripts/assemble-film.mjs
 *
 * Inputs (film/assets/, not in git): video/A-veo.mp4, edit/B.mp4, edit/C.mp4,
 * edit/E.mp4, montage-5s.wav (built by build-montage.mjs --profile short),
 * narration-1-female.mp3, narration-3-female.mp3, music.mp3 and the sfx-*.mp3.
 *
 * Outputs:
 *   film/assets/part1-film-master.mp4   1280x720, 24 fps, high quality
 *   public/film/part1-film.mp4          H.264 crf 26, AAC 128k, +faststart
 *   film/assets/check/still-09s.png, still-21s.png, still-28s.png
 *   film/assets/build/                  text cards and the audio mix
 *
 * The timeline lives in SCENES, AUDIO and CARDS below. Stats are read from
 * content/evidence.json by id; the source line is the publisher (up to any
 * bracket or "via") and the source's year.
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

// ---------------------------------------------------------------- timeline

/**
 * Picture. Each scene after the first starts with a XF crossfade at `at`, so
 * every scene but the last runs XF longer than its slot.
 */
const SCENES = [
  { name: 'black', at: 0, slot: 5 },
  { name: 'A', at: 5, slot: 6, file: 'video/A-veo.mp4', from: 0 }, // original clip, normal speed
  { name: 'B', at: 11, slot: 6, file: 'edit/B.mp4', from: 0 },
  { name: 'C', at: 17, slot: 6, file: 'edit/C.mp4', from: 0 },
  { name: 'E', at: 23, slot: 7, file: 'edit/E.mp4', from: 0 },
];

/** Target loudness (LUFS) of each source before mixing, as measured with ebur128. */
const NARRATION_LUFS = -16;
const MUSIC_BELOW = 20; // dB under the narration

/**
 * Sound. at/until are film times; from is the start inside the source; loop
 * repeats a short source. lufs sets the level; ramp multiplies the gain
 * linearly from ramp[0] to ramp[1] over the layer (amplitude); fadeIn/fadeOut
 * in seconds. Everything also fades with the picture over the last 1.5 s.
 */
const AUDIO = [
  { file: 'montage-5s.wav', at: 0, until: 5, keep: true }, // already mixed and cut at 4.8 s
  { file: 'sfx-footsteps.mp3', at: 5, until: 17 + XF, loop: true, lufs: -29, fadeIn: XF, fadeOut: XF },
  { file: 'sfx-ambience.mp3', at: 5, until: LENGTH, loop: true, lufs: -34, fadeIn: XF },
  { file: 'narration-1-female.mp3', at: 5.5, lufs: NARRATION_LUFS },
  { file: 'sfx-keys.mp3', at: 11, until: 17, lufs: -27, fadeIn: 0.15, fadeOut: XF },
  { file: 'sfx-follower.mp3', at: 17, until: 23 + XF, from: 3.7, lufs: -27, ramp: [0.45, 1], fadeIn: XF, fadeOut: XF },
  { file: 'sfx-heartbeat.mp3', at: 17, until: 23.5, from: 8.5, lufs: -24, ramp: [0.4, 1], fadeIn: XF, fadeOut: 0.5 }, // the faster end
  { file: 'narration-3-female.mp3', at: 24, lufs: NARRATION_LUFS },
  { file: 'music.mp3', at: 5, until: LENGTH, from: 0, lufs: NARRATION_LUFS - MUSIC_BELOW, rise: { from: 23, to: 25, db: 4 }, fadeIn: 0.5 },
];

/** Bands: soft dark band across the lower third while any lower-third text is up. */
const BANDS = [
  [6, 11],
  [12, 17],
  [20, 27],
];

/** Text. kind: caption (bottom), stat (above the caption slot), closing (centred, larger). */
const CARDS = [
  { kind: 'caption', at: 6, until: 11, text: 'For you, that was a simulation. For many women, it\u2019s an ordinary walk home.' },
  { kind: 'stat', at: 8, until: 11, id: 'ssh2018_public_66' },
  { kind: 'stat', at: 12, until: 17, id: 'yougov_keys_44' },
  { kind: 'stat', at: 20, until: 23, id: 'ssh2018_followed_34' }, // the game adds "You guessed N" beside this one
  { kind: 'stat', at: 23, until: 27, id: 'loreal_helped_25' },
  { kind: 'caption', at: 24, until: 27, text: 'But sometimes, someone is there.' },
  { kind: 'closing', at: 27, until: LENGTH, text: 'Next: you\u2019re the one watching.' },
];

/**
 * Layout in pixels of the 1280x720 frame, shared with the game overlay (which
 * places "You guessed N" to the right of the stat block): the stat block's top
 * edge and its maximum width.
 */
export const LAYOUT = { side: 96, statTop: 448, statMaxWidth: 700, captionBottom: 46 };

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
    const file = A(l.file);
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
  filters.push(
    `${AUDIO.map((_, i) => `[a${i}]`).join('')}amix=inputs=${AUDIO.length}:normalize=0:duration=longest,` +
      `atrim=0:${LENGTH},apad=whole_dur=${LENGTH},afade=t=out:st=${LENGTH - FADE_OUT}:d=${FADE_OUT}[mix]`,
  );
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
    f.push(`[${n}:v]trim=start=${s.from ?? 0}:duration=${dur},setpts=PTS-STARTPTS,fps=${FPS},scale=${W}:${H},setsar=1,format=yuv420p,settb=AVTB[s${i}]`);
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

// ---------------------------------------------------------------- run

mkdirSync(build, { recursive: true });
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
for (const t of [9, 21, 28]) ff(['-ss', String(t), '-i', master, '-frames:v', '1', resolve(check, `still-${String(t).padStart(2, '0')}s.png`)]);

const mb = (p) => (statSync(p).size / 1e6).toFixed(2);
console.log(`master ${mb(master)} MB -> ${master}`);
console.log(`web    ${mb(web)} MB -> ${web}`);
console.log(`stills -> ${check}`);
console.log(`text layers: ${layers.map((l) => `${l.name} ${l.at}-${l.until}s`).join(', ')}`);
if (statSync(web).size >= 25e6) {
  console.error('web file is 25 MB or more');
  process.exit(1);
}
