// The agent loop: call the model, run the tools it asks for, feed results
// back, repeat until it answers. Manual loop (not the SDK tool runner) so every
// tool call can be timed, logged and guarded, and so the offline stand-in
// model can drive the exact same code.

import type Anthropic from '@anthropic-ai/sdk';
import { MAX_AGENT_STEPS } from '../config.ts';
import type { ModelClient } from './model.ts';
import { addUsage, zeroUsage, type TokenUsage } from './pricing.ts';
import { sanitizeReply } from './sanitize.ts';
import { executeTool, type ToolContext } from './tools.ts';

export type ToolCallRecord = {
  seq: number;
  name: string;
  input: unknown;
  output: unknown;
  isError: boolean;
  durationMs: number;
};

export type AgentRun = {
  reply: string;
  toolCalls: ToolCallRecord[];
  usage: TokenUsage;
  steps: number;
  stopReason: string | null;
  model: string;
  /** Time spent waiting on provider rate limits during this run. */
  waitMs: number;
  /** The loop stopped for a reason other than a normal answer. */
  abnormal: null | 'step_limit' | 'refusal' | 'max_tokens' | 'empty_reply' | 'leaked_internals';
  /** Internal reasoning was stripped from the reply before it was sent (failure 05). */
  sanitized: boolean;
  /** What leaked, when a reply was withheld for leaking internals. */
  leak?: string;
};

export async function runAgent(opts: {
  model: ModelClient;
  system: string;
  tools: Anthropic.Tool[];
  context: string;
  /** Full model-format history, already ending with the new customer message. Mutated in place. */
  messages: Anthropic.MessageParam[];
  toolCtx: ToolContext;
  seqStart?: number;
}): Promise<AgentRun> {
  const toolCalls: ToolCallRecord[] = [];
  let usage = zeroUsage();
  let stopReason: string | null = null;
  let model = opts.model.modelId;
  let waitMs = 0;
  let reply = '';
  let abnormal: AgentRun['abnormal'] = null;
  let sanitized = false;
  let leak: string | undefined;
  let steps = 0;
  let seq = opts.seqStart ?? 0;

  for (; steps < MAX_AGENT_STEPS; ) {
    steps++;
    const res = await opts.model.create({
      system: opts.system,
      context: opts.context,
      tools: opts.tools,
      messages: opts.messages,
    });
    usage = addUsage(usage, res.usage);
    waitMs += res.waitMs;
    stopReason = res.stopReason;
    model = res.model;
    // Pass the whole content back unchanged (thinking blocks included).
    opts.messages.push({ role: 'assistant', content: res.content as Anthropic.ContentBlockParam[] });

    if (res.stopReason === 'refusal') {
      abnormal = 'refusal';
      break;
    }
    if (res.stopReason === 'max_tokens') {
      abnormal = 'max_tokens';
      break;
    }
    if (res.stopReason === 'pause_turn') continue;

    const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (res.stopReason === 'tool_use' && toolUses.length) {
      const results: Anthropic.ToolResultBlockParam[] = [];
      // Sequential on purpose: guards read state that earlier calls write.
      for (const tu of toolUses) {
        const t0 = performance.now();
        const r = await executeTool(opts.toolCtx, tu.name, tu.input);
        const durationMs = Math.round((performance.now() - t0) * 10) / 10;
        toolCalls.push({ seq: seq++, name: tu.name, input: tu.input, output: r.content, isError: !!r.isError, durationMs });
        results.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content),
          is_error: r.isError || undefined,
        });
      }
      // All results in one user message, so parallel tool use keeps working.
      opts.messages.push({ role: 'user', content: results });
      continue;
    }

    reply = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    // Output guard: never send internal reasoning, tool names or JSON to a customer.
    const clean = sanitizeReply(reply);
    sanitized = clean.stripped;
    if (clean.leak) {
      leak = clean.leak;
      reply = '';
      abnormal = 'leaked_internals';
    } else {
      reply = clean.text;
      if (!reply) abnormal = 'empty_reply';
    }
    break;
  }

  if (!abnormal && steps >= MAX_AGENT_STEPS && !reply) abnormal = 'step_limit';
  return { reply, toolCalls, usage, steps, stopReason, model, waitMs, abnormal, sanitized, leak };
}

/** Append a customer message, merging with a trailing user turn if the last loop ended on tool results. */
export function appendCustomerMessage(messages: Anthropic.MessageParam[], text: string) {
  const last = messages.at(-1);
  if (last && last.role === 'user') {
    const content = typeof last.content === 'string' ? [{ type: 'text' as const, text: last.content }] : last.content;
    last.content = [...content, { type: 'text', text }];
  } else {
    messages.push({ role: 'user', content: text });
  }
}
