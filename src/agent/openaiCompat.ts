// OpenAIChatModel: one adapter for every free provider that speaks the
// OpenAI-compatible Chat Completions API (Gemini via Google AI Studio, Groq,
// local Ollama). Relay's loop works in Anthropic-style content blocks, so this
// file translates both ways and handles free-tier rate limits.
//
// Plain fetch, no SDK: three providers, one small wire format.

import type Anthropic from '@anthropic-ai/sdk';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { ModelClient, ModelRequest, ModelResponse } from './model.ts';

type OAMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OAToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
type OAToolCall = { id: string; type: 'function'; function: { name: string; arguments: string }; extra_content?: unknown };

export class QuotaExhaustedError extends Error {
  constructor(provider: string, detail: string) {
    super(`${provider} free-tier quota is used up for now (${detail}). Wait for it to reset, then resume the run.`);
  }
}

export class ProviderError extends Error {}

export type ProviderConfig = {
  provider: string;
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  /** Client-side cap on requests per minute, to stay under free-tier limits. 0 = no cap. */
  rpm: number;
  /** Strip JSON-schema keywords the provider rejects. */
  sanitizeSchema?: (schema: any) => any;
  /** Backoff step when a 429 gives no wait time (tests use a tiny value). Default 10 s. */
  backoffBaseMs?: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Longest provider-requested wait we sit through before stopping a run (it can be resumed later). */
export const MAX_RATE_LIMIT_WAIT_MS = 20 * 60_000;

/**
 * How long the provider asks us to wait, from (in order) the Retry-After
 * header, Gemini's `"retryDelay": "39s"`, or Groq's "Please try again in 7m12.5s".
 * Null when the response gives no wait time.
 */
export function providerWaitMs(retryAfterHeader: string | null, body: string): number | null {
  const header = Number(retryAfterHeader);
  if (retryAfterHeader && Number.isFinite(header) && header > 0) return header * 1000;
  const gemini = body.match(/retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)s/);
  if (gemini) return Number(gemini[1]) * 1000;
  const groq = body.match(/try again in\s+(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/i);
  if (groq && (groq[1] || groq[2] || groq[3])) {
    return ((Number(groq[1] ?? 0) * 60 + Number(groq[2] ?? 0)) * 60 + Number(groq[3] ?? 0)) * 1000;
  }
  return null;
}

/** Keep the latest rate-limit response on disk, so a stop is diagnosed from facts, not guessed. */
function recordRateLimit(provider: string, status: number, retryAfter: string | null, body: string) {
  try {
    mkdirSync('.data', { recursive: true });
    writeFileSync(`.data/last-rate-limit-${provider}.txt`, `${new Date().toISOString()} HTTP ${status} retry-after=${retryAfter}\n${body.slice(0, 4000)}\n`);
  } catch {
    // diagnostics only
  }
}

/** Remove `additionalProperties` (Gemini's compatibility layer rejects it on function parameters). */
export function stripAdditionalProperties(schema: any): any {
  if (Array.isArray(schema)) return schema.map(stripAdditionalProperties);
  if (schema && typeof schema === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(schema)) if (k !== 'additionalProperties') out[k] = stripAdditionalProperties(v);
    return out;
  }
  return schema;
}

/** Anthropic-style history -> OpenAI chat messages. Thinking blocks are dropped. */
export function toOpenAIMessages(system: string, messages: Anthropic.MessageParam[]): OAMessage[] {
  const out: OAMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content } as OAMessage);
      continue;
    }
    if (m.role === 'assistant') {
      const text = m.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
      const calls = m.content
        .filter((b: any) => b.type === 'tool_use')
        .map((b: any) => ({
          id: b.id,
          type: 'function' as const,
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          // Gemini 3 thought signatures must be sent back exactly as received.
          ...(b._providerExtra ? { extra_content: b._providerExtra } : {}),
        }));
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // user: tool results become `tool` messages; text becomes a user message after them
    const texts: string[] = [];
    for (const b of m.content as any[]) {
      if (b.type === 'tool_result') {
        const content = typeof b.content === 'string' ? b.content : (b.content ?? []).map((c: any) => c.text ?? '').join('\n');
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? `ERROR: ${content}` : content });
      } else if (b.type === 'text') {
        texts.push(b.text);
      }
    }
    if (texts.length) out.push({ role: 'user', content: texts.join('\n') });
  }
  return out;
}

const STOP_MAP: Record<string, string> = { stop: 'end_turn', tool_calls: 'tool_use', length: 'max_tokens', content_filter: 'refusal' };

export class OpenAIChatModel implements ModelClient {
  readonly offline = false;
  readonly provider: string;
  readonly modelId: string;
  private lastRequestAt = 0;

  constructor(private cfg: ProviderConfig) {
    this.provider = cfg.provider;
    this.modelId = cfg.modelId;
  }

