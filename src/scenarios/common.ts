/**
 * Shared machinery for the scene directors: a pausable scene clock, the fear
 * model that drives every sensory channel, speech and thought playback,
 * push-to-talk (pressing Space while he talks cuts him off), and the
 * serialised turn pipeline to the Worker.
 */
import * as THREE from 'three';
import type { AudioEngine, Engine, Hud, Mic, Npc, Player, Rect, StreetWorld } from '../contracts';
import type {
  ClientEventType,
  Emotion,
  OutcomeKind,
  Pov,
  TurnEvent,
  TurnRequest,
  WorldContext,
} from '../../shared/types';
import { createSession, sendTurn } from '../net/api';
import type { PhoneLink } from '../net/phoneLink';
import { MAX_CLIP_BYTES } from '../../shared/audio';
import { MAX_CLIP_MS, bargeOnTalkStart, heardPortion, pushToTalkDown, type TalkOrigin } from '../audio/talk';
import { captionHoldMs } from '../ui/captions';
import scriptJson from '../../content/script.json';
import type { EyeLookSource } from '../player/eyes';
import type { HandGestureSource } from '../player/hands';

export interface ScriptLine {
  speaker: 'thought' | 'woman' | 'man' | 'clerk' | 'self';
  text: string;
  emotion: Emotion;
  delivery: 'normal' | 'call_out' | 'low' | 'shout';
}
export const SCRIPT = (scriptJson as unknown as { lines: Record<string, ScriptLine> }).lines;
export const voUrl = (id: string) => `/audio/vo/${id}.mp3`;

