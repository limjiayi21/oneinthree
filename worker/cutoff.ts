/**
 * Barge-in bookkeeping: when she talks over him, his line in the running
 * transcript is cut down to what he actually got out, so the reader and the
 * line writer react to an interrupted man rather than a finished sentence.
 */

export function cleanInterrupted(raw: unknown): { line: string; heard: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { line?: unknown; heard?: unknown };
  if (typeof r.line !== 'string' || !r.line.trim()) return undefined;
  const heard = typeof r.heard === 'string' ? r.heard : '';
  return { line: r.line.trim().slice(0, 300), heard: heard.trim().slice(0, 300) };
}

/**
 * She talked over him: rewrite his last line in the running transcript so the
 * line writer (and the reader) see only what he actually got out, and that he
 * was cut off. The full line stays in the log.
 */
export function markCutOff(transcript: string[], cut: { line: string; heard: string }): void {
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const target = norm(cut.line);
  for (let i = transcript.length - 1; i >= 0; i--) {
    const m = /^HIM: (.*)$/.exec(transcript[i]);
    if (!m || norm(m[1]) !== target) continue;
    const got = cut.heard ? `${cut.heard.replace(/[\s.,!?…-]+$/, '')}… ` : '';
    transcript[i] = `HIM (she cut him off mid-sentence): ${got}[cut off]`;
    return;
  }
}
