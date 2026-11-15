# Part 1 demo mode: a 25–30 s walk to the shop

## Why

The whole demo has to run in under 2 minutes. Planned budget:

| Segment | Time |
|---|---|
| Intro + briefing | ~10 s |
| **Part 1 (this doc)** | **~25–30 s** |
| Bridge card | ~5 s |
| Combined bystander + guided scene (separate project) | ~45 s |
| Recap | ~15 s |

Part 1 today is ~77 m of open street (~53 s of walking alone) with several possible endings.
For the demo it must be one guided storyline: walk, meet the man, take refuge in the shop.

## Goals

- `?demo=1` turns on a short Part 1. Without it, Part 1 is exactly as it is today.
- The set path (start, past the man, into the shop) is the quickest way through the scene and
  takes under 20 s from gaining control to entering the shop, at normal walking speed, with the
  encounter happening while she walks.
- She stays on her own (right) sidewalk: no crossing the road, no going home, no going back.
- The shop is the only ending she can walk to.

## Non-goals

- The combined bystander/guided scene, and the rest of the demo flow (skipping debriefs,
  the bridge card, the recap). Those come with the combined-scene project.
- Any change to the street geometry, Part 2, or the guided replay.
- Changing the decision model or the server.

## Anti-goals

- Driving her on rails. The player must still walk her; Part 1 is about being her.
- A demo that can stall: no ending may depend on the player finding the shop on their own.

## Approaches

- **A. Move her start and his spot, Part 1 demo only (chosen).** New points just past the
  scaffolding; Part 2 and the replay keep theirs. Loses the subway-exit opening and the alley scare.
- B. Move the shop up the street. Keeps the opening and the alley, but rebuilds street geometry
  and shop interior and shifts staging the combined scene will use.
- C. Keep geometry and auto-walk faster. Little code, but 77 m in 20 s is running, and the
  player loses control of her body.

A is the only one that hits the time without touching the street or the scene being rebuilt.

## Design

**Flag.** `main.ts` reads `?demo=1` and passes `demo: true` on `SceneDeps`. Only Part 1 reads it
for now.

**Staging (demo only).**
- She starts on the right sidewalk at about z = −52, facing down the street.
- He leans on the wall at about (8.08, −64), the same pose and behaviour as today.
- **A quick scene-setting prologue**, packed into the fade-in and first seconds instead of
  being spread along the street:
  - During the fade-in: keys jingle and her keys thought (`w_keys`). The passer-by is already
    on the far sidewalk, headphones on, walking the other way.
  - As she gains control: the trash-can crash and cat yowl, played from just ahead on her
    right (not the real alley, which is behind her), with the startle, gasp and `w_alley_1`.
    `w_alley_2` is dropped.
- He looks up (the notice beat) ~2 s after the crash, once `w_alley_1` has landed. The
  encounter begins when she is ~6.5 m from him, about 4 s in.

**Corridor (demo only).** Two rects: her sidewalk from x = 4.5 to the building line, from 1.5 m
behind her start to 2 m past the shop door's far edge, plus the shop pocket. The edges are
silent: no hint text, she simply cannot go further. The shop is the end of her street.

**Pacing.**
- Opening card shortened: one card (~2.5 s) and a ~1 s fade, instead of 3.8 s + 2.2 s.
- Once the encounter begins, the objective reads "Get to the shop." instead of "Get home."
  and the shop thought (`w_shop`) fires as soon as he first speaks, not when she is near the door.
- The model still drives him. Because she keeps walking and the shop is ~15 m past him, the
  encounter naturally fits in one or two exchanges.
- If she has not entered the shop 15 s after the encounter began, show the hint
  "The shop is still open." once, so the demo cannot stall.

**Shop ending (demo only), ~7 s instead of ~15 s.** Bell, clerk's line, one thought (`w_refuge_1`),
fade. Drop the second thought and shorten the waits.

**Expected timing.** ~26 m of walking from control to inside the shop (~4 s to the encounter,
~14 s past him to the door, ~1.5 s through it) = ~19 s on the set path. Plus ~3.5 s opening
and ~7 s shop ending around it.

## Left to the builder

- Exact z values for her start and his spot, tuned by walking it, to land on the times above.
- Whether the escalation ending needs its own demo trim (it is not on the guided path).
- A test for the demo corridor: she can step into the shop, cannot reach the road or past the shop.
