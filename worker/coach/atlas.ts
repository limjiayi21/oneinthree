/**
 * The coach's research in MongoDB Atlas, searched with Atlas Vector Search.
 *
 * One collection per embedding model (vectors from different models cannot be
 * compared), e.g. research_text_embedding_3_small. Each document is a passage
 * from content/evidence.json plus its embedding. The Worker fills it itself:
 * when the passages' content hash differs from the one stored in coach_meta
 * (first run, or evidence.json changed), it embeds every passage, upserts
 * them, removes ones that no longer exist and makes sure the vector index is
 * there.
 *
 * Atlas only decides which passages are relevant. What the coach reads and
 * cites still comes from the local research base (PASSAGE_BY_ID), so the
 * grounding check works exactly as before. Anything that fails returns null
 * and the coach falls back to the in-memory search.
 */
import type { Collection, Db } from 'mongodb';
import { PASSAGES, PASSAGE_BY_ID, type Embedder, type Passage, type VectorSearch } from './knowledge';

export const VECTOR_INDEX = 'vector_index';
const META = 'coach_meta';

interface PassageDoc {
  _id: string;
  kind: Passage['kind'];
  text: string;
  headline?: string;
  sourceId?: string;
  topic?: string;
  region?: string;
  embedding: number[];
  model: string;
}

interface MetaDoc {
  _id: string;
  hash: string;
  count: number;
  dims: number;
  updatedAt: Date;
}

export const collectionName = (embedModel: string): string => `research_${embedModel.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;

/** SHA-256 of every passage's id and text: changes whenever evidence.json changes. */
export async function passagesHash(passages: Passage[] = PASSAGES): Promise<string> {
  const data = new TextEncoder().encode(passages.map((p) => `${p.id}\u0000${p.text}`).join('\u0001'));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The vector index definition (Atlas Vector Search). `kind` is a filter so a search can be limited to e.g. stats. */
export const indexDefinition = (dims: number) => ({
  fields: [
    { type: 'vector', path: 'embedding', numDimensions: dims, similarity: 'cosine' },
    { type: 'filter', path: 'kind' },
  ],
});

async function ensureIndex(coll: Collection<PassageDoc>, dims: number): Promise<void> {
  const existing = await coll.listSearchIndexes(VECTOR_INDEX).toArray();
  if (existing.length) return;
  await coll.createSearchIndex({ name: VECTOR_INDEX, type: 'vectorSearch', definition: indexDefinition(dims) });
}

/** One sync per Worker instance per collection at a time. */
const syncing = new Map<string, Promise<boolean>>();

/** Makes the collection match the research base. Returns true when it is up to date. */
export async function syncResearch(db: Db, embed: Embedder, embedModel: string, onStep?: (text: string) => void): Promise<boolean> {
  const name = collectionName(embedModel);
  const running = syncing.get(name);
  if (running) return running;
  const job = (async () => {
    const hash = await passagesHash();
    const meta = db.collection<MetaDoc>(META);
    const coll = db.collection<PassageDoc>(name);
    const current = await meta.findOne({ _id: name });
    if (current?.hash === hash) {
      // Up to date; the index may still be missing if an earlier sync was cut short.
      await ensureIndex(coll, current.dims);
      return true;
    }
    onStep?.('Storing the research in MongoDB Atlas (first run or the research changed)');
    const vectors = await embed(PASSAGES.map((p) => p.text));
    const dims = vectors[0]?.length ?? 0;
    if (!dims || vectors.length !== PASSAGES.length) throw new Error('embeddings came back incomplete');
    await coll.bulkWrite(
      PASSAGES.map((p, i) => ({
        replaceOne: {
          filter: { _id: p.id },
          replacement: { kind: p.kind, text: p.text, headline: p.headline, sourceId: p.sourceId, topic: p.topic, region: p.region, embedding: vectors[i], model: embedModel },
          upsert: true,
        },
      })),
      { ordered: false },
    );
    await coll.deleteMany({ _id: { $nin: PASSAGES.map((p) => p.id) } });
    await ensureIndex(coll, dims);
    await meta.replaceOne({ _id: name }, { hash, count: PASSAGES.length, dims, updatedAt: new Date() }, { upsert: true });
    return true;
  })().finally(() => syncing.delete(name));
  syncing.set(name, job);
  return job;
}

/**
 * A VectorSearch backed by Atlas for one coach run. The first search syncs the collection if needed.
 * Returns null hits (so the caller falls back) if the sync, the embedding or the query fails, or the
 * index is still building.
 */
export function atlasSearch(db: Db, embed: Embedder, embedModel: string, onStep?: (text: string) => void): VectorSearch {
  let ready: Promise<boolean> | null = null;
  const coll = db.collection<PassageDoc>(collectionName(embedModel));
  return async (query, k) => {
    try {
      ready ??= syncResearch(db, embed, embedModel, onStep).catch((err) => {
        console.warn('[coach] Atlas sync failed', err instanceof Error ? err.message : err);
        ready = null;
        return false;
      });
      if (!(await ready)) return null;
      const [qv] = await embed([query]);
      const rows = await coll
        .aggregate<{ _id: string; score: number }>([
          { $vectorSearch: { index: VECTOR_INDEX, path: 'embedding', queryVector: qv, numCandidates: Math.max(50, k * 10), limit: k } },
          { $project: { _id: 1, score: { $meta: 'vectorSearchScore' } } },
        ])
        .toArray();
      const hits = rows.map((r) => PASSAGE_BY_ID.get(r._id)).filter((p): p is Passage => Boolean(p));
      // An index that is still building answers with nothing: fall back rather than return no research.
      return hits.length ? hits : null;
    } catch (err) {
      console.warn('[coach] Atlas search failed', err instanceof Error ? err.message : err);
      return null;
    }
  };
}
