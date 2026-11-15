# MongoDB Atlas

The game keeps each live session in its own Durable Object (`worker/session.ts`), and that doesn't change. MongoDB Atlas is added beside it for three things that are useful after a part ends:

1. **The coach's research search, on Atlas Vector Search.** Every passage the coach can cite is stored with its embedding, and `search_evidence` queries it with `$vectorSearch`.
2. **Finished runs.** One anonymous record per session: the outcome, its length, the game's label for each action, and which of the 5 Ds were used.
3. **Coach runs.** For each debrief or answer: the passages it cited, how the grounding check went, how each search was answered, and how long it took.

`GET /api/stats` adds an `insights` block built from MongoDB aggregations: outcomes by part, how often each of the 5 Ds is used, outcomes for the runs that used each D, the most common actions, and the research the coach cites most.

All of it is off unless `MONGODB_URI` is set. When it's off, or MongoDB is down, the game plays exactly as before.

## What is stored, and what isn't

The same rule as the D1 stats (`worker/stats.ts`): **what the player did, never what they said.** No transcripts, no typed or spoken words, no audio, and no debrief text. Records are keyed by the random session id, with no names and no accounts. `worker/runlog.test.ts` checks that a run record contains none of the player's words.

## How it works

```
GET /api/session/:id/summary ──► Durable Object answers (unchanged)
                             └─► after the response: upsert runs/{id}

POST /api/coach ──► one MongoDB connection for the whole run
                    ├─ first search: sync the research collection if evidence.json changed
                    ├─ search_evidence ─► $vectorSearch ─► blended with BM25
                    └─ at the end: insert into coach_runs
```

- **Driver:** the official `mongodb` Node driver, running inside the Worker with `nodejs_compat`. TCP, TLS and the `mongodb+srv://` lookups have all been checked in workerd. Workers can't reuse a socket across requests, so each request opens its own client and closes it (`worker/mongo.ts`).
- **One fix to the build:** the driver's URL parser does `require('punycode/')`, which the Worker bundle can't resolve. `vite.config.ts` points it at the `punycode` package.
- **The research collection** (`worker/coach/atlas.ts`) is named after the embedding model, for example `research_text_embedding_3_small`, because vectors from different models can't be compared. The Worker fills it itself. When the SHA-256 of the passages differs from the hash stored in `coach_meta` (on the first run, or after `evidence.json` changes), it embeds every passage, upserts them, deletes any that were removed, and creates the `vector_index` search index if it's missing.
- **Safe by design:** Atlas only decides *which* passages are relevant. What the coach reads and cites still comes from the local research base, so the grounding check is unchanged. If Atlas fails or its index is still building, search falls back to in-memory vectors, then to keyword search, and the activity feed says so.

## Collections

| Collection | One document per | Fields |
|---|---|---|
| `research_<embedding model>` | research passage | `_id` (passage id), `kind`, `text`, `headline`, `sourceId`, `topic`, `region`, `embedding`, `model` |
| `coach_meta` | research collection | `_id` (collection name), `hash`, `count`, `dims`, `updatedAt` |
| `runs` | session | `_id` (session id), `pov`, `outcome`, `durationSec`, `actions`, `labels`, `fiveDs`, `statIds`, `at` |
| `coach_runs` | debrief or answer | `session`, `kind`, `ok`, `model`, `embedModel`, `searches`, `cited`, `checked`, `ms`, `at` |

Vector index `vector_index` on the research collection:

```json
{ "fields": [
  { "type": "vector", "path": "embedding", "numDimensions": 1536, "similarity": "cosine" },
  { "type": "filter", "path": "kind" }
] }
```

(The value is 3072 dimensions with Gemini embeddings. The Worker creates the index with the right size.)

## Setting it up

1. Create a free **M0** cluster on [MongoDB Atlas](https://cloud.mongodb.com). M0 supports Vector Search.
2. **Database Access:** add a database user with a long random password and *Read and write to any database*. Scoping it to the `oneinthree` database is better.
3. **Network Access:** Cloudflare Workers don't have fixed outgoing IP addresses, so allow `0.0.0.0/0`. The long password is what protects the cluster.
4. **Connect → Drivers:** copy the `mongodb+srv://…` string and put the password in it.
5. Set it on the Worker:
   ```sh
   npx wrangler secret put MONGODB_URI        # paste the connection string
   # optional: a database name other than "oneinthree"
   npx wrangler secret put MONGODB_DB
   ```
6. Check it: `GET /api/health?deep=1` should show `"mongo": true, "mongoPing": true`.
7. Play one Part 2 and open the coach. The first debrief fills the research collection and creates the index, which takes about a minute to build. Searches during that minute run in memory. After that, the activity feed shows *"Searching the research in MongoDB Atlas"*.

For local development, put `MONGODB_URI` in `.dev.vars`. To test without an Atlas account, use MongoDB's local Atlas image, which also supports Vector Search:

```sh
docker run -d --name oit-mongo -p 27017:27017 mongodb/mongodb-atlas-local:latest
echo 'MONGODB_URI=mongodb://localhost:27017/?directConnection=true' >> .dev.vars
npm run dev:local
```

## Tested

- Locally against `mongodb-atlas-local`, in the dev server and in the production build (`vite preview`): ping, research sync (101 passages, 1,536 dimensions), `$vectorSearch` answering the coach's searches, run and coach-run records, and the `/api/stats` insights.
- With MongoDB stopped: the session summary still answers straight away (14 ms), and `/api/health?deep=1` reports `"mongoPing": false` after the 5-second timeout.
- `worker/coach/coach.test.ts`: Atlas first, blending, fallback, collection naming and the content hash. `worker/runlog.test.ts`: the run record holds no words.
- Against a real Atlas M0 cluster (AWS) over `mongodb+srv` with TLS: connecting takes about 0.15 to 0.3 s per request. The first debrief stored the research and created the index; after about a minute, every coach search ran on Atlas Vector Search, and runs, coach runs and `/api/stats` worked the same as locally.
