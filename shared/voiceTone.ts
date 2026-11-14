/**
 * The three tones the voice is allowed to take, so the sound matches the face.
 * calm, irritated, nervous. Shared by the live agent. The TTS request in
 * worker/voices.ts uses the same three words; a test checks they agree.
 */
export type VoiceTone = 'calm' | 'irritated' | 'nervous';

const IRRITATED = new Set(['annoyed', 'angry', 'contempt', 'mocking', 'leer']);
const NERVOUS = new Set(['worried', 'afraid', 'sheepish', 'surprised']);

export function voiceTone(emotion: string): VoiceTone {
  if (IRRITATED.has(emotion)) return 'irritated';
  if (NERVOUS.has(emotion)) return 'nervous';
  return 'calm';
}

/** Bracketed tag the v4 model acts on and does not speak aloud. */
export function voiceTag(emotion: string): string {
  return `[${voiceTone(emotion)}]`;
}
