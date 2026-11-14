/**
 * Live voice over an ElevenLabs Agent. The browser only ever sees a signed
 * URL minted by the Worker. The SDK owns the microphone, playback, and
 * barge-in. The stance machine still runs on each tool call.
 */
import { contextualUpdate, type AgentVariables } from '../../shared/liveVoice';

export interface LiveVoiceHandlers {
  signedUrl: string;
  variables: Record<string, string | number | boolean>;
  /** Returns the JSON string the agent must speak from. */
  commit(heard: string, expression: string): Promise<string>;
  onLine(who: 'you' | 'man', text: string): void;
  onSpeaking(speaking: boolean): void;
  onError(message: string): void;
}

export interface LiveVoice {
  update(vars: AgentVariables, kind: 'opening' | 'state'): void;
  close(): Promise<void>;
}

export async function startLiveVoice(handlers: LiveVoiceHandlers): Promise<LiveVoice> {
  const { Conversation } = await import('@elevenlabs/client');
  const conv = await Conversation.startSession({
    signedUrl: handlers.signedUrl,
    dynamicVariables: handlers.variables,
    // Tags such as [angry] are for the voice, not the subtitle.
    stripAudioTags: true,
    clientTools: {
      commit_player_turn: async (params: { heard?: unknown; expression?: unknown }) => {
        const heard = typeof params?.heard === 'string' ? params.heard : '';
        const expression = typeof params?.expression === 'string' ? params.expression : '';
        return handlers.commit(heard, expression);
      },
    },
    onMessage: (payload) => {
      const text = payload.message?.trim();
      if (!text) return;
      handlers.onLine(payload.role === 'user' || payload.source === 'user' ? 'you' : 'man', text);
    },
    onModeChange: ({ mode }) => handlers.onSpeaking(mode === 'speaking'),
    onInterruption: () => handlers.onSpeaking(false),
    onError: (message) => handlers.onError(message),
  });
  return {
    update(vars, kind) {
      conv.sendContextualUpdate(contextualUpdate(vars, kind));
    },
    close: () => conv.endSession(),
  };
}
