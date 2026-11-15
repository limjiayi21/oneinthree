# One in Three

A first-person simulation of street harassment, built to replace slide-deck respect, consent and bystander-intervention training.

You walk home at night in New York as a woman while a persistent man approaches. Then you walk the same street again as a bystander who sees it happen. Each part ends with a debrief built from cited research.

It is not a game. Nothing graphic is shown: the scene cuts to black at the first moment of physical escalation.

## Stable handoff

This handoff starts from current `main`, including phone walking, webcam head/hand controls, teaching replay, and playthrough logging. It adds the earlier recorder fixes, visible microphone errors, subtitles that last through playback, and stance-driven NPC expressions.

The unfinished live-agent conversation is intentionally excluded. It remains on `cursor/replay-and-bystander-0eb7`; this handoff does not require `ELEVENLABS_AGENT_ID` and does not attempt to update an ElevenLabs agent. Voice services still need separate credentials and provider approval; they are not a requirement for checking the scene.

For a local scene check without remote Workers AI, run `npm ci` followed by `npm run dev:local`. Without a voice key, use **T** to type when a scene allows speech. The worker uses the existing keyword and line-bank fallbacks. **G** remains head look and **H** remains hand tracking.

Before merging, run `npm run typecheck`, `npm test`, and `npm run build`, then smoke-test the two walks, teaching replay, phone walking, and G/H controls. A real microphone and external speech services require a separate laptop check; this handoff does not claim live conversation is working.

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

Head look (optional): press G to look around by turning your head in front of the webcam, and Shift+G to recalibrate. Turning or tilting your head turns hers; holding a turn near the left or right edge turns her body. Your eyes are not tracked, so they stay free to read the screen. The mouse keeps working. Frames are processed in the browser by MediaPipe Face Landmarker and never uploaded. `?eyes=1` starts it automatically after the intro, `?eyegain=1.4` makes it more sensitive, and `?eyegainy=1.5` changes only up and down.

Headphones recommended: in Part 1, when he follows behind you, his footsteps fall into step with yours and keep going a beat after you stop.

AirPods head tracking (optional, macOS 14+): run `npm run airpods` to build and start a small helper app (🎧 in the menu bar). Browsers cannot read headphone motion, so the helper reads the AirPods' sensors with Apple's CMHeadphoneMotionManager and streams them to the game on `ws://127.0.0.1:8765`, this machine only. When the game sees AirPods as the audio device and the helper is running, head look uses them instead of the webcam; otherwise it falls back to the webcam. Allow Motion access the first time macOS asks. If turning your head moves the view the wrong way, add `?airpodsx=-1` (or `?airpodsy=-1` for up and down).

Hand tracking (optional): press H. In Part 2, look down and pinch your thumb and index finger to take out or put away your phone (same as F), and hold up an open hand near the shop to ask the shopkeeper for help (same as E). Head look and hand tracking share one webcam and can run together. `?hands=1` starts it after the intro.

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

Dev shortcuts: `?eyes=1` starts head look, `?hands=1` starts hand tracking, `?nolock=1` runs without pointer lock, `?skip=intro,part1` jumps ahead, `?seed=7` fixes the random seed.

## Known limits

- Desktop only. Pointer lock and the microphone have not been tested on a real machine.
- The first-person body and some facial expressions (smirk, determined) are rough.
- Anyone with a deployed link can spend the ElevenLabs credits behind it; there are no logins yet.
