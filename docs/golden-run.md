# Golden run: Part 1, "Her walk home"

One reference playthrough to build and polish against, instead of chasing every branch. When this run plays exactly as written, with the right words, levels, movement and timing, we widen out.

**Play it:** open the game with `?run=golden` (for example `http://localhost:5173/?run=golden`). His levels are held to this script; his words are still written live from the conversation. The normal game is unchanged.

**Check it:** `node scripts/eval-dialogue.mjs golden` replays both endings against the dev server and flags any beat that is off-script (`--out docs/research/golden-run-check.md` saves the transcript). Logic: `worker/model/golden.ts`, tests in `worker/model/golden.test.ts`.

How to read it:

- **She says** is what the player says (hold Space). Wording can vary; the **read as** column is what the reader must take it as.
- **His level** is the 0–6 ladder (meter top right). The arrow is the change this beat should produce.
- **He says** is an example. The AI writes the real line, but it must do what the **must** column says.
- **Why** is the rule in the model and the research behind it. Magnitudes are assumptions tuned to published per-incident rates; directions come from the evidence file (`docs/research/evidence.md`).

Levels: 0 Calm · 1 Interested · 2 Pushy · 3 Offended · 4 Angry · 5 Intimidating · 6 Threatening (scene ends).

---

## Act 1: the walk (scripted, no conversation)

| Beat | What happens | Her thought |
|---|---|---|
| 1 | 11:42 PM. Four blocks from home. She walks under the streetlights. | *Long day. Just get home.* |
| 2 | Keys in hand. | *Keys in my hand. Like always.* |
| 3 | A trash can crashes in the alley; a cat. Fear spikes and drains. | *Jesus!* … *It's a cat. It's just a cat. Breathe.* |
| 4 | A man is standing under the scaffolding ahead. The meter is not shown yet. | *There's a guy up ahead. Under the scaffolding.* |

## Act 2: the encounter

| # | She says | Read as | His level | He says (example) | He must | Body | Why |
|---|---|---|---|---|---|---|---|
| 1 | *(walks toward him)* | n/a | **1 Interested** | "Hey, beautiful. Where you headed this late?" | Call out as if it were a compliment. | Steps out from the scaffolding toward her. Smile. | Most catcallers say they want a smile or a chat (85% / 78%). *psypost_walton_2021* |
| 2 | "Hi." | friendly | 1 → **1** | "Hi, she says. What's your name, sweetheart?" | Take it as encouragement; ask for more. Never leave or turn hostile. | Falls in beside her, about 1.5 m. | A friendly answer prolongs it; he almost never walks off and never jumps. *psypost_walton_2021, ssh_2014* |
| 3 | "I'm just heading home." | friendly | 1 → **1** | "Home, huh? Lemme walk with you, it's late." | Use her answer; push for the next thing (walking with her). Not ask where she's going again. | Keeps pace beside her. | "Wants more": each exchange he asks for a bit more (name, where, walk with her, number). *ssh_2014* (being pleasant leads to more approaches) |
| 4 | "No thanks, I'm fine." | polite no | 1 → **2 Pushy** | "Relax, I'm just being friendly. One minute." | React to the no with irritation, then keep going. Face annoyed, not smiling. | Closes to about 1.2 m. | Ignoring a no is pushy by definition (refusal floor). 60% of young women who said they weren't interested were contacted again. *pew_2020, ssh_assertive* |
| 5 | *(says nothing, walks faster)* | ignoring him | 2 → **2** | "What, you can't talk now? I'm being nice." | Notice the silence and the hurry; take it personally. | Speeds up to stay with her. | Being ignored sometimes angers; much harassment continues past silence. *ssh_2014, nbc_10hours_2014* |
| 6 | "Please leave me alone." | firm no | 2 → **3 Offended** | "Wow. I give you a compliment and you treat me like a creep?" | Take the no as an insult; guilt-trip her. | Stays beside her, leaning in. Contempt. | About a third of men reacted aggressively to a clear refusal in the lab; rejected men show more hostility. *woerner_2018, andrighetto_2019* |
| 7 | "I said leave me alone." | firm no | 3 → **4 Angry** | "Who the hell do you think you are? Stuck-up bitch." | Raised voice, crude name. No threats of violence, nothing sexual. | Steps closer; voice shouted. | Once he feels slighted he is slower to calm and less likely to just walk off. *stratmoen_2018_pt* |

