// handleInbound: the one entry point for every inbound message. The local
// channel simulator, the eval runner, and (milestone 2) the SMS/email webhooks
// all call this, so tests exercise the same code path production would.
//
//   load thread -> run agent loop -> escalation check -> log everything -> reply

import { appendCustomerMessage, runAgent, type ToolCallRecord } from './agent/loop.ts';
import type { ModelClient } from './agent/model.ts';
import { paidEquivalentUsd, type TokenUsage, zeroUsage } from './agent/pricing.ts';
import { newState, type Channel, type ConversationState, type EscalationReason, type ToolContext } from './agent/tools.ts';
import { buildSystemPrompt, toolsFor, type Variant } from './agent/variants.ts';
import type { ConversationRow, RelayDb, Traffic } from './db/db.ts';
import type { StoreAdapter } from './store/store.ts';
import { REFUND_APPROVAL_THRESHOLD } from './config.ts';

export type InboundMessage = {
  channel: Channel;
  from: string;
  text: string;
  subject?: string;
  /** Continue a specific conversation (evals). Otherwise the open thread for this contact is used. */
  conversationId?: string;
  evalRunId?: string;
  evalCaseId?: string;
  /** live (default), synthetic (scheduled scripted check) or demo. Monitoring keeps them apart. */
  traffic?: Traffic;
};

export type Escalation = { reason: EscalationReason; summary: string; source: 'agent' | 'code'; ticketId: string };

export type InboundResult = {
  conversationId: string;
  reply: string;
  status: ConversationRow['status'];
  escalation?: Escalation;
  /** True when the conversation was already with a human and the agent did not run. */
  heldForHuman: boolean;
  /** Wall-clock time for the whole message, including rate-limit waits. */
  latencyMs: number;
  /** latencyMs minus time spent waiting on free-tier rate limits. This is what reports call latency. */
  activeLatencyMs: number;
  waitMs: number;
  usage: TokenUsage;
  /** What this turn would cost at the model's paid list price; null if no price is on file. Actual spend on free tiers is $0. */
  paidEquivalentUsd: number | null;
  toolCalls: ToolCallRecord[];
  steps: number;
  abnormal: string | null;
  /** Internal reasoning was stripped from the model's reply before sending (failure 05). */
  sanitized?: boolean;
  /** Set when a reply was withheld for leaking internals; the customer got a hand-off instead. */
  leak?: string;
};

export type HandlerDeps = { db: RelayDb; store: StoreAdapter; model: ModelClient; variant: Variant };

export const HANDOFF_LINE = 'A teammate will reply here, usually within one business day.';
const HELD_REPLY = 'Thanks, a teammate already has your conversation and will reply here, usually within one business day.';

// Deterministic backstops for the escalation rules code can detect for
// certain. The model is expected to catch these itself; when code has to,
// the escalation is logged with source = 'code' and reports count it
// separately (agent alone vs agent plus safety nets).
const ASKS_FOR_HUMAN =
  /\b(speak|talk|chat)\s+(to|with)\s+(a|an|some|your)?\s*(real\s+|actual\s+|live\s+)?(human|person|someone|manager|supervisor|representative|agent)\b|\b(real|actual|live)\s+(human|person)\b|\b(get|give|put)\s+me\s+(a|an|through to a)?\s*(human|person|manager|supervisor)\b/i;
