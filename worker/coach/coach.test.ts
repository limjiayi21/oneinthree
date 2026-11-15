import { describe, expect, it } from 'vitest';
import type { SummaryData } from '../../shared/types';
import { checkText, figures, removeProblems } from './check';
import { PASSAGES, PASSAGE_BY_ID, citation, keywordSearch, searchPassages } from './knowledge';
import { momentDetail, overview, toRunPart } from './run';
import { parseCoachRequest } from './index';
import { plainPlanText } from './agent';
import { collectionName, indexDefinition, passagesHash } from './atlas';

const stat = PASSAGES.find((p) => p.kind === 'stat' && /%/.test(p.headline ?? ''))!;
const pct = stat.headline!;

describe('grounding check', () => {
  it('passes a figure that appears in the passage cited in the same sentence', () => {
    const r = checkText(`Only ${pct} of people said this [${stat.id}].`);
    expect(r.ok).toBe(true);
    expect(r.cited).toEqual([stat.id]);
    expect(r.claims).toBe(2);
  });

  it('fails an invented figure, an uncited figure and an unknown citation', () => {
    const r = checkText(`About 97% of people agree [${stat.id}]. Most bystanders, 42%, look away. Help matters [not_a_real_id].`);
    expect(r.ok).toBe(false);
    const issues = r.problems.map((p) => p.issue).join(' | ');
    expect(issues).toMatch(/"97%" does not appear/);
    expect(issues).toMatch(/"42%" has no citation/);
    expect(issues).toMatch(/not_a_real_id/);
  });

  it('does not treat times, moments, parts or the 5 Ds as figures', () => {
    expect(figures('At moment 12, at 14s, in Part 2, you used two of the 5 Ds in 30 seconds.')).toEqual([]);
    expect(figures('One in three women [x] and 25 percent.')).toEqual(['1 in 3', '25%']);
  });

  it('removes the sentences that still fail and keeps the rest', () => {
    const md = `## What you did\nYou called the shopkeeper. That helped 99% of the time.\nThen you checked on her.`;
    const r = checkText(md);
    const { markdown, removed } = removeProblems(md, r.problems);
    expect(removed).toBe(1);
    expect(markdown).toContain('You called the shopkeeper.');
    expect(markdown).toContain('Then you checked on her.');
    expect(markdown).not.toContain('99%');
  });
});

describe('research base', () => {
  it('has every kind of passage, with unique ids', () => {
    expect(new Set(PASSAGES.map((p) => p.kind))).toEqual(new Set(['stat', 'harasser', 'bystander', 'five_d']));
    expect(PASSAGE_BY_ID.size).toBe(PASSAGES.length);
  });

  it('finds the 5 Ds and bystander findings by keyword', () => {
    expect(keywordSearch('delegate ask a shop worker for help', 5).map((p) => p.id)).toContain('five_d_delegate');
    expect(keywordSearch('nobody helped bystanders', 5).some((p) => p.kind === 'bystander' || p.topic === 'bystander')).toBe(true);
  });

  it('falls back to keywords when embeddings fail', async () => {
    const r = await searchPassages('direct intervention risk', 3, async () => {
      throw new Error('offline');
    });
    expect(r.mode).toBe('keyword');
    expect(r.hits.length).toBeGreaterThan(0);
  });

  it('uses Atlas first and blends in keyword hits', async () => {
    const atlasHit = PASSAGE_BY_ID.get('five_d_delay')!;
    const r = await searchPassages('ask a shop worker to help', 4, undefined, async () => [atlasHit]);
    expect(r.mode).toBe('atlas');
    expect(r.hits[0].id).toBe('five_d_delay');
    expect(r.hits.map((p) => p.id)).toContain('five_d_delegate');
    expect(new Set(r.hits.map((p) => p.id)).size).toBe(r.hits.length);
  });

  it('falls back from Atlas when it has nothing or fails', async () => {
    expect((await searchPassages('direct intervention risk', 3, undefined, async () => null)).mode).toBe('keyword');
    const failing = async (): Promise<never> => {
      throw new Error('down');
    };
    expect((await searchPassages('direct intervention risk', 3, undefined, failing)).mode).toBe('keyword');
  });

  it('names one Atlas collection per embedding model and hashes the research stably', async () => {
    expect(collectionName('text-embedding-3-small')).toBe('research_text_embedding_3_small');
    expect(collectionName('gemini-embedding-001')).toBe('research_gemini_embedding_001');
    const h = await passagesHash();
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await passagesHash()).toBe(h);
    expect(await passagesHash(PASSAGES.slice(1))).not.toBe(h);
    expect(indexDefinition(1536).fields[0]).toMatchObject({ type: 'vector', numDimensions: 1536, similarity: 'cosine' });
  });

  it('resolves a citation with its source', () => {
    const c = citation(stat.id)!;
    expect(c.headline).toBe(pct);
    expect(c.source?.publisher).toBeTruthy();
    expect(citation('nope')).toBeNull();
  });
});

