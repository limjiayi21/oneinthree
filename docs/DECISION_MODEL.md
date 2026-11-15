# The decision model

How the man in "One in Three" decides what to do next, where every number comes from, and what is and is not evidence.

Code: `worker/model/` (pure TypeScript, no network, seeded). Tests and Monte Carlo: `worker/model/model.test.ts` (`npm test`). Simulation results: `docs/research/model-simulation.md`. Evidence: `content/evidence.json` and `docs/research/evidence.md`.

## The honest summary

- **No study measures how a street harasser reacts to a particular response.** Every "she did X, so he did Y" probability in this model is therefore an assumption. The research supplies a point value and a range for most of them, and labels them as assumptions itself; the model keeps those labels and the tests hold the model inside those ranges. Holding a guess inside a range does not make it true.
- What the research does support is used as structure rather than as numbers: most men who do this want a friendly reaction; a hostile minority exists; insults are the response most likely to draw hostility; friendly answers prolong contact; reaching other people is the most reliable way out; physical escalation is rare; there is no right response.
- **Most of the variance is his disposition, not her choice.** It is drawn once, before the scene starts. What the trainee says shifts the odds only modestly, and no bad outcome is ever the scripted consequence of a choice.
- His behaviour is sampled, never scripted. The same choices on another night can end differently, which is the point the debrief makes.

## One turn

```
her words (mic) --STT--> text
text + scene  --Clef--> READ   distribution over how she responded, plus tone / insult / police,
                               plus Clef's own view of his most likely reaction
state + READ  --------> DECIDE this model: distribution over his next stance -> sample
stance + her words --LLM--> WRITE  his line and her thought (words only; the model decides nothing)
line --TTS--> VOICE
```

The language model never chooses what he does. It is handed a stance that has already been sampled and writes one line in that stance. Clef never chooses either: it produces probabilities that the model blends into its own.

## Part 1: her walk home

### State

`WomanState` (worker/model/woman.ts): his disposition, his current stance, how many decisions and exchanges there have been, how many clear refusals and insults, his accumulated frustration (0..1), whether he has followed or blocked, how long he has been hostile, when the encounter began, her fear and his tension.

### Stances

`idle -> opening -> { persist | guilt | follow | block | hostile | intimidate | back_off } -> ... -> gone`, and rarely `escalate`.

He always opens with a call-out. `back_off` is a parting remark; on the next beat he is `gone` and walks away (no outcome is emitted: the client lets her finish her walk). `escalate` ends the scene at once; the client cuts to black and nothing is shown or described.

### Step 1: disposition (drawn once per session)

| Disposition | Share | From |
|---|---|---|
| volatile: set out to unsettle her | `man.disposition.hostile_from_start` | evidence.json (inferred) |
| persistent: feels entitled to her attention | `man.disposition.persistent_entitled` | evidence.json (assumption) |
| mild: mainly wants a friendly reaction | the remainder | consistent with `man.disposition.wants_friendly_response` (data) |

Each disposition multiplies the odds of the four reaction classes (`model.disposition.<d>.<class>`). Those multipliers are assumptions, chosen so that the three dispositions together reproduce the researched reaction shares (see "first response" below).

### Step 2: how she responded

Speech is read by Clef into a probability distribution over `WomanStrategy`. Everything else maps directly, without a model call:

| Event | Read as |
|---|---|
| `silence`, `sped_up`, `crossed_street`, `backed_away`, `stopped` | ignore (the physical context still matters: see step 4) |
| `pushed_past` | firm_boundary |
| `entered_shop` | seek_help, and the scene ends with `took_refuge` |
| `reached_home` | ends the scene: `reached_home_alone` if he has gone, is leaving, or is more than 14 m behind; otherwise `reached_home_followed` |

### Step 3: reaction class

For each response the research gives shares for up to four reaction classes: **gives up**, **keeps going**, **verbal hostility**, **menace**. `ROW_KEYS` in woman.ts maps every cell to a parameter key; cells the research leaves open are filled by `model.response.*` parameters (assumptions) and each row is re-normalised.

The row actually used is the mixture of rows weighted by Clef's distribution, so an ambiguous sentence ("get the f--- away from me": boundary or insult?) is treated as ambiguous. Then the odds are multiplied by:

