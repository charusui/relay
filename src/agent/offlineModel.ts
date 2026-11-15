// OfflineModel: a scripted, rule-based stand-in for Claude. It speaks the same
// content-block protocol (text and tool_use blocks), so the real handler,
// tools, database and eval runner all run end to end with no API key and no
// cost. It is deliberately naive. Anything it produces is labelled
// SIMULATED and must never be used as a Relay metric.

import type Anthropic from '@anthropic-ai/sdk';
import type { ModelClient, ModelRequest, ModelResponse } from './model.ts';
import { zeroUsage } from './pricing.ts';

type Call = { name: string; input: any; output: any };

let idCounter = 0;

function textBlock(text: string): Anthropic.ContentBlock {
  return { type: 'text', text, citations: null } as Anthropic.ContentBlock;
}

function toolBlock(name: string, input: object): Anthropic.ContentBlock {
  return { type: 'tool_use', id: `toolu_offline_${++idCounter}`, name, input, caller: undefined } as unknown as Anthropic.ContentBlock;
}

/** Find the latest customer text and the tool calls made since it. */
function readConversation(messages: Anthropic.MessageParam[]): { text: string; calls: Call[] } {
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    if (blocks.some((b: any) => b.type === 'text')) {
      start = i;
      break;
    }
  }
  const m = messages[start];
  const blocks: any[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content as any[]);
  const raw = blocks.filter((b) => b.type === 'text').map((b) => b.text).at(-1) ?? '';
  const text = raw.replace(/<\/?customer_message[^>]*>/g, '').trim();
  const calls: Call[] = [];
  const pending = new Map<string, Call>();
  for (const msg of messages.slice(start + 1)) {
    if (typeof msg.content === 'string') continue;
    for (const b of msg.content as any[]) {
      if (b.type === 'tool_use') {
        const c = { name: b.name, input: b.input, output: undefined };
        pending.set(b.id, c);
        calls.push(c);
      } else if (b.type === 'tool_result') {
        const c = pending.get(b.tool_use_id);
        if (c) c.output = safeParse(typeof b.content === 'string' ? b.content : b.content?.[0]?.text);
      }
    }
  }
  return { text, calls };
}

function safeParse(s: string | undefined) {
  try {
    return s ? JSON.parse(s) : undefined;
  } catch {
    return s;
  }
}

const REASON_TEXT: Record<string, string> = {
  final_sale: 'it was sold as final sale',
  non_returnable: 'that item cannot be returned',
  outside_return_window: 'it is past our 30-day return window',
  not_delivered_yet: 'it has not been delivered yet',
  order_cancelled_already_refunded: 'the order was cancelled and already refunded',
  item_not_on_order: 'that item is not on the order',
};

