/**
 * READ: turn what the player said into typed, probabilistic readings with
 * Cloudflare's Clef decision model, in ONE request per turn:
 *
 *   - how she responded (distribution over WomanStrategy), or which of the
 *     5 Ds the bystander used and who they were talking to;
 *   - extra typed questions the decision model uses (tone, insult, police,
 *     threat);
 *   - Clef's own view of his most likely immediate reaction, which the
 *     decision model blends, modestly, with the evidence-based prior.
 *
 * If the AI binding fails or is slow, a keyword heuristic answers instead and
 * the turn says so.
 */
import type { BystanderStrategy, ManStance, SpeechTarget, WomanStrategy, WorldContext } from '../shared/types';
import type { InterventionResult } from './model/bystander';
import { BYSTANDER_STRATEGIES } from './model/bystander';
import { REACTION_STANCES, WOMAN_STRATEGIES } from './model/woman';

/**
 * Two Clef models answer every read, in parallel. Measured on 41 labelled
 * test utterances (2026-11-12): plain clef read 40 correctly and named the
 * right addressee every time; clef-flash read 37 and missed three addressees,
 * but answered in about 120 ms against 260 ms (p90 about 210 ms against 400
 * to 600 ms). So clef is used when it answers inside its budget, and
 * clef-flash, which has nearly always finished by then, when it does not.
 */
export const CLEF_PRIMARY = { id: '@cf/cloudflare/clef', selector: 'clef' } as const;
export const CLEF_FAST = { id: '@cf/cloudflare/clef-flash', selector: 'clef-flash' } as const;
/** How long the turn waits for the larger model before taking the fast one's answer. */
export const CLEF_PRIMARY_BUDGET_MS = 420;
export const READ_TIMEOUT_MS = 1800;

/**
 * Clef's answer to "what will he do next?" leans the same way whatever she
 * says (it favours guilt-tripping; for bystanders, him turning on them). These
 * are its average answers over the test utterances; dividing them out leaves
 * only what her actual words changed, which is all the blend should use.
 */
const WOMAN_REACTION_BASELINE: Record<string, Record<string, number>> = {
  clef: { back_off: 0.028, persist: 0.177, guilt: 0.366, follow: 0.046, block: 0.167, hostile: 0.136, intimidate: 0.08 },
  'clef-flash': { back_off: 0.081, persist: 0.191, guilt: 0.375, follow: 0.091, block: 0.089, hostile: 0.112, intimidate: 0.061 },
};
const BYSTANDER_REACTION_BASELINE: Record<string, Record<string, number>> = {
  clef: { stops: 0.085, turns: 0.532, continues: 0.384 },
  'clef-flash': { stops: 0.131, turns: 0.509, continues: 0.36 },
};

function relativeToBaseline<K extends string>(probs: Record<K, number> | null, baseline: Record<string, number> | undefined): Record<K, number> | undefined {
  if (!probs) return undefined;
  if (!baseline) return probs;
  const out = {} as Record<K, number>;
  let total = 0;
  for (const k of Object.keys(probs) as K[]) {
    out[k] = probs[k] / Math.max(0.01, baseline[k] ?? 1 / Object.keys(probs).length);
    total += out[k];
  }
  for (const k of Object.keys(out) as K[]) out[k] = total > 0 ? out[k] / total : 0;
  return out;
}

type Question =
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'noul'; instructions: string }
  | { type: 'score'; instructions: string; criteria: string[] };

export interface ClefRequest {
  /** Filled in per model when the request is sent. */
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, Question>;
}

interface ClefAnswers {
  [id: string]:
    | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
    | { type: 'noul'; noul: number }
    | { type: 'score'; score: number; probabilities: Record<string, number>; confidence: number };
}

