/**
 * A short rolling memory of the conversation. Built from the words actually
 * said, with no model call, and handed to the line writer and the live agent
 * so a later line cannot deny what was already established.
 */

export interface ConversationMemory {
  /** Last few beats, oldest first. */
  summary: string;
  facts: string[];
}

export function emptyMemory(): ConversationMemory {
  return { summary: '', facts: [] };
}

const MAX_FACTS = 8;
const MAX_BEATS = 4;

function clip(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 90 ? `${clean.slice(0, 87)}…` : clean;
}

function addFact(facts: string[], fact: string): string[] {
  if (facts.includes(fact)) return facts;
  return [...facts, fact].slice(-MAX_FACTS);
}

function factsFrom(who: 'player' | 'him', text: string): string[] {
  const t = text.toLowerCase();
  const out: string[] = [];
  const partner = t.match(/\b(boyfriend|girlfriend|husband|wife|partner)\b/);
  if (partner && who === 'player') out.push(`The player said a ${partner[1]} is in the picture.`);
  if (/\b(police|cops|911)\b/.test(t) && who === 'player') out.push('The player said they would get the police.');
  if (/\b(leave me alone|stop following|back off|go away|leave her alone)\b/.test(t) && who === 'player') out.push('The player set a firm boundary.');
  const name = text.match(/\bmy name is ([A-Za-z]{2,16})\b/i);
  if (name && who === 'player') out.push(`The player said their name is ${name[1]}.`);
  if (/\b(going home|go home)\b/.test(t) && who === 'player') out.push('The player said they are going home.');
  if (/\b(just being (?:nice|friendly)|only being (?:nice|friendly)|meant it as a compliment)\b/.test(t) && who === 'him') {
    out.push('He already said he was only being friendly.');
  }
  if (/\b(i(?:'| a)m walking this way|same way)\b/.test(t) && who === 'him') out.push('He already said he was only walking the same way.');
  return out;
}

/** Fold one spoken line into the memory. Empty text changes nothing. */
export function noteTurn(memory: ConversationMemory, who: 'player' | 'him', text: string): ConversationMemory {
  const said = clip(text);
  if (!said) return memory;
  const label = who === 'player' ? 'PLAYER' : 'HIM';
  const beats = memory.summary ? memory.summary.split('\n') : [];
  beats.push(`${label}: ${said}`);
  let facts = memory.facts;
  for (const fact of factsFrom(who, text)) facts = addFact(facts, fact);
  return { summary: beats.slice(-MAX_BEATS).join('\n'), facts };
}

/** Prompt block. Empty when nothing has been said yet. */
export function memoryBlock(memory: ConversationMemory | undefined): string {
  if (!memory || (!memory.summary && memory.facts.length === 0)) return '';
  const facts = memory.facts.length ? memory.facts.join(' ') : 'None yet.';
  return `MEMORY, do not contradict this. Summary:\n${memory.summary || '(just started)'}\nFacts: ${facts}`;
}
