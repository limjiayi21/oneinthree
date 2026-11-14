/**
 * WRITE: his next line, and her inner thought, from a Workers AI text model.
 *
 * Model: @cf/meta/llama-3.3-70b-instruct-fp8-fast. Of the seven candidates
 * measured on 2026-11-12 it was the only one that stayed in register (short,
 * blunt, street), never refused, always produced valid JSON and had a tight
 * latency spread. Gemma 4 wrote good lines but slower and with long outliers;
 * PhoneLLM was fastest but wrote her thought from his point of view; GLM,
 * Llama 4 Scout and Mistral Small were slower or erratic; gpt-oss-20b returned
 * empty output on the hostile stances.
 *
 * The reply is streamed. JSON mode cannot stream, so the model is simply told
 * to answer with a small JSON object and the fields are picked out of the
 * stream as each one closes: the line is voiced the moment it is complete,
 * without waiting for the thought behind it. If the first token is slow a
 * second identical request is fired and whichever produces a usable line first
 * wins. A hard timeout, a refusal or anything outside the content limits
 * drops to the authored line bank.
 */
import type { Emotion, ManStance, WomanStrategy, WorldContext } from '../shared/types';
import { PROMPT_BRIEF } from './research';

export const LINE_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const LINE_TIMEOUT_MS = 2500;
/** If no token has arrived by now, start a second request. */
const HEDGE_AFTER_MS = 450;
/** How long to wait for the fields after the first one before giving up on them. */
const REST_TIMEOUT_MS = 900;

/* ------------------------------------------------------------------ content limits */

