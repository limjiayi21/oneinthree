/**
 * The debrief, built deterministically from the session log: no model call.
 *
 * Every number the trainee sees comes from content/evidence.json and is
 * referenced by statId, chosen by topic and region. No statistic, name or
 * figure is written into this file: where evidence.json has nothing suitable
 * the insight is simply written without numbers.
 */
import type { CaseStudy, Evidence, EvidenceStat } from '../shared/evidence';
import type {
  BystanderStrategy,
  FiveDResult,
  Insight,
  ManStance,
  OutcomeKind,
  Rationale,
  Strategy,
  SummaryData,
  TimelineEntry,
  WomanStrategy,
} from '../shared/types';
import type { LogEntry, SessionMeta } from './log';
import { EVIDENCE, PARAMS, type Params } from './model/params';

const STRATEGY_LABEL: Record<Strategy, string> = {
  ignore: 'Said nothing',
  polite_deflect: 'Polite deflection',
  firm_boundary: 'Firm boundary',
  hostile: 'Insulted him',
  excuse: 'Gave an excuse',
  threaten_attention: 'Threatened to call for help',
  seek_help: 'Sought help',
  engage: 'Engaged with him',
  plead: 'Pleaded',
  unclear: 'Unclear',
  direct: 'Direct',
  distract: 'Distract',
  delegate: 'Delegate',
  delay: 'Delay',
  document: 'Document',
  none: 'No intervention',
  aggressive: 'Aggressive (a risky form of Direct)',
};

const STRATEGY_PHRASE: Partial<Record<Strategy, string>> = {
  ignore: 'said nothing',
  polite_deflect: 'turned him down politely',
  firm_boundary: 'told him plainly to leave you alone',
  hostile: 'told him exactly what you thought of him',
  excuse: 'gave him an excuse',
  threaten_attention: 'warned him you would call for help',
  seek_help: 'turned to other people',
  engage: 'answered him',
  plead: 'asked him to let you go',
};

const STANCE_LABEL: Record<ManStance, string> = {
  idle: 'Watching',
  opening: 'Calls out',
  persist: 'Persists',
  follow: 'Follows',
  block: 'Blocks path',
  guilt: 'Guilt-trips',
  hostile: 'Insults',
  intimidate: 'Intimidates',
  back_off: 'Gives up',
  gone: 'Leaves',
  escalate: 'Becomes physical',
};

const SILENT_ACTION: Partial<Record<ManStance, string>> = {
  follow: 'He falls in behind without a word.',
  gone: 'He walks away.',
  back_off: 'He hangs back.',
  block: 'He steps into the way.',
  intimidate: 'He steps in close.',
  escalate: 'He reaches out to grab.',
  hostile: 'He squares up.',
  persist: 'He stays where he is.',
};

const WOMAN_EVENT_TEXT: Record<string, [string, string]> = {
  silence: ['You said nothing.', 'Said nothing'],
  sped_up: ['You walked faster.', 'Tried to get away'],
  crossed_street: ['You crossed the street.', 'Tried to get away'],
  pushed_past: ['You pushed past him.', 'Firm boundary'],
  backed_away: ['You backed away.', 'Tried to get away'],
  stopped: ['You stopped.', 'Stopped'],
  entered_shop: ['You went into the shop.', 'Sought help'],
  reached_home: ['You reached your door.', 'Home'],
};

const BYSTANDER_EVENT_TEXT: Record<string, [string, string]> = {
  asked_clerk: ['You asked the shopkeeper for help.', 'Delegate'],
  filming_start: ['You raised your phone and started filming.', 'Document'],
  filming_stop: ['You stopped filming.', 'Document'],
  stood_between: ['You stepped between them.', 'Direct (with your body)'],
  approached: ['You walked up close to them.', 'Approached'],
  walked_past: ['You walked past them.', 'No intervention'],
  left_scene: ['You left the street.', 'No intervention'],
  scene_timeout: ['The moment passed.', 'No intervention'],
};

/* ------------------------------------------------------------------ evidence lookups */

type Region = EvidenceStat['region'];
type Topic = EvidenceStat['topic'];
const REGION_ORDER: Region[] = ['nyc', 'us', 'international', 'global', 'uk'];

