# Tech spec: voice-simulator pipeline (docs read 2026-11-12)

## TL;DR decisions

```text
 1. Classifier: `@cf/cloudflare/clef-flash` -> env.AI.run(id, { model: "clef-flash", state, questions }). Question types are `choice` / `noul` / `score` (there is no enum/boolean/number). $0.038 per M input tokens, 24,576-token context, ~39 ms median.
 2. Read distribution at res.answers.<qid>.probabilities (+ .choice, .confidence); yes/no at res.answers.<qid>.noul.
 3. REST test: POST https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run/@cf/cloudflare/clef-flash  (Authorization: Bearer).
 4. Audio-direct option: `@cf/cloudflare/clef-omni`, audio: ["data:audio/wav;base64,..."] - only WAV/MP3 documented; webm/opus NOT confirmed.
 5. Dialogue LLM (primary): `@cf/google/gemma-4-26b-a4b-it` - OpenAI-style body, response_format {type:"json_schema", json_schema:{name,schema,strict}}, chat_template_kwargs {enable_thinking:false}; read choices[0].message.content.
 6. Dialogue LLM (fallback): `@cf/meta/llama-3.3-70b-instruct-fp8-fast` - legacy body, response_format {type:"json_schema", json_schema:<schema itself>}; read res.response.
 7. Avoid (HTTP 410 from 2026-11-20): llama-3.1-8b-instruct-fp8, llama-3.2-1b/3b, qwen3-30b-a3b-fp8, kimi-k2.6, kimi-k2.7-code, glm-5.2, glm-5.3-flash, deepseek-v4-*, nemotron-3-120b-a12b.
 8. STT: POST https://api.elevenlabs.io/v1/speech-to-text  multipart: model_id=`scribe_v3` (or `scribe_v2`), file=<webm/opus blob> -> .text
 9. TTS expressive + audio tags over HTTP: POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream?output_format=mp3_44100_128  model_id `eleven_v4`.
10. TTS lowest latency: `eleven_v4_turbo` (~100 ms, tags) - documented only on wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input; HTTP-safe low-latency fallback `eleven_flash_v2_5` (~100 ms, NO tags).
11. SFX: POST https://api.elevenlabs.io/v1/sound-generation  model_id `eleven_text_to_sound_v3` (set explicitly; default v2 is deprecated), duration_seconds 0.5-30, loop, prompt_influence.
12. Voices: GET https://api.elevenlabs.io/v2/voices. Legacy Default voices die 2026-12-31 -> start on replacements: male `fs2OqxduwXgp9foh2xjK` (Callum - Husky Trickster), female `OZ0L6eISlOejga3XjDFt` (Talia - Warm Soft Guide).
13. ElevenLabs auth: header `xi-api-key` (server only). Browser: POST /v1/single-use-token/{realtime_scribe|batch_scribe|tts_websocket}, 15-min single-use.
14. Cloudflare: @cloudflare/vite-plugin v1 + wrangler.jsonc; assets {not_found_handling:"single-page-application", run_worker_first:["/api/*"]}; ai {binding:"AI", remote:true}; compatibility_date "2026-11-12".
15. Durable Object: declare with `exports: { SessionDO: { type:"durable-object", storage:"sqlite" } }`. `migrations`/`new_sqlite_classes` is now the legacy flow (still works; mutually exclusive with exports).
```

Legend used below: **[doc]** = stated in the cited docs. **[observed]** = seen from a live unauthenticated HTTP call today. **[inferred]** / **[unverified]** = my reading or memory, not confirmed by a doc page; test before relying on it. No authenticated API call was made while writing this, so every code sample is untested against the live services.

---

## 1. Cloudflare Clef (decision models)

Verified from:
- https://developers.cloudflare.com/workers-ai/models/clef-flash/index.md (+ `schema-input.json`, `schema-output.json` in the same folder)
- https://developers.cloudflare.com/workers-ai/models/clef/index.md , https://developers.cloudflare.com/workers-ai/models/clef-omni/index.md (+ its `schema-input.json`)
- https://developers.cloudflare.com/changelog/post/2026-10-01-clef-workers-ai/ , https://developers.cloudflare.com/changelog/post/2026-10-09-clef-omni-workers-ai/
- https://blog.cloudflare.com/clef-decision-models/ , https://huggingface.co/Cloudflare/clef , https://huggingface.co/Cloudflare/clef-omni
- https://developers.cloudflare.com/workers-ai/platform/pricing/index.md , https://developers.cloudflare.com/workers-ai/platform/limits/index.md

### 1.1 Models

| Model ID | `model` selector | Size | Hosted context | Price (input only; output free) | Published latency |
| --- | --- | --- | --- | --- | --- |
| `@cf/cloudflare/clef-flash` | `"clef-flash"` | 9B | 24,576 tokens | $0.038 / M tokens (3,455 neurons / M) | median 38.8 ms, p95 122.4 ms |
| `@cf/cloudflare/clef` | `"clef"` | 27B | 65,536 tokens | $0.240 / M tokens | median 152 ms / p95 351 ms at ~800 tokens (after Oct 9 speed-up) |
| `@cf/cloudflare/clef-omni` | `"clef-omni"` | 30B MoE, 3B active | 64,000 tokens | $0.150 / M tokens | text ~20 ms, image or audio < 100 ms |

- The launch post said clef-flash had a 64K window; the Oct 9 changelog cut the hosted window to 24K when the price dropped from $0.090 to $0.038.
- Latency figures are Cloudflare's own benchmark numbers ("across our 43 benchmark runs"), not an SLA.
- All three: zero data retention, no output-token charge, media billed as input tokens.

### 1.2 "System One API" and the `model` selector

- "Clef follows the System One API" [doc]: the same request body as Typesafe's Jev `POST /v1/systemone`: `{ model, state, questions }`. `images` is a "Clef extension to the System One API"; `audio` and `videos` are "Clef-Omni extension".
- `model` is a **required string inside the body**, in addition to the model ID you pass to `env.AI.run` / put in the URL. Schema pattern for the clef and clef-flash endpoints: `^\s*(clef|clef-flash)\s*$`; for clef-omni: `^\s*clef-omni\s*$`.
- Ambiguity: the clef-flash endpoint's pattern also accepts `"clef"`. The docs do not say what happens when the selector and the URL model disagree. Always send the matching pair.

### 1.3 Request schema (exact, from `schema-input.json`)

```ts
type ClefRequest = {
  model: "clef-flash" | "clef" | "clef-omni";   // required
  state: string | object | unknown[];            // required; long text state is truncated to fit
  questions: Record<string, ClefQuestion>;       // required; 1..64 entries
  images?: Array<string | { content_type: string; base64: string }>;  // max 4
  audio?:  Array<string | { content_type: string; base64: string }>;  // clef-omni only, max 4
  videos?: Array<string | { content_type: string; base64: string }>;  // clef-omni only, max 2
};

type ClefQuestion =
  | { type: "noul";   instructions: string | object | unknown[]; criteria?: { true?: unknown; false?: unknown } }
  | { type: "choice"; instructions: string | object | unknown[]; criteria: Record<string, string | object | unknown[] | null> } // 2..255 options
  | { type: "score";  instructions: string | object | unknown[]; criteria: unknown[] };                                          // 2..10 ordered levels, lowest first, indexed from 0
```

Question types (these are the only three):

| Type | Meaning | Maps to what you asked for |
| --- | --- | --- |
| `noul` | Yes/no. "Returns the probability the answer is yes." | boolean |
| `choice` | Pick one option from a map of `option id -> description`. | enum |
| `score` | Ordered rubric, 2 to 10 levels. Returns a probability-weighted level. | ordinal only; there is no free-number type |

- Question ids: letters, digits, `_`, `.`, `-`; max 100 chars. Answers come back under the same ids.
- `instructions` is `required` in the Workers AI schema. The Hugging Face card says it is optional ("the question ID is used when it is omitted"). Send it.
- For extracting or estimating actual numbers Cloudflare lists a separate preview model, `@cf/cloudflare/clairic` ($0.100 / M input tokens). Not researched further.

### 1.4 Response schema (exact, from `schema-output.json`)

