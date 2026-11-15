/**
 * SessionDO: one SQLite-backed Durable Object per session.
 *
 * It owns everything about a session: the decision model's state and seeded
 * RNG, the transcript, the log the summary is built from, and the live audio
 * streams. State is persisted after every turn, so a session survives
 * eviction; hot state stays in memory between requests.
 *
 * A turn is answered as a progressive NDJSON stream, in this order:
 *   heard -> read -> decision -> line(s) -> thought -> outcome -> done
 */
import { DurableObject } from 'cloudflare:workers';
import type {
  ClientEventType,
  CreateSessionRequest,
  CreateSessionResponse,
  Emotion,
  ManDecision,
  ManStance,
  OutcomeKind,
  SpeechSource,
  TurnEvent,
  TurnRequest,
  WomanStrategy,
  WorldContext,
} from '../shared/types';
import { pickBank, scriptLine, scriptedSoFar, type BankEntry } from './linebank';
import type { LogEntry, SessionMeta } from './log';
import { decideBystander, initialBystanderState, type BystanderOutput, type BystanderState, type LineCue } from './model/bystander';
import { Rng, hashSeed } from './model/rng';
import { decideWoman, drawDisposition, initialWomanState, type WomanState } from './model/woman';
import {
  buildBystanderRead,
  buildWomanRead,
  heuristicBystanderRead,
  applyWomanRules,
  heuristicWomanRead,
  parseBystanderRead,
  parseWomanRead,
  runClef,
  type BystanderRead,
  type WomanRead,
} from './read';
import { cleanInterrupted, markCutOff } from './cutoff';
import { askedIn, emptyStory, noteHer, noteHim, noteOther, storyBrief, type Story } from './story';
import { transcribe } from './stt';
import { buildSummary } from './summary';
import { LiveAudio, startTts, type AudioSpec } from './tts';
import { voUrl, type Delivery } from './voices';
import { cleanGuidedChoices, isOutcome, recordPlaythrough, tacticsFromLog } from './stats';
import { BYSTANDER_SYSTEM, WOMAN_SYSTEM, bystanderUserPrompt, cleanLine, womanUserPrompt, writeFields, type WriteResult } from './write';

export interface Env {
  AI: Ai;
  SESSION: DurableObjectNamespace<SessionDO>;
  PHONE: DurableObjectNamespace;
  ASSETS: Fetcher;
  ELEVENLABS_API_KEY?: string;
  /** Aggregate playthrough counts (worker/stats.ts). Optional: without it nothing is logged. */
  DB?: D1Database;
  /** Shared code that unlocks GET /api/stats. Without it the endpoint is off. */
  STATS_CODE?: string;
}

interface Persisted {
  meta: SessionMeta;
  rng: number;
  turn: number;
  woman?: WomanState;
  bystander?: BystanderState;
  /** Recent lines, oldest first, e.g. "HIM: Where you headed?" */
  transcript: string[];
  usedBank: string[];
  hisLines: string[];
  thoughts: string[];
  lastMan: ManDecision | null;
  outcome: OutcomeKind | null;
  /** The whole encounter in one place: every line, what she told him, what he has asked (worker/story.ts). */
  story?: Story;
}

const CLIENT_EVENTS: ClientEventType[] = [
  'begin',
  'speech',
  'silence',
  'sped_up',
  'stopped',
  'crossed_street',
  'pushed_past',
  'backed_away',
  'entered_shop',
  'reached_home',
  'beat',
  'approached',
  'stood_between',
  'filming_start',
  'filming_stop',
  'asked_clerk',
  'walked_past',
  'left_scene',
  'scene_timeout',
];

/** Stances whose line always comes from the pre-rendered bank. */
const FIXED_COPY_STANCES: ManStance[] = ['opening', 'escalate', 'gone', 'idle'];

/** Fields from the line model, held back until the turn knows it wants them. */
class DeferredFields {
  private held: Array<[string, string, number]> = [];
  private sink: ((key: string, value: string, at: number) => void) | null = null;

  push(key: string, value: string): void {
    const at = Date.now();
    if (this.sink) this.sink(key, value, at);
    else this.held.push([key, value, at]);
  }

  adopt(sink: (key: string, value: string, at: number) => void): void {
    this.sink = sink;
    for (const [key, value, at] of this.held.splice(0)) sink(key, value, at);
  }
}

interface LineJob {
  stance: ManStance;
  level?: number;
  fields: DeferredFields;
  result: Promise<WriteResult>;
  abort: AbortController;
  started: number;
}

/** How long `done` will wait for the first audio byte so the turn can report it. */
const AUDIO_WAIT_MS = 1500;
const MAX_LIVE_AUDIO = 24;
const MAX_CLIP_BYTES = 4 * 1024 * 1024;

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

