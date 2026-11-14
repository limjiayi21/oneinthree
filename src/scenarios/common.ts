/**
 * Shared machinery for the scene directors: a pausable scene clock, the fear
 * model that drives every sensory channel, speech and thought playback,
 * live voice, and the serialised turn pipeline to the Worker.
 */
import * as THREE from 'three';
import type { AudioEngine, Engine, Hud, Mic, Npc, Player, Rect, StreetWorld } from '../contracts';
import type {
  ClientEventType,
  Emotion,
  ManStance,
  OutcomeKind,
  Pov,
  TurnEvent,
  TurnRequest,
  WorldContext,
} from '../../shared/types';
import { createSession, getAgentSession, sendTurn } from '../net/api';
import { startLiveVoice, type LiveVoice } from '../audio/agentSession';
import { agentVariables } from '../../shared/liveVoice';
import { advanceLiveLadder, initialLiveLadder, liveDecision, liveOutcome } from '../../shared/liveLadder';
import { MAX_CLIP_BYTES } from '../../shared/audio';
import { MAX_CLIP_MS, bargeOnTalkStart, vadEdge, type TalkOrigin } from '../audio/talk';
import { captionHoldMs } from '../ui/captions';
import { fillerKind, shouldPlayFiller } from '../audio/filler';
import { openPartialCaption } from '../audio/partial';
import scriptJson from '../../content/script.json';

export interface ScriptLine {
  speaker: 'thought' | 'woman' | 'man' | 'clerk' | 'self';
  text: string;
  emotion: Emotion;
  delivery: 'normal' | 'call_out' | 'low' | 'shout';
}
export const SCRIPT = (scriptJson as unknown as { lines: Record<string, ScriptLine> }).lines;
export const voUrl = (id: string) => `/audio/vo/${id}.mp3`;

const MOOD: Record<Emotion, string> = {
  neutral: 'Calm',
  friendly: 'Friendly',
  smirk: 'Smirking',
  leer: 'Staring',
  mocking: 'Mocking',
  annoyed: 'Annoyed',
  angry: 'Angry',
  contempt: 'Contempt',
  sheepish: 'Backing down',
  surprised: 'Surprised',
  afraid: 'Afraid',
  worried: 'Nervous',
  relieved: 'Relieved',
  determined: 'Set on it',
};

export function moodLabel(emotion: Emotion): string {
  return MOOD[emotion] ?? 'Calm';
}

export interface SceneDeps {
  engine: Engine;
  world: StreetWorld;
  audio: AudioEngine;
  mic: Mic;
  hud: Hud;
  /** True when the server can voice lines. */
  voice: boolean;
  /** True when the server can mint an ElevenLabs Agent signed URL. */
  agent?: boolean;
  /** Dev / accessibility: run without pointer lock. */
  requireLock: boolean;
  /** Optional fixed seed for reproducible runs. */
  seed?: number;
}

export interface SceneResult {
  sessionId: string;
  outcome: OutcomeKind;
}

export const inRect = (p: THREE.Vector3, r: Rect) => p.x >= r.minX && p.x <= r.maxX && p.z >= r.minZ && p.z <= r.maxZ;
export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
export const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

type Task = { at: number; fn: () => void; id: number };

export class SceneKit {
  /** Scene time in seconds. Stops while paused. */
  time = 0;
  paused = false;
  ended = false;
  sessionId = '';

  /** Fear as the server last reported it. */
  serverFear = 0;
  /** Local, decaying spikes (startle, proximity). */
  private bump = 0;
  /** Smoothed value actually applied. */
  fear = 0;

  private tasks: Task[] = [];
  private nextTask = 1;
  private cleanups: Array<() => void> = [];
  private frameHooks: Array<(dt: number) => void> = [];
  private npcs: Npc[] = [];

  /* turn pipeline */
  private busy = false;
  private speechTurn = false;
  private pending: { req: TurnRequest; audio?: Blob | null } | null = null;
  turnCount = 0;
  onEvent: (ev: TurnEvent) => void = () => {};

