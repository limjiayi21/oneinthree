import { describe, expect, it, vi } from 'vitest';
import type { WorldContext } from '../shared/types';
import {
  JUDGE_BUDGET_MS,
  OPENAI_MODEL,
  OPENAI_URL,
  TYPESAFE_MODEL,
  TYPESAFE_URL,
  applyToDecision,
  composeBeat,
  judgeTurn,
  openaiBody,
  parseOpenai,
  parseTypesafe,
  selectJudge,
  typesafeBody,
  type JudgeInput,
  type SeededBeat,
} from './judge';

const ctx: WorldContext = {
  elapsed: 20,
  distanceToMan: 2,
  progress: 0.3,
  playerSpeed: 1,
  facingMan: true,
  manBlocking: false,
  oppositeSidewalk: false,
  filming: false,
  betweenThem: false,
};

const input: JudgeInput = {
  pov: 'woman',
  event: 'speech',
  stance: 'persist',
  text: 'Leave me alone.',
  recent: ['HIM: Where you headed?'],
  ctx,
};

const seeded: SeededBeat = { stance: 'persist', emotion: 'smirk', emotionIntensity: 0.6, action: 'stay', tension: 0.4 };

describe('provider selection', () => {
  it('stays on the seeded model unless a provider and its key are both set', () => {
    expect(selectJudge({})).toBeNull();
    expect(selectJudge({ TYPESAFE_API_KEY: 'ts' })).toBeNull();
    expect(selectJudge({ DECISION_PROVIDER: 'typesafe' })).toBeNull();
    expect(selectJudge({ DECISION_PROVIDER: 'typesafe', TYPESAFE_API_KEY: 'ts' })).toBe('typesafe');
    expect(selectJudge({ DECISION_PROVIDER: 'openai', OPENAI_API_KEY: 'sk' })).toBe('openai');
    expect(selectJudge({ DECISION_PROVIDER: 'seeded', OPENAI_API_KEY: 'sk', TYPESAFE_API_KEY: 'ts' })).toBeNull();
  });
});

describe('request shapes', () => {
  it('asks Jev with noul, choice, and score on one System One call', () => {
    const body = typesafeBody(input);
    expect(body.model).toBe(TYPESAFE_MODEL);
    expect(body.model).toBe('jev-1.14.0');
    const questions = body.questions as Record<string, { type: string; criteria?: unknown }>;
    expect(questions.firm_boundary.type).toBe('noul');
    expect(questions.bystander.type).toBe('noul');
    expect(questions.tone.type).toBe('choice');
    expect(questions.stance.type).toBe('choice');
    expect(questions.expression.type).toBe('choice');
    expect(questions.escalation.type).toBe('score');
    expect(Array.isArray(questions.escalation.criteria)).toBe(true);
    expect(JSON.stringify(body)).toContain('Leave me alone.');
    expect(JSON.stringify(body)).not.toMatch(/Bearer|sk-|ts_live/);
  });

  it('asks gpt-6-luna with predicate, choice, and score questions', () => {
    const body = openaiBody(input);
    expect(body.model).toBe(OPENAI_MODEL);
    expect(body.model).toBe('gpt-6-luna');
    const questions = body.questions as Array<{ type: string; name: string; levels?: unknown; choices?: unknown }>;
    expect(questions.map((q) => q.type)).toEqual(['predicate', 'predicate', 'choice', 'choice', 'choice', 'score']);
    expect(questions.map((q) => q.name)).toEqual(['firm_boundary', 'bystander', 'tone', 'stance', 'expression', 'escalation']);
    const escalation = questions.find((q) => q.name === 'escalation');
    expect(Array.isArray(escalation?.levels)).toBe(true);
    expect((escalation?.levels as unknown[]).length).toBeGreaterThanOrEqual(2);
    expect((escalation?.levels as unknown[]).length).toBeLessThanOrEqual(10);
  });
});

