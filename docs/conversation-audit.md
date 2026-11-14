# Conversation audit

One player turn, from the words she said to the line he speaks. Written against the code on the live-voice stack. The "hello" bug is called out where it happened.

## The path

1. **Capture.** Push-to-talk builds a clip (`src/audio/mic.ts`). A 200 ms timeslice is required: Chromium can deliver `stop` before the only `dataavailable` if `start()` is called with none, and sealing on `stop` used to throw the words away. The clip is posted to the session. Live agent mode skips this and sends what the agent heard.

2. **Transcript.** ElevenLabs Scribe turns the clip into text. A silence tag, an empty clip, or a failed call becomes silence, not a boundary. Typed input skips Scribe and uses the typed words.

3. **How she responded.** Clef reads the text into a strategy (engage, firm boundary, ignore, and the rest). If Clef is slow or missing, `heuristicWomanRead` does it with keywords. A bare hello, hi, what, um, or sorry is **engage**. A clear boundary ("leave me alone", "back off", "stop following") is a firm boundary. "Stop" or "move" buried in a longer sentence is not.

4. **Seeded stance.** `decideWoman` samples his next stance from the evidence-based table for that strategy, his disposition, and what has already happened. The sample then goes through `gateStance`.

5. **Workers AI judge, in parallel.** Gemma answers the same turn in JSON: firm boundary, tone, bystander, next stance, expression, heat. Budget 400 ms. A timeout, a bad enum, or malformed JSON returns null and the seeded stance stands. Temperature is 0, so a wrong answer is the same wrong answer every time.

6. **What he is allowed to do.** `composeBeat` may use the judge's stance, then `gateStance` again, from the stance he already had:
   - A greeting cannot become a retreat, a threat, or "your loss".
   - The first clear boundary makes him defensive (guilt: "I was only being nice"). It cannot make him leave, follow, or jump to a threat. A second clear no can.
   - Leaving is allowed after a boundary he has already heard once, after she gets help or calls attention, when a bystander has actually stepped in, or once the encounter has gone on (his fourth decision or later) and he is not being greeted.
   - Heat rises by at most one step a turn, except a real insult or a clear boundary may reach hostility. He cannot snap from charming to grabbing. The judge cannot invent a physical escalation.
   - The model's own "bystander: true" flag is not an intervention. Only the scene is.

7. **The line.** The line model is asked for one line in that stance that picks up her words. If the line does not contain what she said, it is rejected and the grounded bank line for that stance is used. "Your loss, sweetheart" lives only in the leaving bank. It is not a default for a greeting. A short huh, scoff, or sigh plays locally while the line is written. It is not the reply, and it does not play over a live agent call.

8. **Face and voice.** The stance allowlist picks the face and smooths toward it. The TTS request tags the line `[calm]`, `[irritated]`, or `[nervous]` and sets stability to match. Subtitles are the words only. They stay up until the audio ends, and they drop if she talks over him.

9. **Memory.** Her line and his line are folded into a four-beat summary and a few facts (a name, a boyfriend, a firm no, the police, "I was only being friendly"). The next prompt and the live agent's tool result include them.

10. **Live agent.** Pressing L does not let the agent choose the stance. The tool result is the gated stance. The prompt says a greeting is not a no, and he must not leave unless that stance is `back_off`.

## Where a decision used to be made with too little

- The judge's `stance` field replaced the seeded sample with no memory of where he already was. `back_off` was a legal answer on turn one. At temperature 0 that answer stuck.
- `firm` plus a model-supplied bystander flag forced retreat even when nobody had stepped in. The keyword list also treated a bare "stop" or "move" as a boundary.
- The speculative line was decided by calling `decideWoman` on the **live** state. One utterance was applied twice, and the line could be written for the first, wrong, stance.
- With no line model, or when the model misses, the leaving bank includes "Your loss, sweetheart." That line does not mention what she said. It is only legal once he is actually leaving.
- Clef's reaction distribution can be blended in, but it cannot move a probability outside the researched range. The judge could, until the gate.

## What a reply can still ignore

- The line model is told to pick up her words and is rejected when it does not. The grounded fallback quotes her. A silence has nothing to quote; the line is about her not answering.
- His face is chosen from the stance allowlist, not from a free description of the sentence.
- The live agent's spoken words are the agent's, inside the stance and the tag it was given. The prompt forbids leaving on a greeting. It cannot be unit-tested against a live call from this machine.
