# One in Three

A first-person simulation of street harassment, built to replace slide-deck respect, consent and bystander-intervention training.

You walk home at night in New York as a woman while a persistent man approaches. Then you walk the same street again as a bystander who sees it happen. On either briefing, Practice the 5Ds or Walk home instead switches role without a new street. Each part ends with a debrief: a replay of the key moments, each with a short tip from the cited research file, then the rest of the debrief.

It is not a game. Nothing graphic is shown: the scene cuts to black at the first moment of physical escalation.

## Run it

```bash
npm install
```

```bash
npm run set-key
```

```bash
npm run dev
```

`set-key` asks for your ElevenLabs API key with hidden input and saves it to `.dev.vars`, which is git-ignored. You can also copy the template and paste the key yourself:

```bash
cp .dev.vars.example .dev.vars
# then put your key on the ELEVENLABS_API_KEY line. Never commit .dev.vars.
```

Without a key the simulation still runs, with subtitles instead of voices. The dev server is at http://localhost:5173 and needs `wrangler login` for Workers AI. For a deployed build the same key is a Worker secret, not a client variable: `npx wrangler secret put ELEVENLABS_API_KEY`.

Controls: W A S D to walk, mouse to look, Shift to hurry, hold Space to speak, T to type instead, H to toggle hands-free, Esc to pause. In Part 2, F films and E asks the shopkeeper for help. A clip is capped at 8 seconds. The indicator under the scene says Listening…, Transcribing…, or Didn't catch that.

### Check voice and the microphone on a laptop

The VM this was built on has no microphone and no ElevenLabs key, so this part is for a real machine.

1. `npm install`
2. `npm run set-key` (or edit `.dev.vars` as above). Confirm `git status` does not list `.dev.vars`.
3. `npx wrangler login` once, so Workers AI can read what you said.
4. `npm run dev` and open http://localhost:5173
5. Allow the microphone on the intro screen. Hold Space and say "Leave me alone." The indicator should read Listening…, then Transcribing…, then his reply should mention being left alone. Subtitles stay up while his voice plays. Press Space again while he is still talking: his line cuts off and yours starts.
6. Press H and speak without holding Space. Press H again to go back to push-to-talk.
7. If the key is missing or speech-to-text fails, the subtitle still shows and the indicator says Didn't catch that. Press T to type the same line and confirm he answers it.

## Live voice (ElevenLabs Agent)

Press L during a scene for a phone-style call: the ElevenLabs Agent owns the microphone, turn-taking, and barge-in. The seeded stance model still decides what he does. His face uses the emotion the agent reports, clamped to what that stance is allowed to show. The older speech-to-text, line model, and text-to-speech path stays in place; press L again to return to it. `?agent=1` starts the call when the encounter does.

The agent uses Gemini 3.5 Flash (`gemini-3.5-flash`), the low-latency Gemini ElevenLabs moves live conversations onto from 15 November 2026, and Chris on Eleven v4 Turbo with expressive mode. `gemini-4-argon` is the larger Gemini if you want it instead.

```bash
# key already in .dev.vars
npm run agent:create
# prints ELEVENLABS_AGENT_ID=agent_...
# paste that line into .dev.vars, then restart npm run dev
```

In the dashboard the same agent is "One in Three — Dex": LLM Gemini 3.5 Flash, TTS Eleven v4 Turbo, expressive mode on, authentication required. The browser only receives a signed websocket URL from `GET /api/session/:id/agent`. The API key never leaves the Worker.

## Who picks his next move

The default judge is Cloudflare Workers AI, the binding the project already has, so it needs no extra key. It starts in parallel with the line writer and has about 400 ms. If that call fails, returns an enum that is not allowed, or is slow, the seeded stance machine in `worker/model/` is what the trainee sees. Set `DECISION_PROVIDER=seeded` to skip the judge. TypeSafe, OpenAI, and Gemini are optional and each needs its own key.

