/**
 * One in Three: Worker entry.
 *
 *   GET  /api/health                     -> HealthResponse
 *   POST /api/session                    -> CreateSessionResponse
 *   POST /api/session/:id/turn           -> application/x-ndjson stream of TurnEvent
 *   GET  /api/session/:id/audio/:lineId  -> audio/mpeg (live text to speech, streamed straight through)
 *   GET  /api/session/:id/summary        -> SummaryData
 *
 * Everything under /api/session/:id is handled by that session's Durable
 * Object (worker/session.ts). Static assets and the SPA are served by the
 * assets binding; only /api/* reaches this Worker first.
 */
import type { CreateSessionRequest, HealthResponse } from '../shared/types';
import { SessionDO, type Env } from './session';

export { SessionDO };
export type { Env };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

const SESSION_ID = /^[a-z0-9-]{8,64}$/i;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/health') {
      const body: HealthResponse = {
        ok: true,
        voice: Boolean(env.ELEVENLABS_API_KEY),
        ai: Boolean(env.AI),
        agent: Boolean(env.ELEVENLABS_API_KEY && env.ELEVENLABS_AGENT_ID),
      };
      return json(body);
    }

    if (path === '/api/session') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      const body = (await request.json().catch(() => null)) as Partial<CreateSessionRequest> | null;
      if (!body || (body.pov !== 'woman' && body.pov !== 'bystander')) return json({ error: 'pov must be "woman" or "bystander"' }, 400);
      const id = crypto.randomUUID();
      const stub = env.SESSION.get(env.SESSION.idFromName(id));
      return stub.fetch(
        new Request(`https://session/api/session/${id}/init`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pov: body.pov, scenario: 'walk-home', seed: body.seed }),
        }),
      );
    }

    const match = path.match(/^\/api\/session\/([^/]+)\/(turn|summary|audio|agent|agent-line)(?:\/[^/]+)?$/);
    if (match) {
      const id = match[1];
      if (!SESSION_ID.test(id)) return json({ error: 'Unknown session' }, 404);
      // The session object answers directly: turn streams and audio streams pass through untouched.
      return env.SESSION.get(env.SESSION.idFromName(id)).fetch(request);
    }

    if (path.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
