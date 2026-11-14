# One in Three

A first-person simulation of street harassment, built to replace slide-deck respect, consent and bystander-intervention training.

You walk home at night in New York as a woman while a persistent man approaches. Then you walk the same street again as a bystander who sees it happen. Each part ends with a debrief built from cited research.

It is not a game. Nothing graphic is shown: the scene cuts to black at the first moment of physical escalation.

## Restored pre-agent pipeline

The application code is restored to `ca04d292`, the last checkpoint before ElevenLabs Agents was introduced. The decision model chooses behavior, the line writer supplies the words, and ElevenLabs is used for speech-to-text and text-to-speech. No ElevenLabs agent ID or agent creation is required. Existing `ELEVENLABS_AGENT_ID` settings are ignored; keep API keys in the gitignored `.dev.vars` file.

Controls are the original **Space** to record a turn, **T** to type, and **H** for optional hands-free recording. This is the older turn-based pipeline, not a continuous agent call. Without service credentials the existing text/line-bank fallback remains available.

The later experiment is preserved on `backup/conversation-before-agent-rollback`. The two recently updated files, `docs/realism-transcripts.md` and `docs/research/model-simulation.md`, are retained as development notes; they may describe experiments after this application checkpoint. `main` and the separate handoff PR are not changed by this restoration.

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

## How a turn works

1. The browser records a push-to-talk clip and posts it to the Worker.
2. ElevenLabs speech-to-text turns it into words.
3. Cloudflare's Clef decision model reads how she responded and returns probabilities.
4. A seeded state machine samples the man's next stance from those probabilities and the evidence-based parameters.
5. A Workers AI text model writes one short line in that stance, plus her inner thought.
6. ElevenLabs text-to-speech streams his voice back.

The language model never decides what he does; it only writes words for a stance that has already been chosen. See [docs/DECISION_MODEL.md](docs/DECISION_MODEL.md).

## What the evidence does and does not support

Every statistic, case study and phone number shown comes from [content/evidence.json](content/evidence.json), with sources. The readable version is [docs/research/evidence.md](docs/research/evidence.md).

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
