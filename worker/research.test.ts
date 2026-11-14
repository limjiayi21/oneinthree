import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ManDecision, ManStance } from '../shared/types';
import { AGENT_PROMPT } from './agent';
import { composeBeat } from './judge';
import { PARAMS } from './model/params';
import { HARASSMENT_RESEARCH, PROMPT_BRIEF, claimSources, type ResearchClaim } from './research';
import { buildSummary } from './summary';
import type { LogEntry, SessionMeta } from './log';
import { BYSTANDER_SYSTEM, WOMAN_SYSTEM } from './write';

const markdown = readFileSync(new URL('../data/harassment_research.md', import.meta.url), 'utf8');

function claims(): ResearchClaim[] {
  const d = HARASSMENT_RESEARCH.debrief;
  return [...HARASSMENT_RESEARCH.behaviors, ...HARASSMENT_RESEARCH.responses, ...HARASSMENT_RESEARCH.fiveDs, ...Object.values(HARASSMENT_RESEARCH.replayTips), d.noRightResponse, d.firmBoundary, d.fiveDCitation, d.bystanderStops];
}

describe('harassment research file', () => {
  it('gives every numbered claim a source URL, and invents no rate in the model prompt', () => {
    expect(PROMPT_BRIEF).not.toMatch(/\d|%|percent/i);
    expect(HARASSMENT_RESEARCH.firmBystanderRule).not.toMatch(/\d/);
    for (const source of Object.values(HARASSMENT_RESEARCH.sources)) {
      expect(source.url, source.id).toMatch(/^https:\/\//);
    }
    for (const claim of claims()) {
      expect(claim.text.length).toBeGreaterThan(40);
      if (/\d/.test(claim.text)) {
        expect(claim.sourceIds.length, claim.text.slice(0, 60)).toBeGreaterThan(0);
        for (const source of claimSources(claim)) expect(source.url).toMatch(/^https:\/\//);
      }
    }
    expect(HARASSMENT_RESEARCH.fiveDs.map((d) => d.key)).toEqual(['distract', 'delegate', 'document', 'delay', 'direct']);
    for (const source of Object.values(HARASSMENT_RESEARCH.sources)) expect(markdown).toContain(source.url);
    for (const figure of ['65%', '70%', '22%', '68%', '16,600', '92%', '31%', '223']) expect(markdown).toContain(figure);
  });

  it('conditions the line writer and the live agent with the same pattern note', () => {
    expect(WOMAN_SYSTEM).toContain(PROMPT_BRIEF);
    expect(BYSTANDER_SYSTEM).toContain(PROMPT_BRIEF);
    expect(AGENT_PROMPT).toContain(PROMPT_BRIEF);
    expect(WOMAN_SYSTEM).toMatch(/never: slurs/i);
    expect(AGENT_PROMPT).toMatch(/never use a slur/i);
  });

  it('keeps the decision ordering the research supports, without a new probability', () => {
    const hostility = (key: string) => PARAMS.get(key)!.value;
    expect(hostility('response.hostile_insult.p_verbal_hostility')).toBeGreaterThan(hostility('response.firm_boundary.p_verbal_hostility'));
    expect(hostility('response.firm_boundary.p_verbal_hostility')).toBeGreaterThan(hostility('response.ignore.p_verbal_hostility'));
    expect(hostility('bystander.document.p_harassment_stops')).toBeLessThan(hostility('bystander.direct.p_harassment_stops'));
    expect(hostility('bystander.direct.p_hostility_toward_bystander')).toBeGreaterThan(hostility('bystander.distract.p_hostility_toward_bystander'));
    expect(PARAMS.get('response.firm_boundary.p_verbal_hostility')!.basis).not.toBe('data');

    const beat = composeBeat(
      { stance: 'intimidate', emotion: 'angry', emotionIntensity: 0.8, action: 'lean_in', tension: 0.7 },
      { provider: 'workers', firmBoundary: 1, bystander: 1, tone: 'firm', stance: 'intimidate', expression: 'angry', escalation: 0.4 },
      { bystanderIntervened: true },
    );
    expect(beat.stance).toBe('back_off');
    expect(beat.rule).toBe(HARASSMENT_RESEARCH.firmBystanderRule);
    expect(beat.rule).toMatch(/no study gives a rate/i);
  });
});

describe('debrief cites the sources', () => {
  const man = (stance: ManStance): ManDecision => ({ stance, action: 'stay', emotion: 'annoyed', emotionIntensity: 0.4, proximity: 2 });

  it('names the 5D the bystander used and links the guide', () => {
    const meta: SessionMeta = { id: 't', pov: 'bystander', seed: 1, createdAt: 0 };
    const log: LogEntry[] = [
      { kind: 'player', t: 1, turn: 1, event: 'speech', text: 'Leave her alone.', strategy: 'direct', target: 'man' },
      { kind: 'player', t: 4, turn: 2, event: 'filming_start' },
      { kind: 'decision', t: 2, turn: 1, man: man('back_off'), fear: 0.2, tension: 0.3, drivers: [] },
      { kind: 'outcome', t: 5, turn: 2, outcome: 'intervened_he_left' },
    ];
    const summary = buildSummary(meta, log, 'intervened_he_left');
    const direct = summary.fiveDs!.find((d) => d.key === 'direct')!;
    const document = summary.fiveDs!.find((d) => d.key === 'document')!;
    const distract = summary.fiveDs!.find((d) => d.key === 'distract')!;
    expect(direct.used).toBe(true);
    expect(direct.moments.join(' ')).toMatch(/Leave her alone/);
    expect(direct.feedback).toMatch(/https:\/\/righttobe\.org\/guides\/bystander-intervention-training/);
    expect(document.used).toBe(true);
    expect(distract.used).toBe(false);
    expect(distract.feedback).toMatch(/Not used/);
    expect(summary.insights.some((i) => /ilr\.cornell\.edu/.test(i.body))).toBe(true);
  });

  it('tells her there is no correct reply, and cites the survey when she set a boundary', () => {
    const meta: SessionMeta = { id: 'w', pov: 'woman', seed: 2, createdAt: 0, disposition: 'persistent' };
    const log: LogEntry[] = [
      { kind: 'player', t: 1, turn: 1, event: 'speech', text: 'Leave me alone.', strategy: 'firm_boundary' },
      { kind: 'decision', t: 2, turn: 1, man: man('guilt'), fear: 0.4, tension: 0.4, drivers: [] },
      { kind: 'outcome', t: 8, turn: 2, outcome: 'he_left' },
    ];
    const summary = buildSummary(meta, log, 'he_left');
    const opening = summary.insights[0];
    expect(opening.title).toMatch(/no right answer/i);
    expect(opening.body).toMatch(/stopstreetharassment\.org/);
    expect(opening.body).toMatch(/31%/);
    expect(summary.fiveDs).toBeUndefined();
  });
});
