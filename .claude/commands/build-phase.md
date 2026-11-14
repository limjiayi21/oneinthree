---
description: Orchestrate one phase of the interactive controls plan using the helper agents
argument-hint: <phase number, e.g. 1>
---

You are the orchestrator for phase $ARGUMENTS of the One in Three interactive controls work. You plan, set boundaries, hand out tasks to the helper agents, check their work and report to the human. You write code yourself only for the files the plan gives to the orchestrator, or when a task is so small (one or two lines) that handing it out costs more than doing it.

## 1. Check the phase is allowed

Read `docs/INTERACTIVE_CONTROLS_PLAN.md`. If phase $ARGUMENTS needs the owner's sign-off (Phases 4 and 5), stop and tell the human what needs agreeing first. Do nothing else.

## 2. Set up

- Run `git status`. If there are uncommitted changes you did not expect, stop and ask the human.
- Work on branch `controls/phase-$ARGUMENTS`. Create it from the current branch if it does not exist. Never work on `main`.
- Do the orchestrator's own groundwork for this phase before anyone else starts:
  - Phase 1: write `shared/phone.ts` (message and route types exactly as in the plan), add `phone.html` as a second build input in `vite.config.ts`, add `shared/**/*.test.ts` to the `include` list in `vitest.config.ts`.
  - Phase 2: extend `shared/phone.ts` only if the plan's film and status messages are not already there.
  - Phase 3: run `npm install @mediapipe/tasks-vision` and decide where the face model file is served from (prefer a file in `public/`).
- Run `npm run typecheck` so every helper starts from a clean build.

## 3. Hand out tasks

Use the Agent tool with the named agents in `.claude/agents/`. Each task you send must state: the phase, the exact deliverable, the files that agent may touch (copied from the plan), what "done" means, and anything another agent has already built that this one depends on. Agents only know what you tell them plus the plan file.

Order for each phase (send independent tasks in the same message so they run in parallel):

- Phase 1: `relay-backend` (relay and routes) and `phone-frontend` (phone page and `shared/stepDetector.ts`) in parallel. When both are done: `game-integration` (pairing screen, `src/net/phoneLink.ts`, steps into `MoveIntent`) and `tester` (step detector and step rhythm checks) in parallel.
- Phase 2: `phone-frontend` (record button) and `game-integration` (one set-filming function used by both the F key and the phone) in parallel.
- Phase 3: `game-integration` (webcam tracking in `src/vision/**`, head offset layer, sound and facing follow the head), then `tester` (the mapping from head angle to view angle, including the dead zone).

## 4. Check every result yourself

Do not trust a helper's summary. After each one reports:
- Run `git status --short` (it also lists new files, which `git diff` does not) and confirm every changed file belongs to that agent in the plan's ownership table. Anything outside it gets reverted and the task is sent back.
- Run `npm run typecheck` and `npm test`.
- If something is wrong, send it back to the same agent with the exact problem. After two failed rounds on the same problem, stop and ask the human.

## 5. Independent review

When all tasks for the phase pass your checks, run the `reviewer` agent. Send real problems back to the owning agent, then check again. Ignore style nitpicks.

## 6. Hand over to the human

Do not commit or push. Report in plain language:
- what now works and how to try it (`npm run dev:local`; for the phone, press `t` then Enter in the dev server terminal and open the https address on the phone)
- what was tested automatically and what still needs a real phone or webcam
- anything you decided that the human or the project owner should know

Then ask whether to commit.
