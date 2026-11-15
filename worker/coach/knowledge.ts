/**
 * The coach's research base: every passage it may cite, taken from
 * content/evidence.json (stats, findings about harassers, bystander findings,
 * the 5 Ds). Nothing else is citable.
 *
 * Search, in order of preference:
 *   1. Atlas Vector Search, when MongoDB is configured (worker/coach/atlas.ts);
 *   2. in-memory vectors, when an embedder is available (built once per Worker instance);
 *   3. a keyword score (BM25), so the coach still works if both fail.
 * The vector ranking leads and keyword hits fill in.
 */
import type { Evidence } from '../../shared/evidence';
import type { CoachCitation } from '../../shared/coach';
import evidenceJson from '../../content/evidence.json';

export const EVIDENCE = evidenceJson as unknown as Evidence;

export type PassageKind = 'stat' | 'harasser' | 'bystander' | 'five_d';

export interface Passage {
  id: string;
  kind: PassageKind;
  /** The sentence as the research states it (stats: headline + text). */
  text: string;
  /** The big number, for stats. */
  headline?: string;
  /** Extra context the coach may read but should not quote as a figure. */
  detail?: string;
  sourceId?: string;
  topic?: string;
  region?: string;
}

export function buildPassages(ev: Evidence = EVIDENCE): Passage[] {
  const out: Passage[] = [];
  for (const s of ev.stats) {
    out.push({ id: s.id, kind: 'stat', headline: s.headline, text: `${s.headline} ${s.text}`.trim(), detail: s.detail, sourceId: s.sourceId, topic: s.topic, region: s.region });
  }
  for (const f of ev.harasserBehaviour) out.push({ id: f.id, kind: 'harasser', text: f.finding, sourceId: f.sourceId });
  for (const f of ev.bystander.findings) out.push({ id: f.id, kind: 'bystander', text: f.finding, sourceId: f.sourceId });
  for (const d of ev.bystander.fiveDs) {
    out.push({ id: `five_d_${d.key}`, kind: 'five_d', text: `${d.name}: ${d.description} Example: ${d.example}`, sourceId: 'rtb_5ds' in ev.sources ? 'rtb_5ds' : undefined });
  }
  return out;
}

export const PASSAGES = buildPassages();
export const PASSAGE_BY_ID = new Map(PASSAGES.map((p) => [p.id, p]));

/** What the client shows for a cited passage. */
export function citation(id: string, ev: Evidence = EVIDENCE): CoachCitation | null {
  const p = PASSAGE_BY_ID.get(id);
  if (!p) return null;
  const src = p.sourceId ? ev.sources[p.sourceId] : undefined;
  return {
    id,
    headline: p.headline,
    text: p.text,
    source: src ? { publisher: src.publisher, year: src.year, title: src.title, url: src.url || undefined } : undefined,
  };
}

/* ------------------------------------------------------------------ keyword search */

const STOP = new Set('the a an of and or to in on at for with by is are was were be been that this it as from who what when how did do does not no her his him she he you your they their them about into than then there more most only also have has had'.split(' '));

export const tokens = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9% ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => (w.length > 4 ? w.replace(/(ing|ers|ed|es|s)$/, '') : w));

/** BM25 over the passages. */
export function keywordSearch(query: string, k = 5, passages: Passage[] = PASSAGES): Passage[] {
  const docs = passages.map((p) => tokens(`${p.text} ${p.topic ?? ''} ${p.kind.replace('_', ' ')}`));
  const avg = docs.reduce((n, d) => n + d.length, 0) / Math.max(1, docs.length);
  const df = new Map<string, number>();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
  const q = [...new Set(tokens(query))];
  const N = docs.length;
  const scored = docs.map((d, i) => {
    let score = 0;
    for (const w of q) {
      const f = d.filter((x) => x === w).length;
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5));
      score += (idf * f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (d.length / avg)));
    }
    return { p: passages[i], score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((s) => s.p);
}

/* ------------------------------------------------------------------ semantic search */

export type Embedder = (texts: string[]) => Promise<number[][]>;

/** A vector search outside the Worker (Atlas): the k nearest passages, or null to fall back. */
export type VectorSearch = (query: string, k: number) => Promise<Passage[] | null>;

export type SearchMode = 'atlas' | 'semantic' | 'keyword';

/** Vector hits lead, keyword hits fill in, no duplicates. */
function blend(ranked: Passage[], keyword: Passage[], k: number): Passage[] {
  const seen = new Set<string>();
  const merged: Passage[] = [];
  for (const p of [...ranked.slice(0, Math.ceil(k * 0.7)), ...keyword, ...ranked]) {
    if (merged.length >= k) break;
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    merged.push(p);
  }
  return merged;
}

const cosine = (a: number[], b: number[]): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na * nb) || 1);
};

/** The passages' vectors, built once per Worker instance (about 100 short texts, one call). */
let index: Promise<number[][]> | null = null;

export function resetIndex(): void {
  index = null;
}

/**
 * Vector search blended with BM25: the vector ranking leads and the keyword
 * hits fill in, so an exact term ("police", "following") is never lost.
 * Tries Atlas first, then in-memory vectors, then BM25 alone.
 */
export async function searchPassages(query: string, k: number, embed?: Embedder, vector?: VectorSearch): Promise<{ hits: Passage[]; mode: SearchMode }> {
  const keyword = keywordSearch(query, k);
  if (vector) {
    const ranked = await vector(query, k).catch(() => null);
    if (ranked?.length) return { hits: blend(ranked, keyword, k), mode: 'atlas' };
  }
  if (!embed) return { hits: keyword, mode: 'keyword' };
  try {
    index ??= embed(PASSAGES.map((p) => p.text));
    const vectors = await index;
    const [qv] = await embed([query]);
    const ranked = PASSAGES.map((p, i) => ({ p, s: cosine(qv, vectors[i]) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, k)
      .map((r) => r.p);
    return { hits: blend(ranked, keyword, k), mode: 'semantic' };
  } catch (err) {
    console.warn('[coach] embeddings failed, using keyword search', err);
    index = null;
    return { hits: keyword, mode: 'keyword' };
  }
}
