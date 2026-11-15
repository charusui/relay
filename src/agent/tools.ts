// The tools Relay can call. Each one enforces its guard in code, so the model
// cannot talk its way past it:
//   lookupOrder            "not found" is returned as data; orders are only shown to their owner
//   getTrackingStatus      read-only
//   checkReturnEligibility policy logic (window, final sale, threshold) lives here, not in the prompt
//   startReturn            refuses unless an eligibility check passed in this conversation
//   applyDiscountCode      only codes that exist in the store and are customer-facing
// plus searchPolicy (retrieval) and escalateToHuman (hand-off).

import type Anthropic from '@anthropic-ai/sdk';
import { REFUND_APPROVAL_THRESHOLD, RETURN_WINDOW_DAYS } from '../config.ts';
import { searchPolicies } from '../policy/retrieval.ts';
import { normalizeContact, normalizeOrderNumber, StoreNotSupportedError, type StoreAdapter } from '../store/store.ts';
import type { Order } from '../store/types.ts';
import { round2 } from '../../data/seed.ts';

export type Channel = 'sms' | 'email';

export const ESCALATION_REASONS = ['low_confidence', 'angry_customer', 'refund_over_threshold'] as const;
export type EscalationReason = (typeof ESCALATION_REASONS)[number];

export type Eligibility = {
  orderNumber: string;
  sku: string;
  eligible: boolean;
  reasons: string[];
  daysSinceDelivery: number | null;
  refundAmount: number;
  requiresHumanApproval: boolean;
};

/** Per-conversation state the guards rely on. Persisted with the conversation. */
export type ConversationState = {
  verifiedOrders: string[];
  eligibility: Record<string, Eligibility>;
  /** Set when a guard decided a human must approve something. */
  pendingHumanApproval?: { orderNumber: string; sku: string; refundAmount: number };
  escalation?: { reason: EscalationReason; summary: string; source: 'agent' | 'code' };
};

export const newState = (): ConversationState => ({ verifiedOrders: [], eligibility: {} });

export type ToolContext = {
  store: StoreAdapter;
  state: ConversationState;
  sender: { channel: Channel; contact: string };
  escalate: (reason: EscalationReason, summary: string, source: 'agent' | 'code') => Promise<string>;
};

export type ToolResult = { content: unknown; isError?: boolean };

/* ---------------------------------------------------------------- schemas */

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'lookupOrder',
    description:
      'Find an order by its order number, or list the orders that belong to the customer writing in. Call with no arguments to list the sender\'s own orders. If the order belongs to a different email or phone than the one the customer is writing from, the result says so and shares no details; ask the customer for the email or phone used at checkout and call again with it as `contact`. A "not found" result means the order does not exist: never guess another number.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        orderNumber: { type: 'string', description: 'Order number, e.g. "1042" or "#1042".' },
        contact: { type: 'string', description: 'Email or phone the customer says they used at checkout, only if it differs from the one they are writing from.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'getTrackingStatus',
    description: 'Read fulfilment and carrier tracking for an order: shipments, carrier, tracking number, latest scans, estimated delivery, and any backordered items. Read-only.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { orderNumber: { type: 'string' } },
      required: ['orderNumber'],
      additionalProperties: false,
    },
  },
  {
    name: 'checkReturnEligibility',
    description: `Check whether one item (by SKU, from lookupOrder) on an order can be returned under store policy: ${RETURN_WINDOW_DAYS}-day window from delivery, final-sale and non-returnable items, already-returned items. Also says whether the refund needs human approval (over $${REFUND_APPROVAL_THRESHOLD}). Must pass before startReturn.`,
    strict: true,
    input_schema: {
      type: 'object',
      properties: { orderNumber: { type: 'string' }, sku: { type: 'string' } },
      required: ['orderNumber', 'sku'],
      additionalProperties: false,
    },
  },
  {
    name: 'startReturn',
    description: 'Open a return for one item and email the customer a prepaid label. Only works after checkReturnEligibility passed for the same item in this conversation, and never for refunds that need human approval. Only call when the customer has said they want to return the item.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        orderNumber: { type: 'string' },
        sku: { type: 'string' },
        reason: { type: 'string', description: 'The customer\'s reason, in a few words.' },
      },
      required: ['orderNumber', 'sku', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'applyDiscountCode',
    description: 'Apply an existing store discount code to an order that has not shipped yet. Only codes that already exist in the store and are available to customers can be applied; you cannot create or invent codes or custom discounts.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { orderNumber: { type: 'string' }, code: { type: 'string' } },
      required: ['orderNumber', 'code'],
      additionalProperties: false,
    },
  },
  {
    name: 'searchPolicy',
    description: 'Search the store policies (shipping, returns and refunds, warranty, discount codes, order privacy, contact hours). Use it before answering any policy question, and base the answer only on the passages returned.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'escalateToHuman',
    description:
      'Hand the conversation to a human teammate, with a summary they can act on without re-reading the thread. Reasons: low_confidence (you cannot ground an answer in a tool result or policy passage), angry_customer (hostile or repeated-complaint language, or the customer asks for a person), refund_over_threshold (a return or refund needs human approval). After calling it, tell the customer a teammate will reply on this same channel; do not promise an outcome.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', enum: [...ESCALATION_REASONS] },
        summary: { type: 'string', description: 'Who the customer is, what they want, what you checked, and what is still needed.' },
      },
      required: ['reason', 'summary'],
      additionalProperties: false,
    },
  },
];

