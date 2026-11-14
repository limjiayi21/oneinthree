# Teaching replay: summary

Branch `teaching-replay`, from `main` (`b68d2b3`). Fourteen commits counting the summary and its update, all local; nothing was pushed. `npm run build` and `npm test` pass after every commit. There are 44 tests: the 25 model tests, unchanged, plus 19 new ones.

These are unchanged from main:

- the decision model, its parameters and its tests (`git diff main -- worker/model` is empty)
- Part 1 and its debrief
- `content/script.json`, `content/linebank.json` and `content/evidence.json`

## New Part 2 flow

1. **Part 2 free play.** Unchanged.
2. **Outcome screen.** Main's eyebrow, outcome title, body and duration, then two buttons: **Learn how to help** (primary) and **Walk it again**. The rest of main's debrief sits behind a **See full details** disclosure, unchanged: timeline, 5 Ds feedback, insights, numbers, case and the model.
3. **Teaching replay.** Five moments, each with the same four beats.
4. **Recap.** One screen.
5. **The existing closing screen.**

If the player leaves the simulation during Part 2 or the replay, the flow goes straight to the closing screen, as before.

## Commits

| Commit | What |
|---|---|
| `9babc84` | `.gitignore`, cherry-picked from cards-and-replay |
| `1c8b5d7` | Brought over the guided replay (see below) |
| `f092091` | Brought over the D1 logging (see below) |
| `ced9843` | Part 2 outcome screen: "Learn how to help" and "See full details" |
| `23d4be7` | **Task 1**: the four beats. Also includes the new `content/guided.json`, because the beats can't run without it. |
| `24cd78e` | **Task 2**: content tests for the five moments |
| `5b49bec` | **Task 3**: recap screen |
| `9d6573d` | **Task 4**: logging all five moments, with a new migration |

## What was brought over from cards-and-replay

**Brought over:**

- `.gitignore`
- The guided replay:
  - `content/guided.json`, since rewritten
  - `src/scenarios/guidedWalkHome.ts`, since rewritten around the four beats
  - the HUD choice panel and the panel and focus-trap helpers
  - the wiring in `src/main.ts`
  - the `?skip=intro,part1,part2` shortcut
  - the dev harness buttons
  - the guided content tests
- The D1 logging:
  - the `DB` binding in `wrangler.jsonc`
  - `migrations/0001_playthroughs.sql`, unchanged
  - `worker/stats.ts` and its tests
  - the Part 2 row written by `SessionDO`
  - `POST /api/session/:id/guided`
  - `GET /api/stats` behind `STATS_CODE`

**Not brought over:** `content/cards.json`, every card screen, the card CSS, and the card fields in `shared/content.ts`. The old director looked up card questions; that lookup is gone.

## What was built

### Task 1: the four beats

Every moment runs the same loop in `runMoment()` in [guidedWalkHome.ts](src/scenarios/guidedWalkHome.ts):

1. **Freeze.**
   - The scene clock stops and `Hud.freeze()` dims the screen.
   - Moment 2 sets `spotlight: "woman"`. Her upper body is projected to screen space and the dim becomes a radial gradient with a clear pool around her. I checked it in the browser: the pool sits on her.
2. **Choose.**
   - `Hud.choice()` shows an optional caption, the prompt, and the player's inner voice. The inner voice has a "You think:" label, sans italic, in the player's colour, with a left rule. Her thoughts stay as unlabelled floating serif text.
   - Then the three numbered choices.
3. **Play it out.** The chosen lines and what each body does. The player's own thoughts during playback are a subtitle labelled "You think:" (new speaker `self` in `Hud.subtitle()`).
4. **Name it.** `Hud.strip()` is a strip along the bottom with:
   - the concept name
   - the sentence
   - each stat as headline, text and a source link, all read from `evidence.json` by id
   - the concept's credit
   - one button: "Continue", or "Back to the same moment" on a rewind. Enter also works.

`best` and `good` continue. `weaker` and `backfires` play out, show their strip, then rewind over black to the same moment, with the option marked "(tried)". Moment 4's rewind shows the reset card again. Nothing ends on a failure.

**Accessibility.**

- **Keyboard:**
  - 1, 2 and 3 pick a choice.
  - Tab and Enter (or Space) work on the buttons.
  - Enter continues from the strip, except when focus is on a source link, which it opens.
  - Esc pauses over a choice, over a strip, or mid-playback. On resume the same panel comes back.
