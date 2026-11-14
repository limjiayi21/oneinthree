# Part 1 film: assets

Source material for the 90-second film shown after Part 1. Everything here lives
in `film/assets/` and is **not** shipped in `public/`. Generated on 2026-11-14
with ElevenLabs. Prompts are in [PROMPTS.md](PROMPTS.md). The raw per-item log
(model, generation id, time, credits, full request) is `film/assets/log.jsonl`.

**Status:** all five clips animated in Veo 3.1. Seedance was not available on the
account (ByteDance models need approval from ElevenLabs support), so there is no
second-model comparison.

## Chosen assets

| Use | File |
|---|---|
| Narration | `narration-1-female.mp3`, `narration-2-female.mp3`, `narration-3-female.mp3` |
| Clip A still / video | `images/A-2.png` / `video/A-veo.mp4` |
| Clip B still / video | `images/B-3.png` / `video/B-veo.mp4` |
| Clip C still / video | `images/C-2.png` / `video/C-veo.mp4` |
| Clip D still / video | `images/D-3.png` / `video/D-veo.mp4` |
| Clip E still / video | `images/E-5.png` / `video/E-veo.mp4` |
| Sound effects | `sfx-footsteps.mp3`, `sfx-follower.mp3`, `sfx-keys.mp3`, `sfx-heartbeat.mp3`, `sfx-ambience.mp3` |
| Music | `music.mp3` |
| Catcall montage | `montage.wav` |

Unused but kept: the male narration (`narration-*-male.mp3`) and the other
thirteen stills (`A-1`, `A-3`, `B-1`, `B-2`, `C-1`, `C-3`, `D-1`, `D-2`, `E-1`,
`E-2`, `E-3`, `E-4`, `E-6`).

## Narration

