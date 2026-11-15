# The debrief coach

A LangChain **deep agent** (the [`deepagents`](https://github.com/langchain-ai/deepagents) library) that writes each player a personal debrief once they finish Part 2. The player can then ask it follow-up questions about their run.

The rest of the game's debrief is built from fixed rules, so every player sees the same kind of feedback. The coach looks at what this player actually did at each moment and explains what it achieved and what it risked. It suggests what to try next time, with the exact words to say, and backs every claim with the research in `content/evidence.json`.

## What the player sees

The coach appears after the 5 Ds recap, but only when the URL has `?coach=1`.

1. **While the coach works** (about 30 s), a panel shows its plan ticking off and what it and its helpers are doing.
2. **The debrief** has three sections: *What you did*, *What to try next time* and *What the research says*. Each claim has a numbered citation that links to the source.
3. **Follow-up questions:** the player can pick a suggested question or type their own, up to six per run. Each answer takes about 10–15 s.

**Continue** or **Skip** always moves on. If the coach is switched off or fails, the screen says so and the game carries on.

## How it works

```
POST /api/coach  ──►  coach (deep agent, gpt-5.4-mini)
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
- **The research:** the coach can cite about 100 passages: statistics, findings about harassers and bystanders, and the 5 Ds. Search uses OpenAI embeddings blended with keyword search (BM25), and falls back to keyword search alone if embeddings fail.
- **The grounding check** (`worker/coach/check.ts`): every citation must exist, and every figure must appear in a passage cited in the same sentence. The coach runs it on its own draft. The server runs it again on the result and sends the coach back to fix anything that still fails, up to twice. If problems remain after that, the failing sentences are removed. The player sees a line such as "Checked: 5 claims traced to the research".
- **Follow-up questions:** the client sends the coach's working files (its notes and the debrief) back with each question. The server keeps no conversation state, and the coach can still build on its own notes.
- **Safety rules** in every prompt: the player's safety comes first; no physical intervention; Direct is described as the riskiest option; no blaming; and gentle signposting to support if the player seems upset.

## Files

| File | What it is |
|---|---|
| `worker/coach/agent.ts` | The deep agent, its two helpers, the tools and prompts, and the progress reporting |
| `worker/coach/index.ts` | `POST /api/coach`: validation, per-session limits, the streaming, and the final check-and-revise loop |
| `worker/coach/knowledge.ts` | The citable passages and the search |
| `worker/coach/check.ts` | The grounding check |
| `worker/coach/run.ts` | Turns a session summary into numbered moments |
| `worker/coach/coach.test.ts` | Tests for the check, the search, the run and the validation |
| `shared/coach.ts` | The request and stream event types |
| `src/ui/coach.ts`, `coach.css`, `src/net/coach.ts` | The screen and its client |

It hooks into the existing code in five places, all additions:
- the `/api/coach` route in `worker/index.ts`;
- an internal use counter in `worker/session.ts`;
- `coach()` in `src/ui/screens.ts` and `src/contracts.ts`;
- one step in `src/main.ts`, behind `?coach=1`.

## Running it

```sh
# .dev.vars (never committed)
OPENAI_API_KEY=sk-...

npm run dev:local        # or npm run dev
# Play through Part 2 with ?coach=1, e.g. http://localhost:5173/?coach=1
```

To deploy, add the key as a secret on the Cloudflare account that hosts the game:

```sh
npx wrangler secret put OPENAI_API_KEY
# optional: npx wrangler secret put COACH_MODEL   (default gpt-5.4-mini)
```

Without `OPENAI_API_KEY`, `/api/coach` returns 503 and the screen says the coach is unavailable.

## Limits and cost

- **Per Part 2 session:** two debriefs and six questions, counted in the session's Durable Object.
- **Input limits:** questions up to 300 characters, and the returned working files up to 60 KB.
- **Speed and cost:** a debrief takes about 30 s and a question about 10–15 s, each a cent or two on `gpt-5.4-mini`. A run times out after 150 s.
- **Privacy:** the run summary, including what the player said, is sent to OpenAI to write the debrief. Nothing new is stored.

## Tested

- Unit tests: `npx vitest run worker/coach`, 12 tests.
- End to end on the local dev server, with real Part 2 sessions played through the API:
  - the plan streamed live and three moment analysts ran in parallel;
  - the debrief passed the check first time and showed its numbered sources;
  - a follow-up answer arrived in 13 s;
  - an unknown session showed the error, and Continue moved on.
- `npm run build` and the full suite (180 tests) pass, and the deployed Worker bundle is about 1.1 MB compressed.
