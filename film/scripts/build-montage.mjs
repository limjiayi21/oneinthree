#!/usr/bin/env node
/**
 * Builds the catcall montage from the man's pre-rendered lines in
 * public/audio/vo/ plus the film heartbeat. No API calls. Needs ffmpeg.
 *
 *   node film/scripts/build-montage.mjs                 film/assets/montage.wav    (12 s, cut at 11.5 s)
 *   node film/scripts/build-montage.mjs --profile short film/assets/montage-5s.wav (5 s, cut at 4.8 s)
 *
 * Lines enter closer together and louder as it goes, panned around the
 * listener; the early ones are quieter and dulled as if further away. The
 * heartbeat runs underneath, and everything cuts to digital silence at the cut
 * point. Stereo, 44.1 kHz, 16-bit WAV.
 *
 * The short profile is built from the same lines re-spaced to fit, rather
 * than the first 5 s of the long one (which holds only the quiet openers).
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// at: start time (s); pan: -1 left .. 1 right; gain: linear; far: dull and add a little space.
const PROFILES = {
  full: {
    out: 'film/assets/montage.wav',
    cut: 11.5,
    length: 12,
    lines: [
      { id: 'lb_opening_1', at: 0.0, pan: 0.0, gain: 0.35, far: true }, // Hey. Hey, beautiful. Where you headed?
      { id: 'lb_opening_4', at: 1.3, pan: -0.8, gain: 0.4, far: true }, // Hey, gorgeous. Smile, it's not that bad.
      { id: 'lb_persist_4', at: 2.8, pan: 0.7, gain: 0.5, far: true }, // Why you so quiet, sweetheart? I don't bite.
      { id: 'lb_persist_3', at: 4.0, pan: -0.5, gain: 0.6, far: false }, // You got a man? I bet you don't have a man.
      { id: 'lb_follow_2', at: 5.3, pan: 0.9, gain: 0.7, far: false }, // Where you running to? Slow down.
      { id: 'lb_guilt_7', at: 6.4, pan: -0.2, gain: 0.75, far: false }, // It's a compliment, sweetheart. Most girls would say thank you.
      { id: 'lb_block_6', at: 7.6, pan: 0.4, gain: 0.9, far: false }, // Look at me when I'm talking to you.
      { id: 'lb_escalate_1', at: 8.8, pan: 0.0, gain: 1.0, far: false }, // Hey! Don't you walk away from me!
    ],
  },
  short: {
    out: 'film/assets/montage-5s.wav',
    cut: 4.8,
    length: 5,
    lines: [
      { id: 'lb_opening_1', at: 0.0, pan: 0.0, gain: 0.35, far: true }, // Hey. Hey, beautiful. Where you headed?
      { id: 'lb_opening_4', at: 0.45, pan: -0.8, gain: 0.4, far: true }, // Hey, gorgeous. Smile, it's not that bad.
      { id: 'lb_persist_4', at: 0.95, pan: 0.7, gain: 0.5, far: true }, // Why you so quiet, sweetheart? I don't bite.
      { id: 'lb_persist_3', at: 1.5, pan: -0.5, gain: 0.6, far: false }, // You got a man? I bet you don't have a man.
      { id: 'lb_follow_2', at: 2.05, pan: 0.9, gain: 0.7, far: false }, // Where you running to? Slow down.
      { id: 'lb_block_6', at: 2.6, pan: 0.4, gain: 0.85, far: false }, // Look at me when I'm talking to you.
      { id: 'lb_escalate_1', at: 3.2, pan: 0.0, gain: 1.0, far: false }, // Hey! Don't you walk away from me! (cut mid-line)
    ],
  },
};
const HEARTBEAT = { file: 'film/assets/sfx-heartbeat.mp3', gain: 0.55 };

const profileName = (() => {
  const i = process.argv.indexOf('--profile');
  return i >= 0 ? process.argv[i + 1] : 'full';
})();
const P = PROFILES[profileName];
if (!P) throw new Error(`unknown profile ${profileName}; use ${Object.keys(PROFILES).join(' or ')}`);

const inputs = [];
const filters = [];
P.lines.forEach((l, i) => {
  const file = resolve(root, `public/audio/vo/${l.id}.mp3`);
  if (!existsSync(file)) throw new Error(`missing ${file}`);
  inputs.push('-i', file);
  // Constant-power pan of the mono line into stereo.
  const a = ((l.pan + 1) * Math.PI) / 4;
  const left = (Math.cos(a) * l.gain).toFixed(3);
  const right = (Math.sin(a) * l.gain).toFixed(3);
  const distance = l.far ? 'lowpass=f=2800,aecho=0.8:0.6:60:0.25,' : '';
  filters.push(`[${i}:a]aformat=sample_rates=44100:channel_layouts=mono,${distance}pan=stereo|c0=${left}*c0|c1=${right}*c0,adelay=${Math.round(l.at * 1000)}:all=1[v${i}]`);
});
const hb = P.lines.length;
inputs.push('-i', resolve(root, HEARTBEAT.file));
filters.push(`[${hb}:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=${HEARTBEAT.gain},afade=t=in:d=${Math.min(1, P.cut / 5)}[hb]`);
const mixIn = P.lines.map((_, i) => `[v${i}]`).join('') + '[hb]';
filters.push(
  `${mixIn}amix=inputs=${P.lines.length + 1}:normalize=0:duration=longest,alimiter=limit=0.89,` +
    // Hard cut to true silence at the cut point, then pad to the full length.
    `atrim=0:${P.cut},apad=whole_dur=${P.length}[out]`,
);

const out = resolve(root, P.out);
execFileSync('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', filters.join(';'), '-map', '[out]', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', out], { stdio: 'inherit' });
console.log(`wrote ${out} (${P.length} s, silence from ${P.cut} s)`);
console.log('sources:');
for (const l of P.lines) console.log(`  public/audio/vo/${l.id}.mp3  at ${l.at}s  pan ${l.pan}  gain ${l.gain}${l.far ? '  far' : ''}`);
console.log(`  ${HEARTBEAT.file}  gain ${HEARTBEAT.gain}`);
