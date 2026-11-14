/**
 * Live voice over an ElevenLabs Agent. Gemini talks as the man.
 * The browser only receives a signed URL. The SDK owns the microphone.
 */
import { contextualUpdate, type AgentVariables } from '../../shared/liveVoice';

export interface LiveVoiceHandlers {
  signedUrl: string;
  variables: Record<string, string | number | boolean>;
  onLine(who: 'you' | 'man', text: string): void;
  onSpeaking(speaking: boolean): void;
  onHearing?(hearing: boolean): void;
  onError(message: string): void;
  onDisconnect(): void;
}

export interface LiveVoice {
  update(vars: AgentVariables): void;
  sendText(text: string): void;
  outputLevel(): number;
  close(): Promise<void>;
}

export async function startLiveVoice(handlers: LiveVoiceHandlers): Promise<LiveVoice> {
  const { Conversation } = await import('@elevenlabs/client');
  const conv = await Conversation.startSession({
    signedUrl: handlers.signedUrl,
    dynamicVariables: handlers.variables,
    stripAudioTags: true,
    onMessage: (payload) => {
      const text = payload.message?.trim();
      if (!text) return;
      handlers.onLine(payload.role === 'user' || payload.source === 'user' ? 'you' : 'man', text);
    },
    onVadScore: ({ vadScore }) => handlers.onHearing?.(vadScore > 0.45),
    onModeChange: ({ mode }) => handlers.onSpeaking(mode === 'speaking'),
    onInterruption: () => handlers.onSpeaking(false),
    onError: (message) => handlers.onError(message),
    onDisconnect: () => { handlers.onSpeaking(false); handlers.onDisconnect(); },
  });
  return {
    update(vars) {
      conv.sendContextualUpdate(contextualUpdate(vars));
    },
    sendText: (text) => conv.sendUserMessage(text),
    outputLevel: () => conv.getOutputVolume(),
    close: () => conv.endSession(),
  };
}

