import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Player } from '../contracts';
import type { LiveVoiceHandlers } from '../audio/agentSession';
import { SceneKit, type SceneDeps } from './common';

const mocks = vi.hoisted(() => ({ getAgentSession: vi.fn(), startLiveVoice: vi.fn(), sendTurn: vi.fn() }));
vi.mock('../net/api', () => ({ ...mocks, createSession: vi.fn() }));
vi.mock('../audio/agentSession', () => ({ startLiveVoice: mocks.startLiveVoice }));

beforeEach(() => {
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn(), clearTimeout, setTimeout });
  mocks.sendTurn.mockImplementation(async function* () {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

function fixture() {
  const mic = { init: vi.fn(async () => true), watch: vi.fn(), start: vi.fn() };
  const hud = { setMic: vi.fn(), setTalkMode: vi.fn(), hint: vi.fn(), setMood: vi.fn(), subtitle: vi.fn(), setPartial: vi.fn(), thought: vi.fn() };
  const audio = { speak: vi.fn(), stopAllSpeech: vi.fn() };
  const deps = { agent: true, requireLock: false, mic, hud, audio, engine: { onUpdate: () => () => {} } } as unknown as SceneDeps;
  const player = { on: () => () => {} } as unknown as Player;
  const kit = new SceneKit(deps, player, 'woman');
  kit.sessionId = 'test-session';
  kit.speechEnabled = true;
  return { kit, mic, hud, audio };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('live scene ownership', () => {
  it('shows PATCH/signed URL errors without starting either microphone path', async () => {
    mocks.getAgentSession.mockRejectedValue(new Error('Could not start live voice (agent update 403)'));
    const { kit, mic, hud } = fixture();
    kit.refreshMic();
    await flush();
    expect(mocks.startLiveVoice).not.toHaveBeenCalled();
    expect(mic.init).not.toHaveBeenCalled();
    expect(mic.start).not.toHaveBeenCalled();
    expect(mic.watch).not.toHaveBeenCalledWith(true);
    expect(hud.hint).toHaveBeenCalledWith('Could not start live voice (agent update 403)');
    expect(hud.setTalkMode).not.toHaveBeenCalledWith('live');
  });

  it('connects automatically, reacts before the worker answers, and never plays a second voice', async () => {
    mocks.getAgentSession.mockResolvedValue({ signedUrl: 'wss://example.test/signed', dynamicVariables: {} });
    let handlers!: LiveVoiceHandlers;
    const live = { update: vi.fn(), close: vi.fn(async () => {}), outputLevel: () => 0.5 };
    mocks.startLiveVoice.mockImplementation(async (h) => { handlers = h; return live; });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    mocks.sendTurn.mockImplementation(async function* () { await pending; });
    const { kit, mic, hud, audio } = fixture();
    const events = vi.fn();
    kit.onEvent = events;
    kit.refreshMic();
    await flush();
    expect(kit.agentLive).toBe(true);
    expect(hud.setTalkMode).toHaveBeenCalledWith('live');
    expect(live.update).not.toHaveBeenCalled();
    handlers.onLine('you', 'Hello');
    expect(kit.heat).toBe(0);
    handlers.onLine('you', 'Leave me alone');
    expect(kit.heat).toBe(2);
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: 'decision', man: expect.objectContaining({ action: 'step_closer' }) }));
    handlers.onLine('man', 'I was only being nice.');
    expect(kit.heat).toBe(2);
    handlers.onLine('you', 'No, stop.');
    expect(kit.heat).toBe(3);
    await kit.say(null, 'man', 'A second line', '/audio/vo/lb_opening_1.mp3');
    kit.thinkText('A thought', '/audio/vo/w_start_1.mp3');
    expect(audio.speak).not.toHaveBeenCalled();
    expect(mic.init).not.toHaveBeenCalled();
    expect(mic.watch).not.toHaveBeenCalledWith(true);
    release();
    await flush();
    expect(mocks.sendTurn.mock.calls.map(([, req]) => req.text)).toEqual(['Hello', 'Leave me alone', 'I was only being nice.', 'No, stop.']);
  });
});
