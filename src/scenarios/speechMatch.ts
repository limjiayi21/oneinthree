/**
 * Which option did she say? Matches the transcript of what the player said at a Part 2 moment to the
 * moment's spoken options, so the option picked is the one they actually said (or a paraphrase in its
 * spirit), not simply the first one. Pure, so it is unit tested.
 *
 * Score: each word they said that is in an option's line counts 1; a word typical of that kind of help
 * (its tag: Direct, Distract, Delegate, Delay...) counts KEYWORD. The best option wins if it scores at
 * least MIN and beats the next one; otherwise nothing is picked.
 */

export interface SpokenChoice {
  /** The option's index in the moment. */
  index: number;
  /** The words of the option, e.g. "Leave her alone, man." */
  line: string;
  /** The kind of help, e.g. 'Direct', 'Distract', 'Delegate', 'Delay', 'Check in'. */
  tag: string;
}

const KEYWORD = 0.6;
const MIN = 1;

const STOP = new Set(
  'a an the i me my you your he him his she her it its is am are was be to of and or for with on at in here there this that do does can could would will want just so please hey hi oh um uh ah er like well yeah yes no what'.split(' '),
);
// "like" is a stop word: "I like your shoes" says nothing about any option.

/** Words typical of each kind of help, beyond the option's own line. */
const TAG_WORDS: Record<string, string[]> = {
  direct: ['leave', 'alone', 'stop', 'back', 'off', 'enough', 'quit', 'cut', 'go', 'away', 'bothering'],
  distract: ['subway', 'train', 'station', 'way', 'directions', 'where', 'lost', 'time', 'late', 'ready', 'know'],
  delegate: ['come', 'out', 'help', 'shopkeeper', 'shop', 'store', 'sir', 'over'],
  delay: ['okay', 'ok', 'alright', 'right', 'fine', 'safe', 'walk', 'home', 'call', 'someone', 'need', 'stay'],
  'check in': ['okay', 'ok', 'alright', 'right', 'fine', 'good'],
};

export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/n't\b/g, ' not')
    .replace(/'s\b/g, ' is')
    .replace(/'m\b/g, ' am')
    .replace(/'re\b/g, ' are')
    .replace(/'ll\b/g, ' will')
    .replace(/\bim\b/g, 'i am')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w));
}

/** The index of the option they said, or -1 if what they said fits none of them clearly. */
export function matchSpoken(text: string, choices: readonly SpokenChoice[]): number {
  const said = words(text);
  if (!said.length) return -1;
  const scored = choices.map((c) => {
    const line = new Set(words(c.line));
    const typical = new Set(TAG_WORDS[c.tag.toLowerCase()] ?? []);
    let score = 0;
    for (const w of said) {
      if (line.has(w)) score += 1;
      else if (typical.has(w)) score += KEYWORD;
    }
    return { index: c.index, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const [best, next] = scored;
  if (!best || best.score < MIN) return -1;
  if (next && next.score >= best.score) return -1; // a tie: not clear which they meant
  return best.index;
}
