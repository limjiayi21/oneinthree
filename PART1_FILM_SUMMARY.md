# Part 1 film: summary

Branch `part1-film` (pushed to GitHub, not deployed), rebased onto `main` at
`93d06d3`. Worktree: `/Users/aishwaryagoyal/oneinthree-part1-film`.

## What was built

**A narrated film of about 36 seconds that plays when Part 1 ends**, in place
of Part 1's debrief. It is a plain film: no question, no slider, nothing to answer.

| Time | Picture | Sound and on-screen text |
|---|---|---|
| 0:00–0:05 | Black | Catcall montage (7 of the man's lines, panned, building up, heartbeat under it), cut to silence at 4.8 s |
| 0:05–0:10.7 | Clip A: her walk | "For you, that was a simulation. For many women, it's an ordinary walk home." (also as a caption) |
| 0:10.7–0:24.8 | **Three stats, back to back with no gap**, each on its own shot with only its own card: the rest of her walk (66%), keys (44%, card in the top-right corner, clear of the hand), the empty street (25%) | Each stat spoken in full, one straight after another, the card switching on the cut. Heartbeat and the follower's footsteps rise underneath. |
| 0:24.8 | Clip E fades in | Her footsteps, the follower and the heartbeat ease out over a second; the city noise and music carry on |
| 0:25.5–0:28.4 | Clip E: the push-in past the figure across the road | "But sometimes, there is someone to help." (spoken, and as a caption), the city noise fading away under it |
| 0:29.0–0:31.1 | Clip E, then its last frame held | "And this time, **it's you**." "And this time," in her calm voice, "it's you" whispered, with a single gust of night wind behind it. The line appears in the middle of the screen, then fades out. |
| 0:32.6–0:36.4 | The picture fades to black | "What are you going to do?" appears in the middle, **not spoken**, in complete silence. |

- **Sound:** her footsteps, keys, city ambience and a quiet music bed (20 dB under
  the narration). Nothing stops dead: after the last stat her steps, the
  follower and the heartbeat ease out, and the city and music carry on into the
  last shot, fading out under "there is someone to help"; a gust of wind (the
  game's own `wind_gust.mp3`) sits behind the whisper and is gone before the
  question. Mixed to -16 LUFS.
- **On screen:** each stat card shows the number, the full wording from
  `content/evidence.json` and a source line (publisher and year).
- **Spoken stats are short forms.** The 44% figure is from a UK YouGov survey,
  so the spoken line says "In the UK".
- **The figure across the road** is the bystander (warm grey), as designed: it
  is the "someone" who is there, and "you're the one" makes it the player.
- **No flashes.** Clip C (the shadow, whose light cut out and strobed) is no
  longer used, along with the "more than 1 in 3" stat. The only brightness jumps
  are the deliberate hard cuts between stats.
- **Narration speed:** 3% faster than recorded (pitch kept), i.e. natural.

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
| `public/film/part1-film.mp4` (H.264 crf 26, AAC 128k, faststart, 1280×720, 24 fps, 36.4 s) | 5.3 MB | yes |
| `public/film/part1-film.vtt` | 1 KB | yes |
| `film/assets/part1-film-master.mp4` (crf 14) | 28 MB | no |
| `film/assets/` (all raw media) | 290 MB | no; backed up to `~/oneinthree-film-assets-backup/` |

Scripts (in git): `film/scripts/assemble-film.mjs` (builds the film),
`build-montage.mjs`, `gen-audio.mjs`, `flow.mjs`, `prep-clips.mjs`,
`find-calm-window.mjs`. `film/ASSETS.md` lists every asset and what it cost.

## Credits

Narration for the film: 342 ElevenLabs credits (eleven new lines and takes).
Whole film so far: about 82,100.

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
2. **Sound.** Headphones on: the montage builds and cuts to silence; the
   stats should come one straight after another, every word clear; no dropout
   after the 25% stat; the city fades under "there is someone to help"; "it's
   you" is a clear whisper with the wind behind it; the question sits in silence.
   (The whisper was picked from three takes by measurement, not by ear: take 1
   has the least voiced sound and is the clearest. Takes 2 and 3 are in
   `film/assets/` if you prefer one: change WHISPER in `assemble-film.mjs`.)
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
