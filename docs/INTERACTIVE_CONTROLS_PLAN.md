# Interactive controls plan

The single source of truth for adding body-based controls to One in Three. Every agent reads this file before doing anything. If this file and an instruction disagree, stop and ask the orchestrator.

## Goal

Let the player control the simulation with their body as well as the keyboard: walk by stepping in place with a phone in their pocket, film by tapping record on their phone, and look around by turning their head in front of the webcam. Later, new actions (calling someone, pushing him) once the project owner agrees.

## Rules that apply to every agent

1. Add, never replace. Keyboard and mouse must keep working exactly as today in every phase. If the phone or webcam disconnects, the game carries on with the keyboard.
2. Stay inside your files. Each agent owns the files listed for it below. Editing any other file is not allowed; report the need to the orchestrator instead.
3. Never touch the decision model or the evidence: `worker/model/**`, `content/evidence.json`, `docs/DECISION_MODEL.md`, `docs/research/**`, `worker/read.ts`, `worker/write.ts`, `worker/summary.ts`. Changes there need the project owner's sign-off.
4. No new npm dependencies, except `@mediapipe/tasks-vision` in Phase 3, added by the orchestrator.
5. Work on the branch the orchestrator names. Never commit to `main`, never push, never force anything.
6. Match the existing code style: TypeScript strict, short header comment explaining each new file, no em dashes in user-facing text.
7. Done means: `npm run typecheck` passes, `npm test` passes, and you have listed what you changed and what you could not verify.

## How to run and test

- Start the game without a Cloudflare subdomain: `npm run dev:local` (offline mode, AI replaced by built-in fallbacks). Open http://localhost:5173.
- Phones only allow motion sensors on https. While `npm run dev:local` is running, press `t` then Enter in its terminal to start a tunnel and open the https address it prints on the phone.
- Typecheck: `npm run typecheck`. Tests: `npm test`.

## The phone contract (Phase 1 and 2)

Written first, by the orchestrator, in `shared/phone.ts`. Nobody else edits it.

Pairing: the game asks the relay for a new code, shows it with the phone page address, and the player types the code on the phone.

Routes (served by the Worker):

- `POST /api/phone/pair` returns `{ code: string }`, a 6-character code (letters and digits, no look-alike characters such as O/0 or I/1).
- `GET /api/phone/:code/ws?role=game` WebSocket for the game.
- `GET /api/phone/:code/ws?role=phone` WebSocket for the phone.

Messages are JSON, one per WebSocket message:

| From | Message | Meaning |
|---|---|---|
| phone | `{ "t": "hello" }` | Phone connected. |
| phone | `{ "t": "step", "at": number }` | One step detected. `at` is the phone's `performance.now()` in ms. |
| phone | `{ "t": "film", "on": boolean }` | Record button state. Sets the state, never toggles. |
| relay | `{ "t": "peer", "connected": boolean }` | The other side joined or left. Sent to both sides. |
| game | `{ "t": "status", "filming": boolean }` | Lets the phone show the right button state if filming changed from the keyboard. |

The relay only forwards messages between the two sides of one code. It stores nothing and drops a code once both sides have been gone for 10 minutes.

## How steps become movement (Phase 1)

There is no speed sensor. The phone counts steps; the game turns step rhythm into one of three states.

- Step detection runs on the phone: magnitude of `accelerationIncludingGravity`, minus gravity, smoothed; a step is a peak above a threshold with at least 250 ms since the previous step. Lives in `shared/stepDetector.ts` as a pure function so it can be tested without a phone. Threshold and minimum gap are named constants (they will need tuning on real phones).
- The game keeps the last few step times:
  - no step for 0.9 s: stopped
  - steps faster than 0.75 of the player's normal interval: hurrying (same as holding Shift)
  - otherwise: walking forward (same as holding W)
- Normal interval starts at 0.55 s and is replaced by the player's own median after their first 8 steps (simple calibration).
- The phone adds to `MoveIntent` in `src/player/input.ts`; it never overrides a key the player is holding.

## Phases

| Phase | What | Needs owner sign-off |
|---|---|---|
| 1 | Phone walking: relay, phone page, pairing screen, steps into movement | No |
| 2 | Phone filming: record button does exactly what F does in Part 2 | No |
| 3 | Webcam head turning: face tracking on the laptop, small head turn becomes a big view turn with a dead zone; 3D sound and "facing him" follow the head | No |
| 4 | New actions: calling someone, pushing him (new events, model reactions) | Yes. Do not start. |
| 5 | Calibration beat in Part 1, hesitation in the debrief | Yes. Do not start. |

## File ownership

| Agent | Owns (may create or edit) |
|---|---|
| orchestrator | `shared/phone.ts`, this file, `package.json`, `vite.config.ts`, `vitest.config.ts`, `tsconfig*.json` |
| relay-backend | `worker/phoneRelay.ts` (new), `worker/index.ts` (phone routes and export only), `wrangler.jsonc` (new Durable Object binding and a new migration tag only), the `Env` interface in `worker/session.ts` (one added field only) |
| phone-frontend | `phone.html` (new, project root), `src/phone/**` (new), `shared/stepDetector.ts` (new) |
| game-integration | `src/net/phoneLink.ts` (new), `src/player/input.ts`, `src/player/player.ts`, `src/scenarios/**`, `src/ui/**`, `src/main.ts`, and in Phase 3 `src/vision/**` (new) |
| tester | `**/*.test.ts` files only |
| reviewer | nothing (read only) |

Two agents never edit the same file in the same phase. If a task needs a file another agent owns, the orchestrator sequences it.
