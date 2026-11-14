import { afterEach, describe, expect, it, vi } from 'vitest';
import { startLiveVoice } from './agentSession';

const { startSession } = vi.hoisted(() => ({ startSession: vi.fn() }));
vi.mock('@elevenlabs/client', () => ({ Conversation: { startSession } }));
afterEach(() => vi.clearAllMocks());

describe('single live voice', () => {
  it('starts the dashboard agent without a client tool or browser prompt override, and permits interruptions', async () => {
    const conv = { sendContextualUpdate: vi.fn(), sendUserMessage: vi.fn(), getOutputVolume: () => 0.65, endSession: vi.fn(async () => {}) };
    startSession.mockResolvedValue(conv);
    const onLine = vi.fn();
    const onSpeaking = vi.fn();
    const onError = vi.fn();
    const onDisconnect = vi.fn();
    const live = await startLiveVoice({ signedUrl: 'wss://example.test/signed', variables: {}, onLine, onSpeaking, onError, onDisconnect });
    const options = startSession.mock.calls[0][0];
    expect(options.clientTools).toBeUndefined();
    expect(options.overrides).toBeUndefined();
    expect(options.signedUrl).toBe('wss://example.test/signed');
    expect(conv.sendContextualUpdate).not.toHaveBeenCalled(); // no update needed to trigger the greeting
    options.onMessage({ message: 'hello', source: 'user' });
    options.onMessage({ message: 'Hey, you got a second?', source: 'ai' });
    expect(onLine.mock.calls).toEqual([['you', 'hello'], ['man', 'Hey, you got a second?']]);
    options.onModeChange({ mode: 'speaking' });
    options.onInterruption();
    expect(onSpeaking.mock.calls).toEqual([[true], [false]]);
    expect(live.outputLevel()).toBe(0.65);
    live.sendText('Leave me alone');
    expect(conv.sendUserMessage).toHaveBeenCalledWith('Leave me alone');
    live.update({ stance: 'guilt', emotion: 'sheepish', expression: 'defeated', distance: '2', pov: 'woman', heat: '2' });
    expect(conv.sendContextualUpdate.mock.calls[0][0]).not.toMatch(/keep talking|speak|reply|say/i);
    await live.close();
    expect(conv.endSession).toHaveBeenCalledTimes(1);
  });
});
