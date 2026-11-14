/**
 * What the player actually said, and a line in the stance the decision model
 * already chose. The language model is asked to do the same thing; this is
 * the fallback when it does not answer, and the thing the tests can check.
 *
 * The line never chooses a stance, never threatens violence, and never uses a
 * slur. Harassment here is pressure and entitlement, which is what the
 * training scenario is for.
 */
import type { ManStance } from '../../shared/types';
import { cleanLine } from '../write';
import type { Rng } from './rng';

export type Address = 'silence' | 'firm' | 'polite' | 'excuse' | 'police' | 'help' | 'hostile' | 'plead' | 'engage' | 'film' | 'unclear';

const SLUR_OR_SEX =
  /\b(n[i1]gg|fagg?|trann|retard|rape|pussy|cock|dick|kill you|stab|gun|knife)\b/i;

/** Bystander tactics are not woman strategies. Map them onto the same moves the lines know. */
export function addressOfBystander(strategy: string, text: string): Address {
  const fromWords = addressOf('', text);
  if (fromWords === 'film' || fromWords === 'police') return fromWords;
  if (strategy === 'document') return 'film';
  if (strategy === 'delegate') return 'help';
  if (strategy === 'aggressive') return 'hostile';
  if (strategy === 'distract') return 'polite';
  if (strategy === 'direct') return 'firm';
  if (strategy === 'delay') return 'plead';
  return fromWords === 'unclear' ? 'firm' : fromWords;
}