Script: `film/scripts/gen-audio.mjs`. Model `eleven_v4`, `mp3_44100_128`,
stability 0.5, similarity boost 0.8, delivery tag `[calm, low, warm]` (the
repo's pre-render model, format and calm settings from `worker/voices.ts`).

| File | Voice | Length | Credits |
|---|---|---|---|
| `narration-1-female.mp3` | **Matilda - Knowledgable, Professional** (`XrExE9yKIg1WjnnlVkGX`) | 5.8 s | 45 |
| `narration-2-female.mp3` | Matilda | 5.2 s | 44 |
| `narration-3-female.mp3` | Matilda | 2.9 s | 24 |
| `narration-1-male.mp3` (unused) | Brian - Deep, Resonant and Comforting (`nPczCjzI2devNBz1zQrb`) | 5.4 s | 45 |
| `narration-2-male.mp3` (unused) | Brian | 4.8 s | 44 |
| `narration-3-male.mp3` (unused) | Brian | 2.7 s | 24 |

Lines: (1) "For you, that was a simulation. For many women, it's an ordinary walk
home." (2) "Most of it happens when no one else is around. So most men never see
it." (3) "But sometimes, someone is there."

## Sound effects

Script: `film/scripts/gen-audio.mjs`. Model `eleven_text_to_sound_v3`, prompt
influence 0.5. No existing repo sound fitted (the repo's keys are a 1.5 s dry
grab, its city ambience has no rain, its footsteps are single dry steps, and its
heartbeat is synthesised live), so all five were generated.

| File | Length | Credits |
|---|---|---|
| `sfx-footsteps.mp3` | 10 s | 121 |
| `sfx-follower.mp3` | 10 s | 121 |
| `sfx-keys.mp3` | 6 s | 73 |
| `sfx-heartbeat.mp3` | 15 s | 182 |
| `sfx-ambience.mp3` | 20 s | 242 |

## Music

`music.mp3`: 80 s, `music_v2_5`, instrumental, made by `film/scripts/gen-audio.mjs`.
The API returns no per-item cost for music; from the account's credit counter it
was about 1,200 credits.

## Catcall montage

`montage.wav`: 12.0 s, stereo, 44.1 kHz, 16-bit. Built by
`film/scripts/build-montage.mjs` with ffmpeg; no API calls. Eight of the man's
pre-rendered lines enter progressively closer together and louder, panned around
the listener (the first three dulled and quieter, as if further away), over
`sfx-heartbeat.mp3`. Digital silence from 11.5 s. Slur lines were left out.

| Source (`public/audio/vo/`) | Line | Starts | Pan | Gain |
|---|---|---|---|---|
| `lb_opening_1.mp3` | Hey. Hey, beautiful. Where you headed? | 0.0 s | centre | 0.35, far |
| `lb_opening_4.mp3` | Hey, gorgeous. Smile, it's not that bad. | 1.3 s | left | 0.4, far |
| `lb_persist_4.mp3` | Why you so quiet, sweetheart? I don't bite. | 2.8 s | right | 0.5, far |
| `lb_persist_3.mp3` | You got a man? I bet you don't have a man. | 4.0 s | left | 0.6 |
| `lb_follow_2.mp3` | Where you running to? Slow down. | 5.3 s | right | 0.7 |
| `lb_guilt_7.mp3` | It's a compliment, sweetheart. Most girls would say thank you. | 6.4 s | centre-left | 0.75 |
| `lb_block_6.mp3` | Look at me when I'm talking to you. | 7.6 s | centre-right | 0.9 |
| `lb_escalate_1.mp3` | Hey! Don't you walk away from me! | 8.8 s | centre | 1.0 |

## Stills

Script: `film/scripts/flow.mjs image`. Model `gemini-3-pro-image`, 16:9, 2K
(2752×1536 PNG), three versions per clip. Clip A was generated from its prompt
alone; B–E used `A-2.png` as a style reference, which costs about 50% more.

| Files | Credits each | Time each |
|---|---|---|
| `images/A-1..3.png` | ~1,218 | ~26 s |
| `images/B-1..3.png`, `C-1..3`, `D-1..3`, `E-1..3` | ~1,835 | ~34 s |
| `images/E-4..6.png` (E redone with a new prompt) | ~1,827 | ~35 s |

E was redone because E-1 to E-3 put the watcher on the same pavement as the
woman, so he read as a follower. The new prompt (in PROMPTS.md, with the old one
kept below it) asks for a road between them. E-4, E-5 and E-6 all show that;
E-5 was chosen because its road runs straight across the middle of the frame.

## Video

Script: `film/scripts/flow.mjs video`. Image-to-video from the approved still,
8 s, 16:9, 720p, no generated audio.

| File | Model | Start frame | Generation time | Credits |
|---|---|---|---|---|
| `video/A-veo.mp4` | `veo-3.1-generate-001` | `images/A-2.png` | 81 s | 9,696 |
| `video/B-veo.mp4` | `veo-3.1-generate-001` | `images/B-3.png` | 81 s | 9,696 |
| `video/C-veo.mp4` | `veo-3.1-generate-001` | `images/C-2.png` | 81 s | 9,696 |
| `video/D-veo.mp4` | `veo-3.1-generate-001` | `images/D-3.png` | 76 s | 9,696 |
| `video/E-veo.mp4` | `veo-3.1-generate-001` | `images/E-5.png` | 82 s | 9,696 |
| (Seedance, clip A) | `bytedance-seedance-v2.5` | — | refused (403, not charged) | 0 |

All clips are 1280×720, 24 fps, 8.0 s, no audio. Notes from checking frames at
0, 4 and 8 s:

- **A:** style holds; the street brightens and the black sky shrinks towards the end.
- **B:** the hand barely moves; the background streaks shift colour (blue to
  mustard and back), which reads as a painterly shimmer but is more than "grain".
- **C:** the blue shadow moves with her rather than visibly closing in; the
  camera drifts forward.
- **D:** close to static as asked; rain and window light move subtly.
- **E:** the push-in is much stronger than "very slow": it passes the watcher
  and ends on a close-up of her, so the road between them is gone by the end.
  The first 3–4 s match the brief and could be used alone.

## Edit-ready clips

`film/assets/edit/A.mp4` … `E.mp4`: each exactly 8.000 s, 192 frames, 1280×720,
24 fps, no audio. Built by `film/scripts/prep-clips.mjs` (ffmpeg, no API calls);
`--compare` also writes plain and blended versions to `edit/compare/`.

| Clip | Source range | Stretch | Retiming |
|---|---|---|---|
| A | 0–6 s | ×1.333 | minterpolate frame blending |
| B | 4–8 s | ×2 | minterpolate frame blending |
| C | whole clip | — | as is (stream copy) |
| D | whole clip | — | as is (stream copy) |
| E | 0–4 s | ×2 | plain slowing (each frame held twice) |

- **B's window** was chosen by `film/scripts/find-calm-window.mjs`, which scores
  every 4 s window by colour change in the background (top band and right edge,
  away from the hand). 4–8 s scored 477 against 902 for the busiest window
  (1–5 s). It is the calmest, not still: the mustard streak fades to black, and
  small blue and mustard streaks enter at the edges near the end.
- **E** keeps the road and lane lines visible in every frame; by the end they are
  a band at the bottom right, beside the watcher's shoulder.
- **Blending versus plain slowing** was judged on frame-step evenness
  (coefficient of variation of frame-to-frame change), per-frame sharpness and
  close-up crops:

| Clip | Unevenness plain → blend | Blended frames' sharpness loss | Kept |
|---|---|---|---|
| A | 0.60 → 0.15 | ~12%, no visible ghosting | blend |
| B | 1.26 → 0.54 | ~5% | blend |
| E | 1.16 → 0.40 | ~25% on every other frame; grain vanishes and the watcher's shoulder doubles, so texture pulses at 12 Hz | plain |

## Credits spent

| Item | Credits |
|---|---|
| Stills (18) | 31,150 |
| Video (5 clips, Veo) | 48,480 |
| Narration (6 lines) | 226 |
| Sound effects (5) | 739 |
| Music | ~1,212 |
| **Total** | **81,807** |

Per-item image figures are averages: the account's credit counter updates late,
so individual readings in the log show 0 or double. Totals are from the counter.
