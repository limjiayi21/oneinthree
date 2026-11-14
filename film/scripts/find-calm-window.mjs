#!/usr/bin/env node
/**
 * Finds the stretch of a clip where the background changes colour least.
 *
 *   node film/scripts/find-calm-window.mjs film/assets/video/B-veo.mp4 4
 *
 * Decodes the clip to 64x36 RGB with ffmpeg and measures, inside a background
 * mask (the top band and the right edge, where the hand in clip B never
 * reaches), the mean per-pixel colour change between consecutive frames. Each
 * window's score is the sum of those changes plus the change from its first
 * to its last frame (so a slow drift also counts). Prints the best windows.
 */
import { execFileSync } from 'node:child_process';

const [file, secondsArg = '4'] = process.argv.slice(2);
const W = 64, H = 36, FPS = 24;
const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `scale=${W}:${H}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });
const frameSize = W * H * 3;
const n = Math.floor(raw.length / frameSize);
const inMask = (x, y) => y < H * 0.12 || x > W * 0.8;
const mask = [];
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (inMask(x, y)) mask.push((y * W + x) * 3);
const diff = (a, b) => {
  let s = 0;
  for (const p of mask) for (let c = 0; c < 3; c++) s += Math.abs(raw[a * frameSize + p + c] - raw[b * frameSize + p + c]);
  return s / (mask.length * 3);
};
const step = [0];
for (let i = 1; i < n; i++) step.push(diff(i - 1, i));
const len = Math.round(Number(secondsArg) * FPS);
const scores = [];
for (let s = 0; s + len <= n; s++) {
  let sum = 0;
  for (let i = s + 1; i < s + len; i++) sum += step[i];
  scores.push({ start: s, end: s + len, score: sum + diff(s, s + len - 1) });
}
scores.sort((a, b) => a.score - b.score);
console.log(`${n} frames; window ${len} frames (${secondsArg} s); background mask ${mask.length} of ${W * H} px`);
console.log('per-second background change:', Array.from({ length: Math.ceil(n / FPS) }, (_, k) => step.slice(k * FPS + 1, (k + 1) * FPS).reduce((a, b) => a + b, 0).toFixed(0)).join(' '));
for (const w of scores.slice(0, 5)) console.log(`  ${(w.start / FPS).toFixed(2)}-${(w.end / FPS).toFixed(2)} s  score ${w.score.toFixed(1)}`);
const worst = scores[scores.length - 1];
console.log(`  worst: ${(worst.start / FPS).toFixed(2)}-${(worst.end / FPS).toFixed(2)} s  score ${worst.score.toFixed(1)}`);
