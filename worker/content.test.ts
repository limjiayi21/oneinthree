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
import evidenceJson from '../content/evidence.json';
import type { GuidedData } from '../shared/content';
import { CONTINUES, firstPickTactics, stripStatIds } from '../shared/content';
import type { Evidence } from '../shared/evidence';
import { cleanLine } from './write';

const guided = guidedJson as unknown as GuidedData;
const evidence = evidenceJson as unknown as Evidence;
const sentences = (text: string) => text.split(/(?<=[.!?;])\s+(?=[A-Z])/).filter(Boolean).length;

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

  const choices = guided.moments.flatMap((m) => m.choices);

  it('has the five moments of the brief, three choices each, with unique ids', () => {
    expect(guided.moments.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    for (const m of guided.moments) expect(m.choices, m.id).toHaveLength(3);
    const ids = choices.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of choices) expect(c.id.startsWith(`${guided.moments.find((m) => m.choices.includes(c))!.id}_`), c.id).toBe(true);
  });

  it('rates the choices as the brief does, so every moment can be passed', () => {
    const ratings = guided.moments.map((m) => m.choices.map((c) => c.rating));
    expect(ratings).toEqual([
      ['best', 'weaker', 'weaker'],
      ['best', 'weaker', 'weaker'],
      ['good', 'good', 'weaker'],
      ['best', 'weaker', 'backfires'],
      ['best', 'weaker', 'backfires'],
    ]);
    for (const m of guided.moments) expect(m.choices.some((c) => CONTINUES.has(c.rating)), m.id).toBe(true);
  });

  it('spotlights her at moment 2 and explains the reset before moment 4', () => {
    expect(guided.moments[1]!.spotlight).toBe('woman');
    expect(guided.moments[3]!.lead).toBe('Back to the same street. This time you were further behind, and he has already stepped into her path.');
  });

  it('tags the 5 Ds where the brief names them', () => {
    const tactics = Object.fromEntries(choices.filter((c) => c.tactic).map((c) => [c.id, c.tactic]));
    expect(tactics).toEqual({ m3_distract: 'distract', m3_delegate: 'delegate', m3_film: 'document', m4_direct: 'direct', m5_delay: 'delay' });
    const keys = evidence.bystander.fiveDs.map((d) => d.key);
    for (const t of Object.values(tactics)) expect(keys).toContain(t);
  });

  it('keeps every strip short: a concept, at most two sentences, at most one stat (two for moment 2)', () => {
    for (const c of choices) {
      expect(c.strip.concept.trim(), c.id).not.toBe('');
      const isM2Best = c.id === 'm2_my_business';
      expect(sentences(c.strip.sentence), c.id).toBeLessThanOrEqual(2);
      expect(stripStatIds(c.strip).length, c.id).toBeLessThanOrEqual(isM2Best ? 2 : 1);
      if (!isM2Best) expect(c.strip.statIds, c.id).toBeUndefined();
    }
  });

  it('cites only stats that exist in evidence.json, each with a linked source', () => {
    const cited = choices.flatMap((c) => stripStatIds(c.strip));
    expect(cited).toEqual(['loreal_dontknow_86', 'cctv_9in10', 'loreal_helped_25']);
    for (const id of cited) {
      const stat = evidence.stats.find((s) => s.id === id);
      expect(stat, id).toBeDefined();
      expect(evidence.sources[stat!.sourceId]?.url, id).toMatch(/^https?:\/\//);
    }
  });

  it('credits only concepts that are listed, and lists none that are unused', () => {
    const used = new Set(choices.map((c) => c.strip.conceptId).filter(Boolean));
    const listed = new Set(guided.concepts.map((c) => c.id));
    for (const id of used) expect(listed.has(id!), id).toBe(true);
    for (const id of listed) expect(used.has(id), id).toBe(true);
    for (const c of guided.concepts) {
      expect(c.attribution.trim(), c.id).not.toBe('');
      expect(typeof c.verified, c.id).toBe('boolean');
      expect(c.url === '' || /^https:\/\//.test(c.url), c.id).toBe(true);
    }
  });

  it('has a recap with all five Ds, the two steps, and the closing line', () => {
    expect(guided.recap.fiveDs.map((d) => d.key).sort()).toEqual(['delay', 'delegate', 'direct', 'distract', 'document']);
    expect(guided.recap.steps.map((s) => s.name)).toEqual(['Notice it', "Decide it's your business"]);
    expect(guided.recap.closing).toBe('In real life no tactic is guaranteed, but these give her the best chance with the least risk to you.');
  });

  it('ticks the Ds the player picked first, whether or not they were the best choice', () => {
    expect([...firstPickTactics(guided, { m1: 'm1_phone', m3: 'm3_film', m4: 'm4_argue', m5: 'm5_delay' })].sort()).toEqual(['delay', 'document']);
    expect([...firstPickTactics(guided, { m3: 'm3_delegate', m4: 'm4_direct' })].sort()).toEqual(['delegate', 'direct']);
    expect(firstPickTactics(guided, {}).size).toBe(0);
  });

  it('uses no scores, emoji or exclamation marks in its own copy', () => {
    const copy = [
      ...guided.moments.flatMap((m) => [m.prompt ?? '', m.caption ?? '', m.lead ?? '', ...(m.innerVoice ?? [])]),
      ...choices.flatMap((c) => [c.strip.concept, c.strip.sentence]),
      guided.recap.title,
      guided.recap.closing,
      ...guided.recap.fiveDs.map((d) => d.line),
      ...guided.recap.steps.map((s) => s.line),
    ].join(' ');
    expect(copy).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(copy).not.toMatch(/!|\bpoints?\b|\bscores?\b|\bwell done\b|\bgreat\b/i);
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
