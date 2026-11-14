/**
 * Checks on the authored content for the guided replay: reused audio exists
 * and matches its text, and every line the man says passes the same content
 * limits the Worker applies to model-written lines.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import guidedJson from '../content/guided.json';
import linebankJson from '../content/linebank.json';
import scriptJson from '../content/script.json';
import type { GuidedData } from '../shared/content';
import { cleanLine } from './write';

const guided = guidedJson as unknown as GuidedData;

/** Every pre-rendered line's text by audio id: script lines, bank lines, and bank thoughts (<id>_t). */
function knownAudioText(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, line] of Object.entries((scriptJson as { lines: Record<string, { text: string }> }).lines)) out.set(id, line.text);
  const bank = linebankJson as unknown as Record<string, unknown>;
  for (const group of Object.values(bank)) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) continue;
    for (const entries of Object.values(group as Record<string, unknown>)) {
      if (!Array.isArray(entries)) continue;
      for (const e of entries as Array<{ id: string; text: string; thought?: string }>) {
        out.set(e.id, e.text);
        if (e.thought) out.set(`${e.id}_t`, e.thought);
      }
    }
  }
  return out;
}

describe('content/guided.json', () => {
  const audioText = knownAudioText();
  const allLines = guided.moments.flatMap((m) => m.choices.flatMap((c) => c.lines));

  it('has unique choice ids', () => {
    const ids = guided.moments.flatMap((m) => m.choices.map((c) => c.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only reuses audio that exists, with the text it was rendered from', () => {
    for (const line of allLines) {
      if (!line.audioId) continue;
      expect(audioText.get(line.audioId), line.audioId).toBe(line.text);
      const file = fileURLToPath(new URL(`../public/audio/vo/${line.audioId}.mp3`, import.meta.url));
      expect(existsSync(file), file).toBe(true);
    }
  });

  it("keeps the man's lines inside the Worker's content limits", () => {
    for (const line of allLines.filter((l) => l.speaker === 'man')) {
      expect(cleanLine(line.text, { maxWords: 14 }), line.text).not.toBeNull();
    }
  });
});