  /* speech */
  private talkHeld = false;
  private talkOrigin: TalkOrigin = 'ptt';
  /** Local volume gate, used only when no agent is configured. */
  private handsFree = false;
  private limitTimer = 0;
  private missedUntil = 0;
  private loudMs = 0;
  private quietMs = 0;
  private captionToken = 0;
  private filler: { stop(fade?: number): void } | null = null;
  private partial: { stop(): void } | null = null;
  /** True while an NPC line is still audible, so a new clip can cut it. */
  private npcAudible = false;
  /** Scenes switch this on once the player may speak. */
  speechEnabled = false;
  /** The ElevenLabs SDK owns all live microphone and speech playback. */
  agentLive = false;
  private live: LiveVoice | null = null;
  private liveStarting = false;
  private liveAttempted = false;
  private lastStance: ManStance = 'idle';
  private liveState = initialLiveLadder();
  private liveQueue: Promise<void> = Promise.resolve();
  private liveError = '';
  private agentResponseSeq = 0;
  private lastAgentLineAt = -99;
  private typedEcho = '';
  private cancelAgentSilence: (() => void) | null = null;
  private agentHearing = false;
  /** The scene points this at the attacker's mouth and face. */
  onAgentMouth: (level: number) => void = () => {};
  onAgentFace: (emotion: Emotion, intensity: number) => void = () => {};
  private lastThoughtAt = -99;
  private resolveEnd!: (o: OutcomeKind) => void;
  readonly finished: Promise<OutcomeKind>;

  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();

  constructor(
    readonly deps: SceneDeps,
    readonly player: Player,
    readonly pov: Pov,
  ) {
    this.finished = new Promise((res) => (this.resolveEnd = res));
    this.cleanups.push(deps.engine.onUpdate((dt, elapsed) => this.tick(dt, elapsed)));
    this.bindKeys();
    this.cleanups.push(
      player.on('step', (s) => {
        const vol = 0.35 + Math.min(1, s.speed / 2.3) * 0.5;
        deps.audio.footstep(s.surface, { volume: vol });
      }),
    );
    if (deps.requireLock) {
      this.cleanups.push(player.on('unlock', () => void this.handleUnlock()));
    }
  }

  /* ------------------------------------------------------------ lifecycle */

  async openSession(): Promise<void> {
    const res = await createSession({ pov: this.pov, scenario: 'walk-home', seed: this.deps.seed });
    this.sessionId = res.sessionId;
  }

  addNpc(npc: Npc, heavySteps: boolean): void {
    this.npcs.push(npc);
    npc.setObstacles(this.deps.world.colliders, this.deps.world.bounds);
    npc.onStep((pos, speed) => {
      this.deps.audio.footstep('concrete', { position: pos, volume: 0.5 + Math.min(0.5, speed / 4), heavy: heavySteps });
    });
    this.cleanups.push(this.player.addCollider(npc));
  }

  onFrame(fn: (dt: number) => void): void {
    this.frameHooks.push(fn);
  }

  private tick(dt: number, elapsed: number): void {
    const { engine, world, audio, hud } = this.deps;
    // The world and bodies keep moving even when paused would look frozen; but
    // a paused scene must not advance the encounter.
    if (this.paused) return;
    this.time += dt;

    world.update(dt, elapsed);
    this.player.update(dt);
    for (const npc of this.npcs) {
      npc.update(dt);
      npc.human.update(dt);
    }
    audio.setListener(this.player.getEyePosition(this.tmpA), this.player.getForward(this.tmpB));

    if (this.agentLive && this.npcAudible && this.live) this.onAgentMouth(this.live.outputLevel());

    // scheduled tasks
    if (this.tasks.length) {
      const due = this.tasks.filter((t) => t.at <= this.time);
      if (due.length) {
        this.tasks = this.tasks.filter((t) => t.at > this.time);
        for (const t of due) t.fn();
      }
    }

    for (const fn of this.frameHooks) fn(dt);

    // fear: rises fast, drains slowly, exactly as it does in a body
    this.bump = Math.max(0, this.bump - dt * 0.11);
    const target = clamp01(Math.max(this.serverFear, this.bump));
    const rate = target > this.fear ? 2.6 : 0.22;
    this.fear += (target - this.fear) * (1 - Math.exp(-rate * dt));
    const f = this.fear;
    engine.setFear(f);
    hud.setFear(f);
    this.player.setTension(f);
    audio.setHeartbeat(62 + f * 80, f < 0.06 ? 0 : 0.12 + f * 0.88);
    audio.setBreathing(clamp01((f - 0.22) / 0.78));
    audio.setMuffle(clamp01((f - 0.55) / 0.45) * 0.85);
  }

