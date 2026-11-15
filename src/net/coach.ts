/** Client for the debrief coach (POST /api/coach, NDJSON). See shared/coach.ts. */
import { COACH_PATH, type CoachEvent, type CoachRequest } from '../../shared/coach';

export async function* streamCoach(req: CoachRequest, signal?: AbortSignal): AsyncGenerator<CoachEvent> {
  const res = await fetch(COACH_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req), signal });
  if (!res.ok || !res.body) {
    let message = res.status === 503 ? 'The coach is not switched on.' : res.status === 429 ? 'No more questions for this run.' : 'The coach is not available right now.';
    try {
      const body = (await res.json()) as { error?: string };
      if (res.status === 429 && body.error) message = `${body.error}.`;
    } catch {
      /* keep the plain message */
    }
    yield { type: 'error', message };
    return;
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += value;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line) as CoachEvent;
      } catch {
        /* skip a damaged line */
      }
    }
    if (done) break;
  }
}