const WOMAN_CRITERIA: Record<WomanStrategy, string> = {
  ignore: 'No real words to him: only a sigh, a mutter or a filler sound such as "um" or "ugh"',
  polite_deflect: 'Politely declines or brushes him off, for example "no thanks", "I\'m good", "have a good night", "sorry, I\'m in a hurry"',
  firm_boundary: 'Tells him clearly and firmly to stop or leave her alone, without insulting him, for example "leave me alone", "stop following me", "I said no"',
  hostile: 'Insults him, swears at him or attacks him personally, for example calling him a creep, a loser or disgusting',
  excuse: 'Gives a reason or excuse instead of a refusal: a boyfriend or husband, being on the phone, someone waiting for her',
  threaten_attention: 'Threatens consequences or draws attention: says she will call the police, shouts for help, says she will scream or that people are watching',
  seek_help: 'Speaks to somebody other than the man, such as a passer-by or shopkeeper ("excuse me, sir, can you help me?"), or announces that she is going to other people or into a shop or store',
  engage: 'Answers him or makes conversation in a friendly or neutral way: says hi, gives her name, says where she is going or coming from, thanks him for the compliment, laughs along',
  plead: 'Frightened and begging, for example "please just let me go", "please don\'t hurt me"',
  unclear: 'Real words that have nothing to do with him or the situation, or that cannot be understood',
};

const REACTION_CRITERIA: Record<string, string> = {
  back_off: 'Gives up and walks away, perhaps with a sour parting remark',
  persist: 'Keeps talking to her and tries again: another question, another compliment',
  guilt: 'Acts wounded and blames her: says he is just being nice and she is being rude',
  follow: 'Says little and trails after her',
  block: 'Steps into her path so she has to stop',
  hostile: 'Loses his temper and insults her',
  intimidate: 'Steps in close and gets quiet and threatening',
};

const BYSTANDER_CRITERIA: Record<BystanderStrategy, string> = {
  direct: 'Addresses the harassment head-on but calmly: tells the man to stop or leave her alone, says she is not interested, or asks the woman in front of him whether she is okay or whether he is bothering her',
  distract: 'Interrupts without mentioning the harassment: greets the woman as if they know each other, or asks either of them for directions, the time, or anything unrelated',
  delegate: 'Asks someone else to step in: the shopkeeper, another person, or says they are getting help',
  delay: 'Checks on the woman after the man has gone: asks if she is okay, offers to walk with her',
  document: 'Says they are filming or recording what is happening',
  none: 'Talking to themselves or saying something that is not an attempt to do anything about it',
  aggressive: 'Threatens, insults or swears at the man, or challenges him to a fight',
  unclear: 'Unintelligible or cut off',
};

const TARGET_CRITERIA: Record<SpeechTarget, string> = {
  man: 'The man doing the harassing',
  woman: 'The woman being harassed',
  clerk: 'The shopkeeper',
  nobody: 'Nobody in particular, or themselves',
};

const BYSTANDER_REACTION: Record<InterventionResult, string> = {
  stops: 'Backs off and lets it go, perhaps with a remark to save face',
  turns: 'Turns on the bystander: squares up, swears at them, tells them to mind their business with real menace',
  continues: 'Brushes the bystander off and keeps his attention on the woman',
};

const STANCE_NOW: Partial<Record<ManStance, string>> = {
  opening: 'has just called out to her',
  persist: 'is talking at her and will not take the hint',
  follow: 'is trailing after her',
  block: 'has stepped into her path',
  guilt: 'is acting hurt and telling her she is rude',
  hostile: 'has turned to insults',
  intimidate: 'is standing very close, quiet and threatening',
  back_off: 'had started to walk away',
};

function physicalNote(ctx: WorldContext): string {
  const parts: string[] = [];
  if (ctx.oppositeSidewalk) parts.push('She has crossed to the other side of the street.');
  if (ctx.manBlocking) parts.push('He is standing in her path.');
  if (ctx.playerSpeed > 2) parts.push('She is hurrying.');
  else if (ctx.playerSpeed > 0.5) parts.push('She keeps walking.');
  else parts.push('She has stopped.');
  if (Number.isFinite(ctx.distanceToMan) && ctx.distanceToMan < 50) parts.push(`He is about ${Math.max(1, Math.round(ctx.distanceToMan))} metres from her.`);
  if (ctx.facingMan) parts.push('She is looking at him.');
  return parts.join(' ');
}

