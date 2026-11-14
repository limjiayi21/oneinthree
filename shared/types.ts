/**
 * Shared contract between the browser client (src/) and the Worker (worker/).
 * Both sides import from here. Change it only with care: it is the seam
 * every module is built against.
 */

export type Pov = 'woman' | 'bystander';
export type ScenarioId = 'walk-home';

/** Facial / vocal emotion. Drives the face rig on the client and voice delivery on the server. */
export type Emotion =
  | 'neutral'
  | 'friendly' // fake charm, open smile
  | 'smirk' // cocky half-smile
  | 'leer' // looking her up and down
  | 'mocking' // laughing at her
  | 'annoyed'
  | 'angry'
  | 'contempt'
  | 'sheepish' // caught out, backing down
  | 'surprised'
  | 'afraid'
  | 'worried'
  | 'relieved'
  | 'determined';

/** The man's stance: the node of the decision model's state machine. */
export type ManStance =
  | 'idle' // has not engaged yet
  | 'opening' // first call-out / "compliment"
  | 'persist' // keeps talking, will not take the hint
  | 'follow' // trails her
  | 'block' // puts himself in her path
  | 'guilt' // "I'm just being nice", "why you gotta be like that"
  | 'hostile' // insults after rejection
  | 'intimidate' // close, aggressive, low voice
  | 'back_off' // gives up, usually with a parting remark
  | 'gone' // has left the scene
  | 'escalate'; // physical. The client cuts to black immediately; nothing is shown.

/** What his body should do next. The client maps this onto NPC behaviours. */
export type ManAction =
  | 'stay'
  | 'approach'
  | 'walk_alongside'
  | 'follow_behind'
  | 'stalk' // trails her without closing, watching
  | 'run_after' // hurries to catch her
  | 'step_closer'
  | 'block_path'
  | 'lean_in'
  | 'pull_arm' // yanks her back a step. Not a depicted assault.
  | 'back_away'
  | 'leave'
  | 'turn_on_bystander' // bystander POV: he squares up to the player instead
  | 'grab'; // only ever paired with stance 'escalate'

/** How the model read what the player (as the woman) just did or said. */
export type WomanStrategy =
  | 'ignore' // silence, keeps walking
  | 'polite_deflect' // "no thanks, have a good night"
  | 'firm_boundary' // "leave me alone", "stop following me"
  | 'hostile' // insults, swearing at him
  | 'excuse' // boyfriend, on the phone, someone is waiting
  | 'threaten_attention' // "I'll call the police", shouting for help
  | 'seek_help' // goes to others / into the shop
  | 'engage' // answers his questions, friendly
  | 'plead' // frightened, begging
  | 'unclear';

/** Right To Be's 5 Ds, plus the ways of not intervening. */
export type BystanderStrategy =
  | 'direct'
  | 'distract'
  | 'delegate'
  | 'delay'
  | 'document'
  | 'none'
  | 'aggressive' // threatens or insults the harasser: a risky form of Direct
  | 'unclear';

export type Strategy = WomanStrategy | BystanderStrategy;

export type SpeechTarget = 'man' | 'woman' | 'clerk' | 'nobody';

/** Non-speech things the player does, reported by the client's scene director. */
export type ClientEventType =
  // both POVs
  | 'begin' // the encounter starts (returns the man's opening)
  | 'speech' // player spoke: audio or text attached
  | 'agent_reply' // actual live agent transcript; never requests another spoken line
  | 'silence' // player said nothing since the man's last line
  // woman POV
  | 'sped_up'
  | 'stopped'
  | 'crossed_street'
  | 'pushed_past' // tried to get around him while blocked
  | 'backed_away'
  | 'entered_shop'
  | 'reached_home'
  // bystander POV
  | 'beat' // the scripted scene advanced (data.beat names it)
  | 'approached' // walked up close to them
  | 'stood_between' // physically put themselves between the two
  | 'filming_start'
  | 'filming_stop'
  | 'asked_clerk' // pressed the interact key on the shop clerk
  | 'walked_past' // passed them and kept going
  | 'left_scene'
  | 'scene_timeout'; // the scripted scene ran to its end with no intervention

/** Snapshot of the 3D world sent with every turn so the model has physical context. */
export interface WorldContext {
  /** Seconds since the scene started. */
  elapsed: number;
  /** Metres between the player and the man. */
  distanceToMan: number;
  /** 0..1 along the route home (woman POV) or along the street (bystander POV). */
  progress: number;
  /** Player's current horizontal speed in m/s. */
  playerSpeed: number;
  /** Is the player looking roughly at the man? */
  facingMan: boolean;
  /** Is he currently standing in the player's path? */
  manBlocking: boolean;
  /** Player has crossed to the far sidewalk. */
  oppositeSidewalk: boolean;
  // bystander POV only
  distanceToWoman?: number;
  lookingAt?: SpeechTarget;
  filming?: boolean;
  betweenThem?: boolean;
  /** Name of the current scripted beat. */
  beat?: string;
}

export interface TurnRequest {
  event: ClientEventType;
  ctx: WorldContext;
  /** For 'speech' when sent as JSON (typed fallback). Audio is sent as multipart instead. */
  text?: string;
  data?: Record<string, string | number | boolean>;
}

export interface ManDecision {
  stance: ManStance;
  action: ManAction;
  emotion: Emotion;
  /** 0..1 strength of the facial expression. */
  emotionIntensity: number;
  /** How close he wants to be, in metres (0.6 = in her face, 3 = keeping distance). */
  proximity: number;
}

