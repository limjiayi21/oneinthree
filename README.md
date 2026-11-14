# One in Three

A first-person simulation of street harassment, built to replace slide-deck respect, consent and bystander-intervention training.

You walk home at night in New York as a woman while a persistent man approaches. Then you walk the same street again as a bystander who sees it happen. Each part ends with a debrief built from cited research.

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

`set-key` asks for your ElevenLabs API key with hidden input and saves it to `.dev.vars`, which is git-ignored. Without a key the simulation still runs, with subtitles instead of voices. The dev server is at http://localhost:5173 and needs `wrangler login` for Workers AI.

Controls: W A S D to walk, mouse to look, Shift to hurry, hold Space to speak, T to type instead, Esc to pause. In Part 2, F films and E asks the shopkeeper for help.

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