const REPEATED_COMPLAINT =
  /\b(second|third|fourth|fifth|\d+(st|nd|rd|th))\s+time\s+(i('ve| have)?\s+)?(am\s+)?(asked|asking|contacted|contacting|written|writing|emailed|emailing|messaged|messaging|reached out|reaching out)\b|\balready\s+(asked|contacted|emailed|messaged|written to|called|told)\s+(you|about|before|twice)\b|\bkeep\s+(asking|emailing|messaging)\s+(you|and)\b/i;

export function codeEscalationSignal(text: string): string | null {
  if (ASKS_FOR_HUMAN.test(text)) return 'customer asked for a person';
  if (REPEATED_COMPLAINT.test(text)) return 'customer says they have contacted us before about this';
  return null;
}

function contextBlock(store: StoreAdapter, msg: InboundMessage) {
  return [
    `Store: ${store.storeName}. Today's date (store time): ${store.now().toISOString().slice(0, 10)}.`,
    `Channel: ${msg.channel === 'sms' ? 'SMS' : 'Email'}. The customer is writing from ${msg.from}.`,
  ].join('\n');
}

function wrapCustomerText(msg: InboundMessage) {
  const subject = msg.subject ? `Subject: ${msg.subject}\n\n` : '';
  // Customer text is fenced as data (prompt-injection hygiene).
  return `<customer_message channel="${msg.channel}">\n${subject}${msg.text}\n</customer_message>`;
}

export async function handleInbound(deps: HandlerDeps, msg: InboundMessage): Promise<InboundResult> {
  const t0 = performance.now();
  const { db, store, model, variant } = deps;

  const conv =
    (msg.conversationId && (await db.getConversation(msg.conversationId))) ||
    (!msg.evalRunId && (await db.findOpenConversation(msg.channel, msg.from, msg.traffic ?? 'live'))) ||
    (await db.createConversation({
      channel: msg.channel,
      contact: msg.from,
      variant: variant.id,
      model: `${model.provider}:${model.modelId}`,
      state: newState(),
      evalRunId: msg.evalRunId,
      evalCaseId: msg.evalCaseId,
      traffic: msg.traffic,
    }));

  await db.addMessage(conv.id, 'customer', msg.subject ? `[${msg.subject}] ${msg.text}` : msg.text);

  // Already with a human: log the message for them, do not run the agent.
  if (conv.status === 'escalated') {
    await db.addMessage(conv.id, 'agent', HELD_REPLY);
    const ms = Math.round(performance.now() - t0);
    return {
      conversationId: conv.id,
      reply: HELD_REPLY,
      status: conv.status,
      heldForHuman: true,
      latencyMs: ms,
      activeLatencyMs: ms,
      waitMs: 0,
      usage: zeroUsage(),
      paidEquivalentUsd: 0,
      toolCalls: [],
      steps: 0,
      abnormal: null,
    };
  }

  const state: ConversationState = conv.state;
  const messages = conv.model_messages;
  let escalation: Escalation | undefined;
  const escalate = async (reason: EscalationReason, summary: string, source: 'agent' | 'code') => {
    const ticketId = await db.createEscalation({ conversationId: conv.id, reason, source, summary });
    state.escalation = { reason, summary, source };
    escalation = { reason, summary, source, ticketId };
    return ticketId;
  };
  const toolCtx: ToolContext = { store, state, sender: { channel: msg.channel, contact: msg.from }, escalate };

  appendCustomerMessage(messages, wrapCustomerText(msg));
  const run = await runAgent({
    model,
    system: buildSystemPrompt(variant),
    tools: toolsFor(variant),
    context: contextBlock(store, msg),
    messages,
    toolCtx,
  });

  // ---- escalation check (code backstops) ----
  let reply = run.reply;
  if (!state.escalation) {
    const pending = state.pendingHumanApproval;
    const signal = codeEscalationSignal(msg.text);
    if (pending) {
      await escalate(
        'refund_over_threshold',
        `Return of ${pending.sku} on order #${pending.orderNumber} is eligible but the refund ($${pending.refundAmount}) is over $${REFUND_APPROVAL_THRESHOLD}, so it needs approval. Customer message: "${msg.text.slice(0, 300)}"`,
        'code',
      );
    } else if (signal) {
      await escalate('angry_customer', `Escalated by rule (${signal}). Customer message: "${msg.text.slice(0, 300)}"`, 'code');
    } else if (run.abnormal) {
      await escalate('low_confidence', `Agent loop ended abnormally (${run.abnormal}${run.leak ? `: ${run.leak}` : ''}). Customer message: "${msg.text.slice(0, 300)}"`, 'code');
    }
  }
  if (escalation?.source === 'code') {
    reply = reply ? `${reply}\n\n${HANDOFF_LINE}` : `Thanks for your patience. ${HANDOFF_LINE}`;
  }
  if (!reply) reply = `Sorry, something went wrong on our side. ${HANDOFF_LINE}`;

  const status: ConversationRow['status'] = state.escalation ? 'escalated' : 'open';
  const latencyMs = Math.round(performance.now() - t0);
  const activeLatencyMs = Math.max(0, latencyMs - run.waitMs);
  const paid = model.offline ? null : paidEquivalentUsd(model.modelId, run.usage);

  await db.addMessage(conv.id, 'agent', reply);
  await db.recordTurn({
    conversationId: conv.id,
    latencyMs,
    activeLatencyMs,
    waitMs: run.waitMs,
    steps: run.steps,
    usage: run.usage,
    paidEquivalentUsd: paid,
    model: `${model.provider}:${run.model}`,
    stopReason: run.stopReason,
    abnormal: run.abnormal,
    toolCalls: run.toolCalls,
  });
  await db.saveConversationState(conv.id, status, state, messages);

  return {
    conversationId: conv.id,
    reply,
    status,
    escalation,
    heldForHuman: false,
    latencyMs,
    activeLatencyMs,
    waitMs: run.waitMs,
    usage: run.usage,
    paidEquivalentUsd: paid,
    toolCalls: run.toolCalls,
    steps: run.steps,
    abnormal: run.abnormal,
    sanitized: run.sanitized,
    leak: run.leak,
  };
}
