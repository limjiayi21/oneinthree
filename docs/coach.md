# The debrief coach

A LangChain **deep agent** (the [`deepagents`](https://github.com/langchain-ai/deepagents) library) that writes each player a personal debrief once they finish Part 2. The player can then ask it follow-up questions about their run.

The rest of the game's debrief is built from fixed rules, so every player sees the same kind of feedback. The coach looks at what this player actually did at each moment and explains what it achieved and what it risked. It suggests what to try next time, with the exact words to say, and backs every claim with the research in `content/evidence.json`.

## What the player sees

The coach is one button on the Part 2 debrief, the page with the outcome and the timeline (under "See full details"). It replaces nothing:
- **Learn how to help** and **Walk it again** work exactly as before.
- A third button, **Talk it through with a coach**, opens the coach.

The button only appears when the server has a model key (`/api/health` reports `coach: true`) and Part 2 was recorded. `?coach=0` hides it.

In the coach:
1. **While it works** (about 25–35 s), a panel shows its plan ticking off and what it and its helpers are doing. The panel never runs past the bottom of the screen; only its activity list scrolls.
2. **The debrief** has three sections: *What you did*, *What to try next time* and *What the research says*. Each claim has a numbered citation that links to the source.
3. **Follow-up questions:** the player can pick a suggested question or type their own, up to six per run. Each answer takes about 10–15 s.

**Back to your debrief** (or **Back** at the top) returns to the Part 2 debrief. Opening the coach again shows the same work without starting over, and work in progress carries on in the meantime. If the coach is switched off or fails, the screen says so and the button still goes back.

## How it works

```
POST /api/coach  ──►  coach (deep agent, Gemini or OpenAI)
                       │  write_todos: a plan the player can read, kept up to date
                       │  get_my_run: the outcome and every moment, numbered
                       ├─► moment-analyst  (one per key moment, run in parallel)
                       │     get_moment, five_ds_guide, search_evidence
                       ├─► evidence-researcher
                       │     search_evidence (several queries)
                       │  write_file /notes.md, /debrief.md
                       │  check_draft: the grounding check; it fixes and re-checks until it passes
                       ▼
                    NDJSON stream: plan, step, result, done
```

- **The run:** the coach reads the summaries the game already builds for each session (`worker/summary.ts`): the timeline of who said what, how each move was read, why he reacted that way, the 5 Ds and the outcome. It doesn't record anything new and doesn't change how the game plays.
- **The research:** the coach can cite about 100 passages: statistics, findings about harassers and bystanders, and the 5 Ds. When MongoDB is configured, search runs on **MongoDB Atlas Vector Search** (see [mongodb.md](mongodb.md)). Without it, search uses in-memory embeddings. Either way the vector results are blended with keyword search (BM25), and keyword search alone is the last fallback.
- **The grounding check** (`worker/coach/check.ts`): every citation must exist, and every figure must appear in a passage cited in the same sentence. The coach runs it on its own draft. The server runs it again on the result and sends the coach back to fix anything that still fails, up to twice. If problems remain after that, the failing sentences are removed. The player sees a line such as "Checked: 5 claims traced to the research".
- **Follow-up questions:** the client sends the coach's working files (its notes and the debrief) back with each question. The server keeps no conversation state, and the coach can still build on its own notes.
- **Safety rules** in every prompt: the player's safety comes first; no physical intervention; Direct is described as the riskiest option; no blaming; and gentle signposting to support if the player seems upset.

## Which model

`worker/coach/models.ts` picks the model:

- **Gemini (the default when `GEMINI_API_KEY` is set).** It uses `gemini-3.6-flash` and falls back to `gemini-flash-lite-latest` when a call fails or takes over 30 s. Busy Gemini models answer 503 or hang without replying. Embeddings use `gemini-embedding-001`. Deep Agents' built-in tools use schema features Gemini rejects, so the schemas are rewritten into the subset Gemini accepts before they are sent.
- **OpenAI (when only `OPENAI_API_KEY` is set, or `COACH_PROVIDER=openai`).** It uses `gpt-5.4-mini` and `text-embedding-3-small`. Setting `OPENAI_BASE_URL` points it at any OpenAI-compatible service instead, for example a self-hosted or Vultr endpoint.
- `COACH_MODEL` overrides the chat model for either provider.

**Gemini's free tier is too small for the coach.** It allows 15 requests per minute per model, and one debrief makes 15–25 calls in about 20 s. The coach needs a Gemini key with billing turned on (paid tier); until then, use `COACH_PROVIDER=openai`.

## Files

| File | What it is |
|---|---|
| `worker/coach/agent.ts` | The deep agent, its two helpers, the tools and prompts, and the progress reporting |
| `worker/coach/index.ts` | `POST /api/coach`: validation, per-session limits, the streaming, and the final check-and-revise loop |
| `worker/coach/models.ts` | Picks Gemini or OpenAI, with the Gemini fallback, timeout and schema rewrite |
| `worker/coach/knowledge.ts` | The citable passages and the search |
| `worker/coach/atlas.ts` | The research in MongoDB Atlas and the `$vectorSearch` query |
| `worker/coach/check.ts` | The grounding check |
| `worker/coach/run.ts` | Turns a session summary into numbered moments |
| `worker/coach/coach.test.ts` | Tests for the check, the search, the run and the validation |
| `shared/coach.ts` | The request and stream event types |
| `src/ui/coach.ts`, `coach.css`, `src/net/coach.ts` | The screen and its client |

It hooks into the existing code in five places, all additions:
- the `/api/coach` route in `worker/index.ts`;
- an internal use counter in `worker/session.ts`;
- `coach()` in `src/ui/screens.ts` and `src/contracts.ts`, keeping one coach screen per session;
- the button on the Part 2 debrief in `src/ui/screens.ts` (`summary()` can now resolve `'coach'`);
- a `coach` flag in `/api/health`;
- a small loop in `src/main.ts` between the Part 2 debrief and the coach.

## Running it

```sh
# .dev.vars (never committed): one or both
GEMINI_API_KEY=...
OPENAI_API_KEY=sk-...

npm run dev:local        # or npm run dev
# Play through Part 2: on its debrief, choose "Talk it through with a coach"
```

To deploy, add the key as a secret on the Cloudflare account that hosts the game:

```sh
npx wrangler secret put GEMINI_API_KEY      # and/or OPENAI_API_KEY
# optional: COACH_PROVIDER (gemini | openai), COACH_MODEL, OPENAI_BASE_URL
```

Without either key, the button is not shown and `/api/coach` returns 503.

## Limits and cost

- **Per Part 2 session:** two debriefs and six questions, counted in the session's Durable Object.
- **Input limits:** questions up to 300 characters, and the returned working files up to 60 KB.
- **Speed and cost:** a debrief takes about 30 s and a question about 10–15 s, each a cent or two on `gpt-5.4-mini` and less on Gemini Flash. A run times out after 150 s.
- **Privacy:** the run summary, including what the player said, is sent to the model provider (Google or OpenAI) to write the debrief. Nothing new is stored.

## Tested

- Unit tests: `npx vitest run worker/coach`, 14 tests.
- End to end on the local dev server, with real Part 2 sessions played through the API:
  - the plan streamed live and three moment analysts ran in parallel;
  - the debrief passed the check first time and showed its numbered sources;
  - a follow-up answer arrived in 13 s;
  - an unknown session showed the error, and Continue moved on.
- `npm run build` and the full suite (180 tests) pass, and the deployed Worker bundle is about 1.1 MB compressed.