- **Screen readers:**
  - The panels are labelled dialogs; focus moves into them and is kept there.
  - The "You think:" subtitle is announced as "You think: …".
  - The recap ticks have screen-reader text.
- **Reduced motion:**
  - The camera cuts instead of gliding.
  - The panels and strip fade without sliding.
  - The dim appears with no transition.

### Task 2: content

`content/guided.json` holds the five moments of the brief. Each choice has:

- `id`, `text` and `rating`
- `tactic` (one of the 5 Ds, if any)
- `player` (where the camera goes)
- `lines`, `manAction` and `womanAction`
- `strip`: `{ concept, conceptId?, sentence, statId? }`

There is also a `concepts` block (the attributions, editable) and a `recap` block (the recap screen's text). The shapes are in [shared/content.ts](shared/content.ts). The tests check:

- the moments, ratings and 5 D tags against the brief
- that every strip is short
- that every stat id exists and has a linked source
- that every concept id resolves
- the recap contents
- first-pick ticks
- that none of our copy has emoji, scores or exclamation marks

### Task 3: recap

[`screens.recap()`](src/ui/screens.ts) shows:

- **The 5 Ds**, in evidence.json order, each with a one-line definition. A tick marks each D that was the player's first pick at some moment. Document and Direct are always listed.
- **"Before you can help"**: "Notice it" and "Decide it's your business".
- **The closing line**: "In real life no tactic is guaranteed, but these give her the best chance with the least risk to you."
- **Continue**, which goes to the existing closing screen.

It replaces the old guided end screen.

### Task 4: logging

- **New migration**, [migrations/0003_teaching_replay.sql](migrations/0003_teaching_replay.sql) (renamed from 0002, see Follow-up changes), adds `guided_m4` and `guided_m5`. `0001` is unchanged.
- **The Worker** writes the first choice id at each of the five moments. A stored first choice is never overwritten. Ids only, never words.
- **`GET /api/stats`** now returns, for each of the five moments:
  - `guidedFirstChoice`: how often each choice was picked first
  - `guidedFirstRating`: the first pick counted as best, good, weaker or backfires (new)

  It also returns `guidedCompleted`, the number of playthroughs with a first choice at all five moments.
- **Old rows.** Rows written before this change may hold ids from the old three-moment replay. Those ids don't exist in the new content, so the stats skip them. A test covers this.

## Choices I made where the brief was open

- **Strip headings.**
  - The heading names the concept, so I dropped "That's Distract." and similar from the start of the sentences. For example, the Distract strip reads "Distract" / "You helped without ever challenging him. Low risk."
  - Moment 4's best choice is headed "Direct, done safely".
- **Concept names for strips the brief didn't name:**
  - "Staying close" (cross the street)
  - "Reading the signs" (just a guy saying hi)
  - "Keep it short" (argue)
  - "Insults escalate"
  - "Her decision" (police)
  - "No blame"
- **Moment 2** has a caption and the inner voice but no prompt, as written. The caption labels the dialog.
- **Moment 4's text.** Caption: "He's blocking her way. She can't get past." Prompt: "Now you're close enough to speak. What do you say?"
- **Moment 2's two stats** use a `statIds` array. Every other strip uses `statId`. A test enforces this.
- **Ticks mean "chose first", not "did well".** For example, filming first at moment 3 ticks Document. Arguing or insulting at moment 4 has no tactic, so it doesn't tick Direct.
- **Moment 3's Delegate** plays the player's line, then `c_ask` and `c_help_1`, then the man's existing line "Alright, alright. I didn't do anything. I'm going."
- **The replay's opening card:** "Learn how to help" / "The same street again. It will stop at five moments and ask what you would do."
- **The outcome screen's "Next" line:** "Next: the same street once more. It will stop at five moments and show what helps."
- **Part 2 free play is unchanged.** Its own scripted player thoughts (`s_1` to `s_4`) still use her floating-thought style. Only the replay uses "You think:".

## Lines

**No new voiced lines are needed.** Every man, woman, clerk and her-thought line reuses an existing pre-rendered file. A test checks each `audioId` exists and matches its text. I did not run `gen:voice` or `gen:sfx`.

Reused audio ids:

| Speaker | Ids |
|---|---|
| Man | `b_m1`, `b_m2`, `b_m3`, `b_m4`, `lb_b_thrown_2`, `lb_b_clerk_1`, `lb_b_defensive_2`, `lb_b_dismiss_3`, `lb_b_defensive_6`, `lb_b_turn_2` |
| Clerk | `c_ask`, `c_help_1` |
| Woman | `lb_b_w_play_3`, `lb_b_w_leaving_2`, `lb_b_w_thanks_1`, `lb_b_w_leaving_3` |
| Her thoughts | `b_t2`, `b_t3`, `lb_b_turn_3_t`, `lb_b_dismiss_5_t` |

**New player lines.** These are subtitles only. The player is never voiced, by the existing design.

| Where | Speaker | Text |
|---|---|---|
| m3 Distract | you | Hey! Sorry I'm late, you ready? |
| m3 Delegate | you | There's a guy out there who won't leave a woman alone. Can you come out? |
| m3 Film | self (You think:) | At least I'm getting it on video. |
| m4 Direct | you | Leave her alone, man. |
| m4 Direct | you | You okay? Want to walk with me? |
| m4 Argue | you | You think that's how you talk to women? |
| m4 Insult | you | Back off, creep. You want a problem? |
| m5 Delay | you | Are you okay? I saw that. It wasn't okay. Want me to walk with you for a bit? |
| m5 Police | you | You should call the police. |
| m5 Blame | you | Why didn't you say something to him? |

**Inner voice shown in the choice panels** (text): "Probably nothing." (m1), "Is it my business?" and "Someone else will say something." (m2).

**Her reaction lines chosen from the bank.** Please read these two:

- **m5 Police.** She says "I'm going. I'm going home." and walks home alone.
- **m5 Blame.** Her thought is "Say no. Why can't I say no?" This is a bank thought written for a different moment. I used it because it reads as self-blame, which is what the strip names.

## Concept attributions to verify

These are stored in `concepts` in `content/guided.json`. All are `verified: false` with no `url`. The credit appears under the strip as "Idea: …". It becomes a link once a url is filled in.

| id | Attribution | Work | Year | Used on |
|---|---|---|---|---|
| `five_steps` | Bibb Latané & John Darley | The Unresponsive Bystander: Why Doesn't He Help? | 1970 | Noticing (m1 best and phone), Seeing it as a problem (m2 best) |
| `bystander_effect` | John Darley & Bibb Latané | "Bystander Intervention in Emergencies: Diffusion of Responsibility" | 1968 | The bystander effect (m2 wait for the clerk) |
| `five_ds` | Right To Be (formerly Hollaback!) | (none) | (none) | Distract, Delegate, Document, Direct done safely, Keep it short, Delay |

The other strips (Staying close, Reading the signs, Insults escalate, Her decision, No blame) carry no credit.

Three claims to check with a facilitator's eye:

1. **"Helping starts with noticing, and most people never get past it."** *Resolved: the strip no longer has a stat; the 86% stat moved to the bystander-effect strip.*
2. **"People step into most street fights…"** It rests on `cctv_9in10`. Evidence.json's own detail says that study covers public aggression in general, not sexual harassment. The sentence draws exactly that contrast, so I think it's fair, but please confirm.
3. **The m4 insult strip.** *Resolved: it now reads "Insults turn it into a fight between you and him, with her still stuck in the middle."*

## Migration commands

I applied `0003_teaching_replay.sql` to the **local** D1 only and checked the upsert there: first picks were kept and later moments filled in. I then deleted the test row. **The remote database is not migrated.**

```bash
npx wrangler d1 migrations apply oneinthree-stats --local    # done here
npx wrangler d1 migrations apply oneinthree-stats --remote   # yours to run, before deploying this branch
npm run deploy
curl -H 'x-stats-code: <your code>' https://<your-worker>.workers.dev/api/stats
```

**Deploy order.** Run the remote migration before deploying. Without it, the Worker's write names columns that don't exist yet. That write fails, is logged and is swallowed, so the simulation is unaffected, but no rows are recorded.

**Note on the cards-v2 branch.** It has its own `migrations/0002_card_answers.sql`, and your local D1 has applied it (it added a `cards` column). This branch's migration is numbered 0003, so the two don't share a number.

## How it was checked

- **The real app.** Headless Chrome, `?skip=intro,part1,part2&nolock=1`. I ran it with a temporary local Vite config that turns off remote bindings, then deleted the config. Normal `npm run dev` needs `wrangler login` or `CLOUDFLARE_API_TOKEN`, because the AI binding is remote. In the replay I checked:
  - every one of the 15 choices
  - every rewind, including the "(tried)" marks and the replay of his line for context
  - the reset card before moment 4
  - the spotlight at moment 2
  - the REC overlay and the "You think:" subtitle when filming
  - real Enter and number-key presses
  - Esc to pause over an open choice; the clock stopped, and the choice came back on resume
  - recap ticks (Document, Delay and Direct after film, direct and delay)
  - Continue to the closing screen
  - one full run with `prefers-reduced-motion: reduce`

  There were no console errors.
- **The UI harness.** The recap at 1280 px and about 500 px wide (headless Chrome's minimum), with no horizontal scroll. The Part 2 outcome screen, with "See full details" opened by keyboard: it holds what happened, the 5 Ds, in context, in numbers, a real case, and the model.
- **Voice was off** (no ElevenLabs key), so every line played as a subtitle with the mimed mouth.

**Not tested:**

- **A real Part 2 session posting its replay choices.** `?skip` creates no session, so nothing is posted. The SQL, the cleaning and the aggregation are covered by unit tests and by the local D1 check.
- **"Leave the simulation" from the replay's pause dialog.** That path is unchanged from cards-and-replay, but I didn't re-run it this time.

## What to test by hand

1. **Full run, with voice if possible:** Part 1 and its debrief (should be exactly as on main), Part 2, the outcome screen, the replay, the recap, the closing screen.
2. **Outcome screen.** "Learn how to help" starts the replay. "Walk it again" replays Part 2. "See full details" opens main's debrief intact.
3. **Every choice and rewind** at all five moments. Leaving from the pause dialog during the replay should go straight to the closing screen.
4. **Framing.**
   - The choice panel is a side column with the pair in the rest of the frame (see Follow-up changes). Moments 1 to 4 were checked at 1280×720. Moment 5 at 1280×720, and all moments at 1440×900, still need a look; `?moment=m4` or `?moment=m5` jumps straight there in dev.
   - The camera positions are in `stage()` and `movePlayer()` in [guidedWalkHome.ts](src/scenarios/guidedWalkHome.ts). The panel width is in both `.oit-choice--side` (hud.css) and `SIDE_PANEL` (guidedWalkHome.ts); change them together.
   - The spotlight radius is `r: 0.17` in `freezeScene()`.
5. **Screen reader.** Choices, the caption, the "You think:" lines and the strip (concept, sentence, stats, credit) read in a sensible order. The recap ticks are announced.
6. **Logging.** After a full run with `STATS_CODE` set and the remote migration applied, `/api/stats` should show the Part 2 tactics, the outcome and five first choices.
7. **Tone.** Read every strip, and the three claims under "Concept attributions to verify", once with the facilitator's eye.

## Follow-up changes

Each was its own commit; build and tests passed after each.

1. **Moment 4 insult strip** now reads "Insults turn it into a fight between you and him, with her still stuck in the middle."
2. **The 86% stat moved.** Moment 1's Noticing strip keeps its sentence with no stat. `loreal_dontknow_86` is now on moment 2's "Wait and see if the clerk does something" strip.
3. **Both people stay in view while frozen.**
   - **Side column.** On screens 900 px wide or more, the choice panel is a column on the side away from the pair. If they would still overlap it, the camera turns, while frozen, just far enough to put them in the rest of the frame. The turn eases, or cuts under reduced motion. Narrower screens keep the bottom panel.
   - **Moment 1.** The camera starts out toward the curb. Before, he was lined up directly behind her, and from the building side the stoops hid him.
   - **Moment 4.** He stands slightly diagonal to her, still in her way, so they're face to face rather than one behind the other.
   - **Checked:** at 1280×720 for moments 1 to 4, both people are on screen, clear of the panel, and not covering each other. Moment 5 and the 1440×900 size were not checked in the browser. At 1440×900 the panel is a smaller share of the width (480 of 1440 px against 480 of 1280), so there is more room, but please look.
   - **The strip** at the bottom still covers their legs when it holds two stats (moment 2's best choice). Both are visible from the waist up.
   - **Dev shortcut:** `?skip=intro,part1,part2&moment=m4` (or `m5`) starts the replay at that moment.
4. **Migration renamed** to `0003_teaching_replay.sql`, so it doesn't share a number with cards-v2's `0002_card_answers.sql`. It had only been applied locally. I removed its record and its two columns from the local D1, then re-applied it; it applied cleanly as 0003. The remote database still needs it:

   ```bash
   npx wrangler d1 migrations apply oneinthree-stats --remote
   ```

## Not committed

`REPO_REPORT.md` and `BASELINE_CHECK.md` are still untracked, as before.