```ts
type ClefResponse = {
  model: string;
  answers: Record<string, NoulAnswer | ChoiceAnswer | ScoreAnswer>;
  usage: { input_tokens: number; output_tokens: number };
};
type NoulAnswer   = { type: "noul";   noul: number };                       // 0..1, probability of yes
type ChoiceAnswer = { type: "choice"; choice: string;                       // highest-probability option id
                      probabilities: Record<string, number>;                // per option, sums to 1
                      confidence: number };                                 // 0..1
type ScoreAnswer  = { type: "score";  score: number;                        // probability-weighted level, can land between levels
                      legend: Record<string, unknown>;                      // level index (string) -> description
                      probabilities: Record<string, number>;                // per level, sums to 1
                      confidence: number };
```

### 1.5 Limits

| Limit | Value |
| --- | --- |
| Questions per request | 1 to 64 |
| `choice` options | 2 to 255 |
| `score` levels | 2 to 10 |
| Images | max 4; PNG/JPEG/WebP; 4 MiB and 16 MP each; 8 MiB total decoded; whole body max 13 MiB; remote URLs rejected |
| Image tokens | (w/32) x (h/32) + 3 markers, capped at 1,024 per image |
| Audio (omni) | max 4 clips; 8 MiB and 300 s each; ~780 tokens per minute |
| Video (omni) | max 2; 16 MiB and 60 s each; sampled at 2 fps; up to ~15,400 tokens/min (+ ~780/min with sound) |
| Audio + video together | 16 MiB decoded |
| Overflow | media + questions over the context window -> request fails; otherwise text `state` is truncated |
| Rate limit | [inferred] 300 requests/min: the model pages are tagged "Text Generation", whose default is 300 rpm, and Clef is not on the paid-only list. No Clef-specific number is published. |
| Free allocation | 10,000 neurons/day account-wide, then $0.011 per 1,000 neurons |

Cost sanity check: a 300-token classify call on clef-flash is about 1 neuron, about $0.000011.

### 1.6 Worked TypeScript example: 8 categories + a second enum question

Category names below are placeholders; swap in the real taxonomy.

```ts
// worker/classify.ts
const MOVES = {
  comply:        "Agrees or does what the other person wants",
  refuse:        "Says no or sets a firm boundary",
  deflect:       "Changes the subject or gives a vague non-answer",
  de_escalate:   "Tries to calm things down or lower the tension",
  escalate:      "Threatens, insults or raises the stakes",
  question:      "Asks for information or clarification",
  seek_help:     "Calls for or refers to outside help or other people",
  unintelligible: "Silence, noise, or words that do not form a usable utterance",
} as const;
type Move = keyof typeof MOVES;

const TONES = {
  calm:    "Even, controlled delivery",
  nervous: "Hesitant, shaky or apologetic",
  angry:   "Hostile or raised",
  joking:  "Sarcastic or playful",
} as const;
type Tone = keyof typeof TONES;

type Choice<K extends string> = {
  type: "choice"; choice: K; probabilities: Record<K, number>; confidence: number;
};
type ClefResult = {
  model: string;
  answers: { move: Choice<Move>; tone: Choice<Tone> };
  usage: { input_tokens: number; output_tokens: number };
};

export async function classifyUtterance(
  env: Env,
  input: { utterance: string; npcStance: string; npcLastLine: string },
) {
  // Cast: I did not check whether the generated `Ai` types already know the Clef model ids.
  const res = (await (env.AI as any).run("@cf/cloudflare/clef-flash", {
    model: "clef-flash",
    state: {
      npc_stance: input.npcStance,
      npc_last_line: input.npcLastLine,
      player_utterance: input.utterance,
    },
    questions: {
      move: {
        type: "choice",
        instructions: "Which move best describes player_utterance, given the conversation so far?",
        criteria: MOVES,
      },
      tone: {
        type: "choice",
        instructions: "What is the tone of player_utterance?",
        criteria: TONES,
      },
    },
  })) as ClefResult;

  const dist = res.answers.move.probabilities;                       // { comply: 0.03, refuse: 0.71, ... } sums to 1
  const ranked = (Object.entries(dist) as [Move, number][]).sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;

  return {
    move: res.answers.move.choice,                                   // same as top[0]
    moveP: top[1],
    margin: top[1] - (second?.[1] ?? 0),                             // use for "ambiguous" handling in the state machine
    moveDist: dist,
    tone: res.answers.tone.choice,
    toneDist: res.answers.tone.probabilities,
    inputTokens: res.usage.input_tokens,
  };
}
```

Response shape for that call (structure per `schema-output.json`; the numbers are illustrative, not captured from a live call):

```json
{
  "model": "clef-flash",
  "answers": {
    "move": {
      "type": "choice",
      "choice": "refuse",
      "probabilities": { "comply": 0.03, "refuse": 0.71, "deflect": 0.09, "de_escalate": 0.08, "escalate": 0.04, "question": 0.03, "seek_help": 0.01, "unintelligible": 0.01 },
      "confidence": 0.71
    },
    "tone": {
      "type": "choice",
      "choice": "nervous",
      "probabilities": { "calm": 0.22, "nervous": 0.61, "angry": 0.12, "joking": 0.05 },
      "confidence": 0.61
    }
  },
  "usage": { "input_tokens": 212, "output_tokens": 0 }
}
```

`confidence` is described only as "How certain the model is, derived from the probabilities." The formula is not documented, so do not assume it equals the top probability.

### 1.7 REST form (terminal test)

```sh
curl "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run/@cf/cloudflare/clef-flash" \
  -X POST \
  -H "Authorization: Bearer $CLOUDFLARE_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "clef-flash",
    "state": "I said no. Back off.",
    "questions": {
      "move": {
        "type": "choice",
        "instructions": "Which move best describes the utterance?",
        "criteria": {
          "comply": "Agrees or goes along",
          "refuse": "Says no or sets a boundary",
          "deflect": "Changes the subject",
          "de_escalate": "Tries to calm things down",
          "escalate": "Threatens or insults",
          "question": "Asks for information",
          "seek_help": "Calls for outside help",
          "unintelligible": "Not a usable utterance"
        }
      },
      "tone": {
        "type": "choice",
        "instructions": "What is the tone?",
        "criteria": { "calm": "Even", "nervous": "Hesitant", "angry": "Hostile", "joking": "Playful" }
      },
      "hostile": { "type": "noul", "instructions": "Is the speaker hostile?" }
    }
  }'
```

[inferred] Like every Workers AI REST call, the JSON comes back wrapped in the standard API envelope `{ "result": { model, answers, usage }, "success": true, "errors": [], "messages": [] }`. The Clef pages only show the request.

### 1.8 Audio into clef-omni

```ts
const res = await (env.AI as any).run("@cf/cloudflare/clef-omni", {
  model: "clef-omni",
  state: "A push-to-talk clip of the player replying to the NPC.",
  audio: [`data:audio/wav;base64,${wavBase64}`],            // or { content_type: "audio/wav", base64: wavBase64 }
  questions: { /* same question map as above */ },
});
```

- Formats: the changelog says "audio (WAV or MP3)" and "video (MP4 or WebM)". The schema says "an audio/* media type, e.g. audio/wav or audio/mpeg". **`audio/webm;codecs=opus` from MediaRecorder is not confirmed.** Untested idea: a webm/opus recording is a WebM container, and WebM is listed for `videos`, so sending it as `data:video/webm;base64,...` might work as an audio-only video. Treat that as an experiment, not a plan.
- Cost: ~780 tokens per audio minute, so an 8 s clip is about 104 tokens, about $0.000016.
- If it works it could run in parallel with STT (tone from the audio itself). The LLM still needs the transcript, so it does not remove the STT step.

---

## 2. Workers AI text generation

Verified from:
- https://developers.cloudflare.com/workers-ai/models/index.md (catalog, 74 models)
- Model pages + raw schemas (`sync-input.json`, `sync-output.json`): https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/ , `/llama-3.3-70b-instruct-fp8-fast/` , `/phonellm-mini-alpha-2/` , `/glm-4.7-flash/` , `/llama-4-scout-17b-16e-instruct/` , `/mistral-small-3.1-24b-instruct/` , `/gpt-oss-20b/` , `/granite-4.0-h-micro/` , `/qwen3.8-27b/`
- https://developers.cloudflare.com/workers-ai/features/json-mode/index.md
- https://developers.cloudflare.com/changelog/post/2026-11-05-planned-model-deprecations/ , https://developers.cloudflare.com/changelog/post/2026-10-15-phonellm-mini-workers-ai/ , https://developers.cloudflare.com/changelog/post/2026-04-04-gemma-4-26b-a4b-workers-ai/ , https://developers.cloudflare.com/changelog/post/2026-09-17-reject-if-busy/
- https://developers.cloudflare.com/workers-ai/platform/pricing/index.md , `/platform/limits/index.md` , `/platform/errors/index.md` , `/platform/data-usage/index.md`
- https://developers.cloudflare.com/ai-gateway/features/guardrails/usage-considerations/

