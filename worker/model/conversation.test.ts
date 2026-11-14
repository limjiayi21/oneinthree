import { describe, expect, it } from 'vitest';
import type { ManStance, WomanStrategy, WorldContext } from '../../shared/types';
import { addressOf, addressOfBystander, contentWord, groundedLine } from './address';
import { STANCE_EMOTIONS } from '../../shared/expression';
import { Rng } from './rng';
import { decideWoman, initialWomanState } from './woman';
import { cleanLine } from '../write';

const ctx = (over: Partial<WorldContext> = {}): WorldContext => ({
  elapsed: 30,
  distanceToMan: 2,
  progress: 0.35,
  playerSpeed: 1.2,
  facingMan: true,
  manBlocking: false,
  oppositeSidewalk: false,
  ...over,
});

const BANNED = /\b(n[i1]gg|fagg?|trann|retard|rape|pussy|kill you|stab you|gun|knife)\b/i;
const FLIRT = /\b(what'?s your name|you'?re beautiful|smile for me|nice ass)\b/i;

function mentions(line: string, text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3);
  const hay = line.toLowerCase();
  return words.some((w) => hay.includes(w));
}

describe('scripted conversations', () => {
  const scenes: Array<{ name: string; strategy: WomanStrategy; text: string }> = [
    { name: 'firm boundary', strategy: 'firm_boundary', text: 'Leave me alone.' },
    { name: 'firm again', strategy: 'firm_boundary', text: 'I said stop following me.' },
    { name: 'de-escalation', strategy: 'polite_deflect', text: 'No thank you, have a good night.' },
    { name: 'excuse', strategy: 'excuse', text: 'My boyfriend is waiting for me.' },
    { name: 'angry reply', strategy: 'hostile', text: 'Get away from me, you creep.' },
    { name: 'calls for help', strategy: 'threaten_attention', text: 'I am calling the police.' },
  ];

  it('answers each move in the stance the machine already picked, without choosing a new one', () => {
    const rng = new Rng(11);
    let state = initialWomanState('persistent');
    const opened = decideWoman(state, { event: 'begin', ctx: ctx({ elapsed: 4 }) }, rng);
    expect(opened.decision?.stance).toBe('opening');
    state = opened.state;
    const said: string[] = [];
    for (const scene of scenes) {
      const out = decideWoman(
        state,
        { event: 'speech', ctx: ctx({ elapsed: 20 + said.length * 8 }), strategyProbs: { [scene.strategy]: 1 } },
        rng,
      );
      expect(out.decision, scene.name).not.toBeNull();
      state = out.state;
      const stance = out.decision!.stance;
      const move = addressOf(scene.strategy, scene.text);
      const line = groundedLine({ stance, move, text: scene.text, avoid: said, rng });
      expect(line, scene.name).toBeTruthy();
      expect(line!).not.toMatch(BANNED);
      expect(line!).not.toMatch(FLIRT);
      expect(cleanLine(line!, { maxWords: 20 })).toBe(line);
      expect(mentions(line!, scene.text), `${scene.name}: ${line}`).toBe(true);
      expect(STANCE_EMOTIONS[stance], scene.name).toContain(out.decision!.emotion);
      if (stance === 'hostile' || stance === 'intimidate' || stance === 'escalate') {
        expect(['angry', 'contempt', 'mocking']).toContain(out.decision!.emotion);
      }
      said.push(line!);
    }
    expect(new Set(said).size).toBe(said.length);
  });

  it('does not invent words for someone who stays quiet', () => {
    const rng = new Rng(4);
    let state = initialWomanState('mild');
    const opened = decideWoman(state, { event: 'begin', ctx: ctx() }, rng);
    state = opened.state;
    const quiet = decideWoman(state, { event: 'silence', ctx: ctx({ elapsed: 18, playerSpeed: 1.4 }) }, rng);
    expect(addressOf('ignore', '')).toBe('silence');
    const line = groundedLine({ stance: quiet.decision?.stance ?? 'persist', move: 'silence', text: '', rng });
    expect(line).toBeTruthy();
    expect(line!).not.toMatch(/you said|leave me alone|police/i);
    expect(contentWord('')).toBeNull();
    expect(line!).not.toMatch(BANNED);
  });

  it('reads filming and a bystander telling him to stop as different moves', () => {
    expect(addressOfBystander('document', 'I am recording this.')).toBe('film');
    expect(addressOfBystander('direct', 'Leave her alone.')).toBe('firm');
    expect(addressOfBystander('delegate', 'Can you help her?')).toBe('help');
    const rng = new Rng(8);
    const filmed = groundedLine({ stance: 'back_off', move: 'film', text: 'I am recording this.', rng });
    expect(filmed!.toLowerCase()).toMatch(/record|camera|phone|film/);
    const told = groundedLine({ stance: 'hostile', move: 'firm', text: 'Leave her alone.', rng });
    expect(told!.toLowerCase()).toMatch(/leave|alone/);
    expect(filmed).not.toBe(told);
  });

  it('stays in character across stances: no apology, and leaving does not ask for her number', () => {
    const rng = new Rng(21);
    const stances: ManStance[] = ['persist', 'follow', 'block', 'guilt', 'hostile', 'intimidate', 'back_off'];
    const apology = /\b(i am sorry|forgive me|my fault)\b/i;
    const askNumber = /\b(your number|phone number|what is your name)\b/i;
    for (const stance of stances) {
      const line = groundedLine({ stance, move: 'firm', text: 'Leave me alone.', rng });
      expect(line, stance).toBeTruthy();
      expect(line!, stance).not.toMatch(BANNED);
      expect(line!, stance).not.toMatch(apology);
      expect(line!, stance).not.toMatch(FLIRT);
      if (stance === 'back_off') expect(line!, stance).not.toMatch(askNumber);
      if (stance === 'hostile' || stance === 'intimidate') expect(line!.toLowerCase()).not.toMatch(/beautiful|smile for/);
    }
  });

  it('a firm boundary is not answered as if she had flirted, on any stance', () => {
    const rng = new Rng(21);
    const stances: ManStance[] = ['persist', 'guilt', 'hostile', 'intimidate', 'back_off', 'block'];
    for (const stance of stances) {
      const line = groundedLine({ stance, move: 'firm', text: 'Leave me alone.', rng });
      expect(line, stance).toBeTruthy();
      expect(line!).not.toMatch(FLIRT);
      expect(mentions(line!, 'Leave me alone.')).toBe(true);
    }
  });
});
