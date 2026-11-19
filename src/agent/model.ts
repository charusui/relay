// The model behind the agent loop, behind one interface:
//   OpenAIChatModel (openaiCompat.ts)  free providers: Gemini, Groq, Ollama
//   AnthropicModel (here)              Claude API; paid, optional, unused by default
//   OfflineModel (offlineModel.ts)     scripted stand-in, no key, no cost, never real metrics
// providers.ts picks one from the environment.

import Anthropic from '@anthropic-ai/sdk';
import { zeroUsage, type TokenUsage } from './pricing.ts';

export type ModelRequest = {
  system: string;
  /** Per-conversation context (date, channel). Kept after the stable prompt so the prompt prefix stays cacheable. */
  context: string;
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
};

export type ModelResponse = {
  content: Anthropic.ContentBlock[];
  stopReason: string | null;
  usage: TokenUsage;
  model: string;
  /** Time spent waiting on rate limits (client throttle, 429 backoff). Excluded from reported latency. */
  waitMs: number;
  /** Time of the successful HTTP request itself. */
  requestMs: number;
};

export interface ModelClient {
  readonly offline: boolean;
  readonly provider: string;
  readonly modelId: string;
  create(req: ModelRequest): Promise<ModelResponse>;
}

export class AnthropicModel implements ModelClient {
  readonly offline = false;
  readonly provider = 'anthropic';
  private client: Anthropic;

  constructor(
    readonly modelId: string,
    private effort: 'low' | 'medium' | 'high' = 'medium',
  ) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not set. The Claude API is paid and not part of a Claude Pro plan; use a free provider instead (RELAY_PROVIDER=gemini or groq).');
    }
    this.client = new Anthropic({ maxRetries: 4 });
  }

  async create(req: ModelRequest): Promise<ModelResponse> {
    const t0 = Date.now();
    const res = await this.client.messages.create({
      model: this.modelId,
      max_tokens: 8000,
      system: [
        { type: 'text', text: req.system },
        { type: 'text', text: req.context },
      ],
      tools: req.tools,
      messages: req.messages,
      output_config: { effort: this.effort },
      // Automatic prompt caching across the calls of one agent loop.
      cache_control: { type: 'ephemeral' },
    });
    return {
      content: res.content,
      stopReason: res.stop_reason,
      model: res.model,
      waitMs: 0,
      requestMs: Date.now() - t0,
      usage: {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

/** Short, actionable message for any model error (no secrets, no stack). */
export function describeModelError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'Authentication failed: check ANTHROPIC_API_KEY in .env.';
  if (err instanceof Anthropic.BadRequestError && /credit balance/i.test(err.message)) {
    return 'Anthropic API credit balance is too low (the Claude API is billed separately from Claude Pro). Use a free provider instead.';
  }
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status}: ${err.message}`;
  return (err as Error)?.message ?? String(err);
}

export { zeroUsage };