interface StatQuery {
  topic: Topic;
  /** Preferred regions, best first. Defaults to the scene's own city, then country, then wider. */
  regions?: Region[];
  /** Narrow by wording, never by number. */
  match?: RegExp;
  n?: number;
}

function findStats(evidence: Evidence, q: StatQuery): string[] {
  const order = q.regions ?? REGION_ORDER;
  const rank = (r: Region) => {
    const i = order.indexOf(r);
    return i < 0 ? order.length + REGION_ORDER.indexOf(r) : i;
  };
  return (evidence.stats ?? [])
    .filter((s) => s.topic === q.topic && (!q.match || q.match.test(`${s.text} ${s.detail ?? ''}`)))
    .map((s, i) => ({ s, i }))
    .sort((a, b) => rank(a.s.region) - rank(b.s.region) || a.i - b.i)
    .slice(0, q.n ?? 1)
    .map((x) => x.s.id);
}

function pickCase(evidence: Evidence, relevance: CaseStudy['relevance'][], seed: number): string | undefined {
  for (const r of relevance) {
    const list = (evidence.caseStudies ?? []).filter((c) => c.relevance === r);
    if (list.length) return list[seed % list.length].id;
  }
  return undefined;
}

const unique = <T>(list: T[]): T[] => list.filter((v, i) => list.indexOf(v) === i);

function joinPhrases(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  if (parts.length === 2) return `${parts[0]}, then ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and then ${parts[parts.length - 1]}`;
}

/* ------------------------------------------------------------------ outcome copy */

function outcomeCopy(kind: OutcomeKind, facts: { sheLeftFirst: boolean; turnedOnPlayer: boolean; checkedIn: boolean }): { title: string; body: string } {
  switch (kind) {
    case 'reached_home_alone':
      return {
        title: 'You got home.',
        body: 'He gave up before you reached your door. That is how most of these encounters end, and it is still not nothing: you spent the walk measuring distances, exits and his mood. Nothing you said or did brought this on, and no response would have guaranteed a different night.',
      };
    case 'he_left':
      return {
        title: 'He left.',
        body: 'He gave up and walked away. Nothing you said or did brought this on, and there was no response that would have guaranteed he left sooner, or at all.',
      };
    case 'reached_home_followed':
      return {
        title: 'You got home. He saw which door.',
        body: 'He was still behind you when you went in, so he now knows where you live. You did not lead him there by anything you said or left unsaid: following you was his choice, and no response reliably makes a man like this stop.',
      };
    case 'took_refuge':
      return {
        title: 'You went into the shop.',
        body: 'Reaching other people is the most dependable way these encounters end, and it still meant standing under shop lights waiting for a stranger to lose interest. Going in was not weakness, and the other choices would not have been wrong.',
      };
    case 'escalated':
      return {
        title: 'He put his hands on you.',
        body: 'We stopped the scene there. This is rare, and it came from his temper, not from your words: women are grabbed after saying nothing, after a polite no and after shouting. There was no correct response. What he did is his responsibility alone.',
      };
    case 'intervened_he_left':
      return {
        title: 'You stepped in, and he left.',
        body: facts.checkedIn
          ? 'What you did changed how this ended for her, and you stayed long enough to ask how she was. For the person on the receiving end that second part matters as much as the first.'
          : 'What you did changed how this ended for her. It did not need to be brave or clever; it needed to happen.',
      };
    case 'intervened_she_safe':
      return {
        title: 'You stepped in, and she got away.',
        body: facts.turnedOnPlayer
          ? 'He turned his attention to you, and she used that moment to leave. You did not win the argument and you did not need to: the point was to get her out of it.'
          : 'He never really backed down, and it did not matter: what you did gave her the opening to leave. An intervention does not have to change him to work.',
      };
    case 'intervened_escalated':
      return {
        title: 'He turned on you.',
        body: `We stopped the scene there. ${facts.sheLeftFirst ? 'She got away while his attention was on you. ' : ''}Stepping in directly carries this risk, which is why the indirect options exist. Wanting to help was right; the question the 5 Ds ask is how to do it with the least danger to her and to you.`,
      };
    case 'no_intervention_she_escaped':
      return {
        title: 'She got away on her own.',
        body: 'Nobody stepped in, and she got herself home, as most women do. Staying out of it is what most people do too, usually because they do not know what would help rather than because they do not care. The rest of this debrief is about what would have.',
      };
    case 'no_intervention_escalated':
      return {
        title: 'Nobody stepped in.',
        body: 'We stopped the scene there. This is rare, and nothing a bystander does is guaranteed to prevent it. But she was alone with him for the whole of it, and the smallest interruption changes the odds.',
      };
    default:
      return {
        title: 'You left the scene.',
        body: 'You can step out of a simulation. This debrief covers what happened up to that point.',
      };
  }
}