function normaliseCtx(raw: unknown): WorldContext {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const looking = c.lookingAt;
  return {
    elapsed: Math.max(0, num(c.elapsed, 0)),
    distanceToMan: Math.max(0, num(c.distanceToMan, 99)),
    progress: Math.min(1, Math.max(0, num(c.progress, 0))),
    playerSpeed: Math.max(0, num(c.playerSpeed, 0)),
    facingMan: Boolean(c.facingMan),
    manBlocking: Boolean(c.manBlocking),
    oppositeSidewalk: Boolean(c.oppositeSidewalk),
    distanceToWoman: c.distanceToWoman === undefined ? undefined : Math.max(0, num(c.distanceToWoman, 99)),
    lookingAt: looking === 'man' || looking === 'woman' || looking === 'clerk' || looking === 'nobody' ? looking : undefined,
    filming: c.filming === undefined ? undefined : Boolean(c.filming),
    betweenThem: c.betweenThem === undefined ? undefined : Boolean(c.betweenThem),
    beat: typeof c.beat === 'string' ? c.beat.slice(0, 40) : undefined,
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

export class SessionDO extends DurableObject<Env> {
  private s: Persisted | null = null;
  private audio = new Map<string, LiveAudio>();
  private queue: Promise<void> = Promise.resolve();
  /** How the current turn's words arrived. Turns run one at a time, so a field is enough. */
  private turnVia: { via: SpeechSource; interrupted?: { line: string; heard: string } } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS log (seq INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS audio (id TEXT PRIMARY KEY, spec TEXT NOT NULL)');
    const row = sql.exec('SELECT v FROM state WHERE k = ?', 'session').toArray()[0];
    if (row && typeof row.v === 'string') {
      try {
        this.s = JSON.parse(row.v) as Persisted;
      } catch {
        this.s = null;
      }
    }
  }

  private get voice(): boolean {
    return Boolean(this.env.ELEVENLABS_API_KEY);
  }

  private save(): void {
    if (this.s) this.ctx.storage.sql.exec('INSERT INTO state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', 'session', JSON.stringify(this.s));
  }

  private log(entry: LogEntry): void {
    // Exact record of how her words arrived (and whether she cut him off), attached to the player row.
    if (entry.kind === 'player' && entry.event === 'speech' && this.turnVia) entry = { ...entry, ...this.turnVia };
    this.ctx.storage.sql.exec('INSERT INTO log (data) VALUES (?)', JSON.stringify(entry));
  }

  private readLog(): LogEntry[] {
    const out: LogEntry[] = [];
    for (const row of this.ctx.storage.sql.exec('SELECT data FROM log ORDER BY seq')) {
      try {
        out.push(JSON.parse(String(row.data)) as LogEntry);
      } catch {
        /* skip a damaged row */
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ routing */

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean); // api, session, :id, ...
    const action = parts[3] ?? '';

    if (action === 'init' && request.method === 'POST') return this.init(request, parts[2] ?? '');
    if (!this.s) return json({ error: 'Unknown session' }, 404);
    if (action === 'turn' && request.method === 'POST') return this.handleTurn(request);
    if (action === 'summary' && request.method === 'GET') return json(buildSummary(this.s.meta, this.readLog(), this.s.outcome));
    if (action === 'audio' && request.method === 'GET') return this.serveAudio(parts[4] ?? '');
    if (action === 'guided' && request.method === 'POST') return this.recordGuided(request);
    // Internal only (the coach, worker/coach/): counts its uses per session. Not routed from outside.
    if (action === 'coachuse' && request.method === 'POST') return this.countCoachUse(request);
    return json({ error: 'Not found' }, 404);
  }

  private async countCoachUse(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { kind?: unknown };
    const key = body.kind === 'question' ? 'coach_questions' : 'coach_debriefs';
    const row = this.ctx.storage.sql.exec('SELECT v FROM state WHERE k = ?', key).toArray()[0];
    const count = (row ? Number(row.v) || 0 : 0) + 1;
    this.ctx.storage.sql.exec('INSERT INTO state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', key, String(count));
    return json({ count });
  }

  private async init(request: Request, id: string): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as Partial<CreateSessionRequest>;
    const pov = body.pov === 'bystander' ? 'bystander' : 'woman';
    const seed = typeof body.seed === 'number' && Number.isFinite(body.seed) ? Math.floor(Math.abs(body.seed)) >>> 0 : (hashSeed(id) ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
    const rng = new Rng(seed);
    const meta: SessionMeta = { id, pov, seed, createdAt: Date.now() };
    const s: Persisted = { meta, rng: 0, turn: 0, transcript: [], usedBank: [], hisLines: [], thoughts: [], lastMan: null, outcome: null, story: emptyStory() };
    if (pov === 'woman') {
      const disposition = drawDisposition(rng);
      meta.disposition = disposition;
      s.woman = initialWomanState(disposition, { golden: body.run === 'golden', demo: body.demo === true });
      if (body.run === 'golden') meta.run = 'golden';
    } else {
      s.bystander = initialBystanderState();
    }
    s.rng = rng.state;
    this.s = s;
    this.ctx.storage.sql.exec('DELETE FROM log');
    this.ctx.storage.sql.exec('DELETE FROM audio');
    this.save();
    const res: CreateSessionResponse = { sessionId: id, pov, voice: this.voice };
    return json(res);
  }

  /* ------------------------------------------------------------------ audio */

  /** Start voicing a line now and return the URL the client will GET. Empty string when voice is unavailable. */
  private speak(lineId: string, spec: AudioSpec): { url: string; live: LiveAudio | null } {
    const key = this.env.ELEVENLABS_API_KEY;
    if (!key || !this.s) return { url: '', live: null };
    this.ctx.storage.sql.exec('INSERT INTO audio (id, spec) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET spec = excluded.spec', lineId, JSON.stringify(spec));
    const live = startTts(key, spec);
    this.remember(lineId, live);
    return { url: `/api/session/${this.s.meta.id}/audio/${lineId}`, live };
  }

  private remember(lineId: string, live: LiveAudio): void {
    this.audio.delete(lineId);
    this.audio.set(lineId, live);
    while (this.audio.size > MAX_LIVE_AUDIO) {
      const oldest = this.audio.keys().next().value;
      if (oldest === undefined) break;
      this.audio.delete(oldest);
    }
  }

  private async serveAudio(lineId: string): Promise<Response> {
    if (!/^[a-z0-9_-]{1,40}$/i.test(lineId)) return json({ error: 'Not found' }, 404);
    let live = this.audio.get(lineId);
    if (!live || live.failed) {
      // Evicted since the line was written (or the first attempt failed): voice it again from the stored text.
      const key = this.env.ELEVENLABS_API_KEY;
      const row = this.ctx.storage.sql.exec('SELECT spec FROM audio WHERE id = ?', lineId).toArray()[0];
      if (!key || !row) return json({ error: 'Not found' }, 404);
      live = startTts(key, JSON.parse(String(row.spec)) as AudioSpec);
      this.remember(lineId, live);
    }
    if (!(await live.ready())) return json({ error: 'Voice unavailable' }, 502);
    return new Response(live.stream(), {
      headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    });
  }

  /* ------------------------------------------------------------------ turns */

  private async handleTurn(request: Request): Promise<Response> {
    const received = Date.now();
    let req: TurnRequest;
    let clip: Blob | null = null;
    let filename = 'clip.webm';
    try {
      const type = request.headers.get('content-type') ?? '';
      if (type.includes('multipart/form-data')) {
        const form = await request.formData();
        const meta = form.get('meta');
        req = JSON.parse(typeof meta === 'string' ? meta : '{}') as TurnRequest;
        const file = form.get('audio') as unknown;
        if (file && typeof file === 'object' && 'arrayBuffer' in (file as object)) {
          clip = file as Blob;
          const name = (file as { name?: unknown }).name;
          if (typeof name === 'string' && name) filename = name;
        }
      } else {
        req = (await request.json()) as TurnRequest;
      }
    } catch {
      return json({ error: 'Malformed turn request' }, 400);
    }
    if (!req || !CLIENT_EVENTS.includes(req.event)) return json({ error: 'Unknown event' }, 400);
    if (clip && clip.size > MAX_CLIP_BYTES) return json({ error: 'Audio clip too large' }, 413);
    const turnReq: TurnRequest = {
      event: req.event,
      ctx: normaliseCtx(req.ctx),
      text: typeof req.text === 'string' ? req.text.slice(0, 600) : undefined,
      data: req.data,
      source: clip ? 'ptt' : req.source === 'typed' ? 'typed' : undefined,
      interrupted: cleanInterrupted(req.interrupted),
    };

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const emit = (ev: TurnEvent): void => {
      void writer.write(encoder.encode(`${JSON.stringify(ev)}\n`)).catch(() => {});
    };
    const run = async (): Promise<void> => {
      try {
        await this.runTurn(turnReq, clip, filename, emit, received);
      } catch (err) {
        emit({ type: 'error', message: `Turn failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`, recoverable: true });
        emit({ type: 'done', turn: this.s?.turn ?? 0, ms: { total: Date.now() - received } });
      } finally {
        this.save();
        await writer.close().catch(() => {});
      }
    };
    // One turn at a time, in arrival order.
    this.queue = this.queue.then(run, run);
    this.ctx.waitUntil(this.queue);
    return new Response(readable, {
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' },
    });
  }

  private async runTurn(req: TurnRequest, clip: Blob | null, filename: string, emit: (ev: TurnEvent) => void, received: number): Promise<void> {
    const s = this.s as Persisted;
    const ms: Record<string, number> = {};
    const turn = ++s.turn;
    const finish = () => {
      ms.total = Date.now() - received;
      emit({ type: 'done', turn, ms });
    };
    if (s.outcome) return finish();

    let event = req.event;
    let text = (req.text ?? '').trim();
    if (event === 'speech') {
      if (clip) {
        const key = this.env.ELEVENLABS_API_KEY;
        const t0 = Date.now();
        if (key) {
          try {
            text = await transcribe(key, clip, filename);
          } catch (err) {
            text = '';
            emit({ type: 'error', message: `Could not transcribe the clip (${String((err as Error)?.message ?? err).slice(0, 80)}).`, recoverable: true });
          }
        } else {
          text = '';
          emit({ type: 'error', message: 'Voice is unavailable on this server: type instead (T).', recoverable: true });
        }
        ms.stt = Date.now() - t0;
        emit({ type: 'heard', text });
      }
      // An empty transcript is silence.
      if (!text) event = 'silence';
    }
    if (event === 'speech' && req.interrupted) {
      markCutOff(s.transcript, req.interrupted);
      if (s.story) markCutOff(s.story.lines, req.interrupted);
    }
    this.turnVia = event === 'speech' ? { via: req.source ?? 'typed', ...(req.interrupted ? { interrupted: req.interrupted } : {}) } : null;

    if (s.meta.pov === 'woman') await this.womanTurn(s, event, text, req.ctx, turn, ms, emit, received);
    else await this.bystanderTurn(s, event, text, req.ctx, turn, ms, emit, received);
    finish();
  }

  /* ------------------------------------------------------------------ woman POV */

  private async womanTurn(
    s: Persisted,
    event: ClientEventType,
    text: string,
    ctx: WorldContext,
    turn: number,
    ms: Record<string, number>,
    emit: (ev: TurnEvent) => void,
    received: number,
  ): Promise<void> {
    const state = s.woman as WomanState;
    const rng = new Rng(s.rng);
    // Wording choices draw from their own stream, so the decisions replay under a fixed seed whichever path writes the line.
    const copy = copyRng(s.meta.seed, turn);
    const t = ctx.elapsed;

    // Start writing his line before Clef has answered, on a quick keyword guess at her words. If the real
    // decision lands on the same stance (it usually does) the line is already on its way; if not, it is dropped.
    let early: LineJob | null = null;
    if (event === 'speech') {
      s.transcript.push(`HER: ${text}`);
      s.story = noteHer(s.story ?? emptyStory(), text);
      if (this.env.AI) {
        const guess = applyWomanRules(text, heuristicWomanRead(text));
        const trial = decideWoman(state, { event, ctx, strategyProbs: guess.strategyProbs, signals: guess.signals }, new Rng(s.rng));
        if (trial.decision && trial.speak && !FIXED_COPY_STANCES.includes(trial.decision.stance)) {
          early = this.startWomanLine(s, trial.decision, trial.strategy, event, text, ctx, copy);
        }
      }
    }

    let read: WomanRead | null = null;
    if (event === 'speech') {
      const t0 = Date.now();
      try {
        const res = await runClef(this.env.AI, buildWomanRead({ text, ctx, stance: state.stance, recent: s.transcript.slice(0, -1) }));
        read = parseWomanRead(res.answers, res.selector);
        if (read && res.selector !== 'clef') ms.readFast = 1;
      } catch {
        read = null;
      }
      if (!read) {
        read = heuristicWomanRead(text);
        ms.fallbackRead = 1;
      }
      read = applyWomanRules(text, read);
      ms.read = Date.now() - t0;
      emit({ type: 'read', strategy: read.strategy, confidence: round(read.confidence), probs: roundAll(read.strategyProbs) });
    }

    const t1 = Date.now();
    const out = decideWoman(state, { event, ctx, strategyProbs: read?.strategyProbs, signals: read?.signals, reaction: read?.reaction }, rng);
    ms.decide = Date.now() - t1;
    s.woman = out.state;
    s.rng = rng.state;

    const acted = out.decision !== null || out.outcome !== undefined;
    if (event !== 'speech' && event !== 'begin' && event !== 'reached_home' && acted) {
      emit({ type: 'read', strategy: out.strategy, confidence: 1, probs: { [out.strategy]: 1 } });
    }
    this.log({
      kind: 'player',
      t,
      turn,
      event,
      text: event === 'speech' ? text : undefined,
      strategy: event === 'begin' || event === 'reached_home' ? undefined : out.strategy,
      confidence: read ? round(read.confidence) : undefined,
      source: read ? read.source : 'event',
    });

    const usable = early !== null && out.decision !== null && out.speak && out.decision.stance === early.stance && out.decision.level === early.level;
    if (early && !usable) {
      early.abort.abort();
      ms.specMiss = 1;
      early = null;
    }

    if (out.decision) {
      const d = out.decision;
      s.lastMan = d;
      emit({ type: 'decision', man: d, fear: out.fear, tension: out.tension, rationale: out.rationale });
      this.log({ kind: 'decision', t, turn, man: d, fear: out.fear, tension: out.tension, rationale: out.rationale, drivers: out.drivers });

      const thoughtEmotion: Emotion = d.stance === 'back_off' ? 'worried' : out.fear >= 0.6 ? 'afraid' : 'worried';
      const fromBank = (fallback: boolean) => {
        const entry = pickBank('woman', d.stance, copy, s.usedBank, this.reasks(s));
        if (fallback) ms.fallbackLine = 1;
        else ms.bankLine = 1;
        if (out.speak) this.emitBankLine(s, entry, 'man', d.emotion, out.delivery, turn, t, emit);
        this.emitBankThought(s, entry, out.fear, turn, t, emit);
      };

      if (!out.speak) {
        // He says nothing this beat (he is only trailing her): she still reacts.
        if (d.stance === 'follow') fromBank(false);
      } else if (FIXED_COPY_STANCES.includes(d.stance) || !this.env.AI) {
        // Pre-rendered on purpose: the opening answers 'begin' with no latency, and the moment of escalation is fixed copy.
        fromBank(!this.env.AI && !FIXED_COPY_STANCES.includes(d.stance));
      } else {
        if (early) ms.spec = 1;
        const job = early ?? this.startWomanLine(s, d, out.strategy, event, text, ctx, copy);
        let lineAudio: LiveAudio | null = null;
        let wrote = false;
        job.fields.adopt((key, value, at) => {
          if (key === 'line') {
            wrote = true;
            ms.write = at - job.started;
            const voiced = this.speak(`m${turn}`, { role: 'man', text: value, emotion: d.emotion, delivery: out.delivery });
            lineAudio = voiced.live;
            emit({ type: 'line', speaker: 'man', text: value, audioUrl: voiced.url, emotion: d.emotion, delivery: out.delivery });
            this.noteLine(s, 'man', value, 'llm', turn, t);
          } else {
            const voiced = this.speak(`t${turn}`, { role: 'thought', text: value, emotion: thoughtEmotion, delivery: 'low' });
            emit({ type: 'thought', text: value, audioUrl: voiced.url, fear: out.fear });
            this.noteThought(s, value, turn, t);
          }
        });
        try {
          const res = await job.result;
          if (res.attempts > 1) ms.hedged = 1;
          if (!('thought' in res.fields)) this.emitBankThought(s, pickBank('woman', d.stance, copy, s.usedBank, this.reasks(s)), out.fear, turn, t, emit);
        } catch {
          if (!wrote) fromBank(true);
        }
        const live = lineAudio as LiveAudio | null;
        if (live) {
          const ttfb = await live.timeToFirstByte(AUDIO_WAIT_MS);
          if (ttfb !== null && live.firstByteAt !== null) {
            ms.tts = ttfb;
            ms.firstAudio = live.firstByteAt - received;
          }
        }
      }
    }

    if (out.outcome) {
      s.outcome = out.outcome;
      emit({ type: 'outcome', outcome: out.outcome });
      this.log({ kind: 'outcome', t, turn, outcome: out.outcome });
    }
  }

  /** Start the line model for a stance. Fields are held until the caller adopts them. */
  private startWomanLine(s: Persisted, d: ManDecision, strategy: WomanStrategy, event: ClientEventType, text: string, ctx: WorldContext, copy: Rng): LineJob {
    const fields = new DeferredFields();
    const abort = new AbortController();
    const started = Date.now();
    const result = writeFields(this.env.AI, {
      system: WOMAN_SYSTEM,
      user: womanUserPrompt({
        stance: d.stance,
        level: d.level,
        emotion: d.emotion,
        event,
        herWords: text,
        strategy,
        ctx,
        action: d.action,
        recent: s.story?.lines ?? s.transcript,
        memory: s.story ? storyBrief(s.story, d.level ?? 1) : undefined,
        avoidLines: s.hisLines,
        avoidThoughts: s.thoughts,
        dice: [copy.next(), copy.next()],
      }),
      keys: ['line', 'thought'],
      validate: (key, value) => (key === 'line' ? cleanLine(value, { maxWords: 20, avoid: s.hisLines }) : cleanLine(value, { maxWords: 14, avoid: s.thoughts })),
      onField: (key, value) => fields.push(key, value),
      signal: abort.signal,
    });
    result.catch(() => {});
    return { stance: d.stance, level: d.level, fields, result, abort, started };
  }

  /* ------------------------------------------------------------------ bystander POV */

  private async bystanderTurn(
    s: Persisted,
    event: ClientEventType,
    text: string,
    ctx: WorldContext,
    turn: number,
    ms: Record<string, number>,
    emit: (ev: TurnEvent) => void,
    received: number,
  ): Promise<void> {
    const state = s.bystander as BystanderState;
    const rng = new Rng(s.rng);
    const t = ctx.elapsed;
    const manPresent = state.phase !== 'he_left' && state.manStance !== 'gone';
    if (state.phase === 'scripted') s.transcript = scriptedSoFar(ctx.beat);

    let read: BystanderRead | null = null;
    if (event === 'speech') {
      const t0 = Date.now();
      try {
        const res = await runClef(this.env.AI, buildBystanderRead({ text, ctx, manPresent, manFocus: state.manFocus, recent: s.transcript }));
        read = parseBystanderRead(res.answers, ctx, res.selector);
        if (read && res.selector !== 'clef') ms.readFast = 1;
      } catch {
        read = null;
      }
      if (!read) {
        read = heuristicBystanderRead(text, ctx, manPresent);
        ms.fallbackRead = 1;
      }
      ms.read = Date.now() - t0;
    }

    const t1 = Date.now();
    const out: BystanderOutput = decideBystander(
      state,
      // The live game always ends in the grab when nobody steps in (see BystanderInput.inactionEnding).
      { event, ctx, strategyProbs: read?.strategyProbs, target: read?.target, signals: read?.signals, reaction: read?.reaction, inactionEnding: 'physical' },
      rng,
    );
    ms.decide = Date.now() - t1;
    s.bystander = out.state;
    s.rng = rng.state;

    const reportable = event === 'speech' || event === 'asked_clerk' || event === 'filming_start' || event === 'stood_between' || event === 'scene_timeout';
    if (reportable) {
      emit({
        type: 'read',
        strategy: out.strategy,
        confidence: read ? round(out.strategyProbs[out.strategy]) : 1,
        target: out.target,
        probs: roundAll(out.strategyProbs),
      });
    }
    if (event === 'speech') {
      s.transcript.push(`BYSTANDER: ${text}`);
      s.story = noteOther(s.story ?? emptyStory(), 'BYSTANDER', text);
    }
    if (event !== 'silence' || out.man || out.outcome) {
      this.log({
        kind: 'player',
        t,
        turn,
        event,
        text: event === 'speech' ? text : undefined,
        strategy: reportable ? out.strategy : undefined,
        target: event === 'speech' ? out.target : undefined,
        confidence: read ? round(read.confidence) : undefined,
        source: read ? read.source : 'event',
        tactic: out.tactic,
        result: out.result,
      });
    }

    if (out.man || out.woman) {
      const man: ManDecision = out.man ?? s.lastMan ?? { stance: 'gone', action: 'leave', emotion: 'neutral', emotionIntensity: 0.3, proximity: 3 };
      s.lastMan = man;
      emit({ type: 'decision', man, woman: out.woman ?? undefined, fear: out.fear, tension: out.tension, rationale: out.rationale });
      this.log({ kind: 'decision', t, turn, man, woman: out.woman ?? undefined, fear: out.fear, tension: out.tension, rationale: out.rationale, drivers: out.drivers });
    }

    if (out.lines.length) await this.bystanderLines(s, out, event, text, turn, t, ms, emit, received, copyRng(s.meta.seed, turn));

    if (out.outcome) {
      s.outcome = out.outcome;
      emit({ type: 'outcome', outcome: out.outcome });
      this.log({ kind: 'outcome', t, turn, outcome: out.outcome });
      this.ctx.waitUntil(this.recordStats());
    }
  }

  /* ------------------------------------------------------------------ playthrough stats */

  /** Part 2 only: tactics in order and the outcome. Never any words. */
  private recordStats(extra: { guided?: Record<string, string>; outcome?: OutcomeKind } = {}): Promise<void> {
    const s = this.s;
    if (!s || s.meta.pov !== 'bystander') return Promise.resolve();
    return recordPlaythrough(this.env.DB, {
      sessionId: s.meta.id,
      createdAt: s.meta.createdAt,
      tactics: tacticsFromLog(this.readLog()),
      outcome: s.outcome ?? extra.outcome ?? null,
      guided: extra.guided,
    });
  }

  /**
   * POST /api/session/:id/guided  { choices: { m1: "m1_wait", ... }, outcome?: OutcomeKind }
   * The first choice picked at each guided moment. `outcome` is the client's own
   * Part 2 ending, used only when this session never recorded one.
   */
  private async recordGuided(request: Request): Promise<Response> {
    if (this.s?.meta.pov !== 'bystander') return json({ error: 'Not a Part 2 session' }, 400);
    const body = (await request.json().catch(() => null)) as { choices?: unknown; outcome?: unknown } | null;
    const guided = cleanGuidedChoices(body?.choices);
    await this.recordStats({ guided, outcome: isOutcome(body?.outcome) ? body.outcome : undefined });
    return json({ ok: true, recorded: Object.keys(guided).length });
  }

  private async bystanderLines(
    s: Persisted,
    out: BystanderOutput,
    event: ClientEventType,
    text: string,
    turn: number,
    t: number,
    ms: Record<string, number>,
    emit: (ev: TurnEvent) => void,
    received: number,
    copy: Rng,
  ): Promise<void> {
    // The shopkeeper's lines are scripted and pre-rendered: they go out first, as they are.
    for (const cue of out.lines) {
      if (!cue.scriptId) continue;
      const line = scriptLine(cue.scriptId);
      if (!line) continue;
      emit({ type: 'line', speaker: cue.speaker, text: line.text, audioUrl: this.voice ? voUrl(cue.scriptId) : '', emotion: cue.emotion, delivery: cue.delivery });
      this.noteLine(s, cue.speaker, line.text, 'script', turn, t);
    }
    const cues = out.lines.filter((c) => !c.scriptId && (c.speaker === 'man' || c.speaker === 'woman'));
    if (!cues.length) return;
    const thoughtEmotion: Emotion = out.result === 'stops' || out.tactic === 'delay' ? 'relieved' : 'afraid';
    const done = new Set<LineCue>();
    let thoughtDone = !out.thought;
    let lastEntry: BankEntry | null = null;

    const bankCue = (cue: LineCue) => {
      const entry = pickBank('bystander', cue.situation, copy, s.usedBank);
      lastEntry = entry;
      this.emitBankLine(s, entry, cue.speaker as 'man' | 'woman', cue.emotion, cue.delivery, turn, t, emit);
      done.add(cue);
    };

    // The moment of escalation is fixed, pre-rendered copy.
    const fixedCopy = cues.some((c) => c.situation === 'b_man_escalate');
    if (!fixedCopy && this.env.AI) {
      const t2 = Date.now();
      let firstAudio: LiveAudio | null = null;
      const keys = [...cues.map((c) => c.speaker as string), ...(out.thought ? ['thought'] : [])];
      try {
        const res = await writeFields(this.env.AI, {
          system: BYSTANDER_SYSTEM,
          user: bystanderUserPrompt({
            action: describeEvent(event),
            playerWords: event === 'speech' ? text : '',
            target: out.target === 'man' ? 'him' : out.target === 'woman' ? 'her' : out.target === 'clerk' ? 'the shopkeeper' : 'nobody in particular',
            recent: s.transcript,
            cues: cues.map((c) => ({ key: c.speaker as 'man' | 'woman', situation: c.situation })),
            wantThought: Boolean(out.thought),
            avoidLines: s.hisLines,
            dice: cues.map(() => copy.next()),
          }),
          keys,
          validate: (key, value) => (key === 'thought' ? cleanLine(value, { maxWords: 14, avoid: s.thoughts }) : cleanLine(value, { maxWords: 20, avoid: s.hisLines })),
          onField: (key, value) => {
            if (key === 'thought') {
              const voiced = this.speak(`t${turn}`, { role: 'thought', text: value, emotion: thoughtEmotion, delivery: 'low' });
              emit({ type: 'thought', text: value, audioUrl: voiced.url, fear: out.fear });
              this.noteThought(s, value, turn, t);
              thoughtDone = true;
              return;
            }
            const cue = cues.find((c) => c.speaker === key && !done.has(c));
            if (!cue) return;
            if (!('write' in ms)) ms.write = Date.now() - t2;
            const voiced = this.speak(`${key === 'man' ? 'm' : 'w'}${turn}`, { role: key === 'man' ? 'man' : 'woman', text: value, emotion: cue.emotion, delivery: cue.delivery });
            if (!firstAudio) firstAudio = voiced.live;
            emit({ type: 'line', speaker: cue.speaker, text: value, audioUrl: voiced.url, emotion: cue.emotion, delivery: cue.delivery });
            this.noteLine(s, cue.speaker, value, 'llm', turn, t);
            done.add(cue);
          },
        });
        if (res.attempts > 1) ms.hedged = 1;
      } catch {
        /* fall through to the bank for whatever is missing */
      }
      const live = firstAudio as LiveAudio | null;
      if (live) {
        const ttfb = await live.timeToFirstByte(AUDIO_WAIT_MS);
        if (ttfb !== null && live.firstByteAt !== null) {
          ms.tts = ttfb;
          ms.firstAudio = live.firstByteAt - received;
        }
      }
      if (cues.some((c) => !done.has(c))) ms.fallbackLine = 1;
    } else if (!fixedCopy) {
      ms.fallbackLine = 1;
    } else {
      ms.bankLine = 1;
    }
    for (const cue of cues) if (!done.has(cue)) bankCue(cue);
    if (!thoughtDone) {
      const entry = (lastEntry as BankEntry | null) ?? pickBank('bystander', cues[cues.length - 1].situation, copy, s.usedBank);
      this.emitBankThought(s, entry, out.fear, turn, t, emit);
    }
  }

  /* ------------------------------------------------------------------ shared emit helpers */

  private noteLine(s: Persisted, speaker: 'man' | 'woman' | 'clerk', text: string, source: 'llm' | 'bank' | 'script', turn: number, t: number): void {
    const who = speaker === 'man' ? 'HIM' : speaker === 'woman' ? 'HER' : 'SHOPKEEPER';
    s.transcript.push(`${who}: ${text}`);
    if (s.transcript.length > 10) s.transcript = s.transcript.slice(-10);
    const story = s.story ?? emptyStory();
    s.story = speaker === 'man' ? noteHim(story, text) : noteOther(story, who, text);
    if (speaker === 'man') {
      s.hisLines.push(text);
      if (s.hisLines.length > 20) s.hisLines = s.hisLines.slice(-20);
    }
    this.log({ kind: 'line', t, turn, speaker, text, source });
  }

  /** A bank line that would ask something he has already asked (or she already answered) does not fit the story. */
  private reasks(s: Persisted): (text: string) => boolean {
    const story = s.story;
    if (!story) return () => false;
    return (text) =>
      askedIn(text).some((t) => story.asked.includes(t) || (t === 'name' && !!story.facts.name) || (t === 'where' && !!story.facts.destination));
  }

  private noteThought(s: Persisted, text: string, turn: number, t: number): void {
    s.thoughts.push(text);
    if (s.thoughts.length > 8) s.thoughts = s.thoughts.slice(-8);
    this.log({ kind: 'thought', t, turn, text });
  }

  private emitBankLine(s: Persisted, entry: BankEntry, speaker: 'man' | 'woman', emotion: Emotion, delivery: Delivery, turn: number, t: number, emit: (ev: TurnEvent) => void): void {
    if (entry.id) s.usedBank.push(entry.id);
    emit({ type: 'line', speaker, text: entry.text, audioUrl: this.voice && entry.id ? voUrl(entry.id) : '', emotion, delivery });
    this.noteLine(s, speaker, entry.text, 'bank', turn, t);
  }

  private emitBankThought(s: Persisted, entry: BankEntry, fear: number, turn: number, t: number, emit: (ev: TurnEvent) => void): void {
    if (!entry.thought) return;
    if (entry.id && !s.usedBank.includes(entry.id)) s.usedBank.push(entry.id);
    emit({ type: 'thought', text: entry.thought, audioUrl: this.voice && entry.id ? voUrl(`${entry.id}_t`) : '', fear });
    this.noteThought(s, entry.thought, turn, t);
  }
}

function describeEvent(event: ClientEventType): string {
  switch (event) {
    case 'asked_clerk':
      return 'asked the shopkeeper to help, and the shopkeeper has come to his door and told the man to leave her alone';
    case 'stood_between':
      return 'stepped in between the man and the woman without a word';
    case 'filming_start':
      return 'raised a phone and started filming him';
    case 'silence':
      return 'said nothing more and stayed where they were';
    default:
      return 'is standing close by, watching';
  }
}

/** A separate seeded stream for wording (bank picks, prompt angles), one per turn. */
function copyRng(seed: number, turn: number): Rng {
  return new Rng((seed ^ Math.imul(turn + 1, 0x9e3779b1)) >>> 0);
}

const round = (v: number): number => Math.round(v * 1000) / 1000;

function roundAll<K extends string>(probs: Record<K, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(probs) as [K, number][]) out[k] = round(v);
  return out;
}