export interface WomanReadInput {
  text: string;
  ctx: WorldContext;
  stance: ManStance;
  /** Last few lines, oldest first, e.g. "HIM: Where you headed?" */
  recent: string[];
}

export function buildWomanRead(input: WomanReadInput): ClefRequest {
  return {
    model: CLEF_PRIMARY.selector,
    state: {
      scene: 'Late at night on a quiet New York street. A woman in her twenties is walking home alone. A man in his thirties whom she does not know called out to her and will not leave her alone.',
      him: `He thinks he is being charming and takes rejection as disrespect. Right now he ${STANCE_NOW[input.stance] ?? 'is beside her'}.`,
      physical: physicalNote(input.ctx),
      recent_lines: input.recent.slice(-4),
      her_words: input.text,
    },
    questions: {
      strategy: {
        type: 'choice',
        instructions: 'Which option best describes how the woman just responded to the man, judging by her_words?',
        criteria: WOMAN_CRITERIA,
      },
      tone: {
        type: 'score',
        instructions: 'How hostile toward him is the tone of her_words?',
        criteria: ['Warm or friendly', 'Neutral or polite', 'Cold and firm', 'Angry', 'Openly insulting or contemptuous'],
      },
      insult: { type: 'noul', instructions: 'Does she insult him personally in her_words, for example calling him creepy, a loser, disgusting, or swearing at him?' },
      police: { type: 'noul', instructions: 'Does she mention the police, calling someone, screaming, cameras or people watching?' },
      reaction: {
        type: 'choice',
        instructions: 'Given the kind of man he is and exactly what she just said, what is his most likely immediate reaction?',
        criteria: REACTION_CRITERIA,
      },
    },
  };
}

export interface WomanRead {
  strategy: WomanStrategy;
  confidence: number;
  strategyProbs: Record<WomanStrategy, number>;
  signals: { tone: number; insult: number; police: number };
  reaction?: Partial<Record<ManStance, number>>;
  source: 'clef' | 'heuristic';
}

const clamp01 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

function pickProbs<K extends string>(keys: readonly K[], answer: ClefAnswers[string] | undefined): Record<K, number> | null {
  if (!answer || answer.type !== 'choice' || !answer.probabilities) return null;
  const out = {} as Record<K, number>;
  let total = 0;
  for (const k of keys) {
    out[k] = clamp01(answer.probabilities[k]);
    total += out[k];
  }
  if (total <= 0) return null;
  for (const k of keys) out[k] = out[k] / total;
  return out;
}

function top<K extends string>(probs: Record<K, number>): [K, number] {
  let best = Object.keys(probs)[0] as K;
  for (const k of Object.keys(probs) as K[]) if (probs[k] > probs[best]) best = k;
  return [best, probs[best]];
}

export function parseWomanRead(answers: ClefAnswers, selector: string = CLEF_PRIMARY.selector): WomanRead | null {
  const strategyProbs = pickProbs(WOMAN_STRATEGIES, answers.strategy);
  if (!strategyProbs) return null;
  const police = answers.police?.type === 'noul' ? clamp01(answers.police.noul) : 0;
  const insult = answers.insult?.type === 'noul' ? clamp01(answers.insult.noul) : 0;
  const tone = answers.tone?.type === 'score' ? clamp01(answers.tone.score / 4) : 0.25;
  const [strategy, p] = top(strategyProbs);
  const reaction = relativeToBaseline(pickProbs(REACTION_STANCES as readonly ManStance[], answers.reaction), WOMAN_REACTION_BASELINE[selector]);
  return { strategy, confidence: p, strategyProbs, signals: { tone, insult, police }, reaction, source: 'clef' };
}

export interface BystanderReadInput {
  text: string;
  ctx: WorldContext;
  manPresent: boolean;
  manFocus: 'woman' | 'player';
  recent: string[];
}

