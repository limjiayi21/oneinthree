/**
 * Client module contracts. Each module exports a factory that returns one of
 * these interfaces; the scene directors in src/scenarios/ are written against
 * them and nothing else. Implement the interface exactly; add private helpers
 * freely, but do not change these signatures without updating every caller.
 *
 * WORLD COORDINATES (metres, three.js right-handed, Y up)
 *   The street runs along Z. The player starts at z = 0 and walks toward
 *   NEGATIVE Z; home is near z = -128.
 *     road:            x in [-4.5,  4.5]
 *     right sidewalk:  x in [ 4.5,  8.5]   <- the player's side (subway exit, shop, home)
 *     left sidewalk:   x in [-8.5, -4.5]
 *     building fronts: x = +8.5 and x = -8.5
 *     block:           z in [ 8, -140]
 *   Eye height 1.62 m. One unit = one metre everywhere.
 */

import type * as THREE from 'three';
import type { Emotion, SummaryData, Pov } from '../shared/types';

/* ------------------------------------------------------------------ engine */

export interface Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  /** Start / stop the render loop. */
  start(): void;
  stop(): void;
  /** Subscribe to the per-frame tick (dt in seconds, clamped to 0.05). Returns an unsubscribe. */
  onUpdate(fn: (dt: number, elapsed: number) => void): () => void;
  /**
   * 0..1 fear level. Drives post-processing only (vignette tightening, slight
   * desaturation, subtle chromatic pulse in time with the heartbeat).
   */
  setFear(level: number): void;
  /** Momentary full-screen impulse, e.g. on a startle. 0..1. */
  pulse(strength: number): void;
  dispose(): void;
}

/* ------------------------------------------------------------------- world */

/** Axis-aligned rectangle on the ground plane. */
export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export type WorldPoint =
  | 'subwayExit' // woman POV spawn: top of the subway stairs, right sidewalk, z ~ 0
  | 'bystanderSpawn' // bystander POV spawn: same exit
  | 'alleyMouth' // z ~ -20, where the false-alarm startle happens
  | 'alleySource' // inside the alley: where the noise / cat comes from
  | 'harasserSpot' // z ~ -40: where the man leans against the wall
  | 'shopDoor' // z ~ -78: lit corner shop (bodega) doorway, right side
  | 'shopInside' // just inside the doorway
  | 'clerkSpot' // where the clerk stands, visible through the doorway
  | 'homeDoor' // z ~ -128: her building's front door, right side
  | 'homeStoop' // on the sidewalk in front of homeDoor
  | 'farCorner' // z ~ -138: far end of the block (where the man leaves to)
  | 'nearCorner' // z ~ 6: behind the subway exit
  | 'womanStartBystander' // bystander POV: where the woman NPC begins, z ~ -22
  | 'passerbyA0'
  | 'passerbyA1' // a passer-by walks A0 -> A1 on the LEFT sidewalk
  | 'passerbyB0'
  | 'passerbyB1';

export type WorldZone =
  | 'alleyTrigger' // crossing it fires the startle
  | 'noticeTrigger' // crossing it makes the man notice her (z ~ -30)
  | 'shopEntrance' // stepping in counts as entering the shop
  | 'homeEntrance' // stepping in counts as reaching home
  | 'road'
  | 'leftSidewalk'
  | 'rightSidewalk';

export interface StreetWorld {
  /** Root of everything; already added to the scene by the factory. */
  readonly group: THREE.Group;
  /** Static obstacles (building fronts, parked cars, hydrants, trash cans, stairs rails). */
  readonly colliders: Rect[];
  /** The area the player may never leave. */
  readonly bounds: Rect;
  readonly points: Record<WorldPoint, THREE.Vector3>;
  readonly zones: Record<WorldZone, Rect>;
  update(dt: number, elapsed: number): void;
  /** Animate a door. */
  setDoorOpen(which: 'home' | 'shop', open: boolean): void;
  /** Topples the trash can / sends the cat out of the alley for the startle beat. */
  triggerAlleyEvent(): void;
  /** A car drives down the road once (headlights sweep across the scene). */
  spawnPassingCar(direction: 1 | -1): void;
  /** Ground material under a point, for footstep sounds. */
  surfaceAt(x: number, z: number): 'concrete' | 'asphalt' | 'metal' | 'tile';
  dispose(): void;
}

/* ------------------------------------------------------------------ player */

/** A moving circular obstacle (an NPC). */
export interface DynamicCollider {
  getPosition(): THREE.Vector3;
  radius: number;
}