  /** Spike fear locally (startle, he steps in). */
  scare(amount: number): void {
    this.bump = clamp01(Math.max(this.bump, this.fear) + amount);
    this.deps.engine.pulse(Math.min(1, amount * 1.6));
  }

  /** Run `fn` after `seconds` of scene time. Returns a cancel function. */
  after(seconds: number, fn: () => void): () => void {
    const id = this.nextTask++;
    this.tasks.push({ at: this.time + seconds, fn, id });
    return () => {
      this.tasks = this.tasks.filter((t) => t.id !== id);
    };
  }

  wait(seconds: number): Promise<void> {
    return new Promise((res) => this.after(seconds, res));
  }

  /** Resolve the scene. Safe to call more than once. */
  end(outcome: OutcomeKind): void {
    if (this.ended) return;
    this.ended = true;
    this.speechEnabled = false;
    void this.stopAgent();
    this.resolveEnd(outcome);
  }

  dispose(): void {
    this.ended = true;
    window.clearTimeout(this.limitTimer);
    void this.live?.close();
    this.live = null;
    this.agentLive = false;
    this.deps.mic.watch(false);
    for (const c of this.cleanups.splice(0)) c();
    for (const npc of this.npcs.splice(0)) {
      npc.human.dispose();
      npc.dispose();
    }
    this.tasks = [];
    this.frameHooks = [];
    this.deps.audio.stopAllSpeech();
    this.deps.audio.setHeartbeat(60, 0);
    this.deps.audio.setBreathing(0);
    this.deps.audio.setMuffle(0);
    this.deps.engine.setFear(0);
    this.deps.hud.setFear(0);
    this.deps.hud.setMic('hidden');
    this.deps.hud.hint(null);
    this.deps.hud.prompt(null);
    this.deps.hud.objective(null);
    this.deps.hud.clearSubtitle();
    this.deps.hud.setFilming(false);
  }

  /* --------------------------------------------------------------- pause */

  private async handleUnlock(): Promise<void> {
    if (this.ended || this.paused || this.typing) return;
    this.paused = true;
    this.player.inputEnabled = false;
    this.deps.audio.setMaster(0.25, 0.3);
    const choice = await this.deps.hud.pause();
    this.deps.audio.setMaster(1, 0.3);
    if (choice === 'exit') {
      this.paused = false;
      this.end('exited');
      return;
    }
    this.player.requestLock();
    this.player.inputEnabled = true;
    this.paused = false;
  }

  /* --------------------------------------------------------------- voice */

  /** A person in the world speaks. Resolves when the line has finished. */
  async say(npc: Npc | null, speaker: 'man' | 'woman' | 'clerk', text: string, url: string): Promise<void> {
    if (this.deps.agent) return;
    const { audio, hud } = this.deps;
    const estimate = Math.max(1.4, text.length * 0.062);
    const hasAudio = Boolean(url && this.deps.voice);
    const token = ++this.captionToken;
    // The auto-clear must outlast the line. Voiced lines are cleared when the
    // audio actually ends; a text-length timer was dropping the subtitle early.
    const hold = hasAudio ? captionHoldMs(true, text) : Math.ceil((estimate + 0.8) * 1000);
    hud.subtitle(speaker, text, hold);
    this.npcAudible = true;
    try {
      if (hasAudio) {
        let got = false;
        const handle = audio.speak(url, {
          bus: 'voice',
          position: npc ? () => npc.human.getHeadPosition(this.tmpA) : undefined,
          onLevel: (l) => {
            got = got || l > 0.02;
            npc?.human.setTalking(l);
          },
        });
        const t0 = this.time;
        await handle.done;
        npc?.human.setTalking(0);
        // Audio failed outright (no key, 502, autoplay): keep the subtitle and move his mouth.
        if (!got && this.time - t0 < 0.4 && token === this.captionToken) await this.mime(npc, estimate);
      } else {
        await this.mime(npc, estimate);
      }
      if (token === this.captionToken) await this.wait(0.35);
    } finally {
      if (token === this.captionToken) {
        this.npcAudible = false;
        hud.clearSubtitle();
      }
    }
  }