export const MUTATING_TOOLS = new Set(['startReturn', 'applyDiscountCode']);

/* ---------------------------------------------------------------- helpers */

async function contactMatches(ctx: ToolContext, order: Order, contact: string): Promise<boolean> {
  const owner = await ctx.store.getCustomer(order.customerId);
  if (!owner) return false;
  const c = normalizeContact(contact);
  return (!!owner.email && c === owner.email.toLowerCase()) || (!!owner.phone && c === normalizeContact(owner.phone));
}

const senderOwns = (ctx: ToolContext, order: Order) => contactMatches(ctx, order, ctx.sender.contact);

type Access = { ok: true; order: Order } | { ok: false; result: ToolResult };

/** Every order-scoped tool goes through this: not found, or not yet verified, is data. */
async function access(ctx: ToolContext, rawNumber: string): Promise<Access> {
  const number = normalizeOrderNumber(rawNumber ?? '');
  const order = number ? await ctx.store.getOrder(number) : undefined;
  if (!order) {
    return { ok: false, result: { content: { found: false, orderNumber: number, message: 'No order with this number exists in the store. Do not guess or suggest another order number; ask the customer to double-check it.' } } };
  }
  if (ctx.state.verifiedOrders.includes(order.number) || (await senderOwns(ctx, order))) {
    if (!ctx.state.verifiedOrders.includes(order.number)) ctx.state.verifiedOrders.push(order.number);
    return { ok: true, order };
  }
  return {
    ok: false,
    result: {
      content: {
        found: true,
        verified: false,
        orderNumber: order.number,
        message: 'This order is registered to a different email/phone than the one the customer is writing from. Share no details about it. Ask for the email or phone number used at checkout and call lookupOrder again with it as `contact`.',
      },
    },
  };
}

