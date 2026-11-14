/**
 * Shape of content/guided.json: the teaching replay of Part 2.
 *
 * Every moment follows the same four beats: the scene freezes, the player
 * chooses, the choice plays out, and a strip names what just happened.
 * Outcomes are fixed by the file: no microphone, no live model, no rolls.
 */

/** best and good continue; weaker and backfires play out, then rewind to the same moment. */
export type GuidedRating = 'best' | 'good' | 'weaker' | 'backfires';

export const CONTINUES: ReadonlySet<GuidedRating> = new Set<GuidedRating>(['best', 'good']);

/** The 5 Ds, as keyed in content/evidence.json (bystander.fiveDs). */
export type FiveDKey = 'distract' | 'delegate' | 'document' | 'delay' | 'direct';

/**
 * Who speaks a guided line.
 * 'you'     the player, out loud (subtitle, never voiced)
 * 'self'    the player's own inner voice (subtitle labelled "You think:", never voiced)
 * 'thought' her inner voice
 */
export type GuidedSpeaker = 'you' | 'self' | 'man' | 'woman' | 'clerk' | 'thought';

export interface GuidedLine {
  speaker: GuidedSpeaker;
  text: string;
  /** Existing pre-rendered audio id (public/audio/vo/<id>.mp3). New lines have none and play as subtitles. */
  audioId?: string;
}

/** What the man's body does in a consequence. */
export type GuidedManAction =
  | 'none'
  | 'stay'
  | 'call_out'
  | 'leave'
  | 'walk_alongside'
  | 'block_path'
  | 'close_in'
  | 'turn_on_player'
  | 'argue';

/** What the woman's body does in a consequence. */
export type GuidedWomanAction =
  | 'none'
  | 'stay'
  | 'keep_walking'
  | 'hurry'
  | 'look_around'
  | 'freeze'
  | 'step_back'
  | 'move_to_player'
  | 'walk_home_alone'
  | 'walk_with_player';

/** Where the player (the camera) goes for a consequence. */
export type GuidedPlayerMove =
  | 'stay'
  | 'follow_close'
  | 'phone'
  | 'cross'
  | 'hang_back'
  | 'watch_clerk'
  | 'to_her'
  | 'to_him'
  | 'to_shop'
  | 'film';

/** The strip at the bottom of the screen that names what just happened. */
export interface GuidedStrip {
  /** Shown as the strip's heading, e.g. "Noticing" or "Distract". */
  concept: string;
  /** Id of an entry in this file's `concepts`, credited under the strip. Omit for ideas that are ours. */
  conceptId?: string;
  /** One sentence (moment 2's best choice has two). */
  sentence: string;
  /** At most one stat, by content/evidence.json id. */
  statId?: string;
  /** Moment 2's best choice only: two stats, one short line each. Use statId everywhere else. */
  statIds?: string[];
}

export interface GuidedChoice {
  /** Stable id, used for logging (e.g. "m3_distract"). Never change one once data has been collected against it. */
  id: string;
  text: string;
  rating: GuidedRating;
  /** Which of the 5 Ds this is, if any. Ticks the recap when it is the first pick at its moment. */
  tactic?: FiveDKey;
  player: GuidedPlayerMove;
  lines: GuidedLine[];
  manAction: GuidedManAction;
  womanAction: GuidedWomanAction;
  strip: GuidedStrip;
}

export interface GuidedMoment {
  id: string;
  /** Where the scene freezes, for people editing this file. The staging is in src/scenarios/guidedWalkHome.ts. */
  freezeAt: string;
  /** Shown over black before this moment: explains why the scene starts again. */
  lead?: string;
  /** Keep a pool of light around this person while frozen. */
  spotlight?: 'woman' | 'man';
  /** What the player notices, shown above the prompt. */
  caption?: string;
  prompt?: string;
  /** The player's inner voice, shown labelled "You think:". */
  innerVoice?: string[];
  choices: GuidedChoice[];
}

/** A named idea credited on a strip. `verified` stays false until someone has checked it against the original. */
export interface GuidedConcept {
  id: string;
  name: string;
  attribution: string;
  /** Book titles as written; article titles in curly quotes. Empty when there is no single work. */
  work: string;
  year: number | null;
  url: string;
  verified: boolean;
}

export interface GuidedRecap {
  title: string;
  /** In display order. Each name and one-line definition; the long definitions stay in evidence.json. */
  fiveDs: Array<{ key: FiveDKey; name: string; line: string }>;
  stepsTitle: string;
  steps: Array<{ name: string; line: string }>;
  closing: string;
}

export interface GuidedData {
  concepts: GuidedConcept[];
  moments: GuidedMoment[];
  recap: GuidedRecap;
}

/** The stat ids a strip cites, in order. */
export function stripStatIds(strip: GuidedStrip): string[] {
  return [...(strip.statId ? [strip.statId] : []), ...(strip.statIds ?? [])];
}

/** "Bibb Latané & John Darley, The Unresponsive Bystander, 1970", leaving out empty parts. */
export function conceptCitation(concept: Pick<GuidedConcept, 'attribution' | 'work' | 'year'>): string {
  return [concept.attribution, concept.work, concept.year ?? ''].map((part) => String(part).trim()).filter(Boolean).join(', ');
}

/** The 5 Ds the player picked first at any moment. */
export function firstPickTactics(data: GuidedData, firstChoices: Record<string, string>): Set<FiveDKey> {
  const out = new Set<FiveDKey>();
  for (const m of data.moments) {
    const tactic = m.choices.find((c) => c.id === firstChoices[m.id])?.tactic;
    if (tactic) out.add(tactic);
  }
  return out;
}
