// Output guard: internal text must never reach a customer, whatever the model.
// Added after failure 05: Gemma 4 26B put its private reasoning in
// "<thought>...</thought>" blocks inside every reply, and once left the tag
// unclosed with the real answer glued onto the end.
//
// Well-formed reasoning blocks are removed. If anything internal is still
// left (an unclosed tag, a tool name, raw JSON), the reply is not sent: the
// handler hands the conversation to a person instead.

import { toolDefinitions } from './tools.ts';

// A block is delimited by an opening tag (well-formed "<thought>", or malformed "<thought" followed by
// whitespace, as Gemma sometimes writes) and a matching closing tag.
const BLOCK = /<(thought|thinking|reasoning|scratchpad)(?:>|\s)[\s\S]*?<\/\1>/gi;
const TAG = /<\/?(thought|thinking|reasoning|scratchpad)\b/i;
const TOOL_NAMES = toolDefinitions.map((t) => t.name);
const TOOL = new RegExp(`\\b(${TOOL_NAMES.join('|')})\\b`);
const JSONISH = /\{\s*"[a-zA-Z_]+"\s*:/;

/** Why a piece of customer-facing text leaks internals, or null if it is clean. */
export function findLeak(text: string): string | null {
  const tag = text.match(TAG);
  if (tag) return `internal reasoning tag <${tag[1]}>`;
  const tool = text.match(TOOL);
  if (tool) return `tool name "${tool[1]}"`;
  if (JSONISH.test(text)) return 'raw JSON';
  return null;
}

export type Sanitized = {
  text: string;
  /** Well-formed reasoning blocks were removed. */
  stripped: boolean;
  /** Internal text still present after stripping: the reply must not be sent. */
  leak: string | null;
};

// A closing tag left over once complete blocks are gone ("<thought>…</thought>ANSWER</thought>",
// seen in 5 of 25 Gemma replies) closes nothing: the text around it is the answer.
// Unclosed OPENING tags are never repaired: the reasoning and the answer can't be told apart.
const STRAY_CLOSER = /<\/(thought|thinking|reasoning|scratchpad)>/gi;

export function sanitizeReply(raw: string): Sanitized {
  const text = raw.replace(BLOCK, '').replace(STRAY_CLOSER, '').trim();
  return { text, stripped: text !== raw.trim(), leak: findLeak(text) };
}