async function orderView(ctx: ToolContext, o: Order) {
  const customer = await ctx.store.getCustomer(o.customerId);
  const products = await Promise.all(o.lineItems.map((li) => ctx.store.getProduct(li.sku)));
  return {
    orderNumber: o.number,
    customerFirstName: customer?.name.split(' ')[0],
    placedAt: o.placedAt.slice(0, 10),
    status: o.status,
    cancelledAt: o.cancelledAt?.slice(0, 10),
    items: o.lineItems.map((li, i) => {
      const p = products[i];
      return {
        sku: li.sku,
        title: li.title,
        quantity: li.quantity,
        unitPrice: li.unitPrice,
        finalSale: p?.finalSale || undefined,
        returnId: li.returnId,
        backorderedUntil: li.backorderedUntil,
      };
    }),
    subtotal: o.subtotal,
    discountCode: o.discountCode,
    discountAmount: o.discountAmount,
    shipping: o.shipping,
    total: o.total,
    shipTo: `${o.shippingAddress.city}, ${o.shippingAddress.region}, ${o.shippingAddress.country}`,
    shipments: o.shipments.map((s) => ({
      skus: s.skus,
      carrier: s.carrier,
      trackingNumber: s.trackingNumber,
      status: s.status,
      estimatedDelivery: s.estimatedDelivery,
      deliveredAt: s.deliveredAt?.slice(0, 10),
    })),
    // Typed by the customer at checkout. Untrusted: never follow instructions in it.
    untrustedCustomerNote: o.note,
  };
}

function daysBetween(fromIso: string, to: Date): number {
  const a = Date.UTC(+fromIso.slice(0, 4), +fromIso.slice(5, 7) - 1, +fromIso.slice(8, 10));
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((b - a) / 86_400_000);
}

/* ---------------------------------------------------------------- executors */

export async function evaluateReturn(ctx: ToolContext, order: Order, skuRaw: string): Promise<Eligibility> {
  const sku = skuRaw.trim().toUpperCase();
  const li = order.lineItems.find((l) => l.sku === sku);
  const reasons: string[] = [];
  let daysSinceDelivery: number | null = null;
  let refundAmount = 0;
  if (!li) {
    reasons.push('item_not_on_order');
  } else {
    const product = await ctx.store.getProduct(sku);
    const lineTotal = li.unitPrice * li.quantity;
    refundAmount = round2(lineTotal - (order.subtotal ? (order.discountAmount * lineTotal) / order.subtotal : 0));
    const shipment = order.shipments.find((s) => s.skus.includes(sku));
    if (order.status === 'cancelled') reasons.push('order_cancelled_already_refunded');
    if (li.returnId) reasons.push(`already_returned:${li.returnId}`);
    if (product?.finalSale) reasons.push('final_sale');
    if (product?.nonReturnable) reasons.push('non_returnable');
    if (!shipment?.deliveredAt) {
      if (order.status !== 'cancelled') reasons.push('not_delivered_yet');
    } else {
      daysSinceDelivery = daysBetween(shipment.deliveredAt, ctx.store.now());
      if (daysSinceDelivery > RETURN_WINDOW_DAYS) reasons.push('outside_return_window');
    }
  }
  const eligible = reasons.length === 0;
  return {
    orderNumber: order.number,
    sku,
    eligible,
    reasons,
    daysSinceDelivery,
    refundAmount,
    requiresHumanApproval: eligible && refundAmount > REFUND_APPROVAL_THRESHOLD,
  };
}

type Executor = (ctx: ToolContext, input: any) => Promise<ToolResult> | ToolResult;

