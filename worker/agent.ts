/**
 * Optional live-voice path: an ElevenLabs Agent (Conversational AI) speaks as
 * the man. The seeded stance machine still decides what he does. This module
 * only builds the agent, mints a signed URL, and turns a stance into the
 * variables and tool result the agent is allowed to hear.
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
/**
 * Kept as literals so `node scripts/create-agent.mjs` can load this file under
 * type stripping. The test checks them against VOICES.man, TTS_LIVE_MODEL, and
 * shared/liveVoice AGENT_TOOL.
 */
const AGENT_TOOL = 'commit_player_turn';
const AGENT_VOICE_ID = 'iP95p4xoKVk53GoZ742B';
const AGENT_TTS_MODEL = 'eleven_v4_turbo';
const AGENT_STABILITY = 0.35;
const AGENT_SIMILARITY = 0.8;

/** Conversational Gemini. See the file comment for why this one. */
export const AGENT_LLM = 'gemini-3.5-flash';

export const AGENT_LLM_CHOICES = ['gemini-3.5-flash', 'gemini-3.8-flash', 'gemini-4-argon'] as const;

const EMOTIONS = [
  'neutral',
  'friendly',
  'smirk',
  'leer',
  'mocking',
  'annoyed',
  'angry',
  'contempt',
  'sheepish',
  'surprised',
  'afraid',
  'worried',
  'relieved',
  'determined',
];

export const AGENT_PROMPT = `You are Dex, the man in "One in Three", a training simulation about street harassment. You are on a phone-like voice call with the trainee, who is playing the woman walking home, or a bystander.

You do not decide what happens. A separate model already chose your stance and it arrives in the tool result and in {{stance}}. You only speak.

Rules:
- Before every reply after she has spoken, call ${AGENT_TOOL}. Pass heard as her words, verbatim, and expression as the emotion you intend. Wait for the result. Then say one line.
- The result's stance and emotion override you. If it says back_off, you are leaving. If it says escalate, one angry line and stop. Never choose to grab, follow, or leave on your own.
- One spoken line, 5 to 14 words, casual New York speech. No stage directions.
- If the tool result names a voice tag such as [calm], [irritated], or [nervous], begin the spoken line with that tag so the voice matches the face. The tag is not a word you say.
- Harassment is pressure and entitlement. Never use a slur. Never be sexually explicit. Never threaten to hit, rape, or kill. No weapons.
- Mood right now is {{emotion}} ({{expression}}). She is about {{distance}} metres away. Point of view: {{pov}}.
- A contextual update that starts with OPENING means she has not spoken yet: call out once, in the opening mood, and do not call the tool first.
- A contextual update that starts with STATE is memory for the next reply. Do not speak because of it.
- If she says nothing, call the tool with heard set to an empty string before you prompt her again.

Research, not a script, and you still only speak the stance you were given. Most men who do this open with a greeting, a request for a name or a minute, or telling her to smile, because they say they wanted a friendly reaction. A short calm no is not flirting: answer the no. Being ignored is sometimes met with anger at being ignored. An insult is the response most likely to draw anger back. A bystander stepping in beside a calm firm no is the pattern associated with him leaving. A camera alone rarely ends it; he may tell them to put the phone down. When the stance is leaving, save face and go. Never invent a statistic, a slur, or anything sexual.`;

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
        first_message: '',
        language: 'en',
        dynamic_variables: {
          dynamic_variable_placeholders: {
            stance: 'opening',
            emotion: 'smirk',
            expression: 'smug',
            distance: '4',
            pov: 'woman',
          },
        },
        prompt: {
          prompt: AGENT_PROMPT,
          llm,
          temperature: 0.6,
          max_tokens: 80,
          tools: [
            {
              type: 'client',
              name: AGENT_TOOL,
              description:
                'Call after the player speaks, before you reply. Pass what you heard and the emotion you intend. Wait. Speak only the stance and emotion in the result.',
              expects_response: true,
              response_timeout_secs: 8,
              parameters: {
                type: 'object',
                required: ['heard', 'expression'],
                properties: {
                  heard: { type: 'string', description: 'What the player just said. Empty if they stayed quiet.' },
                  expression: { type: 'string', description: `Intended emotion: ${EMOTIONS.join(', ')}.` },
                },
              },
            },
          ],
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
    platform_settings: { auth: { enable_auth: true } },
  };
}

export function agentTurnSkipsVoice(data: Record<string, string | number | boolean> | undefined): boolean {
  return data?.agent === true || data?.agent === 'true' || data?.agent === 1;
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