export interface SceneDeps {
  engine: Engine;
  world: StreetWorld;
  audio: AudioEngine;
  mic: Mic;
  hud: Hud;
  /** True when the server can voice lines. */
  voice: boolean;
  /** Dev / accessibility: run without pointer lock. */
  requireLock: boolean;
  /** Optional fixed seed for reproducible runs. */
  seed?: number;
  /** Optional webcam head look (G toggles it). */
  eyes?: EyeLookSource;
  /** Optional webcam hand gestures (H toggles it). */
  hands?: HandGestureSource;
  /** Optional paired phone; adds walking to the keyboard. */
  phone?: PhoneLink;
  /** ?demo=1: the short, guided Part 1 (see womanDemo.ts). */
  demo?: boolean;
  /** 'golden': the scripted reference playthrough (docs/golden-run.md). */
  run?: 'golden';
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
  /** Slow motion: 1 is real time. Scales the scene clock, bodies and the player (mouse look is not slowed). */
  timeScale = 1;
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
  /** NPCs whose own footstep sounds are silenced (another system voices them, see echoSteps.ts). */
  readonly muteSteps = new Set<Npc>();
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
  private limitTimer = 0;
  private missedUntil = 0;
  private captionToken = 0;
  /** True while an NPC line is still audible, so a new clip can cut it. */
  private npcAudible = false;
  /** Scenes switch this on once the player may speak. */
  speechEnabled = false;
  /** His line that is playing now, to work out how much of it she let him say. */
  private speaking: { text: string; startedAt: number; seconds: number } | null = null;
  /** She cut him off; the next thing she says carries this so he knows. */
  private cutOff: { line: string; heard: string } | null = null;
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
    const res = await createSession({ pov: this.pov, scenario: 'walk-home', seed: this.deps.seed, ...(this.deps.run && this.pov === 'woman' ? { run: this.deps.run } : {}) });
    this.sessionId = res.sessionId;
  }

  addNpc(npc: Npc, heavySteps: boolean): void {
    this.npcs.push(npc);
    npc.setObstacles(this.deps.world.colliders, this.deps.world.bounds);
    npc.onStep((pos, speed) => {
      if (this.muteSteps.has(npc)) return;
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
    dt *= this.timeScale;
    this.time += dt;

    world.update(dt, elapsed);
    this.player.update(dt);
    for (const npc of this.npcs) {
      npc.update(dt);
      npc.human.update(dt);
    }
    audio.setListener(this.player.getEyePosition(this.tmpA), this.player.getForward(this.tmpB));

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
    this.resolveEnd(outcome);
  }

  dispose(): void {
    this.ended = true;
    window.clearTimeout(this.limitTimer);
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
    this.deps.hud.setLevel(null);
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
    const { audio, hud } = this.deps;
    const estimate = Math.max(1.4, text.length * 0.062);
    const hasAudio = Boolean(url && this.deps.voice);
    const token = ++this.captionToken;
    // The auto-clear must outlast the line. Voiced lines are cleared when the
    // audio actually ends; a text-length timer was dropping the subtitle early.
    const hold = hasAudio ? captionHoldMs(true, text) : Math.ceil((estimate + 0.8) * 1000);
    hud.subtitle(speaker, text, hold);
    this.npcAudible = true;
    this.speaking = { text, startedAt: performance.now(), seconds: estimate };
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
        this.speaking = null;
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
    if (url && this.deps.voice) {
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
    const isSpeech = req.event === 'speech';
    const terminal = req.event === 'reached_home' || req.event === 'entered_shop' || req.event === 'scene_timeout';
    if (this.busy) {
      // Two utterances while he is answering: keep both sets of words, in order.
      const prev = this.pending?.req;
      if (isSpeech && prev?.event === 'speech' && prev.text && req.text && !audio && !this.pending?.audio) {
        this.pending = { req: { ...req, text: `${prev.text} ${req.text}`, interrupted: prev.interrupted ?? req.interrupted } };
        return;
      }
      // Otherwise keep only the most important thing waiting: speech and scene-ending events beat everything.
      if (isSpeech || terminal || !this.pending) this.pending = { req, audio };
      return;
    }
    this.busy = true;
    this.speechTurn = isSpeech;
    this.turnCount++;
    if (isSpeech) this.deps.hud.setMic('thinking');
    try {
      for await (const ev of sendTurn(this.sessionId, req, audio)) {
        if (this.ended) break;
        if (ev.type === 'heard') {
          if (ev.text) this.deps.hud.subtitle('you', ev.text, 2600);
          else this.flashMissed();
        }
        if (ev.type === 'error') {
          console.warn('[turn]', ev.message);
          if (isSpeech) this.flashMissed();
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
    if (!this.speechEnabled) hud.setMic('hidden');
    else if (this.talkHeld) hud.setMic('recording', mic.level());
    else if (performance.now() < this.missedUntil) hud.setMic('missed');
    else if (this.busy && this.speechTurn) hud.setMic('thinking');
    else hud.setMic(mic.available ? 'idle' : 'unavailable');
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
      if (e.code === 'Space') {
        e.preventDefault();
        const action = pushToTalkDown({ enabled: this.speechEnabled, held: this.talkHeld, available: mic.available });
        if (e.repeat || action === 'ignore') return;
        if (action === 'type') {
          void this.typeInstead();
          return;
        }
        this.beginTalk('ptt');
      } else if (e.code === 'KeyT') {
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

    // Preserve main's G/H webcam controls; only meter the existing recording.
    this.onFrame(() => {
      if (this.talkHeld) hud.setMic('recording', mic.level());
    });
  }

  private beginTalk(origin: TalkOrigin): void {
    const { mic, hud } = this.deps;
    if (this.talkHeld || this.ended || !this.speechEnabled) return;
    if (bargeOnTalkStart(this.npcAudible)) this.bargeIn();
    this.talkOrigin = origin;
    this.talkHeld = true;
    this.missedUntil = 0;
    if (!mic.start()) {
      this.talkHeld = false;
      this.flashMissed();
      return;
    }
    hud.setMic('recording', 0);
    window.clearTimeout(this.limitTimer);
    this.limitTimer = window.setTimeout(() => {
      if (this.talkHeld) this.endTalk();
    }, MAX_CLIP_MS);
  }

  private endTalk(): void {
    if (!this.talkHeld) return;
    this.talkHeld = false;
    window.clearTimeout(this.limitTimer);
    this.limitTimer = 0;
    const { mic } = this.deps;
    void mic.stop().then((blob) => {
      if (this.ended) return;
      if (!blob || blob.size > MAX_CLIP_BYTES) {
        this.flashMissed();
        return;
      }
      void this.turn({ event: 'speech', ctx: this.context(), source: 'ptt', ...this.takeCutOff() }, blob);
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
      void this.turn({ event: 'speech', ctx: this.context(), text: text.trim(), source: 'typed', ...this.takeCutOff() });
    }
  }

  /* ------------------------------------------------------------ barge-in */

  /** Stop him mid-line because she is talking, and remember how much he got out. */
  private bargeIn(): void {
    const { audio, hud } = this.deps;
    const sp = this.speaking;
    if (sp) {
      const played = (performance.now() - sp.startedAt) / 1000;
      if (played < sp.seconds - 0.25) this.cutOff = { line: sp.text, heard: heardPortion(sp.text, played, sp.seconds) };
    }
    audio.stopAllSpeech();
    this.npcAudible = false;
    this.speaking = null;
    this.captionToken++;
    hud.clearSubtitle();
  }

  private takeCutOff(): { interrupted?: { line: string; heard: string } } {
    const cut = this.cutOff;
    this.cutOff = null;
    return cut ? { interrupted: cut } : {};
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