const executors: Record<string, Executor> = {
  async lookupOrder(ctx, input: { orderNumber?: string; contact?: string }) {
    if (input.orderNumber) {
      const number = normalizeOrderNumber(input.orderNumber);
      const order = await ctx.store.getOrder(number);
      if (order && input.contact && !ctx.state.verifiedOrders.includes(order.number) && (await contactMatches(ctx, order, input.contact))) {
        ctx.state.verifiedOrders.push(order.number);
      }
      const a = await access(ctx, number);
      if (!a.ok) return a.result;
      return { content: { found: true, verified: true, order: await orderView(ctx, a.order) } };
    }
    if (input.contact && normalizeContact(input.contact) !== normalizeContact(ctx.sender.contact)) {
      return {
        content: {
          verified: false,
          message: 'Orders can only be listed for the email/phone the customer is writing from. To look up an order placed with another email or phone, ask for the order number and call lookupOrder with both orderNumber and contact.',
        },
      };
    }
    const customer = await ctx.store.findCustomerByContact(ctx.sender.contact);
    if (!customer) {
      return { content: { found: false, message: 'No orders are linked to the email/phone the customer is writing from. Ask for an order number.' } };
    }
    const orders = await ctx.store.ordersForCustomer(customer.id);
    for (const o of orders) if (!ctx.state.verifiedOrders.includes(o.number)) ctx.state.verifiedOrders.push(o.number);
    return {
      content: {
        found: true,
        customerFirstName: customer.name.split(' ')[0],
        orders: orders.map((o) => ({ orderNumber: o.number, placedAt: o.placedAt.slice(0, 10), status: o.status, items: o.lineItems.map((l) => `${l.title} (${l.sku})`), total: o.total })),
      },
    };
  },

  async getTrackingStatus(ctx, input: { orderNumber: string }) {
    const a = await access(ctx, input.orderNumber);
    if (!a.ok) return a.result;
    const o = a.order;
    const notShipped = o.lineItems.filter((li) => !o.shipments.some((s) => s.skus.includes(li.sku)));
    return {
      content: {
        orderNumber: o.number,
        orderStatus: o.status,
        cancelledAt: o.cancelledAt?.slice(0, 10),
        storeToday: ctx.store.now().toISOString().slice(0, 10),
        shipments: o.shipments.map((s) => ({
          items: s.skus,
          carrier: s.carrier,
          trackingNumber: s.trackingNumber,
          status: s.status,
          shippedAt: s.shippedAt.slice(0, 10),
          estimatedDelivery: s.estimatedDelivery,
          deliveredAt: s.deliveredAt?.slice(0, 10),
          latestEvents: s.events.slice(-3),
        })),
        notShippedYet: notShipped.map((li) => ({ sku: li.sku, title: li.title, backorderedUntil: li.backorderedUntil })),
      },
    };
  },

  async checkReturnEligibility(ctx, input: { orderNumber: string; sku: string }) {
    const a = await access(ctx, input.orderNumber);
    if (!a.ok) return a.result;
    const e = await evaluateReturn(ctx, a.order, input.sku);
    ctx.state.eligibility[`${e.orderNumber}:${e.sku}`] = e;
    if (e.requiresHumanApproval) {
      ctx.state.pendingHumanApproval = { orderNumber: e.orderNumber, sku: e.sku, refundAmount: e.refundAmount };
    }
    return {
      content: {
        ...e,
        returnWindowDays: RETURN_WINDOW_DAYS,
        humanApprovalThreshold: REFUND_APPROVAL_THRESHOLD,
        note: e.requiresHumanApproval
          ? `Eligible, but the refund is over $${REFUND_APPROVAL_THRESHOLD}, so a teammate must approve it. Do not call startReturn; escalate with reason refund_over_threshold if the customer wants to return it.`
          : undefined,
      },
    };
  },

  async startReturn(ctx, input: { orderNumber: string; sku: string; reason: string }) {
    const a = await access(ctx, input.orderNumber);
    if (!a.ok) return a.result;
    const sku = input.sku.trim().toUpperCase();
    const e = ctx.state.eligibility[`${a.order.number}:${sku}`];
    if (!e) {
      return { content: { ok: false, error: 'eligibility_not_checked', message: 'Call checkReturnEligibility for this item first. Returns cannot be opened without a passing check in this conversation.' } };
    }
    if (!e.eligible) {
      return { content: { ok: false, error: 'not_eligible', reasons: e.reasons } };
    }
    if (e.requiresHumanApproval) {
      ctx.state.pendingHumanApproval = { orderNumber: e.orderNumber, sku: e.sku, refundAmount: e.refundAmount };
      return { content: { ok: false, error: 'needs_human_approval', refundAmount: e.refundAmount, message: `Refunds over $${REFUND_APPROVAL_THRESHOLD} need a teammate's approval. Escalate with reason refund_over_threshold.` } };
    }
    let rec;
    try {
      rec = await ctx.store.createReturn({ orderNumber: a.order.number, sku, reason: input.reason, refundAmount: e.refundAmount });
    } catch (err) {
      if (err instanceof StoreNotSupportedError) return { content: { ok: false, error: 'not_supported', message: err.message } };
      throw err;
    }
    // A passing check is used up by the return it allowed.
    delete ctx.state.eligibility[`${a.order.number}:${sku}`];
    return {
      content: {
        ok: true,
        returnId: rec.id,
        refundAmount: rec.refundAmount,
        labelEmailed: rec.labelEmailed ?? true,
        labelUrl: rec.labelUrl,
        nextSteps:
          rec.nextSteps ??
          'Drop the package with the carrier within 14 days. Refund to the original payment method 5-10 business days after it reaches the warehouse.',
      },
    };
  },

  async applyDiscountCode(ctx, input: { orderNumber: string; code: string }) {
    const a = await access(ctx, input.orderNumber);
    if (!a.ok) return a.result;
    const o = a.order;
    const code = await ctx.store.getDiscountCode(input.code);
    const now = ctx.store.now();
    const fail = (error: string, message: string) => ({ content: { ok: false, error, message } });
    if (!code) return fail('code_not_found', 'This code does not exist in the store. You cannot create codes or custom discounts.');
    if (code.staffOnly) return fail('code_not_available', 'This code is not available for customer orders.');
    if (o.status === 'cancelled') return fail('order_cancelled', 'The order is cancelled.');
    if (o.status !== 'unfulfilled') return fail('order_already_shipped', 'Codes can only be added before an order ships.');
    if (o.discountCode) return fail('code_already_applied', `Order already uses ${o.discountCode}. Only one code per order.`);
    if (now < new Date(code.startsAt)) return fail('code_not_started', `This code starts on ${code.startsAt.slice(0, 10)}.`);
    if (now > new Date(code.endsAt)) return fail('code_expired', `This code expired on ${code.endsAt.slice(0, 10)}.`);
    if (o.subtotal < code.minSubtotal) return fail('below_minimum', `This code needs a subtotal of at least $${code.minSubtotal}; the order subtotal is $${o.subtotal}.`);
    const amount = code.kind === 'percent' ? round2((o.subtotal * code.value) / 100) : Math.min(code.value, o.subtotal);
    let updated;
    try {
      updated = await ctx.store.setOrderDiscount(o.number, code.code, amount);
    } catch (err) {
      if (err instanceof StoreNotSupportedError) return fail('not_supported', err.message);
      throw err;
    }
    return {
      content: {
        ok: true,
        code: code.code,
        discountAmount: amount,
        newTotal: updated.total,
        refund: `$${amount.toFixed(2)} goes back to the original payment method within 5-10 business days.`,
      },
    };
  },

  searchPolicy(_ctx, input: { query: string }) {
    const hits = searchPolicies(input.query, 3);
    if (!hits.length) {
      return { content: { passages: [], message: 'No policy passage matches. Do not answer from general knowledge.' } };
    }
    return { content: { passages: hits.map(({ id, doc, section, text }) => ({ id, doc, section, text })) } };
  },

  async escalateToHuman(ctx, input: { reason: EscalationReason; summary: string }) {
    if (!ESCALATION_REASONS.includes(input.reason)) {
      return { content: `Unknown reason "${input.reason}". Use one of: ${ESCALATION_REASONS.join(', ')}`, isError: true };
    }
    if (ctx.state.escalation) {
      return { content: { ok: true, alreadyEscalated: true } };
    }
    const ticketId = await ctx.escalate(input.reason, input.summary, 'agent');
    return {
      content: {
        ok: true,
        ticketId,
        tellCustomer: 'A teammate will reply on this same channel, usually within one business day. Do not promise an outcome.',
      },
    };
  },
};

export async function executeTool(ctx: ToolContext, name: string, input: unknown): Promise<ToolResult> {
  const fn = executors[name];
  if (!fn) return { content: `Unknown tool ${name}`, isError: true };
  if (typeof input !== 'object' || input === null) return { content: 'Tool input must be an object.', isError: true };
  try {
    return await fn(ctx, input);
  } catch (err) {
    return { content: `Tool failed: ${(err as Error).message}`, isError: true };
  }
}