export interface PlayerEvents {
  /** Fired on each footfall while walking. */
  step: { surface: 'concrete' | 'asphalt' | 'metal' | 'tile'; speed: number; position: THREE.Vector3 };
  lock: undefined;
  unlock: undefined;
  /** The player walked into a dynamic collider (an NPC) and was stopped. */
  bumped: { collider: DynamicCollider };
}

export interface Player {
  /** Feet position on the ground (y = 0). Live reference; read-only for callers. */
  readonly position: THREE.Vector3;
  /** Current horizontal speed, m/s. */
  readonly speed: number;
  /** Yaw in radians (0 = facing -Z). */
  readonly yaw: number;
  /** When false, WASD and mouse look are ignored (cutscenes, fades). */
  inputEnabled: boolean;
  readonly isLocked: boolean;
  /** Must be called from a user gesture. */
  requestLock(): void;
  releaseLock(): void;
  setPose(position: THREE.Vector3, yaw: number): void;
  /** Unit vector the player is facing on the ground plane. */
  getForward(out?: THREE.Vector3): THREE.Vector3;
  /** World position of the eyes. */
  getEyePosition(out?: THREE.Vector3): THREE.Vector3;
  /** True if `point` is within `halfAngleDeg` of the view direction. */
  isLookingAt(point: THREE.Vector3, halfAngleDeg?: number): boolean;
  addCollider(c: DynamicCollider): () => void;
  on<K extends keyof PlayerEvents>(event: K, cb: (payload: PlayerEvents[K]) => void): () => void;

  /* Involuntary body reactions: the body acts before she decides to. */
  /** Sharp recoil away from `from`: a short backward lurch plus camera jerk. strength 0..1 */
  flinch(from: THREE.Vector3, strength?: number): void;
  /** A deliberate, forced step (or two) back from `from`, over `duration` seconds. */
  stepBack(from: THREE.Vector3, distance?: number, duration?: number): void;
  /** Whole-body jump: vertical jolt, shoulders up, breath caught. strength 0..1 */
  startle(strength?: number): void;
  /** Pulls the gaze toward a point for `duration` seconds (a nervous glance), then releases. */
  glanceAt(target: THREE.Vector3, duration?: number, weight?: number): void;
  /** 0..1. Raises breathing sway and adds a fine tremor to the view and hands. */
  setTension(level: number): void;
  /** Show or hide the first-person body (legs, feet, arm holding keys/phone). */
  setBodyVisible(visible: boolean): void;
  /** Raise the phone as if filming (bystander POV) or lower it. */
  setPhoneRaised(raised: boolean): void;
  /** Freeze in place for a moment (fear freeze). */
  freeze(duration: number): void;
  update(dt: number): void;
  dispose(): void;
}

/* -------------------------------------------------------------- characters */

export type Gesture =
  | 'beckon'
  | 'shrug'
  | 'open_arms' // "what, I'm just talking"
  | 'point'
  | 'hands_up' // mock surrender, backing off
  | 'dismiss' // waves her off
  | 'lean_in'
  | 'reach' // arm out toward her (never completes: the scene cuts first)
  | 'wave'
  | 'clutch_bag'
  | 'arms_crossed'
  | 'check_phone'
  | 'look_around';

export type Posture = 'stand' | 'lean_wall' | 'relaxed' | 'aggressive' | 'guarded' | 'cower';

export interface HumanOptions {
  build: 'man' | 'woman';
  /** Height in metres. */
  height?: number;
  skin?: number;
  hair?: number;
  hairStyle?: 'short' | 'buzz' | 'long' | 'ponytail' | 'beanie' | 'hood_down';
  top?: number;
  topStyle?: 'hoodie' | 'jacket' | 'coat' | 'tee' | 'apron';
  bottom?: number;
  shoes?: number;
  /** Shoulder bag etc. */
  accessory?: 'none' | 'tote' | 'backpack' | 'headphones';
}

export interface Human {
  readonly root: THREE.Group;
  /** World-space head position (for gaze targets and spatial voice). */
  getHeadPosition(out?: THREE.Vector3): THREE.Vector3;
  /** Blend to an expression over ~0.3 s. intensity 0..1 */
  setEmotion(emotion: Emotion, intensity?: number): void;
  /** Head and eyes track this point; null returns to forward. */
  setGaze(target: THREE.Vector3 | null): void;
  /** 0..1 mouth openness; feed it the voice level every frame while he speaks. */
  setTalking(level: number): void;
  playGesture(gesture: Gesture): void;
  setPosture(posture: Posture): void;
  /** Walk-cycle speed in m/s (0 = idle). The NPC controller calls this; you normally do not. */
  setLocomotion(speed: number): void;
  setVisible(visible: boolean): void;
  update(dt: number): void;
  dispose(): void;
}