### 2.1 Deprecation trap (8 days away)

From 2026-11-20 these return HTTP `410 Gone`, error code `5028` [doc]: `@cf/meta/llama-3.1-8b-instruct-fp8`, `@cf/meta/llama-3.2-1b-instruct`, `@cf/meta/llama-3.2-3b-instruct`, `@cf/qwen/qwen3-30b-a3b-fp8`, `@cf/qwen/qwq-32b`, `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b`, `@cf/deepseek-ai/deepseek-v4-flash-0731`, `@cf/deepseek-ai/deepseek-v4-pro-0813`, `@cf/nvidia/nemotron-3-120b-a12b`, `@cf/moonshotai/kimi-k2.6`, `@cf/moonshotai/kimi-k2.7-code`, `@cf/zai-org/glm-5.2`, `@cf/zai-org/glm-5.3-flash`, plus the `-lora` Llama 2 / Gemma bases. Cloudflare's stated replacements "for smaller model needs": `@cf/google/gemma-4-26b-a4b-it` and `@cf/qwen/qwen3.8-27b`.

### 2.2 Candidates still listed and not flagged for deprecation

| Model ID | Context | Price in / out per M tokens | API shape | Structured output field in schema | Reasoning |
| --- | --- | --- | --- | --- | --- |
| `@cf/google/gemma-4-26b-a4b-it` | 256,000 | $0.10 / $0.30 | OpenAI chat-completions | `response_format` (`text` / `json_object` / `json_schema{name,schema,strict}`) | on by default; `chat_template_kwargs.enable_thinking: false` |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 24,000 | $0.293 / $2.253 | legacy `{response}` | `response_format` (`json_object` / `json_schema`), on the official JSON Mode list | none |
| `@cf/daily-co/phonellm-mini-alpha-2` | 262,140 | $0.06 / $0.24 | OpenAI chat-completions | `response_format` (same as Gemma) | off recommended: `enable_thinking: false` |
| `@cf/zai-org/glm-4.7-flash` | 131,072 | $0.0605 / $0.40 | OpenAI chat-completions | `response_format` (same as Gemma) | on by default; `enable_thinking: false` |
| `@cf/meta/llama-4-scout-17b-16e-instruct` | 131,000 | $0.27 / $0.85 | legacy `{response}` | `response_format` and `guided_json` | none |
| `@cf/mistralai/mistral-small-3.1-24b-instruct` | 128,000 | $0.351 / $0.555 | legacy `{response}` | `guided_json` only | none |
| `@cf/openai/gpt-oss-20b` | 128,000 | $0.20 / $0.30 | accepts chat-completions, completions or Responses | `response_format` | `low` / `medium` (default) / `high`; no "off" value is listed |
| `@cf/qwen/qwen3.8-27b` | 262,144 | $0.45 / $3.20 | OpenAI chat-completions | not inspected | `low` / `medium` / `xhigh` (default) |

All are in the "Text Generation" class: 300 requests/min default. None of the above is on the "requires Workers Paid" list.

### 2.3 Top 2

**1. `@cf/google/gemma-4-26b-a4b-it` (primary).**
- [doc] MoE, 26B total and 4B active: "runs almost as fast as a 4B-parameter model". No latency number is published.
- [doc] Named by Cloudflare as the small-model migration target; not deprecated; cheapest of the capable options.
- [doc] Thinking can be switched off, which matters for a sub-20-word line.
- Risk [unverified, from memory, not from any doc]: Gemma-family models tend to be more conservative about profanity and menace than Llama. Test with the real villain prompt first.

**2. `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (tone and JSON fallback).**
- [doc] The only non-deprecated model that is on the JSON Mode "Supported Models" list.
- [doc] No reasoning mode to disable, so no wasted tokens.
- Output is pricey per token but a 20-word line is about 30 output tokens, about $0.00007.
- A 70B model will be slower to first token than Gemma 4. No number is published.

Runners-up worth a 10-minute A/B: `@cf/zai-org/glm-4.7-flash` ("Optimized for dialogue, instruction-following") and `@cf/daily-co/phonellm-mini-alpha-2` (built for the STT -> LLM -> TTS slot, cheapest, but post-trained "on phone and customer support scenarios", name says alpha, and Pipecat recommends `temperature: 0`, which fights varied dialogue).

The docs cannot tell you which one writes the best gritty line. Decide by running the same 20 prompts through the top two plus glm-4.7-flash and reading the output.

### 2.4 Request / response: Gemma 4 (OpenAI chat-completions shape)

```ts
const LINE_SCHEMA = {
  type: "object",
  properties: {
    line:     { type: "string", description: "One spoken line, under 20 words, no stage directions" },
    delivery: { type: "string", enum: ["low", "mocking", "angry", "flat", "amused"] },
  },
  required: ["line", "delivery"],
  additionalProperties: false,
} as const;

const res = await (env.AI as any).run(
  "@cf/google/gemma-4-26b-a4b-it",
  {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },             // character sheet + "reply with JSON only"
      { role: "user", content: JSON.stringify({ stance, playerSaid, move, tone }) },
    ],
    max_completion_tokens: 80,                                 // `max_tokens` is marked deprecated on this model
    temperature: 0.9,
    chat_template_kwargs: { enable_thinking: false },
    response_format: {
      type: "json_schema",
      json_schema: { name: "npc_line", strict: true, schema: LINE_SCHEMA },
    },
  },
  { rejectIfBusy: true },                                      // optional: fail (429, code 3040) instead of queueing
);

const choice = res.choices[0];
if (choice.finish_reason === "content_filter" || choice.message.refusal) { /* use a canned line */ }
const out = JSON.parse(choice.message.content) as { line: string; delivery: string };
```

Response shape (from `sync-output.json`):

```ts
{
  id: string; object: string; created: number; model: string;
  choices: [{
    index: number;
    message: { role: "assistant"; content: string | null; refusal: string | null; tool_calls?: unknown[] };
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | "function_call";
    logprobs: unknown | null;
  }];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number;
            completion_tokens_details?: { reasoning_tokens?: number } };
}
```

### 2.5 Request / response: Llama 3.3 70B (legacy shape)

```ts
const res = await (env.AI as any).run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
  messages: [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify({ stance, playerSaid, move, tone }) },
  ],
  max_tokens: 80,
  temperature: 0.9,
  response_format: { type: "json_schema", json_schema: LINE_SCHEMA },   // schema goes directly here, no {name, schema} wrapper
});

// JSON Mode docs show `response` as an already-parsed object; the model's output schema says string. Handle both.
const out = typeof res.response === "string" ? JSON.parse(res.response) : res.response;
```

Response shape: `{ response: string | object, usage: { prompt_tokens, completion_tokens, total_tokens }, tool_calls?: [...] }`.

Gotchas:
- **Two different `json_schema` shapes.** OpenAI-style models: `json_schema: { name, schema, strict }`. Legacy models: `json_schema: <the JSON Schema itself>`.
- [doc] "Workers AI can't guarantee that the model responds according to the requested JSON Schema." On failure it returns the error `JSON Mode couldn't be met`. Catch it and fall back to a canned line.
- The JSON Mode page's supported-model list is stale: it lists only one model still alive after Nov 20 (Llama 3.3 70B) and does not mention Gemma 4, PhoneLLM or GLM even though their own schemas define `response_format`. Whether `strict: true` enforces constrained decoding on those is not stated.
- The raw input schemas for phonellm, glm-4.7-flash and llama-3.3 show only a "Prompt" variant with `prompt` required, yet every usage example on those pages sends `messages`. Read that as a docs rendering quirk; `messages` is the documented usage.

### 2.6 Streaming