  /** No audio: move his mouth for roughly as long as the line would take. */
  private mime(npc: Npc | null, seconds: number): Promise<void> {
    const t0 = this.time;
    return new Promise((res) => {
      const step = () => {
        const t = this.time - t0;
        if (t >= seconds || this.ended) {
          npc?.human.setTalking(0);
          res();
          return;
        }
        npc?.human.setTalking(0.35 + 0.35 * Math.abs(Math.sin(t * 11)) * (0.6 + 0.4 * Math.sin(t * 3.1)));
        this.after(0.03, step);
      };
      step();
    });
  }

  /** Her inner voice, from the scripted bank. `quiet` plays it softer (bystander POV hears it faintly). */
  think(id: string, opts: { intensity?: number; quiet?: boolean; minGap?: number } = {}): boolean {
    const line = SCRIPT[id];
    if (!line) return false;
    if (opts.minGap && this.time - this.lastThoughtAt < opts.minGap) return false;
    this.thinkText(line.text, line.speaker === 'self' ? '' : voUrl(id), opts.intensity, opts.quiet);
    return true;
  }

  thinkText(text: string, url: string, intensity?: number, quiet = false): void {
    this.lastThoughtAt = this.time;
    this.deps.hud.thought(text, intensity ?? Math.max(0.15, this.fear));
    if (url && this.deps.voice && !this.deps.agent) {
      this.deps.audio.speak(url, { bus: 'thought', volume: quiet ? 0.45 : 1 });
    }
  }

  get secondsSinceThought(): number {
    return this.time - this.lastThoughtAt;
  }

  /* --------------------------------------------------------------- turns */

  /** Subclasses provide the physical context for each turn. */
  context: () => WorldContext = () => ({
    elapsed: this.time,
    distanceToMan: 99,
    progress: 0,
    playerSpeed: 0,
    facingMan: false,
    manBlocking: false,
    oppositeSidewalk: false,
  });

  get turnInFlight(): boolean {
    return this.busy;
  }

  /** Report a non-speech event. Dropped if a turn is already running (speech always wins). */
  event(event: ClientEventType, data?: TurnRequest['data']): void {
    void this.turn({ event, ctx: this.context(), data });
  }

  async turn(req: TurnRequest, audio?: Blob | null): Promise<void> {
    if (this.ended || !this.sessionId) return;
    if (this.deps.agent) return this.liveTurn(req);
    const isSpeech = req.event === 'speech';
    const terminal = req.event === 'reached_home' || req.event === 'entered_shop' || req.event === 'scene_timeout';
    if (this.busy) {
      // Keep only the most important thing waiting: speech and scene-ending events beat everything.
      if (isSpeech || terminal || !this.pending) this.pending = { req, audio };
      return;
    }
    this.busy = true;
    this.speechTurn = isSpeech;
    this.turnCount++;
    if (shouldPlayFiller(isSpeech, Boolean(this.agentLive || this.deps.agent))) {
      this.deps.hud.setMic('thinking');
      this.playFiller();
    }
    try {
      for await (const ev of sendTurn(this.sessionId, req, audio)) {
        if (this.ended) break;
        if (ev.type === 'heard') {
          if (ev.text) {
            this.deps.hud.subtitle('you', ev.text, 7000);
            this.deps.hud.setPartial(ev.text);
          } else this.flashMissed();
        }
        if (ev.type === 'error') {
          console.warn('[turn]', ev.message);
          if (isSpeech) this.flashMissed();
        }
        if (ev.type === 'line' && ev.speaker === 'man') this.filler?.stop(0.04);
        if (ev.type === 'decision') {
          this.lastStance = ev.man.stance;
          this.deps.hud.setMood(moodLabel(ev.man.emotion));
        }
        this.onEvent(ev);
      }
    } finally {
      this.busy = false;
      this.speechTurn = false;
      if (isSpeech) this.refreshMic();
      const next = this.pending;
      this.pending = null;
      if (next && !this.ended) void this.turn({ ...next.req, ctx: this.context() }, next.audio);
    }
  }

