#!/usr/bin/env node
/**
 * Builds film/assets/montage.wav (12 s, stereo, 44.1 kHz, 16-bit) from the
 * man's pre-rendered lines in public/audio/vo/ plus the film heartbeat.
 * No API calls. Needs ffmpeg on PATH.
 *
 *   node film/scripts/build-montage.mjs
 *
 * Lines enter closer together and louder as it goes, panned around the
 * listener; the early ones are quieter and dulled as if further away. The
 * heartbeat runs underneath, and everything cuts to digital silence at 11.5 s.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CUT = 11.5;
const LENGTH = 12;

// at: start time (s); pan: -1 left .. 1 right; gain: linear; far: dull and add a little space.
const LINES = [
  { id: 'lb_opening_1', at: 0.0, pan: 0.0, gain: 0.35, far: true }, // Hey. Hey, beautiful. Where you headed?
  { id: 'lb_opening_4', at: 1.3, pan: -0.8, gain: 0.4, far: true }, // Hey, gorgeous. Smile, it's not that bad.
  { id: 'lb_persist_4', at: 2.8, pan: 0.7, gain: 0.5, far: true }, // Why you so quiet, sweetheart? I don't bite.
  { id: 'lb_persist_3', at: 4.0, pan: -0.5, gain: 0.6, far: false }, // You got a man? I bet you don't have a man.
  { id: 'lb_follow_2', at: 5.3, pan: 0.9, gain: 0.7, far: false }, // Where you running to? Slow down.
  { id: 'lb_guilt_7', at: 6.4, pan: -0.2, gain: 0.75, far: false }, // It's a compliment, sweetheart. Most girls would say thank you.
  { id: 'lb_block_6', at: 7.6, pan: 0.4, gain: 0.9, far: false }, // Look at me when I'm talking to you.
  { id: 'lb_escalate_1', at: 8.8, pan: 0.0, gain: 1.0, far: false }, // Hey! Don't you walk away from me!
];
const HEARTBEAT = { file: 'film/assets/sfx-heartbeat.mp3', gain: 0.55 };

const inputs = [];
const filters = [];
LINES.forEach((l, i) => {
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
const hb = LINES.length;
inputs.push('-i', resolve(root, HEARTBEAT.file));
filters.push(`[${hb}:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=${HEARTBEAT.gain},afade=t=in:d=1[hb]`);
const mixIn = LINES.map((_, i) => `[v${i}]`).join('') + '[hb]';
filters.push(
  `${mixIn}amix=inputs=${LINES.length + 1}:normalize=0:duration=longest,alimiter=limit=0.89,` +
    // Hard cut to true silence at CUT, then pad to LENGTH.
    `atrim=0:${CUT},apad=whole_dur=${LENGTH}[out]`,
);

const out = resolve(root, 'film/assets/montage.wav');
execFileSync('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', filters.join(';'), '-map', '[out]', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', out], { stdio: 'inherit' });
console.log(`wrote ${out}`);
console.log('sources:');
for (const l of LINES) console.log(`  public/audio/vo/${l.id}.mp3  at ${l.at}s  pan ${l.pan}  gain ${l.gain}${l.far ? '  far' : ''}`);
console.log(`  ${HEARTBEAT.file}  gain ${HEARTBEAT.gain}`);