/* ------------------------------------------------------------------ 5 Ds feedback */

function fiveDs(log: LogEntry[], outcome: OutcomeKind): FiveDResult[] {
  const players = log.filter((e): e is Extract<LogEntry, { kind: 'player' }> => e.kind === 'player');
  const moments: Record<FiveDResult['key'], string[]> = { distract: [], delegate: [], document: [], delay: [], direct: [] };
  let aggressive = false;
  let turned = false;
  for (const e of log) if (e.kind === 'decision' && e.man.action === 'turn_on_bystander') turned = true;
  for (const p of players) {
    const said = p.text ? `"${p.text}"` : null;
    if (p.event === 'filming_start') moments.document.push('You filmed what was happening.');
    else if (p.event === 'asked_clerk') moments.delegate.push('You asked the shopkeeper to step in.');
    else if (p.event === 'stood_between') moments.direct.push('You stepped between them.');
    else if (p.event === 'speech' && said) {
      const s = p.strategy as BystanderStrategy | undefined;
      if (s === 'aggressive') {
        aggressive = true;
        moments.direct.push(said);
      } else if (s === 'direct' || s === 'distract' || s === 'delegate' || s === 'delay' || s === 'document') moments[s].push(said);
    }
  }
  const used = (k: FiveDResult['key']) => moments[k].length > 0;
  const intervened = used('distract') || used('delegate') || used('direct');
  const heLeft = outcome === 'intervened_he_left' || outcome === 'intervened_she_safe';

  const feedback: Record<FiveDResult['key'], string> = {
    distract: used('distract')
      ? 'You interrupted without challenging him, which is the lowest-risk way in: he gets no argument to win and she gets a way out. Keeping your attention on her and ignoring him is exactly the technique.'
      : 'Not used. You could have walked up and greeted her like a friend, or asked either of them for directions or the time. It needs no confrontation at all, which makes it the easiest place to start when you are unsure.',
    delegate: used('delegate')
      ? 'You brought in someone with standing on that street. It spreads the risk and puts another pair of eyes on him. Say plainly what you see and what you want them to do, as you did.'
      : 'Not used. The shopkeeper was a few metres away. Telling him what was happening and asking him to come to his door would have meant you were no longer the only one acting.',
    document: used('document')
      ? intervened
        ? 'You filmed as well as acting, which is the right order: a recording is most useful once someone is already helping. Afterwards, offer it to her and let her decide what happens to it. Never post it without her say.'
        : 'You filmed, but nobody was helping her while you did. Filming by itself rarely stops anything and can leave her feeling watched rather than helped. It is most useful once someone is already stepping in; then offer her the footage and let her decide what happens to it.'
      : 'Not used. Filming from a safe distance is worth doing only when someone else is already helping. The footage belongs to her: offer it, and let her decide.',
    delay: used('delay')
      ? 'You checked on her once he had gone. This is the one of the five that is always available, and for the person it happened to it changes how the whole thing is remembered.'
      : heLeft
        ? 'Not used. Once he had gone there was a moment to ask whether she was okay, tell her you saw it and that it was not acceptable, or offer to walk with her. It costs nothing and it reduces the harm even when the incident is over.'
        : 'Not used. Even if you cannot act in the moment, you can catch up with her afterwards: ask whether she is okay, say you saw it, offer to walk with her. It reduces the harm even when the incident is over.',
    direct: used('direct')
      ? aggressive
        ? `You went at him with threats or insults. That is the form of Direct most likely to make you his target${turned ? ', which is what happened' : ''}, and it keeps the attention on the two of you instead of on getting her out. One short, calm sentence, then turn to her, does the same job with far less risk.`
        : `You named it and told him to stop${turned ? ', and he turned on you: that is the known risk of Direct, not a mistake in how you did it' : ''}. Direct is effective and it is the riskiest of the five. Keep it to one calm sentence, do not argue, and turn your attention to her.`
      : 'Not used. Direct means one short, calm sentence telling him to leave her alone, or asking her in front of him whether she is okay. It works, and it is the riskiest of the five because he may turn on you, so check first that you and she are physically safe.',
  };
  return (['distract', 'delegate', 'document', 'delay', 'direct'] as const).map((key) => ({ key, used: used(key), moments: moments[key], feedback: feedback[key] }));
}

