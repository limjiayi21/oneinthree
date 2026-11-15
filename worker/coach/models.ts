/**
 * Which model runs the coach.
 *
 *   gemini (default when GEMINI_API_KEY is set): Gemini API (Google AI Studio)
 *     chat:       COACH_MODEL or gemini-3.6-flash, falling back to
 *                 gemini-flash-lite-latest when a call fails or takes over 30 s
 *                 (busy models answer 503 or hang)
 *     embeddings: gemini-embedding-001
 *   openai (the fallback when Gemini fails; first when only OPENAI_API_KEY is set, or COACH_PROVIDER=openai)
 *     chat:       COACH_MODEL or gpt-5.4-mini
 *     embeddings: text-embedding-3-small
 *     OPENAI_BASE_URL points it at any OpenAI-compatible service instead
 *     (for example a self-hosted or Vultr inference endpoint).
 */
import { ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { modelFallbackMiddleware, type AgentMiddleware } from 'langchain';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import type { Embedder } from './knowledge';

/**
 * The Gemini SDK accepts only a subset of JSON Schema: no unions (deepagents'
 * grep tool has `type: ["string", "null"]` and `anyOf`) and no keywords such
 * as `exclusiveMinimum`. Rewrite unions as `nullable` and keep only the
 * fields Gemini knows, before the tools are sent.
 */
const GEMINI_KEYS = new Set(['type', 'format', 'description', 'nullable', 'enum', 'properties', 'required', 'items', 'minItems', 'maxItems', 'minimum', 'maximum']);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function geminiSchema(node: any): any {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let src: any = { ...node };
  for (const key of ['anyOf', 'oneOf'] as const) {
    if (!Array.isArray(src[key])) continue;
    const options = src[key].filter((o: { type?: string }) => o?.type !== 'null');
    const nullable = options.length < src[key].length;
    const { [key]: _drop, ...rest } = src;
    src = { ...rest, ...(options[0] ?? { type: 'string' }), ...(nullable ? { nullable: true } : {}) };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any = {};
  for (const [k, v] of Object.entries(src)) {
    if (!GEMINI_KEYS.has(k)) continue;
    if (k === 'properties' && v && typeof v === 'object') out.properties = Object.fromEntries(Object.entries(v).map(([name, sub]) => [name, geminiSchema(sub)]));
    else if (k === 'items') out.items = geminiSchema(v);
    else out[k] = v;
  }
  if (Array.isArray(out.type)) {
    const types = out.type.filter((t: string) => t !== 'null');
    if (types.length < out.type.length) out.nullable = true;
    out.type = types[0] ?? 'string';
  }
  if (out.type === 'integer' || out.type === 'number') {
    if (typeof src.exclusiveMinimum === 'number' && out.minimum === undefined) out.minimum = src.exclusiveMinimum;
    if (typeof src.exclusiveMaximum === 'number' && out.maximum === undefined) out.maximum = src.exclusiveMaximum;
  }
  return out;
}

class GeminiChat extends ChatGoogleGenerativeAI {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override bindTools(tools: any[], kwargs?: any) {
    const clean = tools.map((t) => {
      const fn = convertToOpenAITool(t).function;
      return { type: 'function' as const, function: { ...fn, parameters: geminiSchema(fn.parameters) } };
    });
    return super.bindTools(clean, kwargs);
  }

  /** A busy Gemini model can hang without answering: give up after CALL_TIMEOUT_MS so the fallback takes over. */
  override async _generate(messages: BaseMessage[], options: this['ParsedCallOptions'], runManager?: CallbackManagerForLLMRun): Promise<ChatResult> {
    const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    return super._generate(messages, { ...options, signal }, runManager);
  }
}

const CALL_TIMEOUT_MS = 30_000;

export interface ModelEnv {
  GEMINI_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  COACH_PROVIDER?: string;
  COACH_MODEL?: string;
}

export type Provider = 'gemini' | 'openai';

export const DEFAULTS = {
  gemini: { chat: 'gemini-3.6-flash', fallback: 'gemini-flash-lite-latest', embed: 'gemini-embedding-001' },
  openai: { chat: 'gpt-5.4-mini', embed: 'text-embedding-3-small' },
} as const;

/**
 * The providers to try, in order: Gemini first, then OpenAI as the fallback (each only when its key is
 * set). COACH_PROVIDER moves one to the front. Empty when no key is set (the coach is then off).
 */
export function pickProviders(env: ModelEnv): Provider[] {
  const order: Provider[] = [];
  const want = env.COACH_PROVIDER?.toLowerCase();
  if (want === 'openai' && env.OPENAI_API_KEY) order.push('openai');
  if (env.GEMINI_API_KEY) order.push('gemini');
  if (env.OPENAI_API_KEY && !order.includes('openai')) order.push('openai');
  return order;
}

/** The first provider to try, or null when no key is set. */
export function pickProvider(env: ModelEnv): Provider | null {
  return pickProviders(env)[0] ?? null;
}

export function createModels(env: ModelEnv, provider: Provider): { model: BaseChatModel; embed: Embedder; embedName: string; name: string; middleware: AgentMiddleware[] } {
  if (provider === 'gemini') {
    const name = env.COACH_MODEL || DEFAULTS.gemini.chat;
    const chat = (m: string) => new GeminiChat({ model: m, apiKey: env.GEMINI_API_KEY, temperature: 0.4, maxRetries: 1 });
    const model = chat(name);
    const middleware = name === DEFAULTS.gemini.fallback ? [] : [modelFallbackMiddleware(chat(DEFAULTS.gemini.fallback))];
    const embeddings = new GoogleGenerativeAIEmbeddings({ model: DEFAULTS.gemini.embed, apiKey: env.GEMINI_API_KEY });
    return { model, name, middleware, embedName: DEFAULTS.gemini.embed, embed: (texts) => (texts.length === 1 ? embeddings.embedQuery(texts[0]).then((v) => [v]) : embeddings.embedDocuments(texts)) };
  }
  const name = env.COACH_MODEL || DEFAULTS.openai.chat;
  const configuration = env.OPENAI_BASE_URL ? { baseURL: env.OPENAI_BASE_URL } : undefined;
  // The Responses API: reasoning models take tools there with a reasoning effort, not on chat completions.
  const model = new ChatOpenAI({ model: name, apiKey: env.OPENAI_API_KEY, configuration, reasoning: { effort: 'low' }, useResponsesApi: !env.OPENAI_BASE_URL, maxRetries: 2 });
  const embeddings = new OpenAIEmbeddings({ model: DEFAULTS.openai.embed, apiKey: env.OPENAI_API_KEY, configuration });
  return { model, name, middleware: [], embedName: DEFAULTS.openai.embed, embed: (texts) => (texts.length === 1 ? embeddings.embedQuery(texts[0]).then((v) => [v]) : embeddings.embedDocuments(texts)) };
}
