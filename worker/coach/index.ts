/**
 * POST /api/coach: runs the debrief coach and streams its progress as NDJSON
 * (shared/coach.ts). Reads each session's summary from its Durable Object;
 * changes nothing in the game.
 *
 * Off (503) unless GEMINI_API_KEY or OPENAI_API_KEY is set (worker/coach/models.ts
 * picks the model; Gemini by default). Each Part 2 session may ask for its debrief twice
 * and up to COACH_LIMITS.questionsPerRun follow-up questions.
 */
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { SummaryData } from '../../shared/types';
import { COACH_LIMITS, type CheckSummary, type CoachEvent, type CoachFile, type CoachRequest, type CoachTodo } from '../../shared/coach';
import type { Env } from '../session';
import { createCoachAgent } from './agent';
import { checkText, formatProblems, removeProblems } from './check';
import { citation, type SearchMode } from './knowledge';
import { createModels, pickProvider, type ModelEnv } from './models';
import { atlasSearch } from './atlas';
import { openDb, type MongoEnv } from '../mongo';
import { saveCoachRun, type CoachRunDoc } from '../runlog';
import { toRunPart, type RunPart } from './run';

export type CoachEnv = Env & ModelEnv & MongoEnv;

const SESSION_ID = /^[a-z0-9-]{8,64}$/i;
const MAX_DEBRIEFS = 2;
const RUN_TIMEOUT_MS = 150_000;
const MAX_REVISIONS = 2;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

/** Validates the body; returns an error message or the cleaned request. */
export function parseCoachRequest(raw: unknown): CoachRequest | string {
  if (!raw || typeof raw !== 'object') return 'Expected a JSON body';
  const r = raw as Record<string, unknown>;
  if (typeof r.bystander !== 'string' || !SESSION_ID.test(r.bystander)) return 'bystander must be a session id';
  if (r.woman !== undefined && (typeof r.woman !== 'string' || !SESSION_ID.test(r.woman))) return 'woman must be a session id';
  const out: CoachRequest = { bystander: r.bystander, woman: r.woman as string | undefined };
  if (r.question !== undefined) {
    if (typeof r.question !== 'string' || !r.question.trim()) return 'question must be text';
    out.question = r.question.trim().slice(0, COACH_LIMITS.questionChars);
    if (!Array.isArray(r.files)) return 'a question needs the files from the debrief';
    let bytes = 0;
    const files: CoachFile[] = [];
    for (const f of r.files as unknown[]) {
      const ff = f as Record<string, unknown>;
      if (typeof ff?.path !== 'string' || typeof ff?.content !== 'string' || !/^\/[a-z0-9_-]+\.md$/i.test(ff.path)) return 'files must be {path, content} markdown files';
      bytes += ff.content.length;
      files.push({ path: ff.path, content: ff.content });
    }
    if (bytes > COACH_LIMITS.filesBytes || files.length > 6) return 'files are too large';
    out.files = files;
  }
  return out;
}

async function summaryOf(env: Env, id: string): Promise<SummaryData | null> {
  const res = await env.SESSION.get(env.SESSION.idFromName(id)).fetch(new Request(`https://session/api/session/${id}/summary`));
  if (!res.ok) return null;
  return (await res.json()) as SummaryData;
}

/** Counts a use against the session (internal route, not reachable from outside). */
async function countUse(env: Env, id: string, kind: 'debrief' | 'question'): Promise<number> {
  const res = await env.SESSION.get(env.SESSION.idFromName(id)).fetch(new Request(`https://session/api/session/${id}/coachuse`, { method: 'POST', body: JSON.stringify({ kind }) }));
  if (!res.ok) return Number.POSITIVE_INFINITY;
  return ((await res.json()) as { count: number }).count;
}

type FileMap = Record<string, { content: string | string[]; mimeType?: string; created_at?: string; modified_at?: string }>;

const fileText = (files: FileMap | undefined, path: string): string => {
  const f = files?.[path];
  if (!f) return '';
  return Array.isArray(f.content) ? f.content.join('\n') : String(f.content ?? '');
};

const toFileMap = (files: CoachFile[] = []): FileMap => {
  const now = new Date().toISOString();
  return Object.fromEntries(files.map((f) => [f.path, { content: f.content, mimeType: 'text/markdown', created_at: now, modified_at: now }]));
};

const fromFileMap = (files: FileMap | undefined): CoachFile[] =>
  Object.keys(files ?? {})
    .filter((p) => /^\/[a-z0-9_-]+\.md$/i.test(p))
    .map((p) => ({ path: p, content: fileText(files, p).slice(0, 20_000) }));

const lastText = (messages: BaseMessage[]): string => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m._getType() === 'ai' && typeof m.content === 'string' && m.content.trim()) return m.content.trim();
  }
  return '';
};