- `stream: true` returns a `ReadableStream` of server-sent events: `return new Response(stream, { headers: { "content-type": "text/event-stream" } })` [doc].
- [doc] "JSON Mode currently doesn't support streaming."
- For one line under 20 words, use non-streaming JSON. If time-to-first-word ever matters more than structure, drop JSON and stream plain text.
- [unverified] Chunk shape differs by family: OpenAI-style models emit `chat.completion.chunk` objects with `choices[0].delta.content` and end with `data: [DONE]`; legacy models emit `data: {"response":"..."}`. Log one stream before writing the parser.

### 2.7 Content-safety filtering

- No always-on Workers AI content filter is documented. The data-usage page has a "Safety, security, and legal exceptions" paragraph about retention, not about blocking output.
- The only documented filter is opt-in: **AI Gateway Guardrails** (Llama Guard 3 8B; categories S1 Violent Crimes through S14, including S10 Hate and S12 Sexual Content). It applies only if you route `env.AI.run` through a gateway with categories set to Block. It adds about 500 ms per request and does not support streaming. Do not enable it on this path, or set those categories to Ignore/Flag.
- The OpenAI-style response does include `finish_reason: "content_filter"` and `message.refusal`, so handle both.
- Model-level refusals are a property of each model, undocumented by Cloudflare. Each model also carries its own license / acceptable-use terms (Gemma and Llama licenses are linked from their pages).

---

## 3. ElevenLabs

Verified from:
- https://elevenlabs.io/docs/llms.txt (index) , https://elevenlabs.io/docs/overview/models.md
- https://elevenlabs.io/docs/api-reference/speech-to-text/convert.md , https://elevenlabs.io/docs/overview/capabilities/speech-to-text.md
- https://elevenlabs.io/docs/api-reference/text-to-speech/stream.md , https://elevenlabs.io/docs/overview/capabilities/text-to-speech.md , https://elevenlabs.io/docs/overview/capabilities/text-to-speech/eleven-v4.md , https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices.md
- https://elevenlabs.io/docs/api-reference/text-to-dialogue/stream.md , https://elevenlabs.io/docs/api-reference/text-to-dialogue/ttd-websocket.md , https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tdd.md , https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/tts-vs-ttd-websockets.md
- https://elevenlabs.io/docs/eleven-api/guides/how-to/text-to-speech/streaming.md , `/request-stitching.md` , https://elevenlabs.io/docs/api-reference/streaming.md
- https://elevenlabs.io/docs/eleven-api/concepts/latency-methodology.md , https://elevenlabs.io/docs/eleven-api/guides/how-to/best-practices/latency-optimization.md , https://elevenlabs.io/docs/eleven-api/choosing-the-right-model.md
- https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert.md , https://elevenlabs.io/docs/overview/capabilities/sound-effects.md
- https://elevenlabs.io/docs/api-reference/voices/search.md , https://elevenlabs.io/docs/overview/capabilities/voices.md , https://elevenlabs.io/docs/help-center/product/voices/my-voices/what-are-default-voices.md
- https://elevenlabs.io/docs/api-reference/authentication.md , https://elevenlabs.io/docs/api-reference/tokens/create.md , https://elevenlabs.io/docs/eleven-api/resources/errors.md
- https://elevenlabs.io/pricing/api (page text, 2026-11-12)
- Changelogs: https://elevenlabs.io/docs/changelog/2026/11/9.md , `/2026/11/2.md` , `/2026/9/28.md` , `/2026/7/20.md` , `/2026/7/13.md`
- [observed] `GET https://api.elevenlabs.io/v1/voices` without a key, 2026-11-12

Base URL `https://api.elevenlabs.io` (global routing; `https://api.us.elevenlabs.io` pins to US). The response header `x-region` shows which region served the request.

### 3a. Speech to text

Endpoint: `POST https://api.elevenlabs.io/v1/speech-to-text`, `Content-Type: multipart/form-data`.

| Model ID | Status |
| --- | --- |
| `scribe_v3` | current batch model (added 2026-11-09). 27% fewer word errors than v2 on FLEURS. |
| `scribe_v2` | previous batch model, still available |
| `scribe_v3_live` | current realtime model (WebSocket `wss://api.elevenlabs.io/v1/speech-to-text/realtime`) |
| `scribe_v2_realtime` | previous realtime model; ~150 ms median time to committed transcript |
| `scribe_v2_medical` | clinical fine-tune |
| `scribe_v1` | deprecated |

Fastest for a 2 to 8 s clip: **not answerable from the docs.** "ElevenLabs does not publish a latency figure for ... Scribe v3, Scribe v2". Start with `scribe_v3`, time it against `scribe_v2` on real clips, keep the faster one if accuracy is equal.

Multipart fields that matter here (the full list has about 30):

| Field | Type | Notes |
| --- | --- | --- |
| `model_id` | string, required | `scribe_v3` |
| `file` | file | min 100 ms of audio; < 5 GB. Exactly one of `file` / `cloud_storage_url` / `source_url`. |
| `language_code` | string | ISO-639-1 or -3. Set `en` to skip language detection. |
| `tag_audio_events` | boolean | tags like `(laughter)` in the text |
| `timestamps_granularity` | enum | `word` / `character`; `none` is referenced as a value elsewhere on the page |
| `diarize`, `num_speakers` | | not needed for one speaker |
| `no_verbatim` | boolean | strips fillers and false starts (v2, v2 medical, v3). Leave off if hesitation is a signal. |
| `file_format` | enum | `pcm_s16le_16` (16-bit PCM, 16 kHz, mono, little-endian) or `other`. "Latency will be lower than with passing an encoded waveform." |
| `keyterms` | string[] | +20% cost |
| `temperature`, `seed` | | |
| `numbers_format`, `secondary_language_codes` | | scribe_v3 only |
| query `token` | string | single-use token from `POST /v1/single-use-token/batch_scribe` |
| query `enable_logging` | boolean | `false` = zero retention, Enterprise only |

Input formats: "All major audio and video formats are supported." The FAQ list includes `audio/webm` and `audio/opus`; key facts list "AAC, AIFF, OGG, MP3, OPUS, WAV, FLAC, M4A, WebM". So **webm/opus from MediaRecorder is accepted directly** [doc]. [unverified, browser knowledge] Safari's MediaRecorder produces `audio/mp4` (AAC), which is also on the list; pass the blob's real MIME type and extension.

Response (single channel):

```ts
{
  language_code: string;            // e.g. "en"
  language_probability: number;
  text: string;                     // the transcript
  words: Array<{ text: string; type: "word" | "spacing" | "audio_event"; logprob: number;
                 start?: number; end?: number; speaker_id?: string }>;
  transcription_id?: string;
  audio_duration_secs?: number;
}
```

```ts
export async function transcribe(env: Env, clip: Blob): Promise<string> {
  const form = new FormData();
  form.append("model_id", "scribe_v3");
  form.append("language_code", "en");
  form.append("tag_audio_events", "false");
  form.append("file", clip, "clip.webm");
  const r = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY },   // do not set content-type; fetch adds the boundary
    body: form,
  });
  if (!r.ok) throw new Error(`stt ${r.status}: ${await r.text()}`);
  return ((await r.json()) as { text: string }).text.trim();
}
```

Latency levers, in order: (1) let the browser upload straight to ElevenLabs with a `batch_scribe` single-use token and skip the Worker hop; (2) send `pcm_s16le_16`; (3) move to the realtime WebSocket.

Billing: per second of audio including silence. Trim dead air on the client.

### 3b. Text to speech (streaming)

Endpoint: `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream` (JSON in, chunked audio bytes out).

Current TTS models:

| Model ID | Latency (docs, server-side median, WebSocket, warm voice) | Audio tags like `[whispers]` | Chars / request | Price / 1K chars |
| --- | --- | --- | --- | --- |
| `eleven_v4` | not published ("designed for quality") | yes | 10,000 | $0.08 |
| `eleven_v4_turbo` | ~100 ms | yes | not listed | $0.04 |
| `eleven_v3` | not published | yes | 5,000 | $0.08 |
| `eleven_v3_conversational` | ~165 ms | yes | not listed | $0.04 |
| `eleven_flash_v2_5` | ~100 ms | no (see below) | 40,000 | $0.04 |
| `eleven_flash_v2` (English only) | ~135 ms | no | 30,000 | $0.04 |
| `eleven_multilingual_v2` (endpoint default) | not published | no | 10,000 | $0.08 |
| `eleven_turbo_v2_5`, `eleven_turbo_v2` | deprecated: "We recommend using the Flash models over Turbo models in all use cases." | | | |

