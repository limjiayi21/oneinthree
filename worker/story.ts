/**
 * The story so far, in one place: what she has told him, what he has already
 * asked, and what he wants next. The session keeps one of these per encounter
 * and every line he says is written from it, so he does not ask her name twice,
 * forgets nothing she told him, and escalates what he asks for as it goes on.
 *
 * Pure functions, no network. Kept deliberately simple (patterns, not a model):
 * it only has to catch the facts that matter for continuity.
 */

export type AskTopic = 'name' | 'where' | 'walk_with' | 'number' | 'walk_home' | 'come_with' | 'smile' | 'partner' | 'alone';

export interface StoryFacts {
  /** Her first name, if she gave it. */
  name?: string;
  /** She said she has a boyfriend, girlfriend or husband (true or not). */
  partner?: string;
  /** Where she said she is going. */
  destination?: string;
}

export interface Story {
  facts: StoryFacts;
  /** Topics he has already asked about, in the order he first asked. */
  asked: AskTopic[];
  /** Every line of the encounter, oldest first ("HIM: ...", "HER: ..."). Not truncated. */
  lines: string[];
}

export const emptyStory = (): Story => ({ facts: {}, asked: [], lines: [] });

/* ------------------------------------------------------------------ what he asked */

const ASKS: Array<[AskTopic, RegExp]> = [
  ['name', /\b(what'?s|what is|tell me|gimme|give me) (your|ya|yo) name\b|\byour name\b|\bgot a name\b/i],
  ['where', /\bwhere (you|ya|are you|r you)('re)? (headed|heading|going|goin'?|off to)\b|\bwhere (do )?you live\b|\bwhere'?s home\b|\bwhere you from\b/i],
  ['walk_with', /\b(walk|stroll) (with|beside) you\b|\bkeep you company\b|\bwalk together\b/i],
  ['number', /\b(your|ya|yo) (number|digits|phone|insta|instagram|snap)\b|\bgimme (your|ya) number\b/i],
  ['walk_home', /\bwalk you home\b|\btake you home\b|\bget you home\b|\bsee you home\b|\bwalk you to your (door|place)\b/i],
  ['come_with', /\bcome (with|hang|have|grab|get)\b|\b(grab|get|have) a drink\b|\bhang out\b|\bcome back to my\b/i],
  ['smile', /\bsmile\b/i],
  ['partner', /\b(got|have|you got) a (man|boyfriend|husband)\b|\bboyfriend\b.*\?/i],
  ['alone', /\b(by yourself|all alone|alone)\b.*\?/i],
];

export function askedIn(line: string): AskTopic[] {
  return ASKS.filter(([, rx]) => rx.test(line)).map(([t]) => t);
}

/* ------------------------------------------------------------------ what she said */

const NOT_A_NAME = new Set([
  'fine', 'good', 'okay', 'ok', 'tired', 'busy', 'late', 'going', 'heading', 'walking', 'just', 'not', 'sorry', 'here', 'married', 'leaving', 'done', 'scared', 'calling', 'serious', 'home', 'alright', 'all', 'on', 'in', 'a', 'the', 'so', 'very', 'really', 'me', 'you', 'him', 'cold', 'nice', 'nothing', 'none', 'over', 'fine', 'whatever', 'what', 'that', 'this', 'gonna', 'about',
]);

export function factsIn(text: string): StoryFacts {
  const out: StoryFacts = {};
  const t = text.trim();
  const named = /\b(?:my name(?:'s| is)|call me|it'?s)\s+([A-Za-z][a-z'-]{1,15})\b/i.exec(t) ?? /\b(?:[Ii]'?m|[Ii] am)\s+([A-Z][a-z'-]{1,15})\b/.exec(t);
  if (named && !NOT_A_NAME.has(named[1].toLowerCase())) out.name = named[1].charAt(0).toUpperCase() + named[1].slice(1).toLowerCase();
  const partner = /\b(?:my|i have a|i've got a|i got a)\s+(boyfriend|girlfriend|husband|fianc[eé]e?|partner|wife)\b/i.exec(t) ?? /\bi'?m (married|engaged)\b/i.exec(t);
  if (partner) out.partner = partner[1].toLowerCase();
  const dest = /\b(?:heading|going|walking|on my way|getting|coming)\s+(home|back home|to (?:my|a|the) [a-z' ]{2,30}|to [A-Z][a-z]+(?:'s)?(?: [a-z]+)?)/i.exec(t);
  if (dest) out.destination = dest[1].replace(/\s+/g, ' ').trim();
  return out;
}

/* ------------------------------------------------------------------ the story */

export function noteHer(story: Story, text: string): Story {
  const facts = { ...story.facts };
  const f = factsIn(text);
  if (f.name) facts.name = f.name;
  if (f.partner) facts.partner = f.partner;
  if (f.destination) facts.destination = f.destination;
  return { ...story, facts, lines: [...story.lines, `HER: ${text}`].slice(-80) };
}

export function noteHim(story: Story, text: string, label = 'HIM'): Story {
  const asked = [...story.asked];
  for (const t of askedIn(text)) if (!asked.includes(t)) asked.push(t);
  return { ...story, asked, lines: [...story.lines, `${label}: ${text}`].slice(-80) };
}

export function noteOther(story: Story, who: string, text: string): Story {
  return { ...story, lines: [...story.lines, `${who}: ${text}`].slice(-80) };
}

/**
 * What he pushes for next. Each friendly exchange he wants a little more, which
 * is how a "harmless" chat turns into pressure. The order follows the asks women
 * report (name, where she's going, walking with her, her number, walking her home).
 */
const WANTS: Array<[AskTopic, string]> = [
  ['name', 'her name'],
  ['where', 'where she is going'],
  ['walk_with', 'to walk along with her'],
  ['number', 'her number'],
  ['walk_home', 'to walk her home'],
  ['come_with', 'for her to come and have a drink with him'],
];

export function nextWant(story: Story, level: number): string {
  if (level >= 4) return 'respect: an answer, an apology, for her to stop acting like she is better than him';
  if (level === 3) return 'for her to admit he was only being nice, and to give him what he asked for';
  const answered = (t: AskTopic) => (t === 'name' && story.facts.name) || (t === 'where' && story.facts.destination);
  for (const [topic, want] of WANTS) if (!story.asked.includes(topic) && !answered(topic)) return want;
  return 'more of her time: he keeps pressing for her number or to walk her home';
}

/** The memory block given to the line writer. */
export function storyBrief(story: Story, level: number): string {
  const facts: string[] = [];
  if (story.facts.name) facts.push(`her name is ${story.facts.name} (she told him)`);
  if (story.facts.partner) facts.push(`she said she has a ${story.facts.partner}`);
  if (story.facts.destination) facts.push(`she said she is going ${story.facts.destination.startsWith('to') ? '' : 'to '}${story.facts.destination}`.replace('going to home', 'going home'));
  const asked = story.asked.length ? story.asked.map((t) => ASK_LABEL[t]).join(', ') : 'nothing yet';
  return [
    `WHAT HE KNOWS: ${facts.length ? facts.join('; ') : 'nothing about her yet'}.`,
    `HE HAS ALREADY ASKED ABOUT: ${asked}. Do not ask any of these again; build on her answers instead.`,
    `WHAT HE WANTS NOW: ${nextWant(story, level)}.`,
  ].join('\n');
}

const ASK_LABEL: Record<AskTopic, string> = {
  name: 'her name',
  where: 'where she is going',
  walk_with: 'walking with her',
  number: 'her number',
  walk_home: 'walking her home',
  come_with: 'her coming with him',
  smile: 'a smile',
  partner: 'whether she has a boyfriend',
  alone: 'whether she is alone',
};