/* ------------------------------------------------------------------ the summary */

export function buildSummary(meta: SessionMeta, log: LogEntry[], finalOutcome: OutcomeKind | null, evidence: Evidence = EVIDENCE, params: Params = PARAMS): SummaryData {
  const pov = meta.pov;
  const outcomeRow = [...log].reverse().find((e) => e.kind === 'outcome') as Extract<LogEntry, { kind: 'outcome' }> | undefined;
  const outcome: OutcomeKind = finalOutcome ?? outcomeRow?.outcome ?? 'exited';
  const decisions = log.filter((e): e is Extract<LogEntry, { kind: 'decision' }> => e.kind === 'decision');
  const players = log.filter((e): e is Extract<LogEntry, { kind: 'player' }> => e.kind === 'player');
  const stances = decisions.map((d) => d.man.stance);
  const sawStance = (...list: ManStance[]) => stances.some((s) => list.includes(s));
  const times = log.map((e) => e.t).filter((t) => Number.isFinite(t));
  const durationSec = times.length ? Math.max(0, Math.round(Math.max(...times) - Math.min(...times))) : 0;

  /* ---- timeline ---------------------------------------------------------- */
  const timeline: TimelineEntry[] = [];
  const byTurn = new Map<number, LogEntry[]>();
  for (const e of log) byTurn.set(e.turn, [...(byTurn.get(e.turn) ?? []), e]);
  for (const [, rows] of [...byTurn.entries()].sort((a, b) => a[0] - b[0])) {
    const decision = rows.find((e) => e.kind === 'decision') as Extract<LogEntry, { kind: 'decision' }> | undefined;
    const manLine = rows.find((e) => e.kind === 'line' && e.speaker === 'man');
    for (const e of rows) {
      const t = Math.round(e.t * 10) / 10;
      if (e.kind === 'player') {
        if (e.event === 'begin' || e.event === 'beat') continue;
        if (e.event === 'speech') {
          const to = pov === 'bystander' && e.target && e.target !== 'nobody' ? ` (to ${e.target === 'man' ? 'him' : e.target === 'woman' ? 'her' : 'the shopkeeper'})` : '';
          timeline.push({ t, actor: 'you', text: `"${e.text ?? ''}"`, label: e.strategy ? `${STRATEGY_LABEL[e.strategy]}${to}` : undefined });
          continue;
        }
        if (pov === 'bystander' && e.event === 'silence') continue;
        const table = pov === 'woman' ? WOMAN_EVENT_TEXT : BYSTANDER_EVENT_TEXT;
        const entry = table[e.event];
        if (!entry) continue;
        timeline.push({ t, actor: e.event === 'scene_timeout' ? 'event' : 'you', text: entry[0], label: entry[1] });
      } else if (e.kind === 'decision') {
        if (!manLine) {
          const text = SILENT_ACTION[e.man.stance];
          if (text) timeline.push({ t, actor: 'man', text: `(${text})`, label: STANCE_LABEL[e.man.stance], rationale: e.rationale });
        }
      } else if (e.kind === 'line') {
        const isMan = e.speaker === 'man';
        timeline.push({
          t,
          actor: e.speaker,
          text: e.text,
          label: isMan && decision ? STANCE_LABEL[decision.man.stance] : undefined,
          rationale: isMan ? decision?.rationale : undefined,
        });
      } else if (e.kind === 'thought') {
        timeline.push({ t, actor: 'thought', text: e.text });
      }
    }
  }

  /* ---- insights ---------------------------------------------------------- */
  const insights: Insight[] = [];
  const add = (title: string, body: string, statIds: string[]) => {
    if (insights.length < 4) insights.push({ title, body, statIds: unique(statIds) });
  };
  let caseStudyId: string | undefined;
  let featured: string[] = [];

  if (pov === 'woman') {
    const tried = unique(
      players
        .filter((p) => p.event !== 'begin' && p.event !== 'reached_home')
        .map((p) => (p.event === 'entered_shop' ? 'went into the shop' : p.event === 'crossed_street' ? 'crossed the street' : p.event === 'sped_up' ? 'walked faster' : p.event === 'pushed_past' ? 'pushed past him' : STRATEGY_PHRASE[(p.strategy ?? 'ignore') as WomanStrategy] ?? '')),
    ).filter(Boolean);
    const did: string[] = [];
    if (sawStance('persist', 'guilt')) did.push('kept talking');
    if (sawStance('follow')) did.push('followed you');
    if (sawStance('block')) did.push('stepped into your path');
    if (sawStance('hostile', 'intimidate')) did.push('turned on you');
    if (sawStance('back_off', 'gone')) did.push('eventually gave up');
    const triedText = tried.length ? `You ${joinPhrases(tried.slice(0, 4))}.` : 'You kept walking.';
    const didText = did.length ? ` He ${joinPhrases(did)}.` : '';
    add(
      'There was no right answer',
      `${triedText}${didText} Researchers who have studied women's own accounts find every kind of outcome after every kind of response, and the people who train on this are blunt about it: there is no right or wrong way to respond, because the harassment is never caused by the response. Most of what he did was decided by the kind of man he is, before you said a word.`,
      findStats(evidence, { topic: 'response', n: 2 }),
    );
    if (sawStance('hostile', 'intimidate', 'escalate')) {
      add(
        'When he does not get the reaction he wants',
        'He was calling you beautiful until you did not give him what he wanted. That switch is the reason so many women soften a no, invent a boyfriend or say nothing at all: they are managing a stranger\'s temper in real time, with no way of knowing which kind of man he is.',
        findStats(evidence, { topic: 'escalation', n: 1 }),
      );
    }
    if (sawStance('follow', 'block') || outcome === 'reached_home_followed') {
      add(
        outcome === 'reached_home_followed' ? 'He knows which door is yours' : 'Being followed is not rare',
        outcome === 'reached_home_followed'
          ? 'Being followed to your own door changes what home means. Women describe changing their route, their routine and sometimes their address afterwards. None of that is an overreaction, and none of it should be their job.'
          : 'Trailing after a woman, or stepping into her path, turns a remark into a question about what he will do next. It is common enough that most women have a plan for it.',
        [...findStats(evidence, { topic: 'following', n: 2 }), ...(outcome === 'reached_home_followed' ? findStats(evidence, { topic: 'behaviour_change', match: /route|routine/i, n: 1 }) : [])],
      );
    }
    if (outcome === 'took_refuge') {
      add(
        'Why the shop worked, and what it cost',
        'Men who do this overwhelmingly pick women who are alone, so reaching other people is the most dependable way to end it. It also meant waiting in a shop for a stranger to get bored before you could finish your walk home.',
        findStats(evidence, { topic: 'prevalence', match: /alone/i, n: 1 }),
      );
    }
    if (outcome === 'escalated') {
      add(
        'Rare is not the same as never',
        'Most street harassment stays verbal. Women know that, and they also know they cannot tell in the moment which encounter will be the exception. That uncertainty, more than any single remark, is what you were carrying on that street.',
        [...findStats(evidence, { topic: 'touching', n: 1 }), ...findStats(evidence, { topic: 'escalation', n: 1 })],
      );
    }
    add(
      'The calculating never stopped',
      'For the whole of that walk part of your attention was on distances, exits, his hands, your keys and whether anyone else was around. Many women run that calculation every night, and it shapes where they go, when, and with whom.',
      [...findStats(evidence, { topic: 'behaviour_change', regions: ['us', 'nyc', 'uk'], n: 2 }), ...findStats(evidence, { topic: 'fear', regions: ['us', 'global', 'uk'], n: 1 })],
    );

    const rejectionHostility = sawStance('hostile', 'intimidate', 'escalate');
    if (outcome === 'escalated' || rejectionHostility) caseStudyId = pickCase(evidence, ['rejection_violence'], meta.seed);
    else if (outcome === 'reached_home_followed') caseStudyId = pickCase(evidence, ['followed', 'walking_home'], meta.seed);
    else if (sawStance('follow')) caseStudyId = pickCase(evidence, ['walking_home', 'followed'], meta.seed);

    featured = [
      ...findStats(evidence, { topic: 'prevalence', regions: ['us', 'international', 'global'], match: /street harass/i, n: 1 }),
      ...insights.flatMap((i) => i.statIds),
      ...findStats(evidence, { topic: 'escalation', n: 1 }),
      ...findStats(evidence, { topic: 'following', n: 1 }),
      ...findStats(evidence, { topic: 'fear', regions: ['us', 'global', 'uk'], n: 1 }),
      ...findStats(evidence, { topic: 'reporting', regions: ['us', 'nyc'], n: 1 }),
    ];
  } else {
    const ds = fiveDs(log, outcome);
    const used = (k: FiveDResult['key']) => ds.find((d) => d.key === k)?.used ?? false;
    const aggressive = players.some((p) => p.strategy === 'aggressive');
    const turned = decisions.some((d) => d.man.action === 'turn_on_bystander');
    const intervened = outcome.startsWith('intervened');

    if (!intervened) {
      add(
        'Most people do what you did',
        'Nearly everyone who watches this happen wants it to stop and does not know how. That is not indifference; it is a missing skill, and it can be learned.',
        findStats(evidence, { topic: 'bystander', match: /do not know|helped them|someone helped/i, n: 2 }),
      );
      add(
        'Doing nothing is not neutral',
        'Women who have been through this say that people who saw it and looked away made it worse, and that even a small sign that someone had noticed made it better. You do not have to confront anyone to be that sign.',
        findStats(evidence, { topic: 'bystander', match: /present/i, n: 1 }),
      );
      if (used('document')) {
        add(
          'Filming is for afterwards',
          'A recording can matter later, but while it is being made she is still alone with him. Guidance is to film only once someone is already helping, and to hand the footage to her.',
          [],
        );
      }
    } else {
      if (used('distract')) {
        add(
          'Why interrupting works',
          'You never had to challenge him. Walking up and talking to her ended the one condition nearly every incident shares: a woman by herself. He was left with nothing to push against.',
          findStats(evidence, { topic: 'prevalence', match: /alone/i, n: 1 }),
        );
      }
      if (used('direct')) {
        add(
          aggressive ? 'Meeting his aggression with yours' : 'Direct works, and it is the risky one',
          aggressive
            ? `Threats and insults put you in his sights${turned ? ', as you saw' : ''} and keep the scene about the two of you. The same result usually comes from one calm sentence and then turning to her.`
            : `Harassment is more likely to stop when a bystander confronts it. It is also the tactic most likely to turn him on the person who speaks${turned ? ', which is what happened here' : ''}. Short, calm, no argument, then your attention goes to her.`,
          findStats(evidence, { topic: 'bystander', regions: ['nyc', 'us'], n: 1 }),
        );
      }
      if (used('delegate')) {
        add(
          'You did not have to do it alone',
          'Bringing in the shopkeeper put a second person, with standing on that street, between her and him. When several people are around, someone nearly always acts once one person starts.',
          findStats(evidence, { topic: 'bystander', match: /at least one bystander|cameras/i, n: 1 }),
        );
      }
      add(
        used('delay') ? 'The moment afterwards' : 'One thing was still available',
        used('delay')
          ? 'Asking how she was once he had gone cannot undo it, but it changes what she takes home: that someone saw, and that it was not acceptable.'
          : 'Once it was over there was still time to ask whether she was okay and say that what happened was not acceptable. It is the one option that is always open, even to someone who froze during the incident itself.',
        [],
      );
      add(
        'Most women get no help at all',
        'What you did is unusual. Most people who are harassed in public say nobody stepped in.',
        findStats(evidence, { topic: 'bystander', regions: ['international', 'us', 'nyc'], match: /helped/i, n: 1 }),
      );
    }
    caseStudyId = intervened ? pickCase(evidence, ['bystander_helped'], meta.seed) : pickCase(evidence, ['bystander_absent'], meta.seed);
    featured = [
      ...insights.flatMap((i) => i.statIds),
      ...findStats(evidence, { topic: 'bystander', regions: ['international', 'us', 'nyc'], n: 4 }),
      ...findStats(evidence, { topic: 'prevalence', regions: ['us', 'international'], match: /street harass|public spaces/i, n: 1 }),
    ];
  }

  const known = new Set((evidence.stats ?? []).map((s) => s.id));
  const statIds = unique(featured).filter((id) => known.has(id)).slice(0, 6);
  for (const i of insights) i.statIds = i.statIds.filter((id) => known.has(id));

  /* ---- model notes ------------------------------------------------------- */
  const modelNotes: Rationale[] = [];
  const drivers = unique(decisions.flatMap((d) => d.drivers));
  const fieldReview = (evidence.harasserBehaviour ?? []).find((f) => /no study/i.test(f.finding));
  modelNotes.push({
    text:
      pov === 'woman'
        ? 'What this model assumes: no study measures how a street harasser reacts to a particular response, so every "she did this, so he did that" probability here is an assumption, held inside ranges the research suggests. His behaviour was sampled, not scripted: the same choices on another night could have ended differently.'
        : 'What this model assumes: there is no outcome data for individual bystander tactics, so the odds behind his reaction to each of the 5 Ds are assumptions guided by practitioner experience and by the one finding that confrontation makes harassment more likely to stop. His behaviour was sampled, not scripted.',
    basis: 'assumption',
    sourceIds: fieldReview && evidence.sources[fieldReview.sourceId] ? [fieldReview.sourceId] : [],
  });
  if (pov === 'woman' && meta.disposition) {
    const share = params.get(meta.disposition === 'volatile' ? 'man.disposition.hostile_from_start' : meta.disposition === 'persistent' ? 'man.disposition.persistent_entitled' : 'man.disposition.wants_friendly_response');
    const kind = meta.disposition === 'volatile' ? 'a man who set out to unsettle her' : meta.disposition === 'persistent' ? 'a man who feels entitled to her attention' : 'a man who mainly wanted a friendly reaction';
    modelNotes.push({
      text: `His disposition was drawn once, before the scene began (this time: ${kind}), and it carried most of the variation in what he did. What you said shifted the odds only modestly.`,
      basis: share?.basis ?? 'assumption',
      sourceIds: share?.sourceIds ?? [],
    });
  }
  for (const key of drivers.slice(0, 12)) {
    const p = params.get(key);
    if (!p) continue;
    const range = p.range ? ` (range ${p.range[0]} to ${p.range[1]})` : '';
    modelNotes.push({ text: `${p.key} = ${p.value}${range}. ${p.rationale}`, basis: p.basis, sourceIds: p.sourceIds });
  }
  const blend = params.get('model.blend.clef_weight');
  if (blend && players.some((p) => p.event === 'speech' && p.source === 'clef')) {
    modelNotes.push({
      text: `Your exact words were read by Cloudflare's Clef decision model, and its view of his likely reaction was blended into those odds with a weight of ${blend.value}: enough for what you said to matter, never enough to move a probability outside the range the research gives it.`,
      basis: blend.basis,
      sourceIds: blend.sourceIds,
    });
  }

  const facts = {
    sheLeftFirst: decisions.some((d) => d.woman?.action === 'hurry_home' || d.woman?.action === 'enter_shop'),
    turnedOnPlayer: decisions.some((d) => d.man.action === 'turn_on_bystander'),
    checkedIn: players.some((p) => p.strategy === 'delay'),
  };
  const copy = outcomeCopy(outcome, facts);
  const summary: SummaryData = {
    pov,
    outcome: { kind: outcome, title: copy.title, body: copy.body },
    durationSec,
    timeline,
    insights,
    statIds,
    modelNotes,
  };
  if (caseStudyId) summary.caseStudyId = caseStudyId;
  if (pov === 'bystander') summary.fiveDs = fiveDs(log, outcome);
  return summary;
}