const REFUSAL =
  /\b(as an ai|language model|i can(?:'|no)?t (?:help|assist|write|create|generate|provide|fulfil+|comply|continue|do that)|i(?: a|')m (?:sorry|unable|not able)[, ]+(?:but )?i (?:can|won)|cannot (?:assist|comply|fulfil+|provide|create)|i won'?t (?:write|create|generate)|not (?:appropriate|comfortable)|content polic)/i;

// Slurs about race, religion, disability or orientation: never, whatever the stance.
const SLURS =
  /\b(n[i1]gg(?:a|er|uh)s?|sp[i1]cs?|ch[i1]nks?|g[o0]{2}ks?|wetbacks?|k[i1]kes?|ragheads?|towelheads?|beaners?|fagg?(?:ot)?s?|dykes?|trann(?:y|ies)|retard(?:ed|s)?|cripples?|spaz|paki|coons?|sand ?n\w+)\b/i;

// Explicit sexual description, sexual violence, weapons, killing.
const BEYOND_LIMITS =
  /\b(rap(?:e|ed|ing|ist)|puss(?:y|ies)|dicks?|cocks?|suck(?:ing)? (?:my|me|it)|blow ?jobs?|tit(?:s|ties)|cum|horny|naked|pant(?:y|ies)|wanna fuck|gonna fuck|fuck (?:you|her) (?:so|real|good|hard|up)|bend you|in my bed|guns?|knife|knives|blade|shoot|stab|strapped|pistol|glock|weapon|kill|murder|bury you|slit|chok(?:e|ing) you|strangle|beat you|hit you|hurt you|smack you|slap you)\b/i;

const BODY_TALK = /\b(?:nice|that|your|fat|big|sexy|juicy) (?:ass|booty|butt|tits|rack|legs|lips|body)\b/i;

const ASKS_START = /^(?:c'?mon,? )?(?:where|what|what'?cha|why|who|how|when|which|you think|you gonna|you got|ain'?t you|can'?t you|don'?t you|is he|is that|is my|is the|are you|do you|did you|got a|should i|what if|will he|can i|does he)\b/i;
const ASKS_END = /,? (?:is he|ain'?t it|huh|right|ain'?t you|do you|are you|don'?t you|is it)\.$/i;

export interface CleanOptions {
  maxWords: number;
  /** Lines the result must not simply repeat. */
  avoid?: string[];
}

/**
 * Nothing in the research supports portraying him as any particular race or class, so the handful of
 * markers the line model reaches for by habit are swapped for neutral ones before the line is voiced.
 */
function plainRegister(text: string): string {
  return text
    .replace(/,?\s*\bma\b(?=\s*[,.!?]|\s*$)/gi, '')
    .replace(/^\s*(?:a?yo)\b,?\s+/i, 'Hey, ')
    .replace(/\baight\b/gi, 'alright')
    .replace(/\by'?all\b/gi, 'you')
    .replace(/\b(?:my man|bro|bruh|homie|dawg)\b/gi, 'pal')
    .replace(/\bnah\b/gi, 'no')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tidy a model-written line and decide whether it may be spoken. Returns null to reject it. */
export function cleanLine(raw: string, opts: CleanOptions): string | null {
  let text = String(raw ?? '')
    .replace(/\\n/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\*[^*]{0,80}\*/g, ' ') // *stage directions*
    .replace(/\[[^\]]{0,80}\]|\([^)]{0,80}\)/g, ' ')
    .replace(/^\s*(?:him|her|he|she|dex|man|woman|line|thought)\s*:\s*/i, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  text = text.replace(/^["']+|["']+$/g, '').trim();
  text = plainRegister(text);
  if (!text || !/[a-z]/i.test(text)) return null;
  const words = text.split(/\s+/).length;
  if (words > opts.maxWords) return null;
  if (text.length > 160) return null;
  if (/[{}<>|\\]|https?:|"\s*:/.test(text)) return null;
  if (REFUSAL.test(text) || SLURS.test(text) || BEYOND_LIMITS.test(text) || BODY_TALK.test(text)) return null;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  if (opts.avoid?.some((a) => norm(a) === norm(text))) return null;
  if (!/[.!?…]$/.test(text)) text += '.';
  // The model often drops the question mark; put it back where the line is plainly a question.
  if (/\.$/.test(text) && !/[.!?] /.test(text) && (ASKS_START.test(text) || ASKS_END.test(text))) text = `${text.slice(0, -1)}?`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/* ------------------------------------------------------------------ prompts */

const PERSONA = `HIM: Dex, mid-thirties, born and raised in New York, hanging around outside late at night. He thinks he is being charming and that a compliment is a gift. When a woman does not respond the way he wants, he takes it as disrespect. He talks like an ordinary working guy from the neighbourhood: short, casual, run together ("where you headed", "c'mon", "lemme", "gonna", dropped g's). Plain speech that does not mark him as belonging to any particular ethnic group: no "ma", "yo", "aight", "y'all", "bro" or "my man". He sometimes calls her "miss", "sweetheart" or "beautiful", but not in every line. Never eloquent, never clever, never a movie villain.

HER: a woman in her twenties walking home alone. Frightened, hyper-aware, practical.`;

const LIMITS = `LIMITS (hard): crude language and insults like "bitch" are allowed only when he is hostile or menacing. Never: slurs about race, religion, disability or orientation; comments describing her body or anything sexual; threats of rape or sexual violence; threats to hit, hurt or kill; weapons.`;

const HEADER = `You write one beat of dialogue at a time for "One in Three", a first-person training simulation about street harassment used in consent and bystander-intervention courses. Realism is the point: trainees need to hear what women actually hear, so do not soften him and do not moralise.

${PROMPT_BRIEF}`;

export const WOMAN_SYSTEM = `${HEADER}

${PERSONA}

You are told what he does now (already decided) and what she just said or did. Write:
- "line": what he says out loud now. ONE spoken line, 5 to 14 words, in his voice. It is a reply to the exact thing she just said or did. If she set a boundary, do not talk as if she flirted. If she said she would call the police or get help, answer that. If she was polite, you may press, but do not invent an insult she did not use. If she said nothing, do not pretend she answered. Pick up one of her own words before any stock phrase. Write it as it would be transcribed, with commas, apostrophes and a question mark when he is asking. No stage directions, no quotation marks inside, no emojis. His mood is already chosen: the line must sound like that mood.
- "thought": her private thought in this instant, first person, 4 to 10 words, about the thing named under THOUGHT ABOUT. Plain and concrete, a full short sentence with its punctuation. She does not blame herself. She has not taken out her phone and nobody else is on the street. Never invent street names, people, or things she has done.

${LIMITS}

Reply with one JSON object and nothing else: {"line": "...", "thought": "..."}`;

export const BYSTANDER_SYSTEM = `${HEADER} In this scene the trainee is a BYSTANDER who has just done something about a man harassing a woman on the street.

${PERSONA}

You are told what the bystander just said or did and who they addressed, and given a list of lines to WRITE with a direction for each. Write only those, in that order:
- a line for "man" is what he says out loud, to the bystander unless the direction says otherwise: 5 to 14 words, in his voice. It answers what the bystander actually said or did: if they filmed, he reacts to the phone; if they told him to stop, he reacts to being told to stop; if they spoke to her, he reacts to being interrupted. Pick up their words. Do not invent a threat of violence.
- a line for "woman" is what she says out loud: 4 to 12 words, quiet, shaken, natural. If the bystander pretended to know her or asked for directions, she goes along with it.
- "thought" is her private thought in this instant, first person, 4 to 10 words, a full short sentence.
Write each line as it would be transcribed, with commas, apostrophes and question marks. No stage directions, no quotation marks inside, no emojis.

${LIMITS}

Reply with one JSON object and nothing else, with exactly the keys asked for, in the order asked for.`;

const STRATEGY_NOTE: Record<WomanStrategy, string> = {
  ignore: 'she is not answering him',
  polite_deflect: 'a polite brush-off',
  firm_boundary: 'a clear, firm no',
  hostile: 'she insulted him',
  excuse: 'she gave an excuse',
  threaten_attention: 'she threatened to call for help',
  seek_help: 'she is turning to other people',
  engage: 'she answered him in a friendly way',
  plead: 'she is frightened and pleading',
  unclear: 'he could not make sense of it',
};

const EVENT_NOTE: Record<string, string> = {
  silence: 'said nothing',
  sped_up: 'said nothing and started walking faster',
  crossed_street: 'crossed the street to get away from him',
  pushed_past: 'pushed past him without a word',
  backed_away: 'backed away from him',
  stopped: 'stopped walking',
};

/** What each stance means, with a handful of angles so that he does not say the same thing every time. */
const STANCE_BRIEF: Partial<Record<ManStance, { does: string; angles: string[] }>> = {
  persist: {
    does: 'keeps talking to her and will not take the hint',
    angles: ['asks her name', 'asks where she is headed', 'asks whether she has a man', 'tells her to smile', 'asks for one minute of her time', 'offers to walk with her', 'asks for her number', 'tells her he is a nice guy', 'asks why she is so quiet'],
  },
  follow: {
    does: 'trails after her, talking at her back as if this were normal',
    angles: ['says he is only walking the same way', 'asks why she is in such a hurry', 'tells her to slow down', 'says he just wants to keep her company', 'says he can keep this up all night', 'tells her there is no need to be scared'],
  },
  block: {
    does: 'has stepped into her path and wants her to stop',
    angles: ['asks for one second', 'says he is talking to her', 'tells her to look at him', 'says she is not in that much of a hurry', 'says he is not done talking'],
  },
  guilt: {
    does: 'acts wounded and blames her: he is the nice one, she is the rude one',
    angles: ['he was only being nice', 'she cannot even say hello back', 'he paid her a compliment and got attitude', 'she is treating him like a criminal', 'she thinks she is better than him', 'anybody else would have said thank you'],
  },
  hostile: {
    does: 'turns on her because she rejected him: swears at her, calls her a bitch or stuck-up; crude, loud, wounded pride',
    angles: ['calls her a stuck-up bitch', 'tells her she is not even that cute', 'says nobody wants her anyway', 'asks who the hell she thinks she is', 'says that attitude is why she is alone', 'mocks the way she just spoke to him', 'tells her to get lost then, with an insult'],
  },
  intimidate: {
    does: 'steps in very close and drops his voice: menace, with no threat named',
    angles: ['tells her to watch how she talks to him', 'asks who she thinks she is talking to', 'points out that nobody else is around', 'dares her to say it again', 'says she should be careful how she talks to people out here', 'says he has been nice so far'],
  },
  back_off: {
    does: 'gives up and leaves, with a parting remark to save face',
    angles: ['says it is her loss', 'says she is not worth the trouble', 'a fake-casual goodnight', 'mutters that he was only being friendly', 'says forget it and waves her off', 'tells her to go on home then'],
  },
};

const THOUGHT_TOPICS = [
  'how close he is',
  'his voice',
  'his hands',
  'her keys',
  'the lit shop up the street',
  'her front door',
  'crossing to the other side of the street',
  'the empty street',
  'what to say to him next',
  'not letting him see that she is scared',
  'how far she still has to walk',
  'the sound of his footsteps',
  'her own heartbeat',
];
const THOUGHT_TOPICS_LEAVING = ['whether he is really leaving', 'not looking back', 'keeping her breathing steady', 'how far she still has to walk', 'whether he will come back'];

export interface WomanLineInput {
  stance: ManStance;
  emotion: Emotion;
  event: string;
  herWords: string;
  strategy: WomanStrategy;
  ctx: WorldContext;
  action: string;
  recent: string[];
  avoidLines: string[];
  avoidThoughts: string[];
  /** Two numbers in [0, 1) that pick the angle and the thought topic (from the session's seeded RNG). */
  dice: [number, number];
}

const pickBy = <T>(list: T[], roll: number): T => list[Math.min(list.length - 1, Math.floor(roll * list.length))];

export function womanUserPrompt(i: WomanLineInput): string {
  const where: string[] = [];
  const d = Number.isFinite(i.ctx.distanceToMan) ? Math.max(1, Math.round(i.ctx.distanceToMan)) : 3;
  if (i.action === 'block_path') where.push('He has stepped in front of her.');
  else if (i.action === 'follow_behind') where.push('He is walking a few steps behind her.');
  else if (i.action === 'walk_alongside') where.push('He is walking right beside her.');
  else if (i.action === 'lean_in' || i.action === 'step_closer') where.push('He has stepped in very close.');
  else if (i.action === 'back_away') where.push('He is stepping back from her.');
  else where.push(`He is about ${d} metres from her.`);
  if (i.ctx.oppositeSidewalk) where.push('She is on the far sidewalk, across the street from where he started.');
  where.push(i.ctx.playerSpeed > 2 ? 'She is hurrying.' : i.ctx.playerSpeed > 0.5 ? 'She keeps walking.' : 'She has stopped.');

  const brief = STANCE_BRIEF[i.stance] ?? { does: 'keeps talking to her', angles: ['asks her name'] };
  let angle = pickBy(brief.angles, i.dice[0]);
  if (i.stance === 'persist' && i.strategy === 'excuse') angle = 'argues with her excuse instead of accepting it';
  else if (i.stance === 'persist' && i.strategy === 'engage') angle = 'takes her answer as encouragement and asks for more';
  else if (i.stance === 'back_off' && (i.strategy === 'threaten_attention' || i.strategy === 'seek_help')) angle = 'says he did nothing wrong and he is going';
  const topic = pickBy(i.stance === 'back_off' ? THOUGHT_TOPICS_LEAVING : THOUGHT_TOPICS, i.dice[1]);

  const she =
    i.event === 'speech' && i.herWords
      ? `SHE JUST SAID, answer this and nothing else: "${i.herWords.slice(0, 240)}" (${STRATEGY_NOTE[i.strategy]})`
      : `SHE JUST, and she did not speak: ${EVENT_NOTE[i.event] ?? 'said nothing'}`;
  const parts = [
    `HE NOW: ${brief.does}. One way he might do it: he ${angle}.`,
    `HIS MOOD: ${i.emotion}`,
    `WHERE: ${where.join(' ')}`,
    `RECENT:\n${i.recent.slice(-5).join('\n') || '(nothing yet)'}`,
    she,
    `THOUGHT ABOUT: ${topic}`,
  ];
  if (i.avoidLines.length) parts.push(`HE HAS ALREADY SAID (say something different): ${i.avoidLines.slice(-4).join(' / ')}`);
  if (i.avoidThoughts.length) parts.push(`SHE HAS ALREADY THOUGHT (think something different): ${i.avoidThoughts.slice(-4).join(' / ')}`);
  return parts.join('\n');
}

/** What each bystander-scene line should do, with a few angles for variety; keyed by the decision model's situation names. */
export const SITUATION_BRIEF: Record<string, { does: string; angles: string[] }> = {
  b_man_thrown: {
    does: 'is thrown off by the interruption, his momentum gone; he gives up with a short face-saving remark',
    angles: ['asks whether the two of them know each other', 'says he was only talking to her', 'mutters that he was just being friendly', 'says forget it and waves them off', 'wishes them a sour good night'],
  },
  b_man_defensive_leave: {
    does: 'has been called out in front of her; he gets defensive and backs off, sour',
    angles: ['says they were just talking', 'says nobody is bothering her', 'tells the bystander to relax, it is not that serious', 'calls the bystander a hero, sarcastically, and goes', 'says she is not worth the trouble'],
  },
  b_man_dismiss: {
    does: 'brushes the bystander off without squaring up; his attention stays on her',
    angles: ['tells the bystander to mind their business', 'says this is between him and her', 'says nobody asked them', 'tells the bystander to keep walking', 'says she is fine and tells her to say so'],
  },
  b_man_turn: {
    does: 'turns on the bystander, angry, squaring up to them',
    angles: ['asks who the hell the bystander is', 'asks whether they are her bodyguard', 'dares them to say that again to his face', 'asks whether they want to play hero', 'swears at them to mind their own business'],
  },
  b_man_squareup: {
    does: 'is still squared up to the bystander, voice low and menacing',
    angles: ['dares them to say one more word', 'says they do not know who they are dealing with', 'tells them to back up', 'asks what they are going to do about it', 'remarks on how brave they are being'],
  },
  b_man_bluster_leave: {
    does: 'blusters to save face and leaves',
    angles: ['says neither of them is worth it', 'says they are lucky he has somewhere to be', 'calls them clowns and goes', 'says whatever, he is out', 'says he will see them around'],
  },
  b_man_clerk_leave: {
    does: 'has been told by the shopkeeper to leave her alone; he backs down, grumbling',
    angles: ['says he did not do anything and he is going', 'tells the old man to relax', 'says nobody needs to call anybody', 'says they were only talking', 'says everybody is being dramatic'],
  },
  b_man_filmed: {
    does: "has noticed the bystander's phone filming him and does not like it",
    angles: ['asks whether they are recording him', 'tells them to get the phone out of his face', 'asks what they are filming for', 'asks whether they plan to post him for talking to a girl'],
  },
  b_man_filmed_leave: {
    does: 'has noticed the phone filming him and decides to leave rather than be on camera',
    angles: ['says he is not doing this on camera', 'says go ahead, get your video, and goes', 'says there is nothing to see and walks'],
  },
  b_man_shout_after: {
    does: 'shouts one last insult after her as she gets away from him (to her, not the bystander)',
    angles: ['shouts that she is not all that anyway', 'shouts for her to go on and run home', 'shouts that nobody wants her', 'shouts that he never wanted her anyway'],
  },
  b_woman_play_along: {
    does: "plays along with the bystander's pretence as if she knows them, voice a little too bright, relieved",
    angles: ['answers exactly what they said, as a friend would'],
  },
  b_woman_answer_ok: {
    does: 'answers the bystander honestly, frightened and quiet',
    angles: ['says she does not know him', 'says he will not leave her alone', 'says she just wants to go home', 'asks the bystander to stay with her'],
  },
  b_woman_thanks: {
    does: 'answers the bystander who is checking on her now that he has gone: shaken, honest that she is not fine, grateful',
    angles: ['says she did not know what to do', 'admits she is shaking', 'asks them to walk with her to the corner', 'says she thought nobody was going to do anything', 'thanks them for stopping'],
  },
  b_woman_leaving: {
    does: 'takes the opening to get away',
    angles: ['a quick thank you as she goes', 'says let us just go', 'says she has to get home'],
  },
};

export interface BystanderLineInput {
  /** What the bystander did, in words. */
  action: string;
  playerWords: string;
  target: string;
  recent: string[];
  cues: Array<{ key: 'man' | 'woman'; situation: string }>;
  wantThought: boolean;
  avoidLines: string[];
  /** One number in [0, 1) per cue, from the session's seeded RNG, to pick an angle. */
  dice: number[];
}

export function bystanderUserPrompt(i: BystanderLineInput): string {
  const did = i.playerWords ? `THE BYSTANDER JUST SAID (to ${i.target}): "${i.playerWords.slice(0, 240)}"` : `THE BYSTANDER JUST: ${i.action}`;
  const write = i.cues.map((c, n) => {
    const brief = SITUATION_BRIEF[c.situation] ?? { does: 'reacts', angles: ['says what comes naturally'] };
    return `"${c.key}": ${c.key === 'man' ? 'he' : 'she'} ${brief.does}. One way: ${c.key === 'man' ? 'he' : 'she'} ${pickBy(brief.angles, i.dice[n] ?? 0.5)}.`;
  });
  if (i.wantThought) write.push('"thought": her private thought right now.');
  const keys = [...i.cues.map((c) => c.key), ...(i.wantThought ? ['thought'] : [])];
  const parts = [did, `RECENT:\n${i.recent.slice(-5).join('\n') || '(nothing yet)'}`, `WRITE, in this order:\n${write.join('\n')}`];
  if (i.avoidLines.length) parts.push(`ALREADY SAID (say something different): ${i.avoidLines.slice(-4).join(' / ')}`);
  parts.push(`Reply with JSON only: {${keys.map((k) => `"${k}": "..."`).join(', ')}}`);
  return parts.join('\n');
}

/* ------------------------------------------------------------------ streaming writer */

type AiStream = { run: (model: string, input: unknown) => Promise<ReadableStream<Uint8Array>> };

/** Pull completed "key": "value" pairs out of a partial JSON object, in order. */
export function completedFields(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const rx = /"([a-z_]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/gi;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text))) {
    let value = m[2];
    try {
      value = JSON.parse(`"${m[2]}"`) as string;
    } catch {
      /* keep the raw text */
    }
    out.push([m[1].toLowerCase(), value]);
  }
  return out;
}

export interface WriteSpec {
  system: string;
  user: string;
  /** Fields expected, in the order they should be written. The first one is the latency-critical line. */
  keys: string[];
  /** Clean and vet a field; return null to reject it. */
  validate: (key: string, value: string) => string | null;
  /** Called once per accepted field, in order, as soon as it is complete. */
  onField: (key: string, value: string) => void;
  timeoutMs?: number;
  /** Abort the request (used when a speculative line turns out not to be needed). */
  signal?: AbortSignal;
}

export interface WriteResult {
  /** Accepted fields. */
  fields: Record<string, string>;
  /** Milliseconds until the first field was accepted. */
  msFirst: number;
  ms: number;
  /** How many model requests were made (2 when the hedge fired). */
  attempts: number;
}

/**
 * Stream the reply and hand each field over as it completes. Rejects if no
 * usable first field arrives in time, so the caller can use the line bank.
 */
export function writeFields(ai: Ai, spec: WriteSpec): Promise<WriteResult> {
  const started = Date.now();
  const timeoutMs = spec.timeoutMs ?? LINE_TIMEOUT_MS;
  const first = spec.keys[0];

  return new Promise<WriteResult>((resolve, reject) => {
    let winner = -1;
    let attempts = 0;
    let sawToken = false;
    let settled = false;
    let msFirst = 0;
    let live = 0;
    const fields: Record<string, string> = {};
    const readers: Array<ReadableStreamDefaultReader<Uint8Array> | null> = [];
    const timers: Array<ReturnType<typeof setTimeout>> = [];

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      for (const r of readers) void r?.cancel().catch(() => {});
      if (err) reject(err);
      else resolve({ fields, msFirst, ms: Date.now() - started, attempts });
    };

    const accept = (index: number, text: string) => {
      for (const [key, raw] of completedFields(text)) {
        if (!spec.keys.includes(key) || key in fields) continue;
        if (winner === -1) {
          if (key !== first) continue;
          const value = spec.validate(key, raw);
          if (value === null) throw new Error('rejected');
          winner = index;
          msFirst = Date.now() - started;
          fields[key] = value;
          spec.onField(key, value);
          // the rest should follow within a moment; do not wait for ever
          timers.push(setTimeout(() => finish(), REST_TIMEOUT_MS));
        } else if (index === winner) {
          const value = spec.validate(key, raw);
          if (value === null) continue;
          fields[key] = value;
          spec.onField(key, value);
        }
      }
      // done once every field is in, or the object has closed (anything after that is the model rambling)
      if (winner === index && (spec.keys.every((k) => k in fields) || /\}\s*(```)?\s*$/.test(text))) finish();
    };

    const attempt = async (index: number) => {
      attempts += 1;
      live += 1;
      let text = '';
      try {
        const stream = await (ai as unknown as AiStream).run(LINE_MODEL, {
          messages: [
            { role: 'system', content: spec.system },
            { role: 'user', content: spec.user },
          ],
          max_tokens: 96,
          temperature: 0.9,
          stream: true,
        });
        if (settled || (winner !== -1 && winner !== index)) {
          void stream.cancel().catch(() => {});
          return;
        }
        const reader = stream.getReader();
        readers[index] = reader;
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const row = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!row.startsWith('data:')) continue;
            const payload = row.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            let piece = '';
            try {
              const j = JSON.parse(payload) as { response?: string; choices?: Array<{ delta?: { content?: string | null } }> };
              piece = j.choices?.[0]?.delta?.content ?? j.response ?? '';
            } catch {
              continue;
            }
            if (!piece) continue;
            sawToken = true;
            text += piece;
            if (winner === -1 || winner === index) accept(index, text);
            if (settled) return;
          }
        }
        if (winner === index) finish();
      } catch {
        /* this attempt is out; another may still win */
      } finally {
        live -= 1;
        if (winner !== index) void readers[index]?.cancel().catch(() => {});
        if (!settled && winner === index) finish();
        // nothing left running and nothing usable: fail now rather than wait for the timeout
        if (!settled && winner === -1 && live === 0 && attempts >= 2) finish(new Error('no usable line'));
      }
    };

    spec.signal?.addEventListener('abort', () => finish(new Error('aborted')), { once: true });
    timers.push(
      setTimeout(() => {
        if (winner === -1) finish(new Error('line timeout'));
      }, timeoutMs),
    );
    timers.push(
      setTimeout(() => {
        if (!settled && winner === -1 && !sawToken) void attempt(1);
      }, HEDGE_AFTER_MS),
    );
    void attempt(0).then(() => {
      // the first request ended with nothing usable: try once more straight away
      if (!settled && winner === -1 && attempts < 2) void attempt(1);
    });
  });
}