  private async throttle(): Promise<number> {
    if (!this.cfg.rpm) return 0;
    const gap = 60_000 / this.cfg.rpm;
    const wait = Math.max(0, this.lastRequestAt + gap - Date.now());
    if (wait) await sleep(wait);
    this.lastRequestAt = Date.now();
    return wait;
  }

  async create(req: ModelRequest): Promise<ModelResponse> {
    const sanitize = this.cfg.sanitizeSchema ?? ((s: any) => s);
    const body = {
      model: this.cfg.modelId,
      messages: toOpenAIMessages(`${req.system}\n\n${req.context}`, req.messages),
      tools: req.tools.length
        ? req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: sanitize(t.input_schema) } }))
        : undefined,
      max_tokens: 4000,
    };

    let waitMs = 0;
    for (let attempt = 1; ; attempt++) {
      waitMs += await this.throttle();
      const t0 = Date.now();
      let res: Response;
      try {
        res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}) },
          body: JSON.stringify(body),
        });
      } catch (err) {
        if (attempt >= 4) throw new ProviderError(`Could not reach ${this.provider} at ${this.cfg.baseUrl}: ${(err as Error).message}`);
        await sleep(2000 * attempt);
        waitMs += 2000 * attempt;
        continue;
      }
      const requestMs = Date.now() - t0;
      const text = await res.text();

      if (res.status === 429 || res.status === 503) {
        recordRateLimit(this.provider, res.status, res.headers.get('retry-after'), text);
        // Use the wait the provider actually asks for. Wait it out when it is
        // reasonable; stop (resumable) only when it says to come back much later,
        // or when a daily quota is named and no usable wait is given.
        const asked = providerWaitMs(res.headers.get('retry-after'), text);
        const daily = /per ?day|PerDay|RPD|TPD|daily/i.test(text);
        if (asked !== null && asked > MAX_RATE_LIMIT_WAIT_MS) {
          throw new QuotaExhaustedError(this.provider, `${daily ? 'daily limit; ' : ''}provider asks to wait ${Math.round(asked / 60000)} min`);
        }
        if (asked === null && daily && attempt >= 3) throw new QuotaExhaustedError(this.provider, 'daily limit, no retry time given');
        if (attempt >= 8) throw new QuotaExhaustedError(this.provider, `still rate limited after ${attempt} tries`);
        const delay = (asked ?? Math.min(120_000, (this.cfg.backoffBaseMs ?? 10_000) * attempt)) + 500;
        await sleep(delay);
        waitMs += delay;
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new ProviderError(`${this.provider} rejected the API key (HTTP ${res.status}). Check the key in relay/.env.`);
      }
      if (!res.ok) {
        // Provider-side errors (e.g. Gemini "500 Internal error") are usually transient:
        // retry with growing waits (5, 10, 20, 40, 60 s) before giving up.
        if (res.status >= 500 && attempt < 6) {
          const delay = Math.min(60_000, 5000 * 2 ** (attempt - 1));
          await sleep(delay);
          waitMs += delay;
          continue;
        }
        throw new ProviderError(`${this.provider} returned HTTP ${res.status}: ${text.slice(0, 400)}`);
      }

      const data = JSON.parse(text);
      const choice = data.choices?.[0];
      const msg = choice?.message ?? {};
      const content: Anthropic.ContentBlock[] = [];
      if (typeof msg.content === 'string' && msg.content.trim()) {
        content.push({ type: 'text', text: msg.content, citations: null } as Anthropic.ContentBlock);
      }
      for (const tc of msg.tool_calls ?? []) {
        let input: unknown;
        try {
          input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          input = { __invalid_json__: tc.function.arguments };
        }
        content.push({
          type: 'tool_use',
          id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
          name: tc.function.name,
          input,
          // Provider-specific fields (Gemini's extra_content.google.thought_signature) ride along in history.
          ...(tc.extra_content ? { _providerExtra: tc.extra_content } : {}),
        } as unknown as Anthropic.ContentBlock);
      }
      const hasTools = content.some((b) => b.type === 'tool_use');
      return {
        content,
        stopReason: hasTools ? 'tool_use' : (STOP_MAP[choice?.finish_reason] ?? choice?.finish_reason ?? null),
        model: data.model ?? this.cfg.modelId,
        waitMs,
        requestMs,
        // OpenAI-style prompt_tokens includes cached tokens; split them out so
        // inputTokens means "uncached input" for every provider.
        usage: {
          inputTokens: (data.usage?.prompt_tokens ?? 0) - (data.usage?.prompt_tokens_details?.cached_tokens ?? 0),
          outputTokens: data.usage?.completion_tokens ?? 0,
          cacheReadTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
          cacheWriteTokens: 0,
        },
      };
    }
  }

  /** List model IDs the key can use (GET /models). */
  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/models`, {
      headers: this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {},
    });
    if (!res.ok) throw new ProviderError(`${this.provider} /models returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    return (data.data ?? []).map((m: any) => String(m.id).replace(/^models\//, '')).sort();
  }
}
