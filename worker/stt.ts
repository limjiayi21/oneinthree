/** Speech to text with ElevenLabs Scribe. The browser's clip is passed through untouched. */
import { STT_MODEL } from './voices';

export const STT_TIMEOUT_MS = 6000;

export async function transcribe(apiKey: string, clip: Blob, filename: string): Promise<string> {
  const form = new FormData();
  form.append('model_id', STT_MODEL);
  form.append('language_code', 'en');
  form.append('tag_audio_events', 'false');
  form.append('timestamps_granularity', 'none');
  form.append('file', clip, filename);
  const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: form,
    signal: AbortSignal.timeout(STT_TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`speech-to-text ${res.status}`);
  }
  const data = (await res.json()) as { text?: string };
  return cleanTranscript(data.text ?? '');
}

/** Drop audio-event tags and anything with no actual words in it. */
export function cleanTranscript(text: string): string {
  const stripped = text
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /[a-z0-9]/i.test(stripped) ? stripped : '';
}
