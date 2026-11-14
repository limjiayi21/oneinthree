/**
 * Speech to text with ElevenLabs Scribe.
 *
 * Request shape, checked against
 * https://elevenlabs.io/docs/api-reference/speech-to-text/convert
 * (Scribe v3, November 2026):
 *   POST /v1/speech-to-text
 *   multipart: model_id=scribe_v3, file=<audio>, language_code=en, tag_audio_events=false
 *   Do not set Content-Type yourself; fetch supplies the multipart boundary.
 *   timestamps_granularity is omitted. The documented enum is `word` | `character`
 *   (`none` is only mentioned as a value to avoid when a combined transcript needs
 *   timestamps). Omitting it is the documented default and skips the extra payload.
 *
 * The clip is re-wrapped with a parameter-free MIME type before it is sent.
 * `audio/webm;codecs=opus` is still webm/opus, but the semicolon breaks some
 * multipart parsers and the file arrives empty.
 */
import { MAX_CLIP_BYTES, baseAudioType } from '../shared/audio';
import { STT_MODEL } from './voices';

export const STT_TIMEOUT_MS = 6000;
export { MAX_CLIP_BYTES };

export class ClipTooLargeError extends Error {
  constructor(bytes: number) {
    super(`clip too large (${bytes} bytes)`);
    this.name = 'ClipTooLargeError';
  }
}

/** Copy the bytes into a fresh Blob whose type has no codec parameters. */
export async function prepareClip(clip: Blob, filename: string): Promise<{ blob: Blob; filename: string; type: string }> {
  const named = baseAudioType(clip.type || '', filename);
  const bytes = await clip.arrayBuffer();
  return { blob: new Blob([bytes], { type: named.type }), filename: named.filename, type: named.type };
}

export async function transcribe(apiKey: string, clip: Blob, filename: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (clip.size <= 0) return '';
  if (clip.size > MAX_CLIP_BYTES) throw new ClipTooLargeError(clip.size);
  const prepared = await prepareClip(clip, filename);
  const form = new FormData();
  form.append('model_id', STT_MODEL);
  form.append('language_code', 'en');
  form.append('tag_audio_events', 'false');
  form.append('file', prepared.blob, prepared.filename);
  let res: Response;
  try {
    res = await fetchImpl('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: form,
      signal: AbortSignal.timeout(STT_TIMEOUT_MS),
    });
  } catch (err) {
    const name = (err as Error)?.name ?? '';
    if (name === 'TimeoutError' || name === 'AbortError') throw new Error('speech-to-text timed out');
    throw new Error(`speech-to-text network (${(err as Error)?.message ?? 'failed'})`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
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