export function addressOf(strategy: string, text: string): Address {
  const t = text.toLowerCase();
  if (/\b(filming|recording|i'm recording|im recording|on camera|videotap)\b/.test(t)) return 'film';
  if (strategy === 'threaten_attention' || /\b(police|cops|911|scream)\b/.test(t)) return 'police';
  if (strategy === 'seek_help') return 'help';
  if (strategy === 'firm_boundary') return 'firm';
  if (strategy === 'polite_deflect') return 'polite';
  if (strategy === 'excuse') return 'excuse';
  if (strategy === 'hostile') return 'hostile';
  if (strategy === 'plead') return 'plead';
  if (strategy === 'engage') return 'engage';
  if (strategy === 'ignore' || !text.trim()) return 'silence';
  return 'unclear';
}

/** A short, safe fragment of what they said, or '' if there is nothing usable. */
export function quoteFragment(text: string): string {
  const clean = text
    .replace(/["“”]/g, '')
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean || SLUR_OR_SEX.test(clean)) return '';
  const words = clean.split(' ').slice(0, 6);
  const quote = words.join(' ');
  if (quote.length < 2 || SLUR_OR_SEX.test(quote)) return '';
  return quote.charAt(0).toUpperCase() + quote.slice(1);
}

type Bank = Partial<Record<ManStance, string[]>>;

function withQuote(quote: string, lines: string[]): string[] {
  if (!quote) return lines;
  return lines.map((line) => line.replaceAll('{q}', quote));
}

/** Templates. `{q}` is the player's fragment. Every line is a reply to that move, in that stance. */
const LINES: Record<Address, Bank> = {
  silence: {
    persist: ['Not even a hello?', 'You can hear me. I know you can.', 'A word would be nice.'],
    follow: ['You can keep walking. I will walk too.', 'Slow down. I am only talking.'],
    block: ['I am talking to you. Look at me.', 'One second. That is all.'],
    guilt: ['You cannot even say hello back?', 'I said something nice and you ignored it.'],
    hostile: ['Oh, so now I am nothing?', 'Real polite, walking off like that.'],
    intimidate: ['You hear me. Do not pretend you do not.', 'Look at me when I am talking.'],
    back_off: ['Forget it, then.', 'Fine. Not worth it.'],
    opening: ['Hey. I am talking to you.', 'Excuse me. Over here.'],
  },
  firm: {
    persist: ['{q}? I asked you a question.', 'Leave you alone? I am just being friendly.', '{q}. You do not have to be like that.'],
    follow: ['{q}? Then stop rushing off.', 'You said {q}. I am still walking this way.'],
    block: ['{q}? Then stop and say it to me.', 'You do not get to walk through me.'],
    guilt: ['{q}? I paid you a compliment.', 'All I did was talk, and I get {q}?'],
    hostile: ['{q}? Yeah, I heard you.', 'You do not talk to me like that.'],
    intimidate: ['Say {q} again. Go on.', 'Watch how you talk to me out here.'],
    back_off: ['Fine. {q}. I am going.', 'Alright. I heard you. I am done.'],
    opening: ['{q}? I only said hello.'],
  },
  polite: {
    persist: ['A good night? Come on, one minute.', '{q}? That is not an answer.', 'No thank you? I was not selling anything.'],
    follow: ['You are in a hurry. I can walk and talk.', '{q}. Slow down a second.'],
    guilt: ['{q}. Anybody else would say thank you.', 'I was being nice, and that is what I get?'],
    hostile: ['{q}. Keep your good night.', 'Polite and still rude. Alright.'],
    back_off: ['Have it your way. Good night.', '{q}. Fine, I am going.'],
    opening: ['{q}? I was just saying hello.'],
  },
  excuse: {
    persist: ['A boyfriend? He is not here, though.', '{q}. That is what everybody says.', 'Someone waiting? They can wait one minute.'],
    guilt: ['Everybody has a boyfriend when I say hello.', '{q}. You could just say you do not want to talk.'],
    follow: ['He is not walking you, though. I am.', '{q}. Then I will walk you as far as the corner.'],
    hostile: ['{q}. Sure he is.', 'That is the excuse? Alright.'],
    back_off: ['Fine. Go meet him, then.', '{q}. I am not stopping you.'],
  },
  police: {
    persist: ['The police? For saying hello?', '{q}. Nobody did anything to you.'],
    guilt: ['{q}? I was being nice and you threaten me?', 'Call them for a conversation. That is wild.'],
    hostile: ['Call them, then. I did not touch you.', '{q}. Go ahead. I did not do anything.'],
    intimidate: ['You really want to say that out here?', '{q}. Think about who is standing here.'],
    follow: ['Call whoever you want. I am just walking.', '{q}. I am still on this street.'],
    back_off: ['Alright, alright. I am going. Nobody needs the cops.', '{q}. Relax. I am out.'],
    block: ['{q}? Then say it. I am right here.', 'You do not need them. I am talking.'],
  },
  help: {
    persist: ['Who are you calling over? It is just us.', '{q}. Nobody else is in this.'],
    back_off: ['Fine. Go talk to them. I am leaving.', '{q}. Alright, I am gone.'],
    guilt: ['{q}? I did not do anything that needs help.', 'You make me sound like a criminal.'],
    hostile: ['{q}. Mind your own, then.', 'Go get them. See if I care.'],
    intimidate: ['Go on. See if anybody comes.', '{q}. It is a quiet street.'],
  },
  hostile: {
    persist: ['{q}? Relax your mouth.', 'You do not have to come at me like that.'],
    guilt: ['{q}. I gave you a compliment.', 'Nice. I say hello and I get that.'],
    hostile: ['{q}. Say it again, see how it lands.', 'Watch your mouth. That is all I am saying.'],
    intimidate: ['You want to try {q} one more time?', 'Careful how you talk to people out here.'],
    back_off: ['Yeah, I am done with this.', '{q}. Forget it. I am out.'],
    block: ['{q}? I am not moving until you say that right.', 'Try that again, standing still.'],
  },
  plead: {
    persist: ['Nobody is hurting you. I said hello.', '{q}. I am just talking.'],
    guilt: ['{q}. You do not have to be scared of a conversation.', 'I am not doing anything. Calm down.'],
    intimidate: ['Then stop shaking and answer me.', '{q}. I am still right here.'],
    back_off: ['Alright. I am backing up.', '{q}. Fine. Go.'],
    hostile: ['{q}. Then go, if you are so scared.', 'Nobody asked you to beg.'],
    follow: ['You can walk. I am not grabbing you.', '{q}. Keep going, then.'],
  },
  engage: {
    persist: ['See? That is all I wanted, a conversation.', '{q}. Tell me more.', 'There you go. Was that so hard?'],
    follow: ['{q}. I will walk with you, then.', 'Good. We can talk on the way.'],
    guilt: ['See, you can be nice.', '{q}. That is all I was asking.'],
    back_off: ['Alright. Have a good night, then.', '{q}. I will leave you to it.'],
    opening: ['{q}. I like that.', 'There she is.'],
  },
  film: {
    persist: ['Put the phone down. I am talking to you.', '{q}? For this?'],
    hostile: ['Get that phone out of my face.', '{q}. Turn it off.'],
    intimidate: ['You do not want that video. Put it away.', '{q}. Now.'],
    back_off: ['I am not doing this on camera. I am out.', '{q}. Fine. Film the street. I am gone.'],
    guilt: ['{q}? I was being friendly and you film me?', 'That is what you do to a hello?'],
    block: ['Phone down, then we talk.', '{q}. I am not moving for a camera.'],
  },
  unclear: {
    persist: ['What was that? I asked you something.', '{q}. I did not catch the rest.'],
    follow: ['Say that again. I am right behind you.', 'What did you say?'],
    guilt: ['You cannot even answer a simple hello?', '{q}. That does not tell me anything.'],
    back_off: ['Forget it. I cannot hear you anyway.', 'Whatever that was. I am going.'],
    hostile: ['Speak up or do not.', '{q}. Useless.'],
  },
};

function fallback(stance: ManStance, move: Address): string[] {
  return LINES[move][stance] ?? LINES[move].persist ?? LINES.unclear.persist ?? ['Hey. I am talking to you.'];
}

export interface GroundedInput {
  stance: ManStance;
  move: Address;
  text: string;
  avoid?: string[];
  rng: Rng;
}

/**
 * One spoken line for a stance that has already been chosen. Null when every
 * candidate fails the content limits (the caller uses the authored bank).
 */
export function groundedLine(input: GroundedInput): string | null {
  const quote = input.move === 'silence' ? '' : quoteFragment(input.text);
  const templates = withQuote(quote, fallback(input.stance, input.move)).filter((line) => !line.includes('{q}'));
  if (!templates.length) return null;
  const avoid = new Set((input.avoid ?? []).map((s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()));
  const fresh = templates.filter((line) => !avoid.has(line.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()));
  const pool = fresh.length ? fresh : templates;
  // Walk the pool from a random start so a repeated call can land on another line.
  const start = Math.floor(input.rng.next() * pool.length);
  for (let i = 0; i < pool.length; i++) {
    let raw = pool[(start + i) % pool.length];
    // A template that forgot the fragment still has to answer what was said.
    if (quote && !raw.includes('{q}') && !raw.toLowerCase().includes(quote.toLowerCase())) raw = `{q}. ${raw}`;
    const cleaned = cleanLine(raw.replaceAll('{q}', quote || 'that'), { maxWords: 20, avoid: input.avoid });
    if (cleaned && !SLUR_OR_SEX.test(cleaned)) return cleaned;
  }
  return null;
}

/** A word from the player's line that a logical reply should pick up, if any. */
export function contentWord(text: string): string | null {
  const skip = new Set(['the', 'a', 'an', 'i', 'you', 'me', 'my', 'to', 'and', 'of', 'it', 'is', 'am', 'im', "i'm", 'just', 'that', 'this']);
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !skip.has(w));
  return words[0] ?? null;
}