export type NpcBehaviour =
  | { type: 'idle'; face?: () => THREE.Vector3 }
  | { type: 'goTo'; target: THREE.Vector3; speed?: number; faceOnArrive?: () => THREE.Vector3 }
  | { type: 'path'; points: THREE.Vector3[]; speed?: number; loop?: boolean }
  /** Walk beside a moving target, slightly ahead, turned toward them. */
  | { type: 'walkAlongside'; target: () => THREE.Vector3; targetForward: () => THREE.Vector3; side: 'left' | 'right'; gap: number }
  /** Trail a moving target at a distance. */
  | { type: 'followBehind'; target: () => THREE.Vector3; gap: number; speed?: number }
  /** Get in front of the target, on their line of travel, and stay there as they try to go around. */
  | { type: 'block'; target: () => THREE.Vector3; targetForward: () => THREE.Vector3; gap: number }
  /** Close to `gap` metres facing the target, then hold. */
  | { type: 'closeIn'; target: () => THREE.Vector3; gap: number; speed?: number }
  | { type: 'backAway'; from: () => THREE.Vector3; distance: number; speed?: number }
  /** Walk off and disappear (hidden on arrival). */
  | { type: 'leave'; to: THREE.Vector3; speed?: number };

export interface Npc extends DynamicCollider {
  readonly human: Human;
  /** Feet position (y = 0). Live reference. */
  readonly position: THREE.Vector3;
  readonly behaviour: NpcBehaviour['type'];
  /** Current speed in m/s. */
  readonly speed: number;
  setPose(position: THREE.Vector3, yaw: number): void;
  setBehaviour(behaviour: NpcBehaviour): void;
  /** Resolves when the current goTo / leave / backAway / closeIn completes (or is replaced). */
  arrived(): Promise<void>;
  distanceTo(point: THREE.Vector3): number;
  /** Static obstacles to steer around (pass world.colliders). */
  setObstacles(colliders: Rect[], bounds: Rect): void;
  /** Other moving bodies to keep clear of (the player, other NPCs). */
  addAvoid(c: DynamicCollider): void;
  /** Called on each footfall, for spatialised footstep sounds. */
  onStep(cb: (position: THREE.Vector3, speed: number) => void): void;
  update(dt: number): void;
  dispose(): void;
}

/* ------------------------------------------------------------------- audio */

export type SfxName =
  | 'ambience_city_night' // loop
  | 'ambience_shop_hum' // loop, positional at the shop
  | 'subway_rumble'
  | 'distant_siren'
  | 'car_pass'
  | 'trash_can_crash'
  | 'cat_yowl'
  | 'door_buzz_open'
  | 'door_close_heavy'
  | 'keys_jingle'
  | 'gasp'
  | 'breath_shaky' // loop
  | 'exhale_relief'
  | 'cloth_rustle'
  | 'phone_camera_start'
  | 'shop_bell'
  | 'tinnitus' // rising tone used on the cut to black
  | 'impact_thud'
  | 'wind_gust';

export interface SpeechHandle {
  /** Resolves when playback ends (or fails, or is stopped). Never rejects. */
  readonly done: Promise<void>;
  stop(): void;
}

export interface SpeakOptions {
  /** Live world position of the speaker; omit for an in-head voice (her thoughts). */
  position?: () => THREE.Vector3;
  /** 'voice' = a person in the world; 'thought' = her inner voice (close, slight reverb, no spatialisation). */
  bus: 'voice' | 'thought';
  volume?: number;
  /** Called every frame with the 0..1 output level, for lip movement. */
  onLevel?: (level: number) => void;
}

export interface AudioEngine {
  /** Create / resume the AudioContext. Must follow a user gesture. */
  resume(): Promise<void>;
  /** Load every sound in the manifest; missing files fall back to synthesis. */
  load(onProgress?: (fraction: number) => void): Promise<void>;
  setListener(position: THREE.Vector3, forward: THREE.Vector3): void;
  startAmbience(): void;
  stopAmbience(fadeSeconds?: number): void;
  play(name: SfxName, opts?: { position?: THREE.Vector3; volume?: number; rate?: number; loop?: boolean }): { stop(fade?: number): void };
  footstep(surface: 'concrete' | 'asphalt' | 'metal' | 'tile', opts?: { position?: THREE.Vector3; volume?: number; heavy?: boolean }): void;
  /** Heartbeat. bpm 60-150; volume 0 turns it off. */
  setHeartbeat(bpm: number, volume: number): void;
  /** 0..1 audible breathing. */
  setBreathing(level: number): void;
  /** 0..1: low-passes and ducks the outside world as fear rises (tunnel hearing). */
  setMuffle(level: number): void;
  /** Stream and play speech from a URL (audio/mpeg). */
  speak(url: string, opts: SpeakOptions): SpeechHandle;
  stopAllSpeech(): void;
  /** Hard cut of everything except the tinnitus tone: used for the cut to black. */
  cutToSilence(): void;
  /** Fade the master bus. */
  setMaster(volume: number, fadeSeconds?: number): void;
  dispose(): void;
}