const SUMMARY: SummaryData = {
  pov: 'bystander',
  outcome: { kind: 'intervened_he_left', title: 'He left.', body: 'You stepped in and he walked off.' },
  durationSec: 74.4,
  timeline: [
    { t: 3, actor: 'man', text: 'Hey beautiful, where you going?' },
    { t: 6, actor: 'woman', text: 'Leave me alone.' },
    { t: 9, actor: 'you', text: 'Asked the shopkeeper for help', label: 'Delegate' },
    { t: 11, actor: 'clerk', text: 'Everything okay out here?' },
    { t: 12, actor: 'man', text: 'Mind your business.', label: 'Hostile', rationale: { text: 'Called out in front of a witness, he pushes back first.', basis: 'inferred', sourceIds: [] } },
    { t: 20, actor: 'you', text: '"Back off, creep."', label: 'Insult' },
    { t: 22, actor: 'man', text: 'Whatever.', label: 'Leaves' },
  ],
  insights: [],
  statIds: [],
  fiveDs: [{ key: 'delegate', used: true, moments: ['Asked the shopkeeper for help'], feedback: 'Good use of the space.' }],
  modelNotes: [],
};

describe('the run as the coach sees it', () => {
  it('numbers the moments and keeps what came before and after', () => {
    const part = toRunPart(SUMMARY);
    expect(part.moments).toHaveLength(2);
    expect(part.moments[0]).toMatchObject({ n: 1, t: 9, you: 'Asked the shopkeeper for help', label: 'Delegate' });
    expect(part.moments[0].before).toEqual(['Him: Hey beautiful, where you going?', 'Her: Leave me alone.']);
    expect(part.moments[0].why).toMatch(/witness/);
    expect(part.moments[1].after).toEqual(['Him: Whatever. (Leaves)']);
  });

  it('gives an overview and a full moment', () => {
    const parts = [toRunPart(SUMMARY)];
    expect(overview(parts)).toMatch(/Outcome: He left\./);
    expect(overview(parts)).toMatch(/delegate used/);
    expect(momentDetail(parts, 2, 2)).toMatch(/You: "Back off, creep\." \(read as: Insult\)/);
    expect(momentDetail(parts, 1, 1)).toMatch(/No moment/);
  });
});

describe('request validation', () => {
  const id = '0f3c2a1e-1111-4222-8333-944455556666';
  it('accepts a debrief request and a question with files', () => {
    expect(parseCoachRequest({ bystander: id })).toEqual({ bystander: id, woman: undefined });
    const q = parseCoachRequest({ bystander: id, question: '  What else could I do? ', files: [{ path: '/notes.md', content: 'x' }] });
    expect(q).toMatchObject({ question: 'What else could I do?', files: [{ path: '/notes.md', content: 'x' }] });
  });

  it('rejects bad ids, questions without files and odd file paths', () => {
    expect(parseCoachRequest({ bystander: '../x' })).toMatch(/session id/);
    expect(parseCoachRequest({ bystander: id, question: 'Hi' })).toMatch(/files/);
    expect(parseCoachRequest({ bystander: id, question: 'Hi', files: [{ path: '../etc', content: '' }] })).toMatch(/markdown/);
  });
});

describe('model setup', () => {
  it('rewrites tool schemas into the subset Gemini accepts', async () => {
    const { geminiSchema } = await import('./models');
    const out = geminiSchema({
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'dir' },
        glob: { type: ['string', 'null'] },
        n: { type: 'integer', exclusiveMinimum: 0 },
        tags: { type: 'array', items: { type: 'string', pattern: 'x' } },
      },
      required: ['n'],
    });
    expect(out).toEqual({
      type: 'object',
      properties: {
        path: { type: 'string', nullable: true, description: 'dir' },
        glob: { type: 'string', nullable: true },
        n: { type: 'integer', minimum: 0 },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['n'],
    });
  });

  it('picks Gemini when its key is set, OpenAI otherwise, and nothing without keys', async () => {
    const { pickProvider } = await import('./models');
    expect(pickProvider({ GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o' })).toBe('gemini');
    expect(pickProvider({ GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o', COACH_PROVIDER: 'openai' })).toBe('openai');
    expect(pickProvider({ OPENAI_API_KEY: 'o' })).toBe('openai');
    expect(pickProvider({})).toBeNull();
  });

  it('tries Gemini first, then OpenAI as the fallback', async () => {
    const { pickProviders } = await import('./models');
    expect(pickProviders({ GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o' })).toEqual(['gemini', 'openai']);
    expect(pickProviders({ GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o', COACH_PROVIDER: 'gemini' })).toEqual(['gemini', 'openai']);
    expect(pickProviders({ GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o', COACH_PROVIDER: 'openai' })).toEqual(['openai', 'gemini']);
    expect(pickProviders({ GEMINI_API_KEY: 'g' })).toEqual(['gemini']);
    expect(pickProviders({})).toEqual([]);
  });
});

describe('the plan the player sees', () => {
  it('keeps file and tool names out of it', () => {
    expect(plainPlanText('Write a concise answer to /answer.md and verify it with check_draft')).toBe('Write a concise answer and check it against the research');
    expect(plainPlanText('Read the existing notes and debrief for this run')).toBe('Read the existing notes and debrief for this run');
    expect(plainPlanText('Use get_moment for moment 2')).toBe('Use for moment 2');
  });
});