Her thought around here: *Nobody else is out here.* The meter is red-orange. **The player now chooses an ending.**

---

## Ending A: she got away (the shop)

| # | She does | Read as | His level | He says (example) | Body | Why |
|---|---|---|---|---|---|---|
| A1 | Crosses toward the lit shop. | moving away | 4 → **5 Intimidating** | "Don't walk away from me when I'm talking to you." | Follows close behind, then cuts in front of her once. She freezes for half a second. | Using his body to affect her movement: 43% of reported incidents (upper bound). *hutson_krueger_2018* |
| A2 | Steps around him and goes into the shop. Shop bell. | went to others | 5 → **he waits outside** | n/a | Walks up to the door and stands on the sidewalk outside, looking in. | Reaching other people is the most reliable way these end, though some men wait outside first. *ssh_2014, fleetwood_2019* |
| A3 | Shopkeeper looks up, worried. | n/a | n/a | Shopkeeper: "You okay, miss? That guy bothering you? Stay as long as you need." | He is still standing outside. (If he had already left, the shopkeeper just says "Evening. You alright, miss? Cold one tonight.") | |
| A4 | Her thoughts. | n/a | n/a | *Just stay in here. Wait until he's gone.* … *How long do I wait? Is he still out there?* | | |
| A5 | About ten seconds in. | n/a | he leaves | (through the door, sour) "Whatever. Not worth it." | Turns and walks off. Her thought: *He's going. He's actually going.* Fade out. | |

Then the debrief: a timeline of what she said and how his level moved, with the sources.

## Ending B: cut to black

| # | She says | Read as | His level | He says (example) | Body | Why |
|---|---|---|---|---|---|---|
| B1 | "Get away from me, you creep." | insult | 4 → **5 Intimidating** | (low) "Say that again. Go on, say it." | Steps in very close and drops his voice. Blocks her way. | Swearing at him is the response most likely to provoke anger. *ssh_assertive, stratmoen_2018_pt* |
| B2 | Tries to push past him. | pushed past | 5 → **6 Threatening** | (shouted) "Hey! I'm not done talking to you." | Reaches for her arm. Nothing is shown. | Physical escalation is rare (about 1–3% of realistic runs, under 10% even when she keeps insulting him) and is never caused by one choice. *base.physical_escalation_per_run* |
| B3 | n/a | n/a | n/a | Flinch, a hard cut to silence and black. Card: **"We stop here. What happens next is not shown. For many women, it is not a simulation."** | | |

Then the debrief. Part 1's debrief does not grade her: it explains what he did and why, not what she should have done.

---

## What must be true on every beat

- He **answers what she just said**, uses what she told him (her name, where she's going), and never asks the same thing twice.
- After any **no**, his line reacts to the no and his face shows he minded; he does not carry on as if she said nothing.
- **Movement is continuous**: beside her while he talks (levels 0–3), behind or in front of her at 4–5. He never stands still while she walks off.
- The **meter** changes exactly when his tone changes, never more than +2 per beat.
- **Pre-recorded lines only play when they fit** (e.g. the shopkeeper only mentions him if he is still there).
- Nothing graphic. Crude language only at level 4+. No threats of violence, nothing sexual, no slurs.

## Decided (2026-11-15)

1. **Golden mode** exists: `?run=golden` holds his levels to this script while the AI writes the words.
2. He **opens at level 1** (a "compliment" call-out).
3. At the shop he **waits outside for a moment** before leaving (A2 to A5). This also applies in the normal game.
4. The climb from friendly to angry takes **six exchanges**, as written.
