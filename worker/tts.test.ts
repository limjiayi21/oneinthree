import { describe, expect, it, vi } from 'vitest';
import { voiceTone } from '../shared/voiceTone';
import { TTS_LIVE_MODEL, TTS_OUTPUT_FORMAT, VOICES, buildTts } from './voices';
import { LiveAudio, startTts } from './tts';

describe('TTS request', () => {
  it('streams eleven_v4_turbo mp3 and puts the mood in a tag, not in the model choice', () => {
    const req = buildTts('man', 'Leave you alone? I asked you a question.', 'angry', 'low', TTS_LIVE_MODEL, 'Hey. Over here.');
    expect(req.voiceId).toBe(VOICES.man.id);
    expect(req.url).toBe(`https://api.elevenlabs.io/v1/text-to-speech/${VOICES.man.id}/stream?output_format=${TTS_OUTPUT_FORMAT}`);
    expect(TTS_OUTPUT_FORMAT).toBe('mp3_44100_128');
    expect(req.body.model_id).toBe('eleven_v4_turbo');
    expect(req.body.text.startsWith('[')).toBe(true);
    expect(req.body.text).toContain('Leave you alone?');
    expect(req.body.previous_text).toBe('Hey. Over here.');
    expect(req.body.voice_settings.similarity_boost).toBeGreaterThan(0);
    expect(req.body.voice_settings.stability).toBeGreaterThan(0);
    expect(req.body.text).toContain(voiceTone('angry'));
    expect(voiceTone('angry')).toBe('irritated');
  });

  it('makes an irritated face less steady than a calm one, and a nervous face nervous', () => {
    const angry = buildTts('man', 'Yeah I heard you.', 'angry', 'normal');
    const calm = buildTts('man', 'Hey. Where you headed?', 'friendly', 'normal');
    const nervous = buildTts('man', 'Alright. I am going.', 'sheepish', 'normal');
    expect(angry.body.text).toContain('[irritated');
    expect(calm.body.text).toContain('[calm');
    expect(nervous.body.text).toContain('[nervous');
    expect(calm.body.voice_settings.stability).toBeGreaterThan(angry.body.voice_settings.stability);
    expect(nervous.body.voice_settings.stability).toBeGreaterThan(angry.body.voice_settings.stability);
  });

  it('omits previous_text on the first line', () => {
    const req = buildTts('woman', 'I just want to go home.', 'afraid', 'normal');
    expect(req.body.previous_text).toBeUndefined();
    expect(req.body.text).toContain('I just want to go home.');
  });

  it('plays from the first byte and survives an upstream failure', async () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });
    const live = new LiveAudio(Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'audio/mpeg' } })));
    expect(await live.ready()).toBe(true);
    const reader = live.stream().getReader();
    const got: number[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      got.push(...value);
    }
    expect(got).toEqual([1, 2, 3, 4, 5]);

    const failed = startTts('k', { role: 'man', text: 'Hey.', emotion: 'neutral', delivery: 'normal' }, vi.fn(async () => new Response('no', { status: 429 })));
    expect(await failed.ready()).toBe(false);
    expect(failed.failed).toMatch(/429/);

    const down = new LiveAudio(Promise.reject(new Error('offline')));
    expect(await down.ready()).toBe(false);
    expect(down.failed).toMatch(/offline/);
  });
});