export interface Mic {
  /** Ask for microphone permission. Resolves false if denied or unavailable. */
  init(): Promise<boolean>;
  readonly available: boolean;
  readonly recording: boolean;
  /** Returns false if the recorder could not start. */
  start(): boolean;
  /** Keep sampling the level while not recording, for hands-free. */
  watch(on: boolean): void;
  /** Stops and returns the clip, or null if it was too short, empty, or truly silent. */
  stop(): Promise<Blob | null>;
  /** Live input level 0..1 while recording. */
  level(): number;
  dispose(): void;
}

/* ---------------------------------------------------------------------- ui */

export type MicState = 'hidden' | 'idle' | 'recording' | 'thinking' | 'unavailable' | 'missed';

export interface Hud {
  setVisible(visible: boolean): void;
  /** Spoken-line subtitle. Auto-clears after `ms` (default scales with length). */
  subtitle(speaker: 'man' | 'woman' | 'you' | 'clerk', text: string, ms?: number): void;
  clearSubtitle(): void;
  /** Her inner voice. Rendered differently from subtitles: centred, italic, breathing. intensity 0..1 */
  thought(text: string, intensity?: number, ms?: number): void;
  /** Small control hint at the bottom ("Hold SPACE to speak"). null clears. */
  hint(text: string | null, ms?: number): void;
  /** Top-left one-line objective ("Get home."). null clears. */
  objective(text: string | null): void;
  setMic(state: MicState, level?: number): void;
  /** 0..1: DOM-side fear cues (pulsing edge darkness). */
  setFear(level: number): void;
  /** Fade the whole view to/from black. */
  fade(toBlack: boolean, ms?: number): Promise<void>;
  /** Text card over black ("11:42 PM" / "Four blocks from home"). Resolves after it has faded out. */
  card(title: string, subtitle?: string, ms?: number): Promise<void>;
  /** Phone-camera overlay for the Document action. */
  setFilming(on: boolean): void;
  /** Context prompt near the crosshair ("E  Ask the clerk for help"). null clears. */
  prompt(text: string | null): void;
  /** Typed-speech fallback: opens a text box, resolves with the text or null if cancelled. */
  askText(placeholder?: string): Promise<string | null>;
  /** Pause overlay shown when pointer lock is lost. Resolves with the user's choice. */
  pause(): Promise<'resume' | 'exit'>;
  dispose(): void;
}

export interface Screens {
  /** Landing + content note + how it works + headphone/mic check. Resolves when the user starts. */
  intro(opts: { voiceAvailable: boolean; requestMic: () => Promise<boolean> }): Promise<void>;
  /** Short brief before a part. */
  briefing(pov: Pov): Promise<void>;
  /** Debrief for a part. */
  summary(data: SummaryData): Promise<'continue' | 'retry'>;
  /** Closing screen: resources and sources. */
  closing(): Promise<'restart'>;
  /** Loading / error states. */
  loading(message: string | null, fraction?: number): void;
  error(message: string): void;
}

/* --------------------------------------------------------------- factories
 * Each module exports exactly this factory (named export), from this file:
 *
 *   src/engine/engine.ts      createEngine(canvas: HTMLCanvasElement): Engine
 *   src/world/street.ts       createStreet(engine: Engine): StreetWorld
 *   src/player/player.ts      createPlayer(engine: Engine, world: Pick<StreetWorld, 'colliders' | 'bounds' | 'surfaceAt'>, opts?: { body?: 'woman' | 'bystander' }): Player
 *   src/characters/human.ts   createHuman(opts: HumanOptions): Human
 *   src/characters/npc.ts     createNpc(human: Human, scene: THREE.Scene): Npc
 *   src/audio/engine.ts       createAudio(): AudioEngine
 *   src/audio/mic.ts          createMic(): Mic
 *   src/ui/hud.ts             createHud(root: HTMLElement): Hud
 *   src/ui/screens.ts         createScreens(root: HTMLElement): Screens
 */
