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
  Pov,
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
  heuristicWomanRead,
  parseBystanderRead,
  parseWomanRead,
  runClef,
  type BystanderRead,
  type WomanRead,
} from './read';
import { applyToDecision, composeBeat, judgeTurn, type JudgeEnv, type TurnReading } from './judge';
import { emptyMemory, memoryBlock, noteTurn, type ConversationMemory } from './memory';
import { agentVariables } from '../shared/liveVoice';
import { advanceLiveLadder, initialLiveLadder, liveDecision, liveOutcome, type LiveLadder } from '../shared/liveLadder';
import { agentTurnSkipsVoice, ensureLiveAgent, mintSignedUrl } from './agent';
import { planReply } from './converse';
import { addressOf, addressOfBystander, groundedLine, lineAcknowledges } from './model/address';
import { MAX_CLIP_BYTES, transcribe } from './stt';
import { buildSummary } from './summary';
import { LiveAudio, startTts, type AudioSpec } from './tts';
import { voUrl, type Delivery } from './voices';
import { BYSTANDER_SYSTEM, WOMAN_SYSTEM, bystanderUserPrompt, cleanLine, womanUserPrompt, writeFields, type WriteResult } from './write';

export interface Env {
  AI: Ai;
  SESSION: DurableObjectNamespace<SessionDO>;
  ASSETS: Fetcher;
  ELEVENLABS_API_KEY?: string;
  /** Set after `npm run agent:create`. Without it the sim stays on the STT → line model → TTS path. */
  ELEVENLABS_AGENT_ID?: string;
  /**
   * Unset uses Workers AI. seeded forces the built-in machine.
   * typesafe, openai, and gemini need the matching key. Keys never leave the Worker.
   */
  DECISION_PROVIDER?: string;
  TYPESAFE_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
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
  /** Rolling summary and facts. Absent on sessions saved before this existed. */
  memory?: ConversationMemory;
  live?: LiveLadder;
}

const CLIENT_EVENTS: ClientEventType[] = [
  'begin',
  'speech',
  'agent_reply',
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
  fields: DeferredFields;
  result: Promise<WriteResult>;
  abort: AbortController;
  started: number;
}

