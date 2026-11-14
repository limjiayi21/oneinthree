/**
 * DEV HARNESS ONLY. Nothing in this file ships: src/ never imports it.
 *
 * Two kinds of mock live here:
 *
 *   mockEvidence   Obviously fake stand-ins for content/evidence.json
 *                  ("00%", "Example Source A", "000-000-0000") so the layouts
 *                  can be designed before the verified data lands. None of it
 *                  is, or pretends to be, a real figure, case or phone number.
 *
 *   mockSummary()  A realistic SummaryData, as the Worker would return it for
 *                  one run. Its lines come from content/script.json; its
 *                  statistic / case / source ids are picked from whichever
 *                  evidence object it is given, so the same debrief renders
 *                  against mock, real or empty evidence.
 */

import type { Evidence } from '../shared/evidence';
import type { Rationale, SummaryData, TimelineEntry } from '../shared/types';

const src = (n: string, year: number) => ({
  id: `mock-${n}`,
  title: `Example Report Title ${n.toUpperCase()}: a mock entry, not a real publication`,
  publisher: `Example Source ${n.toUpperCase()}`,
  year,
  url: `https://example.com/mock-source-${n}`,
  accessed: '2000-01-01',
});

export const mockEvidence: Evidence = {
  sources: {
    'mock-a': src('a', 2000),
    'mock-b': src('b', 2001),
    'mock-c': src('c', 2002),
    'mock-d': src('d', 2003),
    'mock-e': src('e', 2004),
  },
  stats: [
    {
      id: 'mock-global',
      headline: '0 in 0',
      text: 'mock statistic text standing in for the global prevalence figure, written at about the length the real sentence will run.',
      detail: 'Mock detail line: who was surveyed, how many, and when. Not a real figure.',
      sourceId: 'mock-a',
      region: 'global',
      topic: 'prevalence',
    },
    {
      id: 'mock-following',
      headline: '00%',
      text: 'mock statistic text about being followed by a stranger, one sentence long.',
      detail: 'Mock detail line. Not a real figure.',
      sourceId: 'mock-b',
      region: 'us',
      topic: 'following',
    },
    {
      id: 'mock-behaviour',
      headline: '00%',
      text: 'mock statistic text about changing a route home or a daily routine.',
      sourceId: 'mock-b',
      region: 'us',
      topic: 'behaviour_change',
    },
    {
      id: 'mock-age',
      headline: 'Before 00',
      text: 'mock statistic text about the age at which it first happens, with a longer headline to test wrapping.',
      detail: 'Mock detail line. Not a real figure.',
      sourceId: 'mock-c',
      region: 'international',
      topic: 'age',
    },
    {
      id: 'mock-escalation',
      headline: 'Nearly 0 in 00',
      text: 'mock statistic text about what follows a refusal.',
      sourceId: 'mock-d',
      region: 'us',
      topic: 'escalation',
    },
    {
      id: 'mock-bystander',
      headline: '00%',
      text: 'mock statistic text about how often someone nearby steps in.',
      detail: 'Mock detail line. Not a real figure.',
      sourceId: 'mock-e',
      region: 'us',
      topic: 'bystander',
    },
    {
      id: 'mock-response',
      headline: '0.0×',
      text: 'mock statistic text about what changes when one person says something.',
      sourceId: 'mock-e',
      region: 'us',
      topic: 'response',
    },
  ],
  caseStudies: [
    {
      id: 'mock-case-rejection',
      name: 'Example Case Name',
      location: 'Example City, Example State',
      year: 2000,
      summary:
        'Mock case study. This paragraph stands in for a short, factual account of a real event: who she was, where she was going, what was said to her, and what happened when she said no. Three or four plain sentences.\n\nA second mock paragraph covers what followed: the investigation, the outcome, and why the case is remembered.',
      relevance: 'rejection_violence',
      sourceIds: ['mock-c', 'mock-d'],
    },
    {
      id: 'mock-case-bystander',
      name: 'Second Example Case',
      location: 'Example Town',
      year: 2001,
      summary:
        'Mock case study. This paragraph stands in for an account of a real event in which someone nearby stepped in, and what difference it made. Three or four plain sentences.',
      relevance: 'bystander_helped',
      sourceIds: ['mock-e'],
    },
  ],
  harasserBehaviour: [
    { id: 'mock-hb-1', finding: 'Mock finding: a sentence standing in for a published result about how street harassers respond to being ignored.', sourceId: 'mock-b', confidence: 'data' },
    { id: 'mock-hb-2', finding: 'Mock finding: a sentence standing in for a result about persistence after a polite refusal.', sourceId: 'mock-c', confidence: 'inferred' },
  ],
  bystander: {
    fiveDs: [
      { key: 'distract', name: 'Distract', description: 'Mock description of this approach: one or two sentences on what it is and why it works without confronting anyone.', example: 'Mock example line showing what someone might say.' },
      { key: 'delegate', name: 'Delegate', description: 'Mock description of this approach: one or two sentences on bringing in someone else.', example: 'Mock example line showing who to ask.' },
      { key: 'document', name: 'Document', description: 'Mock description of this approach: one or two sentences on recording what happens, and what to do with it.', example: 'Mock example line.' },
      { key: 'delay', name: 'Delay', description: 'Mock description of this approach: one or two sentences on checking in afterwards.', example: 'Mock example line showing what to say to her.' },
      { key: 'direct', name: 'Direct', description: 'Mock description of this approach: one or two sentences on naming it to the person doing it.', example: 'Mock example line.' },
    ],
    findings: [
      { id: 'mock-bf-1', finding: 'Mock finding: a sentence standing in for a published result about why people nearby hold back.', sourceId: 'mock-e' },
      { id: 'mock-bf-2', finding: 'Mock finding: a sentence standing in for a result about what the person targeted says helped.', sourceId: 'mock-a' },
    ],
  },
  modelCalibration: {
    notes: 'Mock calibration note. This paragraph stands in for a plain account of how the decision model was tuned and where its numbers come from.',
    parameters: [
      { key: 'mock_persist_after_ignore', value: 0, range: [0, 1], basis: 'data', rationale: 'Mock reasoning for this value.', sourceIds: ['mock-b'] },
      { key: 'mock_hostile_after_firm_no', value: 0, range: [0, 1], basis: 'inferred', rationale: 'Mock reasoning, inferred from a finding rather than a figure.', sourceIds: ['mock-c'] },
      { key: 'mock_leave_when_witnessed', value: 0, basis: 'assumption', rationale: 'Mock reasoning for a value nobody has measured.', sourceIds: [] },
    ],
  },
  resources: [
    { name: 'Example Helpline One', description: 'Mock description: who they are, what they offer and when they answer.', url: 'https://example.org/mock-helpline-one', phone: '000-000-0000', region: 'nyc' },
    { name: 'Example Support Service', description: 'Mock description of a local, in-person service.', url: 'https://example.org/mock-support-service', region: 'nyc' },
    { name: 'Example National Hotline', description: 'Mock description: free, confidential, around the clock.', url: 'https://example.org/mock-national-hotline', phone: '0-000-000-0000', region: 'us' },
    { name: 'Example Text Line', description: 'Mock description of a service reached by text message.', url: 'https://example.org/mock-text-line', phone: 'Text EXAMPLE to 000000', region: 'us' },
    { name: 'Example Training Organisation', description: 'Mock description of an organisation that teaches bystander intervention.', url: 'https://example.org/mock-training', region: 'us' },
    { name: 'Example UK Helpline', description: 'Mock description of a national helpline.', url: 'https://example.org/mock-uk-helpline', phone: '0000 000 0000', region: 'uk' },
    { name: 'Example International Directory', description: 'Mock description of a directory of services by country.', url: 'https://example.org/mock-directory', region: 'international' },
  ],
};

