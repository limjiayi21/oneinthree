/**
 * Every ElevenLabs choice in one place: models, voices, voice settings and
 * the mapping from Emotion + delivery to the audio tags the v4 models act on.
 *
 * Shared by the Worker (live lines) and scripts/gen-voice.mjs (pre-rendered
 * lines), which imports this file directly under Node's type stripping: keep
 * it free of runtime imports and of non-erasable TypeScript syntax.
 *
 * How these were chosen (measured 2026-11-12 against the live API):
 *  - eleven_v4_turbo answers on the plain HTTP stream endpoint with a time to
 *    first byte around 0.2 s and acts on audio tags (a "low" line came back
 *    about 6 dB quieter and far lower in pitch than a "shout"). eleven_v4
 *    sounds the same on the same voice (matching pitch, loudness and length)
 *    but takes 0.5 to 0.9 s to first byte, so it is used only for pre-rendering.
 *    eleven_flash_v2_5 is as fast as turbo but reads the tags aloud.
 *  - Voices are premade voices on the account, picked from their labels and
 *    then checked with a listening proxy (Clef-Omni on the rendered clips).
 */
import type { Emotion } from '../shared/types';

export type Delivery = 'normal' | 'call_out' | 'low' | 'shout';
export type VoiceRole = 'man' | 'woman' | 'thought' | 'clerk';

/** Live lines: fastest model that still acts on audio tags. */
export const TTS_LIVE_MODEL = 'eleven_v4_turbo';
/** Pre-rendered lines: same family, no latency constraint. */
export const TTS_RENDER_MODEL = 'eleven_v4';
export const TTS_OUTPUT_FORMAT = 'mp3_44100_128';
/** Batch speech-to-text. Takes MediaRecorder's webm/opus (and Safari's mp4) as-is. */
export const STT_MODEL = 'scribe_v3';
export const SFX_MODEL = 'eleven_text_to_sound_v3';

export interface VoiceSpec {
  id: string;
  name: string;
  /** Why this voice, from its ElevenLabs labels. */
  note: string;
  settings: { stability: number; similarity_boost: number };
}

export const VOICES: Record<VoiceRole, VoiceSpec> = {
  man: {
    id: 'iP95p4xoKVk53GoZ742B',
    name: 'Chris - Charming, Down-to-Earth',
    note: 'male, American, casual, conversational: "natural and real". A man who thinks he is being charming; the edge comes from the tags, not from a villain voice.',
    settings: { stability: 0.35, similarity_boost: 0.8 },
  },
  woman: {
    id: 'cgSgspJ2msm6clMCkdW9',
    name: 'Jessica - Playful, Bright, Warm',
    note: 'female, young, American, conversational. Her speaking voice in the bystander scene.',
    settings: { stability: 0.4, similarity_boost: 0.8 },
  },
  thought: {
    id: 'cgSgspJ2msm6clMCkdW9',
    name: 'Jessica - Playful, Bright, Warm',
    note: 'The same woman, close and quiet: her inner voice.',
    settings: { stability: 0.5, similarity_boost: 0.8 },
  },
  clerk: {
    id: 'pqHfZKP75CvOlQylNhV4',
    name: 'Bill - Wise, Mature, Balanced',
    note: 'male, old, American: "friendly and comforting". The shopkeeper: older, warm, firm.',
    settings: { stability: 0.5, similarity_boost: 0.8 },
  },
};

const MAN_EMOTION: Partial<Record<Emotion, string>> = {
  friendly: 'friendly, flirty',
  smirk: 'cocky, smirking',
  leer: 'slow, leering',
  mocking: 'mocking, sneering',
  annoyed: 'annoyed, defensive',
  angry: 'angry',
  contempt: 'contemptuous, dismissive',
  sheepish: 'backing down, muttering',
  surprised: 'caught off guard',
};

const MAN_DELIVERY: Record<Delivery, string> = {
  normal: '',
  call_out: 'calling out',
  low: 'low, quiet, threatening',
  shout: 'shouting',
};

const WOMAN_EMOTION: Partial<Record<Emotion, string>> = {
  afraid: 'frightened, shaky',
  worried: 'tense, hurried',
  relieved: 'relieved, breathless',
  determined: 'firm',
  friendly: 'forced brightness, nervous',
  surprised: 'startled',
};

const THOUGHT_EMOTION: Partial<Record<Emotion, string>> = {
  afraid: 'whispering, frightened',
  worried: 'whispering, tense',
  relieved: 'quiet, relieved',
  neutral: 'quiet, to herself',
  determined: 'whispering, urgent',
  surprised: 'whispering, startled',
};

const CLERK_EMOTION: Partial<Record<Emotion, string>> = {
  worried: 'concerned, gentle',
  determined: 'firm',
  angry: 'firm, angry',
};

/** The bracketed delivery note the v4 models act on (never spoken aloud). Empty string for a plain read. */
export function audioTag(role: VoiceRole, emotion: Emotion, delivery: Delivery): string {
  let parts: string[];
  if (role === 'man') parts = [MAN_DELIVERY[delivery], MAN_EMOTION[emotion] ?? ''];
  else if (role === 'thought') parts = [THOUGHT_EMOTION[emotion] ?? 'whispering, tense'];
  else if (role === 'woman') parts = [delivery === 'shout' ? 'shouting' : delivery === 'call_out' ? 'calling out' : '', WOMAN_EMOTION[emotion] ?? 'nervous'];
  else parts = [delivery === 'call_out' || delivery === 'shout' ? 'calling out' : '', CLERK_EMOTION[emotion] ?? ''];
  const text = parts.filter(Boolean).join(', ');
  return text ? `[${text}]` : '';
}

export interface TtsRequest {
  voiceId: string;
  url: string;
  body: {
    text: string;
    model_id: string;
    voice_settings: { stability: number; similarity_boost: number };
    /** Previous spoken line, for prosody. Omitted on the first line of a scene. */
    previous_text?: string;
  };
}

/**
 * The exact request both the Worker and the generation script send for a line.
 *
 * `POST /v1/text-to-speech/{voice_id}/stream?output_format=mp3_44100_128`
 * with `model_id` `eleven_v4_turbo` (acts on audio tags, ~100 ms to first byte).
 * `previous_text` is the documented stitching field; it is sent only when the
 * scene already has a line, and it is never a substitute for the current text.
 */
export function buildTts(
  role: VoiceRole,
  text: string,
  emotion: Emotion,
  delivery: Delivery,
  model: string = TTS_LIVE_MODEL,
  previousText?: string,
): TtsRequest {
  const voice = VOICES[role];
  const tag = audioTag(role, emotion, delivery);
  // A shouted line stays less stable (wider range); a low or whispered one a little steadier.
  const stability = delivery === 'shout' ? Math.max(0.25, voice.settings.stability - 0.1) : voice.settings.stability;
  const previous = previousText?.replace(/\s+/g, ' ').trim().slice(0, 240);
  return {
    voiceId: voice.id,
    url: `https://api.elevenlabs.io/v1/text-to-speech/${voice.id}/stream?output_format=${TTS_OUTPUT_FORMAT}`,
    body: {
      text: tag ? `${tag} ${text}` : text,
      model_id: model,
      voice_settings: { stability, similarity_boost: voice.settings.similarity_boost },
      ...(previous ? { previous_text: previous } : {}),
    },
  };
}

/** Static URL of a pre-rendered line (public/audio/vo/<id>.mp3). */
export const voUrl = (id: string): string => `/audio/vo/${id}.mp3`;
