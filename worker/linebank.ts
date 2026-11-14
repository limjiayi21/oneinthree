/**
 * The authored line bank (content/linebank.json) and the scripted lines
 * (content/script.json). Bank lines are pre-rendered to public/audio/vo, so a
 * fallback or an opening call-out plays with no latency.
 */
import bankJson from '../content/linebank.json';
import scriptJson from '../content/script.json';
import type { Emotion } from '../shared/types';
import type { Rng } from './model/rng';
import type { Delivery } from './voices';

export interface BankEntry {
  id: string;
  speaker: 'man' | 'woman' | 'clerk';
  text: string;
  emotion: Emotion;
  delivery: Delivery;
  thought: string;
  thoughtEmotion: Emotion;
}

export interface ScriptLine {
  speaker: 'thought' | 'woman' | 'man' | 'clerk' | 'self';
  text: string;
  emotion: Emotion;
  delivery: Delivery;
}

const BANK = bankJson as unknown as { woman: Record<string, BankEntry[]>; bystander: Record<string, BankEntry[]> };
const SCRIPT = (scriptJson as unknown as { lines: Record<string, ScriptLine> }).lines;

const GENERIC: BankEntry = {
  id: '',
  speaker: 'man',
  text: "Hey. I'm talking to you.",
  emotion: 'annoyed',
  delivery: 'normal',
  thought: 'Keep moving.',
  thoughtEmotion: 'afraid',
};

export function bankEntries(pov: 'woman' | 'bystander', key: string): BankEntry[] {
  return BANK[pov]?.[key] ?? [];
}

/** Pick a line for a stance or situation, avoiding ones this session has already used where possible. */
export function pickBank(pov: 'woman' | 'bystander', key: string, rng: Rng, used: string[]): BankEntry {
  const all = bankEntries(pov, key);
  if (!all.length) return { ...GENERIC };
  const fresh = all.filter((e) => !used.includes(e.id));
  return rng.pick(fresh.length ? fresh : all);
}

export function scriptLine(id: string): ScriptLine | null {
  return SCRIPT[id] ?? null;
}

/** The scripted bystander exchange, in order, with the beat during which each line is spoken. */
const BYSTANDER_SCRIPT: Array<{ beat: string; id: string }> = [
  { beat: 'call_out', id: 'b_m1' },
  { beat: 'alongside', id: 'b_m2' },
  { beat: 'deflect', id: 'b_w1' },
  { beat: 'walk_you_home', id: 'b_m3' },
  { beat: 'blocks', id: 'b_m4' },
  { beat: 'pleads', id: 'b_w2' },
  { beat: 'hostile', id: 'b_m5' },
  { beat: 'hostile', id: 'b_w3' },
];
const BEAT_ORDER = ['before', 'call_out', 'alongside', 'deflect', 'walk_you_home', 'blocks', 'pleads', 'hostile', 'timeout', 'intervention'];

/** What the bystander has heard so far, reconstructed from the name of the current scripted beat. */
export function scriptedSoFar(beat: string | undefined): string[] {
  const at = BEAT_ORDER.indexOf(beat ?? 'before');
  const upTo = at < 0 ? BEAT_ORDER.length : at;
  const out: string[] = [];
  for (const row of BYSTANDER_SCRIPT) {
    if (BEAT_ORDER.indexOf(row.beat) > upTo) break;
    const line = SCRIPT[row.id];
    if (line) out.push(`${line.speaker === 'woman' ? 'HER' : 'HIM'}: ${line.text}`);
  }
  return out;
}