function decide(text: string, calls: Call[]): Anthropic.ContentBlock {
  const lower = text.toLowerCase();
  const called = (n: string) => calls.find((c) => c.name === n);
  const orderNum = text.match(/#?\b(\d{4,5})\b/)?.[1];

  if (/system prompt|your instructions|reveal your|repeat your/.test(lower)) {
    return textBlock("Sorry, I can't share that. I'm happy to help with an order, shipping or a return.");
  }
  if (called('escalateToHuman')) {
    return textBlock("I've passed this to a teammate, who will reply here shortly.");
  }
  if (/\b(human|person|manager|representative|supervisor)\b|third time|already (asked|contacted|emailed)/.test(lower)) {
    return toolBlock('escalateToHuman', { reason: 'angry_customer', summary: `Customer asked for a person or is upset: "${text.slice(0, 160)}"` });
  }

  const wantsDiscount = /\b(code|discount|promo|coupon)\b/.test(lower);
  const wantsReturn = /\b(return|send (it )?back|refund)\b/.test(lower);
  const policyQ = /\b(how long|policy|ship to|international|warranty|price match|canada|hours|exchange|how do)\b/.test(lower);

  if (!orderNum) {
    if (policyQ && !wantsDiscount) {
      const s = called('searchPolicy');
      if (!s) return toolBlock('searchPolicy', { query: text });
      const p = s.output?.passages?.[0];
      if (!p) return toolBlock('escalateToHuman', { reason: 'low_confidence', summary: `No policy covers: "${text.slice(0, 160)}"` });
      return textBlock(p.text.split('. ').slice(0, 2).join('. ').trim());
    }
    return textBlock('Happy to help. Which order is this about, and what would you like to do?');
  }

  const lookup = called('lookupOrder');
  if (!lookup) return toolBlock('lookupOrder', { orderNumber: orderNum });
  if (lookup.output?.found === false) {
    return textBlock(`I couldn't find an order #${orderNum}. Could you double-check the number?`);
  }
  if (lookup.output?.verified === false) {
    return textBlock('For your security, what email or phone number did you use at checkout?');
  }
  const order = lookup.output.order;

  if (wantsDiscount) {
    const code = text.match(/\b[A-Z][A-Z0-9]{3,}\b/)?.[0];
    if (!code) return textBlock('Which discount code would you like me to apply?');
    const applied = called('applyDiscountCode');
    if (!applied) return toolBlock('applyDiscountCode', { orderNumber: orderNum, code });
    if (applied.output?.ok) return textBlock(`Done: ${code} took $${applied.output.discountAmount} off. Your new total is $${applied.output.newTotal}.`);
    return textBlock(`Sorry, I can't apply that code: ${applied.output?.message ?? 'it is not valid'}`);
  }

  if (wantsReturn) {
    const item =
      order.items.find((i: any) => lower.includes(i.title.toLowerCase().split(' ').at(-1))) ?? order.items[0];
    const check = called('checkReturnEligibility');
    if (!check) return toolBlock('checkReturnEligibility', { orderNumber: orderNum, sku: item.sku });
    const e = check.output;
    if (e.eligible && e.requiresHumanApproval) {
      return toolBlock('escalateToHuman', { reason: 'refund_over_threshold', summary: `Return of ${item.sku} on #${orderNum}, refund $${e.refundAmount}, needs approval.` });
    }
    if (!e.eligible) {
      return textBlock(`Sorry, that item can't be returned because ${e.reasons.map((r: string) => REASON_TEXT[r] ?? r).join(' and ')}.`);
    }
    const start = called('startReturn');
    if (!start) return toolBlock('startReturn', { orderNumber: orderNum, sku: item.sku, reason: 'customer request' });
    if (start.output?.ok) {
      return textBlock(`Your return ${start.output.returnId} is open and a prepaid label is on its way by email. Refund of $${start.output.refundAmount} follows once it reaches us.`);
    }
    return textBlock("I couldn't open that return. A teammate can take a look if you'd like.");
  }

  // Anything else about a known order (including tracking questions): report its shipping status.
  const t = called('getTrackingStatus');
  if (!t) return toolBlock('getTrackingStatus', { orderNumber: orderNum });
  const s = t.output?.shipments?.[0];
  if (t.output?.orderStatus === 'cancelled') return textBlock(`Order #${orderNum} was cancelled and refunded.`);
  if (!s) return textBlock(`Order #${orderNum} hasn't shipped yet. Orders ship within 1-2 business days.`);
  const when = s.deliveredAt ? `delivered on ${s.deliveredAt}` : `estimated delivery ${s.estimatedDelivery}`;
  return textBlock(`Order #${orderNum} is ${s.status.replace(/_/g, ' ')} with ${s.carrier} (tracking ${s.trackingNumber}), ${when}.`);
}

export class OfflineModel implements ModelClient {
  readonly offline = true;
  readonly provider = 'offline';
  readonly modelId = 'offline-stub';

  async create(req: ModelRequest): Promise<ModelResponse> {
    const { text, calls } = readConversation(req.messages);
    const block = decide(text, calls);
    return {
      content: [block],
      stopReason: block.type === 'tool_use' ? 'tool_use' : 'end_turn',
      usage: zeroUsage(),
      model: 'offline-stub',
      waitMs: 0,
      requestMs: 0,
    };
  }
}
