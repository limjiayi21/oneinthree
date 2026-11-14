/**
 * Optional live-voice path: an ElevenLabs Agent (Conversational AI) speaks as
 * the man. The scene follows the shared live escalation ladder. This module
 * updates the dashboard agent and mints a signed URL.
 *
 * LLM: gemini-3.5-flash. ElevenLabs lists it as the model that Gemini 2.5
 * Flash conversations move to from 15 November 2026, and it is the first model
 * in the default latency cascade. gemini-4-argon is the larger Gemini; it is
 * not the realtime default. Override with ELEVENLABS_AGENT_LLM.
 *
 * Voice: the same Chris voice the rest of the sim uses, on eleven_v4_turbo.
 * Expressive mode turns on automatically with that TTS model
 * (https://elevenlabs.io/docs/eleven-agents/customization/voice/expressive-mode).
 * Set expressive_mode true so a dashboard default cannot leave it off.
 *
 * The API key is sent only on the Worker → ElevenLabs hop. The browser
 * receives a wss signed URL and nothing else.
 */
import { AGENT_FIRST_MESSAGE, AGENT_PROMPT } from '../shared/liveVoice';

export { AGENT_FIRST_MESSAGE, AGENT_PROMPT };

/**
 * Kept as literals so `node scripts/create-agent.mjs` can load this file under
 * type stripping. The test checks them against VOICES.man and TTS_LIVE_MODEL.
 */
const AGENT_VOICE_ID = 'iP95p4xoKVk53GoZ742B';
const AGENT_TTS_MODEL = 'eleven_v4_turbo';
const AGENT_STABILITY = 0.35;
const AGENT_SIMILARITY = 0.8;

/** Conversational Gemini. See the file comment for why this one. */
export const AGENT_LLM = 'gemini-3.5-flash';

export const AGENT_LLM_CHOICES = ['gemini-3.5-flash', 'gemini-3.8-flash', 'gemini-4-argon'] as const;

export interface AgentDraft {
  name: string;
  conversation_config: Record<string, unknown>;
  platform_settings: Record<string, unknown>;
}

/** Body for POST /v1/convai/agents/create. Auth stays on so the browser must use a signed URL. */
export function buildAgentDraft(llm: string = AGENT_LLM): AgentDraft {
  return {
    name: 'One in Three — Dex',
    conversation_config: {
      agent: {
        first_message: AGENT_FIRST_MESSAGE,
        language: 'en',
        dynamic_variables: {
          dynamic_variable_placeholders: {
            stance: 'opening',
            emotion: 'friendly',
            expression: 'smug',
            distance: '4',
            pov: 'woman',
            heat: '0',
          },
        },
        prompt: {
          prompt: AGENT_PROMPT,
          llm,
          temperature: 0.8,
          max_tokens: 150,
          tools: [],
          tool_ids: [],
        },
      },
      tts: {
        voice_id: AGENT_VOICE_ID,
        model_id: AGENT_TTS_MODEL,
        expressive_mode: true,
        stability: AGENT_STABILITY,
        similarity_boost: AGENT_SIMILARITY,
      },
      turn: { turn_eagerness: 'normal', turn_timeout: 8 },
      conversation: { client_events: ['audio', 'interruption', 'user_transcript', 'agent_response'] },
    },
    platform_settings: {
      auth: { enable_auth: true },
      overrides: {
        conversation_config_override: {
          agent: { prompt: { prompt: true }, first_message: true },
        },
      },
    },
  };
}

export function agentTurnSkipsVoice(data: Record<string, string | number | boolean> | undefined): boolean {
  return data?.agent === true || data?.agent === 'true' || data?.agent === 1;
}

/** Push the live prompt onto the agent id already saved in ElevenLabs. The dashboard copy is what the call uses. */
export async function ensureLiveAgent(apiKey: string, agentId: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const draft = buildAgentDraft();
  const res = await fetchImpl(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`, {
    method: 'PATCH',
    headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      conversation_config: draft.conversation_config,
      platform_settings: draft.platform_settings,
    }),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`agent update ${res.status}`);
  }
  await res.body?.cancel().catch(() => {});
}

export async function mintSignedUrl(apiKey: string, agentId: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const url = new URL('https://api.elevenlabs.io/v1/convai/conversation/get-signed-url');
  url.searchParams.set('agent_id', agentId);
  const res = await fetchImpl(url, { method: 'GET', headers: { 'xi-api-key': apiKey } });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`signed url ${res.status}`);
  }
  const data = (await res.json()) as { signed_url?: string };
  if (!data.signed_url?.startsWith('wss://')) throw new Error('signed url missing');
  return data.signed_url;
}