| Factor | Effect | Parameters |
|---|---|---|
| disposition | see step 1 | `model.disposition.*` |
| the demo persona | he is less likely to give up after her first and second response: "pushy" | `model.scenario.pushiness_*` (the founders' brief, not evidence) |
| frustration | accumulated rejection raises the odds of hostility and menace | `model.dynamics.frustration_gain`, `model.dynamics.frustration.<response>` |
| fatigue | giving up becomes more likely with time, growing with the square of time | `model.dynamics.fatigue_gain`, `model.session.soft_seconds` |
| inertia | once hostile he rarely returns to charm and more often leaves with an insult | `model.dynamics.hostile_inertia_*` |
| geometry | menace needs him close; her crossing the street nudges him toward giving up | `model.dynamics.far_factor`, `model.dynamics.early_intimidation`, `model.dynamics.distance_back_off` |

**First response check.** With nothing built up, the disposition-weighted reaction shares for each response are computed exactly (no sampling) and asserted to lie inside every researched range. The table is in `docs/research/model-simulation.md`.

### Step 4: what "keeps going" looks like

The keeps-going class is split between talking (`persist`), turning it back on her (`guilt`), trailing her (`follow`) and stepping into her path (`block`):

- follow: the researched share of incidents that involve following (`base.incident_involves_following`, data), boosted by `model.persist.moving_follow_boost` when she is walking away, hurrying or crossing;
- block: `model.persist.share_block`, bounded above by the researched share of incidents with path interference minus following; never twice in a row, at most `model.persist.block_max` times, never from across the street;
- guilt: `model.persist.share_guilt`, more likely straight after a polite or firm refusal;
- talking: the rest, more likely after a friendly answer.

### Step 5: physical escalation

Possible only when **all** of these hold: he was already hostile or menacing before this turn; this is at least decision number `model.escalation.min_turn` (his opening is 1, so never in the first exchanges); and, at full odds, only when he is within a few metres. The per-turn chance is `model.escalation.hazard`, scaled by disposition, by how many times she has insulted him (`model.escalation.insult_gain`: direction supported by guidance and honour-belief research, size a guess), and capped at `model.escalation.cap`.

It can follow silence or a polite no as well as an insult, because it comes from his temper. The Monte Carlo test holds the per-session rate for a realistic mix of responses inside the range of `base.physical_escalation_per_run`.

### Step 6: bounds

After `model.session.max_seconds` of encounter he gives up whatever else is happening. The tests check that every simulated session ends, including one in which she never moves or speaks.

### Step 7: what comes out

`ManDecision` (stance, action, emotion, intensity, proximity), her `fear`, his `tension`, whether he speaks and how (call-out, normal, low, shout), and a `Rationale`: one plain sentence, with the basis and sources of the parameter that mattered most. A rationale is only as strong as its weakest input: if any parameter behind it is an assumption, the rationale is labelled an assumption.

## The blend with Clef

One Clef request per spoken turn carries five typed questions (`worker/read.ts`): the response strategy (choice), tone (score), insult (yes/no), police or attention (yes/no), and **his most likely immediate reaction** (choice over the seven stances).

The last one is blended with the evidence-based prior:

```
posterior(stance)  ∝  prior(stance) × likelihood(stance) ^ w        w = model.blend.clef_weight
```

with three safeguards:

1. **Baseline correction.** Clef leans the same way whatever she says (it favours guilt-tripping). Its answer is divided by its own average answer over a set of test utterances, so only what her actual words changed is used.
2. **Bounds from the evidence.** After blending, each reaction class may only have moved within the band its parameter's researched range allows (for example a share with value 0.30 and range 0.15 to 0.40 may be multiplied by at most 1.33). Classes without a researched range may move by `model.blend.default_band`.
3. **Escalation is not Clef's call.** The probability of physical escalation is fixed by the prior and untouched by the blend.

So her exact words matter (calling him pathetic and saying "no thank you" are not the same event, even if both are refusals) but only inside the bounds the evidence sets, and less than his disposition does.

Two Clef models answer each read in parallel: plain `clef` is used if it answers within 420 ms, otherwise `clef-flash`, which has nearly always finished by then. If neither answers, a keyword heuristic reads her words and the turn says so (`fallbackRead` in `done.ms`).

## Part 2: the bystander

`worker/model/bystander.ts`. The client plays a scripted exchange until the model emits its first decision; from then on the model drives both the man and the woman.

Each intervention is one roll between three results:

| Result | Meaning |
|---|---|
| stops | he backs off with a face-saving remark, and leaves on the next beat |
| turns | he turns on the bystander (`turn_on_bystander`) |
| continues | he brushes it off; his attention stays on her |

The odds per tactic:

| Tactic | How the player triggers it | P(stops) | P(turns on bystander) |
|---|---|---|---|
| Distract | talks to her as if he knows her; asks either of them for directions or the time | `bystander.distract.p_harassment_stops` | `bystander.distract.p_hostility_toward_bystander` |
| Direct | tells him to stop; asks her in front of him whether she is okay | `bystander.direct.p_harassment_stops` | `bystander.direct.p_hostility_toward_bystander` |
| Aggressive (a risky Direct) | threatens or insults him | `model.bystander.aggressive.p_harassment_stops` | `model.bystander.aggressive.p_hostility_toward_bystander` |
| Delegate | asks the shopkeeper (speech to the clerk, or `asked_clerk`) | `bystander.delegate.p_harassment_stops` | `model.bystander.delegate.p_hostility_toward_bystander` |
| Document | films, and he notices (he may not: `model.bystander.document.p_notice_*`) | `bystander.document.p_harassment_stops` | `model.bystander.document.p_hostility_toward_bystander` |
| Stood between | steps physically between them | `bystander.any_action.p_harassment_stops` | `model.bystander.physical.p_hostility_toward_bystander` |
| Delay | checks on her after he has gone | does not change his behaviour; reduces her distress (`bystander.delay.target_distress_reduction`) | none |

A second or later intervention is slightly more likely to stop it (`model.bystander.repeat_boost`). Clef's reading of the bystander's exact words is blended in exactly as above (stops / turns / continues, baseline-corrected, held inside the researched ranges).

What follows each result:

- **stops**: he leaves on the next beat. The player then has one chance to speak to her (Delay); the scene ends on her reply or on the first silence, with `intervened_he_left`.
- **turns**: on each later beat he either blusters and leaves (`model.bystander.turned.p_back_off`), keeps squaring up, or, never before his third beat since the model took over, becomes physical (`model.bystander.turned.p_escalates`, or `..._if_provoked` when the bystander keeps threatening him): `intervened_escalated`. While his attention is on the bystander she may slip away (`model.bystander.she_slips_away`); if she has, the scene ends with `intervened_she_safe`.
- **continues**: she takes the opening the interruption gave her and gets away on the next beat (`intervened_she_safe`); he shouts after her. With the shopkeeper at his door there is a second warning first (`model.bystander.clerk_second_warning.p_harassment_stops`).
- **nobody intervenes** (`scene_timeout`): she gets away by herself, or, with probability `base.physical_escalation_per_run`, it escalates.

`approached`, `walked_past`, `filming_stop`, `left_scene` and unnoticed filming are recorded for the debrief and answered with just `done`: the scripted scene carries on.

## What is data, what is inferred, what is assumption

Labels come straight from `content/evidence.json` for parameters read from it. Every `model.*` parameter is this model's own and is labelled an assumption; a test fails if one ever claims otherwise, and another fails if any response-to-reaction probability is labelled data.

- **data**: a cited figure, used as measured (for example the share of incidents that involve following, or the share of harassers who hoped for a friendly reaction).
- **inferred**: derived from cited figures collected in a different setting (for example hostility after a firm refusal, from a lab dating study).
- **assumption**: no measurement exists; a conservative placeholder. Where a rationale says the *direction* is evidence-based, only the ordering should be treated as supported.

The full table below is generated from the code and `content/evidence.json` by `npm test`, so it cannot drift from what the Worker actually uses.

<!-- PARAMS:START -->
192 parameters: 3 data, 3 inferred, 186 assumption.

Read from content/evidence.json (31 of its 42 calibration parameters are used by the model): 3 data, 3 inferred, 25 assumption. The model's own knobs (161): all assumption.

### Parameters read from content/evidence.json

| Key | Value | Range | Basis | Rationale (from the research) | Sources |
|---|---|---|---|---|---|
| `man.disposition.wants_friendly_response` | 0.85 | 0.73 to 0.85 | data | Among self-reported catcallers, 85% hoped for a smile, 81% for flirting back, 78% for a conversation and 73% that she would feel flattered. The sample was mostly mild, infrequent catcallers. | psypost_walton_2021 |
| `man.disposition.hostile_from_start` | 0.08 | 0.05 to 0.12 | inferred | Among self-reported catcallers, 5% hoped for fear or anger, 9% hoped she would feel intimidated, 12% shocked, and 7% endorsed punishing women. The surveyed men were at the mild end, so the true share among persistent night-time harassers may be higher. | psypost_walton_2021, walton_pedersen_2021 |
| `man.disposition.persistent_entitled` | 0.25 | 0.15 to 0.35 | assumption | No data on the share of harassers who keep going after a clear no. Guided loosely by the finding that catcallers score higher on hostile sexism and tolerance of harassment, and by online-dating data showing that persistence after a refusal is a common experience for young women. | walton_pedersen_2021, pew_2020 |
| `base.physical_escalation_per_run` | 0.03 | 0 to 0.05 | assumption | No per-encounter denominator exists anywhere. Set deliberately below the 6-12% groping or assault share seen in self-selected incident archives. Physical escalation should stay rare and must never be scripted as the consequence of a particular trainee choice. | bastomski_2011, cornell_nyc_2012 |
| `base.incident_involves_following` | 0.18 | 0.14 to 0.2 | data | Share of reported incidents involving stalking or following: 18.2% (NYC, n=99); 14% followed or persistently stared at (London). Lifetime prevalence among US women is 20% (2014) to 34% (2018). | bastomski_2011, fleetwood_2019, ssh_2014, ssh_2018 |
| `base.incident_involves_path_interference` | 0.43 | 0.43 to 0.43 | data | 42.9% of 308 New York and Chicago Hollaback! posts described the harasser using his body or a vehicle to affect the woman's movement (blocking, grabbing or following). Self-selected posts, so treat as an upper bound for everyday encounters. | hutson_krueger_2018 |
| `base.encounter_stays_verbal_only` | 0.7 | 0.55 to 0.85 | inferred | No source reports this directly. Reported-incident archives put physical contact at 6-29% and following at 14-18% with unknown overlap, which implies roughly 55-70% non-contact, non-following incidents; archives over-sample severe incidents and far more US women report verbal harassment (57%) than touching (23%) or following (20%), so the everyday rate is probably higher. | bastomski_2011, cornell_nyc_2012, fleetwood_2019, ssh_2014 |
| `response.ignore.p_back_off` | 0.5 | 0.35 to 0.65 | assumption | No rates exist. Ignoring or walking away was the most common response in NYC reports (41%), most reported incidents are verbal only, and Right To Be notes that much harassment happens in passing. | bastomski_2011, rtb_5ds |
| `response.ignore.p_persist_or_follow` | 0.35 | 0.2 to 0.5 | assumption | No rates exist. A woman who stayed silent for ten hours in Manhattan still drew over 100 remarks, and focus-group accounts describe men following after being ignored. The scenario's man is persistent by design, so this is set higher than the 14-18% following rate in incident archives. | nbc_10hours_2014, ssh_2014, bastomski_2011 |
| `response.ignore.p_verbal_hostility` | 0.15 | 0.05 to 0.3 | assumption | No rates exist. Focus-group accounts show ignoring sometimes triggers anger and insults, but there is no evidence on how often, or on whether it is more or less common than after an explicit refusal. | ssh_2014 |
| `response.polite_deflection.p_persist` | 0.5 | 0.35 to 0.65 | assumption | No rates exist. Guidance says apologies and excuses invite negotiation, and most catcallers are hoping for conversation, so a soft answer is assumed to prolong the exchange more often than a firm one. | ssh_assertive, psypost_walton_2021 |
| `response.polite_deflection.p_verbal_hostility` | 0.1 | 0.05 to 0.25 | assumption | No rates exist. Focus-group accounts include a polite refusal met with belligerence, so this cannot be zero; set below the firm-boundary value because a soft refusal poses less of a public status threat. | ssh_2014, stratmoen_2018_pt |
| `response.firm_boundary.p_back_off` | 0.45 | 0.3 to 0.6 | assumption | No rates exist. Narrative studies describe men walking away, going quiet or apologising after women spoke back, alongside cases with no effect; practitioner guidance recommends a short, calm, firm statement. | fleetwood_2019, ssh_assertive |
| `response.firm_boundary.p_verbal_hostility` | 0.3 | 0.15 to 0.4 | inferred | In a lab dating simulation, 25 of 77 men (32%) reacted aggressively to a clear sexual refusal. Different setting (college men, simulated date), so applied with a wide range. | woerner_2018, andrighetto_2019 |
| `response.hostile_insult.p_verbal_hostility` | 0.5 | 0.35 to 0.65 | assumption | Magnitude is a guess; the ordering is evidence-based. Practitioner guidance identifies swearing or losing one's temper as the reaction most likely to provoke anger and violence, and honor-belief research links perceived insult to endorsement of aggression. Keep this the highest hostility value. | ssh_assertive, stratmoen_2018_pt |
| `response.hostile_insult.p_intimidation` | 0.15 | 0.05 to 0.25 | assumption | No rates exist. Narrative research describes violent retaliation as very rare; this covers stepping closer, threats or blocking rather than physical contact. | fleetwood_2019 |
| `response.lie_or_excuse.p_persist` | 0.45 | 0.3 to 0.6 | assumption | No rates exist. Research on the boyfriend excuse measures perceptions, not harasser behaviour; guidance warns that excuses invite argument (for example questioning the excuse). | stratmoen_2020, ssh_assertive |
| `response.lie_or_excuse.p_verbal_hostility` | 0.1 | 0.05 to 0.2 | assumption | No rates exist. Women report using excuses to soften rejection and avoid retaliation, and men with strong honor beliefs see deception as an added honor threat if detected. | stratmoen_2020 |
| `response.threat_police_or_attention.p_back_off` | 0.55 | 0.4 to 0.7 | assumption | No rates exist. Guidance notes that visibly recording details can scare a harasser into stopping and that harassers rely on going unnoticed; group-harassment research points to anonymity as a motive. | ssh_assertive, wesselmann_kelly_2010, pbs_2014 |
| `response.threat_police_or_attention.p_verbal_hostility` | 0.2 | 0.1 to 0.35 | assumption | No rates exist. A public threat is a status challenge, so hostility is assumed to be somewhat more likely than after ignoring and less likely than after an insult. | stratmoen_2018_pt |
| `response.seek_refuge.p_back_off` | 0.75 | 0.6 to 0.9 | assumption | No rates exist. Focus-group accounts describe shops and venue staff ending episodes of following, and harassers overwhelmingly target women who are alone (78% of NYC incidents). | ssh_2014, bastomski_2011 |
| `response.engage_friendly.p_persist` | 0.8 | 0.65 to 0.9 | assumption | Magnitude is a guess; the direction is evidence-based. Most catcallers hope for a smile or conversation, and women in focus groups report that being pleasant leads to more approaches. | psypost_walton_2021, ssh_2014 |
| `bystander.any_action.p_harassment_stops` | 0.65 | 0.5 to 0.8 | assumption | Magnitude is a guess; the direction is evidence-based. The NYC analysis found harassment was more likely to stop when a bystander confronted the harasser but gives no number, and no reported NYC incident involved a woman accompanied by a man. | cornell_nyc_2012, bastomski_2011 |
| `bystander.distract.p_harassment_stops` | 0.65 | 0.5 to 0.8 | assumption | No outcome data by tactic. Joining the woman removes the condition under which most incidents occur (woman alone) without challenging the man. | rtb_5ds, bastomski_2011 |
| `bystander.distract.p_hostility_toward_bystander` | 0.05 | 0 to 0.1 | assumption | No outcome data. Right To Be describes Distract as an option when open confrontation might escalate. | rtb_5ds |
| `bystander.direct.p_harassment_stops` | 0.65 | 0.5 to 0.8 | assumption | Magnitude is a guess; the direction is evidence-based. Confrontation by a bystander made harassment more likely to stop in NYC incidents (no number given). | cornell_nyc_2012 |
| `bystander.direct.p_hostility_toward_bystander` | 0.25 | 0.1 to 0.4 | assumption | No rates exist. Right To Be warns Direct can redirect abuse to the bystander or escalate, and real cases of bystanders being injured exist. Should be clearly higher than for Distract. | rtb_5ds, wins_bronx_2022 |
| `bystander.delegate.p_harassment_stops` | 0.55 | 0.4 to 0.7 | assumption | No outcome data. Depends on whether the delegate (shop worker, transit staff, another passer-by) acts; group presence increases the chance that someone intervenes. | rtb_5ds, philpot_2020 |
| `bystander.document.p_harassment_stops` | 0.15 | 0.05 to 0.3 | assumption | No outcome data. Right To Be says documenting alone, while nobody is helping, can add to the target's distress; its value is mainly after the fact. | rtb_5ds |
| `bystander.delay.target_distress_reduction` | 0.3 | 0.15 to 0.45 | assumption | Magnitude is a guess; the direction is evidence-based. Even a supportive look or remark improved how targets felt, and Right To Be says checking in afterwards reduces harm. Delay does not change the harasser's behaviour. | cornell_nyc_2012, rtb_5ds |
| `bystander.nothing.target_distress_increase` | 0.25 | 0.1 to 0.4 | assumption | Magnitude is a guess; the direction is evidence-based. Bystanders who were present and did nothing made targets feel worse. | cornell_nyc_2012 |

### The model's own parameters (all assumptions)

| Key | Value | Range | Basis | Rationale | Sources |
|---|---|---|---|---|---|
| `model.response.ignore.p_intimidation` | 0.02 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Kept very small: quiet menace after silence appears in accounts but is not the usual pattern. | ssh_2014 |
| `model.response.polite_deflection.p_back_off` | 0.38 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. The remainder of the row once the researched persistence and hostility shares are taken out. | ssh_assertive |
| `model.response.polite_deflection.p_intimidation` | 0.02 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Kept very small. |  |
| `model.response.firm_boundary.p_persist` | 0.23 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. The remainder of the row once the researched back-off and hostility shares are taken out. | fleetwood_2019 |
| `model.response.firm_boundary.p_intimidation` | 0.02 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Kept very small. |  |
| `model.response.hostile_insult.p_back_off` | 0.2 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Part of the remainder of the row: narrative research describes men walking off or going quiet even after being shouted at. | fleetwood_2019 |
| `model.response.hostile_insult.p_persist` | 0.15 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Part of the remainder of the row. |  |
| `model.response.lie_or_excuse.p_back_off` | 0.43 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. The remainder of the row once the researched persistence and hostility shares are taken out. | stratmoen_2020 |
| `model.response.lie_or_excuse.p_intimidation` | 0.02 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Kept very small. |  |
| `model.response.threat_police_or_attention.p_persist` | 0.22 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. The remainder of the row once the researched back-off and hostility shares are taken out. |  |
| `model.response.threat_police_or_attention.p_intimidation` | 0.03 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Kept very small: a public threat is a status challenge, so slightly above the other calm responses. | stratmoen_2018_pt |
| `model.response.seek_refuge.p_persist` | 0.15 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Part of the remainder of the row; accounts include men who wait outside. | ssh_2014 |
| `model.response.seek_refuge.p_verbal_hostility` | 0.08 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Part of the remainder of the row. |  |
| `model.response.seek_refuge.p_intimidation` | 0.02 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Kept very small. |  |
| `model.response.engage_friendly.p_back_off` | 0.14 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Part of the remainder of the row: a friendly answer rarely ends the contact. | psypost_walton_2021 |
| `model.response.engage_friendly.p_verbal_hostility` | 0.05 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Kept small: he is getting the reaction he hoped for. | psypost_walton_2021 |
| `model.response.engage_friendly.p_intimidation` | 0.01 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Kept very small. |  |
| `model.response.plead.p_back_off` | 0.4 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. The research has no entry for pleading; treated like a soft refusal. |  |
| `model.response.plead.p_persist` | 0.45 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. The research has no entry for pleading; treated like a soft refusal. |  |
| `model.response.plead.p_verbal_hostility` | 0.1 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. The research has no entry for pleading; treated like a soft refusal. |  |
| `model.response.plead.p_intimidation` | 0.05 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Slightly above other soft responses because a minority of men who do this say they want her to feel intimidated. | psypost_walton_2021 |
| `model.response.unclear.p_back_off` | 0.42 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Used when her words could not be read; sits between silence and a polite refusal. |  |
| `model.response.unclear.p_persist` | 0.45 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Used when her words could not be read; sits between silence and a polite refusal. |  |
| `model.response.unclear.p_verbal_hostility` | 0.11 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Used when her words could not be read; sits between silence and a polite refusal. |  |
| `model.response.unclear.p_intimidation` | 0.02 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Kept very small. |  |
| `model.disposition.mild.back_off` | 1.5 |  | assumption | Odds multiplier. A man who mainly hopes for a friendly reaction is assumed to give up sooner than average. Magnitude is a guess; chosen so the mix of dispositions reproduces the researched reaction shares. | psypost_walton_2021 |
| `model.disposition.mild.persist` | 0.75 |  | assumption | Odds multiplier for the mild disposition. Magnitude is a guess. |  |
| `model.disposition.mild.hostile` | 0.55 |  | assumption | Odds multiplier for the mild disposition. Magnitude is a guess. |  |
| `model.disposition.mild.intimidate` | 0.4 |  | assumption | Odds multiplier for the mild disposition. Magnitude is a guess. |  |
| `model.disposition.persistent.back_off` | 0.45 |  | assumption | Odds multiplier. A man who feels entitled to her attention is assumed to give up far less readily. Magnitude is a guess. | walton_pedersen_2021, pew_2020 |
| `model.disposition.persistent.persist` | 1.6 |  | assumption | Odds multiplier for the persistent disposition. Magnitude is a guess. | walton_pedersen_2021, pew_2020 |
| `model.disposition.persistent.hostile` | 1 |  | assumption | Odds multiplier for the persistent disposition: no more or less hostile than average. A guess. |  |
| `model.disposition.persistent.intimidate` | 1 |  | assumption | Odds multiplier for the persistent disposition. A guess. |  |
| `model.disposition.volatile.back_off` | 0.45 |  | assumption | Odds multiplier. A man who set out to unsettle her is assumed not to walk away easily. Magnitude is a guess. | psypost_walton_2021, pbs_2014 |
| `model.disposition.volatile.persist` | 0.8 |  | assumption | Odds multiplier for the volatile disposition. A guess. |  |
| `model.disposition.volatile.hostile` | 2.2 |  | assumption | Odds multiplier. Lab work finds aggression after refusal concentrated in men with hostile views of the woman; the size of the effect on a street is unknown. | woerner_2018 |
| `model.disposition.volatile.intimidate` | 2.5 |  | assumption | Odds multiplier for the volatile disposition. Magnitude is a guess. | woerner_2018 |
| `model.scenario.pushiness_first_response` | 0.45 |  | assumption | Odds multiplier on giving up after her very first response. Not evidence: the founders' brief for this demo is a pushy man, so he usually tries at least once more. This is the knob an intensity setting would turn. |  |
| `model.scenario.pushiness_second_response` | 0.75 |  | assumption | Odds multiplier on giving up after her second response. Not evidence: part of the demo persona (see model.scenario.pushiness_first_response). |  |
| `model.dynamics.frustration_gain` | 1.2 |  | assumption | How strongly accumulated rejection raises the odds of hostility and intimidation. Direction from experiments in which rejected men became more hostile, with anger as the mechanism; magnitude is a guess. | andrighetto_2019, woerner_2018, blake_2018 |
| `model.dynamics.frustration.ignore` | 0.08 |  | assumption | Frustration added when she ignores him. Accounts describe anger at being ignored but give no rates; kept small. | ssh_2014 |
| `model.dynamics.frustration.polite_deflect` | 0.06 |  | assumption | Frustration added by a polite refusal. A guess; kept small. |  |
| `model.dynamics.frustration.firm_boundary` | 0.15 |  | assumption | Frustration added by a clear refusal. Direction from rejection experiments; magnitude is a guess. | woerner_2018, andrighetto_2019 |
| `model.dynamics.frustration.hostile` | 0.3 |  | assumption | Frustration added when she insults him. Kept the largest: guidance names swearing or losing your temper as the reaction most likely to be met with anger, and honour-belief research links perceived insult to aggression. | ssh_assertive, stratmoen_2018_pt |
| `model.dynamics.frustration.excuse` | 0.05 |  | assumption | Frustration added by an excuse. A guess; kept small because excuses are used to soften a refusal. | stratmoen_2020 |
| `model.dynamics.frustration.threaten_attention` | 0.16 |  | assumption | Frustration added when she threatens police or attention: a public status challenge. Magnitude is a guess. | stratmoen_2018_pt |
| `model.dynamics.frustration.seek_help` | 0.08 |  | assumption | Frustration added when she turns to other people. A guess. |  |
| `model.dynamics.frustration.engage` | -0.1 |  | assumption | A friendly answer lowers his frustration: it is the reaction most of these men say they want. | psypost_walton_2021 |
| `model.dynamics.frustration.plead` | 0 |  | assumption | Pleading neither adds to nor reduces his frustration. A guess. |  |
| `model.dynamics.frustration.unclear` | 0.04 |  | assumption | Frustration added when her words could not be read. A guess. |  |
| `model.dynamics.fatigue_gain` | 3 |  | assumption | How much more likely he is to give up as the encounter drags on (odds multiplier reached at model.session.soft_seconds, growing with the square of time). A design choice that bounds the session, not a finding. |  |
| `model.session.soft_seconds` | 150 |  | assumption | Length of encounter, in seconds, at which fatigue reaches full strength. A design choice. |  |
| `model.session.max_seconds` | 215 |  | assumption | Hard bound: after this many seconds of encounter he gives up whatever else is happening. A design choice so a session always ends. |  |
| `model.dynamics.hostile_inertia_back_off` | 1.5 |  | assumption | Once he has turned hostile he is more likely to leave with a parting insult than to start over. Reports describe harassers making a quick exit; the multiplier is a guess. | hutson_krueger_2018 |
| `model.dynamics.hostile_inertia_persist` | 0.45 |  | assumption | Once he has turned hostile he rarely goes back to charm. A guess. |  |
| `model.dynamics.hostile_inertia_hostile` | 1.2 |  | assumption | Once hostile, staying hostile is a little more likely. A guess. |  |
| `model.dynamics.early_intimidation` | 0.6 |  | assumption | Odds multiplier on quiet menace in the first two exchanges: he starts out believing he is being charming. A guess. | psypost_walton_2021 |
| `model.dynamics.reengage_after_insult` | 0.2 |  | assumption | Chance that he turns back if she insults him while he is already walking away. A guess; direction from guidance that insults are the likeliest trigger for anger. | ssh_assertive |
| `model.dynamics.distance_back_off` | 1.2 |  | assumption | Odds multiplier on giving up once she has put the street between them: pursuing now takes visible effort. A guess; harassers are described as relying on going unnoticed. | pbs_2014, wesselmann_kelly_2010 |
| `model.persist.share_block` | 0.14 |  | assumption | Share of "keeps going" turns in which he steps into her path. Bounded above by the researched share of incidents with path interference minus following; set lower because those archives over-represent severe incidents. | hutson_krueger_2018 |
| `model.persist.share_guilt` | 0.22 |  | assumption | Share of "keeps going" turns in which he turns it back on her ("I'm just being nice"). Guilt-tripping is named in practitioner guidance; the share is a guess. | ssh_assertive |
| `model.persist.moving_follow_boost` | 2 |  | assumption | He trails her more often when she walks off, hurries or crosses: staying in contact requires it. A guess. | ssh_2014 |
| `model.persist.refusal_guilt_boost` | 1.6 |  | assumption | Guilt-tripping is more likely straight after a polite or firm refusal. A guess. | ssh_assertive |
| `model.persist.engage_talk_boost` | 2 |  | assumption | After a friendly answer he mostly keeps talking rather than following or blocking. A guess. | psypost_walton_2021, ssh_2014 |
| `model.persist.evade_block_boost` | 1.3 |  | assumption | Stepping into her path is a little more likely when she is trying to get away. A guess. | hutson_krueger_2018 |
| `model.persist.block_max` | 2 |  | assumption | He blocks her path at most this many times in one encounter. A design bound. |  |
| `model.persist.follow_silent` | 0.3 |  | assumption | Chance that he says nothing on a turn where he is only trailing her. A guess. |  |
| `model.escalation.min_turn` | 4 |  | assumption | Earliest decision (his opening call-out is 1) at which he can become physical. A design rule: never in the first exchanges. |  |
| `model.escalation.hazard` | 0.034 |  | assumption | Chance per eligible turn (he is already hostile or menacing, close to her, past the minimum turn) that he becomes physical. Tuned by simulation so the per-session rate stays inside the range of base.physical_escalation_per_run; no per-encounter denominator exists. | bastomski_2011, cornell_nyc_2012 |
| `model.escalation.insult_gain` | 0.15 |  | assumption | Each time she has insulted him raises that chance by this fraction. Only the direction is supported (guidance and honour-belief research); the size is a guess. | ssh_assertive, stratmoen_2018_pt |
| `model.escalation.intimidate_factor` | 1.3 |  | assumption | Multiplier when he is already in close, quiet menace rather than shouting. A guess. |  |
| `model.escalation.volatile_factor` | 2 |  | assumption | Multiplier for the volatile disposition. Lab work points to a hostile minority; the size is a guess. | woerner_2018 |
| `model.escalation.mild_factor` | 0.35 |  | assumption | Multiplier for the mild disposition. A guess. |  |
| `model.dynamics.far_factor` | 0.2 |  | assumption | Odds multiplier on close-range moves (quiet menace, becoming physical) when she is more than a few metres away or across the street. A guess that follows from the geometry. |  |
| `model.escalation.cap` | 0.12 |  | assumption | Upper limit on the per-turn chance of physical escalation whatever has happened. A design bound that keeps it rare. |  |
| `model.ladder.engage.down` | 0.25 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. A friendly answer is what most catcallers say they want (a smile 85%, a conversation 78%), and women report that being pleasant leads to more approaches: he warms up or keeps going, he almost never walks off, and he never jumps two levels. | psypost_walton_2021, ssh_2014 |
| `model.ladder.engage.stay` | 0.62 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. A friendly answer is what most catcallers say they want (a smile 85%, a conversation 78%), and women report that being pleasant leads to more approaches: he warms up or keeps going, he almost never walks off, and he never jumps two levels. | psypost_walton_2021, ssh_2014 |
| `model.ladder.engage.up` | 0.1 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. A friendly answer is what most catcallers say they want (a smile 85%, a conversation 78%), and women report that being pleasant leads to more approaches: he warms up or keeps going, he almost never walks off, and he never jumps two levels. | psypost_walton_2021, ssh_2014 |
| `model.ladder.engage.jump` | 0 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. A friendly answer is what most catcallers say they want (a smile 85%, a conversation 78%), and women report that being pleasant leads to more approaches: he warms up or keeps going, he almost never walks off, and he never jumps two levels. | psypost_walton_2021, ssh_2014 |
| `model.ladder.engage.leave` | 0.03 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. A friendly answer is what most catcallers say they want (a smile 85%, a conversation 78%), and women report that being pleasant leads to more approaches: he warms up or keeps going, he almost never walks off, and he never jumps two levels. | psypost_walton_2021, ssh_2014 |
| `model.ladder.unclear.down` | 0.1 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. He could not tell what she meant: mostly he carries on as he was. |  |
| `model.ladder.unclear.stay` | 0.65 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. He could not tell what she meant: mostly he carries on as he was. |  |
| `model.ladder.unclear.up` | 0.2 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. He could not tell what she meant: mostly he carries on as he was. |  |
| `model.ladder.unclear.jump` | 0 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. He could not tell what she meant: mostly he carries on as he was. |  |
| `model.ladder.unclear.leave` | 0.05 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. He could not tell what she meant: mostly he carries on as he was. |  |
| `model.ladder.polite_deflect.down` | 0.07 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. A soft no rarely ends it: 60% of young women who said they were not interested were still contacted again (online), and practitioner guidance warns soft or apologetic refusals get argued with. Most often he stays or pushes a little harder. | pew_2020, ssh_assertive |
| `model.ladder.polite_deflect.stay` | 0.42 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. A soft no rarely ends it: 60% of young women who said they were not interested were still contacted again (online), and practitioner guidance warns soft or apologetic refusals get argued with. Most often he stays or pushes a little harder. | pew_2020, ssh_assertive |
| `model.ladder.polite_deflect.up` | 0.38 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. A soft no rarely ends it: 60% of young women who said they were not interested were still contacted again (online), and practitioner guidance warns soft or apologetic refusals get argued with. Most often he stays or pushes a little harder. | pew_2020, ssh_assertive |
| `model.ladder.polite_deflect.jump` | 0.07 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. A soft no rarely ends it: 60% of young women who said they were not interested were still contacted again (online), and practitioner guidance warns soft or apologetic refusals get argued with. Most often he stays or pushes a little harder. | pew_2020, ssh_assertive |
| `model.ladder.polite_deflect.leave` | 0.06 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. A soft no rarely ends it: 60% of young women who said they were not interested were still contacted again (online), and practitioner guidance warns soft or apologetic refusals get argued with. Most often he stays or pushes a little harder. | pew_2020, ssh_assertive |
| `model.ladder.firm_boundary.down` | 0.05 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. In the lab, 25 of 77 men (32%) reacted aggressively to a clear sexual refusal, and rejected men show more hostility toward the woman; narrative studies also describe men walking off or going quiet. So a firm no is the answer most likely to make him jump two levels short of an insult, and also one of the few that sometimes ends it. | woerner_2018, andrighetto_2019, fleetwood_2019 |
| `model.ladder.firm_boundary.stay` | 0.24 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. In the lab, 25 of 77 men (32%) reacted aggressively to a clear sexual refusal, and rejected men show more hostility toward the woman; narrative studies also describe men walking off or going quiet. So a firm no is the answer most likely to make him jump two levels short of an insult, and also one of the few that sometimes ends it. | woerner_2018, andrighetto_2019, fleetwood_2019 |
| `model.ladder.firm_boundary.up` | 0.38 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. In the lab, 25 of 77 men (32%) reacted aggressively to a clear sexual refusal, and rejected men show more hostility toward the woman; narrative studies also describe men walking off or going quiet. So a firm no is the answer most likely to make him jump two levels short of an insult, and also one of the few that sometimes ends it. | woerner_2018, andrighetto_2019, fleetwood_2019 |
| `model.ladder.firm_boundary.jump` | 0.25 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. In the lab, 25 of 77 men (32%) reacted aggressively to a clear sexual refusal, and rejected men show more hostility toward the woman; narrative studies also describe men walking off or going quiet. So a firm no is the answer most likely to make him jump two levels short of an insult, and also one of the few that sometimes ends it. | woerner_2018, andrighetto_2019, fleetwood_2019 |
| `model.ladder.firm_boundary.leave` | 0.08 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. In the lab, 25 of 77 men (32%) reacted aggressively to a clear sexual refusal, and rejected men show more hostility toward the woman; narrative studies also describe men walking off or going quiet. So a firm no is the answer most likely to make him jump two levels short of an insult, and also one of the few that sometimes ends it. | woerner_2018, andrighetto_2019, fleetwood_2019 |
| `model.ladder.ignore.down` | 0.03 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Ignoring or walking on is the most common response (41% of NYC reports) and much harassment happens in passing, but focus groups describe men reacting to being ignored with anger, insults or following: he keeps trying or slowly gets pushier. | bastomski_2011, ssh_2014, nbc_10hours_2014 |
| `model.ladder.ignore.stay` | 0.47 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Ignoring or walking on is the most common response (41% of NYC reports) and much harassment happens in passing, but focus groups describe men reacting to being ignored with anger, insults or following: he keeps trying or slowly gets pushier. | bastomski_2011, ssh_2014, nbc_10hours_2014 |
| `model.ladder.ignore.up` | 0.37 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Ignoring or walking on is the most common response (41% of NYC reports) and much harassment happens in passing, but focus groups describe men reacting to being ignored with anger, insults or following: he keeps trying or slowly gets pushier. | bastomski_2011, ssh_2014, nbc_10hours_2014 |
| `model.ladder.ignore.jump` | 0.05 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Ignoring or walking on is the most common response (41% of NYC reports) and much harassment happens in passing, but focus groups describe men reacting to being ignored with anger, insults or following: he keeps trying or slowly gets pushier. | bastomski_2011, ssh_2014, nbc_10hours_2014 |
| `model.ladder.ignore.leave` | 0.08 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Ignoring or walking on is the most common response (41% of NYC reports) and much harassment happens in passing, but focus groups describe men reacting to being ignored with anger, insults or following: he keeps trying or slowly gets pushier. | bastomski_2011, ssh_2014, nbc_10hours_2014 |
| `model.ladder.excuse.down` | 0.08 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. An excuse ("I have a boyfriend") is a deflection he can argue with; men with strong honor beliefs read a deceptive rejection as a bigger slight. | stratmoen_2020 |
| `model.ladder.excuse.stay` | 0.45 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. An excuse ("I have a boyfriend") is a deflection he can argue with; men with strong honor beliefs read a deceptive rejection as a bigger slight. | stratmoen_2020 |
| `model.ladder.excuse.up` | 0.32 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. An excuse ("I have a boyfriend") is a deflection he can argue with; men with strong honor beliefs read a deceptive rejection as a bigger slight. | stratmoen_2020 |
| `model.ladder.excuse.jump` | 0.05 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. An excuse ("I have a boyfriend") is a deflection he can argue with; men with strong honor beliefs read a deceptive rejection as a bigger slight. | stratmoen_2020 |
| `model.ladder.excuse.leave` | 0.1 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. An excuse ("I have a boyfriend") is a deflection he can argue with; men with strong honor beliefs read a deceptive rejection as a bigger slight. | stratmoen_2020 |
| `model.ladder.hostile.down` | 0.02 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Swearing at him or losing her temper is the response practitioners rate most likely to provoke anger, and honor-belief research links a perceived insult to endorsing aggression: the riskiest answer, most likely to make him jump two levels. | ssh_assertive, stratmoen_2018_pt |
| `model.ladder.hostile.stay` | 0.13 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Swearing at him or losing her temper is the response practitioners rate most likely to provoke anger, and honor-belief research links a perceived insult to endorsing aggression: the riskiest answer, most likely to make him jump two levels. | ssh_assertive, stratmoen_2018_pt |
| `model.ladder.hostile.up` | 0.35 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Swearing at him or losing her temper is the response practitioners rate most likely to provoke anger, and honor-belief research links a perceived insult to endorsing aggression: the riskiest answer, most likely to make him jump two levels. | ssh_assertive, stratmoen_2018_pt |
| `model.ladder.hostile.jump` | 0.45 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Swearing at him or losing her temper is the response practitioners rate most likely to provoke anger, and honor-belief research links a perceived insult to endorsing aggression: the riskiest answer, most likely to make him jump two levels. | ssh_assertive, stratmoen_2018_pt |
| `model.ladder.hostile.leave` | 0.05 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Swearing at him or losing her temper is the response practitioners rate most likely to provoke anger, and honor-belief research links a perceived insult to endorsing aggression: the riskiest answer, most likely to make him jump two levels. | ssh_assertive, stratmoen_2018_pt |
| `model.ladder.threaten_attention.down` | 0.1 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Threatening to call the police or draw attention makes him weigh being seen; narrative studies describe men backing off after a public challenge, while a public threat is also a status challenge for some. | fleetwood_2019, stratmoen_2018_pt |
| `model.ladder.threaten_attention.stay` | 0.2 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Threatening to call the police or draw attention makes him weigh being seen; narrative studies describe men backing off after a public challenge, while a public threat is also a status challenge for some. | fleetwood_2019, stratmoen_2018_pt |
| `model.ladder.threaten_attention.up` | 0.27 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Threatening to call the police or draw attention makes him weigh being seen; narrative studies describe men backing off after a public challenge, while a public threat is also a status challenge for some. | fleetwood_2019, stratmoen_2018_pt |
| `model.ladder.threaten_attention.jump` | 0.13 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Threatening to call the police or draw attention makes him weigh being seen; narrative studies describe men backing off after a public challenge, while a public threat is also a status challenge for some. | fleetwood_2019, stratmoen_2018_pt |
| `model.ladder.threaten_attention.leave` | 0.3 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Threatening to call the police or draw attention makes him weigh being seen; narrative studies describe men backing off after a public challenge, while a public threat is also a status challenge for some. | fleetwood_2019, stratmoen_2018_pt |
| `model.ladder.seek_help.down` | 0.1 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Turning to other people is the most reliable way these encounters end in focus-group accounts (shops, bouncers), though some men wait or follow. | ssh_2014, fleetwood_2019 |
| `model.ladder.seek_help.stay` | 0.15 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Turning to other people is the most reliable way these encounters end in focus-group accounts (shops, bouncers), though some men wait or follow. | ssh_2014, fleetwood_2019 |
| `model.ladder.seek_help.up` | 0.15 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Turning to other people is the most reliable way these encounters end in focus-group accounts (shops, bouncers), though some men wait or follow. | ssh_2014, fleetwood_2019 |
| `model.ladder.seek_help.jump` | 0.05 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Turning to other people is the most reliable way these encounters end in focus-group accounts (shops, bouncers), though some men wait or follow. | ssh_2014, fleetwood_2019 |
| `model.ladder.seek_help.leave` | 0.55 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. Turning to other people is the most reliable way these encounters end in focus-group accounts (shops, bouncers), though some men wait or follow. | ssh_2014, fleetwood_2019 |
| `model.ladder.plead.down` | 0.05 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. No research covers pleading; treated like a soft refusal that shows fear, which he may push on. |  |
| `model.ladder.plead.stay` | 0.4 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. No research covers pleading; treated like a soft refusal that shows fear, which he may push on. |  |
| `model.ladder.plead.up` | 0.4 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. No research covers pleading; treated like a soft refusal that shows fear, which he may push on. |  |
| `model.ladder.plead.jump` | 0.07 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. No research covers pleading; treated like a soft refusal that shows fear, which he may push on. |  |
| `model.ladder.plead.leave` | 0.08 |  | assumption | No study measures how a street harasser reacts to a specific response, so this is a placeholder. No research covers pleading; treated like a soft refusal that shows fear, which he may push on. |  |
| `model.ladder.disposition.mild.up` | 0.7 |  | assumption | A mild man (most men in the model) climbs more slowly. Size is a guess; the hostile minority is from lab work on rejection. | woerner_2018 |
| `model.ladder.disposition.mild.jump` | 0.4 |  | assumption | A mild man rarely jumps two levels. A guess. | woerner_2018 |
| `model.ladder.disposition.mild.down` | 1.4 |  | assumption | A mild man calms down more easily. A guess. |  |
| `model.ladder.disposition.mild.leave` | 1.4 |  | assumption | A mild man drops it more easily. A guess. | rtb_5ds |
| `model.ladder.disposition.persistent.up` | 1 |  | assumption | The persistent, entitled man is the reference row. |  |
| `model.ladder.disposition.persistent.jump` | 1 |  | assumption | The persistent, entitled man is the reference row. |  |
| `model.ladder.disposition.persistent.down` | 0.8 |  | assumption | He is slower to let it go. A guess. |  |
| `model.ladder.disposition.persistent.leave` | 0.6 |  | assumption | He does not take no for an answer: less likely to walk off. A guess consistent with persistence after refusal. | pew_2020 |
| `model.ladder.disposition.volatile.up` | 1.25 |  | assumption | The volatile minority climbs faster. Lab work finds aggression concentrated in men high in hostility toward women; the size is a guess. | woerner_2018, andrighetto_2019 |
| `model.ladder.disposition.volatile.jump` | 1.8 |  | assumption | The volatile minority is likelier to jump two levels. A guess. | woerner_2018 |
| `model.ladder.disposition.volatile.down` | 0.6 |  | assumption | He holds on to his anger. A guess. |  |
| `model.ladder.disposition.volatile.leave` | 0.5 |  | assumption | He is less likely to walk off. A guess. |  |
| `model.ladder.cross_non_insult_factor` | 0.5 |  | assumption | When what pushed him toward level 6 was not an insult, only this fraction of the usual share crosses. Practitioner guidance identifies swearing at him as the response most likely to provoke violence and recommends calm, firm statements; the lab aggression after refusal (32%) is mostly verbal. | ssh_assertive, woerner_2018 |
| `model.ladder.pressure_gain` | 0.45 |  | assumption | At full pressure, the share of "he carries on as he was" that becomes "he pushes harder" after a friendly, polite or evasive answer, below level 3. Direction from focus groups (being pleasant leads to more approaches, so women act stern on purpose) and from what catcallers say they want (a conversation, flirting back), which a short friendly answer does not give him; the size is a guess tuned in the Monte Carlo. | ssh_2014, psypost_walton_2021 |
| `model.ladder.pressure_exchanges` | 8 |  | assumption | Exchanges it takes for that pressure to build to full strength. A design choice: a long chat should drift toward pressure within a walk home. |  |
| `model.ladder.invested_leave_factor` | 0.7 |  | assumption | From level 3 up, each level multiplies his chance of simply walking off by this (0.7 at 3, 0.49 at 4, 0.34 at 5). Direction from honor-belief vignette studies: people expect a man who feels insulted to react rather than simply walk away. The size is a guess tuned in the Monte Carlo. | stratmoen_2018_pt |
| `model.ladder.angry_calm_factor` | 0.5 |  | assumption | Once he is angry (level 4 or more) he is half as likely to calm down a level. A guess; honor-belief research links a perceived slight to lasting hostility. | stratmoen_2018_pt |
| `model.ladder.cross_to_threat` | 0.028 |  | assumption | Of the steps that would take him to level 6 (reaching for her), the share that do; the rest hold at 5. Tuned so physical escalation stays inside base.physical_escalation_per_run for a realistic mix of responses. A design bound: physical escalation must stay rare and never follow from one choice. | bastomski_2011, cornell_nyc_2012 |
| `model.blend.clef_weight` | 0.35 |  | assumption | Exponent on Clef's distribution over his next move when it is multiplied into the evidence-based prior. Modest by design: her exact words matter, but less than his disposition. |  |
| `model.blend.likelihood_floor` | 0.05 |  | assumption | Smallest probability Clef's reading is allowed to assign to any move, so it can never rule one out. A design bound. |  |
| `model.blend.default_band` | 0.4 |  | assumption | How far (as a fraction) the blend may move a reaction share that has no researched range. Shares with a researched range may only move within that range. |  |
| `model.bystander.aggressive.p_harassment_stops` | 0.45 |  | assumption | Chance the harassment stops when the bystander threatens or insults him. No outcome data by tactic; set below a calm Direct because guidance says to keep it short and not argue. | rtb_5ds |
| `model.bystander.aggressive.p_hostility_toward_bystander` | 0.45 |  | assumption | Chance he turns on a bystander who threatens or insults him. No rates exist; set clearly above the researched value for a calm Direct, on the guidance that Direct can redirect abuse to the bystander. | rtb_5ds, wins_bronx_2022 |
| `model.bystander.delegate.p_hostility_toward_bystander` | 0.05 |  | assumption | Chance he turns on the bystander after someone with standing in the space steps in. No data; set at the level of Distract because Delegate is also indirect. | rtb_5ds |
| `model.bystander.document.p_hostility_toward_bystander` | 0.2 |  | assumption | Chance he turns on a bystander he notices filming him. No data; a guess between Distract and Direct. | rtb_5ds |
| `model.bystander.document.p_notice_near` | 0.6 |  | assumption | Chance he notices a phone pointed at him from within a few metres. A guess. |  |
| `model.bystander.document.p_notice_mid` | 0.25 |  | assumption | Chance he notices a phone pointed at him from across the sidewalk. A guess. |  |
| `model.bystander.document.p_notice_far` | 0.05 |  | assumption | Chance he notices a phone pointed at him from far away. A guess. |  |
| `model.bystander.physical.p_hostility_toward_bystander` | 0.15 |  | assumption | Chance he turns on a bystander who silently steps between them. No data; a guess between Distract and Direct. | rtb_5ds |
| `model.bystander.interruption.p_harassment_stops` | 0.3 |  | assumption | Chance the harassment stops when a bystander close by says something that could not be read as any tactic. A guess: any interruption breaks his momentum a little. | rtb_5ds |
| `model.bystander.repeat_boost` | 1.2 |  | assumption | Odds multiplier on the harassment stopping at a second or later intervention. A guess: he now knows he is being watched. | pbs_2014 |
| `model.bystander.turned.p_back_off` | 0.6 |  | assumption | Once he has turned on the bystander, chance per exchange that he blusters and leaves. A guess. |  |
| `model.bystander.turned.p_escalates` | 0.03 |  | assumption | Once he has turned on the bystander, chance per later exchange that he becomes physical if the bystander stays calm. Set at the level of base.physical_escalation_per_run; real cases of injured bystanders exist but no rates. | wins_bronx_2022 |
| `model.bystander.turned.p_escalates_if_provoked` | 0.1 |  | assumption | The same chance when the bystander keeps threatening or insulting him. Only the direction is supported; the size is a guess. | rtb_5ds, wins_bronx_2022 |
| `model.bystander.clerk_second_warning.p_harassment_stops` | 0.85 |  | assumption | Chance he leaves once the shopkeeper says he is calling the police. A guess; harassers are described as relying on going unnoticed. | pbs_2014, wesselmann_kelly_2010 |
| `model.bystander.she_slips_away` | 0.5 |  | assumption | Chance she uses the moment he turns on the bystander to get away at once. A guess. |  |
<!-- PARAMS:END -->

## Determinism and seeds

`CreateSessionRequest.seed` fixes the random stream: the disposition draw and every stance sample. Wording choices (which bank line, which angle the line model is nudged toward) draw from a separate per-turn stream, so the decisions replay identically whichever path writes the line. Typed turns with a fixed seed are reproducible up to the Clef read; simulated runs (no network) are exactly reproducible, and the tests assert it.

## How an "intensity" setting could scale it later

The contract has no intensity field yet. If one is added to `CreateSessionRequest`, the clean way to implement it is a small set of multipliers applied to a copy of the parameter table (`buildParams` already returns a plain map and every model function takes `params`):

| Knob | Lower intensity | Higher intensity | Why this knob |
|---|---|---|---|
| `model.scenario.pushiness_first_response`, `..._second_response` | toward 1 (he gives up as readily as the average man) | lower (he almost always tries again) | The demo persona. This is already the one deliberate departure from the researched average. |
| the disposition shares | more mild | more persistent | The research says most of the variance should come from here. Tilt the draw; do not edit the reaction rows. |
| `model.dynamics.fatigue_gain`, `model.session.max_seconds` | shorter encounters | longer encounters | Controls length without changing what he does. |
| `model.persist.share_block`, `model.persist.moving_follow_boost` | less following and blocking | more | Physical pressure without contact. |
| `model.escalation.hazard`, `model.escalation.cap` | 0 (escalation off: suitable for younger audiences) | never above the cap | Must stay inside the range of `base.physical_escalation_per_run`. |

Guard rails for any preset: re-run the tests against it. The first-response shares must stay inside every researched range, the per-session escalation rate inside its range, the orderings (insults riskiest, friendly answers prolong, refuge most reliable) intact, and every session must still end. A preset that cannot pass those is no longer "based on the statistics" and should be labelled as dramatised.

## Limits worth knowing

- The simulated walk used for calibration (about a minute past him, nine seconds per exchange) is a stand-in for the 3D street. If the real walk is much longer, more sessions will end with him giving up before she is home; much shorter, more will end at her door.
- The reaction rows are per response, so a trainee who keeps insulting him faces the hostile row every time. Sustained insults are therefore the riskiest strategy in the simulation, as the research's ordering says they should be; the size of the gap is a guess.
- The bystander model resolves in a handful of beats by design. Real interventions are messier and slower.
- Clef's baseline correction was measured on a few dozen test utterances. It removes an obvious lean; it is not a calibration study.