  /* --------------------------------------------------------------- debug */

  /** Dev only: lets automated tests drive the scene (window.__scene). */
  exposeDebug(extra: Record<string, unknown>): void {
    if (!import.meta.env.DEV) return;
    (window as unknown as Record<string, unknown>).__scene = {
      kit: this,
      player: this.player,
      say: (text: string) => this.turn({ event: 'speech', ctx: this.context(), text }),
      tp: (x: number, z: number, yaw = 0) => this.player.setPose(new THREE.Vector3(x, 0, z), yaw),
      state: () => ({ time: this.time, fear: this.fear, ended: this.ended, busy: this.busy, turns: this.turnCount, ctx: this.context() }),
      ...extra,
    };
  }

  /* -------------------------------------------------------- push-to-talk */

  private typing = false;
  /** Extra keys a scene wants (F, E...). */
  onKey: (code: string) => void = () => {};

  refreshMic(): void {
    const { hud, mic } = this.deps;
    if (this.deps.agent) {
      mic.watch(false);
      if (this.speechEnabled && !this.ended && !this.liveAttempted) {
        this.liveAttempted = true;
        void this.startAgent();
      }
      hud.setMic(!this.speechEnabled ? 'hidden' : this.agentLive ? 'live' : this.liveError ? 'unavailable' : 'connecting');
      hud.setTalkMode(this.speechEnabled && this.agentLive ? 'live' : 'off');
      return;
    }
    if (this.speechEnabled && !this.ended && !this.handsFree) {
      this.handsFree = true;
      void mic.init().then(() => mic.watch(true));
    }
    if (!this.speechEnabled) hud.setMic('hidden');
    else if (this.talkHeld) hud.setMic('recording', mic.level());
    else if (performance.now() < this.missedUntil) hud.setMic('missed');
    else if (this.busy && this.speechTurn) hud.setMic('thinking');
    else hud.setMic('live');
    hud.setTalkMode(this.speechEnabled ? 'live' : 'off');
  }

  private flashMissed(): void {
    this.missedUntil = performance.now() + 1800;
    this.deps.hud.setMic('missed');
  }

  private bindKeys(): void {
    const { mic, hud } = this.deps;
    const isTypingTarget = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
    };