describe('parsing and composition', () => {
  it('reads a TypeSafe answer object and an OpenAI answer array', () => {
    const ts = parseTypesafe({
      answers: {
        firm_boundary: { type: 'noul', noul: 0.91 },
        bystander: { type: 'noul', noul: 0.8 },
        tone: { type: 'choice', choice: 'firm' },
        stance: { type: 'choice', choice: 'intimidate' },
        expression: { type: 'choice', choice: 'smug' },
        escalation: { type: 'score', score: 3 },
      },
    });
    expect(ts?.firmBoundary).toBeCloseTo(0.91);
    expect(ts?.escalation).toBeCloseTo(0.75);
    const oa = parseOpenai({
      answers: [
        { type: 'predicate', name: 'firm_boundary', probability: 0.2 },
        { type: 'predicate', name: 'bystander', probability: 0 },
        { type: 'choice', name: 'tone', choice: 'hostile' },
        { type: 'choice', name: 'stance', choice: 'hostile' },
        { type: 'choice', name: 'expression', choice: 'angry' },
        { type: 'score', name: 'escalation', score: 2 },
      ],
    });
    expect(oa?.stance).toBe('hostile');
    expect(oa?.expression).toBe('angry');
  });

  it('makes him back off when she is firm and a bystander has stepped in', () => {
    const beat = composeBeat(
      seeded,
      { provider: 'openai', firmBoundary: 0.9, bystander: 0.2, tone: 'firm', stance: 'intimidate', expression: 'angry', escalation: 0.8 },
      { bystanderIntervened: true },
    );
    expect(beat.stance).toBe('back_off');
    expect(beat.action).toBe('back_away');
    expect(beat.rule).toMatch(/back off/);
    const decision = applyToDecision({ stance: 'persist', action: 'stay', emotion: 'smirk', emotionIntensity: 0.5, proximity: 1.5 }, beat);
    expect(decision.stance).toBe('back_off');
  });

  it('does not let the provider invent a physical escalation', () => {
    const beat = composeBeat(
      seeded,
      { provider: 'typesafe', firmBoundary: 0, bystander: 0, tone: 'hostile', stance: 'escalate', expression: 'smug', escalation: 1 },
      { bystanderIntervened: false },
    );
    expect(beat.stance).not.toBe('escalate');
    expect(beat.emotion).not.toBe('smirk');
    expect(beat.rule).toMatch(/physical/);
  });

  it('keeps a seeded escalation and clamps a smile off that face', () => {
    const beat = composeBeat(
      { ...seeded, stance: 'escalate', action: 'grab', emotion: 'angry', emotionIntensity: 1, tension: 1 },
      { provider: 'openai', firmBoundary: 0, bystander: 0, tone: 'hostile', stance: 'escalate', expression: 'smug', escalation: 1 },
      { bystanderIntervened: false },
    );
    expect(beat.stance).toBe('escalate');
    expect(beat.action).toBe('grab');
    expect(beat.emotion).toBe('angry');
  });
});

describe('judgeTurn', () => {
  it('posts the TypeSafe body with a bearer token and never returns the key', async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe(TYPESAFE_URL);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ts_live_test');
      const sent = JSON.parse(String(init?.body));
      expect(sent.model).toBe('jev-1.14.0');
      expect(JSON.stringify(sent)).not.toContain('ts_live_test');
      return new Response(
        JSON.stringify({
          answers: {
            firm_boundary: { type: 'noul', noul: 0.4 },
            bystander: { type: 'noul', noul: 0 },
            tone: { type: 'choice', choice: 'calm' },
            stance: { type: 'choice', choice: 'persist' },
            expression: { type: 'choice', choice: 'smug' },
            escalation: { type: 'score', score: 0 },
          },
        }),
        { status: 200 },
      );
    });
    const reading = await judgeTurn({ DECISION_PROVIDER: 'typesafe', TYPESAFE_API_KEY: 'ts_live_test' }, input, fetchImpl);
    expect(reading?.provider).toBe('typesafe');
    expect(reading?.expression).toBe('smug');
  });

  it('posts the OpenAI body and falls back when the call fails or is too slow', async () => {
    const ok = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe(OPENAI_URL);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-test');
      expect(JSON.parse(String(init?.body)).model).toBe('gpt-6-luna');
      return new Response(
        JSON.stringify({
          answers: [
            { type: 'predicate', name: 'firm_boundary', probability: 1 },
            { type: 'predicate', name: 'bystander', probability: 0 },
            { type: 'choice', name: 'tone', choice: 'firm' },
            { type: 'choice', name: 'stance', choice: 'guilt' },
            { type: 'choice', name: 'expression', choice: 'annoyed' },
            { type: 'score', name: 'escalation', score: 1 },
          ],
        }),
        { status: 200 },
      );
    });
    const reading = await judgeTurn({ DECISION_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' }, input, ok);
    expect(reading?.stance).toBe('guilt');

    const fail = vi.fn(async () => new Response('no', { status: 401 }));
    expect(await judgeTurn({ DECISION_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' }, input, fail)).toBeNull();

    const slow = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    });
    const started = Date.now();
    expect(await judgeTurn({ DECISION_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' }, input, slow as typeof fetch)).toBeNull();
    expect(Date.now() - started).toBeLessThan(JUDGE_BUDGET_MS + 250);
  });
});