| `DECISION_PROVIDER` | Key | Request |
|---|---|---|
| unset | none | Workers AI, `@cf/google/gemma-4-26b-a4b-it`, JSON schema. No extra key. The binding is the one the project already uses. |
| `seeded` | none | no network call |
| `typesafe` | `TYPESAFE_API_KEY` | `POST https://api.typesafe.ai/v1/systemone` with model `jev-1.14.0`. Yes/no questions use `noul`. Choice and score use the System One shapes in the [TypeSafe docs](https://docs.typesafe.ai/api/system-one). |
| `openai` | `OPENAI_API_KEY` | `POST https://api.openai.com/v1/decisions` with model `gpt-6-luna` and predicate, choice, and score questions. [Decisions guide](https://developers.openai.com/api/docs/guides/decisions). |
| `gemini` | `GEMINI_API_KEY` | `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent` with header `x-goog-api-key` and a JSON schema. A Google AI Studio key, including free MLH Gemini credits. |

Each call asks whether she set a firm boundary, her tone, whether a bystander stepped in, his next stance, his expression, and how heated the beat is. Code then applies the training rules: a firm boundary together with a bystander makes him back off, and the provider cannot choose a physical escalation the seeded model did not already reach. The expression is clamped to the faces that stance is allowed to wear, then handed to the line writer and, in live voice, to the agent. The keys stay in `.dev.vars` or as Worker secrets.

## How a turn works

1. The browser records a push-to-talk clip and posts it to the Worker.
2. ElevenLabs speech-to-text turns it into words.
3. Cloudflare's Clef decision model reads how she responded and returns probabilities.
4. A seeded state machine samples the man's next stance from those probabilities and the evidence-based parameters.
5. A Workers AI text model writes one short line in that stance, plus her inner thought.
6. ElevenLabs text-to-speech streams his voice back.

The language model never decides what he does; it only writes words for a stance that has already been chosen. See [docs/DECISION_MODEL.md](docs/DECISION_MODEL.md).

## What the evidence does and does not support

Every statistic, case study and phone number shown comes from [content/evidence.json](content/evidence.json), with sources. The readable version is [docs/research/evidence.md](docs/research/evidence.md). The short file the line writer, the live agent, and the debrief read is [data/harassment_research.md](data/harassment_research.md) (and `data/harassment_research.json`). It only includes figures that have a URL, and it does not invent a rate for how he reacts.

No study measures how a street harasser reacts to a specific response. Every "she did X, he does Y" probability is therefore a labelled assumption. The debrief tags each of his reactions as from data, inferred, or assumption.

## Layout

| Path | What it holds |
|---|---|
| `src/scenarios/` | The two scene directors and their shared machinery |
| `src/engine/`, `src/world/` | Renderer and the procedural street |
| `src/characters/`, `src/player/` | Procedural people, facial emotion, movement and body reactions |
| `src/audio/`, `src/ui/` | Sound engine, microphone, HUD and screens |
| `worker/` | API, session Durable Object, Clef read, decision model, line writer, voice |
| `shared/types.ts` | The contract between browser and Worker |
| `content/` | Evidence, scripted lines, fallback line bank, sound-effect prompts |
| `scripts/` | Key prompt, voice and sound generation, end-to-end test |

## Commands

| Command | What it does |
|---|---|
| `npm test` | Decision-model tests, including a Monte Carlo run |
| `node scripts/e2e.mjs` | Walks the whole API against a running dev server, using live services |
| `npm run gen:voice` / `npm run gen:sfx` | Regenerate pre-rendered audio (spends ElevenLabs credits) |
| `npm run build` | Typecheck and production build |
| `npm run deploy` | Build and deploy to Cloudflare; set the key first with `npx wrangler secret put ELEVENLABS_API_KEY` |

Dev shortcuts: `?nolock=1` runs without pointer lock, `?skip=intro,part1` jumps ahead, `?seed=7` fixes the random seed.

## Known limits

- Desktop only. Pointer lock and the microphone have not been tested on a real machine.
- The first-person body and some facial expressions (smirk, determined) are rough.
- Anyone with a deployed link can spend the ElevenLabs credits behind it; there are no logins yet.