    const down = (e: KeyboardEvent) => {
      if (this.ended || this.paused || isTypingTarget(e)) return;
      if (e.code === 'Space' || e.code === 'KeyL' || e.code === 'KeyH') {
        e.preventDefault();
        return;
      }
      if (e.code === 'KeyT') {
        if (!this.speechEnabled || e.repeat) return;
        e.preventDefault();
        void this.typeInstead();
      } else if (!e.repeat) {
        this.onKey(e.code);
      }
    };

    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !this.talkHeld || this.talkOrigin !== 'ptt') return;
      this.endTalk();
    };

    const blur = () => {
      if (this.talkHeld) this.endTalk();
    };

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    this.cleanups.push(() => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    });

    // live level ring while recording, and hands-free edges between lines
    this.onFrame((dt) => {
      if (this.deps.agent || this.agentLive) return;
      if (this.talkHeld) hud.setMic('recording', mic.level());
      if (!this.handsFree || !this.speechEnabled || this.ended || this.paused || this.typing) return;
      const level = mic.level();
      const step = Math.min(0.25, Math.max(0, dt)) * 1000;
      if (!this.talkHeld) {
        this.loudMs = level >= 0.2 ? this.loudMs + step : 0;
        this.quietMs = 0;
      } else if (this.talkOrigin === 'vad') {
        this.quietMs = level < 0.08 ? this.quietMs + step : 0;
        this.loudMs = 0;
      }
      const edge = vadEdge({ holding: this.talkHeld && this.talkOrigin === 'vad', level, loudMs: this.loudMs, quietMs: this.quietMs });
      if (!this.talkHeld && edge === 'start') this.beginTalk('vad');
      else if (this.talkHeld && this.talkOrigin === 'vad' && edge === 'stop') this.endTalk();
    });
  }

  private beginTalk(origin: TalkOrigin): void {
    const { mic, hud, audio } = this.deps;
    if (this.deps.agent || this.agentLive || this.talkHeld || this.ended || !this.speechEnabled) return;
    if (bargeOnTalkStart(this.npcAudible)) {
      audio.stopAllSpeech();
      this.npcAudible = false;
      this.captionToken++;
      hud.clearSubtitle();
    }
    this.talkOrigin = origin;
    this.talkHeld = true;
    this.missedUntil = 0;
    if (!mic.start()) {
      this.talkHeld = false;
      this.flashMissed();
      return;
    }
    hud.setMic('recording', 0);
    this.partial?.stop();
    this.partial = openPartialCaption((text) => {
      if (this.talkHeld) hud.setPartial(text);
    });
    window.clearTimeout(this.limitTimer);
    this.limitTimer = window.setTimeout(() => {
      if (this.talkHeld) this.endTalk();
    }, MAX_CLIP_MS);
  }

  get heat(): number { return this.liveState.heat; }

  /** React in this frame; log in order without holding up the agent's reply. */
  private liveTurn(req: TurnRequest): Promise<void> {
    this.turnCount++;
    const previous = this.liveState;
    this.liveState = advanceLiveLadder(previous, req);
    const man = liveDecision(this.liveState, req.ctx);
    if (previous.heat !== this.liveState.heat || previous.leaving !== this.liveState.leaving || req.event === 'begin') {
      this.lastStance = man.stance;
      this.deps.hud.setMood(moodLabel(man.emotion));
      this.onAgentFace(man.emotion, man.emotionIntensity);
      this.onEvent({ type: 'decision', man, fear: this.liveState.heat / 8, tension: this.liveState.heat / 6 });
      this.live?.update(agentVariables({ pov: this.pov, ...man, distanceMetres: req.ctx.distanceToMan, heat: this.liveState.heat }));
    }
    const outcome = liveOutcome(this.liveState, req.event);
    if (outcome) this.onEvent({ type: 'outcome', outcome });
    const record = async () => {
      for await (const ev of sendTurn(this.sessionId, { ...req, data: { ...req.data, agent: true } })) {
        if (ev.type === 'error') console.warn('[live transcript]', ev.message);
      }
    };
    this.liveQueue = this.liveQueue.then(record, record);
    return this.liveQueue;
  }

  /** Give the final agent line time to play before the invisible cut. */
  async waitForAgentReply(): Promise<void> {
    const seq = this.agentResponseSeq;
    const started = this.time;
    while (!this.ended && this.time - started < 6) {
      if (this.agentResponseSeq > seq && !this.npcAudible && this.time - this.lastAgentLineAt > 0.3) return;
      await this.wait(0.05);
    }
  }

  async stopAgent(): Promise<void> {
    const live = this.live;
    this.live = null;
    this.agentLive = false;
    this.onAgentMouth(0);
    await live?.close();
    this.refreshMic();
  }

  private failAgent(message: string): void {
    this.liveError = message;
    this.agentLive = false;
    this.npcAudible = false;
    this.onAgentMouth(0);
    this.deps.mic.watch(false);
    this.refreshMic();
    this.deps.hud.hint(message);
  }

  /** Fetching/PATCH errors surface before the SDK can open the microphone. */
  private async startAgent(): Promise<void> {
    if (this.liveStarting || this.agentLive || !this.deps.agent || !this.sessionId) return;
    this.liveStarting = true;
    try {
      const session = await getAgentSession(this.sessionId);
      if (this.ended || !this.speechEnabled) return;
      this.deps.audio.stopAllSpeech();
      const live = await startLiveVoice({
        signedUrl: session.signedUrl,
        variables: session.dynamicVariables,
        onLine: (who, text) => {
          if (this.ended || (!this.speechEnabled && who === 'you')) return;
          if (who === 'you') {
            this.cancelAgentSilence?.();
            if (this.typedEcho && text.trim() === this.typedEcho) { this.typedEcho = ''; return; }
            this.typedEcho = '';
            this.deps.hud.subtitle('you', text, 8000);
            this.deps.hud.setPartial(text);
            void this.turn({ event: 'speech', ctx: this.context(), text });
          } else {
            this.agentResponseSeq++;
            this.lastAgentLineAt = this.time;
            this.deps.hud.setPartial(null);
            this.deps.hud.subtitle('man', text, 9000);
            void this.turn({ event: 'agent_reply', ctx: this.context(), text });
          }
        },
        onSpeaking: (speaking) => {
          const finished = this.npcAudible && !speaking;
          this.npcAudible = speaking;
          this.onAgentMouth(speaking ? 0.3 : 0);
          if (finished) {
            this.cancelAgentSilence?.();
            const turn = this.turnCount;
            this.cancelAgentSilence = this.after(8, () => {
              if (this.speechEnabled && this.agentLive && !this.agentHearing && !this.npcAudible && this.turnCount === turn && !this.liveState.leaving) this.event('silence');
            });
          }
        },
        onHearing: (hearing) => {
          this.agentHearing = hearing;
          if (hearing) this.deps.hud.setPartial('Hearing you…');
        },
        onError: (message) => { this.failAgent(message); void this.stopAgent(); },
        onDisconnect: () => {
          if (this.speechEnabled && !this.ended && !this.liveError) this.failAgent('Live voice disconnected.');
        },
      });
      if (this.ended || !this.speechEnabled || this.liveError) { await live.close(); return; }
      this.live = live;
      this.agentLive = true;
      this.refreshMic();
      this.deps.hud.hint('Live. Talk normally.', 3200);
    } catch (err) {
      this.failAgent(err instanceof Error ? err.message : 'Could not start live voice.');
    } finally {
      this.liveStarting = false;
    }
  }

  /** Heard at once, from his last stance, while the real line is still being written. */
  private playFiller(): void {
    this.filler?.stop(0.02);
    const fwd = this.player.getForward(new THREE.Vector3());
    const d = Math.min(4, Math.max(1.2, this.context().distanceToMan || 2));
    const pos = this.player.position.clone().addScaledVector(fwd, d);
    pos.y = 1.55;
    this.filler = this.deps.audio.playFiller(fillerKind(this.lastStance), pos);
  }

  private endTalk(): void {
    if (!this.talkHeld) return;
    this.talkHeld = false;
    this.partial?.stop();
    this.partial = null;
    window.clearTimeout(this.limitTimer);
    this.limitTimer = 0;
    const { mic } = this.deps;
    void mic.stop().then((blob) => {
      if (this.ended) return;
      if (!blob || blob.size > MAX_CLIP_BYTES) {
        this.flashMissed();
        return;
      }
      void this.turn({ event: 'speech', ctx: this.context() }, blob);
    });
  }

  private async typeInstead(): Promise<void> {
    if (this.typing) return;
    this.typing = true;
    const { hud } = this.deps;
    this.player.inputEnabled = false;
    if (this.deps.requireLock) this.player.releaseLock();
    const text = await hud.askText('Say something…');
    // The Enter / Esc keypress is a user gesture, so the lock can be re-taken.
    if (this.deps.requireLock && !this.ended) this.player.requestLock();
    this.player.inputEnabled = true;
    this.typing = false;
    if (text && text.trim() && !this.ended) {
      hud.subtitle('you', text.trim(), 2600);
      if (this.deps.agent && this.live) {
        this.typedEcho = text.trim();
        void this.turn({ event: 'speech', ctx: this.context(), text: this.typedEcho });
        this.live.sendText(this.typedEcho);
      } else if (!this.deps.agent) void this.turn({ event: 'speech', ctx: this.context(), text: text.trim() });
    }
  }
}

/** Positions a point `gap` metres to one side of the player, preferring the open (road) side. */
export function pickSide(player: Player, gap: number): 'left' | 'right' {
  const fwd = player.getForward(new THREE.Vector3());
  // right-hand vector on the ground plane
  const rx = -fwd.z;
  const px = player.position.x;
  const rightX = px + rx * gap;
  const leftX = px - rx * gap;
  const ok = (x: number) => Math.abs(x) < 8.0;
  if (ok(rightX) && !ok(leftX)) return 'right';
  if (ok(leftX) && !ok(rightX)) return 'left';
  // both fine: take the side nearer the road centre, boxing her toward the wall
  return Math.abs(rightX) < Math.abs(leftX) ? 'right' : 'left';
}

