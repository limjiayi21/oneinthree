#!/usr/bin/env node
/**
 * Cuts and retimes the five Veo clips so each fills an 8 s slot.
 * Writes film/assets/edit/<clip>.mp4 (1280x720, 24 fps, 192 frames, no audio).
 *
 *   node film/scripts/prep-clips.mjs              build with the chosen method
 *   node film/scripts/prep-clips.mjs --compare    also write plain and blended
 *                                                 versions of each slowed clip
 *                                                 to film/assets/edit/compare/
 *
 * Slowed clips are retimed either by plain slowing (frames repeated to fill
 * 24 fps) or by ffmpeg minterpolate frame blending (in-between frames are
 * cross-fades of their neighbours). METHOD below records which was kept.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const src = (c) => resolve(root, `film/assets/video/${c}-veo.mp4`);
const outDir = resolve(root, 'film/assets/edit');
const FPS = 24;
const SLOT = 8;

// start/end in seconds of the source; the cut is stretched to fill SLOT.
const CLIPS = {
  A: { start: 0, end: 6 }, // first 6 s, before the street brightens
  B: { start: 4, end: 8 }, // least background colour change (find-calm-window.mjs)
  C: null, // as is
  D: null, // as is
  E: { start: 0, end: 4 }, // road still visible throughout
};

/**
 * Retiming method kept for the final clips, decided with --compare (frame-step
 * evenness, plus per-frame sharpness and close-up crops for ghosting):
 *  A blend: steps 4x more even (cv 0.15 vs 0.60), in-betweens ~12% softer, no visible ghosting.
 *  B blend: steps 2x more even (0.54 vs 1.26), in-betweens only ~5% softer (mostly black background).
 *  E plain: blending made every other frame ~25% softer and doubled the watcher's
 *           shoulder, so the grain pulsed at 12 Hz; plain 2x is "on twos", which suits the drawn style.
 */
const METHOD = { A: 'blend', B: 'blend', E: 'plain' };

const encode = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-an', '-r', String(FPS), '-frames:v', String(SLOT * FPS)];

function build(clip, method, out) {
  const cut = CLIPS[clip];
  const factor = SLOT / (cut.end - cut.start);
  const base = `trim=start=${cut.start}:end=${cut.end},setpts=(PTS-STARTPTS)*${factor}`;
  // minterpolate cannot make frames after the last source frame, so hold it briefly first.
  const vf = method === 'blend' ? `${base},tpad=stop_mode=clone:stop_duration=0.25,minterpolate=fps=${FPS}:mi_mode=blend` : `${base},fps=${FPS}`;
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', src(clip), '-vf', vf, ...encode, out]);
}

function copy(clip, out) {
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', src(clip), '-c', 'copy', '-an', out]);
}

mkdirSync(outDir, { recursive: true });
const compare = process.argv.includes('--compare');
if (compare) mkdirSync(resolve(outDir, 'compare'), { recursive: true });

for (const clip of Object.keys(CLIPS)) {
  const out = resolve(outDir, `${clip}.mp4`);
  if (!CLIPS[clip]) {
    copy(clip, out);
    console.log(`${clip}: as is`);
    continue;
  }
  if (compare) {
    for (const m of ['plain', 'blend']) build(clip, m, resolve(outDir, 'compare', `${clip}-${m}.mp4`));
  }
  build(clip, METHOD[clip], out);
  const c = CLIPS[clip];
  console.log(`${clip}: ${c.start}-${c.end} s stretched x${(SLOT / (c.end - c.start)).toFixed(3)} (${METHOD[clip]})`);
}
