/**
 * Shape of content/guided.json: the guided replay of Part 2.
 */

export type GuidedRating = 'best' | 'weaker' | 'backfires';

/** Who speaks a guided line. 'you' and 'self' are the player (shown as text, never voiced). 'thought' is her inner voice. */
export type GuidedSpeaker = 'you' | 'self' | 'man' | 'woman' | 'clerk' | 'thought';

export interface GuidedLine {
  speaker: GuidedSpeaker;
  text: string;
  /** Existing pre-rendered audio id (public/audio/vo/<id>.mp3). New lines have none and play as subtitles. */
  audioId?: string;
}

/** What the man's body does in a guided consequence. */
export type GuidedManAction = 'stay' | 'leave' | 'walk_alongside' | 'block_path' | 'close_in' | 'turn_on_player' | 'glare_then_leave';
/** What the woman's body does in a guided consequence. */
export type GuidedWomanAction = 'stay' | 'keep_walking' | 'hurry' | 'freeze' | 'step_back' | 'move_to_player' | 'walk_home_alone' | 'walk_with_player';

export interface GuidedChoice {
  /** Stable id, used for logging (e.g. "m1_distract"). */
  id: string;
  text: string;
  /** The 5 Ds name, or a plain label for not intervening. */
  tactic: string;
  rating: GuidedRating;
  lines: GuidedLine[];
  manAction: GuidedManAction;
  womanAction: GuidedWomanAction;
  /** One sentence, linking back to a card. */
  feedback: string;
  /** Id of a part2 card on the cards-and-replay branch. Not used here. */
  cardId?: string;
  /** Raise the player's phone for this consequence. */
  filming?: boolean;
}

export interface GuidedMoment {
  id: string;
  /** The scripted beat the scene pauses at (bystanderWalkHome.ts timeline), or "after" once he has gone. */
  beat: string;
  prompt: string;
  /** Shown over black before this moment when the previous one ended in a way the script cannot continue from. */
  lead?: string;
  choices: GuidedChoice[];
}

export interface GuidedData {
  moments: GuidedMoment[];
  /** Closing line of the guided replay's end screen. */
  closing: string;
}