There is no model called "v3 real-time"; the realtime variants are `eleven_v3_conversational` and `eleven_v4_turbo`. ElevenLabs' own guidance: quality -> `eleven_v4`; low latency -> `eleven_v4_turbo`.

**Which model works on which endpoint (this is the main ambiguity):**

| Endpoint | Models per docs |
| --- | --- |
| `POST /v1/text-to-speech/{voice_id}/stream` | Flash, Multilingual v2. `eleven_v3`: "can also be used with the Text to Speech API". `eleven_v4`: used in the official streaming and stitching guide examples. `eleven_v4_turbo` and `eleven_v3_conversational`: **not stated.** |
| `POST /v1/text-to-dialogue/stream` | default `eleven_v3`; "Eleven v4 is available via the Text to Dialogue API". Body is `inputs: [{ text, voice_id }]`. |
| `wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input` | `model_id` must start with `eleven_v3` or `eleven_v4`; default `eleven_v3_conversational`. "Use `eleven_v4_turbo` through the Text to Dialogue WebSocket." |
| `wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input` | Flash, Multilingual v2. "No `eleven_v3` or `eleven_v4` on this endpoint." |

Resolve the Turbo question in one call (HTTP 200 means use it on the simple HTTP path):

```sh
curl -sS -o turbo.mp3 -w "%{http_code} ttfb=%{time_starttransfer}s\n" \
  -X POST "https://api.elevenlabs.io/v1/text-to-speech/$VOICE_ID/stream?output_format=mp3_44100_128" \
  -H "xi-api-key: $ELEVENLABS_API_KEY" -H "Content-Type: application/json" \
  -d '{"text":"[low, amused] You lost, or just stupid?","model_id":"eleven_v4_turbo"}'
```

Audio tags:
- Work on the v3 and v4 families [doc]: "Eleven v4 and Eleven v3 allow the use of non-speech audio events ... wrapped in square brackets." Tags are free-form natural language, not an enum: `[whispers]`, `[sighs]`, `[sarcastic]`, `[annoyed] [under his breath]`, `[low, gravelly voice]`.
- Flash v2.5 and Multilingual v2: no tag support is documented. Their section says to steer emotion with narrative text, and that such text "will be spoken out by the model". Assume a bracket tag is read aloud or ignored. Use punctuation, capitals, and `<break time="1.0s" />` (max 3 s) instead.
- v3 and v4 do not support SSML `<break>` tags. Use ellipses and tags.
- A tag can be misread as a sound effect on v4; write tags that clearly describe a voice quality.

Body fields:

| Field | Notes |
| --- | --- |
| `text` | required |
| `model_id` | default `eleven_multilingual_v2`; always set it |
| `voice_settings` | see below |
| `language_code` | ISO 639-1; ignored by multilingual_v2 |
| `seed` | 0..4294967295, best effort |
| `previous_text`, `next_text` | prosody continuity |
| `previous_request_ids`, `next_request_ids` | max 3 each; override the `*_text` fields when both are sent |
| `apply_text_normalization` | `auto` (default) / `on` / `off` |
| `audio_effects` | `{ filter_preset_id, distance, environment_id, background_noise_id, send_level, pan }`; free; ids from `GET /v1/audio-effects/catalog` |
| `pronunciation_dictionary_locators`, `use_pvc_as_ivc` | |

`voice_settings`:

| Field | Default | Notes |
| --- | --- | --- |
| `stability` | 0.5 | lower = wider emotional range |
| `similarity_boost` | 0.75 | |
| `style` | 0 | non-zero "might increase latency" |
| `use_speaker_boost` | true | "increases latency" slightly |
| `speed` | 1.0 | 0.7 to 1.2 per the best-practices page |
| `clone_strength` | null | v4 Professional Voice Clones only |

On v4: "Both variants use two voice settings: Stability and Similarity ... Style and Speed sliders are not available in Eleven v4". So `style` and `speed` only do anything on v2/Flash (v3 not specified). The Text to Dialogue endpoints name the field `settings.similarity`, not `similarity_boost`.

Query parameters:
- `output_format` (default `mp3_44100_128`). Allowed: `mp3_22050_32`, `mp3_24000_48`, `mp3_44100_32`, `mp3_44100_64`, `mp3_44100_96`, `mp3_44100_128`, `mp3_44100_192` (Creator plan and up), `pcm_8000` ... `pcm_48000` (`pcm_44100` needs Pro), `ulaw_8000`, `alaw_8000`, `opus_48000_32` ... `opus_48000_192`.
- `optimize_streaming_latency`: still in the reference but marked **deprecated**; the July 13 changelog documents the agent-side setting as a no-op. Do not send it.
- `enable_logging=false`: zero retention, Enterprise only; disables stitching.

For an HTML `<audio>` element use `mp3_44100_128`, or `mp3_44100_64` to shave bytes. [unverified, browser knowledge, not from ElevenLabs docs] `audio.src = "/api/tts?..."` pointing at a GET route that returns chunked `audio/mpeg` starts playing progressively in all major browsers. If the route must be POST, feed the fetch stream into MediaSource (`audio/mpeg` works in Chrome and Safari, not Firefox) or decode with Web Audio.

Request stitching:
- `previous_text` / `next_text`: free-text context. For this app, pass the NPC's previous line as `previous_text`.
- `previous_request_ids`: up to 3; the id comes from the `request-id` response header. More than 3 returns 400.
- "Request stitching is not available for the `eleven_v3` model." The guide's examples use `eleven_v4`.
- Text to Dialogue equivalents: `previous_text` / `future_text` (max 100 chars each), "Not supported by every model".

Minimal Worker call:

```ts
export async function ttsStream(env: Env, voiceId: string, text: string, previousText?: string) {
  const r = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        text,                                   // e.g. "[low, mocking] Nobody's coming, sweetheart."
        model_id: "eleven_v4",                  // or "eleven_v4_turbo" if the curl test above returns 200; "eleven_flash_v2_5" without tags
        voice_settings: { stability: 0.4, similarity_boost: 0.75 },
        previous_text: previousText,
      }),
    },
  );
  if (!r.ok) throw new Error(`tts ${r.status}: ${await r.text()}`);
  return r;                                     // r.body is the live mp3 stream; see section 4.5
}
```

If Turbo is WebSocket-only, the protocol is [doc]:
1. Connect `wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input?model_id=eleven_v4_turbo&output_format=mp3_44100_128`.
2. First message: `{ "voices": ["<voice_id>"], "xi_api_key": "<key>", "voice_settings": { ... } }` (auth may instead be the `xi-api-key` header or a `single_use_token` query parameter). Turbo allows exactly one registered voice.
3. Send `{ "inputs": [{ "text": "...", "voice_id": "<voice_id>", "new_turn": true }] }`.
4. The server buffers until about 40 characters and 8 words. **A sub-20-word line can sit in the buffer**, so follow it with `{ "flush": true }`, or `{ "close_socket": true }` to flush and end.
5. Messages back: `{ "audio": "<base64>" }` chunks, then `{ "is_final": true }`. Errors arrive as `{ "error": ... }`.
6. The connection drops after 20 s with no client message; send `{ "keep_alive": true }` to hold it.
7. Each open connection holds one "dialogue session" for its whole lifetime (separate pool, table in 3e).

Docs conflict: the API reference says "For `eleven_v3_conversational` and `eleven_v4` models, only one voice ID may be registered"; the guide says `eleven_v4` supports up to 10 and only `eleven_v4_turbo` is limited to one. Irrelevant with one voice per connection.

### 3c. Sound effects

Endpoint: `POST https://api.elevenlabs.io/v1/sound-generation` (JSON in, audio file out).