/** How long `done` will wait for the first audio byte so the turn can report it. */
const AUDIO_WAIT_MS = 1500;
const MAX_LIVE_AUDIO = 24;

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
  /** Last spoken line, so the next TTS request can stitch prosody. Not persisted. */
  private lastSpoken = '';

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
    if (action === 'agent' && request.method === 'GET') return this.agentSession();
    if (action === 'agent-line' && request.method === 'POST') return this.agentLine(request);
    if (action === 'summary' && request.method === 'GET') return json(buildSummary(this.s.meta, this.readLog(), this.s.outcome));
    if (action === 'audio' && request.method === 'GET') return this.serveAudio(parts[4] ?? '');
    return json({ error: 'Not found' }, 404);
  }

  private async init(request: Request, id: string): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as Partial<CreateSessionRequest>;
    const pov = body.pov === 'bystander' ? 'bystander' : 'woman';
    const seed = typeof body.seed === 'number' && Number.isFinite(body.seed) ? Math.floor(Math.abs(body.seed)) >>> 0 : (hashSeed(id) ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
    const rng = new Rng(seed);
    const meta: SessionMeta = { id, pov, seed, createdAt: Date.now() };
    const s: Persisted = { meta, rng: 0, turn: 0, transcript: [], usedBank: [], hisLines: [], thoughts: [], lastMan: null, outcome: null };
    if (pov === 'woman') {
      const disposition = drawDisposition(rng);
      meta.disposition = disposition;
      s.woman = initialWomanState(disposition);
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

  /* ------------------------------------------------------------------ live agent */

  /** Signed URL for the browser. The API key stays on this hop. */
  private async agentSession(): Promise<Response> {
    const key = this.env.ELEVENLABS_API_KEY;
    const agentId = this.env.ELEVENLABS_AGENT_ID;
    if (!key || !agentId || !this.s) return json({ error: 'Live voice is not configured' }, 404);
    try {
      await ensureLiveAgent(key, agentId);
      const signedUrl = await mintSignedUrl(key, agentId);
      const man = this.s.lastMan;
      const vars = agentVariables({
        pov: this.s.meta.pov,
        stance: man?.stance ?? 'opening',
        emotion: man?.emotion ?? 'friendly',
        distanceMetres: man?.proximity ?? 4,
        heat: this.s.live?.heat ?? 0,
      });
      return json({ signedUrl, dynamicVariables: vars });
    } catch (err) {
      return json({ error: `Could not start live voice (${String((err as Error)?.message ?? err).slice(0, 80)})` }, 502);
    }
  }

  /** Record a line the agent spoke, so the debrief still has his words. */
  private async agentLine(request: Request): Promise<Response> {
    if (!this.s) return json({ error: 'Unknown session' }, 404);
    const body = (await request.json().catch(() => null)) as { speaker?: string; text?: string; emotion?: string } | null;
    const text = (body?.text ?? '').trim().slice(0, 240);
    if (!text) return json({ error: 'Missing text' }, 400);
    const speaker = body?.speaker === 'woman' || body?.speaker === 'clerk' ? body.speaker : 'man';
    const t = 0;
    this.noteLine(this.s, speaker, text, 'llm', this.s.turn, t);
    this.save();
    return json({ ok: true });
  }

  /* ------------------------------------------------------------------ audio */

  /** Start voicing a line now and return the URL the client will GET. Empty string when voice is unavailable. */
  private speak(lineId: string, spec: AudioSpec): { url: string; live: LiveAudio | null } {
    const key = this.env.ELEVENLABS_API_KEY;
    if (!key || !this.s) return { url: '', live: null };
    const previousText = spec.role === 'thought' ? undefined : this.lastSpoken || undefined;
    const full: AudioSpec = { ...spec, previousText };
    this.ctx.storage.sql.exec('INSERT INTO audio (id, spec) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET spec = excluded.spec', lineId, JSON.stringify(full));
    const live = startTts(key, full);
    this.remember(lineId, live);
    if (spec.role !== 'thought' && spec.text.trim()) this.lastSpoken = spec.text.trim();
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
    const turnReq: TurnRequest = { event: req.event, ctx: normaliseCtx(req.ctx), text: typeof req.text === 'string' ? req.text.slice(0, 600) : undefined, data: req.data };

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
    if (s.outcome && req.event !== 'agent_reply') return finish();

    // The live agent already heard her and is replying. Never run a judge,
    // stance gate, line writer, transcription job, or second voice on this path.
    if (this.env.ELEVENLABS_AGENT_ID || agentTurnSkipsVoice(req.data)) {
      this.liveTurn(s, req, turn, emit);
      ms.agent = 1;
      return finish();
    }

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

    const agentVoice = agentTurnSkipsVoice(req.data);
    if (s.meta.pov === 'woman') await this.womanTurn(s, event, text, req.ctx, turn, ms, emit, received, agentVoice);
    else await this.bystanderTurn(s, event, text, req.ctx, turn, ms, emit, received, agentVoice);
    finish();
  }

  /** Persist the live scene without generating or voicing another reply. */
  private liveTurn(s: Persisted, req: TurnRequest, turn: number, emit: (ev: TurnEvent) => void): void {
    const t = req.ctx.elapsed;
    s.live = advanceLiveLadder(s.live ?? initialLiveLadder(), req);
    if (req.event === 'agent_reply' && req.text) {
      this.noteLine(s, 'man', req.text, 'llm', turn, t);
    } else {
      if (req.event === 'speech' && req.text) {
        this.rememberTurn(s, 'player', req.text);
        s.transcript.push(`HER: ${req.text}`);
      }
      this.log({ kind: 'player', t, turn, event: req.event, text: req.text, source: 'event' });
    }
    const man = liveDecision(s.live, req.ctx);
    const fear = s.live.heat / 8;
    const tension = s.live.heat / 6;
    s.lastMan = man;
    if (s.woman) s.woman.stance = man.stance;
    emit({ type: 'decision', man, fear, tension });
    this.log({ kind: 'decision', t, turn, man, fear, tension, drivers: ['live_ladder'] });
    const outcome = liveOutcome(s.live, req.event);
    if (outcome && !s.outcome) {
      s.outcome = outcome;
      emit({ type: 'outcome', outcome });
      this.log({ kind: 'outcome', t, turn, outcome });
    }
  }

  /** Start the judge immediately so it overlaps Clef and the line model. */
  private prefetchJudge(pov: Pov, event: ClientEventType, text: string, recent: string[], ctx: WorldContext, stance: ManStance): Promise<TurnReading | null> {
    if (!['speech', 'silence', 'filming_start', 'stood_between', 'asked_clerk'].includes(event)) return Promise.resolve(null);
    const t0 = Date.now();
    return judgeTurn(this.env as JudgeEnv, { pov, event, stance, text, recent, ctx }).then((reading) => {
      this.judgeMs = Date.now() - t0;
      return reading;
    });
  }

  private judgeMs = 0;

  /**
   * Apply a judge that was started earlier. Null keeps the seeded decision.
   */
  private async finishJudge(
    pending: Promise<TurnReading | null>,
    pov: Pov,
    event: ClientEventType,
    decision: ManDecision | null,
    tension: number,
    ms: Record<string, number>,
    gate: { fromStance: ManStance; text: string; turn: number; rejections: number; seekingHelp: boolean },
  ): Promise<{ decision: ManDecision; tension: number; rule: string | null } | null> {
    if (!decision || !['speech', 'silence', 'filming_start', 'stood_between', 'asked_clerk'].includes(event)) return null;
    const reading = await pending;
    ms.judge = this.judgeMs;
    if (!reading) {
      ms.judgeFallback = 1;
      return null;
    }
    const flag = { workers: 'judgeWorkers', typesafe: 'judgeTypesafe', openai: 'judgeOpenai', gemini: 'judgeGemini' } as const;
    ms[flag[reading.provider]] = 1;
    const beat = composeBeat(
      { stance: decision.stance, emotion: decision.emotion, emotionIntensity: decision.emotionIntensity, action: decision.action, tension },
      reading,
      {
        bystanderIntervened: pov === 'bystander' && event !== 'silence',
        text: gate.text,
        fromStance: gate.fromStance,
        turn: gate.turn,
        rejections: gate.rejections,
        seekingHelp: gate.seekingHelp,
      },
    );
    return { decision: applyToDecision(decision, beat), tension: beat.tension, rule: beat.rule };
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
    agentVoice = false,
  ): Promise<void> {
    const state = s.woman as WomanState;
    const fromStance = state.stance;
    const rejectionsBefore = state.rejections;
    const turnBefore = state.turn;
    const rng = new Rng(s.rng);
    const pendingJudge = this.prefetchJudge(s.meta.pov, event, text, s.transcript, ctx, state.stance);
    // Wording choices draw from their own stream, so the decisions replay under a fixed seed whichever path writes the line.
    const copy = copyRng(s.meta.seed, turn);
    const t = ctx.elapsed;

    // Start writing his line before Clef has answered, on a quick keyword guess at her words. If the real
    // decision lands on the same stance (it usually does) the line is already on its way; if not, it is dropped.
    let early: LineJob | null = null;
    if (event === 'speech' && text) this.rememberTurn(s, 'player', text);
    if (event === 'speech' && !agentVoice) {
      s.transcript.push(`HER: ${text}`);
      if (this.env.AI) {
        const guess = heuristicWomanRead(text);
        // A copy: the real decision still has to run on the untouched state. The old call
        // advanced the live machine, so one "hello" was decided twice and the line could
        // be written for a retreat the player never earned.
        const trial = decideWoman({ ...state }, { event, ctx, text, strategyProbs: guess.strategyProbs, signals: guess.signals }, new Rng(s.rng));
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
      ms.read = Date.now() - t0;
      emit({ type: 'read', strategy: read.strategy, confidence: round(read.confidence), probs: roundAll(read.strategyProbs) });
    }

    const t1 = Date.now();
    const out = decideWoman(state, { event, ctx, text, strategyProbs: read?.strategyProbs, signals: read?.signals, reaction: read?.reaction }, rng);
    ms.decide = Date.now() - t1;
    const judged = await this.finishJudge(pendingJudge, s.meta.pov, event, out.decision, out.tension, ms, {
      fromStance,
      text,
      turn: turnBefore,
      rejections: rejectionsBefore,
      seekingHelp: event === 'entered_shop',
    });
    if (judged && out.decision) {
      out.decision = judged.decision;
      out.state.stance = judged.decision.stance;
      out.tension = judged.tension;
      if (judged.rule && out.rationale) out.rationale = { ...out.rationale, text: judged.rule, basis: 'assumption' };
    }
    let plannedLine: string | null = null;
    if (event === 'speech' && text && this.env.AI && out.decision && !agentVoice) {
      const planned = await planReply(this.env.AI, {
        fromStance,
        text,
        recent: s.transcript,
        distance: ctx.distanceToMan,
        speed: ctx.playerSpeed,
        turn: turnBefore,
        rejections: rejectionsBefore,
      });
      if (planned) {
        out.decision = {
          ...out.decision,
          stance: planned.stance,
          action: planned.action,
          emotion: planned.emotion,
          emotionIntensity: planned.intensity,
          proximity: planned.proximity,
        };
        out.state.stance = planned.stance;
        out.delivery = planned.delivery;
        out.speak = planned.stance !== 'gone';
        if (planned.stance === 'escalate' || planned.action === 'grab') out.outcome = 'escalated';
        else if (out.outcome === 'escalated') out.outcome = undefined;
        plannedLine = planned.line;
        ms.converse = 1;
        if (early) {
          early.abort.abort();
          early = null;
        }
      }
    }
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

    const usable = early !== null && out.decision !== null && out.speak && out.decision.stance === early.stance;
    if (early && !usable) {
      early.abort.abort();
      ms.specMiss = 1;
      early = null;
    }

    if (out.decision) {
      const d = out.decision;
      s.lastMan = d;
      emit({ type: 'decision', man: d, fear: out.fear, tension: out.tension, rationale: out.rationale, ...this.memoryField(s) });
      this.log({ kind: 'decision', t, turn, man: d, fear: out.fear, tension: out.tension, rationale: out.rationale, drivers: out.drivers });

      if (agentVoice) {
        // The agent speaks. The stance and the clamped expression already went out on `decision`.
        ms.agent = 1;
        const entry = pickBank('woman', d.stance, copy, s.usedBank);
        if (entry.thought) {
          emit({ type: 'thought', text: entry.thought, audioUrl: '', fear: out.fear });
          this.noteThought(s, entry.thought, turn, t);
        }
      } else {
      const thoughtEmotion: Emotion = d.stance === 'back_off' ? 'worried' : out.fear >= 0.6 ? 'afraid' : 'worried';
      const thoughtFromBank = () => this.emitBankThought(s, pickBank('woman', d.stance, copy, s.usedBank), out.fear, turn, t, emit);
      /** A line that answers what she actually said, in the stance already chosen. False when there is nothing to answer. */
      const sayGrounded = (): boolean => {
        if (event !== 'speech' || !text) return false;
        const line = groundedLine({ stance: d.stance, move: addressOf(out.strategy, text), text, avoid: s.hisLines, rng: copy });
        if (!line) return false;
        ms.groundedLine = 1;
        const voiced = this.speak(`m${turn}`, { role: 'man', text: line, emotion: d.emotion, delivery: out.delivery });
        emit({ type: 'line', speaker: 'man', text: line, audioUrl: voiced.url, emotion: d.emotion, delivery: out.delivery });
        this.noteLine(s, 'man', line, 'bank', turn, t);
        return true;
      };
      const fromBank = (fallback: boolean) => {
        const entry = pickBank('woman', d.stance, copy, s.usedBank);
        if (fallback) ms.fallbackLine = 1;
        else ms.bankLine = 1;
        if (out.speak) this.emitBankLine(s, entry, 'man', d.emotion, out.delivery, turn, t, emit);
        this.emitBankThought(s, entry, out.fear, turn, t, emit);
      };

      if (!out.speak) {
        // He says nothing this beat (he is only trailing her): she still reacts.
        if (d.stance === 'follow') fromBank(false);
      } else if (plannedLine) {
        ms.converseLine = 1;
        const voiced = this.speak(`m${turn}`, { role: 'man', text: plannedLine, emotion: d.emotion, delivery: out.delivery });
        emit({ type: 'line', speaker: 'man', text: plannedLine, audioUrl: voiced.url, emotion: d.emotion, delivery: out.delivery });
        this.noteLine(s, 'man', plannedLine, 'llm', turn, t);
        thoughtFromBank();
      } else if (FIXED_COPY_STANCES.includes(d.stance)) {
        // Pre-rendered on purpose: the opening answers 'begin' with no latency, and the moment of escalation is fixed copy.
        fromBank(false);
      } else if (!this.env.AI) {
        // No line model: still answer the words she used, in the stance the machine picked.
        if (sayGrounded()) {
          ms.fallbackLine = 1;
          thoughtFromBank();
        } else fromBank(true);
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
          if (!('thought' in res.fields)) this.emitBankThought(s, pickBank('woman', d.stance, copy, s.usedBank), out.fear, turn, t, emit);
        } catch {
          if (!wrote) {
            if (sayGrounded()) {
              ms.fallbackLine = 1;
              thoughtFromBank();
            } else fromBank(true);
          }
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
        emotion: d.emotion,
        event,
        herWords: text,
        strategy,
        ctx,
        action: d.action,
        recent: s.transcript,
        avoidLines: s.hisLines,
        avoidThoughts: s.thoughts,
        dice: [copy.next(), copy.next()],
        memory: s.memory,
      }),
      keys: ['line', 'thought'],
      validate: (key, value) => {
        const cleaned = key === 'line' ? cleanLine(value, { maxWords: 20, avoid: s.hisLines }) : cleanLine(value, { maxWords: 14, avoid: s.thoughts });
        if (key === 'line' && cleaned && text && !lineAcknowledges(cleaned, text)) return null;
        return cleaned;
      },
      onField: (key, value) => fields.push(key, value),
      signal: abort.signal,
    });
    result.catch(() => {});
    return { stance: d.stance, fields, result, abort, started };
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
    agentVoice = false,
  ): Promise<void> {
    const state = s.bystander as BystanderState;
    const fromStance = state.manStance;
    const turnBefore = state.dynamicTurns;
    if (event === 'speech' && text) this.rememberTurn(s, 'player', text);
    const pendingJudge = this.prefetchJudge(s.meta.pov, event, text, s.transcript, ctx, state.manStance);
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
      { event, ctx, strategyProbs: read?.strategyProbs, target: read?.target, signals: read?.signals, reaction: read?.reaction },
      rng,
    );
    ms.decide = Date.now() - t1;
    const judged = await this.finishJudge(pendingJudge, s.meta.pov, event, out.man, out.tension, ms, {
      fromStance,
      text,
      turn: turnBefore,
      rejections: 0,
      seekingHelp: event === 'asked_clerk',
    });
    if (judged && out.man) {
      out.man = judged.decision;
      out.state.manStance = judged.decision.stance;
      out.tension = judged.tension;
      if (judged.rule && out.rationale) out.rationale = { ...out.rationale, text: judged.rule, basis: 'assumption' };
    }
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
    if (event === 'speech') s.transcript.push(`BYSTANDER: ${text}`);
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
      emit({ type: 'decision', man, woman: out.woman ?? undefined, fear: out.fear, tension: out.tension, rationale: out.rationale, ...this.memoryField(s) });
      this.log({ kind: 'decision', t, turn, man, woman: out.woman ?? undefined, fear: out.fear, tension: out.tension, rationale: out.rationale, drivers: out.drivers });
    }

    if (out.lines.length) await this.bystanderLines(s, out, event, text, turn, t, ms, emit, received, copyRng(s.meta.seed, turn), agentVoice);

    if (out.outcome) {
      s.outcome = out.outcome;
      emit({ type: 'outcome', outcome: out.outcome });
      this.log({ kind: 'outcome', t, turn, outcome: out.outcome });
    }
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
    agentVoice = false,
  ): Promise<void> {
    // The shopkeeper's lines are scripted and pre-rendered: they go out first, as they are.
    for (const cue of out.lines) {
      if (!cue.scriptId) continue;
      const line = scriptLine(cue.scriptId);
      if (!line) continue;
      emit({ type: 'line', speaker: cue.speaker, text: line.text, audioUrl: this.voice ? voUrl(cue.scriptId) : '', emotion: cue.emotion, delivery: cue.delivery });
      this.noteLine(s, cue.speaker, line.text, 'script', turn, t);
    }
    if (agentVoice) {
      ms.agent = 1;
      return;
    }
    const cues = out.lines.filter((c) => !c.scriptId && (c.speaker === 'man' || c.speaker === 'woman'));
    if (!cues.length) return;
    const thoughtEmotion: Emotion = out.result === 'stops' || out.tactic === 'delay' ? 'relieved' : 'afraid';
    const done = new Set<LineCue>();
    let thoughtDone = !out.thought;
    let lastEntry: BankEntry | null = null;

    const bankCue = (cue: LineCue) => {
      if (cue.speaker === 'man' && event === 'speech' && text) {
        const line = groundedLine({
          stance: out.man?.stance ?? 'hostile',
          move: addressOfBystander(out.strategy, text),
          text,
          avoid: s.hisLines,
          rng: copy,
        });
        if (line) {
          ms.groundedLine = 1;
          const voiced = this.speak(`m${turn}`, { role: 'man', text: line, emotion: cue.emotion, delivery: cue.delivery });
          emit({ type: 'line', speaker: 'man', text: line, audioUrl: voiced.url, emotion: cue.emotion, delivery: cue.delivery });
          this.noteLine(s, 'man', line, 'bank', turn, t);
          done.add(cue);
          return;
        }
      }
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
            memory: s.memory,
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

  private rememberTurn(s: Persisted, who: 'player' | 'him', text: string): void {
    s.memory = noteTurn(s.memory ?? emptyMemory(), who, text);
  }

  private memoryField(s: Persisted): { memory?: string } {
    const memory = memoryBlock(s.memory);
    return memory ? { memory } : {};
  }

  private noteLine(s: Persisted, speaker: 'man' | 'woman' | 'clerk', text: string, source: 'llm' | 'bank' | 'script', turn: number, t: number): void {
    const who = speaker === 'man' ? 'HIM' : speaker === 'woman' ? 'HER' : 'SHOPKEEPER';
    s.transcript.push(`${who}: ${text}`);
    if (s.transcript.length > 10) s.transcript = s.transcript.slice(-10);
    if (speaker === 'man') {
      s.hisLines.push(text);
      if (s.hisLines.length > 8) s.hisLines = s.hisLines.slice(-8);
      this.rememberTurn(s, 'him', text);
    }
    this.log({ kind: 'line', t, turn, speaker, text, source });
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

