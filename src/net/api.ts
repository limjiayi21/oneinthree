import { baseAudioType } from '../../shared/audio';
import {
  API,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type HealthResponse,
  type SummaryData,
  type TurnEvent,
  type TurnRequest,
} from '../../shared/types';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export async function getHealth(): Promise<HealthResponse> {
  try {
    return await json<HealthResponse>(await fetch(API.health));
  } catch {
    return { ok: false, voice: false, ai: false };
  }
}

export async function createSession(req: CreateSessionRequest): Promise<CreateSessionResponse> {
  return json<CreateSessionResponse>(
    await fetch(API.session, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    }),
  );
}

export async function getAgentSession(sessionId: string): Promise<{ signedUrl: string; dynamicVariables: Record<string, string> }> {
  const res = await fetch(API.agent(sessionId));
  const body = (await res.json()) as { error?: string; signedUrl?: string; dynamicVariables?: Record<string, string> };
  if (!res.ok) throw new Error(body.error || `Live voice failed (${res.status})`);
  if (!body.signedUrl?.startsWith('wss://')) throw new Error('Live voice returned no signed websocket URL.');
  return { signedUrl: body.signedUrl, dynamicVariables: body.dynamicVariables ?? {} };
}

export function postAgentLine(sessionId: string, text: string): void {
  void fetch(API.agentLine(sessionId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ speaker: 'man', text }),
  }).catch(() => {});
}

export async function getSummary(sessionId: string): Promise<SummaryData> {
  return json<SummaryData>(await fetch(API.summary(sessionId)));
}

/**
 * Send one turn and yield the server's events as they arrive. If `audio` is
 * given the request goes as multipart (meta + clip); otherwise as JSON.
 * Never throws: transport failures surface as a final `error` event.
 */
export async function* sendTurn(
  sessionId: string,
  req: TurnRequest,
  audio?: Blob | null,
  signal?: AbortSignal,
): AsyncGenerator<TurnEvent> {
  let res: Response;
  try {
    if (audio) {
      const form = new FormData();
      form.append('meta', JSON.stringify(req));
      // Strip codec parameters (`audio/webm;codecs=opus`) before the multipart
      // part is built. An unquoted semicolon in Content-Type makes some
      // parsers drop the file, so the turn arrives with no words.
      const named = baseAudioType(audio.type || '');
      const clean = audio.type === named.type ? audio : new Blob([await audio.arrayBuffer()], { type: named.type });
      form.append('audio', clean, named.filename);
      res = await fetch(API.turn(sessionId), { method: 'POST', body: form, signal });
    } else {
      res = await fetch(API.turn(sessionId), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
        signal,
      });
    }
  } catch (err) {
    if ((err as Error).name !== 'AbortError') {
      yield { type: 'error', message: `Network error: ${(err as Error).message}`, recoverable: true };
    }
    return;
  }

  if (!res.ok || !res.body) {
    yield { type: 'error', message: `Server error ${res.status}`, recoverable: res.status >= 500 };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          yield JSON.parse(line) as TurnEvent;
        } catch {
          /* ignore a malformed line rather than kill the turn */
        }
      }
    }
    const tail = buffer.trim();
    if (tail) {
      try {
        yield JSON.parse(tail) as TurnEvent;
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    if ((err as Error).name !== 'AbortError') {
      yield { type: 'error', message: `Stream interrupted: ${(err as Error).message}`, recoverable: true };
    }
  }
}