| Field | Type | Notes |
| --- | --- | --- |
| `text` | string, required | the prompt |
| `model_id` | enum | `eleven_text_to_sound_v2` (default, **deprecated, removed 2027-03-01**) or `eleven_text_to_sound_v3` |
| `duration_seconds` | number or null | "at least 0.5 and at most 30"; null = model picks. (The capability page says 0.1 to 30; trust the API reference.) |
| `prompt_influence` | number | 0 to 1, default 0.3 |
| `loop` | boolean | default false; "SFX v3 supports looping" |
| query `output_format` | enum | default `mp3_44100_128`; also the other mp3 rates, `opus_48000_*`, `pcm_*`, `wav_8000` ... `wav_48000`, `ulaw_8000`, `alaw_8000`. 44.1 kHz PCM/WAV needs Pro. |

Max 30 s per generation. Key facts: "MP3 for all effects; WAV at 48 kHz for non-looping effects". For longer ambience generate a 30 s loop and repeat it client-side.

```ts
// scripts/gen-sfx.ts  (Node 20+, run once, commit the files into public/sfx/)
import { writeFile } from "node:fs/promises";

const SFX = [
  { file: "street-night-loop.mp3", text: "Quiet city street at night, distant traffic, light wind", duration_seconds: 30, loop: true },
  { file: "footsteps-approach.mp3", text: "Slow heavy footsteps on wet pavement approaching", duration_seconds: 4, loop: false },
];

for (const s of SFX) {
  const r = await fetch("https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128", {
    method: "POST",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY!, "content-type": "application/json" },
    body: JSON.stringify({
      text: s.text,
      model_id: "eleven_text_to_sound_v3",
      duration_seconds: s.duration_seconds,
      prompt_influence: 0.3,
      loop: s.loop,
    }),
  });
  if (!r.ok) throw new Error(`${s.file}: ${r.status} ${await r.text()}`);
  await writeFile(`public/sfx/${s.file}`, Buffer.from(await r.arrayBuffer()));
}
```

Prompting v3: describe action, setting and atmosphere ("Footsteps on gravel approaching slowly"), not a category. Exact repeat counts are not reliably followed.

### 3d. Voices

List: `GET https://api.elevenlabs.io/v2/voices` (auth required). Useful query params: `page_size` (max 100, default 10), `next_page_token`, `search`, `voice_type` (`personal` / `community` / `default` / `workspace` / `non-default` / `non-community` / `saved`), `category` (`premade` / `cloned` / `generated` / `professional`), `gender`, `age`, `accent`, `language`, `use_cases`. Response: `{ voices: [{ voice_id, name, category, labels, description, preview_url, ... }], has_more, total_count, next_page_token }`.

```sh
curl -s "https://api.elevenlabs.io/v2/voices?voice_type=default&page_size=100" -H "xi-api-key: $ELEVENLABS_API_KEY" \
  | jq -r '.voices[] | [.voice_id, .name, .labels.gender, .labels.age, .labels.accent] | @tsv'
```

**Default voices are being retired** [doc]: "All our Default voices will expire on December 31, 2026 ... Default voices are only available for accounts that were created before March 2026." The replacements are Voice Library voices, and "Voice Library voices are not available via the API to free tier users."

Current premade voices ([observed] from unauthenticated `GET https://api.elevenlabs.io/v1/voices` on 2026-11-12: 21 voices) with the official replacement from the help-center table:

| Default voice (expires 2026-12-31) | voice_id | Labels (gender / age / accent) | Replacement name | Replacement voice_id |
| --- | --- | --- | --- | --- |
| Roger - Laid-Back, Casual, Resonant | `CwhRBWXzGAHq8TQ4Fs17` | male / middle_aged / american | Darian - Warm Grounded Storyteller | `gOupLcAkjEnguROwi4oS` |
| Sarah - Mature, Reassuring, Confident | `EXAVITQu4vr4xnSDxMaL` | female / young / american | Talia - Warm Soft Guide | `OZ0L6eISlOejga3XjDFt` |
| Laura - Enthusiast, Quirky Attitude | `FGY2WhTYpPnrIDTdsKH5` | female / young / american | Elara - Crisp Pro Narrator | `WQP7cQUF5aAS6Axh5yaa` |
| Charlie - Deep, Confident, Energetic | `IKne3meq5aSn9XLyUdCD` | male / young / australian | Baxter - Dry Calm Aussie | `jSuBIjxMKhqIfb0wCK1F` |
| George - Warm, Captivating Storyteller | `JBFqnCBsd6RMkjVDRZzb` | male / middle_aged / british | Eldrin - Crisp British Baritone | `6WwXjDDEMyNmFG95zycZ` |
| Callum - Husky Trickster | `N2lVS1w4EtoT3dr4eOWO` | male / middle_aged / american | Callum - Husky Trickster | `fs2OqxduwXgp9foh2xjK` |
| River - Relaxed, Neutral, Informative | `SAz9YHcvj6GT2YYXdXww` | neutral / middle_aged / american | Elowen - Upbeat Modern Narrator | `dvbL7qkNGZY1IqPGZAjM` |
| Harry - Fierce Warrior | `SOYHLrjzK2X1ezoPC6cr` | male / young / american | Kaelen - Amateur Warrior | `10NkTYmU7tSz3Kkl3Lex` |
| Liam - Energetic, Social Media Creator | `TX3LPaxmHKxFdv7VOQHJ` | male / young / american | Lawrence - Bright and Informative | `ktkP7Nsj67dw2zcplQYt` |
| Alice - Clear, Engaging Educator | `Xb7hH8MSUJpSbSDYk0k2` | female / middle_aged / british | Alicia - Polished Global Anchor | `BFd5oBc2DDna33pSi4Gf` |
| Matilda - Knowledgable, Professional | `XrExE9yKIg1WjnnlVkGX` | female / middle_aged / american | Maisie - Friendly Casual Neighbor | `QtY3JBOUKEB5xzrRfOKc` |
| Will - Relaxed Optimist | `bIHbv24MWmeRgasZH58o` | male / young / american | Warren - Effortless and Cool | `7QN34D2r3hCNwbOYIeK0` |
| Jessica - Playful, Bright, Warm | `cgSgspJ2msm6clMCkdW9` | female / young / american | Jade - Upbeat and Natural | `g7LVvkPWALzPxOQbF6OE` |
| Eric - Smooth, Trustworthy | `cjVigY5qzO86Huf0OWal` | male / middle_aged / american | Eddie - Natural and Helpful | `l7kNoIfnJKPg7779LI2t` |
| Bella - Professional, Bright, Warm | `hpp4J3VqNfWAUOO0d1Us` | female / middle_aged / american | none listed | |
| Chris - Charming, Down-to-Earth | `iP95p4xoKVk53GoZ742B` | male / middle_aged / american | Caleb - Trusted Guide | `AaOhDHYJ1XLZk74lXhdE` |
| Brian - Deep, Resonant and Comforting | `nPczCjzI2devNBz1zQrb` | male / middle_aged / american | Sawyer - Midnight Storyteller | `8dEUmyPMdDdK91vboYih` |
| Daniel - Steady Broadcaster | `onwK4e9ZLuTAKqWW03F9` | male / middle_aged / british | Finley - Articulate Anchor | `fnYMz3F5gMEDGMWcH1ex` |
| Lily - Velvety Actress | `pFZP5JQG7iQjIQuC4Bku` | female / middle_aged / british | Florence - Atmospheric Storyteller | `22N9cF8z0o7y23njdyaY` |
| Adam - Dominant, Firm | `pNInz6obpgDQGcFmaJgB` | male / middle_aged / american | none listed | |
| Bill - Wise, Mature, Balanced | `pqHfZKP75CvOlQylNhV4` | male / old / american | Wyatt - Seasoned Mentor | `FrS6cKLB1wg4WYgPa9GW` |

Recommendations. These are picked from the label and description text only. I could not listen to anything, and I could not read metadata for the replacement voices (needs a key), so I only know their names. Audition before committing.

(i) American man, 30s, casual, rough street delivery:

