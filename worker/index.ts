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
 *   GET  /api/stats                      -> aggregate playthrough counts (D1) and MongoDB insights; needs STATS_CODE
 *   POST /api/coach                      -> NDJSON stream: the debrief coach (worker/coach/); needs OPENAI_API_KEY
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
import { handleCoach, type CoachEnv } from './coach';
import { pickProvider } from './coach/models';
import { COACH_PATH } from '../shared/coach';
import { mongoOn, pingMongo, withDb, type MongoEnv } from './mongo';
import { readInsights, runDoc, saveRun } from './runlog';
import type { SummaryData } from '../shared/types';

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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/health') {
      const body: HealthResponse = { ok: true, voice: Boolean(env.ELEVENLABS_API_KEY), ai: Boolean(env.AI), coach: pickProvider(env as CoachEnv) !== null, mongo: mongoOn(env as MongoEnv) };
      // ?deep=1 also does a round trip to MongoDB (slower; for checking a deploy, not for the game).
      if (body.mongo && url.searchParams.get('deep') === '1') body.mongoPing = await pingMongo(env as MongoEnv);
      return json(body);
    }

    if (path === '/api/stats') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      // Off unless STATS_CODE is set. The code goes in the x-stats-code header (or ?code= for a quick look in a browser).
      const given = request.headers.get('x-stats-code') ?? url.searchParams.get('code');
      if (!env.STATS_CODE || !codeMatches(given, env.STATS_CODE)) return json({ error: 'Not found' }, 404);
      const mongo = mongoOn(env as MongoEnv);
      if (!env.DB && !mongo) return json({ error: 'No stats database is bound' }, 503);
      // D1 counts as before, plus MongoDB aggregations (worker/runlog.ts) when it is configured. Either can fail alone.
      const [d1, insights] = await Promise.all([
        env.DB
          ? readStats(env.DB).catch((err) => {
              console.error('[stats] read failed', err);
              return null;
            })
          : null,
        mongo ? withDb(env as MongoEnv, readInsights, 'stats') : null,
      ]);
      if (!d1 && !insights) return json({ error: 'Stats are unavailable' }, 500);
      return json({ ...(d1 ?? {}), ...(insights ? { insights } : {}) });
    }

    if (path === COACH_PATH) return handleCoach(request, env as CoachEnv, ctx);

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
          body: JSON.stringify({ pov: body.pov, scenario: 'walk-home', seed: body.seed, ...(body.run === 'golden' ? { run: 'golden' } : {}) }),
        }),
      );
    }

    const match = path.match(/^\/api\/session\/([^/]+)\/(turn|summary|audio|guided)(?:\/[^/]+)?$/);
    if (match) {
      const id = match[1];
      if (!SESSION_ID.test(id)) return json({ error: 'Unknown session' }, 404);
      // The session object answers directly: turn streams and audio streams pass through untouched.
      const res = await env.SESSION.get(env.SESSION.idFromName(id)).fetch(request);
      // A part's summary is read when it ends: keep its anonymous record in MongoDB, after the response.
      if (match[2] === 'summary' && request.method === 'GET' && res.ok && mongoOn(env as MongoEnv)) {
        const copy = res.clone();
        ctx.waitUntil(
          copy
            .json()
            .then((s) => withDb(env as MongoEnv, (db) => saveRun(db, runDoc(id, s as SummaryData)), 'runlog'))
            .catch(() => {}),
        );
      }
      return res;
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