/** Bystander POV: what the woman NPC does in response. */
export interface WomanDecision {
  emotion: Emotion;
  action: 'keep_walking' | 'stop' | 'step_back' | 'move_to_player' | 'hurry_home' | 'enter_shop' | 'freeze';
}

/** Why the model moved the way it did: shown in the debrief, with citations. */
export interface Rationale {
  /** One plain-English sentence. */
  text: string;
  /** Was this transition driven by cited numbers, reasoned from findings, or a labelled assumption? */
  basis: 'data' | 'inferred' | 'assumption';
  sourceIds: string[];
}

export type OutcomeKind =
  // woman POV
  | 'he_left' // he gave up before she got home
  | 'reached_home_alone' // got home, he had already dropped away
  | 'reached_home_followed' // got home but he saw where she lives
  | 'took_refuge' // went into the shop and waited
  | 'escalated' // he became physical: cut to black
  // bystander POV
  | 'intervened_he_left'
  | 'intervened_she_safe'
  | 'intervened_escalated'
  | 'no_intervention_she_escaped'
  | 'no_intervention_escalated'
  // either
  | 'exited';

/**
 * A turn is answered with a stream of newline-delimited JSON events
 * (Content-Type: application/x-ndjson) so the client can react progressively:
 * his face changes before he speaks, exactly as it would in life.
 */
export type TurnEvent =
  | { type: 'heard'; text: string }
  | {
      type: 'read';
      strategy: Strategy;
      confidence: number;
      target?: SpeechTarget;
      /** Full probability distribution from the decision model, for the debrief. */
      probs?: Record<string, number>;
    }
  | {
      type: 'decision';
      man: ManDecision;
      woman?: WomanDecision;
      /** 0..1 how frightened she is right now. Drives heartbeat, vignette, breathing. */
      fear: number;
      /** 0..1 how volatile he is. */
      tension: number;
      rationale?: Rationale;
      /** Rolling memory for the live agent. Empty when nothing has been said. */
      memory?: string;
    }
  | {
      type: 'line';
      speaker: 'man' | 'woman' | 'clerk';
      text: string;
      /** GET this for streamed audio/mpeg. Empty string when voice is unavailable. */
      audioUrl: string;
      emotion: Emotion;
      delivery: 'normal' | 'call_out' | 'low' | 'shout';
    }
  | { type: 'thought'; text: string; audioUrl: string; fear: number }
  | { type: 'outcome'; outcome: OutcomeKind }
  | { type: 'error'; message: string; recoverable: boolean }
  | { type: 'done'; turn: number; ms: Record<string, number> };

export interface CreateSessionRequest {
  pov: Pov;
  scenario: ScenarioId;
  /** Optional fixed seed for reproducible runs (tests, demos). */
  seed?: number;
}

export interface CreateSessionResponse {
  sessionId: string;
  pov: Pov;
  /** False when ELEVENLABS_API_KEY is missing: the client falls back to subtitles and typed input. */
  voice: boolean;
}

export interface HealthResponse {
  ok: boolean;
  voice: boolean;
  ai: boolean;
  /** True when the Worker can mint an ElevenLabs Agent signed URL (key and agent id). */
  agent?: boolean;
  /** True when ELEVENLABS_AGENT_ID is set. The id itself is never sent. */
  agentId?: boolean;
}

export interface TimelineEntry {
  /** Seconds since scene start. */
  t: number;
  actor: 'you' | 'man' | 'woman' | 'clerk' | 'thought' | 'event';
  text: string;
  /** Short tag, e.g. "Firm boundary", "Blocks path". */
  label?: string;
  rationale?: Rationale;
}

export interface Insight {
  title: string;
  body: string;
  /** ids into evidence.json stats */
  statIds: string[];
}

export interface FiveDResult {
  key: 'distract' | 'delegate' | 'document' | 'delay' | 'direct';
  used: boolean;
  /** What the player actually said or did, if used. */
  moments: string[];
  feedback: string;
}

export interface SummaryData {
  pov: Pov;
  outcome: { kind: OutcomeKind; title: string; body: string };
  durationSec: number;
  timeline: TimelineEntry[];
  insights: Insight[];
  /** ids into evidence.json stats, in display order */
  statIds: string[];
  /** id into evidence.json caseStudies */
  caseStudyId?: string;
  /** bystander POV only */
  fiveDs?: FiveDResult[];
  /** Transparency: how the man's behaviour was decided. */
  modelNotes: Rationale[];
}

/**
 * HTTP API (all under /api):
 *   GET  /api/health                       -> HealthResponse
 *   POST /api/session                      CreateSessionRequest -> CreateSessionResponse
 *   POST /api/session/:id/turn             TurnRequest as JSON, or multipart/form-data with
 *                                          fields "meta" (TurnRequest JSON) and "audio" (the clip)
 *                                          -> application/x-ndjson stream of TurnEvent
 *   GET  /api/session/:id/audio/:lineId    -> audio/mpeg (streamed TTS for a 'line' or 'thought')
 *   GET  /api/session/:id/summary          -> SummaryData
 */
export const API = {
  health: '/api/health',
  session: '/api/session',
  turn: (id: string) => `/api/session/${id}/turn`,
  agent: (id: string) => `/api/session/${id}/agent`,
  agentLine: (id: string) => `/api/session/${id}/agent-line`,
  summary: (id: string) => `/api/session/${id}/summary`,
} as const;