| Rank | Voice | Default id | Replacement id | Why |
| --- | --- | --- | --- | --- |
| 1 | Callum - Husky Trickster | `N2lVS1w4EtoT3dr4eOWO` | `fs2OqxduwXgp9foh2xjK` | Description: "Deceptively gravelly, yet unsettling edge." Closest to rough and menacing. Labeled middle-aged. |
| 2 | Chris - Charming, Down-to-Earth | `iP95p4xoKVk53GoZ742B` | `AaOhDHYJ1XLZk74lXhdE` (Caleb - Trusted Guide) | Labeled `casual`, "Natural and real". Casual first, add roughness with tags. The replacement's name suggests a gentler read. |
| 3 | Harry - Fierce Warrior | `SOYHLrjzK2X1ezoPC6cr` | `10NkTYmU7tSz3Kkl3Lex` (Kaelen - Amateur Warrior) | Only male American voice labeled `rough`, and young. Described as an "animated warrior", so it may be too theatrical. |
| alt | Adam - Dominant, Firm | `pNInz6obpgDQGcFmaJgB` | none | "brash ... slightly aggressive self-assurance". No replacement, so it disappears on Dec 31. |

(ii) Young American woman, soft, tense inner monologue:

| Rank | Voice | Default id | Replacement id | Why |
| --- | --- | --- | --- | --- |
| 1 | Sarah - Mature, Reassuring, Confident | `EXAVITQu4vr4xnSDxMaL` | `OZ0L6eISlOejga3XjDFt` (Talia - Warm Soft Guide) | Young, American; the replacement is the only one with "Soft" in its name. |
| 2 | Jessica - Playful, Bright, Warm | `cgSgspJ2msm6clMCkdW9` | `g7LVvkPWALzPxOQbF6OE` (Jade - Upbeat and Natural) | Young, American, conversational. Bright by default; needs tags to go tense. |
| 3 | Laura - Enthusiast, Quirky Attitude | `FGY2WhTYpPnrIDTdsKH5` | `WQP7cQUF5aAS6Axh5yaa` (Elara - Crisp Pro Narrator) | Young, American. Weakest fit; the replacement sounds like a narrator. |

No premade voice is labeled soft or tense. On v3/v4, get the inner-monologue read from tags such as `[whispering]`, `[quiet, tense]`, `[under her breath]`. If none of the three convinces, search the Voice Library (`GET /v1/shared-voices`, auth required) or use Voice Design; note the docs say Voice Design voices "may be less performative" on v4.

### 3e. Limits and cost

Concurrency by plan [doc, models page]:

| Plan | Multilingual v2 | Flash | STT | Realtime STT | SFX | TTD WebSocket sessions |
| --- | --- | --- | --- | --- | --- | --- |
| Free | 2 | 4 | 8 | 6 | 4 | 14 |
| Starter | 3 | 6 | 12 | 9 | 4 | 21 |
| Creator | 5 | 10 | 20 | 15 | 6 | 35 |
| Pro | 10 | 20 | 40 | 30 | 6 | 70 |
| Scale / Business | 15 | 30 | 60 | 45 | 8 | 105 |

- The table has no v3 or v4 column, so which TTS limit applies to `eleven_v4` over HTTP is not stated.
- Over the limit, requests queue ("typically only adds ~50ms") or fail with HTTP 429, `code` = `concurrent_limit_exceeded`, `rate_limit_exceeded` or `system_busy`. No requests-per-minute numbers are published.
- Response headers: `current-concurrent-requests`, `maximum-concurrent-requests`, `character-cost`, `request-id`.
- HTTP requests count against concurrency for their full duration. The TTS WebSocket counts only while generating.

Price [pricing/api page]: "API usage is billed in US dollars, not credits."

| Product | Rate | Included on Free / Starter $6 / Creator $22 / Pro $99 |
| --- | --- | --- |
| TTS `eleven_v4`, `eleven_v3`, `eleven_multilingual_v2` | $0.08 per 1K characters | 10K / 75K / 275K / 1.238M chars |
| TTS `eleven_v4_turbo`, `eleven_v3_conversational`, Flash | $0.04 per 1K characters | 20K / 150K / 550K / 2.475M chars |
| STT `scribe_v3`, `scribe_v2` | $0.20 per audio hour (keyterms +$0.05/h, transcript edit +$0.07/h) | 4.5 h / 30 h / 110 h / 495 h |
| STT realtime (`scribe_v3_live`, `scribe_v2_realtime`) | $0.22 per audio hour | 2.5 h on Free |
| Sound effects | $0.12 per minute of audio | 8 / 150 / 605 / 3,000 generations |

Per turn (6 s clip in, 100-character line out on v4): STT about $0.0003 + TTS about $0.008. TTS dominates; Turbo or Flash halves it.

Inconsistencies to be aware of:
- The pricing page says dollars; the SFX capability page still says "40 credits per second when duration is specified" and the help center still talks in credits.
- The pricing page advertises Flash at "~75ms" and v3 Conversational at "~280ms"; the docs' latency page (updated 2026-10-29) says ~100 ms and ~165 ms.
- Free plan: no commercial rights, and Voice Library voices are not usable via the API.

### 3f. Authentication

- Header: `xi-api-key: <ELEVENLABS_API_KEY>` on every request. "Do not share it with others or expose it in any client-side code." Keys can be scoped to endpoints, given a credit quota, and IP-allowlisted. [inferred] Workers have no fixed egress IPs, so do not enable IP allowlisting on this key.
- Single-use tokens: `POST https://api.elevenlabs.io/v1/single-use-token/{token_type}` with `xi-api-key`; `token_type` is `realtime_scribe`, `batch_scribe` or `tts_websocket`. Returns `{ "token": "..." }`: "expires after 15 minutes. Will be consumed on use."
  - `batch_scribe`: browser calls `POST /v1/speech-to-text?token=<token>` directly (added 2026-07-20).
  - `tts_websocket`: browser opens the TTS WebSocket directly (Flash / Multilingual only).
  - There is no token type for the HTTP TTS stream endpoint, so `eleven_v4` over HTTP must go through the Worker. The Text to Dialogue WebSocket accepts a `single_use_token`, but the docs do not say which `token_type` to mint for it.

---

## 4. Cloudflare project setup

Verified from:
- https://developers.cloudflare.com/workers/vite-plugin/ , `/get-started/` , `/reference/api/` , `/reference/static-assets/` , `/reference/secrets/` , `/v2-beta/` , `/vite-plus/`
- https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/ , `/routing/worker-script/`
- https://developers.cloudflare.com/workers/framework-guides/web-apps/react/
- https://developers.cloudflare.com/durable-objects/get-started/ , https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/ , https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/ , https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/
- https://developers.cloudflare.com/workers/local-development/ (remote bindings) , https://developers.cloudflare.com/workers/wrangler/configuration/ , https://developers.cloudflare.com/workers/configuration/secrets/ , https://developers.cloudflare.com/workers/configuration/compatibility-dates/
- https://developers.cloudflare.com/workers/runtime-apis/streams/ , https://developers.cloudflare.com/workers/runtime-apis/rpc/ , https://developers.cloudflare.com/workers/languages/typescript/

### 4.1 What changed since older tutorials

- **Durable Object classes are declared in `exports`**, announced 2026-06-30. The `migrations` array is now "legacy" but "remains fully supported". A Worker can use only one of the two, and "Once a Worker has been deployed with `exports`, subsequent deploys cannot return to the legacy `migrations` array."
- The Vite plugin docs describe **v1 as current stable** (`wrangler.jsonc`, deploy with `wrangler deploy`). A v2 beta exists (`cloudflare.config.ts`, `cf deploy`, Vite 7+); do not start on it.
- `assets.directory` is not needed with the Vite plugin; it fills it in at build time.
- Selective `run_worker_first` arrays need Wrangler >= 4.20.0 and Vite plugin >= 1.7.0.
- Types: generate with `wrangler types` (writes `worker-configuration.d.ts`) rather than installing `@cloudflare/workers-types`.

