import { describe, expect, it, vi } from 'vitest';
import { agentVariables, commitToolResult, contextualUpdate } from '../shared/liveVoice';
import { TTS_LIVE_MODEL, VOICES } from './voices';
import { AGENT_LLM, AGENT_PROMPT, agentTurnSkipsVoice, buildAgentDraft, mintSignedUrl } from './agent';

describe('ElevenLabs agent draft', () => {
  const draft = buildAgentDraft();
  const config = draft.conversation_config as {
    agent: { prompt: { prompt: string; llm: string; tools: Array<Record<string, unknown>> } };
    tts: { voice_id: string; model_id: string; expressive_mode: boolean; stability: number; similarity_boost: number };
  };

  it('selects Gemini 3.5 Flash, the current low-latency Gemini, and an expressive v4 voice', () => {
    expect(AGENT_LLM).toBe('gemini-3.5-flash');
    expect(config.agent.prompt.llm).toBe('gemini-3.5-flash');
    expect(config.tts.model_id).toBe(TTS_LIVE_MODEL);
    expect(config.tts.model_id).toBe('eleven_v4_turbo');
    expect(config.tts.expressive_mode).toBe(true);
    expect(config.tts.voice_id).toBe(VOICES.man.id);
    expect(config.tts.stability).toBe(VOICES.man.settings.stability);
    expect(config.tts.similarity_boost).toBe(VOICES.man.settings.similarity_boost);
    expect(config.agent.prompt.tools).toEqual([]);
    expect(config.agent.prompt.prompt).toMatch(/live voice conversation/i);
    expect(AGENT_PROMPT).toMatch(/never use a slur/i);
    expect(AGENT_PROMPT).not.toMatch(/call commit_player_turn/i);
  });

  it('lets him talk without waiting on the stance machine', () => {
    expect(config.agent.prompt.tools).toEqual([]);
    expect(draft.platform_settings).toMatchObject({ auth: { enable_auth: true } });
    expect(JSON.stringify(draft)).not.toMatch(/xi-api-key|sk_/);
    expect(JSON.stringify(draft.conversation_config)).toContain('Hey, excuse me, miss');
  });
});

describe('live-voice contract', () => {
  it('skips the old TTS pipeline only when the turn asks for the agent', () => {
    expect(agentTurnSkipsVoice({ agent: true })).toBe(true);
    expect(agentTurnSkipsVoice({ agent: 'true' })).toBe(true);
    expect(agentTurnSkipsVoice({ agent: 1 })).toBe(true);
    expect(agentTurnSkipsVoice(undefined)).toBe(false);
    expect(agentTurnSkipsVoice({})).toBe(false);
  });

  it('puts stance, mood, and distance into dynamic variables', () => {
    expect(agentVariables({ pov: 'woman', stance: 'hostile', emotion: 'angry', distanceMetres: 1.4 })).toEqual({
      stance: 'hostile',
      emotion: 'angry',
      expression: 'angry',
      distance: '1',
      pov: 'woman',
    });
  });

  it('tells him where she is without ordering him to stay quiet', () => {
    const vars = agentVariables({ pov: 'woman', stance: 'opening', emotion: 'smirk', distanceMetres: 6 });
    expect(contextualUpdate(vars, 'opening')).toMatch(/6 metres/);
    expect(contextualUpdate(vars, 'state')).not.toMatch(/Do not speak/);
  });

  it('clamps an illegal expression and never hands the key to the agent', () => {
    const grabbed = commitToolResult('escalate', 'friendly', 'Get away from me');
    expect(grabbed.emotion).toBe('angry');
    expect(grabbed.expression).toBe('angry');
    expect(grabbed.result).not.toMatch(/xi-api-key|signed_url/);
    const allowed = commitToolResult('back_off', 'sheepish', 'I am calling the police');
    expect(allowed.emotion).toBe('sheepish');
    expect(allowed.expression).toBe('defeated');
    const parsed = JSON.parse(allowed.result) as { stance: string; say: string };
    expect(parsed.stance).toBe('back_off');
    expect(parsed.say).toMatch(/No slurs/);
    expect(parsed.say).toMatch(/\[nervous\]/);
  });
});

describe('signed URL', () => {
  it('asks ElevenLabs with the key on the server and returns only the websocket URL', async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=agent_test');
      expect(new Headers(init?.headers).get('xi-api-key')).toBe('secret-key');
      expect(init?.body).toBeUndefined();
      return new Response(JSON.stringify({ signed_url: 'wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_test&conversation_signature=abc' }), { status: 200 });
    });
    const signed = await mintSignedUrl('secret-key', 'agent_test', fetchImpl);
    expect(signed.startsWith('wss://')).toBe(true);
    expect(signed).not.toContain('secret-key');
  });

  it('fails closed when ElevenLabs refuses', async () => {
    const fetchImpl = vi.fn(async () => new Response('no', { status: 401 }));
    await expect(mintSignedUrl('secret-key', 'agent_test', fetchImpl)).rejects.toThrow(/401/);
  });
});