export function buildBystanderRead(input: BystanderReadInput): ClefRequest {
  const c = input.ctx;
  const where: string[] = [];
  if (Number.isFinite(c.distanceToMan) && c.distanceToMan < 50) where.push(`The bystander is about ${Math.max(1, Math.round(c.distanceToMan))} metres from the man.`);
  if (c.lookingAt && c.lookingAt !== 'nobody') where.push(`The bystander is looking at the ${c.lookingAt === 'clerk' ? 'shopkeeper' : c.lookingAt}.`);
  if (c.filming) where.push('The bystander is holding up a phone, filming.');
  if (c.betweenThem) where.push('The bystander is standing between the man and the woman.');
  return {
    model: CLEF_PRIMARY.selector,
    state: {
      scene: input.manPresent
        ? 'Late at night on a quiet New York street. A man is harassing a woman who is trying to walk home; she has told him to leave her alone and he has not. A passer-by (the bystander) is nearby. A shopkeeper is in his doorway a few metres away.'
        : 'Late at night on a quiet New York street. A man who was harassing a woman has just walked away. The passer-by who was nearby (the bystander) is now standing with her.',
      him: input.manPresent ? (input.manFocus === 'player' ? 'The man has turned his attention to the bystander and is angry.' : 'The man is focused on the woman.') : 'The man has gone.',
      physical: where.join(' '),
      recent_lines: input.recent.slice(-4),
      bystander_words: input.text,
    },
    questions: {
      strategy: {
        type: 'choice',
        instructions: 'Which option best describes what the bystander is doing with bystander_words?',
        criteria: BYSTANDER_CRITERIA,
      },
      target: {
        type: 'choice',
        instructions: 'Who is the bystander speaking to?',
        criteria: TARGET_CRITERIA,
      },
      threat: { type: 'noul', instructions: 'Would the man hear bystander_words as a threat or a challenge to fight?' },
      insult: { type: 'noul', instructions: 'Do bystander_words insult the man or swear at him?' },
      reaction: {
        type: 'choice',
        instructions: 'Given a man who thinks he was doing nothing wrong and takes challenges personally, what is his most likely immediate reaction to bystander_words?',
        criteria: BYSTANDER_REACTION,
      },
    },
  };
}

export interface BystanderRead {
  strategy: BystanderStrategy;
  confidence: number;
  strategyProbs: Record<BystanderStrategy, number>;
  target: SpeechTarget;
  signals: { threat: number; insult: number };
  reaction?: Partial<Record<InterventionResult, number>>;
  source: 'clef' | 'heuristic';
}

export function parseBystanderRead(answers: ClefAnswers, ctx: WorldContext, selector: string = CLEF_PRIMARY.selector): BystanderRead | null {
  let strategyProbs = pickProbs(BYSTANDER_STRATEGIES, answers.strategy);
  if (!strategyProbs) return null;
  if (ctx.lookingAt === 'clerk' && strategyProbs.delegate >= 0.12) {
    // Speaking to the shopkeeper about what is happening is a Delegate, even if the words alone read as Direct.
    const boosted = { ...strategyProbs, delegate: strategyProbs.delegate * 3 };
    const total = Object.values(boosted).reduce((a, b) => a + b, 0);
    strategyProbs = Object.fromEntries(Object.entries(boosted).map(([k, v]) => [k, v / total])) as Record<BystanderStrategy, number>;
  }
  const targetProbs = pickProbs(['man', 'woman', 'clerk', 'nobody'] as const, answers.target);
  let target: SpeechTarget = ctx.lookingAt ?? 'nobody';
  if (targetProbs) {
    // Where the player is looking is a strong hint about who they are talking to.
    const looked = ctx.lookingAt && ctx.lookingAt !== 'nobody' ? ctx.lookingAt : null;
    const blended = { ...targetProbs };
    if (looked) blended[looked] = blended[looked] * 2 + 0.25;
    target = top(blended)[0];
  }
  const [strategy, p] = top(strategyProbs);
  const reaction = relativeToBaseline(pickProbs(['stops', 'turns', 'continues'] as const, answers.reaction), BYSTANDER_REACTION_BASELINE[selector]);
  return {
    strategy,
    confidence: p,
    strategyProbs,
    target,
    signals: {
      threat: answers.threat?.type === 'noul' ? clamp01(answers.threat.noul) : 0,
      insult: answers.insult?.type === 'noul' ? clamp01(answers.insult.noul) : 0,
    },
    reaction,
    source: 'clef',
  };
}

