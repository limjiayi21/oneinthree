import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAgentSession } from './api';

afterEach(() => vi.unstubAllGlobals());

describe('live connection errors', () => {
  it('surfaces the worker PATCH error instead of returning a silent fallback', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Could not start live voice (agent update 403)' }, { status: 502 })));
    await expect(getAgentSession('test-session')).rejects.toThrow('agent update 403');
  });

  it('refuses a missing or invalid signed websocket URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ signedUrl: 'https://example.test' })));
    await expect(getAgentSession('test-session')).rejects.toThrow('no signed websocket URL');
  });

  it('returns the signed URL without needing a browser API key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ signedUrl: 'wss://example.test/signed' })));
    expect(await getAgentSession('test-session')).toEqual({ signedUrl: 'wss://example.test/signed', dynamicVariables: {} });
  });
});
