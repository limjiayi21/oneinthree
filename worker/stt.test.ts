import { describe, expect, it, vi } from 'vitest';
import { MAX_CLIP_BYTES, baseAudioType } from '../shared/audio';
import { STT_MODEL } from './voices';
import { ClipTooLargeError, cleanTranscript, prepareClip, transcribe } from './stt';

function wavLike(bytes: number, type = 'audio/webm;codecs=opus'): Blob {
  return new Blob([new Uint8Array(bytes)], { type });
}

describe('Scribe request', () => {
  it('sends scribe_v3 and a codec-free file', async () => {
    let seen: { url: string; headers: Headers; form: FormData } | null = null;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as FormData;
      seen = { url: String(url), headers: new Headers(init?.headers), form };
      return new Response(JSON.stringify({ text: 'Leave me alone.' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const text = await transcribe('test-key', wavLike(4000), 'clip.webm', fetchImpl);
    expect(text).toBe('Leave me alone.');
    expect(seen).not.toBeNull();
    expect(seen!.url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect(seen!.headers.get('xi-api-key')).toBe('test-key');
    expect(seen!.headers.get('content-type')).toBeNull();
    expect(seen!.form.get('model_id')).toBe(STT_MODEL);
    expect(STT_MODEL).toBe('scribe_v3');
    expect(seen!.form.get('language_code')).toBe('en');
    expect(seen!.form.get('tag_audio_events')).toBe('false');
    expect(seen!.form.get('timestamps_granularity')).toBeNull();
    const file = seen!.form.get('file') as File;
    expect(file).toBeInstanceOf(Blob);
    expect(file.type).toBe('audio/webm');
    expect(file.type.includes(';')).toBe(false);
    expect(file.name).toBe('clip.webm');
    expect(file.size).toBe(4000);
  });

  it('strips codec parameters before the bytes are wrapped', async () => {
    const prepared = await prepareClip(wavLike(12, 'audio/mp4;codecs=mp4a.40.2'), 'take.mp4');
    expect(prepared.type).toBe('audio/mp4');
    expect(prepared.filename).toBe('clip.mp4');
    expect(baseAudioType('audio/ogg;codecs=opus').type).toBe('audio/ogg');
  });

  it('does not call Scribe for empty audio', async () => {
    const fetchImpl = vi.fn();
    expect(await transcribe('k', wavLike(0), 'clip.webm', fetchImpl)).toBe('');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a clip over the public-demo cap', async () => {
    await expect(transcribe('k', wavLike(MAX_CLIP_BYTES + 8), 'clip.webm', vi.fn())).rejects.toBeInstanceOf(ClipTooLargeError);
  });

  it('surfaces a network failure and an HTTP error', async () => {
    await expect(transcribe('k', wavLike(100), 'clip.webm', vi.fn(async () => { throw new Error('offline'); }))).rejects.toThrow(/network/i);
    const http = vi.fn(async () => new Response('no', { status: 401 }));
    await expect(transcribe('k', wavLike(100), 'clip.webm', http)).rejects.toThrow(/401/);
  });

  it('treats a silence tag as nothing said', () => {
    expect(cleanTranscript('(silence)')).toBe('');
    expect(cleanTranscript('  [noise]  ')).toBe('');
    expect(cleanTranscript('Leave me alone.')).toBe('Leave me alone.');
  });
});
