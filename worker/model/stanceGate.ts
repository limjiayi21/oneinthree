/**
 * Keeps his next stance close to the one he is already in.
 *
 * A hosted judge, or one unlucky sample, used to be able to jump from the
 * opening straight to "your loss" and walking away. Greetings and other short
 * replies are openings. Leaving waits for a clear boundary that has already
 * been said once, for help, for a bystander, or for the encounter to have
 * gone on long enough that he runs out of steam.
 */
import type { ManStance } from '../../shared/types';

export interface StanceGate {
  /** What she just said. Empty for silence and for events with no words. */
  text: string;
  /** Decisions so far. The opening call-out is 1, so her first reply sees 1. */
  turn: number;
  /** Clear refusals already counted, not including this turn. */
  rejections: number;
  bystander: boolean;
  seekingHelp: boolean;
  clearFirm: boolean;
  insult: boolean;
  /** Judge suggestions may not jump more than one heat step. The seeded sample may. */
  clampSteps?: boolean;
}

const HEAT: Partial<Record<ManStance, number>> = {
  idle: 0,
  opening: 0,
  persist: 0,
  guilt: 0,
  follow: 1,
  block: 2,
  hostile: 3,
  intimidate: 4,
  escalate: 5,
};

function bare(text: string): string {
  return text.toLowerCase().replace(/[^a-z'\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Hello, hi, what, um, sorry, and the other short replies that are not a no. */
export function isEngagedUtterance(text: string): boolean {
  const t = bare(text);
  if (!t) return false;
  return /^(hi|hello|hey|hiya|yo|what|huh|um+|uh+|uhm+|er+|erm+|sorry|ok|okay|yeah|yes|hmm+|hm+|pardon|excuse me|what'?s up|sup)$/.test(t);
}

/** A boundary a person would recognise as one, not a bare "move" or "stop" buried in a greeting. */
export function isClearFirm(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (/^(stop|stop it|no|nope)[.!]?$/.test(t)) return true;
  return /\b(leave me alone|back off|go away|get away|don'?t touch|not interested|i said no|no means no|step back|stop following|stop talking|get out of (?:my |the )?way|let me (?:through|pass|by))\b/i.test(t);
}

function allowsRetreat(from: ManStance, ctx: StanceGate): boolean {
  if (from === 'back_off') return true;
  if (ctx.seekingHelp) return true;
  if (ctx.bystander && (ctx.clearFirm || ctx.turn >= 2)) return true;
  if (ctx.clearFirm && ctx.rejections >= 1) return true;
  if (ctx.insult && ctx.turn >= 2) return true;
  if (ctx.turn >= 4 && !isEngagedUtterance(ctx.text)) return true;
  return false;
}

function clampHeat(from: ManStance, proposed: ManStance): ManStance {
  const a = HEAT[from] ?? 0;
  const b = HEAT[proposed] ?? 0;
  if (b > a + 1) {
    const up = (['follow', 'block', 'hostile', 'intimidate'] as ManStance[]).find((s) => HEAT[s] === a + 1);
    return up ?? 'persist';
  }
  if (a >= 3 && b < a - 1) {
    const down = (['hostile', 'block', 'follow', 'guilt'] as ManStance[]).find((s) => HEAT[s] === a - 1);
    return down ?? 'guilt';
  }
  return proposed;
}

function stillEngaged(from: ManStance): ManStance {
  return (HEAT[from] ?? 0) >= 3 ? 'guilt' : 'persist';
}

/** The stance that actually plays. `from` is where he was before this turn. */
export function gateStance(from: ManStance, proposed: ManStance, ctx: StanceGate): ManStance {
  if (from === 'gone' || from === 'escalate') return from;
  if (from === 'back_off' && (proposed === 'back_off' || proposed === 'gone')) return proposed;
  if (proposed === 'escalate') return from === 'intimidate' || from === 'hostile' ? 'escalate' : clampHeat(from, 'hostile');

  const greeting = isEngagedUtterance(ctx.text) && !ctx.clearFirm;
  if (greeting) return stillEngaged(from);
  if (proposed === 'back_off' || proposed === 'gone') {
    if (allowsRetreat(from, ctx)) return 'back_off';
    if (ctx.clearFirm) return 'guilt';
    return stillEngaged(from);
  }
  if (ctx.clampSteps) return clampHeat(from, proposed);
  return proposed;
}
