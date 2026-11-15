# Part 1 Demo Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With `?demo=1`, Part 1 becomes a guided ~19 s walk on her own sidewalk: a quick scene-setting prologue, the man, then the shop.

**Architecture:** All demo staging values and the demo corridor live in one new pure module, `src/scenarios/womanDemo.ts`, which is unit-tested. `main.ts` reads the flag onto `SceneDeps.demo`; `womanWalkHome.ts` branches on `deps.demo` at a handful of clearly marked points. Without the flag, behaviour is unchanged.

**Tech Stack:** TypeScript, three.js, Vite, Vitest (`npm test`, `npm run typecheck`).

**Spec:** `docs/superpowers/specs/2026-11-14-part1-demo-mode-design.md`

## Global Constraints

- Demo behaviour only when the URL has `demo=1`. Without it, Part 1, Part 2, the guided replay and the server behave exactly as today.
- No changes to street geometry (`src/world/layout.ts` points/zones, `street.ts`, `landmarks.ts`), Part 2, the guided replay, or the server.
- Set path (control to inside the shop, normal walking speed 1.45 m/s) under 20 s.
- Demo corridor edges are silent: no `onCorridorEdge` hint.
- The player always walks her herself; no auto-walk.
- The only text hint added: "The shop is still open." once, 15 s after the encounter begins, if she is not in the shop.
- Objective once the encounter begins (demo): "Get to the shop."

## Review Focus

1. Stepping from the sidewalk into the shop through its door must work in the demo corridor (the overlap bug the full corridor already hit) → test in Task 1.
2. The man's pushes, blocks and step-backs must not shove her onto the road or behind her start → covered by the corridor clamp running in `resolve()`; test in Task 1 that road and behind-start points are clamped.
3. Walking into the shop before the encounter starts can't end the scene early (shop ending requires `encounter`) → unchanged existing guard; check in Task 2's manual run.
4. If the player stops to talk, the scene must not stall forever → the 15 s nudge in Task 3.
5. Prologue thoughts must not talk over his first line → notice fires 2 s after the crash and the encounter ~4 s in; check timing in Task 3's manual run.

---

### Task 1: Demo staging module and flag

**Files:**
- Create: `src/scenarios/womanDemo.ts`
- Create: `src/scenarios/womanDemo.test.ts`
- Modify: `src/scenarios/common.ts` (`SceneDeps`, ~line 35)
- Modify: `src/main.ts` (deps construction ~line 105–120)

**Interfaces:**
- Produces:
  - `export const DEMO: { start: THREE.Vector3; startYaw: number; manSpot: THREE.Vector3; crashSource: THREE.Vector3; noticeDelay: number; nudgeAfter: number }`
    - `start = (5.75, 0, -52)`, `startYaw = 0` (same facing as `subwayExit`, down the street), `manSpot = (8.08, 0, -64)`, `crashSource = (8.3, 1, -58)` (just ahead on her right), `noticeDelay = 2`, `nudgeAfter = 15`.
  - `export function demoCorridor(): Rect[]` — `[rect(ROAD_HALF, LINE, SHOP.doorZ - SHOP.doorHalf - 2, DEMO.start.z + 1.5), <the shop pocket, identical to walkCorridor's second rect>]`. Reuse the shop-pocket rect by extracting it from `walkCorridor` into an exported `shopPocket(): Rect` in `layout.ts` (pure refactor, no value change).
  - `export function setPathSeconds(walkSpeed: number): number` — straight-line length start → `shopDoor` → `shopInside` (x/z only) divided by `walkSpeed`.
  - `SceneDeps.demo?: boolean`.