type AiRun = { run: (model: string, input: unknown) => Promise<unknown> };

function once(ai: Ai, model: { id: string; selector: string }, request: ClefRequest): Promise<ClefAnswers> {
  return (ai as unknown as AiRun).run(model.id, { ...request, model: model.selector }).then((res) => {
    const answers = (res as { answers?: ClefAnswers } | null)?.answers;
    if (!answers || typeof answers !== 'object') throw new Error(`${model.selector}: no answers`);
    return answers;
  });
}

export interface ClefResult {
  answers: ClefAnswers;
  /** Which model's answer was used. */
  selector: string;
}

/**
 * Ask both Clef models at once. Use the larger model's answer if it arrives
 * inside its budget, otherwise the fast model's. Throws only if neither
 * answers in time; callers then fall back to the keyword heuristics below.
 */
export async function runClef(ai: Ai, request: ClefRequest, budgetMs = CLEF_PRIMARY_BUDGET_MS, timeoutMs = READ_TIMEOUT_MS): Promise<ClefResult> {
  const wait = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
  const primary = once(ai, CLEF_PRIMARY, request).then(
    (answers) => ({ answers, selector: CLEF_PRIMARY.selector }) as ClefResult,
    () => null,
  );
  const fast = once(ai, CLEF_FAST, request).then(
    (answers) => ({ answers, selector: CLEF_FAST.selector }) as ClefResult,
    () => null,
  );
  const inBudget = await Promise.race([primary, wait(budgetMs, null)]);
  if (inBudget) return inBudget;
  const remaining = Math.max(50, timeoutMs - budgetMs);
  // The larger model is late (or failed): take whichever valid answer exists first.
  const firstValid = await Promise.race([
    fast.then((r) => r ?? primary),
    primary.then((r) => r ?? fast),
    wait(remaining, null),
  ]);
  if (firstValid) return firstValid;
  throw new Error('clef: no answer in time');
}

/* ------------------------------------------------------------------ keyword fallback */

function spread<K extends string>(keys: readonly K[], winner: K, p: number): Record<K, number> {
  const rest = (1 - p) / (keys.length - 1);
  const out = {} as Record<K, number>;
  for (const k of keys) out[k] = k === winner ? p : rest;
  return out;
}