/* --------------------------------------------------------------- summaries */

export type MockSummaryKind = 'woman' | 'woman-escalated' | 'bystander';

function pickStats(evidence: Evidence, topics: string[], max: number): string[] {
  const out: string[] = [];
  for (const topic of topics) {
    const hit = evidence.stats.find((s) => s.topic === topic && !out.includes(s.id));
    if (hit) out.push(hit.id);
  }
  for (const stat of evidence.stats) {
    if (out.length >= max) break;
    if (!out.includes(stat.id)) out.push(stat.id);
  }
  return out.slice(0, max);
}

function pickCase(evidence: Evidence, relevance: string[]): string | undefined {
  for (const r of relevance) {
    const hit = evidence.caseStudies.find((c) => c.relevance === r);
    if (hit) return hit.id;
  }
  return evidence.caseStudies[0]?.id;
}

export function mockSummary(kind: MockSummaryKind, evidence: Evidence): SummaryData {
  // Rationales. Against the mock evidence these are placeholder sentences citing
  // the mock sources. Against the real evidence each one is replaced by the real
  // calibration parameter named in `key` (its own reasoning, basis and sources),
  // so no made-up sentence is ever shown next to a real citation.
  const isMock = evidence === mockEvidence;
  const sourceIds = Object.keys(evidence.sources);
  const source = (i: number): string[] => (isMock && sourceIds.length ? [sourceIds[i % sourceIds.length]!] : []);
  const why = (text: string, basis: Rationale['basis'], i: number, key?: string): Rationale => {
    const parameter = key ? evidence.modelCalibration.parameters.find((p) => p.key === key) : undefined;
    if (parameter) return { text: parameter.rationale, basis: parameter.basis, sourceIds: parameter.sourceIds };
    return { text, basis, sourceIds: basis === 'assumption' ? [] : source(i) };
  };

  const modelNotes: Rationale[] = [
    why('His opening line and the odds that he keeps going after being ignored were set from published survey figures.', 'data', 0, 'man.disposition.wants_friendly_response'),
    why('How quickly he turns from charm to insult after a firm refusal was reasoned from research on reactions to rejection. There is no direct figure for it.', 'inferred', 1, 'response.firm_boundary.p_verbal_hostility'),
    why('How long he follows before giving up is an assumption. Nobody has measured it.', 'assumption', 2, 'man.disposition.persistent_entitled'),
  ];

  if (kind === 'bystander') {
    const timeline: TimelineEntry[] = [
      { t: 4, actor: 'event', text: 'You come up out of the subway. She is twenty metres ahead of you.' },
      { t: 19, actor: 'man', text: 'Hey. Hey, beautiful. Where you headed?', label: 'Opening', rationale: why('He opens the way most recorded encounters open: a call-out framed as a compliment.', 'data', 0, 'base.incident_includes_verbal') },
      { t: 23, actor: 'woman', text: 'I’m good, thanks. Have a good night.', label: 'Polite deflection' },
      { t: 28, actor: 'man', text: 'I’m talking to you. What, you can’t say hi?', label: 'Persists', rationale: why('A polite refusal rarely ends it. The model raises the chance that he keeps talking.', 'inferred', 1, 'response.polite_deflection.p_persist') },
      { t: 33, actor: 'event', text: 'He pushes off the wall and falls in beside her.', label: 'Walks alongside' },
      { t: 41, actor: 'man', text: 'Come on, slow down. Let me walk you home. Where you live at?', label: 'Persists' },
      { t: 46, actor: 'woman', text: 'Please. I just want to get home.', label: 'Pleads' },
      { t: 52, actor: 'you', text: 'Hey! Sorry, do you know which way the F train is?', label: 'Distract' },
      { t: 55, actor: 'event', text: 'She turns toward you. He stops walking.', rationale: why('A third person entering the scene interrupts him. How often that works in life is not well measured.', 'assumption', 2, 'bystander.distract.p_harassment_stops') },
      { t: 58, actor: 'man', text: 'Damn, why you gotta be like that? I’m just being nice.', label: 'Guilt' },
      { t: 64, actor: 'event', text: 'You go to the shop doorway and ask the shopkeeper for help.', label: 'Delegate' },
      { t: 69, actor: 'clerk', text: 'Hey! Hey, leave her alone, man. I got cameras out here.' },
      { t: 75, actor: 'you', text: 'Leave her alone.', label: 'Direct' },
      { t: 79, actor: 'man', text: 'Yeah, keep walking! Nobody wants you anyway!', label: 'Backs off', rationale: why('Outnumbered and watched, he leaves with a parting insult rather than a fight.', 'inferred', 1, 'bystander.direct.p_harassment_stops') },
      { t: 84, actor: 'event', text: 'He walks off toward the far corner. She reaches her door.' },
    ];
    return {
      pov: 'bystander',
      outcome: {
        kind: 'intervened_she_safe',
        title: 'She got away from him.',
        body: 'You did not start with him. You asked her for directions, and it gave her a reason to turn away from him. Then you brought in the shopkeeper, and then you said it to his face.',
      },
      durationSec: 92,
      timeline,
      insights: [
        {
          title: 'You spoke to her first, not to him.',
          body: 'An ordinary question did what a confrontation might not have: it broke his hold on the conversation without challenging him. (Mock insight text. In the real debrief this paragraph ties what you did to a published finding.)',
          statIds: pickStats(evidence, ['bystander'], 1),
        },
        {
          title: 'You did not act alone.',
          body: 'Bringing in the shopkeeper meant he was facing two people and a camera. (Mock insight text.)',
          statIds: pickStats(evidence, ['response'], 1),
        },
      ],
      statIds: pickStats(evidence, ['bystander', 'response', 'prevalence', 'following'], 4),
      caseStudyId: pickCase(evidence, ['bystander_helped', 'bystander_absent']),
      fiveDs: [
        { key: 'distract', used: true, moments: ['“Hey! Sorry, do you know which way the F train is?”'], feedback: 'You gave her a way out that did not require her to refuse him again, and did not require you to confront him.' },
        { key: 'delegate', used: true, moments: ['Asked the shopkeeper for help.'], feedback: 'The shopkeeper had standing on that sidewalk, and cameras. You did not have to carry it alone.' },
        { key: 'document', used: false, moments: [], feedback: 'You did not film. Others were already helping, so there was little need.' },
        { key: 'delay', used: false, moments: [], feedback: 'The scene ended before you had the chance to check in with her afterwards.' },
        { key: 'direct', used: true, moments: ['“Leave her alone.”'], feedback: 'Short, clear, and said once others were with you.' },
      ],
      modelNotes,
    };
  }

  const escalated = kind === 'woman-escalated';
  const timeline: TimelineEntry[] = [
    { t: 3, actor: 'event', text: 'You come up out of the subway. Four blocks to go.' },
    { t: 6, actor: 'thought', text: 'Long day. Just get home.' },
    { t: 21, actor: 'event', text: 'Something crashes in the alley beside you.', label: 'Startle' },
    { t: 23, actor: 'thought', text: 'It’s a cat. It’s just a cat. Breathe.' },
    { t: 38, actor: 'thought', text: 'There’s a guy up ahead. Under the scaffolding.' },
    { t: 44, actor: 'man', text: 'Hey. Hey, beautiful. Where you headed?', label: 'Opening', rationale: why('He opens the way most recorded encounters open: a call-out framed as a compliment.', 'data', 0) },
    { t: 47, actor: 'you', text: 'Said nothing. Kept walking.', label: 'Ignore' },
    { t: 52, actor: 'man', text: 'I’m talking to you. What, you can’t say hi?', label: 'Persists', rationale: why('Being ignored did not end it. The model keeps him talking more often than not.', 'data', 0, 'response.ignore.p_persist_or_follow') },
    { t: 55, actor: 'event', text: 'He pushes off the wall and falls in beside you.', label: 'Walks alongside' },
    { t: 58, actor: 'thought', text: 'He’s too close. Back up.' },
    { t: 63, actor: 'you', text: 'No thank you. Have a good night.', label: 'Polite deflection' },
    { t: 68, actor: 'man', text: 'Come on, slow down. Let me walk you home. Where you live at?', label: 'Persists', rationale: why('A polite refusal is often read as an opening. The model raises the chance that he continues.', 'inferred', 1, 'response.polite_deflection.p_persist') },
    { t: 76, actor: 'you', text: 'Please leave me alone.', label: 'Firm boundary' },
    { t: 81, actor: 'man', text: 'Damn, why you gotta be like that? I’m just being nice.', label: 'Guilt' },
    { t: 88, actor: 'event', text: 'He steps in front of you.', label: 'Blocks path', rationale: why('Whether he blocks her path at this point is an assumption about pacing, not a measured behaviour.', 'assumption', 2, 'base.incident_involves_path_interference') },
    { t: 90, actor: 'thought', text: 'I can’t get past him.' },
  ];

  if (escalated) {
    timeline.push(
      { t: 96, actor: 'you', text: 'Get away from me!', label: 'Firm boundary' },
      { t: 101, actor: 'man', text: 'Stuck-up bitch. You think you’re too good for me?', label: 'Hostile', rationale: why('After a firm refusal the model moves him from charm to insult.', 'inferred', 1, 'response.firm_boundary.p_verbal_hostility') },
      { t: 104, actor: 'thought', text: 'Don’t let him touch me.' },
      { t: 107, actor: 'event', text: 'He closes the distance. The simulation stopped here.', label: 'Escalation', rationale: why('A small share of encounters turn physical. The model lets that happen at a low rate, whatever she says.', 'data', 0, 'base.physical_escalation_per_run') },
    );
    return {
      pov: 'woman',
      outcome: {
        kind: 'escalated',
        title: 'It became physical.',
        body: 'The simulation stopped at the moment he closed the distance. Nothing further was shown.\n\nYou ignored him, then you were polite, then you told him clearly to leave. He escalated anyway.',
      },
      durationSec: 107,
      timeline,
      insights: [
        {
          title: 'You said no clearly. He escalated anyway.',
          body: 'What he did next was his decision, not a consequence of your wording. (Mock insight text. In the real debrief this paragraph ties what happened to a published finding.)',
          statIds: pickStats(evidence, ['escalation'], 1),
        },
      ],
      statIds: pickStats(evidence, ['escalation', 'prevalence', 'reporting'], 3),
      caseStudyId: pickCase(evidence, ['rejection_violence', 'followed']),
      modelNotes,
    };
  }

  timeline.push(
    { t: 97, actor: 'you', text: 'Stop following me. I mean it.', label: 'Firm boundary' },
    { t: 103, actor: 'man', text: 'Yeah, keep walking! Nobody wants you anyway!', label: 'Hostile', rationale: why('After a firm refusal the model moves him from charm to insult.', 'inferred', 1, 'response.firm_boundary.p_verbal_hostility') },
    { t: 110, actor: 'event', text: 'He lets you pass, then follows a few metres behind.', label: 'Follows' },
    { t: 118, actor: 'thought', text: 'Don’t look back. Don’t look back.' },
    { t: 141, actor: 'thought', text: 'If I go in now, he sees where I live.' },
    { t: 176, actor: 'event', text: 'You reach your door. He is standing across the street.', label: 'Home' },
    { t: 184, actor: 'thought', text: 'He watched me go in. He knows which door is mine.' },
  );
  return {
    pov: 'woman',
    outcome: {
      kind: 'reached_home_followed',
      title: 'You got home. He saw which door.',
      body: 'He stayed with you for most of three blocks. You ignored him, then you were polite, then you told him to stop. He was still on the sidewalk when the door closed behind you.',
    },
    durationSec: 187,
    timeline,
    insights: [
      {
        title: 'You tried three different things. None of them was wrong.',
        body: 'Silence, politeness and a clear no each got a different reaction from him, and none of them made him leave. (Mock insight text. In the real debrief this paragraph ties what you did to a published finding.)',
        statIds: pickStats(evidence, ['following'], 1),
      },
      {
        title: 'You thought about where to go, not only what to say.',
        body: 'Going straight home meant he would learn your address. That calculation is part of the walk. (Mock insight text.)',
        statIds: pickStats(evidence, ['behaviour_change'], 1),
      },
    ],
    statIds: pickStats(evidence, ['prevalence', 'following', 'behaviour_change', 'age'], 4),
    caseStudyId: pickCase(evidence, ['followed', 'walking_home']),
    modelNotes,
  };
}

/** The shape main.ts falls back to when the server cannot produce a debrief. */
export function minimalSummary(pov: 'woman' | 'bystander'): SummaryData {
  return {
    pov,
    outcome:
      pov === 'woman'
        ? { kind: 'reached_home_alone', title: 'You got home.', body: 'He dropped away before you reached your door.' }
        : { kind: 'no_intervention_she_escaped', title: 'She got away on her own.', body: 'Nobody on the street said anything.' },
    durationSec: 0,
    timeline: [],
    insights: [],
    statIds: [],
    modelNotes: [],
  };
}
