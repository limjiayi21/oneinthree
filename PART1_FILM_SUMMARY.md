# Part 1 film: summary

Branch `part1-film` (local only, not pushed or deployed), rebased onto `main` at
`93d06d3`. Worktree: `/Users/aishwaryagoyal/oneinthree-part1-film`.

## What was built

**A 30-second narrated film that plays when Part 1 ends**, in place of Part 1's
debrief. It is a plain film: no question, no slider, nothing to answer.

| Time | Picture | Narration (Matilda, female voice) and on-screen text |
|---|---|---|
| 0:00–0:05 | Black | Catcall montage (7 of the man's lines, panned, building up, heartbeat under it), cut to silence at 4.8 s |
| 0:05–0:10 | Clip A: her walk | "For you, that was a simulation. For many women, it's an ordinary walk home." (also as a caption) |
| 0:10–0:14 | Clip D: empty street, rain | "Sixty-six percent of women in the US have been sexually harassed in public." + 66% stat |
| 0:14–0:19 | Clip B: keys | "In the UK, forty-four percent of women hold their keys ready to defend themselves." + 44% stat |
| 0:19–0:23 | Clip C: the shadow | "More than one in three women in the US have been followed." + 1 in 3 stat |
| 0:23–0:30 | Clip E: from across the road | "Only twenty-five percent of people harassed in public say someone helped." + 25% stat, then "This time, you're the one. What would you do?" spoken and shown large in the centre as the picture fades to black |

- **Sound:** footsteps and keys on her shots; the follower's footsteps and a
  rising heartbeat on clip C; city ambience and a quiet music bed throughout,
  20 dB under the narration, rising slightly on the last shot. Mixed to
  -16 LUFS.
- **On screen:** each stat uses the number and wording from
  `content/evidence.json`, with a small source line under it (publisher and
  year). White (the game's off-white) text on a soft dark band across the lower
  third, 0.3 s fades, 0.3 s crossfades between shots.
- **Spoken stats are short forms.** The full wording and source stay on screen.
  The 44% figure is from a UK YouGov survey, so the spoken line says "In the UK".
- **The flashes are gone.** Clip C's light used to cut out at about 0:20 and
  then strobe. The film now uses only C's calm first 3 seconds (slowed 1.18×).
  A frame-by-frame brightness scan finds no jumps beyond crossfades and fades.
- **Narration is sped up 13%** (pitch kept) so all six lines fit in 30 seconds.
  It runs almost wall to wall, from 5.1 s to 29.4 s.

**In the game**
- The film opens with "Contains harassing language. Headphones recommended."
  for 3 seconds, then starts on Enter or click.
- Full screen on black, no browser controls. Space or Esc pauses and resumes. A
  quiet Skip button is always in the top right.
- When the film ends or is skipped, the Part 2 intro appears. It has a small
  "See full details" link that opens the old Part 1 debrief ("Walk it again"
  there replays Part 1).
- Screen readers: the on-screen words are read out from a hidden text track
  (`public/film/part1-film.vtt`) through a live region; every control has a
  label; focus moves to whatever needs it. With reduced motion, nothing fades.
- `?skip=part1` still plays the film; `?skip=film` leaves it out.

**Removed:** the mid-film question, the slider, "You guessed N", the guess
logging (`/api/film/guess`, migration `0004_part1_film.sql`, the `filmGuesses`
stats). They were never deployed.

## Font

The game's own fonts, as set in `src/ui/base.css` and used throughout
`screens.css`: **Inter** (captions, stat text, source lines) and **Newsreader**
(stat numbers and the closing line, as in the game's stat blocks). The game
loads both from Google Fonts at runtime; for the burned-in text the static TTFs
were downloaded from Google Fonts into `film/assets/fonts/`.

## Files and sizes

| File | Size | In git |
|---|---|---|
| `public/film/part1-film.mp4` (H.264 crf 26, AAC 128k, faststart, 1280×720, 24 fps, 30.0 s) | 4.7 MB | yes |
| `public/film/part1-film.vtt` | 1 KB | yes |
| `film/assets/part1-film-master.mp4` (crf 14) | 24 MB | no |
| `film/assets/` (all raw media) | 290 MB | no; backed up to `~/oneinthree-film-assets-backup/` |

Scripts (in git): `film/scripts/assemble-film.mjs` (builds the film),
`build-montage.mjs`, `gen-audio.mjs`, `flow.mjs`, `prep-clips.mjs`,
`find-calm-window.mjs`. `film/ASSETS.md` lists every asset and what it cost.

## Credits

This round: 205 ElevenLabs credits (the five new narration lines). Whole film
so far: about 82,000.

## Commands

Nothing new is needed to play it: there is no migration any more.

```sh
cd /Users/aishwaryagoyal/oneinthree-part1-film
npm run dev:local                      # or npm run dev
# open http://localhost:5173/?skip=intro,part1   (film straight away)
# open http://localhost:5173/                    (the real flow: play Part 1 first)

node film/scripts/assemble-film.mjs    # rebuild the film (needs ffmpeg, Google Chrome and film/assets/)
npm run build && npm test              # both pass (81 tests)
```

## Test by hand

1. **Real full screen.** Start the film with Enter, then with a click. It should
   go full screen. (Automated runs could not grant it, because synthetic key
   presses do not count as a user gesture.) Press Esc in full screen: the
   browser leaves full screen and the film should pause; Space resumes.
2. **Sound.** Headphones on: the montage builds and cuts to silence; narration
   is clear over the music and effects; the hook is not cut off at the end.
   Judge whether the 13% faster narration still sounds calm enough.
3. **The full flow.** Play Part 1 to the end (not `skip=part1`): the film should
   appear with no debrief first, and the Part 2 intro should show
   "See full details", which opens the Part 1 debrief and returns.
4. **Skip** in the middle, and **pause** with Space, Esc and a click on the picture.
5. **Screen reader** (VoiceOver: Cmd+F5): the note, the start button, the stats
   as they appear, and "Skip the film".
6. **Reduced motion** (System Settings, Accessibility, Display, Reduce motion):
   no fades on the note or controls.

## Things to know

- The burned-in text could not use ffmpeg's text filter (Homebrew's ffmpeg has
  none), so each card is rendered by headless Chrome as a transparent image and
  overlaid.
- The film player's classes are `oit-reel-*`: `oit-film-*` was already taken by
  the HUD's phone-filming frame.
- `film/assets/` is in `.gitignore`. Copy it (or keep the backup) before removing
  this worktree.
