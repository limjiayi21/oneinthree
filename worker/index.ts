/**
 * One in Three: Worker entry.
 *
 *   GET  /api/health                     -> HealthResponse
 *   POST /api/session                    -> CreateSessionResponse
 *   POST /api/session/:id/turn           -> application/x-ndjson stream of TurnEvent
 *   GET  /api/session/:id/audio/:lineId  -> audio/mpeg (live text to speech, streamed straight through)
 *   GET  /api/session/:id/summary        -> SummaryData
 *   POST /api/phone/pair                 -> PhonePairResponse
 *   GET  /api/phone/:code/ws?role=       -> WebSocket relay (worker/phoneRelay.ts)
 *   POST /api/session/:id/guided         -> records the guided replay's first choices (worker/stats.ts)
 *   GET  /api/stats                      -> aggregate playthrough counts; needs STATS_CODE
 *
 * Everything under /api/session/:id is handled by that session's Durable
 * Object (worker/session.ts). Static assets and the SPA are served by the
 * assets binding; only /api/* reaches this Worker first.
 */
import type { CreateSessionRequest, HealthResponse } from '../shared/types';
import { PHONE_CODE_ALPHABET, PHONE_CODE_LENGTH, isPhoneCode, phonePairPath, type PhonePairResponse } from '../shared/phone';
import { PhoneRelayDO } from './phoneRelay';
import { SessionDO, type Env } from './session';
import { codeMatches, readStats } from './stats';

export { PhoneRelayDO, SessionDO };
export type { Env };

/** Random pairing code; bytes at or above the largest multiple of the alphabet size are skipped to avoid modulo bias. */
function newPhoneCode(): string {
  const n = PHONE_CODE_ALPHABET.length;
  const limit = 256 - (256 % n);
  let code = '';
  while (code.length < PHONE_CODE_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < limit && code.length < PHONE_CODE_LENGTH) code += PHONE_CODE_ALPHABET[b % n];
    }
  }
  return code;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

const SESSION_ID = /^[a-z0-9-]{8,64}$/i;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/health') {
      const body: HealthResponse = { ok: true, voice: Boolean(env.ELEVENLABS_API_KEY), ai: Boolean(env.AI) };
      return json(body);
    }

    if (path === '/api/stats') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      // Off unless STATS_CODE is set. The code goes in the x-stats-code header (or ?code= for a quick look in a browser).
      const given = request.headers.get('x-stats-code') ?? url.searchParams.get('code');
      if (!env.STATS_CODE || !codeMatches(given, env.STATS_CODE)) return json({ error: 'Not found' }, 404);
      if (!env.DB) return json({ error: 'No stats database is bound' }, 503);
      try {
        return json(await readStats(env.DB));
      } catch (err) {
        console.error('[stats] read failed', err);
        return json({ error: 'Stats are unavailable' }, 500);
      }
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
          body: JSON.stringify({ pov: body.pov, scenario: 'walk-home', seed: body.seed, ...(body.run === 'golden' ? { run: 'golden' } : {}), ...(body.demo === true ? { demo: true } : {}) }),
        }),
      );
    }

    const match = path.match(/^\/api\/session\/([^/]+)\/(turn|summary|audio|guided)(?:\/[^/]+)?$/);
    if (match) {
      const id = match[1];
      if (!SESSION_ID.test(id)) return json({ error: 'Unknown session' }, 404);
      // The session object answers directly: turn streams and audio streams pass through untouched.
      return env.SESSION.get(env.SESSION.idFromName(id)).fetch(request);
    }

    if (path === phonePairPath) {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      for (let i = 0; i < 5; i++) {
        const code = newPhoneCode();
        const res = await env.PHONE.get(env.PHONE.idFromName(code)).fetch('https://phone/issue', { method: 'POST' });
        if (res.status === 200) return json({ code } satisfies PhonePairResponse);
      }
      return json({ error: 'Could not issue a code' }, 503);
    }

    const phone = path.match(/^\/api\/phone\/([^/]+)\/ws$/);
    if (phone) {
      const role = url.searchParams.get('role');
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      if (!isPhoneCode(phone[1]) || (role !== 'game' && role !== 'phone')) return json({ error: 'Bad code or role' }, 400);
      if (request.headers.get('upgrade') !== 'websocket') return json({ error: 'Expected a WebSocket' }, 426);
      return env.PHONE.get(env.PHONE.idFromName(phone[1])).fetch(new Request(`https://phone/ws?role=${role}`, request));
    }

    if (path.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