const RX = {
  police: /\b(police|cops?|911|nine one one|call(ing)? (someone|somebody|my)|scream|help!|somebody help|security|cameras?)\b/i,
  insult: /\b(fuck|fucking|creep|creepy|asshole|loser|disgusting|pervert|perv|pig|freak|ugly|pathetic|piece of shit|dick|scum|weirdo|shut up)\b/i,
  excuse: /\b(boyfriend|husband|married|fianc|girlfriend|waiting for me|on the phone|meeting (someone|my)|my (dad|father|brother|friend)s? (is|are)|running late|in a hurry|late for)\b/i,
  firm: /\b(leave me alone|stop|back off|go away|get away|don'?t touch|not interested|i said no|no means no|step back|move|let me (through|pass|by)|get out of my way)\b/i,
  plead: /\bplease\b.*\b(let me|don'?t|go home|stop|leave)\b|\bplease,? please\b/i,
  polite: /\b(no thanks|no,? thank you|i'?m good|i'?m fine|i'?m okay|have a (good|nice) (night|evening|one)|sorry|not tonight|maybe another time|excuse me)\b/i,
  engage: /\b(thanks|thank you|hi|hello|hey|my name|i'?m (just )?(heading|going|walking)|just (heading|going)|nice to meet|how are you|what'?s your name)\b/i,
  seek: /\b(store|shop|bodega|sir|ma'?am|can (you|someone) help|somebody|anyone)\b/i,
};

export function heuristicWomanRead(text: string): WomanRead {
  const t = text.toLowerCase();
  let strategy: WomanStrategy = 'unclear';
  if (RX.insult.test(t)) strategy = 'hostile';
  else if (RX.police.test(t)) strategy = 'threaten_attention';
  else if (RX.plead.test(t)) strategy = 'plead';
  else if (RX.firm.test(t)) strategy = 'firm_boundary';
  else if (RX.excuse.test(t)) strategy = 'excuse';
  else if (RX.polite.test(t)) strategy = 'polite_deflect';
  else if (RX.seek.test(t)) strategy = 'seek_help';
  else if (RX.engage.test(t)) strategy = 'engage';
  else if (t.trim().split(/\s+/).length <= 1) strategy = 'unclear';
  const p = strategy === 'unclear' ? 0.5 : 0.65;
  return {
    strategy,
    confidence: p,
    strategyProbs: spread(WOMAN_STRATEGIES, strategy, p),
    signals: { tone: strategy === 'hostile' ? 0.9 : strategy === 'firm_boundary' || strategy === 'threaten_attention' ? 0.6 : 0.25, insult: RX.insult.test(t) ? 0.9 : 0.05, police: RX.police.test(t) ? 0.9 : 0.05 },
    source: 'heuristic',
  };
}

const BRX = {
  aggressive: /\b(fuck|fucking|asshole|creep|kick your|beat your|punch|knock you|i'?ll (hurt|end|drop)|piece of shit|scumbag|dickhead|loser|you want to go|fight me)\b/i,
  direct: /\b(leave her alone|stop|back off|she said no|she'?s not interested|that'?s enough|knock it off|cut it out|walk away|get away from her|are you (ok|okay|alright)|you (ok|okay|alright)|is (he|this guy) bothering you|do you know (him|this guy)|not cool|let her go)\b/i,
  distract: /\b(there you are|been looking for you|sorry i'?m late|do you (know|have) the time|what time is it|directions|how do i get to|where is|which way|excuse me|long time no see|is that you|hey girl|let'?s go|ready to go)\b/i,
  delegate: /\b(can you help|call (someone|somebody|the police)|that (guy|man) is|he'?s harassing|she needs help|come out|help her)\b/i,
  document: /\b(recording|filming|on camera|got (this|you) on video|i'?m filming)\b/i,
  delay: /\b(are you (ok|okay|alright)|you (ok|okay|alright)|do you want me to walk|walk you|i saw (that|what)|that wasn'?t (ok|okay))\b/i,
};

export function heuristicBystanderRead(text: string, ctx: WorldContext, manPresent: boolean): BystanderRead {
  const t = text.toLowerCase();
  const looking: SpeechTarget = ctx.lookingAt ?? 'nobody';
  let strategy: BystanderStrategy = 'unclear';
  if (!manPresent && BRX.delay.test(t)) strategy = 'delay';
  else if (BRX.aggressive.test(t)) strategy = 'aggressive';
  else if (looking === 'clerk' || BRX.delegate.test(t)) strategy = 'delegate';
  else if (BRX.document.test(t)) strategy = 'document';
  else if (BRX.direct.test(t)) strategy = 'direct';
  else if (BRX.distract.test(t)) strategy = 'distract';
  else if (!manPresent) strategy = 'delay';
  const p = strategy === 'unclear' ? 0.5 : 0.65;
  const target: SpeechTarget = strategy === 'delegate' ? 'clerk' : strategy === 'distract' || strategy === 'delay' ? (looking === 'man' ? 'man' : 'woman') : looking === 'nobody' ? 'man' : looking;
  return {
    strategy,
    confidence: p,
    strategyProbs: spread(BYSTANDER_STRATEGIES, strategy, p),
    target,
    signals: { threat: strategy === 'aggressive' ? 0.85 : 0.1, insult: BRX.aggressive.test(t) ? 0.85 : 0.05 },
    source: 'heuristic',
  };
}
