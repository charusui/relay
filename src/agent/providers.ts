// Pick the model client from the environment (relay/.env). All free options
// first; Anthropic is supported but paid and off by default.

import { AnthropicModel, type ModelClient } from './model.ts';
import { OfflineModel } from './offlineModel.ts';
import { OpenAIChatModel, stripAdditionalProperties, type ProviderConfig } from './openaiCompat.ts';

export const PROVIDERS = ['gemini', 'groq', 'ollama', 'anthropic'] as const;
export type Provider = (typeof PROVIDERS)[number];

const env = (k: string) => process.env[k]?.trim() || undefined;

function need(key: string, hint: string): string {
  const v = env(key);
  if (!v) throw new Error(`${key} is not set in relay/.env. ${hint}`);
  return v;
}

export function providerConfig(provider: Provider, modelOverride?: string): ProviderConfig {
  switch (provider) {
    case 'gemini':
      return {
        provider,
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        apiKey: need('GEMINI_API_KEY', 'Get a free key at https://aistudio.google.com/apikey (no billing needed).'),
        modelId: modelOverride ?? need('RELAY_GEMINI_MODEL', 'Run `npm run models -- gemini` to list the model IDs your key can use, then set one.'),
        rpm: Number(env('RELAY_GEMINI_RPM') ?? 12), // free limit 15/min for 3.5 Flash Lite
        sanitizeSchema: stripAdditionalProperties,
      };
    case 'groq':
      return {
        provider,
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKey: need('GROQ_API_KEY', 'Get a free key at https://console.groq.com/keys (no card needed).'),
        modelId: modelOverride ?? need('RELAY_GROQ_MODEL', 'Run `npm run models -- groq` to list model IDs, then pick one that supports tool use.'),
        rpm: Number(env('RELAY_GROQ_RPM') ?? 20),
      };
    case 'ollama':
      return {
        provider,
        baseUrl: env('OLLAMA_BASE_URL') ?? 'http://localhost:11434/v1',
        modelId: modelOverride ?? need('RELAY_OLLAMA_MODEL', 'Pull a small tool-capable model with Ollama and set its name.'),
        rpm: 0,
      };
    default:
      throw new Error(`No OpenAI-compatible config for provider "${provider}".`);
  }
}

export function parseProvider(raw: string | undefined): Provider {
  const p = (raw ?? env('RELAY_PROVIDER') ?? 'gemini').toLowerCase();
  if (!(PROVIDERS as readonly string[]).includes(p)) throw new Error(`Unknown provider "${p}". Use one of: ${PROVIDERS.join(', ')}`);
  return p as Provider;
}

/** The agent's model. `offline` returns the free scripted stand-in. */
export function createModel(opts: { provider?: string; model?: string; offline?: boolean } = {}): ModelClient {
  if (opts.offline) return new OfflineModel();
  const provider = parseProvider(opts.provider);
  if (provider === 'anthropic') return new AnthropicModel(opts.model ?? env('RELAY_ANTHROPIC_MODEL') ?? 'claude-haiku-5-5');
  return new OpenAIChatModel(providerConfig(provider, opts.model));
}

/** The eval judge. Defaults to RELAY_JUDGE_PROVIDER, which should differ from the agent's provider. */
export function createJudgeModel(): OpenAIChatModel | AnthropicModel {
  const provider = parseProvider(env('RELAY_JUDGE_PROVIDER') ?? 'groq');
  const model = env('RELAY_JUDGE_MODEL');
  if (provider === 'anthropic') return new AnthropicModel(model ?? 'claude-haiku-5-5', 'low');
  return new OpenAIChatModel(providerConfig(provider, model));
}
