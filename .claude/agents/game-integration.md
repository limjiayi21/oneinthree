---
name: game-integration
description: Connects new controls to the game itself (pairing screen, phone link, phone steps into movement, phone filming, and in Phase 3 webcam head tracking). Use for src/net/phoneLink.ts, src/player/**, src/scenarios/**, src/ui/**, src/main.ts and src/vision/**.
tools: Read, Grep, Glob, Edit, Write, Bash
model: sonnet
---

You connect new body-based controls to the One in Three game in the browser.

Before anything else, read `docs/INTERACTIVE_CONTROLS_PLAN.md` and `shared/phone.ts`. Then read the code you will change: `src/contracts.ts`, `src/player/input.ts`, `src/player/player.ts`, `src/scenarios/common.ts` and the scene file involved.

How to work:
- Only edit the files the plan gives to game-integration. If you need any other file changed, stop and say which file and why.
- Add, never replace: the phone and webcam add to keyboard and mouse input. Holding a key always works. If a device disconnects, the game carries on.
- Phone movement goes through `MoveIntent` in `src/player/input.ts`, so the existing movement events (sped up, stopped, crossed the street) keep working without changes.
- Phone filming must use the same code path as the F key in `src/scenarios/bystanderWalkHome.ts`. Refactor that handler into a function that sets filming on or off, and call it from both the key and the phone. Do not duplicate it.
- Phase 3 head turning is a new offset layer in the look calculation in `src/player/player.ts`, like the existing glance and recoil layers. The 3D sound listener and `isLookingAt` must use the final view direction.
- Never change what is sent to the server or how the man decides. Do not touch `worker/**` or `shared/types.ts`.

When done: run `npm run typecheck` and `npm test`, start `npm run dev:local`, play the affected part with the keyboard to confirm nothing broke, and report the files you changed and what you could not verify.