- [ ] **Step 1: Write the failing tests** in `src/scenarios/womanDemo.test.ts` (style of `src/player/corridor.test.ts`, radius 0.3, using `clampToCorridor`):
  - `the set path takes under 20 s at walking speed`: `expect(setPathSeconds(PLAYER_TUNING.walkSpeed)).toBeLessThan(20)`.
  - `leaves her alone on her sidewalk between start and shop`: `at(6, -52).edge`, `at(7.5, -64).edge`, `at(5, -78).edge` all `null`.
  - `lets her step from the sidewalk through the door into the shop`: points `(LINE - 0.4, SHOP.doorZ)`, `(LINE + 0.4, SHOP.doorZ)`, `((SHOP.x0 + SHOP.x1) / 2, SHOP.doorZ)` all `null`.
  - `keeps her off the road`: `at(0, -64)` → edge `'side'`, `p.x >= ROAD_HALF + 0.3 - 1e-9`.
  - `stops her going back`: `at(6, -45)` → `'back'`, `p.z <= -50.5`.
  - `stops her going past the shop toward home`: `at(6, -100)` → `'ahead'`, `p.z >= SHOP.doorZ - SHOP.doorHalf - 2 + 0.3 - 1e-9`.
  - `starts her and the man inside the corridor, him ahead of her`: `at(DEMO.start.x, DEMO.start.z).edge` is `null`; `DEMO.manSpot.z < DEMO.start.z`; `DEMO.start.z - DEMO.manSpot.z > 6.5 + 4` (encounter doesn't start the moment she can move).

- [ ] **Step 2: Run** `npx vitest run src/scenarios/womanDemo.test.ts` — expected FAIL (module not found).

- [ ] **Step 3: Implement** `womanDemo.ts` per Interfaces, extract `shopPocket()` in `layout.ts` and use it from `walkCorridor`. Add `demo?: boolean` to `SceneDeps` with a one-line doc comment. In `main.ts`, set `demo: params.get('demo') === '1'` on the deps object.

- [ ] **Step 4: Run** `npm test && npm run typecheck` — expected all PASS, including the existing `corridor.test.ts` (proves the `shopPocket` refactor changed nothing).

- [ ] **Step 5: Commit**
```bash
git add src/scenarios/womanDemo.ts src/scenarios/womanDemo.test.ts src/scenarios/common.ts src/main.ts src/world/layout.ts
git commit -m "Add demo staging and corridor for a short Part 1"
```

### Task 2: Demo staging and prologue in Part 1

**Files:**
- Modify: `src/scenarios/womanWalkHome.ts`

**Interfaces:**
- Consumes: `DEMO`, `demoCorridor()` from Task 1; `deps.demo`.

Every change below applies only when `deps.demo` is true; mark each branch with a `// demo:` comment.

- [ ] **Step 1: Corridor and poses.** `createPlayer` gets `corridor: deps.demo ? demoCorridor() : walkCorridor(P.subwayExit.z)` and `onCorridorEdge` only when not demo. `man.setPose(deps.demo ? DEMO.manSpot : P.harasserSpot, Math.PI / 2)`. `player.setPose(deps.demo ? DEMO.start : P.subwayExit, deps.demo ? DEMO.startYaw : 0)`. `progress()` uses `DEMO.start.z` as its origin in demo.

- [ ] **Step 2: Skip the street beats in `onFrame`.** In demo, do not run the `'keys'`, `'passer'`, `'alley'` or zone-based `'notice'` blocks, nor the `w_notice_cross` follow-up (crossing is impossible). Keep the `'start'` controls hint.

- [ ] **Step 3: Prologue (demo), in the run section.**
  - Right after `hud.card(...)` resolves and before `hud.fade(false, ...)`: `audio.play('keys_jingle', { volume: 0.5 })`, `kit.think('w_keys', { intensity: 0.12 })`; show the passer on the far sidewalk ahead (`passer.setPose(v(-6.35, DEMO.start.z - 12), Math.PI)`, visible, `leave` toward `P.passerbyA1` at 1.5).
  - At `player.inputEnabled = true`: the crash beat from the existing `'alley'` block, with sounds at `DEMO.crashSource` (cat yowl at the same point), `player.startle(0.9)`, gasp, `kit.scare(0.75)`, `kit.think('w_alley_1', { intensity: 0.95 })` after 0.35 s. No `world.triggerAlleyEvent()`, no `w_alley_2`.
  - After `DEMO.noticeDelay` s: run the existing notice body (gaze, smirk, `serverFear`, `w_notice_1`) and `once.add('notice')`, so the existing encounter check takes over. Drop `w_notice_2` in demo.

- [ ] **Step 4: Run** `npm run typecheck && npm test` — expected PASS.

- [ ] **Step 5: Manual check** with `npm run dev`, open `/?demo=1&skip=intro`: she starts mid-block on the right sidewalk, keys + passer during fade-in, crash on control, he looks up ~2 s later, she can't step onto the road or back, the shop door is walkable, walking into the shop before he engages does nothing. Then open `/?skip=intro` and confirm Part 1 starts at the subway exit as before.

- [ ] **Step 6: Commit**
```bash
git add src/scenarios/womanWalkHome.ts
git commit -m "Stage the Part 1 demo: mid-block start, quick prologue, sidewalk only"
```

### Task 3: Demo pacing and shop ending

**Files:**
- Modify: `src/scenarios/womanWalkHome.ts`

**Interfaces:**
- Consumes: `DEMO.nudgeAfter`; `deps.demo`.

- [ ] **Step 1: Opening.** In demo: `hud.card('11:42 PM', 'Four blocks from home.', 2500)` (same copy, shorter) and `hud.fade(false, 1000)` (full version keeps 3800 / 2200 and its copy).

- [ ] **Step 2: Encounter pacing.** In demo, when the encounter begins: `hud.objective('Get to the shop.')` (also in `leave()`); `kit.after(DEMO.nudgeAfter, () => !kit.ended && !finishing && hud.hint('The shop is still open.', 5000))`. In `onLine`, on the man's first line in demo, `kit.think('w_shop')` via `first('shopThought')` 1.5 s after his line starts, instead of the proximity trigger.

- [ ] **Step 3: Shop ending (demo).** In the `took_refuge` branch: keep bell, clerk gaze/emotion and his line; then `kit.think('w_refuge_1')`, `await kit.wait(2.2)`, `hud.fade(true, 1200)`, `audio.stopAmbience(1.2)`, `await kit.wait(0.6)`, `kit.end(outcome)`. Drop `w_refuge_2`. Full version unchanged.

- [ ] **Step 4: Run** `npm run typecheck && npm test` — expected PASS.

- [ ] **Step 5: Manual timing check** at `/?demo=1&skip=intro`: stopwatch from the moment she can move to the shop bell, walking straight at normal speed without stopping. Expected under 20 s. Then stop beside him and confirm the nudge appears ~15 s after he engages. Shop ending to fade-out ~7 s. If over 20 s, move `DEMO.start` / `DEMO.manSpot` closer to the shop in `womanDemo.ts` (the Task 1 tests guard the bounds).

- [ ] **Step 6: Commit**
```bash
git add src/scenarios/womanWalkHome.ts src/scenarios/womanDemo.ts
git commit -m "Pace the Part 1 demo: short opening, shop objective and nudge, short refuge ending"
```