### 4.2 `wrangler.jsonc`

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "oneinthree",
  "main": "./worker/index.ts",
  // Docs: "you should always set compatibility_date to the current date" when starting a project.
  "compatibility_date": "2026-11-12",
  "upload_source_maps": true,

  "assets": {
    // no "directory": the Vite plugin points it at the client build output
    "not_found_handling": "single-page-application",
    "binding": "ASSETS",
    "run_worker_first": ["/api/*"]
  },

  // Workers AI always runs remotely, also in `vite dev`. remote:true silences the warning; remote:false is an error.
  "ai": { "binding": "AI", "remote": true },

  "durable_objects": {
    "bindings": [{ "name": "SESSION", "class_name": "SessionDO" }]
  },

  // Current way to register a SQLite-backed Durable Object class.
  "exports": {
    "SessionDO": { "type": "durable-object", "storage": "sqlite" }
  },

  // Declares required secret names: validated in dev and on deploy, and used by `wrangler types`.
  "secrets": { "required": ["ELEVENLABS_API_KEY"] },

  "observability": { "enabled": true }
}
```

Legacy alternative, exactly what you asked for. Use it **instead of** the `exports` block, never alongside:

```jsonc
{
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["SessionDO"] }
  ]
}
```

Recommendation: use `exports` for a new Worker. The docs do not state a minimum Wrangler version for it, so install the latest `wrangler` and `@cloudflare/vite-plugin`. If `vite dev` rejects the `exports` key, fall back to the `migrations` block before the first deploy (the choice is one-way after deploying with `exports`).

State of this repo when this was written (read only, not modified): `wrangler.jsonc` already exists and uses the legacy `migrations` + `new_sqlite_classes` block, with `wrangler ^4.161.0` and `@cloudflare/vite-plugin ^1.69.1`. That is valid and can stay; just do not add a Durable Object entry under `exports` next to it. Two small gaps against the docs: its `ai` binding has no `"remote": true` (works, but logs a warning), and `compatibility_date` is `2026-11-01` rather than today.

Notes:
- `run_worker_first: ["/api/*"]`: those paths always hit the Worker; everything else is asset-first with SPA fallback to `/index.html`. Using the array form "disables the automatic `Sec-Fetch-Mode: navigate` detection", so `/api/*` reaches the Worker even when a browser navigates to it or an `<audio src>` requests it.
- With `secrets.required` set, "only the keys listed in `secrets.required` are loaded from `.dev.vars`". Add every secret name there.

### 4.3 `vite.config.ts`, `package.json`, secrets

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [cloudflare({ viteEnvironment: { name: "worker" } })],
  environments: {
    worker: { build: { sourcemap: true } },
  },
});
```

```json
{
  "name": "oneinthree",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "preview": "npm run build && vite preview",
    "deploy": "npm run build && wrangler deploy",
    "types": "wrangler types"
  }
}
```

```sh
npm i -D vite @cloudflare/vite-plugin wrangler typescript
npx wrangler login                 # needed even for local dev: the AI binding calls your account
npx wrangler types                 # generates worker-configuration.d.ts (Env + runtime types)
cp .dev.vars.example .dev.vars     # ELEVENLABS_API_KEY=...   (dotenv syntax, same folder as wrangler.jsonc)
npm run dev
npx wrangler secret put ELEVENLABS_API_KEY   # production secret, once
```

Layout: `index.html` + `src/main.ts` (client; the root `index.html` is what makes the plugin build a client environment), `worker/index.ts` (Worker + Durable Object), `public/sfx/*.mp3` (pre-generated effects, served as static assets).

Secrets in dev: "Put secrets for use in local development in either a `.dev.vars` file or a `.env` file". Use one or the other; if `.dev.vars` exists, `.env` is ignored. `vite build` copies `.dev.vars` into the output only for `vite preview`; it "is not deployed with your Worker".

### 4.4 AI binding in local dev

- [doc] "By default, bindings connect to local resource simulations (except for AI bindings, as AI models always run remotely)." "There is no current local simulation for Workers AI."
- [doc] If `remote` is omitted on the AI binding: connects remotely and warns. If `remote: false`: error. So set `"remote": true`. **No CLI flag is needed.**
- The Vite plugin's `remoteBindings` option defaults to `true`.
- [doc] "Using Workers AI always accesses your Cloudflare account ... and will incur usage charges even in local development", and local calls count toward rate limits.
- Durable Objects always run locally in dev (cannot be remote); a local DO can still call the remote AI binding. State persists in `.wrangler/state`.

### 4.5 Worker + SQLite Durable Object + streaming ElevenLabs audio straight through

[doc] "If your Worker only forwards subrequest responses to the client verbatim without reading their body text, then its body handling is already optimal." Hand `upstream.body` to a new `Response` and never `await` the body.

```ts
// worker/index.ts
import { DurableObject } from "cloudflare:workers";

export class SessionDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        player_text TEXT NOT NULL,
        move TEXT NOT NULL,
        stance TEXT NOT NULL,
        npc_line TEXT NOT NULL
      )`);
  }

  // fetch() handler because we return a streaming Response.
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/tts") && request.method === "GET") {
      const text = url.searchParams.get("text") ?? "";
      const voiceId = url.searchParams.get("voice") ?? "fs2OqxduwXgp9foh2xjK";

      const upstream = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128`,
        {
          method: "POST",
          headers: { "xi-api-key": this.env.ELEVENLABS_API_KEY, "content-type": "application/json" },
          body: JSON.stringify({ text, model_id: "eleven_v4" }),
        },
      );
      if (!upstream.ok || !upstream.body) {
        return new Response(await upstream.text(), { status: 502 });
      }
      // Pass the body through untouched: bytes reach the browser as ElevenLabs produces them.
      return new Response(upstream.body, {
        headers: { "content-type": "audio/mpeg", "cache-control": "no-store" },
      });
    }

    return new Response("not found", { status: 404 });
  }

  // Plain RPC method for non-streaming work.
  async recordTurn(t: { playerText: string; move: string; stance: string; npcLine: string }) {
    this.ctx.storage.sql.exec(
      "INSERT INTO turns (ts, player_text, move, stance, npc_line) VALUES (?, ?, ?, ?, ?)",
      Date.now(), t.playerText, t.move, t.stance, t.npcLine,
    );
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    // /api/session/<id>/...  ->  one Durable Object per session
    const m = url.pathname.match(/^\/api\/session\/([\w-]+)\//);
    if (m) {
      const stub = env.SESSION.getByName(m[1]);
      return stub.fetch(request);          // the stream is forwarded as-is through the Worker
    }
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

Client side: `new Audio("/api/session/" + id + "/tts?voice=...&text=" + encodeURIComponent(line)).play()`.

Notes:
- [doc] Workers RPC can also carry `ReadableStream` ("with automatic streaming flow control") and `Response` objects, so `stub.speak(text)` returning a `Response` is an alternative to `stub.fetch`.
- [inferred] While audio streams through the Durable Object it stays active (and bills duration) for the length of the stream. A leaner split: the DO returns `{ line, voiceId }` as JSON and the stateless Worker makes the ElevenLabs call and streams it. Same code, moved out of the class.
- [unverified] GET with the text in the query string is the simplest thing an `<audio>` element can consume, but it puts dialogue text in URLs and logs. If that matters, have the DO store the line and expose `/tts?turn=<id>`.
- To change the stream on the way through (not needed here), pipe through a `TransformStream` and do not `await` the `pipeTo`.

---

## 5. Surprises and open questions

1. Workers AI catalog purge on 2026-11-20 removes most small Llama/Qwen models that older guides recommend (section 2.1).
2. ElevenLabs Default (premade) voices expire 2026-12-31 and are hidden from accounts created after March 2026; replacements are Voice Library voices, which the free tier cannot use via API (3d).
3. `eleven_v4_turbo` over plain HTTP streaming is undocumented; docs route it through the Text to Dialogue WebSocket, which buffers short lines unless flushed (3b). One curl settles it.
4. Clef has no enum/boolean/number types; they are `choice` / `noul` / `score`, and `model` must be repeated inside the body (1.2, 1.3).
5. clef-omni audio is documented for WAV/MP3 only; MediaRecorder's webm/opus is unconfirmed (1.8). ElevenLabs STT does accept webm/opus (3a).
6. Two incompatible `json_schema` shapes across Workers AI models, and a stale JSON Mode supported-models list (2.5).
7. Durable Object `exports` replaces `migrations`; one-way once deployed; no minimum Wrangler version stated (4.1, 4.2).
8. No published latency for batch Scribe or for `eleven_v4`; no published latency for any Workers AI text model. All three need measuring.
9. ElevenLabs pricing page (dollars; Flash ~75 ms) and docs (credits in places; Flash ~100 ms) disagree (3e).
10. Voice picks are from metadata only; nothing was auditioned, and replacement-voice metadata could not be read without a key (3d).
11. Whether `env.AI.run` TypeScript types already include the Clef model ids was not checked; samples cast to `any`.