export async function handleCoach(request: Request, env: CoachEnv, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const provider = pickProvider(env);
  if (!provider) return json({ error: 'The coach is not switched on' }, 503);
  const req = parseCoachRequest(await request.json().catch(() => null));
  if (typeof req === 'string') return json({ error: req }, 400);

  const [part2, part1] = await Promise.all([summaryOf(env, req.bystander), req.woman ? summaryOf(env, req.woman) : Promise.resolve(null)]);
  if (!part2 || part2.pov !== 'bystander') return json({ error: 'Unknown Part 2 session' }, 404);

  const kind = req.question ? 'question' : 'debrief';
  const used = await countUse(env, req.bystander, kind);
  const limit = kind === 'question' ? COACH_LIMITS.questionsPerRun : MAX_DEBRIEFS;
  if (used > limit) return json({ error: kind === 'question' ? 'No questions left for this run' : 'The debrief was already written' }, 429);
  const questionsLeft = kind === 'question' ? Math.max(0, limit - used) : COACH_LIMITS.questionsPerRun;

  const parts: RunPart[] = [...(part1 && part1.pov === 'woman' ? [toRunPart(part1)] : []), toRunPart(part2)];
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  let closed = false;
  const send = (ev: CoachEvent): void => {
    if (closed) return;
    void writer.write(enc.encode(`${JSON.stringify(ev)}\n`)).catch(() => (closed = true));
  };

  const { model, embed, embedName, name: modelName, middleware } = createModels(env, provider);

  const work = (async () => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), RUN_TIMEOUT_MS);
    // MongoDB, when configured: one connection for the whole run (the research search and saving the result).
    const mongo = await openDb(env, 'coach');
    const started = Date.now();
    const searches: Record<string, number> = {};
    let outcome: Pick<CoachRunDoc, 'ok' | 'cited' | 'checked'> = { ok: false, cited: [] };
    try {
      const vector = mongo ? atlasSearch(mongo.db, embed, embedName, (text) => send({ type: 'step', who: 'evidence-researcher', text })) : undefined;
      // Say so (once) if Atlas could not answer and the in-memory search stood in, e.g. while the index is still building.
      let toldFallback = false;
      const onSearch = (mode: SearchMode): void => {
        searches[mode] = (searches[mode] ?? 0) + 1;
        if (!vector || mode === 'atlas' || toldFallback) return;
        toldFallback = true;
        send({ type: 'step', who: 'evidence-researcher', text: 'Atlas is not ready yet (its index is still building), so this search ran in memory' });
      };
      const { agent, progress } = createCoachAgent({ model, embed, vector, onSearch, middleware, parts, onEvent: send }, kind === 'question' ? 'followup' : 'debrief');
      const config = { recursionLimit: 80, callbacks: [progress], signal: abort.signal };
      const target = kind === 'question' ? '/answer.md' : '/debrief.md';
      const ask = kind === 'question' ? `My question: ${req.question}` : 'Write my debrief.';
      send({ type: 'step', who: 'coach', text: kind === 'question' ? 'Thinking about your question' : 'Starting your debrief' });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let state: any = await agent.invoke({ messages: [new HumanMessage(ask)], files: toFileMap(req.files) } as never, config);
      let text = fileText(state.files, target) || lastText(state.messages);
      let check = checkText(text);
      let revisions = 0;
      // The coach is told to pass check_draft; if what it left still fails, send it back with the problems.
      while (!check.ok && revisions < MAX_REVISIONS && text) {
        revisions++;
        send({ type: 'step', who: 'coach', text: `The final check found ${check.problems.length} claim${check.problems.length === 1 ? '' : 's'} to fix. Revising` });
        state = await agent.invoke(
          { messages: [...state.messages, new HumanMessage(`The final check of ${target} failed. Fix these in ${target}, run check_draft, then finish:\n${formatProblems(check.problems)}`)], files: state.files, todos: state.todos } as never,
          config,
        );
        text = fileText(state.files, target) || lastText(state.messages);
        check = checkText(text);
      }
      let removed = 0;
      if (!check.ok) ({ markdown: text, removed } = removeProblems(text, check.problems));
      if (!text) throw new Error('the coach did not produce any text');
      const final = checkText(text);
      if (Array.isArray(state.todos) && state.todos.length && revisions + removed > 0) send({ type: 'plan', todos: (state.todos as CoachTodo[]).map((t) => ({ content: String(t.content), status: t.status })) });
      const checked: CheckSummary = { claims: final.claims, revisions, removed };
      send({ type: 'result', kind: kind === 'question' ? 'answer' : 'debrief', markdown: text, citations: final.cited.map((id) => citation(id)).filter((c) => c !== null), checked });
      outcome = { ok: true, cited: final.cited, checked };
      send({ type: 'done', files: fromFileMap(state.files), questionsLeft });
    } catch (err) {
      console.error('[coach] failed', err);
      send({ type: 'error', message: abort.signal.aborted ? 'The coach took too long.' : 'The coach could not finish.' });
    } finally {
      clearTimeout(timer);
      if (mongo) {
        // What the coach did, never what it wrote (worker/runlog.ts).
        const doc: CoachRunDoc = { session: req.bystander, kind: kind === 'question' ? 'answer' : 'debrief', model: modelName, embedModel: embedName, searches, ...outcome, ms: Date.now() - started, at: new Date() };
        await saveCoachRun(mongo.db, doc).catch((err) => console.warn('[coach] could not log the run', err instanceof Error ? err.message : err));
        await mongo.close();
      }
      closed = true;
      await writer.close().catch(() => {});
    }
  })();
  ctx.waitUntil(work);
  return new Response(readable, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}
