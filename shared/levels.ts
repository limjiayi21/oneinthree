/**
 * His escalation ladder levels (woman POV), shared by the decision model
 * (worker/model/ladder.ts), the line writer and the on-screen meter.
 */

export interface LevelInfo {
  level: number;
  /** Short name for the on-screen meter. */
  name: string;
  /** What he is like at this level, given to the line writer. */
  direction: string;
}

export const LEVELS: LevelInfo[] = [
  { level: 0, name: 'Calm', direction: 'calm and friendly on the surface: casual small talk, as if they were neighbours' },
  { level: 1, name: 'Interested', direction: 'interested and flirty: a compliment, asks her name or where she is going, tells her to smile' },
  { level: 2, name: 'Pushy', direction: 'pushy: ignores the hint, keeps the conversation going, "c\'mon", stays next to her' },
  { level: 3, name: 'Offended', direction: 'offended and entitled: guilt-trips her, "I\'m just being nice", calls her rude or stuck up' },
  { level: 4, name: 'Angry', direction: 'angry and insulting: raised voice, crude names, takes her answer as disrespect' },
  { level: 5, name: 'Intimidating', direction: 'intimidating: closes the distance, follows or blocks her way, low and menacing, demands an answer' },
  { level: 6, name: 'Threatening', direction: 'threatening: in her face, reaching for her' },
];
